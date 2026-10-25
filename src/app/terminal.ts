import { invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { TerminalStarted, TerminalTab } from "../types";
import { errorText, OperationCancelledError } from "./command-client";
import type { KeyAction } from "./keybindings";
import { transferUpload } from "./actions/remote";
import { completions, wordBeforeCursor } from "./completion";
import { confirm, requestTextInput } from "./modals";
import { openPicker, type PaletteItem } from "./palette";
import { layoutPanes, leaf, leaves, mapLeaves, MIN_RATIO, neighbor, removeLeaf, replaceLeaf, splitLeaf, type Divider, type FocusDirection, type PaneNode, type Rect, type SplitDirection } from "./panes";
import { render } from "./render";
import { invokeCommand, setError } from "./session";
import { activeDock, activeTerminalGroup, activeTerminalGroups, activeTerminalTabByWorkspace, connectedServerIds, dockShown, isLocalWorkspace, LOCAL_SERVER_ID, LOCAL_WORKSPACE_ID, root, state, terminalDocks, terminalGroupOf, terminalInputChains, terminalSurfaces, useWebglRenderer } from "./state";
import { TerminalSurface, type TerminalAppearance } from "./terminal-surface";
import { showToast } from "./toasts";
import { loadTerminalConfig, profileConfig, profileForServer, terminalAppearance } from "./terminal-config";
import type { TerminalGroup } from "./types";
import type { TerminalRenderer } from "./state";


/** The surface of the focused pane, if any. */
export const focusedSurface = (): TerminalSurface | undefined => state.activeTerminalTabId ? terminalSurfaces.get(state.activeTerminalTabId) : undefined;

export function createTerminalSurface(tab: TerminalTab): TerminalSurface {
  const appearance = terminalAppearance(tab.profile);
  const surface = new TerminalSurface({
    // New panes inherit the focused pane's font size, like Ghostty's window-inherit-font-size.
    appearance: { ...appearance, fontSize: focusedSurface()?.fontSize ?? appearance.fontSize },
    webgl: useWebglRenderer(),
    onSelection: () => {
      const { copyOnSelect, trimTrailingSpaces } = profileConfig(tab.profile);
      // `true` means the primary selection, which a webview cannot write; `clipboard` copies.
      if (copyOnSelect !== "clipboard") return;
      const text = surface.selectionText(trimTrailingSpaces);
      rememberClipboard(text);
      void writeText(text).catch(() => undefined);
    },
    onFocus: () => focusPane(tab.id, false),
    onOpenUrl: (url) => { void openUrl(url).catch(setError); },
    imageStorageMb: profileConfig(tab.profile).imageStorageLimit / 1_000_000,
    triggers: () => profileConfig(tab.profile).triggers,
    onTriggerNotify: (title, line) => { void notify(title, line); },
    pathLinks: tab.serverId === LOCAL_SERVER_ID ? {
      cwd: () => tab.cwd,
      resolve: (base, candidates) => invoke<(string | null)[]>("resolve_paths", { base, candidates }),
      open: (path, line, column) => { void openFileInEditor(tab, path, line, column); },
    } : undefined,
    onDirectory: (path) => {
      tab.cwd = path;
      if (tab.id === state.activeTerminalTabId) scheduleRender();
    },
    onTitle: (title) => {
      tab.paneTitle = title.trim() || undefined;
      if (terminalGroupOf(tab.id)?.focusedId === tab.id) scheduleRender();
    },
    onFinished: (command, seconds) => notifyCommandFinished(tab, command.exitCode ?? 0, seconds),
    onInput: (data) => {
      // After the process exits, any key closes the pane (Ghostty's wait-after-command).
      if (tab.closed) { if (!tab.connecting) void closeTerminal(tab.id); return; }
      const group = terminalGroupOf(tab.id);
      if (group?.broadcast) {
        for (const id of leaves(group.root)) {
          const target = state.terminalTabs.find((item) => item.id === id);
          if (target?.sessionId && !target.closed && !target.connecting) queueTerminalInput(target.sessionId, data);
        }
        return;
      }
      if (tab.sessionId) queueTerminalInput(tab.sessionId, data);
    },
    onResize: (cols, rows) => {
      if (tab.sessionId && !tab.connecting && !tab.closed) void invoke("terminal_resize", { request: { sessionId: tab.sessionId, cols, rows } }).catch(() => undefined);
    },
    onAck: (bytes) => { if (tab.sessionId) void invoke("terminal_ack", { sessionId: tab.sessionId, bytes }).catch(() => undefined); },
    onClosed: (message) => {
      tab.closed = true;
      finishRemoteEdit(tab);
      if (!profileConfig(tab.profile).waitAfterCommand) { void closeTerminal(tab.id); return; }
      surface.notice(message);
      surface.term.write("\x1b[2mPress any key to close.\x1b[0m");
      render();
    },
  });
  terminalSurfaces.set(tab.id, surface);
  appliedAppearances.set(tab.id, appearance);
  return surface;
}

/** Uploads any last change from a remote-edit pane and removes the local copy. */
function finishRemoteEdit(tab: TerminalTab): void {
  if (!tab.remoteEditId) return;
  void invoke("finish_remote_edit", { id: tab.remoteEditId }).catch(() => undefined);
  tab.remoteEditId = undefined;
}

let renderPending = false;

/** Title and directory reports can come with every prompt; batch their re-renders per frame. */
function scheduleRender(): void {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; render(); });
}

/** The tab's name: the focused pane's program title (OSC 2) when it has one. */
export function groupTitle(group: TerminalGroup): string {
  if (group.customTitle) return group.title;
  return state.terminalTabs.find((tab) => tab.id === group.focusedId)?.paneTitle ?? group.title;
}

