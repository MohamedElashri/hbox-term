import assert from "node:assert/strict";
import { test } from "node:test";
import { UpdateController, type DownloadEvent, type UpdatePackage } from "../src/app/updates.ts";

function fakeUpdate(log: string[], options: { downloadError?: Error } = {}): UpdatePackage {
  return {
    version: "0.2.0",
    body: "Notes",
    date: "2026-11-01",
    async download(onEvent: (event: DownloadEvent) => void) {
      log.push("download");
      onEvent({ event: "Started", data: { contentLength: 10 } });
      onEvent({ event: "Progress", data: { chunkLength: 10 } });
      onEvent({ event: "Finished" });
      if (options.downloadError) throw options.downloadError;
    },
    async install() { log.push("install"); },
    async close() { log.push("close"); },
  };
}

test("nothing happens until a check is requested", () => {
  let checks = 0;
  const controller = new UpdateController(async () => { checks += 1; return null; }, async () => {}, () => {});
  assert.equal(controller.state.phase, "idle");
  assert.equal(checks, 0);
});

test("reports when the running version is current", async () => {
  const controller = new UpdateController(async () => null, async () => {}, () => {});
  await controller.checkNow();
  assert.equal(controller.state.phase, "current");
});

test("downloads, installs and restarts only when asked", async () => {
  const log: string[] = [];
  let restarted = false;
  const controller = new UpdateController(async () => fakeUpdate(log), async () => { restarted = true; }, () => {});
  await controller.checkNow();
  assert.equal(controller.state.phase, "available");
  assert.equal(controller.state.version, "0.2.0");
  assert.deepEqual(log, []);
  await controller.install();
  assert.deepEqual(log, ["download", "install", "close"]);
  assert.equal(controller.state.phase, "installed");
  assert.equal(controller.state.downloaded, 10);
  assert.equal(restarted, false);
  await controller.restartNow();
  assert.equal(restarted, true);
});

test("a failed verification never installs", async () => {
  const log: string[] = [];
  const controller = new UpdateController(async () => fakeUpdate(log, { downloadError: new Error("signature mismatch") }), async () => {}, () => {});
  await controller.checkNow();
  await controller.install();
  assert.deepEqual(log, ["download", "close"]);
  assert.equal(controller.state.phase, "error");
  assert.match(controller.state.error ?? "", /signature mismatch/);
});

test("check failures are reported", async () => {
  const controller = new UpdateController(async () => { throw new Error("offline"); }, async () => {}, () => {});
  await controller.checkNow();
  assert.equal(controller.state.phase, "error");
  assert.match(controller.state.error ?? "", /offline/);
});
