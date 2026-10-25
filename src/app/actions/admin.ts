import type { CommandResult, TunnelConfig, TunnelStatus } from "../../types";
import { listeningEndpoint } from "../ports";
import { errorText, OperationCancelledError } from "../command-client";
import { confirm, finishAppDialog, finishTextInput, requestTextInput } from "../modals";
import { render } from "../render";
import { finishHostKeyPrompt, finishMasterPasswordPrompt, invokeCommand, setError } from "../session";
import { activeServer, state } from "../state";
import { showToast } from "../toasts";
import { loadActiveView, loadAdministrationTab, setCommandResults } from "../workspace";
import { openComposeLogs } from "./containers";

export async function copyText(value: string): Promise<void> {
  if (!value) return;
  try { await navigator.clipboard.writeText(value); showToast("Copied to the clipboard."); } catch (error) { setError(error); }
}

export async function runComposeAction(path: string, action: string): Promise<void> {
  if (!state.activeServerId) return;
  const project = state.composeProjects.find((item) => item.path === path);
  if (action === "logs") {
    await openComposeLogs(path, project?.name ?? path);
    return;
  }
  if (action === "scale") {
    if (!project?.services.length) {
      setError("No Compose services are available to scale");
      return;
    }
    state.composeScaleProject = project;
    state.modal = "compose-scale";
    render();
    return;
  }
  let service: string | undefined; let command: string | undefined;
  if (action === "exec" && !project?.services.length) {
    setError("No Compose services are available for exec");
    return;
  }
  if (action === "exec" && (!project || project.running === 0)) {
    showToast("Start a Compose service before running a command.", "info");
    return;
  }
  if (["restart", "exec"].includes(action) && project?.services.length) {
    const selectedService = await requestTextInput({ title: action === "exec" ? "Run command in Compose service" : "Restart Compose service", label: "Service", defaultValue: project.services[0], allowEmpty: action === "restart", choices: project.services });
    if (selectedService === null) return;
    service = selectedService || undefined;
  }
  if (action === "exec") {
    const enteredCommand = await requestTextInput({ title: "Run command in Compose service", label: `Command for ${service}`, defaultValue: "id && pwd", multiline: true });
    if (enteredCommand === null || !enteredCommand.trim()) return;
    command = enteredCommand.trim();
  }
  if (["down", "rebuild"].includes(action) && !await confirm(`${action} ${project?.name ?? path}?`, { title: "Confirm Compose action", kind: "warning" })) return;
  try {
    const output = await invokeCommand<string>("compose_action", { serverId: state.activeServerId, path, action, service, command, lines: undefined, since: undefined });
    if (action === "exec") setCommandResults([{ serverId: state.activeServerId, serverName: project?.name ?? "Compose", stdout: output, stderr: "", exitCode: 0 }], false);
    state.composeProjectsServerId = null;
    await loadActiveView();
    if (action === "exec" && state.activeView === "docker" && state.containerPlatformTab === "compose") {
      state.shouldScrollToCommandResults = true;
      render();
    }
  } catch (error) {
    if (action === "exec" && /(?:service|container).*not running/i.test(errorText(error))) {
      showToast(`Start ${service ?? "the selected service"} before running a command.`, "info");
      return;
    }
    if (action === "exec" && !(error instanceof OperationCancelledError) && !errorText(error).toLowerCase().includes("operation cancelled")) {
      setCommandResults([{
        serverId: state.activeServerId,
        serverName: project?.name ?? "Compose",
        stdout: "",
        stderr: "",
        exitCode: 1,
        error: errorText(error),
      }]);
      render();
      return;
    }
    setError(error);
  }
}

export async function submitComposeScaleForm(form: HTMLFormElement): Promise<void> {
  if (!state.activeServerId || !state.composeScaleProject) return;
  const project = state.composeScaleProject;
  const data = new FormData(form);
  const service = String(data.get("service") ?? "").trim();
  const replicas = String(data.get("replicas") ?? "").trim();
  if (!project.services.includes(service) || !/^\d+$/.test(replicas)) return;
  try {
    await invokeCommand<string>("compose_action", { serverId: state.activeServerId, path: project.path, action: "scale", service: undefined, command: `${service}=${replicas}`, lines: undefined, since: undefined });
    state.modal = null;
    state.composeScaleProject = null;
    state.composeProjectsServerId = null;
    await loadActiveView();
  } catch (error) { setError(error); }
}

