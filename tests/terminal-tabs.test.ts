import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { installTabStripHandlers } from "../src/app/terminal-tabs.ts";

function fixture() {
  const dom = new JSDOM(`<main><div class="tab-strip"><div class="term-tab" data-tab-group="a">A<button class="term-tab-close">Close</button></div><div class="term-tab" data-tab-group="b">B</div></div></main>`);
  const root = dom.window.document.querySelector("main")!;
  const tabs = [...root.querySelectorAll<HTMLElement>(".term-tab")];
  tabs.forEach((tab, index) => { tab.getBoundingClientRect = () => ({ left: index * 100, width: 100 } as DOMRect); });
  const moves: unknown[] = [], closed: string[] = [], renamed: string[] = [];
  let captured: { id: number; target: Element } | undefined;
  for (const target of [root, ...tabs]) {
    target.setPointerCapture = id => { captured = { id, target }; };
    target.hasPointerCapture = id => captured?.id === id && captured.target === target;
    target.releasePointerCapture = id => { if (target.hasPointerCapture(id)) captured = undefined; };
  }
  const pointer = (name: string, target: Element, x: number, id = 1) => {
    const event = new dom.window.Event(name, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: id, button: 0, isPrimary: true, clientX: x });
    target.dispatchEvent(event);
  };
  installTabStripHandlers(root, {
    moveTab: (id, to) => { moves.push({ id, to }); },
    closeTerminalGroup: async id => { closed.push(id); },
    renameTab: async id => { renamed.push(id); },
  });
  const loseCapture = () => { captured = undefined; };
  return { dom, root, tabs, moves, closed, renamed, pointer, captured: () => captured?.id, captureTarget: () => captured?.target, loseCapture };
}

test("tab drag captures release outside the app and finishes exactly once", () => {
  const f = fixture();
  try {
    f.pointer("pointerdown", f.tabs[0], 20);
    f.pointer("pointermove", f.root, 210);
    // Browser pointer capture routes an out-of-window release back to the root.
    const receiver = f.captured() === 1 ? f.root : f.dom.window.document.body;
    f.pointer("pointerup", receiver, 300);
    assert.deepEqual(f.moves, [{ id: "a", to: { before: "" } }]);
    assert.equal(f.captured(), undefined);
    f.pointer("pointermove", f.tabs[1], 0);
    f.pointer("pointerup", f.tabs[1], 0);
    assert.equal(f.moves.length, 1);
    assert.equal(f.root.querySelector(".dragging,.drop-before,.drop-after"), null);
  } finally { f.dom.window.close(); }
});

test("losing pointer capture cancels the drag without reordering later", () => {
  const f = fixture();
  try {
    f.pointer("pointerdown", f.tabs[0], 20);
    f.pointer("pointermove", f.root, 210);
    f.loseCapture();
    f.pointer("lostpointercapture", f.root, 210);
    assert.equal(f.root.querySelector(".dragging,.drop-before,.drop-after"), null);
    f.pointer("pointermove", f.tabs[1], 0);
    f.pointer("pointerup", f.tabs[1], 0);
    assert.deepEqual(f.moves, []);
    assert.equal(f.root.querySelector(".dragging,.drop-before,.drop-after"), null);
  } finally { f.dom.window.close(); }
});

test("an outside release does not swallow the next ordinary tab click", async () => {
  const f = fixture();
  try {
    f.pointer("pointerdown", f.tabs[0], 20);
    f.pointer("pointermove", f.root, 210);
    f.pointer("pointerup", f.root, 300);
    await new Promise(resolve => f.dom.window.setTimeout(resolve, 5));
    let clicks = 0;
    f.root.addEventListener("click", () => { clicks++; });
    f.tabs[1].click();
    assert.equal(clicks, 1);
    assert.equal(f.captured(), undefined);
  } finally { f.dom.window.close(); }
});

test("ordinary clicks retain the tab target; close controls do not start a drag", () => {
  const f = fixture();
  try {
    f.pointer("pointerdown", f.tabs[0], 20);
    assert.equal(f.captureTarget(), f.tabs[0]);
    f.pointer("pointerup", f.tabs[0], 20);
    assert.equal(f.captured(), undefined);
    f.pointer("pointerdown", f.tabs[0].querySelector("button")!, 20);
    f.pointer("pointermove", f.root, 210);
    assert.equal(f.captured(), undefined);
    let clicks = 0;
    f.root.addEventListener("click", () => { clicks++; });
    f.pointer("pointerdown", f.tabs[0], 20);
    f.pointer("pointermove", f.root, 210);
    f.pointer("pointerup", f.root, 210);
    f.tabs[0].click();
    assert.equal(clicks, 0);
    assert.equal(f.moves.length, 1);
  } finally { f.dom.window.close(); }
});

test("capture transfers to the stable root without cancelling the drag", () => {
  const f = fixture();
  try {
    f.pointer("pointerdown", f.tabs[0], 20);
    assert.equal(f.captured(), 1, "The first move is captured even over the terminal overlay");
    f.pointer("pointermove", f.tabs[0], 210);
    f.pointer("lostpointercapture", f.tabs[0], 210);
    assert.equal(f.captureTarget(), f.root);
    assert.ok(f.root.querySelector(".dragging"));
    f.pointer("pointerup", f.root, 210);
    assert.deepEqual(f.moves, [{ id: "a", to: { before: "" } }]);
  } finally { f.dom.window.close(); }
});
