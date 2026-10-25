// Interprets Ghostty-format config entries (read and include-resolved by src-tauri/src/config.rs).
// Later entries win, like Ghostty. Keys hbox-term does not implement are reported, not errors.

export interface ConfigEntry { file: string; line: number; key: string; value: string }

export type CursorStyle = "block" | "bar" | "underline";

export interface ColorConfig {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorText?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  palette: Record<number, string>;
}

export interface TerminalConfig {
  fontFamily: string[];
  /** Points, like Ghostty. */
  fontSize: number;
  theme: string | null;
  colors: ColorConfig;
  cursorStyle: CursorStyle;
  /** null: blink unless the program turns it off (Ghostty's default). */
  cursorBlink: boolean | null;
  copyOnSelect: "false" | "true" | "clipboard";
  pasteProtection: boolean;
  pasteBracketedSafe: boolean;
  trimTrailingSpaces: boolean;
  /** Bytes, like Ghostty. */
  scrollbackLimit: number;
  waitAfterCommand: boolean;
  keybinds: string[];
  /** Local shells only: replaces the login shell (Ghostty's `command`). */
  command: string | null;
  /** `home`, `inherit` (the focused pane's directory) or a path. */
  workingDirectory: string;
  env: [string, string][];
  /** hbox-term: SSH tabs to servers matching one of these globs use the profile. */
  matchHost: string[];
  /** Ghostty's notify-on-command-finish: never, unfocused or always. */
  notifyOnCommandFinish: "never" | "unfocused" | "always";
  /** Seconds a command must run before its finish is notified. */
  notifyOnCommandFinishAfter: number;
  /** Ghostty's shell-integration: none, detect, or a shell name. */
  shellIntegration: string;
  /** hbox-term: command to edit remote files with; defaults to $VISUAL/$EDITOR. */
  editor: string | null;
  /** Ghostty's window-save-state: restore local tabs, layout and scrollback unless `never`. */
  windowSaveState: "default" | "never" | "always";
  /** Ghostty's image-storage-limit in bytes; 0 turns inline images off. */
  imageStorageLimit: number;
  /** hbox-term (from iTerm2): actions on output lines matching a pattern. */
  triggers: Trigger[];
  /** Ghostty's quick terminal: top, bottom, left, right or center. */
  quickTerminalPosition: string;
  /** Ghostty's quick-terminal-size, e.g. `40%` or `40%,800px`; empty for the default. */
  quickTerminalSize: string;
  quickTerminalAutohide: boolean;
  /** hbox-term: install the shell integration on servers and start SSH shells through it. */
  remoteShellIntegration: boolean;
}

export interface ParsedConfig {
  config: TerminalConfig;
  /** Keys hbox-term does not support yet, with where they were set. */
  ignored: string[];
  errors: string[];
}

export const DEFAULT_CONFIG: TerminalConfig = {
  fontFamily: [],
  fontSize: 13,
  theme: null,
  colors: { palette: {} },
  cursorStyle: "block",
  cursorBlink: null,
  copyOnSelect: "true",
  pasteProtection: true,
  pasteBracketedSafe: true,
  trimTrailingSpaces: true,
  scrollbackLimit: 10_000_000,
  waitAfterCommand: false,
  keybinds: [],
  command: null,
  workingDirectory: "inherit",
  env: [],
  matchHost: [],
  notifyOnCommandFinish: "never",
  notifyOnCommandFinishAfter: 5,
  shellIntegration: "detect",
  editor: null,
  windowSaveState: "default",
  imageStorageLimit: 320_000_000,
  triggers: [],
  quickTerminalPosition: "top",
  quickTerminalSize: "",
  quickTerminalAutohide: true,
  remoteShellIntegration: false,
};

const NAMED_COLORS: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#00ff00", blue: "#0000ff",
  yellow: "#ffff00", cyan: "#00ffff", magenta: "#ff00ff", gray: "#bebebe", grey: "#bebebe",
};

export function parseColor(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const hex = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/.exec(trimmed);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1];
    return `#${digits}`;
  }
  return NAMED_COLORS[trimmed] ?? null;
}

function parseBoolean(value: string): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/** Applies color keys; shared by the config and theme files. Returns false for non-color keys. */
function applyColor(colors: ColorConfig, key: string, value: string, errors: string[], where: string): boolean {
  const fields: Record<string, keyof Omit<ColorConfig, "palette">> = {
    background: "background", foreground: "foreground", "cursor-color": "cursor", "cursor-text": "cursorText",
    "selection-background": "selectionBackground", "selection-foreground": "selectionForeground",
  };
  if (key === "palette") {
    const match = /^(\d{1,3})\s*=\s*(.+)$/.exec(value);
    const index = match ? Number(match[1]) : NaN;
    const color = match ? parseColor(match[2]) : null;
    if (!match || index > 255 || !color) errors.push(`${where}: invalid palette entry "${value}"`);
    else colors.palette[index] = color;
    return true;
  }
  const field = fields[key];
  if (!field) return false;
  if (!value) { delete colors[field]; return true; }
  const color = parseColor(value);
  if (color) colors[field] = color;
  else errors.push(`${where}: invalid color "${value}" for ${key}`);
  return true;
}