export async function runFirewallAction(action: string, port?: number, protocol?: string, source?: string): Promise<void> {
  if (!state.activeServerId) return;
  if (["disable", "deny"].includes(action) && !await confirm("This firewall change may block SSH access. Continue only if the current SSH port remains allowed.", { title: "Possible SSH lockout", kind: "warning" })) return;
  try { await invokeCommand("firewall_action", { serverId: state.activeServerId, action, port, protocol, source: source || undefined }); await loadAdministrationTab(); } catch (error) { setError(error); }
}

export async function submitFirewallForm(form: HTMLFormElement, submitter: HTMLButtonElement | null): Promise<void> {
  const data = new FormData(form); await runFirewallAction(submitter?.value || "allow", Number(data.get("port")), String(data.get("protocol") ?? "tcp"), String(data.get("source") ?? "").trim());
}

export async function addAuthorizedKey(): Promise<void> {
  if (!state.activeServerId) return; const key = await requestTextInput({ title: "Add authorized key", label: "OpenSSH public key", defaultValue: "", multiline: true, placeholder: "ssh-ed25519 AAAA…" }); if (!key) return;
  try { await invokeCommand("authorized_key_action", { serverId: state.activeServerId, action: "add", key: key.trim() }); await loadAdministrationTab(); } catch (error) { setError(error); }
}

export async function removeAuthorizedKey(id: string): Promise<void> {
  if (!state.activeServerId) return; const key = state.authorizedKeys.find((item) => item.id === id); if (!key || !await confirm(`Remove ${key.fingerprint}? Make sure another login method works first.`, { title: "Remove authorized key", kind: "warning" })) return;
  try { await invokeCommand("authorized_key_action", { serverId: state.activeServerId, action: "remove", key: key.key }); await loadAdministrationTab(); } catch (error) { setError(error); }
}

export async function runQuickAction(action: string): Promise<void> {
  if (!state.activeServerId) return;
  if (["reboot", "shutdown", "restart-ssh", "clear-cache"].includes(action) && !await confirm(`Run ${action.replaceAll("-", " ")} on ${activeServer()?.name}?`, { title: "Confirm server action", kind: "warning" })) return;
  try { const output = await invokeCommand<string>("run_quick_action", { serverId: state.activeServerId, action }); setCommandResults([{ serverId: state.activeServerId, serverName: activeServer()?.name ?? "Server", stdout: output, stderr: "", exitCode: 0 }]); render(); } catch (error) { setError(error); }
}

export async function saveCommandForm(form: HTMLFormElement): Promise<void> {
  if (!state.activeServerId) return; const data = new FormData(form);
  try { await invokeCommand("save_saved_command", { input: { id: state.editingCommand?.id, serverId: data.get("global") === "on" ? undefined : state.activeServerId, name: String(data.get("name") ?? ""), command: String(data.get("command") ?? "") } }); state.modal = null; state.editingCommand = null; await loadActiveView(); } catch (error) { setError(error); }
}

export async function runSavedCommand(id: string): Promise<void> {
  if (!state.activeServerId) return; const item = state.savedCommands.find((command) => command.id === id); if (!item) return;
  try { setCommandResults([await invokeCommand<CommandResult>("run_saved_command", { serverId: state.activeServerId, command: item.command })]); render(); } catch (error) { setError(error); }
}

export async function deleteSavedCommand(id: string): Promise<void> {
  const item = state.savedCommands.find((command) => command.id === id); if (!item || !await confirm(`Delete “${item.name}”?`, { title: "Delete saved command", kind: "warning" })) return;
  try { await invokeCommand("delete_saved_command", { id }); await loadActiveView(); } catch (error) { setError(error); }
}

