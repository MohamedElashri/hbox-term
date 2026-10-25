import { invoke } from "@tauri-apps/api/core";
import { errorText } from "./command-client";
import { DEFAULT_THEME, fontSizePx, hostMatches, keybindLines, parseColors, parseConfig, scrollbackLines, themeName, xtermTheme, type ColorConfig, type ConfigEntry, type TerminalConfig } from "./config";
import { LINUX_DEFAULTS, MACOS_DEFAULTS, parseKeybindings, quickTerminalShortcut } from "./keybindings";
import { platform, quickMode, state, type ResolvedProfile } from "./state";
import { applyTerminalAppearance } from "./terminal";
import type { TerminalAppearance } from "./terminal-surface";
import { showToast } from "./toasts";

interface LoadedConfig {
  path: string;
  entries: ConfigEntry[];
  errors: string[];
  profiles: { name: string; entries: ConfigEntry[] }[];
}

// Ghostty's default font is JetBrains Mono (bundled); configured families come first.
const FALLBACK_FONTS = ["JetBrains Mono", "SF Mono", "Menlo", "DejaVu Sans Mono"];

const cssFontFamily = (families: string[]): string =>
  [...families, ...FALLBACK_FONTS].map((family) => `"${family.replace(/"/g, "")}"`).join(", ") + ", monospace";

/** The main config, or a profile layered on it; unknown profile names fall back to the main config. */
export function resolvedProfile(profile?: string): ResolvedProfile {
  return (profile && state.terminalConfig.profiles.get(profile)) || state.terminalConfig;
}

export const profileConfig = (profile?: string): TerminalConfig => resolvedProfile(profile).config;

/** The terminal settings for a profile. */
export function terminalAppearance(profile?: string): TerminalAppearance {
  const { config, theme } = resolvedProfile(profile);
  return {
    theme,
    fontFamily: cssFontFamily(config.fontFamily),
    fontSize: fontSizePx(config.fontSize, platform),
    cursorStyle: config.cursorStyle,
    cursorBlink: config.cursorBlink ?? true,
    scrollback: scrollbackLines(config.scrollbackLimit),
  };
}

/** The first profile whose `match-host` globs match the server's host or name. */
export function profileForServer(server: { host: string; name: string }): string | undefined {
  for (const [name, profile] of state.terminalConfig.profiles) {
    if (hostMatches(profile.config.matchHost, server.host) || hostMatches(profile.config.matchHost, server.name)) return name;
  }
  return undefined;
}

async function resolveTheme(config: TerminalConfig, errors: string[]): Promise<ResolvedProfile> {
  let themeColors: ColorConfig | null = null;
  if (config.theme) {
    try {
      themeColors = parseColors(await invoke<ConfigEntry[]>("load_theme", { name: themeName(config.theme, state.darkMode) }));
    } catch (error) {
      errors.push(errorText(error));
    }
  }
  return { config, theme: xtermTheme(DEFAULT_THEME, themeColors, config.colors) };
}

/** Reads ~/.config/hbox-term/config, its includes and profiles, and applies them to open terminals. */
export async function loadTerminalConfig(announce = false): Promise<void> {
  let loaded: LoadedConfig;
  try {
    loaded = await invoke<LoadedConfig>("load_config");
  } catch (error) {
    state.terminalConfig = { ...state.terminalConfig, errors: [errorText(error)] };
    if (announce) showToast(`Could not read the config: ${errorText(error)}`, "info");
    return;
  }
  const { config, ignored, errors } = parseConfig(loaded.entries);
  const base = await resolveTheme(config, errors);
  const profiles = new Map<string, ResolvedProfile>();
  for (const profile of loaded.profiles) {
    // Report problems in the profile file itself, not the main config again.
    const own = parseConfig(profile.entries);
    errors.push(...own.errors.map((error) => `profile ${profile.name}: ${error}`));
    ignored.push(...own.ignored.map((key) => `${key} (profile ${profile.name})`));
    profiles.set(profile.name, await resolveTheme(parseConfig([...loaded.entries, ...profile.entries]).config, errors));
  }
  state.terminalConfig = { path: loaded.path, ...base, profiles, ignored, errors: [...loaded.errors, ...errors] };
  state.keybindings = parseKeybindings(keybindLines(platform === "macos" ? MACOS_DEFAULTS : LINUX_DEFAULTS, config.keybinds));
  if (!quickMode) {
    // The main window owns the quick terminal's settings and global hotkey.
    await invoke("configure_quick_terminal", {
      position: config.quickTerminalPosition,
      size: config.quickTerminalSize,
      autohide: config.quickTerminalAutohide,
      shortcut: quickTerminalShortcut(config.keybinds),
    }).catch((error) => state.terminalConfig.errors.push(errorText(error)));
  }
  applyTerminalAppearance();
  if (announce) {
    const problems = state.terminalConfig.errors.length;
    showToast(problems ? `Config reloaded with ${problems} problem${problems === 1 ? "" : "s"}; see Settings.` : "Config reloaded.", "info");
  }
}
