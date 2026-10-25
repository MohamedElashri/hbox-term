// Keybindings in Ghostty's `trigger=action` syntax, e.g. `ctrl+shift+t=new_tab`, so the
// config file can add and override bindings with the same lines Ghostty uses.

export type KeyAction =
  | "copy_to_clipboard" | "paste_from_clipboard" | "select_all" | "clear_screen"
  | "new_tab" | "close_surface" | "next_tab" | "previous_tab" | "last_tab" | `goto_tab:${number}`
  | "new_split:right" | "new_split:down" | "toggle_split_zoom"
  | "goto_split:left" | "goto_split:right" | "goto_split:up" | "goto_split:down"
  | "increase_font_size:1" | "decrease_font_size:1" | "reset_font_size"
  | "reload_config" | "start_search" | "toggle_command_palette"
  | "jump_to_prompt:-1" | "jump_to_prompt:1" | "copy_last_output"
  | "toggle_broadcast" | "paste_history" | "autocomplete" | "toggle_quick_terminal"
  | "move_tab:-1" | "move_tab:1" | "rename_tab" | "toggle_terminal_dock"
  /** Removes an earlier binding for the same trigger. */
  | "unbind";

interface Trigger { ctrl: boolean; shift: boolean; alt: boolean; super: boolean; key: string }
export interface Keybinding { trigger: Trigger; action: KeyAction }

/** Ghostty's Linux defaults (the subset hbox-term implements). */
export const LINUX_DEFAULTS = [
  "ctrl+shift+c=copy_to_clipboard", "ctrl+shift+v=paste_from_clipboard", "ctrl+shift+a=select_all",
  "ctrl+shift+t=new_tab", "ctrl+shift+w=close_surface",
  "ctrl+tab=next_tab", "ctrl+shift+tab=previous_tab", "ctrl+page_down=next_tab", "ctrl+page_up=previous_tab",
  "ctrl+shift+right=next_tab", "ctrl+shift+left=previous_tab",
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `alt+${n}=goto_tab:${n}`), "alt+9=last_tab",
  "ctrl+shift+o=new_split:right", "ctrl+shift+e=new_split:down", "ctrl+shift+enter=toggle_split_zoom",
  "ctrl+alt+left=goto_split:left", "ctrl+alt+right=goto_split:right", "ctrl+alt+up=goto_split:up", "ctrl+alt+down=goto_split:down",
  "ctrl+equal=increase_font_size:1", "ctrl+plus=increase_font_size:1", "ctrl+minus=decrease_font_size:1", "ctrl+0=reset_font_size",
  "ctrl+shift+comma=reload_config", "ctrl+shift+f=start_search", "ctrl+shift+p=toggle_command_palette",
  "ctrl+shift+page_up=jump_to_prompt:-1", "ctrl+shift+page_down=jump_to_prompt:1",
  "ctrl+shift+alt+i=toggle_broadcast", "ctrl+shift+h=paste_history", "ctrl+shift+semicolon=autocomplete",
  "ctrl+grave_accent=toggle_terminal_dock",
];

/** iTerm2's macOS defaults. */
export const MACOS_DEFAULTS = [
  "super+c=copy_to_clipboard", "super+v=paste_from_clipboard", "super+a=select_all", "super+k=clear_screen",
  "super+t=new_tab", "super+w=close_surface",
  "super+shift+right_bracket=next_tab", "super+shift+left_bracket=previous_tab", "ctrl+tab=next_tab", "ctrl+shift+tab=previous_tab",
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `super+${n}=goto_tab:${n}`), "super+9=last_tab",
  "super+d=new_split:right", "super+shift+d=new_split:down", "super+shift+enter=toggle_split_zoom",
  "super+alt+left=goto_split:left", "super+alt+right=goto_split:right", "super+alt+up=goto_split:up", "super+alt+down=goto_split:down",
  "super+equal=increase_font_size:1", "super+plus=increase_font_size:1", "super+minus=decrease_font_size:1", "super+0=reset_font_size",
  "super+shift+comma=reload_config", "super+f=start_search", "super+shift+p=toggle_command_palette",
  "super+shift+up=jump_to_prompt:-1", "super+shift+down=jump_to_prompt:1", "super+shift+a=copy_last_output",
  "super+alt+i=toggle_broadcast", "super+shift+h=paste_history", "super+semicolon=autocomplete",
  "super+shift+left=move_tab:-1", "super+shift+right=move_tab:1", "ctrl+grave_accent=toggle_terminal_dock",
  "super+shift+o=toggle_command_palette",
];

// Ghostty accepts several spellings for some keys; normalize to one.
const KEY_ALIASES: Record<string, string> = {
  return: "enter", arrow_left: "left", arrow_right: "right", arrow_up: "up", arrow_down: "down",
  pageup: "page_up", pagedown: "page_down", bracket_left: "left_bracket", bracket_right: "right_bracket",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  "=": "equal", "-": "minus", "+": "plus", "[": "left_bracket", "]": "right_bracket", ",": "comma", ".": "period",
};
const MODIFIER_ALIASES: Record<string, keyof Omit<Trigger, "key">> = {
  ctrl: "ctrl", control: "ctrl", shift: "shift", alt: "alt", opt: "alt", option: "alt", super: "super", cmd: "super", command: "super",
};

function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  const digit = /^digit_(\d)$/.exec(lower);
  return digit ? digit[1] : KEY_ALIASES[lower] ?? lower;
}

