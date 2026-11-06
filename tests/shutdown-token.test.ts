import assert from "node:assert/strict";
import { test } from "node:test";
import { ShutdownToken } from "../src/app/shutdown-token.ts";
test("only the current shutdown can release its window's input freeze", () => {
  const token = new ShutdownToken(); assert.equal(token.active, false);
  token.freeze("first"); token.freeze("second");
  assert.equal(token.release("first"), false); assert.equal(token.active, true);
  assert.equal(token.release("second"), true); assert.equal(token.active, false);
  assert.equal(token.release("second"), false);
});
