import { icon } from "../../icons";
import type { ContainerInfo } from "../../types";
import { containerLogBelongsToActiveTab } from "../actions/containers";
import { escapeHtml, meter } from "../format";
import { renderViewLoading } from "../render";
import { activeCapabilities, state } from "../state";
import { shortId } from "../workspace";
import { renderCommandResults, renderUnsupported } from "./admin";
import { renderLogViewer } from "./logs";
import { renderCollectionFooter } from "./system";

export function renderDocker(): string {
  const cap = activeCapabilities();
  if (cap && !cap.docker && !cap.podman) return renderUnsupported("No container runtime is available", "The SSH endpoint is not a Docker or Podman host. Install Docker or Podman on that server and reconnect; hbox-term will detect it automatically.");
  return `<section class="docker-workspace"><div class="subnav-tabs workspace-tabs container-platform-tabs"><button class="subnav-tab ${state.containerPlatformTab === "runtime" ? "active" : ""}" data-container-platform-tab="runtime">Runtime resources</button><button class="subnav-tab ${state.containerPlatformTab === "compose" ? "active" : ""}" data-container-platform-tab="compose">Compose projects</button></div>${state.containerPlatformTab === "compose" ? renderComposeProjects() : renderRuntimeResources()}${containerLogBelongsToActiveTab() ? renderContainerLogs() : ""}</section>`;
}

export function renderRuntimeResources(): string {
  if (!state.docker) return renderViewLoading();
  const currentDocker = state.docker;
  return `<div class="docker-summary"><div class="docker-runtime"><span class="docker-mark">${icon("docker")}</span><div><div class="panel-kicker">Container runtime</div><h2>${escapeHtml(currentDocker.runtime)}</h2><p>Each resource type loads independently in manageable pages.</p></div></div><div class="docker-summary-stats">${(["containers", "images", "volumes", "networks"] as const).map((section) => `<div><strong>${state.dockerLoaded[section] ? currentDocker[section].length : "—"}${state.dockerHasMore[section] ? "+" : ""}</strong><span>${section} loaded</span></div>`).join("")}</div></div><div class="subnav-tabs">${(["containers", "images", "volumes", "networks"] as const).map((tab) => `<button class="subnav-tab ${state.dockerTab === tab ? "active" : ""}" data-docker-tab="${tab}">${tab[0].toUpperCase() + tab.slice(1)} <span>${state.dockerLoaded[tab] ? `${currentDocker[tab].length}${state.dockerHasMore[tab] ? "+" : ""}` : "·"}</span></button>`).join("")}<span class="subnav-spacer"></span><button class="button button-quiet" data-action="docker-pull">${icon("download")} Pull image</button><button class="button button-primary" data-action="docker-create">${icon("plus")} Create container</button></div>${!state.dockerLoaded[state.dockerTab] ? `<div class="collection-loading" role="status"><div class="spinner"></div><span>Loading ${state.dockerTab}…</span></div>` : state.dockerTab === "containers" ? renderContainers() : state.dockerTab === "images" ? renderImages() : state.dockerTab === "volumes" ? renderVolumes() : renderNetworks()}`;
}

export function renderComposeProjects(): string {
  return `<section class="panel"><div class="panel-head"><div><div class="panel-kicker">Docker Compose</div><h2>${state.composeProjects.length} Compose ${state.composeProjects.length === 1 ? "project" : "projects"} found</h2><p>Scans common deployment locations for Compose configuration files.</p></div><button class="icon-button" data-action="refresh">${icon("refresh")}</button></div><div class="tier3-grid">${state.composeProjects.length ? state.composeProjects.map((project) => {
    const actions = ["up", "down", "restart", "pull", "rebuild", "logs", "exec", "scale"];
    return `<article class="tier3-card"><div class="tier3-card-head"><span class="stat-icon cyan">${icon("docker")}</span><span class="status-badge ${project.running ? "status-good" : ""}"><i></i>${project.running} running</span></div><h3>${escapeHtml(project.name)}</h3><code>${escapeHtml(project.path)}</code><p>${project.services.length ? project.services.map((service) => `<span class="tag-chip">${escapeHtml(service)}</span>`).join(" ") : "No services returned"}</p>${project.topology.length ? `<div class="compose-meta"><strong>Topology</strong><span>${project.topology.map(escapeHtml).join(" · ")}</span></div>` : ""}${project.environment.length ? `<details class="compose-environment"><summary>Environment keys (${project.environment.length})</summary><span>${project.environment.map(escapeHtml).join(" · ")}</span></details>` : ""}<div class="tier3-card-actions">${actions.map((action) => {
      const execUnavailable = action === "exec" && project.running === 0;
      return `<button class="button button-quiet small-button" data-compose-action="${action}" data-compose-path="${escapeHtml(project.path)}" ${execUnavailable ? "disabled title=\"Start a Compose service before running a command\"" : ""}>${action}</button>`;
    }).join("")}</div></article>`;
  }).join("") : `<div class="empty-state compact-empty"><h2>No Compose projects found</h2><p>Projects under the remote home, /opt, /srv, and /var/www appear here.</p></div>`}</div>${renderCommandResults()}</section>`;
}

