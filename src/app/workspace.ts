import { invoke } from "@tauri-apps/api/core";
import type { AccountSnapshot, AppStateSnapshot, AuthorizedKey, CommandResult, ComposeProject, CronJob, DiskExplorerSnapshot, FirewallSnapshot, PackagePage, Page, PortInfo, ProcessInfo, SavedCommand, SecuritySnapshot, ServiceInfo, TunnelConfig, TunnelStatus } from "../types";
import { ensureDockerContainersForLogs } from "./actions/containers";
import { loadLogFileChoices, loadLogViewer, stopLogViewer, updateLogTargetLabel } from "./actions/logs";
import { loadDashboard, loadDockerSection, loadFiles } from "./actions/remote";
import { errorText, OperationCancelledError } from "./command-client";
import { render } from "./render";
import { cancelCurrentOperation, invokeCommand, setError } from "./session";
import { activeCapabilities, activeTerminalTabByWorkspace, activeTerminalTabs, activeWorkspaceTab, connectedServerIds, isLocalWorkspace, LOCAL_SERVER_ID, LOCAL_WORKSPACE_ID, createLogViewer, dashboardSnapshots, PORT_PAGE_SIZE, PROCESS_PAGE_SIZE, root, serverTabViews, SERVICE_PAGE_SIZE, state } from "./state";
import { disposeTerminalSurfaces, openNewTerminal } from "./terminal";
import type { View } from "./types";

export function clearRefreshTimer(): void {
  if (state.refreshTimer !== undefined) window.clearInterval(state.refreshTimer);
  state.refreshTimer = undefined;
}

export function resetPaginationState(): void {
  state.processesHasMore = false;
  state.servicesHasMore = false;
  state.filesHaveMore = false;
  state.portsHaveMore = false;
  state.dockerLoaded = { containers: false, images: false, volumes: false, networks: false };
  state.dockerHasMore = { containers: false, images: false, volumes: false, networks: false };
}

export function clearContainerLogs(): void {
  if (state.containerLogViewer?.streamId) void invoke("close_log_stream", { sessionId: state.containerLogViewer.streamId }).catch(() => undefined);
  state.containerLogViewer = null;
  state.shouldScrollToContainerLogs = false;
}

export function viewRequestIsCurrent(serverId: string, view: View, version: number): boolean {
  return state.activeServerId === serverId && state.activeView === view && state.navigationVersion === version;
}

export function viewTransitionIsCurrent(): boolean {
  return Boolean(state.viewTransition && viewRequestIsCurrent(state.viewTransition.serverId, state.viewTransition.view, state.viewTransition.version));
}

export function shortId(value: string): string { return value.slice(0, 12); }

