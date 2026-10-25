import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyFilter, fuzzyScore } from "../src/app/fuzzy.ts";

test("characters must appear in order", () => {
  assert.notEqual(fuzzyScore("spr", "Split right"), null);
  assert.equal(fuzzyScore("rps", "Split right"), null);
  assert.equal(fuzzyScore("", "anything"), 0);
});

test("word starts and runs rank higher", () => {
  const items = ["Close pane", "Clear screen", "Split right", "Reload config", "Select all"];
  assert.equal(fuzzyFilter("sr", items, (item) => item)[0], "Split right");
  assert.equal(fuzzyFilter("cle", items, (item) => item)[0], "Clear screen");
  assert.equal(fuzzyFilter("conf", items, (item) => item)[0], "Reload config");
});

test("ties keep the original order", () => {
  assert.deepEqual(fuzzyFilter("", ["b", "a"], (item) => item), ["b", "a"]);
});
