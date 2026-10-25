import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutPanes, leaf, leaves, mapLeaves, neighbor, PANE_GAP, removeLeaf, replaceLeaf, splitLeaf, type PaneNode } from "../src/app/panes.ts";

const area = { x: 0, y: 0, width: 801, height: 401 };

function grid(): PaneNode {
  // a | b
  // --+--
  // c | (b spans)
  let tree = leaf("a");
  tree = splitLeaf(tree, "a", "b", "right");
  tree = splitLeaf(tree, "a", "c", "down");
  return tree;
}

test("splitting keeps reading order and nests in place", () => {
  assert.deepEqual(leaves(grid()), ["a", "c", "b"]);
});

test("removing a leaf promotes its sibling", () => {
  const tree = removeLeaf(grid(), "c");
  assert.deepEqual(tree && leaves(tree), ["a", "b"]);
  assert.equal(removeLeaf(leaf("a"), "a"), null);
});

test("replacing a leaf keeps its position", () => {
  assert.deepEqual(leaves(replaceLeaf(grid(), "c", "d")), ["a", "d", "b"]);
});

test("layout fills the area with a gap between panes", () => {
  const { panes, dividers } = layoutPanes(grid(), area);
  const a = panes.get("a")!;
  const b = panes.get("b")!;
  const c = panes.get("c")!;
  assert.equal(a.width + PANE_GAP + b.width, area.width);
  assert.equal(a.height + PANE_GAP + c.height, area.height);
  assert.equal(b.height, area.height);
  assert.equal(dividers.length, 2);
});

test("ratio changes resize panes", () => {
  const tree = splitLeaf(leaf("a"), "a", "b", "right");
  if (tree.kind === "split") tree.ratio = 0.25;
  const { panes } = layoutPanes(tree, area);
  assert.equal(panes.get("a")!.width, 200);
});

test("neighbor follows geometry", () => {
  const { panes } = layoutPanes(grid(), area);
  assert.equal(neighbor(panes, "a", "right"), "b");
  assert.equal(neighbor(panes, "a", "down"), "c");
  assert.equal(neighbor(panes, "c", "up"), "a");
  assert.equal(neighbor(panes, "c", "right"), "b");
  // From the tall pane, prefer the one aligned with its top edge.
  assert.equal(neighbor(panes, "b", "left"), "a");
  assert.equal(neighbor(panes, "a", "left"), undefined);
});

test("mapLeaves copies the tree with new ids", () => {
  const original = grid();
  const copy = mapLeaves(original, (id) => `new-${id}`);
  assert.deepEqual(leaves(copy), ["new-a", "new-c", "new-b"]);
  assert.deepEqual(leaves(original), ["a", "c", "b"], "original untouched");
  assert.deepEqual(layoutPanes(copy, area).panes.get("new-b"), layoutPanes(original, area).panes.get("b"));
});
