import assert from "node:assert/strict";
import { test } from "node:test";
import { completions, wordBeforeCursor } from "../src/app/completion.ts";

const output = [
  "Compiling ternway v0.1.0 (/home/me/projects/ternway/src-tauri)",
  "error: could not find `pty_output.rs` in src/",
  "warning: unused variable `terminal_sessions`.",
];

test("words that extend the prefix, newest first", () => {
  assert.deepEqual(completions(output, "term"), ["terminal_sessions"]);
  assert.deepEqual(completions(output, "/home/me/pro"), ["/home/me/projects/ternway/src-tauri"]);
  assert.deepEqual(completions(output, "tern"), ["ternway"]);
});

test("trailing punctuation and duplicates are dropped", () => {
  assert.deepEqual(completions(["see foo.rs.", "foo.rs, again"], "foo"), ["foo.rs"]);
  assert.deepEqual(completions(["abc"], "abc"), [], "the prefix itself is not a completion");
});

test("the word before the cursor", () => {
  assert.equal(wordBeforeCursor("$ cargo build --manifest-path src-ta"), "src-ta");
  assert.equal(wordBeforeCursor("$ ls "), "");
});
