import assert from "node:assert/strict";
import { test } from "node:test";
import { BRAND, buildSummary } from "../src/app/brand.ts";

test("brand links point to the Ternway project", () => {
  assert.equal(BRAND.name, "Ternway");
  assert.equal(BRAND.releases, "https://github.com/MohamedElashri/ternway/releases");
});
test("copied build details contain only selected build metadata", () => {
  const info = {version:"0.2.0-beta.1",os:"linux",arch:"aarch64",commit:"abc123",debug:false, password:"never copy",host:"private.example"};
  const text = buildSummary(info);
  assert.equal(text, "Ternway 0.2.0-beta.1\nPlatform: linux / aarch64\nBuild: release\nCommit: abc123");
  assert.ok(!text.includes(info.password));
  assert.ok(!text.includes(info.host));
});
