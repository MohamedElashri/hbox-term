import assert from "node:assert/strict";
import { test } from "node:test";
import { saveConnection, type ConnectionSaveEffects } from "../src/app/connection-save.ts";
import type { ServerSaveResult } from "../src/types.ts";

function fixture(invalidatedServerIds: string[] = []) {
  const calls: string[] = [];
  const effects: ConnectionSaveEffects = {
    persist: async () => { calls.push("persist"); return { server: { id: "saved" }, invalidatedServerIds } as ServerSaveResult; },
    invalidate: async id => { calls.push(`invalidate:${id}`); },
    refresh: async () => { calls.push("refresh"); },
    finish: () => { calls.push("finish"); },
    connect: async id => { calls.push(`connect:${id}`); },
  };
  return { calls, effects };
}

test("Save connection persists and refreshes the library without contacting a host", async () => {
  const { calls, effects } = fixture();
  await saveConnection(false, effects);
  assert.deepEqual(calls, ["persist", "refresh", "finish"]);
});

test("Save & test connects exactly once, after the saved profile is refreshed", async () => {
  const { calls, effects } = fixture();
  await saveConnection(true, effects);
  assert.deepEqual(calls, ["persist", "refresh", "finish", "connect:saved"]);
});

test("editing a route closes invalidated sessions without reconnecting them", async () => {
  const { calls, effects } = fixture(["saved", "dependent"]);
  await saveConnection(false, effects);
  assert.deepEqual(calls, ["persist", "invalidate:saved", "invalidate:dependent", "refresh", "finish"]);
});

test("a failed save leaves the editor open and never attempts SSH", async () => {
  const { calls, effects } = fixture();
  effects.persist = async () => { throw new Error("fixture failure"); };
  await assert.rejects(saveConnection(true, effects), /fixture failure/);
  assert.deepEqual(calls, []);
});