/** Moves a tab within its workspace (Ghostty's move_tab), or to the position of another tab. */
export function moveTab(groupId: string, to: number | { before: string }): void {
  const group = state.terminalGroups.find((item) => item.id === groupId);
  if (!group) return;
  const siblings = state.terminalGroups.filter((item) => item.workspaceTabId === group.workspaceTabId);
  const others = siblings.filter((item) => item !== group);
  const index = typeof to === "number"
    ? Math.min(others.length, Math.max(0, siblings.indexOf(group) + to))
    : (() => { const target = others.findIndex((item) => item.id === to.before); return target < 0 ? others.length : target; })();
  others.splice(index, 0, group);
  // Keep other workspaces' tabs where they were.
  const rest = state.terminalGroups.filter((item) => item.workspaceTabId !== group.workspaceTabId);
  state.terminalGroups = [...rest, ...others];
  render();
}

export async function renameTab(groupId: string): Promise<void> {
  const group = state.terminalGroups.find((item) => item.id === groupId);
  if (!group) return;
  const title = await requestTextInput({ title: "Rename tab", label: "Tab name (empty to follow the program title)", defaultValue: group.customTitle ? group.title : groupTitle(group), allowEmpty: true });
  if (title === null) return;
  group.customTitle = Boolean(title.trim());
  if (group.customTitle) group.title = title.trim();
  render();
  focusedSurface()?.focus();
}

/** Ghostty's notify-on-command-finish: a desktop notification when a long command ends. */
async function notifyCommandFinished(tab: TerminalTab, exitCode: number, seconds: number): Promise<void> {
  const { notifyOnCommandFinish, notifyOnCommandFinishAfter } = profileConfig(tab.profile);
  if (notifyOnCommandFinish === "never" || seconds < notifyOnCommandFinishAfter) return;
  const watched = document.hasFocus() && tab.id === state.activeTerminalTabId && Boolean(terminalPlaceholder());
  if (notifyOnCommandFinish === "unfocused" && watched) return;
  const group = terminalGroupOf(tab.id);
  const duration = seconds < 90 ? `${Math.round(seconds)}s` : `${Math.round(seconds / 60)} min`;
  await notify(exitCode === 0 ? "Command finished" : `Command failed (exit ${exitCode})`, `${tab.paneTitle ?? (group ? groupTitle(group) : tab.title)} · ${duration}`);
}

async function notify(title: string, body: string): Promise<void> {
  if (!(await isPermissionGranted()) && (await requestPermission()) !== "granted") return;
  sendNotification({ title, body });
}

/** Disposes sessions' terminals and removes their panes; empty tabs are removed. */
export function disposeTerminalSurfaces(tabs: TerminalTab[]): void {
  for (const tab of tabs) {
    const surface = terminalSurfaces.get(tab.id);
    shownSurfaces.delete(surface!);
    surface?.dispose();
    terminalSurfaces.delete(tab.id);
    appliedAppearances.delete(tab.id);
    pendingStarts.delete(tab.id);
    finishRemoteEdit(tab);
    if (tab.sessionId) terminalInputChains.delete(tab.sessionId);
    const group = state.terminalGroups.find((item) => item.id === tab.groupId);
    if (!group) continue;
    const remaining = removeLeaf(group.root, tab.id);
    if (!remaining) {
      state.terminalGroups = state.terminalGroups.filter((item) => item !== group);
      continue;
    }
    group.root = remaining;
    if (group.focusedId === tab.id) group.focusedId = leaves(remaining)[0];
    if (leaves(remaining).length === 1) group.zoomed = false;
  }
  const removed = new Set(tabs.map((tab) => tab.id));
  state.terminalTabs = state.terminalTabs.filter((tab) => !removed.has(tab.id));
  if (state.activeTerminalTabId && removed.has(state.activeTerminalTabId)) {
    const sameGroup = state.terminalGroups.find((group) => group.id === tabs.find((tab) => tab.id === state.activeTerminalTabId)?.groupId);
    state.activeTerminalTabId = sameGroup?.focusedId ?? activeTerminalGroups().at(-1)?.focusedId ?? null;
  }
}

type Placement =
  | { kind: "tab" }
  | { kind: "split"; from: TerminalTab; direction: SplitDirection }
  | { kind: "replace"; tab: TerminalTab }
  /** A pane of a restored tab; the group already holds the layout. */
  | { kind: "restore"; group: TerminalGroup; id: string; pane: SavedPane };

/** Opens a terminal in a new tab of the active workspace (local shell or SSH session). */
export async function openNewTerminal(command?: string, title?: string, profile?: string): Promise<void> {
  await openTerminal({ kind: "tab" }, command, title, profile);
}

/**
 * Opens a `file:line` link in the editor: GUI editors start on their own, terminal editors open in
 * a split next to the pane the link was clicked in.
 */
export async function openFileInEditor(from: TerminalTab, path: string, line?: number, column?: number): Promise<void> {
  try {
    const command = await invoke<string | null>("open_in_editor", { path, line, column, editor: profileConfig(from.profile).editor });
    if (command) await openTerminal({ kind: "split", from, direction: "right" }, command);
  } catch (error) {
    setError(error);
  }
}

/** Opens a local editor pane for a remote file, as a tab of the current workspace. */
export async function openRemoteEditor(command: string, title: string, remoteEditId: string): Promise<void> {
  await openTerminal({ kind: "tab" }, command, title, undefined, { serverId: LOCAL_SERVER_ID, remoteEditId });
}

