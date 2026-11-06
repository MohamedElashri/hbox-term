import { freezeShutdown, releaseShutdown, shutdownFrozen } from "./app/shutdown-freeze";
import { refreshTransferQueue } from "./app/transfer-queue";
import { flushRemoteEdits } from "./app/terminal";
import { installCredentialPrivacy } from "./app/credential-privacy";
import { installWindowEvents } from "./app/window-events";
import { confirmTerminalClose } from "./app/terminal-close";
import { cancelCurrentOperation } from "./app/session";
import { watchSharedSsh } from "./app/shared-ssh";
import { rememberGroup } from "./app/connection-groups";
import { closeCustomSelects } from "./app/select-controls";
import { containModalFocus, handleModalKeydown } from "./app/modal-state";
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
import { handleChange, handleClick, handleInput, handleKeydown, handleSubmit, runAction, workspaceTabDrag } from "./app/events";
import { render } from "./app/render";
import { composingText, matchKeybinding } from "./app/keybindings";
import { appWindow, DEFAULT_INTERFACE_SCALE, quickMode, root, state } from "./app/state";
import { togglePalette } from "./app/palette";
import { loadTerminalConfig } from "./app/terminal-config";
import { installTabStripHandlers } from "./app/terminal-tabs";
import { closeTerminalGroup, dropOnPane, installDockDivider, moveTab, paneAt, renameTab, restoreSession, runTerminalAction, type SavedSession } from "./app/terminal";
import { dismissTransferToast, setInterfaceScale, showToast, stepInterfaceScale, syncTransferToast } from "./app/toasts";
import { refreshSnapshot, selectLocalWorkspace } from "./app/workspace";
import { saveSession, sessionSavingEnabled } from "./app/session-save";
import { confirm } from "./app/modals";
import "./styles.css";
import type { CredentialStatus, TerminalEvent, TransferProgress } from "./types";

let finishBootstrap: () => void;
const windowReady = new Promise<void>(resolve => { finishBootstrap = resolve; });
let bootstrapSucceeded = false;
const preparedQuitTokens = new Set<string>();
async function prepareQuit(token: string, restart = false): Promise<void> {
  if (preparedQuitTokens.has(token)) return;
  preparedQuitTokens.add(token);
  if (preparedQuitTokens.size > 8) preparedQuitTokens.delete(preparedQuitTokens.values().next().value!);
  await windowReady;
  if (!await confirmTerminalClose(state.terminalTabs, restart ? "Restart Ternway" : "Quit Ternway", "quit")) {
    await invoke("acknowledge_quit", { token, ready: false }); return;
  }
  freezeShutdown(token, restart);
  if (!await flushRemoteEdits(state.terminalTabs)) { await invoke("acknowledge_quit", { token, ready: false }); return; }
  cancelCurrentOperation();
  let ready = false;
  try { if (!quickMode && bootstrapSucceeded) await saveSession(); ready = true; }
  catch (error) { showToast(`Could not save the workspace: ${errorText(error)}`, "info"); }
  await invoke("acknowledge_quit", { token, ready });
}

async function installEventListeners(): Promise<void> {
  await installCredentialPrivacy();
  state.terminalUnlisteners.push(...await installWindowEvents(appWindow.label, {
    quit: (token, restart) => { void prepareQuit(token, restart); },
    about: () => { void runAction("show-about"); },
    updates: () => { void runAction("check-updates"); },
  }, listen));
  state.terminalUnlisteners.push(await listen("library-changed", () => { void refreshSnapshot(false).then(() => { if (!state.modal && !state.appDialogPrompt) render(); }); }));
  state.terminalUnlisteners.push(await listen("transfer-queue-changed", () => { void refreshTransferQueue(); }));
  state.terminalUnlisteners.push(await listen<{token: string; message: string}>("shutdown-aborted", event => { releaseShutdown(event.payload.token); showToast(event.payload.message, "info"); }));
  // Quit can be requested before this webview has installed its event listener.
  const pending = await invoke<{token: string; restart: boolean} | null>("pending_quit");
  if (pending) void prepareQuit(pending.token, pending.restart);
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
  }, { target: appWindow.label }));
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

