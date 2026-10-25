import type { ContainerExec, DockerPage, ServiceDetails } from "../../types";
import { confirm, requestTextInput } from "../modals";
import { render } from "../render";
import { cancelCurrentOperation, invokeCommand, setError } from "../session";
import { createLogViewer, DOCKER_PAGE_SIZE, state } from "../state";
import { openNewTerminal } from "../terminal";
import { showToast } from "../toasts";
import type { LogTarget } from "../types";
import { clearCommandResults, clearRefreshTimer, loadActiveView, shortId, viewRequestIsCurrent } from "../workspace";
import { loadLogViewer, stopLogViewer, updateLogTargetLabel } from "./logs";
import { mergeDockerPage } from "./remote";

export async function runProcessAction(pid: number, force: boolean): Promise<void> {
  if (!state.activeServerId) return;
  try { await invokeCommand("signal_process", { serverId: state.activeServerId, pid, force }); await loadActiveView(); } catch (error) { setError(error); }
}

export async function openServiceDetails(service: string): Promise<void> {
  if (!state.activeServerId) return;
  state.modal = "service"; state.serviceDetails = null; render();
  try { state.serviceDetails = await invokeCommand<ServiceDetails>("get_service_details", { serverId: state.activeServerId, service }); render(); } catch (error) { setError(error); }
}

export async function runServiceAction(action: string, service: string): Promise<void> {
  if (!state.activeServerId || !service) return;
  if (["stop", "disable"].includes(action) && !await confirm(`${action[0].toUpperCase() + action.slice(1)} ${service}?`, { title: "Confirm service action", kind: "warning" })) return;
  try { await invokeCommand("service_action", { serverId: state.activeServerId, service, action }); await loadActiveView(); if (state.modal === "service") await openServiceDetails(service); } catch (error) { setError(error); }
}

export async function dockerAction(action: string, target: string): Promise<void> {
  if (!state.activeServerId) return;
  if (["rm", "rmi", "volume-rm", "network-rm"].includes(action) && !await confirm(`Run ${action} on ${target}?`, { title: "Confirm container action", kind: "warning" })) return;
  try { await invokeCommand("docker_action", { serverId: state.activeServerId, action, target }); await loadActiveView(false, true); } catch (error) { setError(error); }
}

export async function createDockerResource(action: "volume-create" | "network-create", label: string): Promise<void> {
  const name = await requestTextInput({ title: `Create ${label}`, label: `${label[0].toUpperCase() + label.slice(1)} name`, defaultValue: "" });
  if (!name || !state.activeServerId) return;
  try { await invokeCommand("docker_action", { serverId: state.activeServerId, action, target: name.trim() }); await loadActiveView(false, true); } catch (error) { setError(error); }
}

export async function loadDockerLogs(container: string): Promise<void> {
  await openContainerLogs({ source: "container", label: container, container });
}

export async function openComposeLogs(path: string, label: string): Promise<void> {
  await openContainerLogs({ source: "compose", label, composePath: path });
}

export async function openContainerLogs(target: LogTarget): Promise<void> {
  if (!state.activeServerId) return;
  cancelCurrentOperation();
  state.navigationVersion += 1;
  clearRefreshTimer();
  clearCommandResults();
  if (state.containerLogViewer) await stopLogViewer(state.containerLogViewer, "idle");
  state.containerLogViewer = createLogViewer(target, 300);
  state.shouldScrollToContainerLogs = true;
  render();
  await loadLogViewer(state.containerLogViewer, "container", false);
}

export function containerLogBelongsToActiveTab(): boolean {
  return Boolean(state.containerLogViewer && ((state.containerPlatformTab === "compose" && state.containerLogViewer.target.source === "compose") || (state.containerPlatformTab === "runtime" && state.containerLogViewer.target.source === "container")));
}