/** Where a new local shell starts: Ghostty's working-directory, where `inherit` follows the focused pane. */
function localWorkingDirectory(placement: Placement, profile?: string): string {
  if (placement.kind === "restore") return placement.pane.cwd ?? "home";
  const configured = profileConfig(profile).workingDirectory;
  if (configured !== "inherit") return configured;
  const source = placement.kind === "split" ? placement.from : placement.kind === "replace" ? placement.tab
    : state.terminalTabs.find((tab) => tab.id === state.activeTerminalTabId && tab.serverId === LOCAL_SERVER_ID);
  return source?.cwd ?? "home";
}

/** For SSH: the directory the source pane's shell reported (with remote-shell-integration). */
function remoteWorkingDirectory(placement: Placement, serverId: string): string | undefined {
  const source = placement.kind === "split" ? placement.from : placement.kind === "replace" ? placement.tab
    : state.terminalTabs.find((tab) => tab.id === state.activeTerminalTabId);
  return source?.serverId === serverId ? source.cwd : undefined;
}

async function openTerminal(placement: Placement, command?: string, title?: string, requestedProfile?: string, extra: { serverId?: string; remoteEditId?: string } = {}): Promise<void> {
  const workspaceTabId = placement.kind === "tab" ? state.activeWorkspaceTabId
    : placement.kind === "split" ? placement.from.workspaceTabId
    : placement.kind === "restore" ? placement.group.workspaceTabId
    : placement.tab.workspaceTabId;
  const serverId = extra.serverId ?? (workspaceTabId === LOCAL_WORKSPACE_ID ? LOCAL_SERVER_ID
    : placement.kind === "tab" || placement.kind === "restore" ? state.activeServerId
    : placement.kind === "split" ? placement.from.serverId : placement.tab.serverId);
  if (!workspaceTabId || !serverId) return;
  const local = serverId === LOCAL_SERVER_ID;
  const server = state.snapshot.servers.find((item) => item.id === serverId);
  // Splits keep their pane's profile; SSH tabs pick one by match-host.
  const profile = placement.kind === "split" ? placement.from.profile : placement.kind === "replace" ? placement.tab.profile
    : placement.kind === "restore" ? placement.pane.profile
    : requestedProfile ?? (server ? profileForServer(server) : undefined);
  const cols = focusedSurface()?.cols ?? 110;
  const rows = focusedSurface()?.rows ?? 28;
  const id = placement.kind === "restore" ? placement.id : crypto.randomUUID();

  let group: TerminalGroup;
  if (placement.kind === "restore") {
    group = placement.group;
  } else if (placement.kind === "tab") {
    const prefix = profile ?? (local ? "shell" : "session");
    const used = new Set(state.terminalGroups.filter((item) => item.workspaceTabId === workspaceTabId).map((item) => item.title));
    let number = 1;
    while (used.has(`${prefix} ${number}`)) number += 1;
    group = { id: crypto.randomUUID(), workspaceTabId, title: title ?? `${prefix} ${number}`, root: leaf(id), focusedId: id, zoomed: false };
    state.terminalGroups.push(group);
  } else {
    const source = placement.kind === "split" ? placement.from : placement.tab;
    group = state.terminalGroups.find((item) => item.id === source.groupId)!;
    group.root = placement.kind === "split" ? splitLeaf(group.root, source.id, id, placement.direction) : replaceLeaf(group.root, source.id, id);
    group.focusedId = id;
    group.zoomed = false;
  }
  // A split runs the given command (an editor) or a plain shell, even next to a container exec pane.
  const tabCommand = command ?? (placement.kind === "replace" ? placement.tab.command : undefined);
  const tab: TerminalTab = { id, serverId, workspaceTabId, groupId: group.id, profile, title: group.title, command: tabCommand, connecting: true, sessionId: id, remoteEditId: extra.remoteEditId };
  const config = profileConfig(profile);
  const localRequest = { sessionId: id, cols, rows, cwd: localWorkingDirectory(placement, profile), command: tabCommand ?? config.command, env: config.env, shellIntegration: config.shellIntegration };
  if (placement.kind === "replace") disposeTerminalSurfaces([placement.tab]);
  const surface = createTerminalSurface(tab);
  if (placement.kind === "restore" && placement.pane.snapshot) {
    surface.term.write(`${placement.pane.snapshot}\r\n\x1b[0m\x1b[2m── restored session ──\x1b[0m\r\n`);
  }
  state.terminalTabs.push(tab);
  const startSession = async (): Promise<void> => {
    try {
      const started = local
        ? await invoke<TerminalStarted>("start_local_terminal", { request: localRequest, onOutput: surface.output })
        : await invokeCommand<TerminalStarted>("start_terminal", { request: { sessionId: id, serverId, cols, rows, command: tabCommand, shellIntegration: config.remoteShellIntegration && !tabCommand, cwd: remoteWorkingDirectory(placement, serverId) }, onOutput: surface.output });
      if (!local) connectedServerIds.add(serverId);
      tab.sessionId = started.sessionId; tab.connecting = false;
      // The terminal may have been fitted to its real size while the session was opening.
      if (surface.cols !== cols || surface.rows !== rows) void invoke("terminal_resize", { request: { sessionId: tab.sessionId, cols: surface.cols, rows: surface.rows } }).catch(() => undefined);
      render();
    } catch (error) {
      if (error instanceof OperationCancelledError || errorText(error).toLowerCase().includes("operation cancelled")) {
        disposeTerminalSurfaces([tab]);
        render();
        return;
      }
      tab.connecting = false; tab.closed = true; surface.notice(`Unable to open terminal: ${errorText(error)}`); setError(error);
    }
  };
  if (placement.kind === "restore") {
    // Start the shell once the pane is shown and fitted, so it starts at its real size.
    pendingStarts.set(id, () => {
      localRequest.cols = surface.cols;
      localRequest.rows = surface.rows;
      void startSession();
    });
    return;
  }
  state.activeTerminalTabId = id;
  activeTerminalTabByWorkspace.set(workspaceTabId, id);
  // With the dock open the page stays on its view; the new terminal appears in the dock.
  if (!dockShown()) state.activeView = "terminal";
  render();
  surface.focus();
  await startSession();
}

