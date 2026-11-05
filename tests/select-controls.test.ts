import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { enhanceSelects, syncCustomSelect } from "../src/app/select-controls.ts";

test("enhanced selects announce the field name and current value", () => {
  const dom = new JSDOM('<main><label><span>Terminal renderer</span><select name="renderer"><option value="auto">Automatic</option><option value="dom">DOM</option></select></label></main>');
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  enhanceSelects(root);
  const picker = root.querySelector<HTMLElement>(".custom-select")!;
  const trigger = picker.querySelector("button")!;
  assert.equal(trigger.getAttribute("aria-label"), "Terminal renderer: Automatic");
  picker.querySelector("select")!.value = "dom";
  syncCustomSelect(picker);
  assert.equal(trigger.getAttribute("aria-label"), "Terminal renderer: DOM");
  assert.equal(picker.querySelector('[data-value="dom"]')?.getAttribute("aria-selected"), "true");
  dom.window.close();
});

test("the hidden native select still submits its value without duplicating keyboard focus", () => {
  const dom = new JSDOM('<main><form><select name="auth" aria-label="Authentication"><option value="agent">SSH agent</option></select></form></main>');
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  enhanceSelects(root);
  const select = root.querySelector("select")!;
  assert.equal(select.tabIndex, -1);
  assert.equal(select.getAttribute("aria-hidden"), "true");
  assert.equal(new dom.window.FormData(root.querySelector("form")!).get("auth"), "agent");
  assert.equal(root.querySelector("button")?.getAttribute("aria-label"), "Authentication: SSH agent");
  dom.window.close();
});

test("disabled selects and options stay disabled after enhancement", () => {
  const dom = new JSDOM('<main><select disabled><option>Selected</option><option disabled>Unavailable</option></select></main>');
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  enhanceSelects(root);
  assert.equal(root.querySelector<HTMLButtonElement>(".custom-select-trigger")?.disabled, true);
  assert.equal(root.querySelector<HTMLButtonElement>('[data-value="Unavailable"]')?.disabled, true);
  enhanceSelects(root);
  assert.equal(root.querySelectorAll(".custom-select").length, 1);
  dom.window.close();
});
