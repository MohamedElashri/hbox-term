import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { renderImportChoices } from "../src/app/ssh-import.ts";

test("Git services stay available for explicit selection but are never preselected as servers", () => {
  const dom = new JSDOM(renderImportChoices([{ alias: "lab" }, { alias: "work-git", service: "Git service" }, { alias: "internal", issues: ["ProxyJump needs manual configuration"] }]));
  const boxes = [...dom.window.document.querySelectorAll<HTMLInputElement>("input")];
  assert.equal(boxes[0].checked, true);
  assert.equal(boxes[1].checked, false);
  assert.equal(boxes[1].disabled, false);
  assert.equal(boxes[2].checked, false);
  assert.equal(boxes[2].disabled, true);
  assert.match(dom.window.document.body.textContent!, /manual configuration/);
  dom.window.close();
});

test("configuration values render as text", () => {
  const dom = new JSDOM(renderImportChoices([{ alias: '<img src=x onerror="alert(1)">', service: "<script>bad()</script>" }]));
  assert.equal(dom.window.document.querySelector("img,script"), null);
  dom.window.close();
});

test("linked mode enables advanced aliases for explicit selection without implying static compatibility", () => {
  const dom = new JSDOM(renderImportChoices([{ alias: "proxy", issues: ["proxycommand requires manual configuration"] }, { alias: "git", service: "Git service" }, { alias: "simple" }], true));
  const boxes = [...dom.window.document.querySelectorAll<HTMLInputElement>("input")];
  assert.equal(boxes[0].disabled, false);
  assert.equal(boxes[0].checked, false);
  assert.equal(boxes[1].checked, false);
  assert.equal(boxes[2].checked, true);
  assert.match(dom.window.document.body.textContent!, /OpenSSH resolves advanced settings/);
  assert.doesNotMatch(dom.window.document.body.textContent!, /requires manual configuration/);
  dom.window.close();
});