/** Closes one pane. The local workspace always keeps at least one shell. */
export async function closeTerminal(tabId: string): Promise<void> {
  const tab = state.terminalTabs.find((item) => item.id === tabId);
  if (!tab) return;
  if (tab.sessionId && !tab.closed) await invoke("close_terminal", { sessionId: tab.sessionId }).catch(() => undefined);
  disposeTerminalSurfaces([tab]);
  if (state.activeWorkspaceTabId && state.activeTerminalTabId) activeTerminalTabByWorkspace.set(state.activeWorkspaceTabId, state.activeTerminalTabId);
  if (isLocalWorkspace() && !activeTerminalGroups().length) { await openNewTerminal(); return; }
  render();
}

/** Closes a whole tab with all of its panes. */
export async function closeTerminalGroup(groupId: string): Promise<void> {
  const group = state.terminalGroups.find((item) => item.id === groupId);
  if (!group) return;
  for (const id of leaves(group.root)) await closeTerminal(id);
}

export function clearActiveTerminal(): void {
  focusedSurface()?.clear();
}

export function queueTerminalInput(sessionId: string, data: string): void {
  const previous = terminalInputChains.get(sessionId) ?? Promise.resolve();
  const next = previous
    .then(() => invokeCommand("terminal_input", { sessionId, data }))
    .then(() => undefined)
    .catch(() => undefined);
  terminalInputChains.set(sessionId, next);
  void next.then(() => {
    if (terminalInputChains.get(sessionId) === next) terminalInputChains.delete(sessionId);
  });
}

/** Restarts the focused pane's session in the same place. */
export async function reconnectTerminal(): Promise<void> {
  const current = state.terminalTabs.find((tab) => tab.id === state.activeTerminalTabId);
  if (!current) return;
  if (current.sessionId && !current.closed) await invoke("close_terminal", { sessionId: current.sessionId }).catch(() => undefined);
  await openTerminal({ kind: "replace", tab: current });
}

/** Makes a pane the focused one; `moveFocus` also moves keyboard focus into it. */
export function focusPane(terminalId: string, moveFocus = true): void {
  const group = terminalGroupOf(terminalId);
  if (!group) return;
  const changed = state.activeTerminalTabId !== terminalId;
  group.focusedId = terminalId;
  state.activeTerminalTabId = terminalId;
  activeTerminalTabByWorkspace.set(group.workspaceTabId, terminalId);
  if (moveFocus) terminalSurfaces.get(terminalId)?.focus();
  if (changed) render();
}

const appliedAppearances = new Map<string, TerminalAppearance>();

/** Applies the loaded config to every open terminal, keeping per-pane font zoom if its font is unchanged. */
export function applyTerminalAppearance(): void {
  updateSurroundings();
  for (const [id, surface] of terminalSurfaces) {
    const next = terminalAppearance(state.terminalTabs.find((tab) => tab.id === id)?.profile);
    const previous = appliedAppearances.get(id);
    const fontChanged = !previous || previous.fontSize !== next.fontSize || previous.fontFamily !== next.fontFamily;
    appliedAppearances.set(id, next);
    surface.configure(fontChanged ? next : { ...next, fontSize: surface.fontSize });
  }
}

export function setTerminalRenderer(renderer: TerminalRenderer): void {
  state.terminalRenderer = renderer;
  try { localStorage.setItem("hbox-term-renderer", renderer); } catch { /* not persisted */ }
  for (const surface of terminalSurfaces.values()) surface.setWebgl(useWebglRenderer());
}

// --- Session restore (window-save-state) ------------------------------------------------------

const SNAPSHOT_LINES = 1000;

export interface SavedPane { cwd?: string; profile?: string; snapshot?: string }

export interface SavedSession {
  version: 1;
  activeGroup: number;
  groups: { title: string; root: PaneNode; focusedId: string; panes: Record<string, SavedPane> }[];
}

/** Local tabs with their layout, directories, profiles and recent scrollback. */
export function snapshotSession(): SavedSession {
  const groups: SavedSession["groups"] = [];
  let activeGroup = 0;
  const focusedLocal = isLocalWorkspace() ? state.activeTerminalTabId : activeTerminalTabByWorkspace.get(LOCAL_WORKSPACE_ID);
  for (const group of state.terminalGroups.filter((item) => item.workspaceTabId === LOCAL_WORKSPACE_ID)) {
    let root: PaneNode | null = group.root;
    const panes: Record<string, SavedPane> = {};
    for (const id of leaves(group.root)) {
      const tab = state.terminalTabs.find((item) => item.id === id);
      // Editor panes for remote files end with their edit session.
      if (!tab || tab.remoteEditId || tab.serverId !== LOCAL_SERVER_ID) { root = root && removeLeaf(structuredClone(root), id); continue; }
      panes[id] = { cwd: tab.cwd, profile: tab.profile, snapshot: terminalSurfaces.get(id)?.snapshot(SNAPSHOT_LINES) };
    }
    if (!root) continue;
    if (focusedLocal && leaves(group.root).includes(focusedLocal)) activeGroup = groups.length;
    groups.push({ title: group.title, root, focusedId: panes[group.focusedId] ? group.focusedId : leaves(root)[0], panes });
  }
  return { version: 1, activeGroup, groups };
}

