import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/400-italic.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/jetbrains-mono/700-italic.css";
import "@xterm/xterm/css/xterm.css";
import { closeModal } from "./app/actions/admin";
import { appendLogOutput } from "./app/actions/logs";
import { transferUpload } from "./app/actions/remote";
import { errorText } from "./app/command-client";
import { handleChange, handleClick, handleInput, handleKeydown, handleSubmit, workspaceTabDrag } from "./app/events";
import { render } from "./app/render";
import { matchKeybinding } from "./app/keybindings";
import { appWindow, DEFAULT_INTERFACE_SCALE, quickMode, root, state } from "./app/state";
import { togglePalette } from "./app/palette";
import { loadTerminalConfig } from "./app/terminal-config";
import { installTabStripHandlers } from "./app/terminal-tabs";
import { dropOnPane, installDockDivider, paneAt, restoreSession, runTerminalAction, snapshotSession, type SavedSession } from "./app/terminal";
import { dismissTransferToast, setInterfaceScale, showToast, stepInterfaceScale, syncTransferToast } from "./app/toasts";
import { refreshSnapshot, selectLocalWorkspace } from "./app/workspace";
import { confirm } from "./app/modals";
import "./styles.css";
import type { CredentialStatus, TerminalEvent, TransferProgress } from "./types";

async function installEventListeners(): Promise<void> {
  state.terminalUnlisteners.push(await listen<TerminalEvent>("log-stream-output", (event) => {
    if (state.logsViewer.streamId === event.payload.sessionId) appendLogOutput(state.logsViewer, event.payload.data, "workspace");
    else if (state.containerLogViewer?.streamId === event.payload.sessionId) appendLogOutput(state.containerLogViewer, event.payload.data, "container");
  }));
  state.terminalUnlisteners.push(await listen<TerminalEvent>("log-stream-closed", (event) => {
    const viewer = state.logsViewer.streamId === event.payload.sessionId ? state.logsViewer : state.containerLogViewer?.streamId === event.payload.sessionId ? state.containerLogViewer : null;
    if (!viewer) return;
    viewer.streamId = undefined;
    viewer.following = false;
    viewer.status = "stopped";
    render();
  }));
  state.terminalUnlisteners.push(await listen("config-changed", () => { void loadTerminalConfig(true); }));
  state.terminalUnlisteners.push(await listen<{ id: string; remotePath: string; status: string; message?: string }>("remote-edit", (event) => {
    const { id, remotePath, status, message } = event.payload;
    const name = remotePath.split("/").pop() || remotePath;
    if (status === "saved") showToast(`Saved ${name} to the server.`, "success");
    else if (status === "failed") showToast(`Could not upload ${name}: ${message ?? "unknown error"}. Save again to retry.`, "info");
    else if (status === "conflict") {
      void confirm(`${remotePath} changed on the server since you opened it. Overwrite it with your version?`, { title: "File changed on the server", kind: "warning" })
        .then((overwrite) => { if (overwrite) void invoke("overwrite_remote_edit", { id }); });
    }
  }));
  state.terminalUnlisteners.push(await listen<TransferProgress>("transfer-progress", (event) => {
    state.transfer = event.payload;
    syncTransferToast();
    if (event.payload.done) dismissTransferToast(event.payload.transferId);
  }));
  state.terminalUnlisteners.push(await listen<{ paths?: string[]; position?: { x: number; y: number } }>("tauri://drag-drop", (event) => {
    const paths = event.payload?.paths ?? [];
    if (!paths.length) return;
    // The position is in physical pixels.
    const position = event.payload.position;
    const pane = position ? paneAt(position.x / window.devicePixelRatio, position.y / window.devicePixelRatio) : undefined;
    if (pane) { void dropOnPane(pane, paths); return; }
    if (state.activeView !== "files") return;
    for (const path of paths) void transferUpload(path);
  }));
}

