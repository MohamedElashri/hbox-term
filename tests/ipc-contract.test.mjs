import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

test("frontend IPC calls reference registered Tauri commands", () => {
  const backend = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const handlers = /tauri::generate_handler!\s*\[([^\]]+)\]/.exec(backend)?.[1];
  assert.ok(handlers, "Tauri command registration was not found");
  const registered = new Set(handlers.match(/\b[a-z][a-z_]+\b/g));
  const missing = [];
  let checked = 0;
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { scan(path); continue; }
      if (!path.endsWith(".ts")) continue;
      const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["invoke", "invokeCommand"].includes(node.expression.text)
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          checked++;
          if (!registered.has(node.arguments[0].text)) missing.push(`${path}: ${node.arguments[0].text}`);
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "remoteOperationLabels" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
          for (const property of node.initializer.properties) {
            if (!property.name) continue;
            const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : "";
            if (name && !registered.has(name)) missing.push(`Remote operation label: ${name}`);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  scan(fileURLToPath(new URL("../src", import.meta.url)));
  assert.ok(checked > 0, "No frontend command calls were checked");
  assert.deepEqual(missing, [], "Every frontend IPC call must have a matching backend command");
});