export function scrollPanelIntoView(selector: string): boolean {
  const content = root.querySelector<HTMLElement>(".content-area");
  const panel = root.querySelector<HTMLElement>(selector);
  if (!content || !panel) return false;
  const contentRect = content.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const targetTop = content.scrollTop + panelRect.top - contentRect.top - 18;
  content.scrollTo({
    top: Math.max(0, targetTop),
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
  return true;
}

export function scrollContainerLogsIntoView(): boolean { return scrollPanelIntoView(".container-log-panel"); }

export function scrollCommandResultsIntoView(): boolean { return scrollPanelIntoView("[data-command-results]"); }

export function setCommandResults(results: CommandResult[], focus = true): void {
  state.commandResults = results;
  state.shouldScrollToCommandResults = focus && results.length > 0;
}

export function clearCommandResults(): void {
  state.commandResults = [];
  state.shouldScrollToCommandResults = false;
}

export async function selectServer(serverId: string, openAnother = false): Promise<void> {
  const tab = (!openAnother ? state.openServerTabs.find((item) => item.serverId === serverId) : undefined)
    ?? { id: crypto.randomUUID(), serverId };
  if (!state.openServerTabs.includes(tab)) state.openServerTabs.push(tab);
  await selectWorkspaceTab(tab.id);
}

async function leaveActiveWorkspace(): Promise<void> {
  cancelCurrentOperation();
  if (state.logsViewer.streamId) await stopLogViewer(state.logsViewer, "paused");
  if (state.containerLogViewer?.streamId) await stopLogViewer(state.containerLogViewer, "paused");
  if (state.activeWorkspaceTabId) {
    if (state.dashboard) dashboardSnapshots.set(state.activeWorkspaceTabId, state.dashboard);
    serverTabViews.set(state.activeWorkspaceTabId, state.activeView);
    if (state.activeTerminalTabId) activeTerminalTabByWorkspace.set(state.activeWorkspaceTabId, state.activeTerminalTabId);
  }
}

/** Switches to the local workspace, starting a shell if none is open. */
export async function selectLocalWorkspace(): Promise<void> {
  if (!isLocalWorkspace()) {
    await leaveActiveWorkspace();
    clearRefreshTimer();
    state.activeWorkspaceTabId = LOCAL_WORKSPACE_ID;
    state.activeServerId = null;
    state.connection = null;
    state.dashboard = null;
    state.viewTransition = null;
  }
  state.activeView = "terminal";
  const savedTerminalId = activeTerminalTabByWorkspace.get(LOCAL_WORKSPACE_ID);
  state.activeTerminalTabId = savedTerminalId && activeTerminalTabs().some((tab) => tab.id === savedTerminalId)
    ? savedTerminalId
    : activeTerminalTabs().at(-1)?.id ?? null;
  if (!activeTerminalTabs().length) await openNewTerminal();
  else render();
}

export async function selectWorkspaceTab(workspaceTabId: string): Promise<void> {
  if (workspaceTabId === LOCAL_WORKSPACE_ID) return selectLocalWorkspace();
  const nextTab = state.openServerTabs.find((tab) => tab.id === workspaceTabId);
  if (!nextTab) return;
  await leaveActiveWorkspace();
  state.activeWorkspaceTabId = workspaceTabId;
  state.activeServerId = nextTab.serverId;
  state.activeView = serverTabViews.get(workspaceTabId) ?? "dashboard";
  const savedTerminalId = activeTerminalTabByWorkspace.get(workspaceTabId);
  state.activeTerminalTabId = savedTerminalId && state.terminalTabs.some((tab) => tab.id === savedTerminalId && tab.workspaceTabId === workspaceTabId)
    ? savedTerminalId
    : activeTerminalTabs().at(-1)?.id ?? null;
  state.connection = null;
  state.dashboard = dashboardSnapshots.get(workspaceTabId) ?? null;
  state.processes = [];
  state.services = [];
  state.docker = null;
  state.composeProjects = [];
  state.composeProjectsServerId = null;
  state.ports = [];
  state.cronJobs = [];
  state.packagePage = null;
  state.accounts = null;
  state.remoteFiles = [];
  state.logsViewer = createLogViewer({ source: "system", label: "System logs" }, 100);
  clearContainerLogs();
  resetPaginationState();
  state.viewTransition = null;
  clearRefreshTimer();
  await setView(state.activeView);
}

/** Closes SSH terminals for one server, or for every server. Local shells are left open. */
export async function closeInteractiveSessions(serverId?: string): Promise<void> {
  const closingTabs = state.terminalTabs.filter((tab) => serverId ? tab.serverId === serverId : tab.serverId !== LOCAL_SERVER_ID);
  for (const tab of closingTabs) {
    if (tab.sessionId) await invoke("close_terminal", { sessionId: tab.sessionId }).catch(() => undefined);
  }
  state.terminalTabs = state.terminalTabs.filter((tab) => !closingTabs.includes(tab));
  if (!isLocalWorkspace() && (!serverId || state.activeServerId === serverId)) state.activeTerminalTabId = null;
  for (const tab of state.openServerTabs.filter((item) => !serverId || item.serverId === serverId)) activeTerminalTabByWorkspace.delete(tab.id);
  disposeTerminalSurfaces(closingTabs);
}

export async function closeWorkspaceInteractiveSessions(workspaceTabId: string): Promise<void> {
  const closingTabs = state.terminalTabs.filter((tab) => tab.workspaceTabId === workspaceTabId);
  for (const tab of closingTabs) {
    if (tab.sessionId) await invoke("close_terminal", { sessionId: tab.sessionId }).catch(() => undefined);
  }
  state.terminalTabs = state.terminalTabs.filter((tab) => tab.workspaceTabId !== workspaceTabId);
  activeTerminalTabByWorkspace.delete(workspaceTabId);
  if (state.activeWorkspaceTabId === workspaceTabId) state.activeTerminalTabId = null;
  disposeTerminalSurfaces(closingTabs);
}

export async function closeWorkspaceTab(workspaceTabId: string): Promise<void> {
  const tabIndex = state.openServerTabs.findIndex((tab) => tab.id === workspaceTabId);
  if (tabIndex < 0) return;
  const closingTab = state.openServerTabs[tabIndex];
  if (state.activeWorkspaceTabId === workspaceTabId) cancelCurrentOperation();
  await closeWorkspaceInteractiveSessions(workspaceTabId);
  serverTabViews.delete(workspaceTabId);
  dashboardSnapshots.delete(workspaceTabId);
  state.openServerTabs = state.openServerTabs.filter((tab) => tab.id !== workspaceTabId);
  if (!state.openServerTabs.some((tab) => tab.serverId === closingTab.serverId)) {
    await invoke("disconnect_server", { serverId: closingTab.serverId }).catch(() => undefined);
    connectedServerIds.delete(closingTab.serverId);
  }
  if (state.activeWorkspaceTabId !== workspaceTabId) { render(); return; }
  const nextTab = state.openServerTabs[Math.min(tabIndex, state.openServerTabs.length - 1)] ?? null;
  state.activeWorkspaceTabId = null;
  state.activeServerId = null;
  state.connection = null;
  await selectWorkspaceTab(nextTab?.id ?? LOCAL_WORKSPACE_ID);
}

export async function refreshSnapshot(loadView = true): Promise<void> {
  state.snapshot = await invokeCommand<AppStateSnapshot>("get_state");
  const activeTabIndex = state.activeWorkspaceTabId ? state.openServerTabs.findIndex((tab) => tab.id === state.activeWorkspaceTabId) : -1;
  state.openServerTabs = state.openServerTabs.filter((tab) => state.snapshot.servers.some((server) => server.id === tab.serverId));
  if (state.activeServerId && !state.snapshot.servers.some((server) => server.id === state.activeServerId)) {
    const nextTab = state.openServerTabs[Math.min(Math.max(activeTabIndex, 0), state.openServerTabs.length - 1)] ?? null;
    state.activeWorkspaceTabId = nextTab?.id ?? null;
    state.activeServerId = nextTab?.serverId ?? null;
    if (!nextTab) { await selectLocalWorkspace(); return; }
  }
  if (state.activeServerId && !activeWorkspaceTab()) {
    const tab = { id: crypto.randomUUID(), serverId: state.activeServerId };
    state.openServerTabs.push(tab);
    state.activeWorkspaceTabId = tab.id;
  }
  if (loadView && state.activeServerId) await loadActiveView();
}

export async function setView(view: View): Promise<void> {
  if (!state.activeServerId) return;
  cancelCurrentOperation();
  state.navigationVersion += 1;
  if (state.activeView !== view) clearCommandResults();
  if (state.activeView === "logs" && view !== "logs") {
    state.logsViewer.following = false;
    await stopLogViewer(state.logsViewer, "paused");
  }
  if (state.activeView === "docker" && view !== "docker") clearContainerLogs();
  state.activeView = view;
  if (state.activeWorkspaceTabId) serverTabViews.set(state.activeWorkspaceTabId, view);
  state.errorMessage = "";
  clearRefreshTimer();
  const reuseDashboardSnapshot = view === "dashboard" && state.dashboard !== null;
  const reuseContainerSnapshot = view === "docker" && (state.containerPlatformTab === "compose"
    ? state.composeProjectsServerId === state.activeServerId
    : state.dockerLoaded[state.dockerTab]);
  state.viewTransition = view === "terminal" || reuseDashboardSnapshot || reuseContainerSnapshot ? null : { serverId: state.activeServerId, view, version: state.navigationVersion };
  render();
  if (view === "terminal") {
    if (!activeTerminalTabs().length) await openNewTerminal();
    return;
  }
  await loadActiveView(!reuseDashboardSnapshot && !reuseContainerSnapshot);
}

export async function loadActiveView(showTransition = false, forceRefresh = false): Promise<void> {
  if (!state.activeServerId || state.activeView === "terminal") { render(); return; }
  const serverId = state.activeServerId;
  const view = state.activeView;
  const version = state.navigationVersion;
  if (showTransition) state.viewTransition = { serverId, view, version };
  state.errorMessage = ""; clearRefreshTimer(); render();
  try {
    switch (view) {
      case "dashboard": {
        if (!state.dashboard || forceRefresh) await loadDashboard(serverId, version);
        if (!viewRequestIsCurrent(serverId, view, version)) return;
        break;
      }
      case "processes": {
        const nextProcesses = await invokeCommand<Page<ProcessInfo>>("get_processes", { serverId, offset: 0, limit: Math.max(PROCESS_PAGE_SIZE, state.processes.length) });
        if (!viewRequestIsCurrent(serverId, view, version)) return;
        state.processes = nextProcesses.items; state.processesHasMore = nextProcesses.hasMore; state.refreshTimer = window.setInterval(() => { if (!state.activeOperation) void loadActiveView(); }, 5_000); break;
      }
      case "services": {
        const nextServices = await invokeCommand<Page<ServiceInfo>>("get_services", { serverId, offset: 0, limit: Math.max(SERVICE_PAGE_SIZE, state.services.length) });
        if (!viewRequestIsCurrent(serverId, view, version)) return;
        state.services = nextServices.items; state.servicesHasMore = nextServices.hasMore; break;
      }
      case "disk": {
        const nextSnapshot = await invokeCommand<DiskExplorerSnapshot>("get_disk_snapshot", { serverId });
        if (!viewRequestIsCurrent(serverId, view, version)) return;
        state.diskSnapshot = nextSnapshot;
        if (!nextSnapshot.dockerUsage && state.diskTab === "docker") state.diskTab = "mounts";
        state.diskVarLog = null;
        state.diskVarLogLoading = false;
        break;
      }
      case "files": await loadFiles(serverId, version); break;
      case "docker": {
        if (state.containerPlatformTab === "compose" && (forceRefresh || state.composeProjectsServerId !== serverId)) {
          state.composeProjects = await invokeCommand<ComposeProject[]>("get_compose_projects", { serverId });
          state.composeProjectsServerId = serverId;
        }
        else if (state.containerPlatformTab === "runtime" && (forceRefresh || !state.dockerLoaded[state.dockerTab])) {
          await loadDockerSection(false, serverId, version);
        }
        if (!viewRequestIsCurrent(serverId, view, version)) return;
        break;
      }
      case "logs": {
        const capabilities = activeCapabilities();
        if (state.logsViewer.target.source === "system" && !capabilities?.journalctl && !capabilities?.logread) {
          state.logsViewer = createLogViewer({ source: "file", label: "/var/log/", filePath: "/var/log/" }, state.logsViewer.lines);
        }
        updateLogTargetLabel(state.logsViewer);
        if (state.logsViewer.target.source === "container" || (state.logsViewer.target.source === "file" && Boolean(capabilities?.docker || capabilities?.podman))) {
          await ensureDockerContainersForLogs(serverId, version);
        }
        if (state.logsViewer.target.source === "file") await loadLogFileChoices(serverId, version);
        if (!viewRequestIsCurrent(serverId, view, version)) return;
        await loadLogViewer(state.logsViewer, "workspace", false);
        break;
      }
      case "network": {
        const nextPorts = await invokeCommand<Page<PortInfo>>("get_ports", { serverId, offset: 0, limit: Math.max(PORT_PAGE_SIZE, state.ports.length) });
        if (!viewRequestIsCurrent(serverId, view, version)) return;
        state.ports = nextPorts.items; state.portsHaveMore = nextPorts.hasMore; state.refreshTimer = window.setInterval(() => { if (!state.activeOperation) void loadActiveView(); }, 8_000); break;
      }
      case "cron": {
        const next = await invokeCommand<CronJob[]>("get_cron_jobs", { serverId });
        if (!viewRequestIsCurrent(serverId, view, version)) return;
        state.cronJobs = next; break;
      }
      case "packages": {
        const next = await invokeCommand<PackagePage>("get_packages", { serverId, query: state.packageQuery, upgradesOnly: state.packageUpgradesOnly, offset: 0, limit: Math.max(100, state.packagePage?.packages.items.length ?? 0) });
        if (!viewRequestIsCurrent(serverId, view, version)) return;
        state.packagePage = next; break;
      }
      case "accounts": {
        const next = await invokeCommand<AccountSnapshot>("get_accounts", { serverId });
        if (!viewRequestIsCurrent(serverId, view, version)) return;
        state.accounts = next; break;
      }
      case "administration": await loadAdministrationTab(serverId, version); break;
      case "commands": {
        const nextCommands = await invokeCommand<SavedCommand[]>("get_saved_commands", { serverId });
        if (!viewRequestIsCurrent(serverId, view, version)) return;
        state.savedCommands = nextCommands;
        break;
      }
      case "tunnels": {
        state.tunnels = await invokeCommand<TunnelConfig[]>("get_tunnels", { serverId });
        state.tunnelStatuses = await invokeCommand<TunnelStatus[]>("get_tunnel_statuses", { serverId });
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof OperationCancelledError) && !errorText(error).toLowerCase().includes("operation cancelled") && viewRequestIsCurrent(serverId, view, version)) {
      state.errorMessage = errorText(error);
    }
  } finally {
    if (state.viewTransition?.serverId === serverId && state.viewTransition.view === view && state.viewTransition.version === version) state.viewTransition = null;
    if (viewRequestIsCurrent(serverId, view, version)) render();
  }
}

export async function loadAdministrationTab(expectedServerId = state.activeServerId, expectedVersion = state.navigationVersion): Promise<void> {
  if (!expectedServerId) return;
  try {
    if (state.administrationTab === "firewall") state.firewallSnapshot = await invokeCommand<FirewallSnapshot>("get_firewall", { serverId: expectedServerId });
    else if (state.administrationTab === "keys") state.authorizedKeys = await invokeCommand<AuthorizedKey[]>("get_authorized_keys", { serverId: expectedServerId });
    else if (state.administrationTab === "security") state.securitySnapshot = await invokeCommand<SecuritySnapshot>("get_security_snapshot", { serverId: expectedServerId });
    if (viewRequestIsCurrent(expectedServerId, "administration", expectedVersion)) render();
  } catch (error) { if (viewRequestIsCurrent(expectedServerId, "administration", expectedVersion)) setError(error); }
}
