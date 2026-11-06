import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandTracker } from "../src/app/shell-integration.ts";

globalThis.self = globalThis;
const { Terminal } = (await import("@xterm/xterm")).default;
const write = (term, text: string) => new Promise<void>(resolve => term.write(text, resolve));
const mark = (value: string) => `\x1b]133;${value}\x07`;

async function capture(output: string, cols = 80) {
  const term = new Terminal({ allowProposedApi: true, cols, rows: 24 });
  const tracker = new CommandTracker(term, { onDirectory() {}, onFinished() {} });
  await write(term, `${mark("A")}$ command\r\n${mark("C")}${output}${mark("D;0")}${mark("A")}$ next prompt`);
  return { term, tracker };
}

test("copy last output includes an unterminated final line and excludes the next prompt", async () => {
  for (const output of ["hello", "first\r\nlast", "first\r\nlast\r\n", ""]) {
    const { term, tracker } = await capture(output);
    try { assert.equal(tracker.lastOutput(), output.replace(/\r/g, "").replace(/\n+$/, "")); }
    finally { tracker.dispose(); term.dispose(); }
  }
});

test("copy last output joins wrapped rows and includes the partial final row", async () => {
  const output = "a".repeat(35) + "終";
  const { term, tracker } = await capture(output, 20);
  try { assert.equal(tracker.lastOutput(), output); }
  finally { tracker.dispose(); term.dispose(); }
});

test("command boundaries exclude text before output on the same terminal row", async () => {
  const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
  const tracker = new CommandTracker(term, { onDirectory() {}, onFinished() {} });
  try {
    await write(term, `${mark("A")}prefix: ${mark("C")}result 終${mark("D;0")} next prompt`);
    assert.equal(tracker.lastOutput(), "result 終");
  } finally { tracker.dispose(); term.dispose(); }
});
