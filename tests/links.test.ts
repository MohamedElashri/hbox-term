import assert from "node:assert/strict";
import { test } from "node:test";
import { findPathCandidates } from "../src/app/links.ts";

const paths = (text: string) => findPathCandidates(text).map(({ path, line, column }) => [path, line, column]);

test("compiler and tool output", () => {
  assert.deepEqual(paths("error[E0308]: --> src/main.rs:12:5"), [["src/main.rs", 12, 5]]);
  assert.deepEqual(paths("  File \"/usr/lib/python3/x.py\", line 4"), [["/usr/lib/python3/x.py", undefined, undefined]]);
  assert.deepEqual(paths("modified:   README.md"), [["README.md", undefined, undefined]]);
  assert.deepEqual(paths("see ~/notes/todo.txt and ./run.sh"), [["~/notes/todo.txt", undefined, undefined], ["./run.sh", undefined, undefined]]);
});

test("ordinary words and URLs are not candidates", () => {
  assert.deepEqual(paths("build finished in 3.2s with 0 errors"), []);
  assert.deepEqual(paths("version 1.2.3"), []);
  assert.deepEqual(paths("open https://example.com/docs/index.html"), []);
});

test("offsets cover the line and column suffix", () => {
  const [candidate] = findPathCandidates("at lib/a.ts:3");
  assert.equal("at lib/a.ts:3".slice(candidate.start, candidate.end), "lib/a.ts:3");
});