export async function saveTunnelForm(form: HTMLFormElement): Promise<void> {
  if (!state.activeServerId) return; const data = new FormData(form);
  const input = { id: state.editingTunnel?.id, serverId: state.activeServerId, name: String(data.get("name") ?? ""), kind: String(data.get("kind") ?? "local"), bindHost: String(data.get("bindHost") ?? "127.0.0.1"), bindPort: Number(data.get("bindPort")), targetHost: String(data.get("targetHost") ?? ""), targetPort: Number(data.get("targetPort") || 1) };
  if (!["127.0.0.1", "::1", "localhost"].includes(input.bindHost) && !await confirm(`Binding to ${input.bindHost} may expose this tunnel to other machines. Continue?`, { title: "Public tunnel binding", kind: "warning" })) return;
  try { if (state.editingTunnel && state.tunnelStatuses.find((status) => status.id === state.editingTunnel?.id)?.running) await invokeCommand("stop_tunnel", { id: state.editingTunnel.id }); await invokeCommand("save_tunnel", { input }); state.modal = null; state.editingTunnel = null; await loadActiveView(); } catch (error) { setError(error); }
}

export async function toggleTunnel(id: string, running: boolean): Promise<void> {
  try { await invokeCommand(running ? "stop_tunnel" : "start_tunnel", { id }); await new Promise((resolve) => window.setTimeout(resolve, 120)); await loadActiveView(); } catch (error) { setError(error); }
}

export async function deleteTunnel(id: string): Promise<void> {
  if (!await confirm("Delete this saved tunnel?", { title: "Delete tunnel", kind: "warning" })) return;
  try { await invokeCommand("stop_tunnel", { id }); await invokeCommand("delete_tunnel", { id }); await loadActiveView(); } catch (error) { setError(error); }
}

export function closeModal(): void {
  if (state.finishAppDialogWaiter) {
    finishAppDialog(false);
    return;
  }
  if (state.modal === "master-password" && state.masterPasswordWaiter) {
    finishMasterPasswordPrompt(null);
    return;
  }
  if (state.modal === "host-key" && state.hostKeyWaiter) {
    finishHostKeyPrompt(false);
    return;
  }
  if (state.modal === "input-prompt" && state.finishTextInputWaiter) {
    finishTextInput(null);
    return;
  }
  state.modal = null;
  state.composeScaleProject = null;
  state.renamingWorkspaceTabId = null;
  state.serviceDetails = null;
  state.inspectText = "";
  state.credentialSettingsError = "";
  state.credentialSettingsNotice = "";
  render();
}

/**
 * Forwards a remote listening port to localhost (one click from the Network view): reuses a saved
 * tunnel to the same target, keeps the same port number locally when it is free, and starts it.
 */
export async function forwardPort(localAddress: string): Promise<void> {
  const serverId = state.activeServerId;
  const endpoint = listeningEndpoint(localAddress);
  if (!serverId || !endpoint) return;
  try {
    const tunnels = await invokeCommand<TunnelConfig[]>("get_tunnels", { serverId });
    let tunnel = tunnels.find((item) => item.kind === "local" && item.targetHost === endpoint.host && item.targetPort === endpoint.port);
    if (!tunnel) {
      const bindPort = await invokeCommand<number>("free_local_port", { preferred: endpoint.port });
      tunnel = await invokeCommand<TunnelConfig>("save_tunnel", { input: {
        serverId, name: `Port ${endpoint.port}`, kind: "local", bindHost: "127.0.0.1", bindPort, targetHost: endpoint.host, targetPort: endpoint.port,
      } });
    }
    const statuses = await invokeCommand<TunnelStatus[]>("get_tunnel_statuses", { serverId });
    if (!statuses.find((status) => status.id === tunnel.id)?.running) await invokeCommand("start_tunnel", { id: tunnel.id });
    showToast(`localhost:${tunnel.bindPort} now forwards to port ${endpoint.port} on the server.`, "success");
  } catch (error) {
    setError(error);
  }
}

