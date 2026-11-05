import assert from "node:assert/strict";
import { test } from "node:test";
import { unavailableToolReason } from "../src/app/navigation.ts";

const host = { systemd: false, docker: false, podman: false, sudo: false, journalctl: false, logread: false, cron: false, architecture: "aarch64", coreutilsVariant: "bsd", root: false };

test("terminal and files remain available on non-systemd hosts", () => {
  for (const view of ["terminal", "files", "dashboard"]) assert.equal(unavailableToolReason(view, host), undefined);
  assert.match(unavailableToolReason("services", host)!, /systemd/);
});
test("either container runtime enables container tools", () => {
  assert.ok(unavailableToolReason("docker", host));
  assert.equal(unavailableToolReason("docker", { ...host, podman: true }), undefined);
  assert.equal(unavailableToolReason("docker", { ...host, docker: true }), undefined);
});
test("Linux tools follow detected capabilities rather than desktop OS", () => {
  const linux = { ...host, systemd: true, cron: true, packageManager: "apt-get", networkTool: "ss" };
  for (const view of ["services", "cron", "packages", "network"]) assert.equal(unavailableToolReason(view, linux), undefined);
  assert.ok(unavailableToolReason("packages", { ...linux, packageManager: "dnf" }));
});
test("unknown capabilities do not prematurely reject a tool", () => {
  assert.equal(unavailableToolReason("terminal", null), undefined);
  assert.equal(unavailableToolReason("services", undefined), undefined);
});