/** Reopens saved local tabs: same layout and directories, with their scrollback shown above. */
export async function restoreSession(saved: SavedSession): Promise<void> {
  if (saved.version !== 1 || !Array.isArray(saved.groups)) return;
  const restored: TerminalGroup[] = [];
  for (const savedGroup of saved.groups) {
    const ids = new Map<string, string>();
    const root = mapLeaves(savedGroup.root, (oldId) => { const id = crypto.randomUUID(); ids.set(oldId, id); return id; });
    const group: TerminalGroup = { id: crypto.randomUUID(), workspaceTabId: LOCAL_WORKSPACE_ID, title: savedGroup.title, root, focusedId: ids.get(savedGroup.focusedId) ?? leaves(root)[0], zoomed: false };
    state.terminalGroups.push(group);
    restored.push(group);
    for (const [oldId, id] of ids) {
      await openTerminal({ kind: "restore", group, id, pane: savedGroup.panes[oldId] ?? {} });
    }
  }
  const active = restored[saved.activeGroup] ?? restored.at(-1);
  if (active) activeTerminalTabByWorkspace.set(LOCAL_WORKSPACE_ID, active.focusedId);
}

// --- Terminal layer ---------------------------------------------------------------------------

/**
 * Terminals are drawn in a fixed layer outside `root`, positioned over the
 * `[data-terminal-surface]` placeholder of the current render. The layer is never re-rendered and
 * panes are only repositioned, never moved in the DOM, so terminals keep their canvas, focus
 * and scroll position across renders.
 */
const terminalLayer = document.createElement("div");
terminalLayer.className = "terminal-layer";
terminalLayer.hidden = true;
const layerInner = document.createElement("div");
layerInner.className = "terminal-layer-inner";
terminalLayer.append(layerInner);
document.body.append(terminalLayer);

const shownSurfaces = new Set<TerminalSurface>();
/** Restored panes whose shell starts when they are first laid out. */
const pendingStarts = new Map<string, () => void>();
let lastPaneRects = new Map<string, Rect>();
let dividerElements: HTMLElement[] = [];
/** Current layout data for each divider element; elements are reused so a drag keeps its pointer capture. */
const dividerData = new WeakMap<HTMLElement, Divider>();
let placeholderObserver: ResizeObserver | null = null;
let observedPlaceholder: HTMLElement | null = null;
new ResizeObserver(() => layoutPanesInLayer()).observe(layerInner);

function terminalPlaceholder(): HTMLElement | null {
  return state.activeView === "terminal" || dockShown() ? root.querySelector<HTMLElement>("[data-terminal-surface]") : null;
}

/** Opens or closes the terminal dock of the current server workspace (Ctrl+` / palette). */
export async function toggleTerminalDock(): Promise<boolean> {
  const workspaceTabId = state.activeWorkspaceTabId;
  if (!workspaceTabId || isLocalWorkspace() || !state.activeServerId) return false;
  if (state.activeView === "terminal") return false;
  const dock = terminalDocks.get(workspaceTabId) ?? { open: false, position: "right", ratio: 0.45 };
  dock.open = !dock.open;
  terminalDocks.set(workspaceTabId, dock);
  if (dock.open && !activeTerminalGroups().length) await openNewTerminal();
  else render();
  if (dock.open) focusedSurface()?.focus();
  return true;
}

export function toggleDockPosition(): void {
  const dock = activeDock();
  if (!dock) return;
  dock.position = dock.position === "right" ? "bottom" : "right";
  render();
}

/** Dragging the divider between a view and the dock (only CSS changes; the layer follows). */
export function installDockDivider(): void {
  root.addEventListener("pointerdown", (event) => {
    const divider = (event.target as HTMLElement).closest<HTMLElement>("[data-dock-divider]");
    const layout = divider?.closest<HTMLElement>(".dock-layout");
    const dock = activeDock();
    if (!divider || !layout || !dock) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const rect = layout.getBoundingClientRect();
      const fraction = dock.position === "right" ? (rect.right - moveEvent.clientX) / rect.width : (rect.bottom - moveEvent.clientY) / rect.height;
      dock.ratio = Math.min(0.85, Math.max(0.15, fraction));
      layout.style.setProperty("--dock-ratio", String(dock.ratio));
    };
    const finish = () => { divider.removeEventListener("pointermove", move); focusedSurface()?.focus(); };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", finish, { once: true });
    divider.addEventListener("pointercancel", finish, { once: true });
  });
}

/** Positions the layer over the placeholder, clipped to the scrolling content area. */
export function positionTerminalLayer(): void {
  const placeholder = terminalPlaceholder();
  if (!placeholder || !shownSurfaces.size) { terminalLayer.hidden = true; return; }
  const rect = placeholder.getBoundingClientRect();
  const bounds = (placeholder.closest(".terminal-dock, .content-area") ?? placeholder).getBoundingClientRect();
  const style = getComputedStyle(placeholder);
  const inset = [bounds.top - rect.top, rect.right - bounds.right, rect.bottom - bounds.bottom, bounds.left - rect.left].map((value) => Math.max(0, value));
  Object.assign(terminalLayer.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    padding: style.padding,
    // Only clip when needed: a clip path changes how WebKit composites the WebGL canvas.
    clipPath: inset.some((value) => value > 0) ? `inset(${inset.map((value) => `${value}px`).join(" ")})` : "none",
  });
  terminalLayer.hidden = false;
}

/** Padding around the panes and the Local tab take the visible tab's terminal background. */
function updateSurroundings(): void {
  const focused = state.terminalTabs.find((tab) => tab.id === activeTerminalGroup()?.focusedId);
  document.documentElement.style.setProperty("--terminal-background", terminalAppearance(focused?.profile).theme.background ?? "");
}

