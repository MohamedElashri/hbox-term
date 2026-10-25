import { openRemoteEditor } from "../terminal";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { DashboardCard, DockerPage, PackagePage, Page, PortInfo, ProcessInfo, RemoteFile, ServerConnection, ServiceInfo, TransferProgress } from "../../types";
import { errorText, OperationCancelledError } from "../command-client";
import { confirm, requestTextInput } from "../modals";
import { render } from "../render";
import { cancelCurrentOperation, invokeCommand, setError } from "../session";
import { connectedServerIds, DASHBOARD_OVERVIEW_TIMEOUT_MS, dashboardSnapshots, DOCKER_PAGE_SIZE, FILE_PAGE_SIZE, platform, PORT_PAGE_SIZE, PROCESS_PAGE_SIZE, SERVICE_PAGE_SIZE, state } from "../state";
import { dismissTransferToast, syncTransferToast } from "../toasts";
import type { DashboardCardName, DashboardState, DockerSection } from "../types";
import { loadActiveView, viewRequestIsCurrent } from "../workspace";

export const dashboardCardOrder: DashboardCardName[] = ["profile", "memory", "storage", "uptime", "network", "cpu"];

export async function loadDashboard(serverId: string, version: number): Promise<void> {
  if (!state.connection) {
    const connected = await invokeCommand<ServerConnection>("connect_server", { serverId });
    if (!viewRequestIsCurrent(serverId, "dashboard", version)) return;
    state.connection = connected;
    connectedServerIds.add(serverId);
  }
  if (!viewRequestIsCurrent(serverId, "dashboard", version)) return;

  const targetDashboard: DashboardState = { errors: {}, loading: true };
  state.dashboard = targetDashboard;
  if (state.activeWorkspaceTabId) dashboardSnapshots.set(state.activeWorkspaceTabId, targetDashboard);
  if (state.viewTransition?.serverId === serverId && state.viewTransition.view === "dashboard" && state.viewTransition.version === version) {
    state.viewTransition = null;
  }
  render();

  try {
    const cards = await invokeDashboard(serverId);
    if (!viewRequestIsCurrent(serverId, "dashboard", version) || state.dashboard !== targetDashboard) return;
    for (const card of cards) applyDashboardCard(card);
  } catch (error) {
    if (error instanceof OperationCancelledError || errorText(error).toLowerCase().includes("operation cancelled")) throw error;
    if (!viewRequestIsCurrent(serverId, "dashboard", version) || state.dashboard !== targetDashboard) return;
    for (const cardName of dashboardCardOrder) targetDashboard.errors[cardName] = errorText(error);
    throw error;
  } finally {
    if (viewRequestIsCurrent(serverId, "dashboard", version) && state.dashboard === targetDashboard) {
      targetDashboard.loading = false;
      render();
    }
  }
}

