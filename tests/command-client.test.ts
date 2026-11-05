import assert from "node:assert/strict";
import { test } from "node:test";
import { createCommandClient, OperationCancelledError, type CommandClientOptions } from "../src/app/command-client.ts";
import type { ActiveOperation } from "../src/app/types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const unknownHost = { kind: "hostKeyUnknown", host: "qa.example.test", port: 239, keyType: "ssh-ed25519", fingerprint: "SHA256:fixture" };

function fixture(handler: (command: string, args?: Record<string, unknown>) => Promise<unknown>) {
  let active: ActiveOperation | null = null;
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const connected: string[] = [];
  let prompts = 0;
  const options: CommandClientOptions = {
    invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args });
      return await handler(command, args) as T;
    },
    getActiveOperation: () => active,
    setActiveOperation: (value: ActiveOperation | null) => { active = value; },
    onRemoteOperationSuccess: (serverId: string) => { connected.push(serverId); },
    render: () => {},
    unlockForCredentialError: async () => { prompts++; },
    requestHostKeyDecision: async () => { prompts++; return false; },
    requestHostKeyTrust: async () => { prompts++; return false; },
  };
  return { options, calls, connected, active: () => active, prompts: () => prompts };
}

test("plain remote errors cannot impersonate host-key or credential prompts", async () => {
  for (const error of ['HOST_KEY_UNKNOWN: {"host":"fake"}', 'MASTER_PASSWORD_REQUIRED', '{"kind":"hostKeyUnknown"}']) {
    const f = fixture(async () => { throw error; });
    const client = createCommandClient(f.options);
    await assert.rejects(client.invokeCommand("connect_server", { serverId: "qa" }), value => value === error);
    assert.equal(f.prompts(), 0);
    assert.equal(f.active(), null);
  }
});

test("malformed structured host-key errors never become approval prompts", async () => {
  const error = { ...unknownHost, port: "239" };
  const f = fixture(async () => { throw error; });
  await assert.rejects(createCommandClient(f.options).invokeCommand("connect_server", { serverId: "qa" }), value => value === error);
  assert.equal(f.prompts(), 0);
});

test("host-key approval is pinned to the requested server and fingerprint", async () => {
  let attempts = 0;
  const f = fixture(async command => {
    if (command === "connect_server" && ++attempts === 1) throw unknownHost;
    return "connected";
  });
  f.options.requestHostKeyTrust = async () => true;
  assert.equal(await createCommandClient(f.options).invokeCommand("connect_server", { serverId: "qa" }), "connected");
  assert.deepEqual(f.calls.find(call => call.command === "accept_host_key")?.args, { serverId: "qa", expectedHost: unknownHost.host, expectedPort: 239, expectedFingerprint: unknownHost.fingerprint });
  assert.deepEqual(f.connected, ["qa"]);
});

test("a canceled operation cannot publish a late successful response", async () => {
  const result = deferred<string>();
  const f = fixture(async command => command === "connect_server" ? result.promise : undefined);
  const client = createCommandClient(f.options);
  const pending = client.invokeCommand("connect_server", { serverId: "qa" });
  client.cancelCurrentOperation();
  result.resolve("late response");
  await assert.rejects(pending, OperationCancelledError);
  assert.deepEqual(f.connected, []);
});

test("late host-key approval cannot cancel a newer connection", async () => {
  const prompted = deferred<void>();
  const decision = deferred<boolean>();
  const newerStarted = deferred<void>();
  const newerResult = deferred<string>();
  let attempts = 0;
  const f = fixture(async (command, args) => {
    if (command === "connect_server" && args?.serverId === "old" && ++attempts === 1) throw unknownHost;
    if (command === "connect_server" && args?.serverId === "new") { newerStarted.resolve(); return newerResult.promise; }
    return "connected";
  });
  f.options.requestHostKeyTrust = async () => { prompted.resolve(); return decision.promise; };
  const client = createCommandClient(f.options);
  const old = client.invokeCommand("connect_server", { serverId: "old" });
  await prompted.promise;
  const newer = client.invokeCommand("connect_server", { serverId: "new" });
  const newerOutcome = newer.catch(error => error);
  await newerStarted.promise;
  decision.resolve(true);
  try {
    await assert.rejects(old, OperationCancelledError);
    assert.equal(f.calls.some(call => call.command === "accept_host_key"), false);
    assert.equal(f.active()?.serverId, "new");
  } finally {
    newerResult.resolve("new connection");
    await newerOutcome;
  }
  assert.deepEqual(f.connected, ["new"]);
});

test("canceling during a host-key prompt dismisses it and cannot trust later", async () => {
  const prompted = deferred<void>();
  const decision = deferred<boolean>();
  const f = fixture(async command => {
    if (command === "connect_server") throw unknownHost;
  });
  f.options.requestHostKeyTrust = async () => { prompted.resolve(); return decision.promise; };
  let dismissed = 0;
  f.options.cancelRecovery = () => { dismissed++; decision.resolve(false); };
  const client = createCommandClient(f.options);
  const pending = client.invokeCommand("connect_server", { serverId: "qa" });
  await prompted.promise;
  client.cancelCurrentOperation();
  await assert.rejects(pending, OperationCancelledError);
  assert.equal(dismissed, 1);
  assert.equal(f.calls.some(call => call.command === "accept_host_key"), false);
});

test("a canceled credential prompt cannot publish its later failure", async () => {
  const prompted = deferred<void>();
  const unlock = deferred<void>();
  const f = fixture(async () => { throw { kind: "masterPasswordRequired" }; });
  f.options.unlockForCredentialError = async () => {
    prompted.resolve();
    await unlock.promise;
    throw new Error("late credential error");
  };
  const client = createCommandClient(f.options);
  const pending = client.invokeCommand("connect_server", { serverId: "qa" });
  await prompted.promise;
  client.cancelCurrentOperation();
  unlock.resolve();
  await assert.rejects(pending, OperationCancelledError);
  assert.equal(f.calls.filter(call => call.command === "connect_server").length, 1);
});
