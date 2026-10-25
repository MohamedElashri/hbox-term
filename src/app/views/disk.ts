import { icon } from "../../icons";
import type { DiskExplorerSnapshot, DiskMount, LargestDirectory } from "../../types";
import { escapeHtml, formatBytes, formatDate, meter } from "../format";
import { render, renderViewLoading } from "../render";
import { invokeCommand, setError } from "../session";
import { state } from "../state";
import type { DiskTab } from "../types";
import { setView } from "../workspace";
import { parentPath } from "./system";

export function diskMeterTone(percent: number): "accent" | "orange" | "green" {
  if (percent >= 90) return "accent";
  if (percent >= 80) return "orange";
  return "green";
}

export function renderDisk(): string {
  if (!state.diskSnapshot) return renderViewLoading();
  const { mounts, largestFiles, largestDirs, dockerUsage } = state.diskSnapshot;
  if (state.diskTab === "docker" && !dockerUsage) state.diskTab = "mounts";
  const tabs = [
    ["mounts", "Mounts", `${mounts.length}`],
    ["files", "Largest files", largestFiles.length ? `${largestFiles.length}` : "·"],
    ["dirs", "Largest directories", largestDirs.length ? `${largestDirs.length}` : "·"],
    ...(dockerUsage ? [["docker", "Docker disk", ""] as [DiskTab, string, string]] : []),
    ["varlog", "/var/log", ""],
  ] as Array<[DiskTab, string, string]>;
  return `<section class="docker-workspace"><div class="subnav-tabs workspace-tabs container-platform-tabs">${tabs.map(([tab, label, count]) => `<button class="subnav-tab ${state.diskTab === tab ? "active" : ""}" data-disk-tab="${tab}">${label}${count ? ` <span>${count}</span>` : ""}</button>`).join("")}</div>${renderDiskTab()}</section>`;
}

export function renderDiskTab(): string {
  if (!state.diskSnapshot) return "";
  switch (state.diskTab) {
    case "mounts": return renderDiskMounts();
    case "files": return renderDiskLargestFiles();
    case "dirs": return renderDiskLargestDirs();
    case "docker": return state.diskSnapshot.dockerUsage ? renderDockerDiskPanel(state.diskSnapshot.dockerUsage) : "";
    case "varlog": return renderDiskVarLog();
  }
}

export function renderDiskMounts(): string {
  const { mounts } = state.diskSnapshot!;
  const inodeCell = (mount: (typeof mounts)[number]): string => {
    if (mount.inodeTotal === undefined || mount.inodeUsed === undefined) return `<td class="muted-text">—</td>`;
    const percent = mount.inodePercent ?? (mount.inodeTotal ? mount.inodeUsed / mount.inodeTotal * 100 : 0);
    return `<td><div class="disk-inode-cell"><span class="metric-number ${percent >= 90 ? "hot" : ""}">${percent.toFixed(0)}%</span><small class="muted-text">${formatNumber(mount.inodeUsed)} / ${formatNumber(mount.inodeTotal)}</small></div></td>`;
  };
  return `<section class="panel table-panel"><div class="panel-head compact"><div><div class="panel-kicker">Mount overview</div><h2>${mounts.length} mounted filesystem${mounts.length === 1 ? "" : "s"}</h2><p>Sorted by how full each mount is. Inodes appear when the filesystem reports them.</p></div><span class="panel-note">snapshot</span></div>
    ${mounts.length ? `<div class="table-scroll"><table><thead><tr><th>Mount</th><th>Filesystem</th><th>Usage</th><th>Used</th><th>Available</th><th>Inodes</th></tr></thead><tbody>${mounts.map((mount) => `<tr>
      <td><div class="process-name wrap-anywhere"><strong title="${escapeHtml(mount.mount)}">${escapeHtml(mount.mount)}</strong><small>${diskMountKind(mount)}</small></div></td>
      <td class="mono muted-text"><span class="file-path-text">${escapeHtml(mount.filesystem)}</span></td>
      <td class="disk-usage-cell"><div class="disk-usage-inner">${meter(mount.percent, diskMeterTone(mount.percent))}<strong class="disk-percent ${mount.percent >= 90 ? "hot-text" : ""}">${mount.percent.toFixed(0)}%</strong></div></td>
      <td class="muted-text">${formatBytes(mount.usedBytes)} <small>of ${formatBytes(mount.totalBytes)}</small></td>
      <td class="muted-text">${formatBytes(mount.availableBytes)}</td>
      ${inodeCell(mount)}
    </tr>`).join("")}</tbody></table></div>` : `<div class="empty-table">Disk usage could not be read on this server.</div>`}
  </section>`;
}

export function renderDiskLargestFiles(): string {
  const { largestFiles } = state.diskSnapshot!;
  return `<section class="panel table-panel"><div class="panel-head compact"><div><div class="panel-kicker">Largest files</div><h2>${largestFiles.length ? `${largestFiles.length} largest files found` : "No large files reported"}</h2><p>Bounded scan of common high-consumption roots (/var, /opt, /srv, /home, /usr/local), four levels deep. Permission-restricted paths may be missed.</p></div></div>
    ${largestFiles.length ? `<div class="table-scroll"><table><thead><tr><th>Path</th><th>Size</th><th>Modified</th><th></th></tr></thead><tbody>${largestFiles.map((file) => `<tr>
      <td class="file-path-cell"><span class="mono file-path-text" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</span></td>
      <td><strong>${formatBytes(file.sizeBytes)}</strong></td>
      <td class="muted-text">${file.modifiedAt ? formatDate(file.modifiedAt) : "—"}</td>
      <td><div class="row-actions"><button class="row-action" data-disk-open-path="${escapeHtml(file.path)}" title="Open folder in Files">${icon("folder")}</button></div></td>
    </tr>`).join("")}</tbody></table></div>` : `<div class="empty-table">No matching files were found in the scanned roots.</div>`}
  </section>`;
}