export function parseColors(entries: ConfigEntry[]): ColorConfig {
  const colors: ColorConfig = { palette: {} };
  for (const entry of entries) applyColor(colors, entry.key, entry.value, [], `${entry.file}:${entry.line}`);
  return colors;
}

export function parseConfig(entries: ConfigEntry[]): ParsedConfig {
  const config: TerminalConfig = structuredClone(DEFAULT_CONFIG);
  const ignored: string[] = [];
  const errors: string[] = [];
  for (const { key, value, file, line } of entries) {
    const where = `${file}:${line}`;
    const invalid = () => errors.push(`${where}: invalid value "${value}" for ${key}`);
    if (applyColor(config.colors, key, value, errors, where)) continue;
    switch (key) {
      case "font-family":
        // An empty value resets the list; repeated keys add fallbacks.
        if (value) config.fontFamily.push(value); else config.fontFamily = [];
        break;
      case "font-size": {
        const size = Number(value);
        if (size > 0 && size <= 200) config.fontSize = size; else invalid();
        break;
      }
      case "theme": config.theme = value || null; break;
      case "cursor-style": {
        const style = value === "block_hollow" ? "block" : value;
        if (style === "block" || style === "bar" || style === "underline") config.cursorStyle = style; else invalid();
        break;
      }
      case "cursor-style-blink": config.cursorBlink = value ? parseBoolean(value) : null; break;
      case "copy-on-select":
        if (value === "true" || value === "false" || value === "clipboard") config.copyOnSelect = value; else invalid();
        break;
      case "clipboard-paste-protection":
      case "clipboard-paste-bracketed-safe":
      case "clipboard-trim-trailing-spaces":
      case "wait-after-command": {
        const flag = parseBoolean(value);
        if (flag === null) { invalid(); break; }
        if (key === "clipboard-paste-protection") config.pasteProtection = flag;
        else if (key === "clipboard-paste-bracketed-safe") config.pasteBracketedSafe = flag;
        else if (key === "clipboard-trim-trailing-spaces") config.trimTrailingSpaces = flag;
        else config.waitAfterCommand = flag;
        break;
      }
      case "scrollback-limit": {
        const bytes = Number(value);
        if (Number.isFinite(bytes) && bytes >= 0) config.scrollbackLimit = bytes; else invalid();
        break;
      }
      case "keybind": config.keybinds.push(value); break;
      case "command": config.command = value || null; break;
      case "shell-integration": config.shellIntegration = value || "detect"; break;
      case "editor": config.editor = value || null; break;
      case "trigger": {
        if (!value) { config.triggers = []; break; }
        const trigger = parseTrigger(value);
        if (typeof trigger === "string") errors.push(`${where}: ${trigger}`); else config.triggers.push(trigger);
        break;
      }
      case "quick-terminal-position":
        if (["top", "bottom", "left", "right", "center"].includes(value)) config.quickTerminalPosition = value; else invalid();
        break;
      case "quick-terminal-size": config.quickTerminalSize = value; break;
      case "remote-shell-integration": {
        const flag = parseBoolean(value);
        if (flag === null) invalid(); else config.remoteShellIntegration = flag;
        break;
      }
      case "quick-terminal-autohide": {
        const flag = parseBoolean(value);
        if (flag === null) invalid(); else config.quickTerminalAutohide = flag;
        break;
      }
      // Ghostty's other quick terminal settings are macOS-specific or about animation.
      case "quick-terminal-screen": case "quick-terminal-animation-duration": case "quick-terminal-space-behavior": break;
      case "image-storage-limit": {
        const bytes = Number(value);
        if (Number.isFinite(bytes) && bytes >= 0) config.imageStorageLimit = bytes; else invalid();
        break;
      }
      case "window-save-state":
        if (value === "default" || value === "never" || value === "always") config.windowSaveState = value; else invalid();
        break;
      // Ghostty's cursor/sudo/title/ssh-* features need nothing extra here: titles always
      // apply and hbox-term's TERM is the widely known xterm-256color.
      case "shell-integration-features": break;
      case "working-directory": config.workingDirectory = value || "inherit"; break;
      case "env": {
        // `env = KEY=VALUE` adds, `env = KEY=` removes, an empty value clears all.
        if (!value) { config.env = []; break; }
        const separator = value.indexOf("=");
        if (separator <= 0) { invalid(); break; }
        const name = value.slice(0, separator).trim();
        config.env = config.env.filter(([existing]) => existing !== name);
        if (value.slice(separator + 1)) config.env.push([name, value.slice(separator + 1)]);
        break;
      }
      case "match-host":
        if (value) config.matchHost.push(value); else config.matchHost = [];
        break;
      case "notify-on-command-finish":
        if (value === "never" || value === "unfocused" || value === "always") config.notifyOnCommandFinish = value; else invalid();
        break;
      case "notify-on-command-finish-after": {
        const seconds = parseDuration(value);
        if (seconds === null) invalid(); else config.notifyOnCommandFinishAfter = seconds;
        break;
      }
      default: ignored.push(`${key} (${where})`);
    }
  }
  return { config, ignored, errors };
}

