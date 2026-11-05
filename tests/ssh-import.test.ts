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
