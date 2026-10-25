import { icon } from "../icons";
import type { ServerProfile } from "../types";
import { escapeHtml } from "./format";
import { profileRouteLabel, renderAppDialog, renderModal } from "./modals";
import { enhanceSelects } from "./select-controls";
import { activeCapabilities, activeDock, activeServer, activeServerIsConnected, activeTerminalGroup, activeTerminalGroups, connectedServerIds, dockShown, hasInteractiveSession, isLocalWorkspace, platform, quickMode, root, sidebarScrollPositions, state, viewScrollPositions } from "./state";
import { renderEmptyWorkspaceView, renderErrorView, renderInlineErrorView, renderLoadingView, renderTitlebarView, renderWelcomeView } from "./static-views";
import { groupTitle, mountTerminal } from "./terminal";
import { renderAppToast, renderTransferToast } from "./toasts";
import type { View, WorkspaceTab } from "./types";
import { renderAccounts, renderAdministration, renderCommands, renderCron, renderNetwork, renderPackages, renderTunnels } from "./views/admin";
import { renderDisk } from "./views/disk";
import { renderDocker } from "./views/docker";
import { renderLogs } from "./views/logs";
import { groupExited, paneCount, renderDashboard, renderTabStrip, renderFiles, renderProcesses, renderServices, renderTerminal } from "./views/system";
import { scrollCommandResultsIntoView, scrollContainerLogsIntoView, viewTransitionIsCurrent } from "./workspace";

export function render(): void {
  const previousContent = root.querySelector<HTMLElement>(".dock-main") ?? root.querySelector<HTMLElement>(".content-area");
  const previousServerList = root.querySelector<HTMLElement>(".server-list");
  const previousNavigation = root.querySelector<HTMLElement>(".nav-section");
  if (previousContent && state.renderedLocation) viewScrollPositions.set(state.renderedLocation, previousContent.scrollTop);
  if (previousServerList) sidebarScrollPositions.servers = previousServerList.scrollTop;
  if (previousNavigation) sidebarScrollPositions.navigation = previousNavigation.scrollTop;
  const nextLocation = state.activeWorkspaceTabId ? `${state.activeWorkspaceTabId}:${state.activeView}` : "welcome";
  root.dataset.theme = state.darkMode ? "dark" : "light";
  root.innerHTML = quickMode ? renderQuickShell() : `${renderTitlebar()}${state.loading ? renderLoading() : renderShell()}`;
  const nextContent = root.querySelector<HTMLElement>(".dock-main") ?? root.querySelector<HTMLElement>(".content-area");
  const nextServerList = root.querySelector<HTMLElement>(".server-list");
  const nextNavigation = root.querySelector<HTMLElement>(".nav-section");
  if (nextContent) nextContent.scrollTop = viewScrollPositions.get(nextLocation) ?? 0;
  if (nextServerList) nextServerList.scrollTop = sidebarScrollPositions.servers;
  if (nextNavigation) nextNavigation.scrollTop = sidebarScrollPositions.navigation;
  if (state.shouldScrollToContainerLogs && nextContent) {
    window.setTimeout(() => {
      if (scrollContainerLogsIntoView()) state.shouldScrollToContainerLogs = false;
    }, 0);
  }
  if (state.shouldScrollToCommandResults && nextContent) {
    window.setTimeout(() => {
      if (scrollCommandResultsIntoView()) state.shouldScrollToCommandResults = false;
    }, 0);
  }
  enhanceSelects(root);
  state.renderedLocation = nextLocation;
  mountTerminal();
}

function activeGroupTitle(): string | undefined {
  const group = activeTerminalGroup();
  return group ? groupTitle(group) : undefined;
}

export function renderTitlebar(): string {
  const server = activeServer();
  const context = isLocalWorkspace()
    ? { title: "Local", detail: activeGroupTitle() ?? "shell" }
    : server ? { title: server.name, detail: server.host } : undefined;
  return renderTitlebarView({ platform, context });
}

export function renderLoading(): string {
  return renderLoadingView();
}

/** The quick terminal window: just the local terminal, plus dialogs and toasts. */
function renderQuickShell(): string {
  return `<div class="quick-shell"><section class="content-area content-area-local">${state.loading ? "" : renderTerminal()}</section></div>${state.appDialogPrompt ? renderAppDialog() : ""}${state.appToast ? renderAppToast() : ""}`;
}