/** Positions the active tab's panes and dividers inside the layer. */
function layoutPanesInLayer(): Map<string, Rect> {
  const group = terminalPlaceholder() ? activeTerminalGroup() : undefined;
  const area = { x: 0, y: 0, width: layerInner.clientWidth, height: layerInner.clientHeight };
  const ids = group ? leaves(group.root) : [];
  const layout = group && !group.zoomed ? layoutPanes(group.root, area) : { panes: new Map(group ? [[group.focusedId, area]] : []), dividers: [] };
  for (const surface of shownSurfaces) {
    if (![...layout.panes.keys()].some((id) => terminalSurfaces.get(id) === surface)) { surface.hide(); shownSurfaces.delete(surface); }
  }
  for (const [id, rect] of layout.panes) {
    const surface = terminalSurfaces.get(id);
    if (!surface) continue;
    surface.show(layerInner);
    surface.place(rect);
    surface.setDimmed(ids.length > 1 && !group?.zoomed && id !== group?.focusedId);
    surface.host.classList.toggle("broadcasting", Boolean(group?.broadcast));
    shownSurfaces.add(surface);
  }
  while (dividerElements.length > layout.dividers.length) dividerElements.pop()!.remove();
  while (dividerElements.length < layout.dividers.length) dividerElements.push(createDividerElement());
  layout.dividers.forEach((divider, index) => {
    const element = dividerElements[index];
    const vertical = divider.split.direction === "right";
    dividerData.set(element, divider);
    element.className = `pane-divider ${vertical ? "vertical" : "horizontal"}${element.classList.contains("dragging") ? " dragging" : ""}`;
    Object.assign(element.style, { left: `${divider.rect.x}px`, top: `${divider.rect.y}px`, width: vertical ? "" : `${divider.rect.width}px`, height: vertical ? `${divider.rect.height}px` : "" });
  });
  lastPaneRects = layout.panes;
  positionSearchBar();
  const starting = [...layout.panes.keys()].filter((id) => pendingStarts.has(id));
  if (starting.length) {
    // Two frames: one for the resize observer to see the new size, one for the fit.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      for (const id of starting) {
        const start = pendingStarts.get(id);
        pendingStarts.delete(id);
        start?.();
      }
    }));
  }
  updateSurroundings();
  return layout.panes;
}

function createDividerElement(): HTMLElement {
  const element = document.createElement("div");
  element.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    element.classList.add("dragging");
    const move = (moveEvent: PointerEvent) => {
      const divider = dividerData.get(element);
      if (!divider) return;
      const origin = layerInner.getBoundingClientRect();
      const vertical = divider.split.direction === "right";
      const position = vertical ? moveEvent.clientX - origin.left - divider.area.x : moveEvent.clientY - origin.top - divider.area.y;
      const size = vertical ? divider.area.width : divider.area.height;
      divider.split.ratio = Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, position / size));
      layoutPanesInLayer();
    };
    const finish = () => {
      element.removeEventListener("pointermove", move);
      element.classList.remove("dragging");
      focusedSurface()?.focus();
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", finish, { once: true });
    element.addEventListener("pointercancel", finish, { once: true });
  });
  layerInner.append(element);
  return element;
}

/** Shows the active tab's panes over the freshly rendered view, if the terminal view is showing. */
export function mountTerminal(): void {
  const placeholder = terminalPlaceholder();
  if (placeholder !== observedPlaceholder) {
    placeholderObserver?.disconnect();
    observedPlaceholder = placeholder;
    if (placeholder) {
      placeholderObserver ??= new ResizeObserver(() => positionTerminalLayer());
      placeholderObserver.observe(placeholder);
    }
  }
  // Show first so the layer has a size, then lay the panes out inside it.
  terminalLayer.hidden = !placeholder;
  layoutPanesInLayer();
  positionTerminalLayer();
  const surface = placeholder ? focusedSurface() : undefined;
  if (!surface) return;
  const focused = document.activeElement;
  if (!state.modal && (!focused || focused === document.body || terminalLayer.contains(focused))) surface.focus();
}

window.addEventListener("resize", positionTerminalLayer);
// Server terminal views scroll with the content area.
root.addEventListener("scroll", positionTerminalLayer, { capture: true, passive: true });

// --- Scrollback search ------------------------------------------------------------------------

const searchBar = document.createElement("div");
searchBar.className = "terminal-search";
searchBar.hidden = true;
searchBar.innerHTML = `<input type="text" placeholder="Find" spellcheck="false" autocomplete="off" aria-label="Find in scrollback"><span class="terminal-search-count" aria-live="polite"></span><button type="button" data-search="caseSensitive" title="Match case" aria-pressed="false">Aa</button><button type="button" data-search="regex" title="Regular expression" aria-pressed="false">.*</button><button type="button" data-search="previous" title="Previous match (Shift+Enter)">↑</button><button type="button" data-search="next" title="Next match (Enter)">↓</button><button type="button" data-search="close" title="Close (Escape)">✕</button>`;
layerInner.append(searchBar);
const searchInput = searchBar.querySelector("input")!;
const searchCount = searchBar.querySelector<HTMLElement>(".terminal-search-count")!;
const searchOptions = { caseSensitive: false, regex: false };
let searchSurface: TerminalSurface | null = null;
let searchSubscription: { dispose(): void } | null = null;

function runSearch(backwards: boolean): void {
  if (!searchSurface) return;
  const found = searchSurface.find(searchInput.value, backwards, searchOptions);
  if (!searchInput.value) searchCount.textContent = "";
  else if (!found) searchCount.textContent = "No matches";
}

function openSearch(surface: TerminalSurface): void {
  if (searchSurface !== surface) {
    closeSearch(false);
    searchSurface = surface;
    searchSubscription = surface.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      searchCount.textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : searchInput.value ? "No matches" : "";
    });
  }
  searchBar.hidden = false;
  positionSearchBar();
  // Start from the current selection, like most terminals.
  const selection = surface.selectionText(true);
  if (selection && !selection.includes("\n")) searchInput.value = selection;
  searchInput.focus();
  searchInput.select();
  if (searchInput.value) runSearch(false);
}

