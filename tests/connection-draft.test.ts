import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionDraft } from "../src/app/connection-draft.ts";

function form(values: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({ host: " host.example ", username: " alice ", authMethod: "password", ...values })) data.set(key, value);
  return data;
}

test("minimal connection uses host as name and defaults to SSH port", () => {
  const draft = connectionDraft(form());
  assert.equal(draft.name, "host.example");
  assert.equal(draft.host, "host.example");
  assert.equal(draft.username, "alice");
  assert.equal(draft.port, 22);
});
test("editing with blank secrets preserves existing vault values", () => {
  const draft = connectionDraft(form({ password: "", keyPassphrase: "", sudoPassword: "" }), "existing");
  for (const key of ["password", "keyPassphrase", "sudoPassword"]) assert.equal(Object.hasOwn(draft, key), false);
  assert.equal(draft.id, "existing");
});
test("replacement secrets are preserved exactly", () => {
  const draft = connectionDraft(form({ password: " secret ", sudoPassword: "sudo" }), "existing");
  assert.equal(draft.password, " secret ");
  assert.equal(draft.sudoPassword, "sudo");
});
test("private keys accept macOS and Linux paths and custom path wins", () => {
  for (const path of ["/Users/alice/.ssh/id_ed25519", "/home/alice/.ssh/id_ed25519"]) {
    assert.equal(connectionDraft(form({ authMethod: "privateKey", customKeyPath: path, keyPath: "/other" })).keyPath, path);
  }
  assert.throws(() => connectionDraft(form({ authMethod: "privateKey" })), /private key/);
  assert.equal(connectionDraft(form({ keyPath: "/unused" })).keyPath, undefined);
});
test("invalid input cannot reach the backend through either save action", () => {
  for (const port of ["0", "65536", "22.5", "invalid"]) assert.throws(() => connectionDraft(form({ port })), /port/);
  for (const key of ["host", "username"]) assert.throws(() => connectionDraft(form({ [key]: " " })), /host and username/);
  assert.throws(() => connectionDraft(form({ authMethod: "unknown" })), /authentication/);
});
test("organization and routing survive editing even when sections are collapsed", () => {
  const draft = connectionDraft(form({ name: "Production", port: "2222", jumpHostId: "bastion", groupName: "  Team   A ", tags: "web, prod, web", notes: "keep\nnotes", favorite: "on" }), "existing");
  assert.equal(draft.name, "Production");
  assert.equal(draft.port, 2222);
  assert.equal(draft.jumpHostId, "bastion");
  assert.equal(draft.groupName, "Team A");
  assert.deepEqual(draft.tags, ["web", "prod"]);
  assert.equal(draft.notes, "keep\nnotes");
  assert.equal(draft.favorite, true);
});

test("agent authentication delegates username to identity and omits login secrets", () => {
  const draft = connectionDraft(form({ authMethod: "sshAgent", identityId: "work", username: "", password: "stale", keyPassphrase: "stale", keyPath: "/stale" }));
  assert.equal(draft.identityId, "work");
  assert.equal(draft.authMethod, "sshAgent");
  assert.equal(draft.keyPath, undefined);
  assert.equal(Object.hasOwn(draft, "password"), false);
  assert.equal(Object.hasOwn(draft, "keyPassphrase"), false);
  assert.throws(() => connectionDraft(form({ authMethod: "sshAgent" })), /identity/);
});
test("switching away from agent removes identity reference", () => {
  assert.equal(connectionDraft(form({ identityId: "stale" })).identityId, undefined);
});

test("OpenSSH references keep config and alias while omitting managed credentials and routing", () => {
  const draft = connectionDraft(form({ authMethod: "openSsh", openSshAlias: " work ", openSshConfigPath: "/home/alice/SSH config", host: "wrong-preview", username: "wrong-user", port: "invalid", identityId: "old", password: "old-secret", keyPassphrase: "old-secret", sudoPassword: "old-secret", jumpHostId: "old-bastion" }));
  assert.equal(draft.host, "work");
  assert.deepEqual(draft.openSsh, { alias: "work", configPath: "/home/alice/SSH config", shareConnection: true });
  assert.equal(draft.username, "");
  for (const key of ["password", "keyPassphrase", "sudoPassword"]) assert.equal(Object.hasOwn(draft, key), false);
  for (const key of ["keyPath", "identityId", "jumpHostId"]) assert.equal(draft[key], undefined);
  assert.equal(connectionDraft(form({ authMethod: "openSsh", openSshAlias: "work" })).openSsh?.configPath, undefined);
});

test("OpenSSH aliases cannot smuggle options or additional arguments", () => {
  for (const alias of ["", "-oProxyCommand=bad", "host extra", "host\nother", "host\0other"]) {
    assert.throws(() => connectionDraft(form({ authMethod: "openSsh", openSshAlias: alias })), /OpenSSH host alias/);
  }
});

test("OpenSSH sharing can defer to configured multiplexing", () => {
  assert.equal(connectionDraft(form({ authMethod: "openSsh", openSshAlias: "work", openSshSharing: "config" })).openSsh?.shareConnection, false);
});

test("external password references replace password copies and require explicit valid source", () => {
  const draft = connectionDraft(form({ passwordProvider: "onePassword", passwordReference: " op://Work/QA/password " }), "existing");
  assert.deepEqual(draft.passwordReference, { provider: "onePassword", reference: "op://Work/QA/password" });
  assert.equal(Object.hasOwn(draft, "password"), false);
  assert.throws(() => connectionDraft(form({ passwordProvider: "onePassword", passwordReference: "" })), /reference/);
  assert.throws(() => connectionDraft(form({ passwordProvider: "shell", passwordReference: "anything" })), /provider/);
  assert.throws(() => connectionDraft(form({ passwordProvider: "bitwarden", passwordReference: "id", password: "secret" })), /empty/);
  assert.equal(connectionDraft(form({ authMethod: "openSsh", openSshAlias: "work", passwordProvider: "onePassword", passwordReference: "unused" })).passwordReference, undefined);
});
