import assert from "node:assert/strict";
import { test } from "node:test";
import { ClipboardHistory } from "../src/app/clipboard-history.ts";
test("clipboard history requires opt-in, expires, bounds size and clears previous copies", () => {
  const history = new ClipboardHistory();
  history.remember("secret", false, 0); assert.deepEqual(history.values(0), []);
  history.remember("first", true, 0); history.remember("second", true, 1); history.remember("first", true, 2);
  assert.deepEqual(history.values(3), ["first", "second"]);
  history.remember("x".repeat(65537), true, 3); assert.equal(history.values(3).length, 2);
  assert.deepEqual(history.values(120002), []);
  for (let i = 0; i < 30; i++) history.remember(String(i), true, 130000);
  assert.equal(history.values(130000).length, 25);
  history.remember("disabled", false, 130001); assert.deepEqual(history.values(130001), []);
});