function closeSearch(refocus = true): void {
  searchSurface?.clearSearch();
  searchSubscription?.dispose();
  searchSubscription = null;
  searchSurface = null;
  searchBar.hidden = true;
  searchCount.textContent = "";
  if (refocus) focusedSurface()?.focus();
}

/** Keeps the bar at the top right of the pane it searches; closes it when that pane is hidden. */
function positionSearchBar(): void {
  if (!searchSurface) return;
  const id = [...terminalSurfaces].find(([, surface]) => surface === searchSurface)?.[0];
  const rect = id ? lastPaneRects.get(id) : undefined;
  if (!rect) { closeSearch(false); return; }
  searchBar.style.top = `${rect.y + 8}px`;
  searchBar.style.right = `${layerInner.clientWidth - rect.x - rect.width + 12}px`;
}

searchInput.addEventListener("input", () => runSearch(false));
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); runSearch(event.shiftKey); }
  else if (event.key === "Escape") { event.preventDefault(); closeSearch(); }
});
searchBar.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-search]");
  if (!button) return;
  const command = button.dataset.search;
  if (command === "close") { closeSearch(); return; }
  if (command === "caseSensitive" || command === "regex") {
    searchOptions[command] = !searchOptions[command];
    button.setAttribute("aria-pressed", String(searchOptions[command]));
  }
  runSearch(command === "previous");
  searchInput.focus();
});

// --- Keybinding actions -----------------------------------------------------------------------

function cycleTab(step: number): void {
  const groups = activeTerminalGroups();
  const index = groups.findIndex((group) => group === activeTerminalGroup());
  const next = groups[(index + step + groups.length) % groups.length];
  if (next) focusPane(next.focusedId);
}

async function pasteFromClipboard(surface: TerminalSurface): Promise<void> {
  const text = await readText().catch(() => "");
  if (!text) return;
  rememberClipboard(text);
  await pasteWithProtection(surface, text);
}

/** Pastes, asking first for multi-line text unless bracketed paste makes it safe. */
async function pasteWithProtection(surface: TerminalSurface, text: string): Promise<void> {
  // Multi-line text runs commands unless the program asked for bracketed paste (Ghostty's
  // clipboard-paste-protection with clipboard-paste-bracketed-safe).
  const tab = state.terminalTabs.find((item) => terminalSurfaces.get(item.id) === surface);
  const { pasteProtection, pasteBracketedSafe } = profileConfig(tab?.profile);
  if (pasteProtection && /[\r\n]/.test(text) && !(pasteBracketedSafe && surface.bracketedPaste)) {
    const preview = text.length > 400 ? `${text.slice(0, 400)}…` : text;
    if (!(await confirm(`This text contains line breaks, so pasting it may run commands immediately:\n\n${preview}`, { title: "Paste multiple lines?", kind: "warning" }))) {
      surface.focus();
      return;
    }
  }
  surface.paste(text);
  surface.focus();
}

/** The pane under a point in window (CSS pixel) coordinates, if the terminal view shows one. */
export function paneAt(x: number, y: number): TerminalTab | undefined {
  if (terminalLayer.hidden) return undefined;
  const origin = layerInner.getBoundingClientRect();
  for (const [id, rect] of lastPaneRects) {
    const left = origin.left + rect.x;
    const top = origin.top + rect.y;
    if (x >= left && x < left + rect.width && y >= top && y < top + rect.height) return state.terminalTabs.find((tab) => tab.id === id);
  }
  return undefined;
}

const shellQuote = (value: string): string => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/**
 * Files dropped on a pane: a local pane gets their quoted paths typed in (like Ghostty), an SSH
 * pane uploads them to its directory (reported by remote shell integration) or the home directory.
 */
export async function dropOnPane(tab: TerminalTab, paths: string[]): Promise<void> {
  const surface = terminalSurfaces.get(tab.id);
  if (!surface || !paths.length) return;
  focusPane(tab.id);
  if (tab.serverId === LOCAL_SERVER_ID) {
    surface.paste(`${paths.map(shellQuote).join(" ")} `);
    return;
  }
  const server = state.snapshot.servers.find((item) => item.id === tab.serverId);
  const directory = tab.cwd ?? ".";
  const where = directory === "." ? "your home directory" : directory;
  const names = paths.map((path) => path.split("/").pop()).join(", ");
  if (!(await confirm(`Upload ${names} to ${where} on ${server?.name ?? "the server"}?`, { title: "Upload to server" }))) return;
  for (const path of paths) await transferUpload(path, directory, tab.serverId);
  surface.focus();
}

/** Types text into the focused pane (bracketed, so it is not run until the user presses Enter). */
export function pasteIntoFocused(text: string): boolean {
  const surface = terminalPlaceholder() ? focusedSurface() : undefined;
  if (!surface) return false;
  surface.paste(text);
  surface.focus();
  return true;
}

// Copies and pastes made in hbox-term, newest first; kept in memory only.
const CLIPBOARD_HISTORY_SIZE = 25;
const clipboardHistory: string[] = [];

function rememberClipboard(text: string): void {
  if (!text.trim()) return;
  const existing = clipboardHistory.indexOf(text);
  if (existing >= 0) clipboardHistory.splice(existing, 1);
  clipboardHistory.unshift(text);
  clipboardHistory.length = Math.min(clipboardHistory.length, CLIPBOARD_HISTORY_SIZE);
}