/** Parses one `trigger=action` line; returns null for anything it does not understand. */
export function parseKeybinding(line: string): Keybinding | null {
  const separator = line.lastIndexOf("=");
  if (separator <= 0) return null;
  const parts = line.slice(0, separator).trim().split("+");
  const action = line.slice(separator + 1).trim() as KeyAction;
  const key = parts.pop();
  if (!key || !action) return null;
  const trigger: Trigger = { ctrl: false, shift: false, alt: false, super: false, key: normalizeKey(key) };
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.trim().toLowerCase()];
    if (!modifier) return null;
    trigger[modifier] = true;
  }
  return { trigger, action };
}

export function parseKeybindings(lines: string[]): Keybinding[] {
  return lines.map(parseKeybinding).filter((binding): binding is Keybinding => binding !== null);
}

const CODE_KEYS: Record<string, string> = {
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", PageUp: "page_up", PageDown: "page_down",
  Enter: "enter", NumpadEnter: "enter", Tab: "tab", Equal: "equal", Minus: "minus", BracketLeft: "left_bracket",
  BracketRight: "right_bracket", Comma: "comma", Period: "period", Slash: "slash", Backslash: "backslash",
  Semicolon: "semicolon", Quote: "apostrophe", Backquote: "grave_accent", Space: "space", Escape: "escape",
  Backspace: "backspace", Delete: "delete", Insert: "insert", Home: "home", End: "end", NumpadAdd: "plus",
};

interface KeyEventLike { code: string; key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }

/** Physical key names for an event (layout independent), plus `plus` when the key produces "+". */
export function eventKeys(event: KeyEventLike): string[] {
  const names: string[] = [];
  const letter = /^Key([A-Z])$/.exec(event.code);
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(event.code);
  if (letter) names.push(letter[1].toLowerCase());
  else if (digit) names.push(digit[1]);
  else if (CODE_KEYS[event.code]) names.push(CODE_KEYS[event.code]);
  else if (/^F\d{1,2}$/.test(event.code)) names.push(event.code.toLowerCase());
  if (event.key === "+") names.push("plus");
  return names;
}

export function matchKeybinding(bindings: Keybinding[], event: KeyEventLike): KeyAction | undefined {
  const keys = eventKeys(event);
  // Later bindings win, so a config line overrides a default for the same trigger.
  for (let index = bindings.length - 1; index >= 0; index--) {
    const { trigger, action } = bindings[index];
    if (trigger.ctrl !== event.ctrlKey || trigger.alt !== event.altKey || trigger.super !== event.metaKey) continue;
    // `plus` usually needs Shift on the keyboard, so Shift is optional for it.
    if (trigger.shift !== event.shiftKey && !(trigger.key === "plus" && event.shiftKey)) continue;
    if (keys.includes(trigger.key)) return action === "unbind" ? undefined : action;
  }
  return undefined;
}

const KEY_LABELS: Record<string, string> = {
  left: "←", right: "→", up: "↑", down: "↓", enter: "Enter", tab: "Tab", page_up: "PgUp", page_down: "PgDn",
  equal: "=", plus: "+", minus: "-", comma: ",", period: ".", left_bracket: "[", right_bracket: "]", space: "Space",
};

/** A readable shortcut for the last binding of an action, e.g. "Ctrl+Shift+O" or "⌘⇧D". */
export function shortcutLabel(bindings: Keybinding[], action: KeyAction, mac: boolean): string | undefined {
  // Later bindings win, so the last one for the action is the one that works.
  const binding = [...bindings].reverse().find((item) => item.action === action
    && !bindings.some((other) => other !== item && bindings.indexOf(other) > bindings.indexOf(item) && sameTrigger(other.trigger, item.trigger)));
  if (!binding) return undefined;
  const { trigger } = binding;
  const key = KEY_LABELS[trigger.key] ?? trigger.key.toUpperCase();
  if (mac) return `${trigger.ctrl ? "⌃" : ""}${trigger.alt ? "⌥" : ""}${trigger.shift ? "⇧" : ""}${trigger.super ? "⌘" : ""}${key}`;
  return [trigger.ctrl && "Ctrl", trigger.alt && "Alt", trigger.shift && "Shift", trigger.super && "Super", key].filter(Boolean).join("+");
}

function sameTrigger(a: Trigger, b: Trigger): boolean {
  return a.key === b.key && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.super === b.super;
}

const ACCELERATOR_KEYS: Record<string, string> = {
  grave_accent: "Backquote", space: "Space", enter: "Enter", tab: "Tab", escape: "Escape", backspace: "Backspace",
  minus: "Minus", equal: "Equal", comma: "Comma", period: "Period", slash: "Slash", backslash: "Backslash",
  semicolon: "Semicolon", apostrophe: "Quote", left_bracket: "BracketLeft", right_bracket: "BracketRight",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", page_up: "PageUp", page_down: "PageDown",
  home: "Home", end: "End", insert: "Insert", delete: "Delete",
};

/**
 * The quick terminal's global hotkey from Ghostty-style `keybind = global:<trigger>=toggle_quick_terminal`
 * lines, as an accelerator for the global shortcut plugin (e.g. `Control+Backquote`).
 */
export function quickTerminalShortcut(lines: string[]): string | null {
  let shortcut: string | null = null;
  for (const line of lines) {
    if (!line.startsWith("global:")) continue;
    const binding = parseKeybinding(line.slice("global:".length));
    if (binding?.action !== "toggle_quick_terminal") continue;
    const { trigger } = binding;
    const key = /^[a-z]$/.test(trigger.key) ? trigger.key.toUpperCase()
      : /^\d$/.test(trigger.key) ? `Digit${trigger.key}`
      : /^f\d{1,2}$/.test(trigger.key) ? trigger.key.toUpperCase()
      : ACCELERATOR_KEYS[trigger.key];
    if (!key) continue;
    shortcut = [trigger.ctrl && "Control", trigger.alt && "Alt", trigger.shift && "Shift", trigger.super && "Super", key].filter(Boolean).join("+");
  }
  return shortcut;
}