export function renderShell(): string {
  return `<div class="app-shell ${isLocalWorkspace() ? "no-sidebar" : ""}">
    ${renderServerRail()}
    ${isLocalWorkspace() ? "" : renderSidebar()}
    <main class="main-area">
      ${renderTabBar()}
      ${isLocalWorkspace()
        ? `<section class="content-area content-area-local">${renderTerminal()}</section>`
        : dockShown()
          ? `<section class="content-area content-area-docked">${renderDockLayout()}</section>`
          : `<section class="content-area">${state.activeServerId ? renderConnectedContent() : state.snapshot.servers.length ? renderEmptyWorkspace() : renderWelcome()}</section>`}
    </main>
  </div>${renderOperationBanner()}${state.modal ? renderModal() : ""}${state.appDialogPrompt ? renderAppDialog() : ""}${state.transfer && !state.transfer.done ? renderTransferToast() : ""}${state.appToast ? renderAppToast() : ""}`;
}

export function renderOperationBanner(): string {
  if (!state.activeOperation) return "";
  const server = state.activeOperation.serverId ? state.snapshot.servers.find((item) => item.id === state.activeOperation?.serverId) : activeServer();
  return `<div class="operation-banner" role="status" aria-live="polite"><span class="operation-spinner"></span><div class="operation-copy"><strong>${escapeHtml(state.activeOperation.label)}</strong><span>${escapeHtml(server?.host ? `SSH can take a moment on ${server.host}. Your workspace is still available.` : "Your workspace is still available while this finishes.")}</span></div><button class="operation-cancel" data-action="cancel-operation">Cancel</button></div>`;
}

export function filteredServers(): ServerProfile[] {
  const query = state.serverQuery.trim().toLowerCase();
  const servers = state.snapshot.servers.filter((server) => `${server.name} ${server.host} ${server.groupName ?? ""} ${server.tags.join(" ")} ${server.notes}`.toLowerCase().includes(query)).sort((left, right) => {
    if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
    const recent = (right.lastConnectedAt ?? "").localeCompare(left.lastConnectedAt ?? "");
    return recent || left.name.localeCompare(right.name);
  });
  if (state.sidebarCopyPlacement) {
    const sourceIndex = servers.findIndex((server) => server.id === state.sidebarCopyPlacement?.sourceId);
    const copyIndex = servers.findIndex((server) => server.id === state.sidebarCopyPlacement?.copyId);
    if (sourceIndex >= 0 && copyIndex >= 0 && groupKey(servers[sourceIndex].groupName) === groupKey(servers[copyIndex].groupName)) {
      const [copy] = servers.splice(copyIndex, 1);
      servers.splice(copyIndex < sourceIndex ? sourceIndex : sourceIndex + 1, 0, copy);
    }
  }
  return servers;
}

export function normalizedGroupName(groupName?: string): string {
  return groupName?.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/gu, "").trim().replace(/\s+/gu, " ") ?? "";
}

export function groupKey(groupName?: string): string {
  return (normalizedGroupName(groupName) || "Ungrouped").toLocaleLowerCase();
}

export function renderServerGroups(servers: ServerProfile[]): string {
  const grouped = new Map<string, { label: string; servers: ServerProfile[] }>();
  for (const server of servers) {
    const label = normalizedGroupName(server.groupName) || "Ungrouped";
    const key = groupKey(label);
    const group = grouped.get(key) ?? { label, servers: [] };
    group.servers.push(server);
    grouped.set(key, group);
  }
  return [...grouped.values()].map(({ label, servers: items }) => `<div class="server-group"><div class="server-group-label"><span class="group-label-full">${escapeHtml(label)}</span><span class="group-label-short" aria-hidden="true">${escapeHtml(shortGroupLabel(label))}</span></div>${items.map(renderServerItem).join("")}</div>`).join("");
}

export function shortGroupLabel(group: string): string {
  return group.length <= 4 ? group : `${group.slice(0, 4)}...`;
}