function showPasteHistory(surface: TerminalSurface): void {
  if (!clipboardHistory.length) { showToast("Nothing copied or pasted in hbox-term yet.", "info"); return; }
  openPicker("Paste from history…", clipboardHistory.map((text): PaletteItem => {
    const lines = text.split("\n");
    return {
      title: (lines.find((line) => line.trim()) ?? "").trim().slice(0, 120),
      detail: lines.length > 1 ? `${lines.length} lines` : `${text.length} characters`,
      kind: "Clipboard",
      run: () => pasteWithProtection(surface, text),
    };
  }));
}

/** Completes the word before the cursor from the pane's recent output (iTerm2's Cmd+;). */
function showCompletions(surface: TerminalSurface, tab: TerminalTab): void {
  const buffer = surface.term.buffer.active;
  const cursorLine = buffer.baseY + buffer.cursorY;
  const prefix = wordBeforeCursor(buffer.getLine(cursorLine)?.translateToString(false, 0, buffer.cursorX) ?? "");
  const lines: string[] = [];
  for (let line = Math.max(0, cursorLine - 2000); line < cursorLine; line++) lines.push(buffer.getLine(line)?.translateToString(true) ?? "");
  const words = completions(lines, prefix);
  const insert = (word: string) => { if (tab.sessionId) queueTerminalInput(tab.sessionId, word.slice(prefix.length)); surface.focus(); };
  if (!words.length) { showToast(prefix ? `No completions for “${prefix}” in this pane's output.` : "No words in this pane's output yet.", "info"); return; }
  if (words.length === 1) { insert(words[0]); return; }
  openPicker(prefix ? `Complete “${prefix}”…` : "Insert a word from the output…", words.map((word): PaletteItem => ({ title: word, kind: "Word", run: () => insert(word) })));
}

/** Runs a keybinding action. Returns false when it does not apply right now. */
export function runTerminalAction(action: KeyAction): boolean {
  if (action === "toggle_quick_terminal") {
    void invoke("toggle_quick_terminal");
    return true;
  }
  if (action === "reload_config") {
    void loadTerminalConfig(true);
    return true;
  }
  if (action === "toggle_terminal_dock") {
    void toggleTerminalDock().then((toggled) => { if (!toggled) showToast("The terminal dock is for server views like Files or Logs.", "info"); });
    return true;
  }
  if (action === "new_tab") {
    if (!isLocalWorkspace() && !state.activeServerId) return false;
    void openNewTerminal();
    return true;
  }
  const surface = terminalPlaceholder() ? focusedSurface() : undefined;
  const tab = state.terminalTabs.find((item) => item.id === state.activeTerminalTabId);
  const group = activeTerminalGroup();
  if (!surface || !tab || !group) return false;
  switch (action) {
    case "copy_to_clipboard": {
      const text = surface.selectionText(profileConfig(tab.profile).trimTrailingSpaces);
      if (text) { rememberClipboard(text); void writeText(text).catch(setError); }
      return true;
    }
    case "paste_from_clipboard": void pasteFromClipboard(surface); return true;
    case "select_all": surface.selectAll(); return true;
    case "start_search": openSearch(surface); return true;
    case "jump_to_prompt:-1": case "jump_to_prompt:1":
      if (!surface.jumpToPrompt(action === "jump_to_prompt:1" ? 1 : -1) && !surface.commands.active) showToast("Jumping between prompts needs shell integration.", "info");
      return true;
    case "copy_last_output": {
      const text = surface.commands.lastOutput();
      if (text === null) showToast(surface.commands.active ? "No finished command to copy yet." : "Copying command output needs shell integration.", "info");
      else { rememberClipboard(text); void writeText(text).then(() => showToast("Copied the last command's output.", "success")).catch(setError); }
      return true;
    }
    case "clear_screen": surface.clear(); return true;
    case "close_surface": void closeTerminal(tab.id); return true;
    case "new_split:right": case "new_split:down":
      void openTerminal({ kind: "split", from: tab, direction: action === "new_split:right" ? "right" : "down" });
      return true;
    case "toggle_split_zoom":
      if (leaves(group.root).length > 1) { group.zoomed = !group.zoomed; layoutPanesInLayer(); surface.focus(); }
      return true;
    case "goto_split:left": case "goto_split:right": case "goto_split:up": case "goto_split:down": {
      if (group.zoomed) return true;
      const target = neighbor(layoutPanesInLayer(), tab.id, action.slice("goto_split:".length) as FocusDirection);
      if (target) focusPane(target);
      return true;
    }
    case "toggle_broadcast":
      group.broadcast = !group.broadcast;
      layoutPanesInLayer();
      render();
      showToast(group.broadcast ? `Typing now goes to all ${leaves(group.root).length} panes of this tab.` : "Broadcast input is off.", "info");
      return true;
    case "paste_history": showPasteHistory(surface); return true;
    case "autocomplete": showCompletions(surface, tab); return true;
    case "move_tab:-1": case "move_tab:1": moveTab(group.id, action === "move_tab:1" ? 1 : -1); return true;
    case "rename_tab": void renameTab(group.id); return true;
    case "next_tab": cycleTab(1); return true;
    case "previous_tab": cycleTab(-1); return true;
    case "last_tab": { const last = activeTerminalGroups().at(-1); if (last) focusPane(last.focusedId); return true; }
    case "increase_font_size:1": surface.setFontSize(surface.fontSize + 1); return true;
    case "decrease_font_size:1": surface.setFontSize(surface.fontSize - 1); return true;
    case "reset_font_size": surface.setFontSize(terminalAppearance(tab.profile).fontSize); return true;
    default: {
      const index = /^goto_tab:(\d+)$/.exec(action)?.[1];
      const target = index ? activeTerminalGroups()[Number(index) - 1] : undefined;
      if (target) focusPane(target.focusedId);
      return true;
    }
  }
}
