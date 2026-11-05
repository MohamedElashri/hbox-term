import { test } from "node:test";
import assert from "node:assert/strict";
import { closeWarning } from "../src/app/terminal-close-policy.ts";

test("idle and exited local shells close without unnecessary prompts", () => {
  assert.equal(closeWarning([]), undefined);
  assert.equal(closeWarning([{ remote: false, activity: "idle" }, { remote: true, activity: "closed" }]), undefined);
});

test("foreground jobs, unknown local activity and SSH sessions get accurate warnings", () => {
  const warning = closeWarning([{ remote: false, activity: "busy" }, { remote: false, activity: "unknown" }, { remote: true, activity: "idle" }]);
  assert.match(warning!, /1 local job is still running/);
  assert.match(warning!, /1 SSH session will disconnect/);
  assert.match(warning!, /could not be checked/);
  assert.match(warning!, /Save changes/);
});