installTabStripHandlers(root);
installDockDivider();
root.addEventListener("click", (event) => { void handleClick(event); });
root.addEventListener("input", handleInput);
root.addEventListener("change", handleChange);
root.addEventListener("submit", (event) => { void handleSubmit(event); });
root.addEventListener("keydown", handleKeydown);
root.addEventListener("pointerdown", workspaceTabDrag.pointerDown);
root.addEventListener("pointermove", workspaceTabDrag.pointerMove);
root.addEventListener("pointerup", workspaceTabDrag.finishPointerDrag);
root.addEventListener("pointercancel", workspaceTabDrag.finishPointerDrag);
root.addEventListener("click", (event) => {
  const backdrop = (event.target as HTMLElement).closest<HTMLElement>("[data-backdrop], [data-app-dialog]");
  if (backdrop && event.target === backdrop) closeModal();
});

window.addEventListener("contextmenu", (event) => { event.preventDefault(); }, { capture: true });
window.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  const inTerminal = Boolean(target.closest?.(".terminal-host"));
  const inField = !inTerminal && target.matches?.("input, textarea, select, [contenteditable]");
  const action = matchKeybinding(state.keybindings, event);
  if (action === "toggle_command_palette" && !state.modal && !state.appDialogPrompt) {
    event.preventDefault();
    event.stopPropagation();
    togglePalette();
    return;
  }
  if (!state.modal && !state.appDialogPrompt && !inField) {
    if (action && runTerminalAction(action)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }
  // Every other key typed in a terminal belongs to the shell (Ctrl+K, Ctrl+-, …).
  if (inTerminal) return;
  if ((event.metaKey || event.ctrlKey) && !event.altKey) {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      void stepInterfaceScale(1);
      return;
    }
    if (event.key === "-") {
      event.preventDefault();
      void stepInterfaceScale(-1);
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      void setInterfaceScale(DEFAULT_INTERFACE_SCALE);
      return;
    }
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    root.querySelector<HTMLInputElement>('[data-field="server-search"]')?.focus();
  }
  if (event.key === "Escape" && (state.modal || state.appDialogPrompt)) closeModal();
}, { capture: true });

const SESSION_SAVE_INTERVAL_MS = 30_000;
let lastSavedSession = "";

const sessionSavingEnabled = (): boolean => state.terminalConfig.config.windowSaveState !== "never";

async function restoreSavedSession(): Promise<void> {
  if (!sessionSavingEnabled()) return;
  try {
    const saved = await invoke<string | null>("load_session");
    if (saved) await restoreSession(JSON.parse(saved) as SavedSession);
  } catch (error) {
    console.warn("Could not restore the previous session", error);
  }
}

async function saveSession(): Promise<void> {
  if (!sessionSavingEnabled()) return;
  const contents = JSON.stringify(snapshotSession());
  if (contents === lastSavedSession) return;
  await invoke("save_session", { contents });
  lastSavedSession = contents;
}

/** Saves local tabs periodically (so a crash loses little) and when the window closes. */
function startSessionSaving(): void {
  window.setInterval(() => { void saveSession().catch(() => undefined); }, SESSION_SAVE_INTERVAL_MS);
  void appWindow.onCloseRequested(async () => { await saveSession().catch(() => undefined); });
}

async function bootstrap(): Promise<void> {
  await setInterfaceScale(state.interfaceScale, false);
  render();
  try {
    await installEventListeners();
    await refreshSnapshot(false);
    state.credentialStatus = await invoke<CredentialStatus>("get_credential_status");
    state.loading = false;
    // Load the config first so the first shell already uses it, and the bundled font (Ghostty's
    // default, not installed on macOS) before xterm.js measures its cell size.
    await loadTerminalConfig();
    await Promise.all(["400", "700"].map((weight) => document.fonts.load(`${weight} 16px "JetBrains Mono"`))).catch(() => undefined);
    if (!quickMode) await restoreSavedSession();
    await selectLocalWorkspace();
    if (!quickMode) startSessionSaving();
  } catch (error) {
    state.loading = false; state.errorMessage = errorText(error); render();
  }
}

void bootstrap();
