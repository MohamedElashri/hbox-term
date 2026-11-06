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

test("unsupported installations never download or install an update", async () => {
  const log: string[] = [];
  const controller = new UpdateController(async () => fakeUpdate(log), async () => {}, () => {}, async () => {
    throw new Error("Development builds update with git pull and make.");
  });
  await controller.checkNow();
  await controller.install();
  assert.deepEqual(log, ["close"]);
  assert.equal(controller.state.phase, "error");
  assert.match(controller.state.error ?? "", /Development builds/);
});

test("concurrent checks and installs do not duplicate requests", async () => {
  let finishCheck!: (value: UpdatePackage) => void;
  let checks = 0;
  let finishDownload!: () => void;
  const log: string[] = [];
  const update = fakeUpdate(log);
  update.download = async () => { log.push("download"); await new Promise<void>(resolve => { finishDownload = resolve; }); };
  const controller = new UpdateController(() => {
    checks += 1;
    return new Promise(resolve => { finishCheck = resolve; });
  }, async () => {}, () => {});
  const firstCheck = controller.checkNow();
  await controller.checkNow();
  // checkNow first releases the previous updater resource.
  await Promise.resolve();
  assert.equal(checks, 1);
  finishCheck(update);
  await firstCheck;
  const firstInstall = controller.install();
  await controller.install();
  await controller.checkNow();
  assert.deepEqual(log, ["download"]);
  assert.equal(checks, 1);
  finishDownload();
  await firstInstall;
  assert.deepEqual(log, ["download", "install", "close"]);
});

test("failed downloads release their resource and a fresh check can retry", async () => {
  const log: string[] = [];
  let checks = 0;
  const controller = new UpdateController(async () => fakeUpdate(log, ++checks === 1 ? { downloadError: new Error("offline") } : {}), async () => {}, () => {});
  await controller.checkNow();
  await controller.install();
  assert.equal(controller.state.phase, "error");
  await controller.checkNow();
  assert.equal(controller.state.error, undefined);
  await controller.install();
  assert.equal(controller.state.phase, "installed");
  assert.deepEqual(log, ["download", "close", "download", "install", "close"]);
});

test("an install failure releases the package and never restarts", async () => {
  const log: string[] = [];
  const update = fakeUpdate(log);
  update.install = async () => { throw new Error("permission denied"); };
  const controller = new UpdateController(async () => update, async () => { log.push("restart"); }, () => {});
  await controller.checkNow();
  await controller.install();
  await controller.restartNow();
  assert.equal(controller.state.phase, "error");
  assert.match(controller.state.error ?? "", /permission denied/);
  assert.deepEqual(log, ["download", "close"]);
});

test("a failed restart keeps the installed update ready to retry", async () => {
  let restarts = 0;
  const controller = new UpdateController(async () => fakeUpdate([]), async () => {
    if (++restarts === 1) throw new Error("restart blocked");
  }, () => {});
  await controller.checkNow();
  await controller.install();
  await controller.restartNow();
  assert.equal(controller.state.phase, "installed");
  assert.match(controller.state.error ?? "", /Quit and reopen/);
  await controller.restartNow();
  assert.equal(restarts, 2);
  assert.equal(controller.state.error, undefined);
});

test("cancelling restart keeps an installed update ready without displaying a failure", async () => {
  const controller = new UpdateController(async () => fakeUpdate([]), async () => { throw { message: "Restart cancelled; all windows remain open" }; }, () => {});
  await controller.checkNow(); await controller.install(); await controller.restartNow();
  assert.equal(controller.state.phase, "installed"); assert.equal(controller.state.error, undefined);
});
test("structured restart errors show their message instead of object serialization", async () => {
  const controller = new UpdateController(async () => fakeUpdate([]), async () => { throw { message: "Saving a window failed" }; }, () => {});
  await controller.checkNow(); await controller.install(); await controller.restartNow();
  assert.match(controller.state.error ?? "", /Saving a window failed/);
  assert.doesNotMatch(controller.state.error ?? "", /object Object/);
});
