import { icon } from "../../icons";
import { escapeHtml } from "../format";
import { LOG_LINE_OPTIONS, activeCapabilities, state } from "../state";
import type { LogTarget, LogViewerState } from "../types";

export function renderLogLineOptions(selected: number): string {
  return LOG_LINE_OPTIONS.map((value) => `<option value="${value}" ${selected === value ? "selected" : ""}>${value}</option>`).join("");
}

export function renderLogSinceOptions(selected: string): string {
  return `<option value="" ${!selected ? "selected" : ""}>Any time</option><option value="1 hour ago" ${selected === "1 hour ago" ? "selected" : ""}>Last hour</option><option value="today" ${selected === "today" ? "selected" : ""}>Today</option>`;
}

export function renderLogs(): string {
  const cap = activeCapabilities();
  const systemLogLabel = cap?.journalctl ? "System journal" : cap?.logread ? "Syslog buffer" : "System logs";
  const source = state.logsViewer.target.source;
  const sourceControl = `<div class="logs-control-group"><span class="control-label">Source</span><div class="segmented-control"><button class="${source === "system" ? "active" : ""}" data-logs-source="system">${icon("services")} ${systemLogLabel}</button><button class="${source === "container" ? "active" : ""}" data-logs-source="container" ${cap && !cap.docker && !cap.podman ? "disabled" : ""}>${icon("docker")} Container</button><button class="${source === "file" ? "active" : ""}" data-logs-source="file">${icon("folder")} File</button></div></div>`;
  let sourceFields = "";
  if (source === "system") {
    sourceFields = `<label class="field compact-field"><span>Service (optional)</span><input data-field="log-service" data-log-scope="workspace" value="${escapeHtml(state.logsViewer.target.service ?? "")}" placeholder="nginx.service" ${cap?.journalctl ? "" : "disabled"}/></label>`;
  } else if (source === "container") {
    sourceFields = `<label class="field compact-field"><span>Container</span><select data-field="log-container" data-log-scope="workspace"><option value="">Choose a container…</option>${state.docker?.containers.map((container) => `<option value="${escapeHtml(container.name || container.id)}" ${state.logsViewer.target.container === (container.name || container.id) ? "selected" : ""}>${escapeHtml(container.name || container.id)}</option>`).join("") ?? ""}</select></label>`;
  } else if (source === "file") {
    sourceFields = `<label class="field compact-field log-location-field"><span>Location</span><select data-field="log-file-container" data-log-scope="workspace"><option value="" ${!state.logsViewer.target.container ? "selected" : ""}>Server filesystem</option>${state.docker?.containers.map((container) => `<option value="${escapeHtml(container.name || container.id)}" ${state.logsViewer.target.container === (container.name || container.id) ? "selected" : ""}>${escapeHtml(container.name || container.id)}</option>`).join("") ?? ""}</select></label><label class="field compact-field log-path-field"><span>Absolute path</span><input data-field="log-file-path" data-log-scope="workspace" list="log-file-choices" value="${escapeHtml(state.logsViewer.target.filePath ?? "")}" placeholder="/var/log/nginx/error.log"/><datalist id="log-file-choices">${state.discoveredLogFiles.map((path) => `<option value="${escapeHtml(path)}"></option>`).join("")}</datalist></label>`;
  }
  return renderLogViewer(state.logsViewer, "workspace", sourceControl, sourceFields, false);
}

export function renderLogViewer(viewer: LogViewerState, scope: "workspace" | "container", sourceControl: string, sourceFields: string, embedded: boolean): string {
  const cap = activeCapabilities();
  const sinceDisabled = viewer.target.source === "file" || (viewer.target.source === "system" && !cap?.journalctl);
  const lineCount = countLogLines(viewer.text);
  const statusLabel = viewer.status === "live" ? "Live" : viewer.status === "polling" ? "Live · polling" : viewer.status === "paused" ? "Paused" : viewer.status === "loading" ? "Catching up" : viewer.status === "stopped" ? "Stopped" : "Ready";
  const followLabel = viewer.following ? "Pause" : viewer.status === "paused" ? "Resume" : "Follow";
  const controls = `<div class="logs-controls panel">${sourceControl}${sourceFields}<label class="field compact-field"><span>Since</span><select data-field="log-since" data-log-scope="${scope}" ${sinceDisabled ? "disabled" : ""}>${renderLogSinceOptions(viewer.since)}</select></label><label class="field compact-field log-lines-field"><span>Lines</span><select data-field="log-lines" data-log-scope="${scope}">${renderLogLineOptions(viewer.lines)}</select></label><button class="button button-primary logs-run" data-action="load-log-viewer" data-log-scope="${scope}" ${state.activeOperation ? "disabled" : ""}>${icon("refresh")} Load logs</button><label class="follow-toggle" title="${followLabel} live output"><input type="checkbox" data-field="log-follow" data-log-scope="${scope}" ${viewer.following ? "checked" : ""}/><span></span>${followLabel}</label><span class="log-live-state ${viewer.status}"><i></i>${statusLabel}</span></div>`;
  const panel = `<div class="panel log-panel ${embedded ? "container-log-panel" : ""}"><div class="log-head"><div><div class="panel-kicker">${escapeHtml(logKicker(viewer.target))}</div><h2>${escapeHtml(viewer.target.label)}</h2><small class="log-line-count" data-log-count="${scope}">${lineCount} ${lineCount === 1 ? "line" : "lines"}</small></div><div class="log-actions"><label class="log-search"><span>${icon("search")}</span><input data-field="log-query" data-log-scope="${scope}" value="${escapeHtml(viewer.query)}" placeholder="Search output…"/><select data-field="log-severity" data-log-scope="${scope}"><option value="all" ${viewer.severity === "all" ? "selected" : ""}>All levels</option><option value="error" ${viewer.severity === "error" ? "selected" : ""}>Errors</option><option value="warn" ${viewer.severity === "warn" ? "selected" : ""}>Warnings</option></select></label><button class="icon-button" data-action="copy-log-viewer" data-log-scope="${scope}" title="Copy logs">${icon("copy")}</button><button class="icon-button" data-action="clear-log-viewer" data-log-scope="${scope}" title="Clear logs">${icon("trash")}</button></div></div><pre class="log-output" data-log-output="${scope}">${escapeHtml(filteredLogs(viewer))}</pre></div>`;
  return `<section class="logs-workspace ${embedded ? "embedded-log-workspace" : ""}">${controls}${panel}</section>`;
}

export function logKicker(target: LogTarget): string {
  if (target.source === "system") return activeCapabilities()?.journalctl ? "system journal" : "syslog buffer";
  if (target.source === "compose") return "Compose output";
  if (target.source === "file") return target.container ? "container file" : "server file";
  return "container output";
}

export function filteredLogs(viewer: LogViewerState): string {
  if (!viewer.text) return "Load a log source to begin.";
  const query = viewer.query.trim().toLowerCase();
  return viewer.text.split("\n").filter((line) => {
    const lower = line.toLowerCase();
    const queryMatch = !query || lower.includes(query);
    const severityMatch = viewer.severity === "all" || (viewer.severity === "error" ? /error|fail|fatal|crit/.test(lower) : /warn|notice/.test(lower));
    return queryMatch && severityMatch;
  }).join("\n") || "No log lines match the current filter.";
}

export function countLogLines(value: string): number {
  return value ? value.replace(/\n$/, "").split("\n").length : 0;
}
