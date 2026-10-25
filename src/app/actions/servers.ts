import { invoke } from "@tauri-apps/api/core";
import type { CredentialStatus, ServerProfile, ServerSaveResult } from "../../types";
import { errorText } from "../command-client";
import { confirm, profileRouteContains, requestTextInput } from "../modals";
import { normalizedGroupName, render } from "../render";
import { cancelCurrentOperation, errorKind, finishMasterPasswordPrompt, invokeCommand, setError } from "../session";
import { activeServer, connectedServerIds, createLogViewer, dashboardSnapshots, state } from "../state";
import { clearContainerLogs, clearRefreshTimer, closeInteractiveSessions, loadActiveView, refreshSnapshot, resetPaginationState, selectWorkspaceTab, setView } from "../workspace";

export function saveWorkspaceTabRenameForm(form: HTMLFormElement): void {
  const tab = state.openServerTabs.find((item) => item.id === state.renamingWorkspaceTabId);
  if (!tab) return;
  const label = String(new FormData(form).get("label") ?? "").trim();
  tab.label = label || undefined;
  state.renamingWorkspaceTabId = null;
  state.modal = null;
  render();
}

export async function submitMasterPasswordForm(form: HTMLFormElement): Promise<void> {
  const prompt = state.masterPasswordPrompt;
  if (!prompt || !state.finishMasterPasswordWaiter) return;
  const data = new FormData(form);
  const password = String(data.get("masterPassword") ?? "");
  if ([...password].length < 8) {
    prompt.error = "Choose a master password that is at least 8 characters long.";
    render();
    return;
  }
  if (prompt.mode === "setup" && password !== String(data.get("confirmPassword") ?? "")) {
    prompt.error = "The two master passwords do not match.";
    render();
    return;
  }
  finishMasterPasswordPrompt(password);
}

export async function changeMasterPasswordForm(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const currentPassword = String(data.get("currentPassword") ?? "");
  const newPassword = String(data.get("newPassword") ?? "");
  const confirmation = String(data.get("confirmPassword") ?? "");
  state.credentialSettingsError = "";
  if ([...newPassword].length < 8) state.credentialSettingsError = "Choose a new master password that is at least 8 characters long.";
  else if (newPassword !== confirmation) state.credentialSettingsError = "The two new master passwords do not match.";
  if (state.credentialSettingsError) { render(); return; }
  try {
    cancelCurrentOperation();
    clearRefreshTimer();
    await closeInteractiveSessions();
    state.credentialStatus = await invoke<CredentialStatus>("change_master_password", { currentPassword, newPassword });
    connectedServerIds.clear();
    state.connection = null;
    state.dashboard = null;
    dashboardSnapshots.clear();
    state.processes = [];
    state.services = [];
    state.docker = null;
    state.ports = [];
    state.remoteFiles = [];
    state.logsViewer = createLogViewer({ source: "system", label: "System logs" }, 100);
    resetPaginationState();
    state.errorMessage = "";
    state.credentialSettingsError = "";
    state.credentialSettingsNotice = "Master password changed. All saved credentials were re-encrypted with the new password.";
    state.modal = "security";
    render();
  } catch (error) {
    state.credentialSettingsError = errorKind(error) === "masterPasswordInvalid"
      ? "The current master password is incorrect."
      : errorText(error);
    render();
  }
}

export async function resetCredentialsForm(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const password = String(data.get("masterPassword") ?? "");
  const confirmation = String(data.get("confirmation") ?? "");
  state.credentialSettingsError = "";
  if (confirmation !== "RESET") state.credentialSettingsError = "Type RESET exactly to confirm this irreversible action.";
  if (state.credentialSettingsError) { render(); return; }
  try {
    cancelCurrentOperation();
    clearRefreshTimer();
    await closeInteractiveSessions();
    await invoke("reset_credentials", { masterPassword: password });
    connectedServerIds.clear();
    state.credentialStatus = { configured: false, unlocked: false };
    state.connection = null;
    state.dashboard = null;
    dashboardSnapshots.clear();
    state.processes = [];
    state.services = [];
    state.docker = null;
    state.ports = [];
    state.remoteFiles = [];
    state.logsViewer = createLogViewer({ source: "system", label: "System logs" }, 100);
    resetPaginationState();
    state.errorMessage = "";
    state.credentialSettingsError = "";
    state.credentialSettingsNotice = "All saved credentials were deleted. Your server profiles are still here.";
    state.modal = "security";
    render();
  } catch (error) {
    state.credentialSettingsError = errorKind(error) === "masterPasswordInvalid"
      ? "The master password is incorrect. Nothing was reset."
      : errorText(error);
    render();
  }
}

