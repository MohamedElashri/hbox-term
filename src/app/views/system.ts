import { icon } from "../../icons";
import type { ProcessInfo, RemoteFile, ServiceInfo } from "../../types";
import { leaves } from "../panes";
import { groupTitle } from "../terminal";
import type { TerminalGroup } from "../types";
import { escapeHtml, formatBytes, formatDate, formatDuration, meter, sparkline } from "../format";
import { renderViewLoading } from "../render";
import { activeCapabilities, activeServer, activeTerminalGroup, activeTerminalGroups, isLocalWorkspace, state } from "../state";
import type { DashboardCardName } from "../types";
import { renderUnsupported } from "./admin";

export function renderDashboard(): string {
  if (!state.dashboard) return renderViewLoading();
  const { profile, cpu, memory, storage, uptime, network } = state.dashboard;
  const primaryDisk = storage?.disks[0];
  const cap = profile?.capabilities;
  return `<div class="dashboard-grid">
    ${cpu ? `<div class="stat-card stat-card-large"><div class="stat-card-head"><span class="stat-icon accent">${icon("cpu")}</span><span>CPU load</span><span>SNAPSHOT</span></div><div class="stat-value">${cpu.cpuPercent.toFixed(1)}<small>%</small></div><div class="stat-meta">${cpu.cpuCores} cores · ${escapeHtml(cpu.cpuModel)}</div>${sparkline(cpu.cpuPercent, "accent")}</div>` : renderDashboardPlaceholder("div", "stat-card stat-card-large", "CPU load", "cpu")}
    ${memory ? `<div class="stat-card stat-card-large"><div class="stat-card-head"><span class="stat-icon green">${icon("memory")}</span><span>Memory</span><span>${memory.memory.percent.toFixed(0)}%</span></div><div class="stat-value">${formatBytes(memory.memory.usedBytes)}<small> used</small></div><div class="stat-meta">${formatBytes(memory.memory.freeBytes)} available of ${formatBytes(memory.memory.totalBytes)}</div>${meter(memory.memory.percent, "green")}</div>` : renderDashboardPlaceholder("div", "stat-card stat-card-large", "Memory", "memory")}
    ${storage ? `<div class="stat-card stat-card-large"><div class="stat-card-head"><span class="stat-icon orange">${icon("disk")}</span><span>System disk</span><span>${primaryDisk ? `${primaryDisk.percent.toFixed(0)}%` : "—"}</span></div><div class="stat-value">${primaryDisk ? formatBytes(primaryDisk.usedBytes) : "—"}<small> used</small></div><div class="stat-meta">${primaryDisk ? `${formatBytes(primaryDisk.availableBytes)} free on ${escapeHtml(primaryDisk.mount)}` : "No disk data"}</div>${meter(primaryDisk?.percent ?? 0, "orange")}</div>` : renderDashboardPlaceholder("div", "stat-card stat-card-large", "System disk", "storage")}
    ${uptime ? `<div class="stat-card stat-card-large"><div class="stat-card-head"><span class="stat-icon cyan">${icon("clock")}</span><span>Uptime</span><span>STEADY</span></div><div class="stat-value">${formatDuration(uptime.uptimeSeconds)}</div><div class="stat-meta">Load ${uptime.loadAverages.map((value) => value.toFixed(2)).join(" · ")}</div>${sparkline(uptime.loadAverages[0] * 20, "cyan")}</div>` : renderDashboardPlaceholder("div", "stat-card stat-card-large", "Uptime", "uptime")}

    ${profile ? `<section class="panel overview-panel"><div class="panel-head"><div><div class="panel-kicker">Machine profile</div><h2>${escapeHtml(profile.hostname)}</h2><p>${escapeHtml(profile.os)}</p></div><span class="status-badge status-good"><i></i>Reachable</span></div><div class="machine-details"><div><span>Kernel</span><strong>${escapeHtml(profile.kernel)}</strong></div><div><span>Architecture</span><strong>${escapeHtml(profile.architecture)}</strong></div><div><span>Last refresh</span><strong>${formatDate(profile.connectedAt)}</strong></div></div><div class="capability-row">${capabilityBadge("systemd", cap?.systemd ?? false)}${capabilityBadge("Containers", Boolean(cap?.docker || cap?.podman))}${capabilityBadge("sudo", Boolean(cap?.sudo || cap?.root))}${capabilityBadge("cron", cap?.cron ?? false)}${capabilityBadge(cap?.packageManager ?? "packages", Boolean(cap?.packageManager))}${capabilityBadge(cap?.networkTool ?? "network", Boolean(cap?.networkTool))}${capabilityBadge("journalctl", cap?.journalctl ?? false)}${capabilityBadge("logread", cap?.logread ?? false)}</div></section>` : renderDashboardPlaceholder("section", "panel overview-panel", "Machine profile", "profile")}
    ${uptime ? `<section class="panel load-panel"><div class="panel-head compact"><div><div class="panel-kicker">Load averages</div><h2>How busy is it?</h2></div><span class="panel-note">1 · 5 · 15 min</span></div><div class="load-bars">${uptime.loadAverages.map((value, index) => `<div class="load-row"><span>${["01", "05", "15"][index]}</span>${meter(Math.min(100, value / Math.max(1, cpu?.cpuCores ?? 1) * 100), index === 0 ? "accent" : index === 1 ? "green" : "cyan")}<strong>${value.toFixed(2)}</strong></div>`).join("")}</div>${memory ? `<div class="swap-note"><span>${icon("memory")} Swap</span><strong>${formatBytes(memory.swap.usedBytes)} / ${formatBytes(memory.swap.totalBytes)}</strong>${meter(memory.swap.percent, "orange")}</div>` : `<div class="swap-note dashboard-inline-loading"><span>${icon("memory")} Swap</span><span>Waiting for memory…</span></div>`}</section>` : renderDashboardPlaceholder("section", "panel load-panel", "Load averages", "uptime")}
    ${storage ? `<section class="panel disk-panel"><div class="panel-head compact"><div><div class="panel-kicker">Storage</div><h2>Mounted disks</h2></div><span class="panel-note">${storage.disks.length} mount${storage.disks.length === 1 ? "" : "s"}</span></div>${storage.disks.length ? `<div class="disk-list">${storage.disks.slice(0, 5).map((disk) => `<div class="disk-row"><div class="disk-row-name"><span>${icon("folder")}</span><strong>${escapeHtml(disk.mount)}</strong><small>${escapeHtml(disk.filesystem)}</small></div><div class="disk-row-meter">${meter(disk.percent, disk.percent > 85 ? "accent" : "orange")}<small>${formatBytes(disk.usedBytes)} of ${formatBytes(disk.totalBytes)}</small></div><strong class="disk-percent">${disk.percent.toFixed(0)}%</strong></div>`).join("")}</div>` : `<div class="empty-mini">Disk usage could not be read.</div>`}</section>` : renderDashboardPlaceholder("section", "panel disk-panel", "Mounted disks", "storage")}
    ${network ? `<section class="panel network-panel"><div class="panel-head compact"><div><div class="panel-kicker">Network</div><h2>Interfaces</h2></div><button class="text-button" data-view="network">View ports ${icon("chevron")}</button></div>${network.interfaces.length ? `<div class="interface-list">${network.interfaces.slice(0, 5).map((item) => `<div class="interface-row"><span class="interface-dot"></span><strong>${escapeHtml(item.name)}</strong><span>${item.addresses.map(escapeHtml).join(" · ")}</span></div>`).join("")}</div>` : `<div class="empty-mini">No global network addresses reported.</div>`}</section>` : renderDashboardPlaceholder("section", "panel network-panel", "Network interfaces", "network")}
  </div>`;
}

