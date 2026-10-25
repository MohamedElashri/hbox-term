// Command palette (Ghostty's toggle_command_palette, iTerm2's Open Quickly): fuzzy search over
// terminal actions, open tabs in every workspace, saved servers and app actions. It is an overlay
// outside `root`, so re-renders never touch it.
import { invoke } from "@tauri-apps/api/core";
import { runAction } from "./events";
import { escapeHtml } from "./format";
import { fuzzyFilter } from "./fuzzy";
import { shortcutLabel, type KeyAction } from "./keybindings";
import { LOCAL_WORKSPACE_ID, platform, state } from "./state";
import { focusedSurface, focusPane, groupTitle, openNewTerminal, pasteIntoFocused, runTerminalAction } from "./terminal";
import { showToast } from "./toasts";
import type { SavedCommand } from "../types";
import type { TerminalGroup } from "./types";
import { selectLocalWorkspace, selectServer, selectWorkspaceTab, setView } from "./workspace";

export interface PaletteItem {
  title: string;
  detail?: string;
  shortcut?: string;
  kind: "Action" | "Tab" | "Server" | "Snippet" | "App" | "Clipboard" | "Word";
  run: () => unknown;
}

const PALETTE_PLACEHOLDER = "Type a command, tab or server…";

const MAX_RESULTS = 60;

const TERMINAL_ACTIONS: [string, KeyAction][] = [
  ["New tab", "new_tab"], ["Split right", "new_split:right"], ["Split down", "new_split:down"],
  ["Close pane", "close_surface"], ["Zoom pane", "toggle_split_zoom"], ["Find in scrollback", "start_search"],
  ["Next tab", "next_tab"], ["Previous tab", "previous_tab"],
  ["Copy", "copy_to_clipboard"], ["Paste", "paste_from_clipboard"], ["Select all", "select_all"], ["Clear screen", "clear_screen"],
  ["Increase font size", "increase_font_size:1"], ["Decrease font size", "decrease_font_size:1"], ["Reset font size", "reset_font_size"],
  ["Jump to previous prompt", "jump_to_prompt:-1"], ["Jump to next prompt", "jump_to_prompt:1"],
  ["Copy last command output", "copy_last_output"], ["Broadcast input to all panes", "toggle_broadcast"],
  ["Paste from history", "paste_history"], ["Complete word from output", "autocomplete"],
  ["Toggle quick terminal", "toggle_quick_terminal"],
  ["Rename tab", "rename_tab"], ["Move tab left", "move_tab:-1"], ["Move tab right", "move_tab:1"],
  ["Terminals beside this view", "toggle_terminal_dock"],
  ["Reload config", "reload_config"],
];

const backdrop = document.createElement("div");
backdrop.className = "palette-backdrop";
backdrop.hidden = true;
backdrop.innerHTML = `<div class="palette" role="dialog" aria-label="Command palette"><input type="text" placeholder="Type a command, tab or server…" spellcheck="false" autocomplete="off" role="combobox" aria-controls="palette-results" aria-expanded="true"><ul id="palette-results" role="listbox"></ul></div>`;
document.body.append(backdrop);
const input = backdrop.querySelector("input")!;
const list = backdrop.querySelector("ul")!;

let items: PaletteItem[] = [];
let results: PaletteItem[] = [];
let selected = 0;

function workspaceName(group: TerminalGroup): string {
  if (group.workspaceTabId === LOCAL_WORKSPACE_ID) return "Local";
  const tab = state.openServerTabs.find((item) => item.id === group.workspaceTabId);
  const server = state.snapshot.servers.find((item) => item.id === tab?.serverId);
  return tab?.label || server?.name || "Server";
}

async function goToGroup(group: TerminalGroup): Promise<void> {
  if (group.workspaceTabId === LOCAL_WORKSPACE_ID) await selectLocalWorkspace();
  else {
    await selectWorkspaceTab(group.workspaceTabId);
    await setView("terminal");
  }
  focusPane(group.focusedId);
}