installTabStripHandlers(root, { closeTerminalGroup, moveTab, renameTab });
installDockDivider();
root.addEventListener("click", (event) => { void handleClick(event); });
root.addEventListener("toggle", (event) => {
  const details = event.target as HTMLDetailsElement;
  if (details.dataset.connectionGroup && !state.serverQuery) rememberGroup(details.dataset.connectionGroup, details.open);
}, true);
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
document.addEventListener("focusin", event => containModalFocus(root, event));
window.addEventListener("keydown", (event) => {
  if (shutdownFrozen() && !(event.target instanceof Element && event.target.closest(".shutdown-freeze"))) { event.preventDefault(); event.stopImmediatePropagation(); return; }
  if (composingText(event)) return;
  // This listener runs in capture phase, before the picker's key handler.
  const openPicker = root.querySelector<HTMLElement>(".custom-select.open");
  if (event.key === "Escape" && openPicker) {
    event.preventDefault();
    event.stopPropagation();
    closeCustomSelects(root);
    openPicker.querySelector<HTMLButtonElement>(".custom-select-trigger")?.focus();
    return;
  }
  if (event.key === "Escape" && (state.modal || state.appDialogPrompt)) {
    event.preventDefault();
    event.stopPropagation();
    closeModal();
    return;
  }
  if (handleModalKeydown(root, event)) return;
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
}, { capture: true });

const SESSION_SAVE_INTERVAL_MS = 30_000;

async function restoreSavedSession(): Promise<boolean> {
  const layoutId = new URLSearchParams(window.location.search).get("layout");
  if (!layoutId && !sessionSavingEnabled()) return false;
  try {
    if (layoutId) {
      const saved = await invoke<{layout: unknown}>("load_workspace", { id: layoutId });
      await restoreSession(saved.layout); return true;
    }
    const saved = await invoke<string | null>("load_session");
    if (saved) { await restoreSession(JSON.parse(saved) as SavedSession); return true; }
  } catch (error) {
    state.activeWorkspaceTabId = "local"; state.activeView = "terminal";
    state.errorMessage = `Could not restore the workspace: ${errorText(error)}`;
    return true; // A damaged layout must not turn into an automatic command launch.
  }
  return false;
}

/** Saves local tabs periodically (so a crash loses little) and when the window closes. */
function startSessionSaving(): void {
  window.setInterval(() => {
    void saveSession().catch(error => showToast(`Could not save the workspace: ${errorText(error)}`, "info"));
  }, SESSION_SAVE_INTERVAL_MS);
  void appWindow.onCloseRequested(async event => {
    if (shutdownFrozen()) { event.preventDefault(); return; }
    if (!await confirmTerminalClose(state.terminalTabs, "Close window", "window")) { event.preventDefault(); return; }
    if (!await flushRemoteEdits(state.terminalTabs)) { event.preventDefault(); return; }
    cancelCurrentOperation();
    try {
      await saveSession();
      await Promise.all(state.terminalTabs.filter(tab => tab.sessionId).map(tab => invoke("close_terminal", { sessionId: tab.sessionId }).catch(() => undefined)));
    } catch (error) {
      event.preventDefault();
      if (await confirm(`This window’s layout could not be saved. Close without saving it?\n${errorText(error)}`, { title: "Session could not be saved", kind: "warning", confirmLabel: "Close without saving" })) await appWindow.destroy();
    }
  });
}

async function bootstrap(): Promise<void> {
  await setInterfaceScale(state.interfaceScale, false);
  render();
  try {
    await installEventListeners();
    watchSharedSsh();
    await refreshSnapshot(false);
    state.credentialStatus = await invoke<CredentialStatus>("get_credential_status");
    state.loading = false;
    // Load the config first so the first shell already uses it, and the bundled font (Ghostty's
    // default, not installed on macOS) before xterm.js measures its cell size.
    await loadTerminalConfig();
    if (!quickMode) await invoke("set_window_restore", { enabled: sessionSavingEnabled() });
    await Promise.all(["400", "700"].map((weight) => document.fonts.load(`${weight} 16px "JetBrains Mono"`))).catch(() => undefined);
    const restored = !quickMode && await restoreSavedSession();
    if (restored) render(); else await selectLocalWorkspace();
    if (!quickMode) startSessionSaving();
    bootstrapSucceeded = true;
  } catch (error) {
    state.loading = false; state.errorMessage = errorText(error); render();
  } finally { finishBootstrap(); }
}

void bootstrap();
