import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.self = globalThis;
const { Terminal } = (await import("@xterm/xterm")).default;
const { Unicode11Addon } = (await import("@xterm/addon-unicode11")).default;
const write = (term, bytes) => new Promise(resolve => term.write(bytes, resolve));

test("split UTF-8, combining marks, wide characters and emoji keep their cell widths", async () => {
  const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
  term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = "11";
  const input = "A界e\u0301🙂Z";
  for (const byte of new TextEncoder().encode(input)) await write(term, new Uint8Array([byte]));
  assert.equal(term.buffer.active.getLine(0).translateToString(true), input);
  assert.equal(term.buffer.active.getLine(0).getCell(1).getWidth(), 2);
  assert.equal(term.buffer.active.cursorX, 7);
  term.dispose();
});

test("full-screen alternate buffers preserve the shell while repeatedly resizing", async () => {
  const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
  await write(term, "shell history");
  await write(term, "\x1b[?1049h\x1b[2J\x1b[Heditor\x1b[2;4Hselection\x1b[?25l");
  assert.equal(term.buffer.active.type, "alternate");
  assert.equal(term.buffer.active.getLine(0).translateToString(true), "editor");
  assert.equal(term.buffer.active.getLine(1).translateToString(true), "   selection");
  for (let n = 0; n < 100; n++) term.resize(80 + n % 20, 24 + n % 10);
  await write(term, "\x1b[?1049l\x1b[?25h");
  assert.equal(term.buffer.active.type, "normal");
  assert.equal(term.buffer.active.getLine(0).translateToString(true), "shell history");
  term.dispose();
});