export function renderDiskLargestDirs(): string {
  const { largestDirs } = state.diskSnapshot!;
  return `<section class="panel table-panel"><div class="panel-head compact"><div><div class="panel-kicker">Largest directories</div><h2>${largestDirs.length ? `${largestDirs.length} largest directories found` : "No large directories reported"}</h2><p>Disk usage per directory tree, staying on one filesystem and three levels deep.</p></div></div>
    ${largestDirs.length ? `<div class="table-scroll"><table><thead><tr><th>Path</th><th>Size</th><th>Depth</th><th></th></tr></thead><tbody>${largestDirs.map((dir) => `<tr>
      <td class="file-path-cell"><span class="mono file-path-text" title="${escapeHtml(dir.path)}">${escapeHtml(dir.path)}</span></td>
      <td><strong>${formatBytes(dir.sizeBytes)}</strong></td>
      <td class="muted-text">${dir.depth}</td>
      <td><div class="row-actions"><button class="row-action" data-disk-open-path="${escapeHtml(dir.path)}" title="Open folder in Files">${icon("folder")}</button></div></td>
    </tr>`).join("")}</tbody></table></div>` : `<div class="empty-table">No directories over 10 MB were found in the scanned roots.</div>`}
  </section>`;
}

export function renderDiskVarLog(): string {
  return `<section class="panel"><div class="panel-head compact"><div><div class="panel-kicker">Log directory</div><h2>/var/log breakdown</h2><p>On-demand view for the classic “why is /var full?” question.</p></div><button class="icon-button" data-disk-varlog title="Reload /var/log usage">${icon("refresh")}</button></div>
    ${state.diskVarLogLoading ? `<div class="collection-loading" role="status"><div class="spinner"></div><span>Measuring /var/log…</span></div>` : state.diskVarLog?.length ? `<div class="varlog-list">${state.diskVarLog.map((entry) => `<div class="disk-row"><div class="disk-row-name"><span>${icon("folder")}</span><strong title="${escapeHtml(entry.path)}">${escapeHtml(entry.path)}</strong></div><div class="disk-row-meter">${meter(Math.min(100, entry.sizeBytes / Math.max(1, state.diskVarLog![0].sizeBytes) * 100), "cyan")}</div><strong class="disk-percent">${formatBytes(entry.sizeBytes)}</strong></div>`).join("")}</div>` : `<div class="disk-docker-body"><div class="empty-mini">/var/log could not be read or is empty.</div></div>`}
  </section>`;
}

export function diskMountKind(mount: DiskMount): string {
  const fs = mount.filesystem.toLowerCase();
  if (fs.startsWith("nfs") || fs.includes(":/") || fs.startsWith("cifs") || fs.startsWith("smb")) return "network mount";
  if (fs.startsWith("tmpfs") || fs.startsWith("devtmpfs") || fs.startsWith("overlay") || fs.startsWith("squashfs")) return "virtual";
  return "local";
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value));
}

export function renderDockerDiskPanel(usage: NonNullable<DiskExplorerSnapshot["dockerUsage"]>): string {
  const rows = [
    ["Images", usage.imagesBytes],
    ["Containers", usage.containersBytes],
    ["Volumes", usage.volumesBytes],
    ["Build cache", usage.buildCacheBytes],
    ...(usage.otherBytes > 0 ? [["Other", usage.otherBytes] as [string, number]] : []),
  ] as Array<[string, number]>;
  return `<section class="panel"><div class="panel-head compact"><div><div class="panel-kicker">Container runtime</div><h2>Docker disk usage</h2><p>Reported by docker system df. Reclaimable is what a prune would free.</p></div><button class="button button-quiet small-button" data-disk-open-path="/var/lib/docker" title="Open Docker data root in Files">${icon("folder")} /var/lib/docker</button></div>
    <div class="disk-docker-body">
      <div class="disk-stat-cards">${rows.map(([label, bytes]) => `<div class="network-stat"><span class="stat-icon orange">${icon("docker")}</span><div><strong>${formatBytes(bytes)}</strong><span>${label}</span></div></div>`).join("")}</div>
      <div class="machine-details"><div><span>Total</span><strong>${formatBytes(usage.totalBytes)}</strong></div><div><span>Reclaimable</span><strong>${formatBytes(usage.reclaimableBytes)}</strong></div></div>
    </div>
  </section>`;
}

export async function selectDiskTab(tab: DiskTab): Promise<void> {
  state.diskTab = tab;
  state.errorMessage = "";
  render();
  if (tab === "varlog") await ensureDiskVarLog(false);
}

/// Loads /var/log usage on demand. `force` re-measures even when cached
/// (the tab's reload button); plain tab switches reuse the cached result.
export async function ensureDiskVarLog(force: boolean): Promise<void> {
  const serverId = state.activeServerId;
  if (!serverId || (state.diskVarLog && !force) || state.diskVarLogLoading) return;
  state.diskVarLogLoading = true;
  if (!state.diskVarLog || force) render();
  try {
    const entries = await invokeCommand<LargestDirectory[]>("get_disk_varlog", { serverId });
    if (state.activeServerId !== serverId) return;
    state.diskVarLog = entries;
  } catch (error) {
    setError(error);
  } finally {
    state.diskVarLogLoading = false;
    if (state.activeServerId === serverId && state.activeView === "disk") render();
  }
}

export async function openDiskPathInFiles(path: string): Promise<void> {
  state.remotePath = parentPath(path);
  state.remoteFileSearch = "";
  state.remoteFiles = [];
  state.filesHaveMore = false;
  state.errorMessage = "";
  await setView("files");
}
