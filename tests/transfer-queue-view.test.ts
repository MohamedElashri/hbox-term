import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { renderTransferQueue, type TransferJob } from "../src/app/transfer-queue-view.ts";
const job = (status: string): TransferJob => ({ id: 'id"bad', serverId: "server", direction: "upload", localPath: '<script>secret</script>', remotePath: "/remote", overwrite: false, status, error: '<img onerror="oops">' });
test("transfer history escapes paths and errors and offers only safe actions", () => {
  for (const status of ["complete", "invalidated", "running", "paused", "failed", "queued"]) {
    const document = new JSDOM(renderTransferQueue([job(status)])).window.document;
    assert.equal(document.querySelector("script,img"), null);
    assert.match(document.body.textContent!, /<script>secret<\/script>/);
    assert.equal(document.querySelector('[data-job-id]')?.getAttribute("data-job-id"), status === "running" ? undefined : 'id"bad');
    if (["complete", "invalidated"].includes(status)) assert.equal(document.querySelector('[data-job-action="retry"]'), null);
    if (status === "running") assert.ok(document.querySelector('[data-action="cancel-transfer"]'));
    if (status === "paused") assert.ok(document.querySelector('[data-job-action="retry"]'));
    assert.equal(Boolean(document.querySelector('[data-job-action="replace"]')), status === "failed");
  }
});