export function renderServerRail(): string {
  const servers = filteredServers();
  const query = state.serverQuery.trim().toLowerCase();
  return `<aside class="server-rail" aria-label="Servers">
    <div class="server-rail-flyout">
      <div class="rail-brand"><span class="brand-mark">${icon("logo")}</span><span class="rail-brand-name">hbox-term</span></div>
      <div class="sidebar-section server-section">
        <div class="section-label-row"><span class="section-label">Servers</span></div>
        <label class="sidebar-search"><span>${icon("search")}</span><input data-field="server-search" value="${escapeHtml(state.serverQuery)}" placeholder="Search servers…" aria-label="Search servers and notes"/><kbd>⌘ K</kbd></label>
        <div class="server-list">
          ${servers.length ? renderServerGroups(servers) : `<div class="server-empty">${query ? "No matching servers" : "No servers saved yet"}</div>`}
        </div>
      </div>
      <div class="rail-utilities">
        <button class="icon-button" data-action="credential-settings" aria-label="Settings" title="Settings">${icon("settings")}</button>
        <button class="icon-button" data-action="theme" aria-label="${state.darkMode ? "Switch to light appearance" : "Switch to dark appearance"}" title="${state.darkMode ? "Switch to light appearance" : "Switch to dark appearance"}">${icon(state.darkMode ? "sun" : "moon")}</button>
      </div>
      <div class="server-rail-foot">
        <button class="icon-button" data-action="add-server" aria-label="Add server" title="Add server">${icon("plus")}</button>
        <span class="rail-foot-label">New server</span>
      </div>
    </div>
  </aside>`;
}

export function renderSidebar(): string {
  const nav = [
    ["dashboard", "Overview", "dashboard"],
    ["terminal", "Terminal", "terminal"],
    ["processes", "Processes", "processes"],
    ["services", "Systemd services", "services"],
    ["files", "Files", "files"],
    ["disk", "Disk usage", "disk"],
    ["docker", "Container platform", "docker"],
    ["logs", "Logs", "logs"],
    ["network", "Network sockets", "network"],
    ["cron", "Cron jobs", "cron"],
    ["packages", "Packages", "packages"],
    ["accounts", "Users & groups", "users"],
    ["commands", "Saved commands", "terminalSmall"],
    ["tunnels", "SSH tunnels", "network"],
    ["administration", "Administration", "settings"],
  ] as const;
  const unsupported = (view: View): boolean => {
    const cap = activeCapabilities();
    if (!cap) return false;
    if (view === "docker") return !cap.docker && !cap.podman;
    if (view === "services") return !cap.systemd;
    if (view === "cron") return !cap.cron;
    if (view === "packages") return cap.packageManager !== "apt-get";
    if (view === "network") return !cap.networkTool;
    return false;
  };
  return `<aside class="sidebar">
    <div class="sidebar-section nav-section"><div class="section-label">Workspace</div>${nav.map(([view, label, iconName]) => `<button class="nav-item ${state.activeView === view ? "active" : ""}" data-view="${view}" ${!activeServerIsConnected() || unsupported(view) ? "disabled" : ""}>${icon(iconName)}<span>${label}</span>${unsupported(view) ? `<small>off</small>` : ""}</button>`).join("")}</div>
    ${renderSidebarBottom()}
  </aside>`;
}

function renderSidebarBottom(): string {
  return `<div class="sidebar-bottom">
      <button class="utility-link" data-action="credential-settings">${icon("settings")} Settings</button>
      <button class="icon-button sidebar-theme-toggle" data-action="theme" aria-label="${state.darkMode ? "Switch to light appearance" : "Switch to dark appearance"}" title="${state.darkMode ? "Switch to light appearance" : "Switch to dark appearance"}">${icon(state.darkMode ? "sun" : "moon")}</button>
    </div>`;
}

export function renderServerItem(server: ServerProfile): string {
  const initials = server.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const connected = connectedServerIds.has(server.id) || hasInteractiveSession(server.id);
  const tooltip = `${server.name}\n${server.host}`;
  return `<div class="server-item ${server.id === state.activeServerId ? "active" : ""}" data-server-id="${escapeHtml(server.id)}" role="button" tabindex="0" aria-label="Open ${escapeHtml(server.name)} at ${escapeHtml(server.host)}" title="${escapeHtml(tooltip)}">
    <span class="server-avatar">${escapeHtml(initials)}</span><span class="server-item-copy"><strong>${server.favorite ? `${icon("star")} ` : ""}${escapeHtml(server.name)}</strong><small>${escapeHtml(server.username)}@${escapeHtml(server.host)}</small></span><span class="server-item-actions"><button class="server-action" data-server-action="new-tab" data-server-id="${escapeHtml(server.id)}" aria-label="Open another ${escapeHtml(server.name)} workspace" title="Open another workspace">${icon("plus")}</button><button class="server-action" data-server-action="duplicate" data-server-id="${escapeHtml(server.id)}" aria-label="Duplicate ${escapeHtml(server.name)}" title="Duplicate server">${icon("copy")}</button><button class="server-action" data-server-action="edit" data-server-id="${escapeHtml(server.id)}" aria-label="Edit ${escapeHtml(server.name)}" title="Edit connection">${icon("edit")}</button><button class="server-action server-action-delete" data-server-action="delete" data-server-id="${escapeHtml(server.id)}" aria-label="Delete ${escapeHtml(server.name)}" title="Delete server">${icon("trash")}</button></span><span class="connection-dot ${connected ? "online" : ""}"></span>
  </div>`;
}

