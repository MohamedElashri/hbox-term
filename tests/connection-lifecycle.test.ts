import { test } from "node:test";
import assert from "node:assert/strict";
import { phaseAfterHealth, freshSessionRequest, type ConnectionPhase } from "../src/app/connection-lifecycle.ts";

test("a native process is not an authenticated connection", () => {
  assert.equal(phaseAfterHealth("authenticating", true, true, true, false), "authenticating");
  assert.equal(phaseAfterHealth("authenticating", true, true, true, true), "ready");
  assert.equal(phaseAfterHealth("interactive", true, true, false, false), "interactive");
});

test("transport and process loss disconnect a ready pane without reviving it", () => {
  assert.equal(phaseAfterHealth("ready", true, true, true, false), "disconnected");
  assert.equal(phaseAfterHealth("ready", false, false, false, true), "disconnected");
  for (const phase of ["launching", "disconnected", "failed", "cancelled"] as ConnectionPhase[]) {
    assert.equal(phaseAfterHealth(phase, true, true, true, true), phase);
  }
});

test("reconnect constructs a fresh session rather than replaying input or a command", () => {
  const request = freshSessionRequest("new-id", "server", 80, 24, true, "/work");
  assert.deepEqual(request, { sessionId: "new-id", serverId: "server", cols: 80, rows: 24, shellIntegration: true, cwd: "/work" });
  assert.ok(!("command" in request)); assert.ok(!("input" in request));
});

test("large workspaces are checked without exceeding backend request bounds", async () => {
  const { healthBatches } = await import("../src/app/connection-lifecycle.ts");
  const servers = Array.from({ length: 130 }, (_, n) => `server-${n}`);
  const sessions = Array.from({ length: 1030 }, (_, n) => `session-${n}`);
  const batches = healthBatches(servers, sessions);
  assert.deepEqual(batches.flatMap(batch => batch.serverIds), servers);
  assert.deepEqual(batches.flatMap(batch => batch.sessionIds), sessions);
  assert.ok(batches.every(batch => batch.serverIds.length <= 64 && batch.sessionIds.length <= 512));
  assert.deepEqual(healthBatches([], []), []);
});