export async function ensureDockerContainersForLogs(expectedServerId: string, expectedVersion: number): Promise<void> {
  if (!viewRequestIsCurrent(expectedServerId, "logs", expectedVersion)) return;
  if (!state.dockerLoaded.containers || !state.docker) {
    const next = await invokeCommand<DockerPage>("get_docker", { serverId: expectedServerId, section: "containers", offset: 0, limit: DOCKER_PAGE_SIZE });
    if (!viewRequestIsCurrent(expectedServerId, "logs", expectedVersion)) return;
    mergeDockerPage(next);
  }
  while (state.dockerHasMore.containers) {
    const loaded = state.docker?.containers.length ?? 0;
    const next = await invokeCommand<DockerPage>("get_docker", { serverId: expectedServerId, section: "containers", offset: loaded, limit: DOCKER_PAGE_SIZE });
    if (!viewRequestIsCurrent(expectedServerId, "logs", expectedVersion)) return;
    if (!next.containers.length) {
      state.dockerHasMore.containers = false;
      break;
    }
    if (state.docker) state.docker.containers = [...state.docker.containers, ...next.containers];
    state.dockerHasMore.containers = next.hasMore;
  }
  if (!viewRequestIsCurrent(expectedServerId, "logs", expectedVersion)) return;
  const available = state.docker?.containers.map((container) => container.name || container.id) ?? [];
  if (state.logsViewer.target.source === "container" && !available.includes(state.logsViewer.target.container ?? "")) {
    state.logsViewer.target.container = available[0];
    updateLogTargetLabel(state.logsViewer);
  }
}

export async function openDockerTerminal(container: string): Promise<void> {
  const runtime = state.docker?.runtime;
  if (runtime !== "docker" && runtime !== "podman") {
    setError("Could not determine the container runtime. Refresh the Containers view and try again.");
    return;
  }
  const target = state.docker?.containers.find((item) => item.id === container || item.name === container);
  if (target?.state.trim().toLowerCase() !== "running") {
    showToast("Start the container before opening an exec shell.", "info");
    return;
  }
  try {
    const exec = await invokeCommand<ContainerExec>("container_exec", { serverId: state.activeServerId, container });
    state.navigationVersion += 1;
    state.activeView = "terminal";
    clearRefreshTimer();
    render();
    await openNewTerminal(exec.command, `${exec.shell} · ${shortId(container)}`);
  } catch (error) {
    setError(error);
  }
}

export async function openInspect(target: string, kind: string): Promise<void> {
  if (!state.activeServerId) return;
  state.modal = "inspect"; state.inspectText = "Loading…"; render();
  try { state.inspectText = await invokeCommand<string>("docker_inspect", { serverId: state.activeServerId, target, kind }); render(); } catch (error) { setError(error); }
}

export async function pullDockerImage(): Promise<void> {
  const image = await requestTextInput({ title: "Pull image", label: "Image name and tag", defaultValue: "nginx:latest" });
  if (!image || !state.activeServerId) return;
  render();
  try { await invokeCommand("docker_pull", { serverId: state.activeServerId, image }); await loadActiveView(false, true); } catch (error) { setError(error); }
}

export async function createDocker(form: HTMLFormElement): Promise<void> {
  if (!state.activeServerId) return;
  const data = new FormData(form);
  const lines = (key: string) => String(data.get(key) ?? "").split("\n").map((value) => value.trim()).filter(Boolean);
  const input = { image: String(data.get("image") ?? ""), name: String(data.get("name") ?? "") || undefined, command: String(data.get("command") ?? "") || undefined, ports: lines("ports"), environment: lines("environment"), volumes: lines("volumes"), networks: lines("networks"), restartPolicy: String(data.get("restartPolicy") ?? "no"), detached: data.get("detached") === "on", removeOnExit: data.get("removeOnExit") === "on", memoryLimit: String(data.get("memoryLimit") ?? "") || undefined, cpuLimit: String(data.get("cpuLimit") ?? "") || undefined };
  try { await invokeCommand("docker_create", { serverId: state.activeServerId, input }); state.modal = null; await loadActiveView(false, true); } catch (error) { setError(error); }
}