export async function invokeDashboard(serverId: string): Promise<DashboardCard[]> {
  let timedOut = false;
  const request = invokeCommand<DashboardCard[]>("get_dashboard", { serverId });
  const operationId = state.activeOperation?.id;
  const timeout = window.setTimeout(() => {
    if (!operationId || state.activeOperation?.id !== operationId) return;
    timedOut = true;
    cancelCurrentOperation(operationId);
  }, DASHBOARD_OVERVIEW_TIMEOUT_MS);
  try {
    return await request;
  } catch (error) {
    if (timedOut) throw new Error("The server overview took too long to load.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function applyDashboardCard(card: DashboardCard): void {
  if (!state.dashboard) return;
  switch (card.kind) {
    case "profile": state.dashboard.profile = card.summary; break;
    case "cpu": state.dashboard.cpu = card; break;
    case "memory": state.dashboard.memory = card; break;
    case "storage": state.dashboard.storage = card; break;
    case "uptime": state.dashboard.uptime = card; break;
    case "network": state.dashboard.network = card; break;
  }
}

export async function loadFiles(expectedServerId = state.activeServerId, expectedVersion = state.navigationVersion, append = false): Promise<void> {
  if (!expectedServerId) return;
  const offset = append ? state.remoteFiles.length : 0;
  const limit = append ? FILE_PAGE_SIZE : Math.max(FILE_PAGE_SIZE, state.remoteFiles.length);
  const files = await invokeCommand<Page<RemoteFile>>("list_remote_files", { serverId: expectedServerId, request: { path: state.remotePath, showHidden: state.showHidden, offset, limit } });
  if (!viewRequestIsCurrent(expectedServerId, "files", expectedVersion)) return;
  if (append) {
    const loadedPaths = new Set(state.remoteFiles.map((file) => file.path));
    state.remoteFiles = [...state.remoteFiles, ...files.items.filter((file) => !loadedPaths.has(file.path))];
  } else {
    state.remoteFiles = files.items;
  }
  state.filesHaveMore = files.hasMore;
  render();
}

export function mergeDockerPage(next: DockerPage): void {
  const current = state.docker ?? { runtime: next.runtime, containers: [], images: [], volumes: [], networks: [] };
  switch (next.section) {
    case "containers": current.containers = next.containers; break;
    case "images": current.images = next.images; break;
    case "volumes": current.volumes = next.volumes; break;
    case "networks": current.networks = next.networks; break;
  }
  current.runtime = next.runtime;
  state.docker = current;
  state.dockerLoaded[next.section] = true;
  state.dockerHasMore[next.section] = next.hasMore;
}

export async function loadDockerSection(expand: boolean, expectedServerId = state.activeServerId, expectedVersion = state.navigationVersion): Promise<void> {
  if (!expectedServerId) return;
  const section = state.dockerTab;
  const loaded = state.docker?.[section].length ?? 0;
  const limit = expand ? loaded + DOCKER_PAGE_SIZE : Math.max(DOCKER_PAGE_SIZE, loaded);
  const next = await invokeCommand<DockerPage>("get_docker", { serverId: expectedServerId, section, offset: 0, limit });
  if (!viewRequestIsCurrent(expectedServerId, "docker", expectedVersion) || state.dockerTab !== section) return;
  mergeDockerPage(next);
  render();
}

export async function selectDockerSection(section: DockerSection): Promise<void> {
  state.dockerTab = section;
  state.errorMessage = "";
  render();
  if (state.dockerLoaded[section]) return;
  try { await loadDockerSection(false); } catch (error) { setError(error); }
}

export async function loadMoreActiveView(): Promise<void> {
  if (!state.activeServerId || state.activeOperation) return;
  const serverId = state.activeServerId;
  const view = state.activeView;
  const version = state.navigationVersion;
  try {
    switch (view) {
      case "processes": {
        const next = await invokeCommand<Page<ProcessInfo>>("get_processes", { serverId, offset: 0, limit: state.processes.length + PROCESS_PAGE_SIZE });
        if (!viewRequestIsCurrent(serverId, view, version)) return;
        state.processes = next.items; state.processesHasMore = next.hasMore; break;
      }
      case "services": {
        const next = await invokeCommand<Page<ServiceInfo>>("get_services", { serverId, offset: 0, limit: state.services.length + SERVICE_PAGE_SIZE });
        if (!viewRequestIsCurrent(serverId, view, version)) return;
        state.services = next.items; state.servicesHasMore = next.hasMore; break;
      }
      case "files": await loadFiles(serverId, version, true); return;
      case "docker": await loadDockerSection(true, serverId, version); return;
      case "network": {
        const next = await invokeCommand<Page<PortInfo>>("get_ports", { serverId, offset: 0, limit: state.ports.length + PORT_PAGE_SIZE });
        if (!viewRequestIsCurrent(serverId, view, version)) return;
        state.ports = next.items; state.portsHaveMore = next.hasMore; break;
      }
      case "packages": {
        const loaded = state.packagePage?.packages.items.length ?? 0;
        const next = await invokeCommand<PackagePage>("get_packages", { serverId, query: state.packageQuery, upgradesOnly: state.packageUpgradesOnly, offset: 0, limit: loaded + 100 });
        if (!viewRequestIsCurrent(serverId, view, version)) return;
        state.packagePage = next; break;
      }
      default: return;
    }
    render();
  } catch (error) { setError(error); }
}

export async function navigateFiles(path: string): Promise<void> {
  state.remotePath = path || "/"; state.remoteFileSearch = ""; state.remoteFiles = []; state.filesHaveMore = false; await loadActiveView(true);
}

export async function openEditor(path: string): Promise<void> {
  if (!state.activeServerId) return;
  const serverId = state.activeServerId;
  const version = state.navigationVersion;
  render();
  try {
    const content = await invokeCommand<string>("read_remote_file", { serverId, path });
    if (state.activeServerId !== serverId || state.activeView !== "files" || state.navigationVersion !== version) return;
    state.editorPath = path; state.editorContent = content; state.editorDirty = false; state.modal = "editor"; render();
  } catch (error) { setError(error); }
}

export async function saveEditorForm(form: HTMLFormElement): Promise<void> {
  if (!state.activeServerId) return;
  const content = String(new FormData(form).get("content") ?? state.editorContent);
  try {
    await invokeCommand("write_remote_file", { serverId: state.activeServerId, path: state.editorPath, content });
    state.editorContent = content; state.editorDirty = false; state.modal = null; await loadFiles();
  } catch (error) { setError(error); }
}

export async function createFolder(form: HTMLFormElement): Promise<void> {
  if (!state.activeServerId) return;
  const name = String(new FormData(form).get("name") ?? "").trim();
  if (!/^[^/]+$/.test(name)) { state.errorMessage = "Folder name cannot contain a slash."; render(); return; }
  try {
    const path = `${state.remotePath.replace(/\/$/, "")}/${name}` || `/${name}`;
    await invokeCommand("remote_file_action", { serverId: state.activeServerId, action: "mkdir", path }); state.modal = null; await loadFiles();
  } catch (error) { setError(error); }
}

export async function deleteRemote(path: string): Promise<void> {
  if (!state.activeServerId) return;
  const file = state.remoteFiles.find((item) => item.path === path);
  if (!await confirm(`Delete ${file?.name ?? path}? This cannot be undone remotely.`, { title: "Delete remote item", kind: "warning" })) return;
  try { await invokeCommand("remote_file_action", { serverId: state.activeServerId, action: "delete", path }); await loadFiles(); } catch (error) { setError(error); }
}

export async function changeRemoteMode(path: string): Promise<void> {
  if (!state.activeServerId) return;
  const mode = await requestTextInput({ title: "Change permissions", label: "Permissions in octal", defaultValue: "644" });
  if (!mode) return;
  try { await invokeCommand("remote_file_action", { serverId: state.activeServerId, action: "chmod", path, mode }); await loadFiles(); } catch (error) { setError(error); }
}

export async function changeRemoteOwner(path: string): Promise<void> {
  if (!state.activeServerId) return;
  const file = state.remoteFiles.find((item) => item.path === path);
  const owner = await requestTextInput({ title: "Change owner", label: "Owner as uid:gid", defaultValue: `${file?.uid ?? "0"}:${file?.gid ?? "0"}` });
  if (!owner) return;
  try { await invokeCommand("remote_file_action", { serverId: state.activeServerId, action: "chown", path, target: owner }); await loadFiles(); } catch (error) { setError(error); }
}

export async function uploadLocalPathFallback(kind: "file" | "folder"): Promise<string[] | null> {
  const selected = await requestTextInput(kind === "file"
    ? { title: "Upload a local file", label: "Absolute local file path", defaultValue: "", placeholder: platform === "windows" ? "C:\\Users\\name\\Desktop\\archive.tar.gz" : "~/Desktop/archive.tar.gz" }
    : { title: "Upload a local folder", label: "Absolute local folder path", defaultValue: "", placeholder: platform === "windows" ? "C:\\Users\\name\\Desktop\\project" : "~/Desktop/project" });
  if (!selected?.trim()) return null;
  return [selected.trim()];
}

export async function uploadLocal(): Promise<void> {
  if (!state.activeServerId) return;
  let selected: string[] | null = null;
  try {
    const picked = await open({ multiple: true, directory: false });
    if (picked === null) return;
    selected = Array.isArray(picked) ? picked : [picked];
  } catch {
    selected = await uploadLocalPathFallback("file");
  }
  if (!selected) return;
  for (const path of selected) await transferUpload(path);
}

export async function uploadLocalFolder(): Promise<void> {
  if (!state.activeServerId) return;
  let selected: string[] | null = null;
  try {
    const picked = await open({ multiple: false, directory: true });
    if (picked === null) return;
    selected = Array.isArray(picked) ? picked : [picked];
  } catch {
    selected = await uploadLocalPathFallback("folder");
  }
  if (!selected) return;
  for (const path of selected) await transferUpload(path);
}

/** Uploads into the Files view's directory, or into `remotePath` (e.g. a terminal pane's directory). */
export async function transferUpload(localPath: string, remotePath = state.remotePath, serverId = state.activeServerId): Promise<void> {
  if (!serverId) return;
  const refresh = async () => { if (state.activeView === "files" && serverId === state.activeServerId) await loadFiles(); };
  state.transfer = { transferId: "pending", direction: "upload", path: localPath, completedBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0, done: false };
  syncTransferToast();
  try {
    state.transfer = await invokeCommand<TransferProgress>("upload_path", { serverId, localPath, remotePath, overwrite: false });
    await refresh();
  } catch (error) {
    const conflict = error !== null && typeof error === "object" && (error as { kind?: unknown }).kind === "uploadConflict"
      ? error as { paths?: unknown; count?: unknown }
      : null;
    if (conflict) {
      const paths = Array.isArray(conflict.paths) ? conflict.paths.filter((path): path is string => typeof path === "string") : [];
      const count = typeof conflict.count === "number" ? conflict.count : paths.length;
      const listed = paths.map((path) => `• ${path}`).join("\n");
      const remaining = count > paths.length ? `\n…and ${count - paths.length} more.` : "";
      if (await confirm(`${count} remote ${count === 1 ? "file already exists" : "files already exist"}. Replace ${count === 1 ? "it" : "them"}?\n${listed}${remaining}`, { title: "Replace remote files?", kind: "warning" })) {
        try {
          state.transfer = await invokeCommand<TransferProgress>("upload_path", { serverId, localPath, remotePath, overwrite: true });
          await refresh();
        } catch (retryError) {
          state.transfer = { ...state.transfer, done: true, error: errorText(retryError) };
          setError(retryError);
        }
      } else {
        state.transfer = null;
      }
    } else {
      state.transfer = { ...state.transfer, done: true, error: errorText(error) };
      setError(error);
    }
  }
  if (state.transfer?.done) {
    syncTransferToast();
    dismissTransferToast(state.transfer.transferId);
  }
}

export async function downloadRemote(path: string): Promise<void> {
  if (!state.activeServerId) return;
  const file = state.remoteFiles.find((item) => item.path === path);
  const directory = file?.kind === "directory";
  let localPath: string | null = null;
  try {
    if (directory) {
      const picked = await open({ multiple: false, directory: true });
      if (picked === null) return;
      localPath = Array.isArray(picked) ? picked[0] ?? null : picked;
    } else {
      localPath = await save({ defaultPath: file?.name ?? "download" });
      if (localPath === null) return;
    }
  } catch {
    localPath = await requestTextInput({
      title: directory ? "Download remote folder" : "Download remote file",
      label: directory ? "Local destination folder" : "Local destination file",
      defaultValue: directory ? "~/Downloads" : `~/Downloads/${file?.name ?? "download"}`,
      placeholder: platform === "windows" ? "C:\\Users\\name\\Downloads" : "~/Downloads",
    });
  }
  if (!localPath?.trim()) return;
  try {
    state.transfer = await invokeCommand<TransferProgress>("download_path", { serverId: state.activeServerId, remotePath: path, localPath: localPath.trim() });
    syncTransferToast();
    dismissTransferToast(state.transfer.transferId);
  } catch (error) { setError(error); }
}

export function cancelTransfer(): void {
  if (!state.transfer || state.transfer.done) return;
  cancelCurrentOperation();
}

/** Opens a remote file in the local editor; saves are uploaded (src-tauri/src/remote_edit.rs). */
export async function editInLocalEditor(path: string): Promise<void> {
  if (!state.activeServerId) return;
  try {
    const opened = await invokeCommand<{ id: string; localPath: string; command: string }>("start_remote_edit", {
      serverId: state.activeServerId, path, editor: state.terminalConfig.config.editor,
    });
    await openRemoteEditor(opened.command, `✎ ${path.split("/").pop() || path}`, opened.id);
  } catch (error) {
    setError(error);
  }
}