export function renderDashboardPlaceholder(tag: "div" | "section", className: string, label: string, card: DashboardCardName): string {
  const error = state.dashboard?.errors[card];
  const content = error
    ? `<div class="dashboard-card-error"><span>${icon("info")}</span><div><strong>${escapeHtml(label)} is unavailable</strong><small>${escapeHtml(error)}</small></div></div>`
    : `<div class="dashboard-card-skeleton" role="status" aria-live="polite"><span class="dashboard-card-shimmer"></span><div><strong>${state.dashboard?.loading ? `Loading ${label}…` : `${label} unavailable`}</strong><small>${state.dashboard?.loading ? "Collecting the overview in one secure request." : "No data was reported by this server."}</small></div></div>`;
  return `<${tag} class="${className} dashboard-card-loading">${content}</${tag}>`;
}

export function renderCollectionFooter(hasMore: boolean, loaded: number, noun: string): string {
  if (!hasMore) return loaded ? `<div class="collection-footer"><span>All ${loaded} ${noun} loaded</span></div>` : "";
  return `<div class="collection-footer"><span>${loaded} ${noun} loaded</span><button class="button button-quiet small-button" data-action="load-more" ${state.activeOperation ? "disabled" : ""}>${state.activeOperation ? "Loading…" : `Load more ${noun}`}</button></div>`;
}