export function renderContainerLogs(): string {
  if (!state.containerLogViewer) return "";
  const project = state.containerLogViewer.target.source === "compose"
    ? state.composeProjects.find((item) => item.path === state.containerLogViewer?.target.composePath)
    : undefined;
  const targetField = project?.services.length
    ? `<label class="field compact-field"><span>Service</span><select data-field="log-service" data-log-scope="container"><option value="" ${!state.containerLogViewer.target.service ? "selected" : ""}>All services</option>${project.services.map((service) => `<option value="${escapeHtml(service)}" ${state.containerLogViewer?.target.service === service ? "selected" : ""}>${escapeHtml(service)}</option>`).join("")}</select></label>`
    : "";
  return renderLogViewer(state.containerLogViewer, "container", "", targetField, true);
}

export function renderContainers(): string {
  return `<section class="panel table-panel"><div class="panel-head compact"><div><div class="panel-kicker">All containers</div><h2>${state.docker?.containers.length ?? 0} containers loaded</h2></div><button class="icon-button" data-action="refresh">${icon("refresh")}</button></div><div class="container-grid">${state.docker?.containers.length ? state.docker.containers.map(renderContainerCard).join("") : `<div class="empty-state compact-empty"><div class="empty-art">${icon("docker")}</div><h2>No containers yet</h2><p>Create the first one from an image.</p></div>`}</div>${renderCollectionFooter(state.dockerHasMore.containers, state.docker?.containers.length ?? 0, "containers")}</section>`;
}

export function renderContainerCard(container: ContainerInfo): string {
  const status = container.state.trim().toLowerCase();
  const paused = status === "paused";
  const running = status === "running" || paused;
  const canExec = status === "running";
  const execState = canExec ? "" : "disabled title=\"Start the container before opening an exec shell\"";
  return `<article class="container-card"><div class="container-card-head"><span class="container-status ${running ? "running" : "stopped"}"><i></i>${escapeHtml(container.state || "unknown")}</span><button class="icon-button small" data-docker-inspect="${escapeHtml(container.id)}" data-docker-kind="container">${icon("more")}</button></div><h3>${escapeHtml(container.name || shortId(container.id))}</h3><p class="container-image">${escapeHtml(container.image)}</p><div class="container-metrics"><div><span>CPU</span><strong>${container.cpuPercent?.toFixed(1) ?? "—"}%</strong>${meter(container.cpuPercent ?? 0, "accent")}</div><div><span>Memory</span><strong>${container.memoryPercent?.toFixed(1) ?? "—"}%</strong>${meter(container.memoryPercent ?? 0, "green")}</div></div>${container.ports ? `<div class="container-ports">${icon("network")} ${escapeHtml(container.ports)}</div>` : ""}<div class="container-card-foot"><span>${escapeHtml(container.status || "No status")}</span><div class="row-actions">${running ? `<button class="row-action" data-docker-action="restart" data-docker-target="${escapeHtml(container.id)}" title="Restart">${icon("restart")}</button><button class="row-action" data-docker-action="stop" data-docker-target="${escapeHtml(container.id)}" title="Stop">${icon("stop")}</button><button class="row-action" data-docker-action="${paused ? "unpause" : "pause"}" data-docker-target="${escapeHtml(container.id)}" title="${paused ? "Unpause" : "Pause"}">${icon("pause")}</button>` : `<button class="row-action" data-docker-action="start" data-docker-target="${escapeHtml(container.id)}" title="Start">${icon("play")}</button>`}<button class="row-action" data-docker-logs="${escapeHtml(container.id)}" title="View logs">${icon("logs")}</button><button class="row-action" data-docker-exec="${escapeHtml(container.id)}" ${execState}>${icon("terminalSmall")}</button><button class="row-action danger" data-docker-action="rm" data-docker-target="${escapeHtml(container.id)}" title="Remove">${icon("trash")}</button></div></div></article>`;
}

