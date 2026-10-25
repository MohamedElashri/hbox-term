import { invoke } from "@tauri-apps/api/core";
import type { LogStreamStarted } from "../../types";
import { normalizeLogOutput } from "../format";
import { render } from "../render";
import { invokeCommand, setError } from "../session";
import { activeCapabilities, root, state } from "../state";
import type { LogViewerState } from "../types";
import { countLogLines, filteredLogs } from "../views/logs";
import { clearRefreshTimer, viewRequestIsCurrent } from "../workspace";
import { containerLogBelongsToActiveTab } from "./containers";

export function logViewerForScope(scope?: string): LogViewerState | null {
  return scope === "container" ? state.containerLogViewer : state.logsViewer;
}

export function logRequest(viewer: LogViewerState): Record<string, unknown> {
  const common = {
    lines: viewer.lines,
    since: viewer.since || undefined,
    query: undefined,
    severity: undefined,
  };
  switch (viewer.target.source) {
    case "container": return { ...common, source: "container", container: viewer.target.container };
    case "compose": return { ...common, source: "compose", composePath: viewer.target.composePath, service: viewer.target.service };
    case "file": return { ...common, source: "file", filePath: viewer.target.filePath, container: viewer.target.container };
    case "system": return { ...common, source: "system", service: viewer.target.service };
  }
}

export function logViewerIsCurrent(viewer: LogViewerState, scope: "workspace" | "container", serverId = state.activeServerId): boolean {
  if (!serverId || state.activeServerId !== serverId) return false;
  return scope === "workspace" ? state.activeView === "logs" && state.logsViewer === viewer : state.activeView === "docker" && state.containerLogViewer === viewer && containerLogBelongsToActiveTab();
}

export async function loadLogViewer(viewer: LogViewerState, scope: "workspace" | "container", keepBusy = true): Promise<void> {
  if (viewer.following) {
    await startLogFollowing(viewer, scope);
    return;
  }
  await loadLogSnapshot(viewer, scope, keepBusy);
}

export async function loadLogSnapshot(viewer: LogViewerState, scope: "workspace" | "container", keepBusy = true): Promise<void> {
  const serverId = state.activeServerId;
  if (!serverId || !logViewerIsCurrent(viewer, scope, serverId)) return;
  if (keepBusy) {
    viewer.status = "loading";
    state.errorMessage = "";
    render();
  }
  try {
    const nextLogs = await invokeCommand<string>("get_logs", { serverId, request: logRequest(viewer) });
    if (!logViewerIsCurrent(viewer, scope, serverId)) return;
    viewer.text = normalizeLogOutput(nextLogs);
    viewer.status = viewer.following ? "polling" : "idle";
    render();
  } catch (error) {
    if (!logViewerIsCurrent(viewer, scope, serverId)) return;
    viewer.following = false;
    viewer.status = "stopped";
    setError(error);
  }
}

export function logSourceCanStream(viewer: LogViewerState): boolean {
  return viewer.target.source !== "system" || Boolean(activeCapabilities()?.journalctl);
}

export async function setLogFollowing(viewer: LogViewerState, scope: "workspace" | "container"): Promise<void> {
  if (!viewer.following) {
    await stopLogViewer(viewer, "paused");
    render();
    return;
  }
  await startLogFollowing(viewer, scope);
}

export async function startLogFollowing(viewer: LogViewerState, scope: "workspace" | "container"): Promise<void> {
  const serverId = state.activeServerId;
  if (!serverId || !logViewerIsCurrent(viewer, scope, serverId)) return;
  await stopLogViewer(viewer, "loading");
  viewer.following = true;
  viewer.status = "loading";
  state.errorMessage = "";
  render();
  if (!logSourceCanStream(viewer)) {
    await loadLogSnapshot(viewer, scope, false);
    if (!viewer.following || !logViewerIsCurrent(viewer, scope, serverId)) return;
    viewer.status = "polling";
    render();
    clearRefreshTimer();
    state.refreshTimer = window.setInterval(() => { if (!state.activeOperation) void loadLogSnapshot(viewer, scope, false); }, 2_500);
    return;
  }
  const sessionId = crypto.randomUUID();
  viewer.streamId = sessionId;
  try {
    const request = { ...logRequest(viewer), lines: viewer.text ? 0 : viewer.lines };
    await invokeCommand<LogStreamStarted>("start_log_stream", { request: { sessionId, serverId, logs: request } });
    if (!logViewerIsCurrent(viewer, scope, serverId) || viewer.streamId !== sessionId) {
      await invoke("close_log_stream", { sessionId }).catch(() => undefined);
      return;
    }
    viewer.status = "live";
    render();
  } catch (error) {
    if (viewer.streamId === sessionId) viewer.streamId = undefined;
    viewer.following = false;
    viewer.status = "stopped";
    setError(error);
  }
}

export async function stopLogViewer(viewer: LogViewerState, status: LogViewerState["status"]): Promise<void> {
  const sessionId = viewer.streamId;
  viewer.streamId = undefined;
  viewer.status = status;
  if (sessionId) await invoke("close_log_stream", { sessionId }).catch(() => undefined);
  clearRefreshTimer();
}

export function updateLogTargetLabel(viewer: LogViewerState): void {
  const target = viewer.target;
  if (target.source === "system") target.label = target.service || (activeCapabilities()?.journalctl ? "System journal" : "Syslog buffer");
  else if (target.source === "container") target.label = target.container || "Container logs";
  else if (target.source === "file") target.label = target.filePath || "Log file";
}

export function appendLogOutput(viewer: LogViewerState, data: string, scope: "workspace" | "container"): void {
  viewer.text += normalizeLogOutput(data);
  if (viewer.text.length > 1_048_576) {
    const start = viewer.text.indexOf("\n", viewer.text.length - 1_048_576);
    viewer.text = viewer.text.slice(start >= 0 ? start + 1 : viewer.text.length - 1_048_576);
  }
  updateLogViewerDom(viewer, scope, true);
}

export function updateLogViewerDom(viewer: LogViewerState, scope: "workspace" | "container", preserveLiveEdge = false): void {
  const output = root.querySelector<HTMLElement>(`[data-log-output="${scope}"]`);
  if (output) {
    const atLiveEdge = output.scrollHeight - output.scrollTop - output.clientHeight < 48;
    output.textContent = filteredLogs(viewer);
    if (preserveLiveEdge && atLiveEdge) output.scrollTop = output.scrollHeight;
  }
  const count = root.querySelector<HTMLElement>(`[data-log-count="${scope}"]`);
  if (count) {
    const lines = countLogLines(viewer.text);
    count.textContent = `${lines} ${lines === 1 ? "line" : "lines"}`;
  }
}

export async function loadLogFileChoices(serverId: string, version: number): Promise<void> {
  try {
    const files = await invokeCommand<string[]>("get_log_files", { serverId });
    if (viewRequestIsCurrent(serverId, "logs", version) && state.logsViewer.target.source === "file") {
      state.discoveredLogFiles = files;
      if ((!state.logsViewer.target.filePath || state.logsViewer.target.filePath.endsWith("/")) && files[0]) {
        state.logsViewer.target.filePath = files[0];
        updateLogTargetLabel(state.logsViewer);
      }
    }
  } catch {
    state.discoveredLogFiles = [];
  }
}