export function capabilityBadge(label: string, enabled: boolean): string {
  return `<span class="capability ${enabled ? "enabled" : "disabled"}"><i></i>${label}</span>`;
}

export function renderTerminal(): string {
  if (isLocalWorkspace()) return renderLocalTerminal();
  const current = state.terminalTabs.find((tab) => tab.id === state.activeTerminalTabId);
  return `<section class="terminal-workspace">${renderTabStrip()}${current ? `<div class="terminal-meta"><span>${icon("terminalSmall")} ${escapeHtml(activeServer()?.username ?? "user")}@${escapeHtml(activeServer()?.host ?? "server")}</span><span>${current.connecting ? "Opening session…" : current.closed ? `${current.command ? "Container" : "SSH"} session closed` : current.command ? "Container exec · xterm" : "Interactive SSH · xterm"}</span>${current.closed ? `<button class="text-button" data-action="reconnect-terminal">${icon("restart")} Reconnect</button>` : ""}<button class="text-button" data-action="clear-terminal">Clear ${icon("close")}</button></div><div class="terminal-surface" data-terminal-surface="${current.id}"></div>` : `<div class="terminal-empty"><div class="terminal-empty-art">${icon("terminal")}</div><h2>A shell for whatever comes next.</h2><p>Every server deserves a good terminal fallback. Open one when you need to go off-road.</p><button class="button button-primary" data-action="new-terminal">${icon("terminalSmall")} Open terminal</button></div>`}</section>`;
}

/**
 * The tabs of the current workspace, like Ghostty's and iTerm2's tab bar: click to switch, middle
 * click or × to close, double click to rename, drag to reorder (see terminal-tabs.ts).
 */
export function renderTabStrip(controls = ""): string {
  const groups = activeTerminalGroups();
  const activeGroup = activeTerminalGroup();
  const tabs = groups.map((group) => {
    const title = groupTitle(group);
    const active = group === activeGroup;
    return `<div class="term-tab ${active ? "active" : ""}" role="tab" aria-selected="${active}" data-terminal-tab="${escapeHtml(group.focusedId)}" data-tab-group="${escapeHtml(group.id)}" title="${escapeHtml(title)}"><span class="term-tab-dot ${groupExited(group) ? "closed" : ""}"></span><span class="term-tab-title">${escapeHtml(title)}</span>${paneCount(group)}<button class="term-tab-close" data-terminal-close="${escapeHtml(group.id)}" aria-label="Close ${escapeHtml(title)}">${icon("close")}</button></div>`;
  }).join("");
  return `<div class="tab-strip" role="tablist" aria-label="Terminal tabs">${tabs}<button class="term-tab-new" data-action="new-terminal" title="New tab" aria-label="New tab">${icon("plus")}</button>${controls ? `<span class="tab-strip-controls">${controls}</span>` : ""}</div>`;
}

export const groupExited = (group: TerminalGroup): boolean =>
  leaves(group.root).every((id) => state.terminalTabs.find((tab) => tab.id === id)?.closed);

export function paneCount(group: TerminalGroup): string {
  const count = leaves(group.root).length;
  const broadcast = group.broadcast ? `<small class="broadcast-badge" title="Typing goes to every pane of this tab">broadcast</small>` : "";
  return `${broadcast}${count > 1 ? `<small class="pane-count">${count}</small>` : ""}`;
}

/** Local shells fill the content area below their tab strip. */
function renderLocalTerminal(): string {
  return `<section class="terminal-workspace terminal-workspace-local">${renderTabStrip()}<div class="terminal-surface" data-terminal-surface></div></section>`;
}