export function renderTabBar(): string {
  const tabs = state.openServerTabs.map((tab) => ({ tab, server: state.snapshot.servers.find((server) => server.id === tab.serverId) })).filter((item): item is { tab: WorkspaceTab; server: ServerProfile } => Boolean(item.server));
  const tabContent = tabs.length ? tabs.map(({ tab, server }) => {
    const selected = tab.id === state.activeWorkspaceTabId;
    const connected = connectedServerIds.has(server.id) || hasInteractiveSession(server.id);
    const label = tab.label || server.name;
    return `<button class="workspace-tab ${selected ? "active" : ""}" data-workspace-tab="${escapeHtml(tab.id)}" role="tab" aria-selected="${selected}"><span class="workspace-tab-status ${connected ? "online" : ""}"></span><span class="workspace-tab-copy">${escapeHtml(label)}</span><span class="workspace-tab-action" data-workspace-tab-action data-workspace-rename="${escapeHtml(tab.id)}" title="Rename tab" aria-label="Rename ${escapeHtml(label)} tab">${icon("edit")}</span><span class="workspace-tab-action workspace-tab-close" data-workspace-tab-action data-workspace-close="${escapeHtml(tab.id)}" title="Close tab" aria-label="Close ${escapeHtml(label)} tab">${icon("close")}</span></button>`;
  }).join("") : "";
  const local = isLocalWorkspace();
  const localTab = `<button class="workspace-tab workspace-tab-local ${local ? "active" : ""}" data-action="open-local" aria-pressed="${local}" title="Shells on this machine"><span class="workspace-tab-icon">${icon("terminalSmall")}</span><span class="workspace-tab-copy">Local</span></button>`;
  return `<div class="workspace-tabbar">${localTab}<div class="workspace-tabs" role="tablist" aria-label="Open server workspaces">${tabContent}</div>${state.activeServerId && activeServerIsConnected() ? `<button class="button button-quiet workspace-disconnect" data-action="disconnect">Disconnect</button>` : ""}</div>`;
}

export function renderWelcome(): string {
  return renderWelcomeView();
}

export function renderEmptyWorkspace(): string {
  return renderEmptyWorkspaceView();
}

/** The current server view with the server's terminals docked beside it (terminal.ts mounts them). */
function renderDockLayout(): string {
  const dock = activeDock()!;
  const controls = `<button class="term-tab-new" data-action="dock-position" title="Dock ${dock.position === "right" ? "below" : "on the right"}" aria-label="Move the terminal dock">${icon(dock.position === "right" ? "chevron" : "terminalSmall")}</button><button class="term-tab-new" data-action="toggle-dock" title="Hide terminals" aria-label="Hide terminals">${icon("close")}</button>`;
  return `<div class="dock-layout dock-${dock.position}" style="--dock-ratio: ${dock.ratio}"><div class="dock-main">${renderConnectedContent()}</div><div class="dock-divider" data-dock-divider role="separator" aria-orientation="${dock.position === "right" ? "vertical" : "horizontal"}"></div><section class="terminal-dock">${renderTabStrip(controls)}<div class="terminal-surface" data-terminal-surface></div></section></div>`;
}