export async function saveServerForm(form: HTMLFormElement, testAfter: boolean): Promise<void> {
  const data = new FormData(form);
  const authMethod = String(data.get("authMethod") ?? "password") as "password" | "privateKey";
  const customKeyPath = String(data.get("customKeyPath") ?? "").trim();
  const selectedKeyPath = String(data.get("keyPath") ?? "").trim();
  const password = String(data.get("password") ?? "");
  const keyPassphrase = String(data.get("keyPassphrase") ?? "");
  const sudoPassword = String(data.get("sudoPassword") ?? "");
  const payload: Record<string, unknown> = {
    id: state.editingServer?.id,
    name: String(data.get("name") ?? ""),
    host: String(data.get("host") ?? ""),
    username: String(data.get("username") ?? ""),
    port: Number(data.get("port") ?? 22),
    authMethod,
    keyPath: authMethod === "privateKey" ? customKeyPath || selectedKeyPath || undefined : undefined,
    jumpHostId: String(data.get("jumpHostId") ?? "").trim() || undefined,
    groupName: normalizedGroupName(String(data.get("groupName") ?? "")) || undefined,
    tags: String(data.get("tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
    notes: String(data.get("notes") ?? ""),
    favorite: data.get("favorite") === "on",
  };
  if (!state.editingServer || password) payload.password = password;
  if (!state.editingServer || keyPassphrase) payload.keyPassphrase = keyPassphrase;
  if (!state.editingServer || sudoPassword) payload.sudoPassword = sudoPassword;
  cancelCurrentOperation();
  state.errorMessage = ""; render();
  try {
    const result = await invokeCommand<ServerSaveResult>("save_server", { draft: payload });
    const saved = result.server;
    for (const invalidatedServerId of result.invalidatedServerIds) {
      await closeInteractiveSessions(invalidatedServerId);
      connectedServerIds.delete(invalidatedServerId);
      for (const tab of state.openServerTabs.filter((item) => item.serverId === invalidatedServerId)) dashboardSnapshots.delete(tab.id);
    }
    await refreshSnapshot(false);
    let workspaceTab = state.openServerTabs.find((item) => item.serverId === saved.id);
    if (!workspaceTab) {
      workspaceTab = { id: crypto.randomUUID(), serverId: saved.id };
      state.openServerTabs.push(workspaceTab);
    }
    state.editingServer = null;
    state.modal = null;
    if (state.activeWorkspaceTabId !== workspaceTab.id) {
      await selectWorkspaceTab(workspaceTab.id);
    } else if (result.invalidatedServerIds.includes(saved.id)) {
      state.connection = null;
      state.dashboard = null;
      state.processes = [];
      state.services = [];
      state.docker = null;
      state.ports = [];
      state.remoteFiles = [];
      state.logsViewer = createLogViewer({ source: "system", label: "System logs" }, 100);
      resetPaginationState();
    }
    render();
    if (testAfter) {
      await testActiveServer();
    } else {
      await setView("dashboard");
    }
  } catch (error) { setError(error); }
}

export async function testActiveServer(): Promise<void> {
  if (!state.activeServerId) return;
  await setView("dashboard");
}

export async function duplicateServer(serverId: string): Promise<void> {
  try {
    const duplicated = await invokeCommand<ServerProfile>("duplicate_server", { serverId });
    await refreshSnapshot(false);
    state.sidebarCopyPlacement = { sourceId: serverId, copyId: duplicated.id };
    state.editingServer = duplicated;
    state.modal = "server";
    render();
  } catch (error) { setError(error); }
}

export async function saveCronForm(form: HTMLFormElement): Promise<void> {
  if (!state.activeServerId) return;
  const data = new FormData(form);
  try {
    await invokeCommand("save_cron_job", { serverId: state.activeServerId, input: { id: state.editingCron?.id, schedule: String(data.get("schedule") ?? ""), command: String(data.get("command") ?? ""), enabled: data.get("enabled") === "on" } });
    state.modal = null; state.editingCron = null; await loadActiveView();
  } catch (error) { setError(error); }
}

export async function runCronAction(id: string, action: string): Promise<void> {
  if (!state.activeServerId) return;
  if (action === "delete" && !await confirm("Delete this cron job?", { title: "Delete cron job", kind: "warning" })) return;
  try { await invokeCommand("cron_action", { serverId: state.activeServerId, id, action }); await loadActiveView(); } catch (error) { setError(error); }
}

export async function openPackageDetails(name: string): Promise<void> {
  if (!state.activeServerId) return;
  state.modal = "package-details"; state.packageDetailsText = ""; render();
  try { state.packageDetailsText = await invokeCommand<string>("get_package_details", { serverId: state.activeServerId, name }); render(); } catch (error) { setError(error); }
}

export async function runPackageAction(action: string, name?: string): Promise<void> {
  if (!state.activeServerId) return;
  const destructive = action === "remove" || action === "upgrade-all";
  if (destructive && !await confirm(action === "remove" ? `Remove ${name}?` : "Install every pending upgrade?", { title: "Confirm package operation", kind: "warning" })) return;
  try {
    await invokeCommand<string>("package_action", { serverId: state.activeServerId, action, name });
    await loadActiveView();
  } catch (error) { setError(error); }
}

export async function createUserForm(form: HTMLFormElement): Promise<void> {
  if (!state.activeServerId) return;
  const data = new FormData(form);
  const input = { name: String(data.get("name") ?? ""), home: String(data.get("home") ?? "") || undefined, shell: String(data.get("shell") ?? "") || undefined, groups: String(data.get("groups") ?? "").split(",").map((item) => item.trim()).filter(Boolean), password: String(data.get("password") ?? "") || undefined };
  try { await invokeCommand("create_user", { serverId: state.activeServerId, input }); state.modal = null; await loadActiveView(); } catch (error) { setError(error); }
}

export async function runUserAction(action: string, name: string): Promise<void> {
  if (!state.activeServerId) return;
  if (action === "password") { state.passwordUser = name; state.modal = "user-password"; render(); return; }
  let value: string | undefined;
  if (action === "shell") { value = (await requestTextInput({ title: "Change login shell", label: `New login shell for ${name}`, defaultValue: state.accounts?.users.find((user) => user.name === name)?.shell ?? "", placeholder: "/bin/sh" })) ?? undefined; if (!value) return; }
  if (action === "groups") {
    value = (await requestTextInput({ title: "Change supplementary groups", label: `Complete comma-separated group list for ${name}`, defaultValue: "", allowEmpty: true, placeholder: "sudo,docker" })) ?? undefined;
    if (value === undefined) return;
    if (!value.trim() && !await confirm(`Remove ${name} from every supplementary group?`, { title: "Clear supplementary groups", kind: "warning" })) return;
  }
  if ((action === "delete-user" || action === "lock") && !await confirm(action === "delete-user" ? `Delete ${name} and their home directory?` : `Lock ${name}?`, { title: "Confirm account change", kind: "warning" })) return;
  try { await invokeCommand("account_action", { serverId: state.activeServerId, action, name, value }); await loadActiveView(); } catch (error) { setError(error); }
}

export async function resetUserPasswordForm(form: HTMLFormElement): Promise<void> {
  if (!state.activeServerId) return;
  const data = new FormData(form);
  const password = String(data.get("password") ?? "");
  if (password !== String(data.get("confirmation") ?? "")) { state.errorMessage = "The passwords do not match."; render(); return; }
  try { await invokeCommand("reset_user_password", { serverId: state.activeServerId, name: state.passwordUser, password }); state.modal = null; state.passwordUser = ""; await loadActiveView(); } catch (error) { setError(error); }
}

export async function createGroup(): Promise<void> {
  if (!state.activeServerId) return;
  const name = (await requestTextInput({ title: "Create group", label: "Group name", defaultValue: "" }))?.trim();
  if (!name) return;
  try { await invokeCommand("account_action", { serverId: state.activeServerId, action: "create-group", name }); await loadActiveView(); } catch (error) { setError(error); }
}

export async function deleteGroup(name: string): Promise<void> {
  if (!state.activeServerId || !await confirm(`Delete group ${name}?`, { title: "Delete group", kind: "warning" })) return;
  try { await invokeCommand("account_action", { serverId: state.activeServerId, action: "delete-group", name }); await loadActiveView(); } catch (error) { setError(error); }
}

export async function deleteServer(serverId: string): Promise<void> {
  const server = state.snapshot.servers.find((item) => item.id === serverId);
  if (!server) return;
  const dependents = state.snapshot.servers.filter((item) => item.jumpHostId === server.id);
  const routeWarning = dependents.length
    ? ` ${dependents.length} profile${dependents.length === 1 ? "" : "s"} (${dependents.map((item) => item.name).join(", ")}) will switch to direct connections.`
    : "";
  const proceed = await confirm(`Remove “${server.name}” and its encrypted saved credentials?${routeWarning}`, { title: "Remove connection", kind: "warning" });
  if (!proceed) return;
  try {
    cancelCurrentOperation();
    const currentActive = activeServer();
    const affectedActiveRoute = Boolean(currentActive && profileRouteContains(currentActive, server.id));
    const affectedServerIds = state.snapshot.servers.filter((profile) => profileRouteContains(profile, server.id)).map((profile) => profile.id);
    for (const affectedServerId of affectedServerIds) {
      await closeInteractiveSessions(affectedServerId);
      connectedServerIds.delete(affectedServerId);
      for (const tab of state.openServerTabs.filter((item) => item.serverId === affectedServerId)) dashboardSnapshots.delete(tab.id);
    }
    await invokeCommand("delete_server", { serverId: server.id });
    await refreshSnapshot(false);
    if (affectedActiveRoute) {
      state.connection = null;
      state.dashboard = null;
      state.processes = [];
      state.services = [];
      state.docker = null;
      state.composeProjects = [];
      state.composeProjectsServerId = null;
      state.ports = [];
      state.remoteFiles = [];
      state.logsViewer = createLogViewer({ source: "system", label: "System logs" }, 100);
      clearContainerLogs();
      resetPaginationState();
    }
    state.editingServer = null;
    state.modal = null;
    render();
    if (affectedActiveRoute && state.activeServerId) await setView("dashboard");
  } catch (error) { setError(error); }
}

export async function deleteActiveServer(): Promise<void> {
  if (state.activeServerId) await deleteServer(state.activeServerId);
}

export async function disconnectActiveServer(): Promise<void> {
  const serverId = state.activeServerId;
  if (!serverId) return;
  cancelCurrentOperation();
  clearRefreshTimer();
  await closeInteractiveSessions(serverId);
  await invokeCommand("disconnect_server", { serverId }).catch((error) => setError(error));
  connectedServerIds.delete(serverId);
  state.navigationVersion += 1;
  state.connection = null;
  state.dashboard = null;
  for (const tab of state.openServerTabs.filter((item) => item.serverId === serverId)) dashboardSnapshots.delete(tab.id);
  state.processes = [];
  state.services = [];
  state.docker = null;
  state.composeProjects = [];
  state.composeProjectsServerId = null;
  state.ports = [];
  state.remoteFiles = [];
  state.logsViewer = createLogViewer({ source: "system", label: "System logs" }, 100);
  clearContainerLogs();
  resetPaginationState();
  render();
}
