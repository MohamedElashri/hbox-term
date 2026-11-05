import { test } from "node:test";
import assert from "node:assert/strict";
import { installWindowEvents, type WindowListener } from "../src/app/window-events.ts";

test("targeted quit and native-menu events only reach their intended window", async () => {
  const listeners: { name: string; target?: string; callback: (event: {payload: unknown}) => void }[] = [];
  const listen: WindowListener = async (name, callback, options) => {
    const entry = { name, target: options?.target, callback: callback as (event: {payload: unknown}) => void };
    listeners.push(entry); return () => { listeners.splice(listeners.indexOf(entry), 1); };
  };
  const seen: string[] = [];
  await installWindowEvents("main", { quit: token => seen.push(`main:${token}`), about: () => seen.push("main:about"), updates: () => seen.push("main:updates") }, listen);
  await installWindowEvents("other", { quit: token => seen.push(`other:${token}`), about: () => seen.push("other:about"), updates: () => seen.push("other:updates") }, listen);
  const emitTo = (target: string, name: string, payload: unknown) => {
    // Tauri's unrestricted listeners receive every target. Restricted listeners must match.
    for (const entry of listeners) if (entry.name === name && (!entry.target || entry.target === target)) entry.callback({payload});
  };
  emitTo("main", "prepare-quit", { token: "q", windowLabel: "main" });
  emitTo("main", "show-about", null);
  emitTo("other", "check-updates", null);
  assert.deepEqual(seen, ["main:q", "main:about", "other:updates"]);
  emitTo("other", "prepare-quit", { token: "q", windowLabel: "main" });
  assert.equal(seen.length, 3, "A misrouted quit payload must not consume another window's token");
  emitTo("other", "prepare-quit", { token: "q", windowLabel: "other" });
  assert.equal(seen.at(-1), "other:q");
});

test("restart intent reaches only the intended window's save barrier", async () => {
  let handler: ((event: {payload: unknown}) => void) | undefined;
  const listen: WindowListener = async (name, callback) => { if (name === "prepare-quit") handler = callback as (event: {payload: unknown}) => void; return () => {}; };
  const calls: unknown[] = [];
  await installWindowEvents("main", { quit: (token, restart) => calls.push({token,restart}), about: () => {}, updates: () => {} }, listen);
  handler!({payload:{token:"restart",windowLabel:"other",restart:true}});
  assert.deepEqual(calls,[]);
  handler!({payload:{token:"restart",windowLabel:"main",restart:true}});
  assert.deepEqual(calls,[{token:"restart",restart:true}]);
});
