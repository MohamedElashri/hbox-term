import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { containModalFocus, focusModal, handleModalKeydown, restoreConnectionForm } from "../src/app/modal-state.ts";

function fixture() {
  const dom = new JSDOM('<main id="app"><button id="background">Settings</button></main><textarea id="terminal"></textarea>');
  const { document } = dom.window;
  const root = document.querySelector<HTMLElement>("#app")!;
  document.addEventListener("focusin", event => containModalFocus(root, event as FocusEvent));
  dom.window.addEventListener("keydown", event => handleModalKeydown(root, event as KeyboardEvent), true);
  return { dom, document, root };
}

test("opening a dialog without autofocus moves typing out of the terminal", () => {
  const { dom, document, root } = fixture();
  document.querySelector<HTMLElement>("#terminal")!.focus();
  root.insertAdjacentHTML("beforeend", '<div class="modal" role="dialog"><button id="close">Close</button><button>Done</button></div>');
  focusModal(root);
  assert.equal(document.activeElement?.id, "close");
  dom.window.close();
});

test("Tab and Shift-Tab wrap inside a dialog", () => {
  const { dom, document, root } = fixture();
  root.innerHTML = '<div class="modal" role="dialog"><button id="first">Close</button><input id="field"><button id="last">Save</button></div>';
  focusModal(root);
  document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(document.activeElement?.id, "last");
  document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  assert.equal(document.activeElement?.id, "first");
  dom.window.close();
});

test("programmatic terminal focus cannot escape a dialog", () => {
  const { dom, document, root } = fixture();
  root.innerHTML = '<div class="modal" role="dialog"><input id="host" autofocus><button>Save</button></div>';
  focusModal(root);
  document.querySelector<HTMLElement>("#terminal")!.focus();
  assert.equal(document.activeElement?.id, "host");
  dom.window.close();
});

test("background key events cannot reach the shell while a dialog is open", () => {
  const { dom, document, root } = fixture();
  root.innerHTML = '<div class="modal" role="dialog"><button id="close">Close</button></div>';
  let shellKeys = 0;
  const terminal = document.querySelector("#terminal")!;
  terminal.addEventListener("keydown", () => { shellKeys++; });
  const event = new dom.window.KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
  terminal.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(shellKeys, 0);
  assert.equal(document.activeElement?.id, "close");
  dom.window.close();
});

test("the top confirmation owns focus instead of the form below it", () => {
  const { dom, document, root } = fixture();
  root.innerHTML = '<div class="modal" role="dialog"><input id="host" autofocus></div><div class="modal" role="alertdialog"><button id="cancel" autofocus>Cancel</button><button>Continue</button></div>';
  focusModal(root);
  document.querySelector<HTMLElement>("#host")!.focus();
  assert.equal(document.activeElement?.id, "cancel");
  root.querySelector('[role="alertdialog"]')!.remove();
  focusModal(root);
  assert.equal(document.activeElement?.id, "host");
  dom.window.close();
});

test("hidden and disabled controls cannot capture initial focus", () => {
  const { dom, document, root } = fixture();
  root.innerHTML = '<div class="modal" role="dialog"><button disabled autofocus>Disabled</button><input hidden autofocus><div style="display:none"><input autofocus></div><details><summary>Options</summary><input autofocus></details><select class="native-select-source" autofocus><option>Hidden native select</option></select><input id="visible" autofocus></div>';
  focusModal(root);
  assert.equal(document.activeElement?.id, "visible");
  dom.window.close();
});

test("connection redraws retain entered fields, auth choice, and caret", () => {
  const { dom, document, root } = fixture();
  root.innerHTML = '<div class="modal" role="dialog"><form data-form="server" data-connection-id="new"><input id="host" name="host"><input name="authMethod" type="radio" value="privateKey" checked><input name="customKeyPath"><input name="keyPassphrase" type="password"><textarea name="notes"></textarea><details open><summary>Route</summary><input name="port" value="239"></details></form></div>';
  const previous = root.querySelector<HTMLFormElement>("form")!;
  const host = previous.querySelector<HTMLInputElement>("#host")!;
  host.value = "qa.example.test";
  previous.querySelector<HTMLInputElement>('[name="customKeyPath"]')!.value = "/tmp/a=b";
  previous.querySelector<HTMLInputElement>('[name="keyPassphrase"]')!.value = "fixture only";
  host.focus();
  host.setSelectionRange(3, 7);
  root.innerHTML = '<div class="modal" role="dialog"><form data-form="server" data-connection-id="new"><input name="host"><input name="authMethod" type="radio" value="password" checked></form></div>';
  restoreConnectionForm(root, previous);
  focusModal(root, host);
  assert.equal(root.querySelector("form"), previous);
  assert.equal(host.value, "qa.example.test");
  assert.equal(previous.querySelector<HTMLInputElement>('[name="authMethod"]')!.value, "privateKey");
  assert.equal(previous.querySelector<HTMLInputElement>('[name="keyPassphrase"]')!.value, "fixture only");
  assert.equal(document.activeElement, host);
  assert.deepEqual([host.selectionStart, host.selectionEnd], [3, 7]);
  dom.window.close();
});

test("switching connection records never restores another record's fields", () => {
  const { dom, root } = fixture();
  root.innerHTML = '<form data-form="server" data-connection-id="old"><input type="password" value="fixture"></form>';
  const previous = root.querySelector<HTMLFormElement>("form")!;
  root.innerHTML = '<form data-form="server" data-connection-id="new"><input name="host"></form>';
  restoreConnectionForm(root, previous);
  assert.notEqual(root.querySelector("form"), previous);
  assert.equal(root.querySelector('input[type="password"]'), null);
  dom.window.close();
});

test("without a dialog normal terminal typing stays untouched", () => {
  const { dom, document } = fixture();
  const terminal = document.querySelector<HTMLElement>("#terminal")!;
  terminal.focus();
  const event = new dom.window.KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
  terminal.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(document.activeElement, terminal);
  dom.window.close();
});

test("password entry survives a background redraw without crossing connection records", () => {
  const { dom, root } = fixture();
  root.innerHTML = '<form data-form="ssh-password" data-connection-id="qa"><input type="password" name="password"><input type="checkbox" name="remember"></form>';
  const previous = root.querySelector<HTMLFormElement>("form")!;
  previous.querySelector<HTMLInputElement>('[name="password"]')!.value = "fixture secret";
  root.innerHTML = '<form data-form="ssh-password" data-connection-id="qa"><input type="password" name="password"></form>';
  restoreConnectionForm(root, previous);
  assert.equal(root.querySelector("form"), previous);
  assert.equal(previous.querySelector<HTMLInputElement>('[name="password"]')!.value, "fixture secret");
  root.innerHTML = '<form data-form="ssh-password" data-connection-id="another"><input type="password" name="password"></form>';
  restoreConnectionForm(root, previous);
  assert.notEqual(root.querySelector("form"), previous);
  assert.equal(root.querySelector<HTMLInputElement>('[name="password"]')!.value, "");
  dom.window.close();
});
