import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderWorkspaceRows } from "../src/app/workspace-library-view.ts";

test("saved workspace rows escape names and show actual split layout", () => {
  const leaf = (id: string) => ({ kind: "leaf", terminalId: id });
  const html = renderWorkspaceRows([{ version: 1, id: "fixture", name: '<script>unsafe</script>', layout: { version: 2, groups: [{ title: "Tabs", root: { kind: "split", direction: "right", ratio: .4, first: leaf("a"), second: leaf("b") }, focusedId: "a", panes: {} }], workspaces: [] } }]);
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelector("script"), null);
  assert.equal(document.querySelector("strong")?.textContent, '<script>unsafe</script>');
  assert.equal(document.querySelectorAll(".workspace-preview-pane").length, 2);
  assert.match(document.querySelector("button")!.textContent!, /Open in new window/);
  assert.match(document.querySelector("p")!.textContent!, /1 local tab, 0 remote tabs/);
});

test("unsupported layouts remain visible without an unsafe open action", () => {
  const html = renderWorkspaceRows([{ version: 1, id: "future", name: "Future", layout: { version: 99, groups: [] } }]);
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelector("button"), null);
  assert.match(document.body.textContent!, /cannot be opened/);
});