function buildItems(): PaletteItem[] {
  const mac = platform === "macos";
  const actions: PaletteItem[] = TERMINAL_ACTIONS.map(([title, action]) => ({
    title, kind: "Action", shortcut: shortcutLabel(state.keybindings, action, mac), run: () => runTerminalAction(action),
  }));
  const profiles: PaletteItem[] = [...state.terminalConfig.profiles.keys()].map((name) => ({
    title: `New tab: ${name}`, detail: "profile", kind: "Action", run: async () => { await selectLocalWorkspace(); await openNewTerminal(undefined, undefined, name); },
  }));
  const tabs: PaletteItem[] = state.terminalGroups.map((group) => ({
    title: `${workspaceName(group)} › ${groupTitle(group)}`, kind: "Tab", run: () => goToGroup(group),
  }));
  const servers: PaletteItem[] = state.snapshot.servers.flatMap((server) => [
    { title: `Open ${server.name}`, detail: `${server.username}@${server.host}`, kind: "Server" as const, run: () => selectServer(server.id) },
    { title: `SSH to ${server.name}`, detail: `${server.username}@${server.host}`, kind: "Server" as const, run: async () => { await selectServer(server.id); await openNewTerminal(); } },
  ]);
  const app: PaletteItem[] = [
    { title: "Local shells", kind: "App", run: () => selectLocalWorkspace() },
    { title: "Open config file", kind: "App", run: () => invoke("open_config_file") },
    { title: "Settings", kind: "App", run: () => runAction("credential-settings") },
    { title: "Check for updates", kind: "App", run: () => runAction("check-updates") },
    { title: "Add server", kind: "App", run: () => runAction("add-server") },
    { title: state.darkMode ? "Switch to light appearance" : "Switch to dark appearance", kind: "App", run: () => runAction("theme") },
  ];
  return [...actions, ...profiles, ...tabs, ...servers, ...app];
}

function renderResults(): void {
  results = fuzzyFilter(input.value, items, (item) => `${item.title} ${item.detail ?? ""}`).slice(0, MAX_RESULTS);
  selected = Math.min(selected, Math.max(0, results.length - 1));
  list.innerHTML = results.length
    ? results.map((item, index) => `<li role="option" data-index="${index}" aria-selected="${index === selected}" class="${index === selected ? "selected" : ""}"><span class="palette-kind">${item.kind}</span><span class="palette-title">${escapeHtml(item.title)}</span>${item.detail ? `<span class="palette-detail">${escapeHtml(item.detail)}</span>` : ""}${item.shortcut ? `<kbd>${escapeHtml(item.shortcut)}</kbd>` : ""}</li>`).join("")
    : `<li class="palette-empty">No matches</li>`;
  list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

export function isPaletteOpen(): boolean { return !backdrop.hidden; }

export function openPalette(): void {
  items = buildItems();
  input.placeholder = PALETTE_PLACEHOLDER;
  input.value = "";
  selected = 0;
  backdrop.hidden = false;
  renderResults();
  input.focus();
  void loadSnippets();
}

/** The palette overlay as a picker over other items (paste history, completions). */
export function openPicker(placeholder: string, pickerItems: PaletteItem[]): void {
  items = pickerItems;
  input.placeholder = placeholder;
  input.value = "";
  selected = 0;
  backdrop.hidden = false;
  renderResults();
  input.focus();
}

/** Saved commands (global, plus the active server's) are typed into the focused pane. */
async function loadSnippets(): Promise<void> {
  const snippets = await invoke<SavedCommand[]>("get_saved_commands", { serverId: state.activeServerId }).catch(() => []);
  if (backdrop.hidden || !snippets.length) return;
  items = [...items, ...snippets.map((snippet): PaletteItem => ({
    title: snippet.name, detail: snippet.command, kind: "Snippet",
    run: () => { if (!pasteIntoFocused(snippet.command)) showToast("Open a terminal to insert the saved command.", "info"); },
  }))];
  renderResults();
}

export function closePalette(refocus = true): void {
  if (backdrop.hidden) return;
  backdrop.hidden = true;
  if (refocus) focusedSurface()?.focus();
}

export function togglePalette(): void {
  if (isPaletteOpen()) closePalette(); else openPalette();
}

async function runSelected(index = selected): Promise<void> {
  const item = results[index];
  if (!item) return;
  // Return focus to the terminal first, so terminal actions act on the focused pane.
  closePalette();
  await item.run();
}

input.addEventListener("input", () => { selected = 0; renderResults(); });
input.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    selected = (selected + step + results.length) % Math.max(1, results.length);
    renderResults();
  } else if (event.key === "Enter") {
    event.preventDefault();
    void runSelected();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closePalette();
  }
});
list.addEventListener("click", (event) => {
  const option = (event.target as HTMLElement).closest<HTMLElement>("li[data-index]");
  if (option) void runSelected(Number(option.dataset.index));
});
backdrop.addEventListener("mousedown", (event) => { if (event.target === backdrop) closePalette(); });
