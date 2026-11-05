import assert from "node:assert/strict";
import { test } from "node:test";
import { importedDraft } from "../src/app/ssh-import.ts";

test("import preserves host, port and key and fills missing username", () => {
  const draft = importedDraft({ alias: "lab", host: "lab.example", port: 239, keyPath: "/home/me/key" }, "ubuntu", " Lab ", "");
  assert.equal(draft.username, "ubuntu");
  assert.equal(draft.port, 239);
  assert.equal(draft.groupName, "Lab");
  assert.equal(draft.authMethod, "privateKey");
  assert.equal(Object.hasOwn(draft, "password"), false);
});
test("agent import binds identity without importing a key", () => {
  const draft = importedDraft({ alias: "lab", keyPath: "/key" }, "", "Lab", "identity");
  assert.equal(draft.authMethod, "sshAgent");
  assert.equal(draft.identityId, "identity");
  assert.equal(draft.keyPath, undefined);
});
test("missing username is caught before saving", () => {
  assert.throws(() => importedDraft({ alias: "lab" }, "", "Lab", ""), /username/);
});

test("unsupported routes cannot silently become direct connections", () => {
  assert.throws(() => importedDraft({ alias: "internal", issues: ["proxyjump is not imported"] }, "ubuntu", "", ""), /manual configuration/);
});
test("explicit password preference wins over an available key", () => {
  assert.equal(importedDraft({ alias: "lab", authMethod: "password", keyPath: "/key" }, "ubuntu", "", "").authMethod, "password");
});

test("linked imports retain the source alias even when static settings cannot be represented", async () => {
  const { linkedDraft } = await import("../src/app/ssh-import.ts");
  const draft = linkedDraft({ alias: "internal", host: "preview.example", username: "preview", port: 239, keyPath: "/one-key", issues: ["ProxyJump and dynamic rules"] }, "/home/alice/custom config", " Work ");
  assert.equal(draft.authMethod, "openSsh");
  assert.equal(draft.host, "internal");
  assert.equal(draft.username, "");
  assert.deepEqual(draft.openSsh, { alias: "internal", configPath: "/home/alice/custom config" });
  assert.equal(draft.groupName, "Work");
  assert.equal(Object.hasOwn(draft, "password"), false);
  assert.equal(Object.hasOwn(draft, "keyPath"), false);
});