/** Picks the theme for the current appearance from `name` or `light:A,dark:B`. */
export function themeName(value: string, dark: boolean): string {
  if (!value.includes(":")) return value;
  const variants = Object.fromEntries(value.split(",").map((part) => part.split(":").map((item) => item.trim()) as [string, string]));
  return (dark ? variants.dark : variants.light) ?? variants.dark ?? variants.light ?? value;
}

/** Dracula, the default terminal theme; the config's theme and colors are layered on top. */
export const DEFAULT_THEME: XtermTheme = {
  background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", cursorAccent: "#282a36",
  selectionBackground: "#44475a", selectionForeground: "#f8f8f2",
  black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c", blue: "#bd93f9", magenta: "#ff79c6",
  cyan: "#8be9fd", white: "#f8f8f2", brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94",
  brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff",
};

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;

export interface XtermTheme {
  background?: string; foreground?: string; cursor?: string; cursorAccent?: string;
  selectionBackground?: string; selectionForeground?: string; extendedAnsi?: string[];
  [ansi: string]: string | string[] | undefined;
}

/** Layers the base theme, the theme file and the config's own colors, in that order. */
export function xtermTheme(base: XtermTheme, ...layers: (ColorConfig | null)[]): XtermTheme {
  const theme: XtermTheme = { ...base };
  for (const colors of layers) {
    if (!colors) continue;
    if (colors.background) theme.background = colors.background;
    if (colors.foreground) theme.foreground = colors.foreground;
    if (colors.cursor) theme.cursor = colors.cursor;
    if (colors.cursorText) theme.cursorAccent = colors.cursorText;
    if (colors.selectionBackground) theme.selectionBackground = colors.selectionBackground;
    if (colors.selectionForeground) theme.selectionForeground = colors.selectionForeground;
    for (const [index, color] of Object.entries(colors.palette)) {
      const number = Number(index);
      if (number < 16) theme[ANSI_NAMES[number]] = color;
      else (theme.extendedAnsi ??= [])[number - 16] = color;
    }
  }
  return theme;
}

/** Ghostty sizes fonts in points. WebKit on macOS treats a CSS pixel as a point; elsewhere 1pt = 4/3 px. */
export function fontSizePx(points: number, platform: string): number {
  return Math.round(platform === "macos" ? points : points * 4 / 3);
}

/**
 * Ghostty limits scrollback in bytes; xterm.js in lines. Assume ~100 bytes per line and cap
 * the in-memory scrollback, since xterm.js keeps every line in JavaScript memory.
 */
export function scrollbackLines(bytes: number): number {
  return Math.min(100_000, Math.max(1_000, Math.round(bytes / 100)));
}

/** Default bindings followed by config bindings; `keybind = clear` drops everything before it. */
export function keybindLines(defaults: string[], configured: string[]): string[] {
  const clear = configured.lastIndexOf("clear");
  return clear >= 0 ? configured.slice(clear + 1) : [...defaults, ...configured];
}

/** Ghostty durations such as `5s`, `1m30s`, `500ms`; a bare number is seconds. */
export function parseDuration(value: string): number | null {
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const units: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600 };
  let total = 0;
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let consumed = 0;
  for (const match of trimmed.matchAll(pattern)) {
    total += Number(match[1]) * units[match[2]];
    consumed += match[0].length;
  }
  return consumed && consumed === trimmed.replace(/\s+/g, "").length ? total : null;
}

/** Shell-style globs (`*`, `?`) against a host name or address, case-insensitively. */
export function hostMatches(patterns: string[], host: string): boolean {
  return patterns.some((pattern) => {
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${source}$`, "i").test(host);
  });
}

// --- Triggers (iTerm2): `trigger = <action>[:<argument>] /<regex>/<flags>` -----------------

export type TriggerAction = "highlight" | "notify" | "mark";

export interface Trigger {
  action: TriggerAction;
  /** highlight: a #rrggbb color; notify: the notification title. */
  argument?: string;
  pattern: RegExp;
}

export const DEFAULT_HIGHLIGHT = "#ffb86c";

/** Parses one `trigger =` value; returns an error message instead for invalid ones. */
export function parseTrigger(value: string): Trigger | string {
  const match = /^(\w+)(?::(.*?))?\s+\/(.+)\/([a-z]*)$/.exec(value.trim());
  if (!match) return `expected "<action>[:<argument>] /<regex>/<flags>", got "${value}"`;
  const [, action, argument, source, flags] = match;
  if (action !== "highlight" && action !== "notify" && action !== "mark") return `unknown trigger action "${action}"`;
  if (action === "highlight" && argument && !/^#[0-9a-f]{6}$/i.test(argument)) return `highlight color must be #rrggbb, got "${argument}"`;
  try {
    // Always global, to find every match on a line.
    return { action, argument: argument || undefined, pattern: new RegExp(source, flags.includes("g") ? flags : `${flags}g`) };
  } catch (error) {
    return `invalid regular expression /${source}/: ${(error as Error).message}`;
  }
}