export function renderImages(): string {
  return `<section class="panel table-panel"><div class="panel-head compact"><div><div class="panel-kicker">Image cache</div><h2>${state.docker?.images.length ?? 0} images loaded</h2></div><button class="icon-button" data-action="refresh">${icon("refresh")}</button></div><div class="table-scroll"><table><thead><tr><th>Repository</th><th>Tag</th><th>Image ID</th><th>Size</th><th>Created</th><th></th></tr></thead><tbody>${state.docker?.images.length ? state.docker.images.map((image) => `<tr><td><strong>${escapeHtml(image.repository)}</strong></td><td><span class="tag-chip">${escapeHtml(image.tag)}</span></td><td class="mono muted-text">${escapeHtml(image.id)}</td><td class="muted-text">${escapeHtml(image.size)}</td><td class="muted-text">${escapeHtml(image.created)}</td><td><div class="row-actions"><button class="row-action" data-docker-inspect="${escapeHtml(image.id)}" data-docker-kind="image">${icon("info")}</button><button class="row-action danger" data-docker-action="rmi" data-docker-target="${escapeHtml(image.id)}">${icon("trash")}</button></div></td></tr>`).join("") : `<tr><td colspan="6"><div class="empty-table">No images returned.</div></td></tr>`}</tbody></table></div>${renderCollectionFooter(state.dockerHasMore.images, state.docker?.images.length ?? 0, "images")}</section>`;
}

export function renderVolumes(): string {
  return `<section class="panel table-panel"><div class="panel-head compact"><div><div class="panel-kicker">Persistent data</div><h2>${state.docker?.volumes.length ?? 0} volumes loaded</h2></div><div class="table-head-actions"><button class="button button-quiet small-button" data-action="docker-create-volume">${icon("plus")} Volume</button><button class="icon-button" data-action="refresh">${icon("refresh")}</button></div></div><div class="table-scroll"><table><thead><tr><th>Name</th><th>Driver</th><th>Mountpoint</th><th></th></tr></thead><tbody>${state.docker?.volumes.length ? state.docker.volumes.map((volume) => `<tr><td><strong>${escapeHtml(volume.name)}</strong></td><td><span class="tag-chip">${escapeHtml(volume.driver)}</span></td><td class="mono muted-text">${escapeHtml(volume.mountpoint || "—")}</td><td><div class="row-actions"><button class="row-action" data-docker-inspect="${escapeHtml(volume.name)}" data-docker-kind="volume">${icon("info")}</button><button class="row-action danger" data-docker-action="volume-rm" data-docker-target="${escapeHtml(volume.name)}">${icon("trash")}</button></div></td></tr>`).join("") : `<tr><td colspan="4"><div class="empty-table">No volumes returned.</div></td></tr>`}</tbody></table></div>${renderCollectionFooter(state.dockerHasMore.volumes, state.docker?.volumes.length ?? 0, "volumes")}</section>`;
}

export function renderNetworks(): string {
  return `<section class="panel table-panel"><div class="panel-head compact"><div><div class="panel-kicker">Container networking</div><h2>${state.docker?.networks.length ?? 0} networks loaded</h2></div><div class="table-head-actions"><button class="button button-quiet small-button" data-action="docker-create-network">${icon("plus")} Network</button><button class="icon-button" data-action="refresh">${icon("refresh")}</button></div></div><div class="table-scroll"><table><thead><tr><th>Name</th><th>Driver</th><th>Scope</th><th>ID</th><th></th></tr></thead><tbody>${state.docker?.networks.length ? state.docker.networks.map((network) => `<tr><td><strong>${escapeHtml(network.name)}</strong></td><td><span class="tag-chip">${escapeHtml(network.driver)}</span></td><td class="muted-text">${escapeHtml(network.scope)}</td><td class="mono muted-text">${escapeHtml(network.id)}</td><td><div class="row-actions"><button class="row-action" data-docker-inspect="${escapeHtml(network.name)}" data-docker-kind="network">${icon("info")}</button><button class="row-action danger" data-docker-action="network-rm" data-docker-target="${escapeHtml(network.name)}">${icon("trash")}</button></div></td></tr>`).join("") : `<tr><td colspan="5"><div class="empty-table">No networks returned.</div></td></tr>`}</tbody></table></div>${renderCollectionFooter(state.dockerHasMore.networks, state.docker?.networks.length ?? 0, "networks")}</section>`;
}