export function renderProcesses(): string {
  const rows = state.processes;
  return `<section class="panel table-panel"><div class="panel-head"><div><div class="panel-kicker">Live process table</div><h2>${rows.length} processes loaded</h2><p>Refreshes every 5 seconds · sorted by CPU</p></div><div class="table-head-actions"><span class="status-badge status-live"><i></i>Auto refresh</span><button class="icon-button" data-action="refresh">${icon("refresh")}</button></div></div><div class="table-scroll"><table><thead><tr><th>PID</th><th>Process / user</th><th>CPU</th><th>Memory</th><th>RSS</th><th>Runtime</th><th></th></tr></thead><tbody>${rows.length ? rows.map(renderProcessRow).join("") : `<tr><td colspan="7"><div class="empty-table">No processes were returned.</div></td></tr>`}</tbody></table></div>${renderCollectionFooter(state.processesHasMore, rows.length, "processes")}</section>`;
}

export function renderProcessRow(process: ProcessInfo): string {
  return `<tr><td><span class="mono muted-text">${process.pid}</span></td><td><div class="process-name"><strong title="${escapeHtml(process.command)}">${escapeHtml(process.command)}</strong><small>${escapeHtml(process.user)}</small></div></td><td><span class="metric-number ${process.cpuPercent > 70 ? "hot" : ""}">${process.cpuPercent.toFixed(1)}%</span></td><td><span class="metric-number">${process.memoryPercent.toFixed(1)}%</span></td><td class="muted-text">${formatBytes(process.rssBytes)}</td><td class="muted-text">${formatDuration(process.runtimeSeconds)}</td><td><div class="row-actions"><button class="row-action" data-process-action="term" data-pid="${process.pid}" title="Send SIGTERM">${icon("stop")}</button><button class="row-action danger" data-process-action="kill" data-pid="${process.pid}" title="Force kill">${icon("close")}</button></div></td></tr>`;
}

export function renderServices(): string {
  const cap = activeCapabilities();
  if (cap && !cap.systemd) return renderUnsupported("systemd is not available on this server", "This machine did not report systemd. Systemd services are hidden until a compatible init system is detected.");
  return `<section class="panel table-panel"><div class="panel-head"><div><div class="panel-kicker">systemd service manager</div><h2>${state.services.length} units loaded</h2><p>Start, stop, reload, and inspect recent journal entries.</p></div><div class="table-head-actions"><span class="status-badge status-good"><i></i>systemd</span><button class="icon-button" data-action="refresh">${icon("refresh")}</button></div></div><div class="service-filter"><span>${icon("search")}</span><input data-field="service-search" placeholder="Filter loaded services…"/><span class="service-count">${state.services.filter((service) => service.activeState === "active").length} active</span></div><div class="table-scroll"><table><thead><tr><th>Unit</th><th>State</th><th>Description</th><th>Enabled</th><th></th></tr></thead><tbody>${state.services.length ? state.services.map(renderServiceRow).join("") : `<tr><td colspan="5"><div class="empty-table">No services returned.</div></td></tr>`}</tbody></table></div>${renderCollectionFooter(state.servicesHasMore, state.services.length, "services")}</section>`;
}

export function renderServiceRow(service: ServiceInfo): string {
  const good = service.activeState === "active";
  return `<tr data-service-row="${escapeHtml(service.name)}"><td><div class="unit-name"><span class="service-dot ${good ? "active" : service.activeState === "failed" ? "failed" : "idle"}"></span><strong>${escapeHtml(service.name)}</strong></div></td><td><span class="state-label ${good ? "good" : service.activeState === "failed" ? "bad" : "muted"}">${escapeHtml(service.activeState)} · ${escapeHtml(service.subState)}</span></td><td class="description-cell">${escapeHtml(service.description || "—")}</td><td class="muted-text">${service.enabled === undefined ? "—" : service.enabled ? "Enabled" : "Disabled"}</td><td><div class="row-actions service-actions">${good ? `<button class="row-action" data-service-action="stop" data-service="${escapeHtml(service.name)}" title="Stop">${icon("stop")}</button>` : `<button class="row-action" data-service-action="start" data-service="${escapeHtml(service.name)}" title="Start">${icon("play")}</button>`}<button class="row-action" data-service-action="restart" data-service="${escapeHtml(service.name)}" title="Restart">${icon("restart")}</button><button class="row-action" data-service-action="reload" data-service="${escapeHtml(service.name)}" title="Reload">${icon("refresh")}</button><button class="row-action" data-service-details="${escapeHtml(service.name)}" title="Details">${icon("chevron")}</button></div></td></tr>`;
}

