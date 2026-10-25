import assert from "node:assert/strict";
import { test } from "node:test";
import { LINUX_DEFAULTS, MACOS_DEFAULTS, matchKeybinding, parseKeybinding, parseKeybindings, quickTerminalShortcut, shortcutLabel } from "../src/app/keybindings.ts";

const key = (code: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}, keyValue = "") => ({
  code, key: keyValue, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta,
});

test("all default bindings parse", () => {
  assert.equal(parseKeybindings(LINUX_DEFAULTS).length, LINUX_DEFAULTS.length);
  assert.equal(parseKeybindings(MACOS_DEFAULTS).length, MACOS_DEFAULTS.length);
});

test("parses Ghostty spellings", () => {
  assert.deepEqual(parseKeybinding("ctrl+shift+x=close_surface"), {
    trigger: { ctrl: true, shift: true, alt: false, super: false, key: "x" }, action: "close_surface",
  });
  assert.equal(parseKeybinding("cmd+digit_1=goto_tab:1")?.trigger.key, "1");
  assert.equal(parseKeybinding("ctrl+arrow_left=previous_tab")?.trigger.key, "left");
  assert.equal(parseKeybinding("hyper+x=new_tab"), null);
  assert.equal(parseKeybinding("not a binding"), null);
});

test("matches Linux defaults on physical keys", () => {
  const linux = parseKeybindings(LINUX_DEFAULTS);
  assert.equal(matchKeybinding(linux, key("KeyT", { ctrl: true, shift: true }, "T")), "new_tab");
  assert.equal(matchKeybinding(linux, key("KeyO", { ctrl: true, shift: true }, "O")), "new_split:right");
  assert.equal(matchKeybinding(linux, key("ArrowLeft", { ctrl: true, alt: true })), "goto_split:left");
  assert.equal(matchKeybinding(linux, key("Digit3", { alt: true }, "3")), "goto_tab:3");
  assert.equal(matchKeybinding(linux, key("Equal", { ctrl: true, shift: true }, "+")), "increase_font_size:1");
  // Plain Ctrl+C and Ctrl+K belong to the shell.
  assert.equal(matchKeybinding(linux, key("KeyC", { ctrl: true }, "c")), undefined);
  assert.equal(matchKeybinding(linux, key("KeyK", { ctrl: true }, "k")), undefined);
});

test("matches iTerm2 defaults on macOS", () => {
  const mac = parseKeybindings(MACOS_DEFAULTS);
  assert.equal(matchKeybinding(mac, key("KeyD", { meta: true }, "d")), "new_split:right");
  assert.equal(matchKeybinding(mac, key("KeyD", { meta: true, shift: true }, "D")), "new_split:down");
  assert.equal(matchKeybinding(mac, key("BracketRight", { meta: true, shift: true }, "}")), "next_tab");
});

test("later bindings override earlier ones", () => {
  const bindings = parseKeybindings([...LINUX_DEFAULTS, "ctrl+shift+w=new_tab"]);
  assert.equal(matchKeybinding(bindings, key("KeyW", { ctrl: true, shift: true }, "W")), "new_tab");
});

test("shortcut labels follow the binding that wins", () => {
  assert.equal(shortcutLabel(parseKeybindings(LINUX_DEFAULTS), "new_split:right", false), "Ctrl+Shift+O");
  assert.equal(shortcutLabel(parseKeybindings(MACOS_DEFAULTS), "new_split:down", true), "⇧⌘D");
  // Rebinding the trigger to something else hides it from the old action.
  const rebound = parseKeybindings([...LINUX_DEFAULTS, "ctrl+shift+w=new_tab"]);
  assert.equal(shortcutLabel(rebound, "close_surface", false), undefined);
  assert.equal(shortcutLabel(parseKeybindings(LINUX_DEFAULTS), "clear_screen", false), undefined);
});

test("global quick terminal hotkey as an accelerator", () => {
  assert.equal(quickTerminalShortcut(["global:ctrl+grave_accent=toggle_quick_terminal"]), "Control+Backquote");
  assert.equal(quickTerminalShortcut(["global:super+shift+t=toggle_quick_terminal"]), "Shift+Super+T");
  assert.equal(quickTerminalShortcut(["global:alt+f12=toggle_quick_terminal", "global:ctrl+1=toggle_quick_terminal"]), "Control+Digit1");
  assert.equal(quickTerminalShortcut(["ctrl+grave_accent=toggle_quick_terminal", "global:ctrl+t=new_tab"]), null);
});