export function renderConnectedContent(): string {
  const server = activeServer();
  if (!server) return renderWelcome();
  const titles: Record<View, [string, string]> = {
    dashboard: ["Overview", "A clear read on how this machine is doing."],
    terminal: ["Terminal", "A real interactive shell, one keystroke away."],
    processes: ["Processes", "See what is using the machine right now."],
    services: ["Systemd services", "Keep systemd units healthy and moving."],
    files: ["Files", "Browse, edit, and move files over SFTP."],
    disk: ["Disk usage", "Find what is consuming space before it becomes an outage."],
    docker: ["Container platform", "Runtime resources and Compose applications in one place."],
    logs: ["System logs", "The recent story behind what is happening."],
    network: ["Network sockets", "Listening ports and active connections."],
    cron: ["Cron jobs", "Scheduled commands for this server."],
    packages: ["Packages", "Installed software and pending APT upgrades."],
    accounts: ["Users & groups", "Linux identities, access, and membership."],
    administration: ["Administration", "Firewall, SSH access, security posture, and maintenance."],
    commands: ["Saved commands", "Reusable commands for this server or your whole workspace."],
    tunnels: ["SSH tunnels", "Local, remote, and SOCKS5 forwarding managed by hbox-term."],
  };
  const [title, subtitle] = titles[state.activeView];
  const snapshotNotice = state.activeView === "dashboard"
    ? `<span class="overview-snapshot-note">${icon("info")} Snapshot metrics · not live</span>`
    : "";
  return `<div class="page-head"><div><div class="eyebrow">${escapeHtml(server.name)} <span class="eyebrow-separator">/</span> ${title}</div><h1>${title}</h1><p>${subtitle}</p></div><div class="page-actions">${snapshotNotice}${state.activeView === "terminal" ? "" : `<button class="button button-quiet ${dockShown() ? "active" : ""}" data-action="toggle-dock" title="Terminals beside this view (Ctrl+\`)">${icon("terminalSmall")} Terminal</button>`}<button class="button button-quiet" data-action="refresh">${icon("refresh")} Refresh</button></div></div>${renderView()}`;
}

export function renderView(): string {
  if (viewTransitionIsCurrent()) return renderViewLoading();
  if (state.activeView === "dashboard" && !state.activeOperation && !state.dashboard && !activeServerIsConnected()) return `${state.errorMessage ? renderInlineError() : ""}${renderConnectPrompt()}`;
  if (state.errorMessage && state.activeView !== "dashboard") return `${renderError()}${renderViewBody()}`;
  return `${state.errorMessage ? renderInlineError() : ""}${renderViewBody()}`;
}

export function renderConnectPrompt(): string {
  const server = activeServer();
  if (!server) return renderWelcome();
  const bastion = state.snapshot.servers.find((candidate) => candidate.id === server.jumpHostId);
  const route = bastion
    ? ` The connection routes through ${escapeHtml(profileRouteLabel(bastion))}.`
    : "";
  return `<div class="connect-prompt"><div class="connect-prompt-art">${icon("shield")}</div><div class="eyebrow">Connection is idle</div><h2>Ready when you are.</h2><p>Nothing has contacted ${escapeHtml(server.host)} yet. hbox-term will read this connection's saved secret only when you choose to connect.${route}</p><button class="button button-primary" data-action="connect">${icon("play")} Connect to ${escapeHtml(server.name)}</button></div>`;
}

export function renderViewBody(): string {
  switch (state.activeView) {
    case "dashboard": return renderDashboard();
    case "terminal": return renderTerminal();
    case "processes": return renderProcesses();
    case "services": return renderServices();
    case "files": return renderFiles();
    case "disk": return renderDisk();
    case "docker": return renderDocker();
    case "logs": return renderLogs();
    case "network": return renderNetwork();
    case "cron": return renderCron();
    case "packages": return renderPackages();
    case "accounts": return renderAccounts();
    case "administration": return renderAdministration();
    case "commands": return renderCommands();
    case "tunnels": return renderTunnels();
  }
}

export function renderViewLoading(): string {
  const server = activeServer();
  const firstConnection = !activeServerIsConnected();
  const title = state.activeOperation?.label ?? (firstConnection ? "Establishing a secure connection…" : "Loading this view…");
  const detail = firstConnection
    ? `Connecting to ${server?.host ?? "the server"} and reading its overview. SSH can take a moment on the first connection.`
    : `Reading fresh information from ${server?.host ?? "the server"}. You can switch views or cancel at any time.`;
  return `<div class="view-loading" role="status" aria-live="polite" aria-busy="true"><div class="view-loading-card"><div class="view-loading-mark"><div class="spinner"></div>${icon("logo")}</div><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div></div><div class="view-loading-skeleton" aria-hidden="true"><span></span><span></span><span></span><span></span></div></div>`;
}

export function renderError(): string {
  return renderErrorView(state.errorMessage);
}

export function renderInlineError(): string {
  return renderInlineErrorView(state.errorMessage);
}
