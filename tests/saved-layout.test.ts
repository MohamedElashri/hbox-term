import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSavedLayout } from "../src/app/saved-layout.ts";

const group = () => ({ title: "Work", focusedId: "a", root: { kind: "leaf", terminalId: "a" }, panes: { a: { cwd: "/work", profile: "dev", snapshot: "historical output" } } });

test("old local layouts migrate as inert data and strip commands and input", () => {
  const saved = group();
  Object.assign(saved.panes.a, { command: "must-not-run", input: "must-not-replay" });
  const layout = parseSavedLayout({ version: 1, activeGroup: 0, groups: [saved] });
  assert.equal(layout.version, 2); assert.equal(layout.groups[0].workspace, "local");
  assert.deepEqual(layout.groups[0].panes.a, { cwd: "/work", profile: "dev", snapshot: "historical output" });
});

test("remote layouts preserve profile references and labels without credentials", () => {
  const layout = parseSavedLayout({ version: 2, activeGroup: 0, activeWorkspace: "remote", workspaces: [{ id: "remote", serverId: "profile-id", label: "Production", password: "not-retained" }], groups: [{ ...group(), workspace: "remote" }] });
  assert.deepEqual(layout.workspaces, [{ id: "remote", serverId: "profile-id", label: "Production" }]);
  assert.equal(layout.activeWorkspace, "remote");
});

test("invalid, oversized and ambiguous layout trees are rejected before restoration", () => {
  const bad = (root: unknown) => ({ version: 1, groups: [{ ...group(), root }] });
  for (const root of [null, { kind: "unknown" }, { kind: "split", direction: "right", ratio: NaN }, { kind: "split", direction: "down", ratio: .5, first: group().root, second: group().root }]) assert.throws(() => parseSavedLayout(bad(root)));
  let deep: unknown = group().root;
  for (let n = 0; n < 14; n++) deep = { kind: "split", direction: "right", ratio: .5, first: deep, second: { kind: "leaf", terminalId: `b${n}` } };
  assert.throws(() => parseSavedLayout(bad(deep)), /deep/);
  assert.throws(() => parseSavedLayout({ version: 3, groups: [] }));
  assert.throws(() => parseSavedLayout({ version: 1, groups: Array.from({ length: 129 }, group) }));
  assert.throws(() => parseSavedLayout({ version: 2, groups: [{ ...group(), workspace: "missing" }] }));
});