export function renderFiles(): string {
  const filtered = state.remoteFiles.filter((file) => file.name.toLowerCase().includes(state.remoteFileSearch.toLowerCase()));
  const parts = state.remotePath.split("/").filter(Boolean);
  let accumulated = "";
  const crumbs = [`<button data-file-path="/">root</button>`, ...parts.map((part) => { accumulated += `/${part}`; return `<span>/</span><button data-file-path="${escapeHtml(accumulated)}">${escapeHtml(part)}</button>`; })].join("");
  return `<section class="files-workspace"><div class="files-toolbar"><div class="breadcrumbs">${crumbs}</div><div class="files-toolbar-actions"><label class="toggle-control"><input type="checkbox" data-field="show-hidden" ${state.showHidden ? "checked" : ""}/><span></span>Hidden</label><button class="button button-quiet" data-action="new-folder">${icon("folder")} New folder</button><button class="button button-quiet" data-action="upload-file">${icon("upload")} File</button><button class="button button-quiet" data-action="upload-folder">${icon("folder")} Folder</button></div></div><div class="file-drop-zone" data-file-drop>${icon("upload")} Drop files or folders here to upload</div><div class="panel table-panel file-table-panel"><div class="file-table-search"><span>${icon("search")}</span><input data-field="file-search" value="${escapeHtml(state.remoteFileSearch)}" placeholder="Search loaded files…"/><span class="file-location">${escapeHtml(state.remotePath)}</span><button class="icon-button" data-action="refresh">${icon("refresh")}</button></div><div class="table-scroll"><table><thead><tr><th>Name</th><th>Size</th><th>Modified</th><th>Permissions</th><th>Owner</th><th></th></tr></thead><tbody>${state.remotePath !== "/" ? `<tr class="parent-row"><td colspan="6"><button class="file-name-button" data-file-path="${escapeHtml(parentPath(state.remotePath))}">${icon("back")} ..</button></td></tr>` : ""}${filtered.length ? filtered.map(renderFileRow).join("") : `<tr><td colspan="6"><div class="empty-table">${state.remoteFiles.length ? "No matching files." : "This folder is empty or could not be read."}</div></td></tr>`}</tbody></table></div>${renderCollectionFooter(state.filesHaveMore, state.remoteFiles.length, "files")}</div></section>`;
}

export function renderFileRow(file: RemoteFile): string {
  const isDir = file.kind === "directory";
  return `<tr><td><button class="file-name-button" data-file-${isDir ? "path" : "edit"}="${escapeHtml(file.path)}">${icon(isDir ? "folder" : "file")}<strong>${escapeHtml(file.name)}</strong>${file.kind === "symlink" ? `<small>symlink</small>` : ""}</button></td><td class="muted-text">${isDir ? "—" : formatBytes(file.sizeBytes)}</td><td class="muted-text">${formatDate(file.modifiedAt)}</td><td><span class="mono muted-text">${escapeHtml(file.permissions ?? "—")}</span></td><td class="muted-text">${file.uid ?? "—"}:${file.gid ?? "—"}</td><td><div class="row-actions"><button class="row-action" data-file-download="${escapeHtml(file.path)}" title="Download">${icon("download")}</button><button class="row-action" data-file-edit="${escapeHtml(file.path)}" title="Edit">${icon("edit")}</button><button class="row-action" data-file-edit-local="${escapeHtml(file.path)}" title="Edit in local editor (saves upload)">${icon("terminalSmall")}</button><button class="row-action" data-file-chmod="${escapeHtml(file.path)}" title="Change permissions">${icon("settings")}</button><button class="row-action" data-file-chown="${escapeHtml(file.path)}" title="Change owner">${icon("shield")}</button><button class="row-action danger" data-file-delete="${escapeHtml(file.path)}" title="Delete">${icon("trash")}</button></div></td></tr>`;
}

export function parentPath(path: string): string { const value = path.replace(/\/$/, ""); const parent = value.slice(0, value.lastIndexOf("/")); return parent || "/"; }
