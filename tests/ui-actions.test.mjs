import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("every rendered action has a registered UI handler", () => {
  const source = readFileSync("src/app/events.ts", "utf8");
  const handled = new Set([...source.matchAll(/case "([a-z][a-z-]+)"/g)].map(match => match[1]));
  const missing = [];
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (path.endsWith(".ts")) {
        for (const match of readFileSync(path, "utf8").matchAll(/data-action="([a-z][a-z-]+)"/g)) {
          if (!handled.has(match[1])) missing.push(`${path}: ${match[1]}`);
        }
      }
    }
  }
  scan("src");
  assert.deepEqual(missing, [], "A visible control must dispatch an implemented action");
});
