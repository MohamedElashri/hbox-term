import { invoke } from "@tauri-apps/api/core";
import { addAuthorizedKey, closeModal, copyText, deleteSavedCommand, deleteTunnel, forwardPort, removeAuthorizedKey, runComposeAction, runFirewallAction, runQuickAction, runSavedCommand, saveCommandForm, saveTunnelForm, submitComposeScaleForm, submitFirewallForm, toggleTunnel } from "./actions/admin";
import { createDocker, createDockerResource, dockerAction, ensureDockerContainersForLogs, loadDockerLogs, openDockerTerminal, openInspect, openServiceDetails, pullDockerImage, runProcessAction, runServiceAction } from "./actions/containers";
import { loadLogFileChoices, loadLogViewer, logViewerForScope, setLogFollowing, stopLogViewer, updateLogTargetLabel, updateLogViewerDom } from "./actions/logs";
import { cancelTransfer, changeRemoteMode, changeRemoteOwner, createFolder, deleteRemote, downloadRemote, editInLocalEditor, loadMoreActiveView, navigateFiles, openEditor, saveEditorForm, selectDockerSection, uploadLocal, uploadLocalFolder } from "./actions/remote";
import { changeMasterPasswordForm, createGroup, createUserForm, deleteActiveServer, deleteGroup, deleteServer, disconnectActiveServer, duplicateServer, openPackageDetails, resetCredentialsForm, resetUserPasswordForm, runCronAction, runPackageAction, runUserAction, saveCronForm, saveServerForm, saveWorkspaceTabRenameForm, submitMasterPasswordForm } from "./actions/servers";
import { formatBytes } from "./format";
import { confirm, finishAppDialog, finishTextInput, message, renderAuthFieldsForForm } from "./modals";
import { filteredServers, render, renderServerGroups } from "./render";
import { closeCustomSelects, syncCustomSelect } from "./select-controls";
import { cancelCurrentOperation, finishHostKeyPrompt, setError } from "./session";
import { activeCapabilities, activeTerminalTabByWorkspace, appWindow, createLogViewer, DEFAULT_INTERFACE_SCALE, root, state } from "./state";
import { clearActiveTerminal, closeTerminalGroup, focusPane, openNewTerminal, reconnectTerminal, setTerminalRenderer, toggleDockPosition, toggleTerminalDock } from "./terminal";
import { dismissToast, setInterfaceScale, stepInterfaceScale } from "./toasts";
import type { AdministrationTab, ContainerPlatformTab, DiskTab, DockerSection, LogSource, LogTarget, LogViewerState, View } from "./types";
import { ensureDiskVarLog, openDiskPathInFiles, selectDiskTab } from "./views/disk";
import { clearCommandResults, clearContainerLogs, clearRefreshTimer, closeWorkspaceTab, loadActiveView, loadAdministrationTab, selectLocalWorkspace, selectServer, selectWorkspaceTab, setView } from "./workspace";
import type { TerminalRenderer } from "./state";
import { loadTerminalConfig } from "./terminal-config";
import { RELEASES_URL, updates } from "./updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createWorkspaceTabDragController } from "./workspace-tab-drag";

export async function handleClick(event: MouseEvent): Promise<void> {
  const clickedElement = event.target as HTMLElement;
  if (workspaceTabDrag.suppressesClick() && clickedElement.closest(".workspace-tab[data-workspace-tab]")) {
    event.preventDefault();
    return;
  }
  const customOption = clickedElement.closest<HTMLButtonElement>(".custom-select-option");
  if (customOption) {
    const picker = customOption.closest<HTMLElement>(".custom-select");
    const select = picker?.querySelector<HTMLSelectElement>("select");
    if (picker && select && !customOption.disabled) {
      select.value = customOption.dataset.value ?? "";
      syncCustomSelect(picker);
      closeCustomSelects(root);
      picker.querySelector<HTMLButtonElement>(".custom-select-trigger")?.focus();
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return;
  }
  const customTrigger = clickedElement.closest<HTMLButtonElement>(".custom-select-trigger");
  if (customTrigger) {
    const picker = customTrigger.closest<HTMLElement>(".custom-select");
    const options = picker?.querySelector<HTMLElement>(".custom-select-options");
    if (picker && options) {
      const opening = !picker.classList.contains("open");
      closeCustomSelects(root, opening ? picker : undefined);
      picker.classList.toggle("open", opening);
      customTrigger.setAttribute("aria-expanded", String(opening));
      options.hidden = !opening;
      if (opening) picker.querySelector<HTMLButtonElement>(".custom-select-option.selected")?.focus();
    }
    return;
  }
  closeCustomSelects(root);
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-window], [data-server-action], [data-action], [data-view], [data-server-id], [data-workspace-tab], [data-workspace-rename], [data-workspace-close], [data-terminal-tab], [data-terminal-close], [data-file-path], [data-file-edit], [data-file-edit-local], [data-file-download], [data-file-delete], [data-file-chmod], [data-file-chown], [data-disk-tab], [data-disk-varlog], [data-disk-open-path], [data-container-platform-tab], [data-docker-tab], [data-docker-action], [data-docker-logs], [data-docker-exec], [data-docker-inspect], [data-logs-source], [data-process-action], [data-service-action], [data-service-details], [data-cron-edit], [data-cron-action], [data-package-action], [data-package-details], [data-account-tab], [data-user-action], [data-group-delete], [data-administration-tab], [data-compose-action], [data-firewall-action], [data-key-remove], [data-quick-action], [data-command-run], [data-command-edit], [data-command-delete], [data-tunnel-toggle], [data-port-forward], [data-tunnel-edit], [data-tunnel-delete]");
  if (!target) return;
  if (target.dataset.serverAction) {
    event.preventDefault();
    event.stopPropagation();
    const server = state.snapshot.servers.find((item) => item.id === target.dataset.serverId);
    if (!server) return;
    if (target.dataset.serverAction === "new-tab") {
      await selectServer(server.id, true);
    } else if (target.dataset.serverAction === "edit") {
      state.editingServer = server;
      state.errorMessage = "";
      state.modal = "server";
      render();
    } else if (target.dataset.serverAction === "duplicate") {
      await duplicateServer(server.id);
    } else if (target.dataset.serverAction === "delete") {
      await deleteServer(server.id);
    }
    return;
  }
  if (target.dataset.terminalClose) {
    event.stopPropagation();
    await closeTerminalGroup(target.dataset.terminalClose);
    return;
  }
  if (target.dataset.workspaceRename) {
    event.preventDefault();
    event.stopPropagation();
    state.renamingWorkspaceTabId = target.dataset.workspaceRename;
    state.modal = "workspace-tab-rename";
    render();
    window.setTimeout(() => {
      const input = root.querySelector<HTMLInputElement>('form[data-form="workspace-tab-rename"] input[name="label"]');
      input?.focus();
      input?.select();
    }, 0);
    return;
  }
  if (target.dataset.workspaceClose) {
    event.preventDefault();
    event.stopPropagation();
    await closeWorkspaceTab(target.dataset.workspaceClose);
    return;
  }
  if (target.dataset.workspaceTab) {
    await selectWorkspaceTab(target.dataset.workspaceTab);
    return;
  }
  if (target.dataset.window) {
    event.preventDefault();
    event.stopPropagation();
    try {
      if (target.dataset.window === "minimize") await appWindow.minimize();
      else if (target.dataset.window === "maximize") await appWindow.toggleMaximize();
      else await appWindow.close();
    } catch (error) {
      setError(error);
    }
    return;
  }
  if (target.dataset.view) {
    await setView(target.dataset.view as View);
    return;
  }
  if (target.dataset.serverId) {
    await selectServer(target.dataset.serverId);
    return;
  }
  if (target.dataset.terminalTab) {
    focusPane(target.dataset.terminalTab);
    return;
  }
  if (target.dataset.filePath) {
    await navigateFiles(target.dataset.filePath);
    return;
  }
  if (target.dataset.fileEditLocal) {
    await editInLocalEditor(target.dataset.fileEditLocal);
    return;
  }
  if (target.dataset.fileEdit) {
    await openEditor(target.dataset.fileEdit);
    return;
  }
  if (target.dataset.fileDownload) {
    await downloadRemote(target.dataset.fileDownload);
    return;
  }
  if (target.dataset.fileDelete) {
    await deleteRemote(target.dataset.fileDelete);
    return;
  }
  if (target.dataset.fileChmod) {
    await changeRemoteMode(target.dataset.fileChmod);
    return;
  }
  if (target.dataset.fileChown) {
    await changeRemoteOwner(target.dataset.fileChown);
    return;
  }
  if (target.dataset.diskVarlog !== undefined) {
    await ensureDiskVarLog(true);
    return;
  }
  if (target.dataset.diskTab) {
    await selectDiskTab(target.dataset.diskTab as DiskTab);
    return;
  }
  if (target.dataset.diskOpenPath) {
    await openDiskPathInFiles(target.dataset.diskOpenPath);
    return;
  }
  if (target.dataset.containerPlatformTab) {
    const nextTab = target.dataset.containerPlatformTab as ContainerPlatformTab;
    if (state.containerPlatformTab !== nextTab) clearContainerLogs();
    state.containerPlatformTab = nextTab;
    clearCommandResults();
    await loadActiveView(true);
    return;
  }
  if (target.dataset.dockerTab) {
    await selectDockerSection(target.dataset.dockerTab as DockerSection);
    return;
  }
  if (target.dataset.dockerAction) {
    await dockerAction(target.dataset.dockerAction, target.dataset.dockerTarget ?? "");
    return;
  }
  if (target.dataset.dockerLogs) {
    await loadDockerLogs(target.dataset.dockerLogs);
    return;
  }
  if (target.dataset.dockerExec) {
    await openDockerTerminal(target.dataset.dockerExec);
    return;
  }
  if (target.dataset.dockerInspect) {
    await openInspect(target.dataset.dockerInspect, target.dataset.dockerKind ?? "container");
    return;
  }
  if (target.dataset.logsSource) {
    cancelCurrentOperation();
    state.navigationVersion += 1;
    await stopLogViewer(state.logsViewer, "idle");
    const source = target.dataset.logsSource as LogSource;
    const lines = state.logsViewer.lines;
    const targetBySource: Record<"system" | "container" | "file", LogTarget> = {
      system: { source: "system", label: "System logs" },
      container: { source: "container", label: "Container logs" },
      file: { source: "file", label: "Log file", filePath: "/var/log/" },
    };
    if (source !== "system" && source !== "container" && source !== "file") return;
    state.logsViewer = createLogViewer(targetBySource[source], lines);
    state.errorMessage = "";
    clearRefreshTimer();
    render();
    if ((source === "container" || source === "file") && state.activeServerId) {
      try {
        if (source === "container" || (source === "file" && Boolean(activeCapabilities()?.docker || activeCapabilities()?.podman))) {
          await ensureDockerContainersForLogs(state.activeServerId, state.navigationVersion);
        }
        if (source === "file") await loadLogFileChoices(state.activeServerId, state.navigationVersion);
        render();
      } catch (error) {
        setError(error);
      }
    }
    return;
  }
  if (target.dataset.processAction) {
    const pid = Number(target.dataset.pid);
    const force = target.dataset.processAction === "kill";
    const proceed = await confirm(`${force ? "Force kill" : "Stop"} process ${pid}?`, { title: "Confirm process action", kind: "warning" });
    if (proceed) await runProcessAction(pid, force);
    return;
  }
  if (target.dataset.serviceAction) {
    await runServiceAction(target.dataset.serviceAction, target.dataset.service ?? "");
    return;
  }
  if (target.dataset.serviceDetails) {
    await openServiceDetails(target.dataset.serviceDetails);
    return;
  }
  if (target.dataset.cronEdit) {
    state.editingCron = state.cronJobs.find((job) => job.id === target.dataset.cronEdit) ?? null;
    state.modal = "cron"; render(); return;
  }
  if (target.dataset.cronAction) { await runCronAction(target.dataset.cronId ?? "", target.dataset.cronAction); return; }
  if (target.dataset.packageDetails) { await openPackageDetails(target.dataset.packageDetails); return; }
  if (target.dataset.packageAction) { await runPackageAction(target.dataset.packageAction, target.dataset.packageName); return; }
  if (target.dataset.accountTab) { state.accountTab = target.dataset.accountTab as typeof state.accountTab; render(); return; }
  if (target.dataset.userAction) { await runUserAction(target.dataset.userAction, target.dataset.userName ?? ""); return; }
  if (target.dataset.groupDelete) { await deleteGroup(target.dataset.groupDelete); return; }
  if (target.dataset.administrationTab) { state.administrationTab = target.dataset.administrationTab as AdministrationTab; clearCommandResults(); await loadAdministrationTab(); return; }
  if (target.dataset.composeAction) { await runComposeAction(target.dataset.composePath ?? "", target.dataset.composeAction); return; }
  if (target.dataset.firewallAction) { await runFirewallAction(target.dataset.firewallAction); return; }
  if (target.dataset.keyRemove) { await removeAuthorizedKey(target.dataset.keyRemove); return; }
  if (target.dataset.quickAction) { await runQuickAction(target.dataset.quickAction); return; }
  if (target.dataset.commandRun) { await runSavedCommand(target.dataset.commandRun); return; }
  if (target.dataset.commandEdit) { state.editingCommand = state.savedCommands.find((item) => item.id === target.dataset.commandEdit) ?? null; state.modal = "command"; render(); return; }
  if (target.dataset.commandDelete) { await deleteSavedCommand(target.dataset.commandDelete); return; }
  if (target.dataset.portForward) { await forwardPort(target.dataset.portForward); return; }
  if (target.dataset.tunnelToggle) { await toggleTunnel(target.dataset.tunnelToggle, target.dataset.tunnelRunning === "true"); return; }
  if (target.dataset.tunnelEdit) { state.editingTunnel = state.tunnels.find((item) => item.id === target.dataset.tunnelEdit) ?? null; state.modal = "tunnel"; render(); return; }
  if (target.dataset.tunnelDelete) { await deleteTunnel(target.dataset.tunnelDelete); return; }
  const action = target.dataset.action;
  if (action) await runAction(action, target);
}

/** Runs a `data-action`; `target` carries extra data attributes for actions that need them. */
export async function runAction(action: string, target: HTMLElement = document.createElement("button")): Promise<void> {
  switch (action) {
    case "add-server": state.editingServer = null; state.modal = "server"; state.errorMessage = ""; render(); break;
    case "credential-settings": state.credentialSettingsError = ""; state.credentialSettingsNotice = ""; state.modal = "security"; render(); break;
    case "change-master-password": state.credentialSettingsError = ""; state.credentialSettingsNotice = ""; state.modal = "change-password"; render(); break;
    case "reset-credentials": state.credentialSettingsError = ""; state.credentialSettingsNotice = ""; state.modal = "reset-credentials"; render(); break;
    case "connect": await setView("dashboard"); break;
    case "close-modal": closeModal(); break;
    case "accept-app-dialog": finishAppDialog(true); break;
    case "cancel-app-dialog": finishAppDialog(false); break;
    case "dismiss-toast": dismissToast(); break;
    case "reject-host-key": finishHostKeyPrompt(false); break;
    case "trust-host-key": finishHostKeyPrompt(true); break;
    case "close-editor": closeModal(); break;
    case "cancel-operation": cancelCurrentOperation(); break;
    case "cancel-transfer": cancelTransfer(); break;
    case "disconnect": await disconnectActiveServer(); break;
    case "save-and-test": { const form = root.querySelector<HTMLFormElement>('form[data-form="server"]'); if (form) await saveServerForm(form, true); break; }
    case "delete-server": await deleteActiveServer(); break;
    case "refresh": state.composeProjectsServerId = null; await loadActiveView(false, true); break;
    case "load-more": await loadMoreActiveView(); break;
    case "retry": state.errorMessage = ""; await loadActiveView(false, true); break;
    case "dismiss-error": state.errorMessage = ""; render(); break;
    case "theme":
      state.darkMode = !state.darkMode;
      localStorage.setItem("hbox-term-theme", state.darkMode ? "dark" : "light");
      render();
      // A `theme = light:A,dark:B` config follows the appearance.
      if (state.terminalConfig.config.theme?.includes(":")) void loadTerminalConfig();
      break;
    case "interface-scale-decrease": await stepInterfaceScale(-1); break;
    case "interface-scale-increase": await stepInterfaceScale(1); break;
    case "interface-scale-reset": await setInterfaceScale(DEFAULT_INTERFACE_SCALE); break;
    case "open-local": await selectLocalWorkspace(); break;
    case "toggle-dock": await toggleTerminalDock(); break;
    case "dock-position": toggleDockPosition(); break;
    case "open-config": await invoke("open_config_file").catch(setError); break;
    case "check-updates":
      if (state.modal !== "security") await runAction("credential-settings");
      await updates.checkNow();
      break;
    case "install-update": await updates.install(); break;
    case "restart-update":
      if (await confirm("Restarting ends the programs running in your terminals.", { title: "Restart hbox-term?" })) await updates.restartNow();
      break;
    case "open-releases": await openUrl(RELEASES_URL).catch(setError); break;
    case "reload-config": await loadTerminalConfig(true); render(); break;
    case "new-terminal": await openNewTerminal(); break;
    case "reconnect-terminal": await reconnectTerminal(); break;
    case "clear-terminal": clearActiveTerminal(); break;
    case "new-folder": state.modal = "folder"; render(); break;
    case "upload-file": await uploadLocal(); break;
    case "upload-folder": await uploadLocalFolder(); break;
    case "download-current": await downloadRemote(state.remotePath); break;
    case "load-log-viewer": { const viewer = logViewerForScope(target.dataset.logScope); if (viewer) await loadLogViewer(viewer, target.dataset.logScope === "container" ? "container" : "workspace"); break; }
    case "copy-log-viewer": { const viewer = logViewerForScope(target.dataset.logScope); if (viewer) await copyText(viewer.text); break; }
    case "clear-log-viewer": { const viewer = logViewerForScope(target.dataset.logScope); if (viewer) { viewer.text = ""; updateLogViewerDom(viewer, target.dataset.logScope === "container" ? "container" : "workspace"); } break; }
    case "docker-pull": await pullDockerImage(); break;
    case "docker-create": state.modal = "docker"; render(); break;
    case "docker-create-volume": await createDockerResource("volume-create", "volume"); break;
    case "docker-create-network": await createDockerResource("network-create", "network"); break;
    case "new-cron": state.editingCron = null; state.modal = "cron"; render(); break;
    case "search-packages": await loadActiveView(true); break;
    case "new-user": state.modal = "user"; render(); break;
    case "new-group": await createGroup(); break;
    case "copy-package-details": await copyText(state.packageDetailsText); break;
    case "copy-inspect": await copyText(state.inspectText); break;
    case "add-authorized-key": await addAuthorizedKey(); break;
    case "new-command": state.editingCommand = null; state.modal = "command"; render(); break;
    case "new-tunnel": state.editingTunnel = null; state.modal = "tunnel"; render(); break;
    case "show-help": await message("The Local tab is a shell on this machine. Add a server with a password or private key to open SSH terminals next to it and manage the server from the sidebar: overview, files over SFTP, services, containers, logs, and network sockets. Nothing is installed on your servers.", { title: "How hbox-term works" }); break;
  }
}

export function handleInput(event: Event): void {
  const input = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (!input.dataset.field) return;
  if (input.dataset.field === "server-search") {
    state.serverQuery = input.value;
    const list = root.querySelector<HTMLElement>(".server-list");
    if (list) {
      const servers = filteredServers();
      list.innerHTML = servers.length ? renderServerGroups(servers) : `<div class="server-empty">${state.serverQuery.trim() ? "No matching servers" : "No servers saved yet"}</div>`;
    } else {
      render();
    }
  } else if (input.dataset.field === "service-search") {
    const query = input.value.toLowerCase();
    root.querySelectorAll<HTMLElement>("[data-service-row]").forEach((row) => { row.hidden = !row.dataset.serviceRow!.toLowerCase().includes(query); });
  } else if (input.dataset.field === "file-search") {
    state.remoteFileSearch = input.value;
    render();
    const next = root.querySelector<HTMLInputElement>('[data-field="file-search"]');
    next?.focus(); next?.setSelectionRange(state.remoteFileSearch.length, state.remoteFileSearch.length);
  } else if (input.dataset.field === "editor-content") {
    state.editorContent = input.value;
    state.editorDirty = true;
    const saveButton = root.querySelector<HTMLButtonElement>('form[data-form="editor"] button[type="submit"]');
    if (saveButton) saveButton.disabled = false;
    const status = root.querySelector<HTMLElement>(".editor-status");
    if (status) status.textContent = `Unsaved changes · ${formatBytes(new Blob([state.editorContent]).size)}`;
  } else if (input.dataset.field === "log-service") {
    const viewer = logViewerForScope(input.dataset.logScope);
    if (viewer) { viewer.target.service = input.value || undefined; updateLogTargetLabel(viewer); }
  } else if (input.dataset.field === "log-file-path") {
    state.logsViewer.target.filePath = input.value;
    updateLogTargetLabel(state.logsViewer);
  } else if (input.dataset.field === "log-query") {
    const viewer = logViewerForScope(input.dataset.logScope);
    if (viewer) { viewer.query = input.value; updateLogViewerDom(viewer, input.dataset.logScope === "container" ? "container" : "workspace"); }
  } else if (input.dataset.field === "package-query") {
    state.packageQuery = input.value;
  }
}

export function handleChange(event: Event): void {
  const input = event.target as HTMLInputElement | HTMLSelectElement;
  if (input.dataset.field === "terminal-renderer") {
    setTerminalRenderer(input.value as TerminalRenderer);
    return;
  }
  if (input.dataset.field === "cron-preset") {
    const schedule = input.closest<HTMLFormElement>("form")?.elements.namedItem("schedule") as HTMLInputElement | null;
    if (schedule && input.value) schedule.value = input.value;
    return;
  }
  if (input.dataset.field === "package-upgrades") {
    state.packageUpgradesOnly = (input as HTMLInputElement).checked;
    void loadActiveView(true);
    return;
  }
  if (input.dataset.field === "ssh-config") {
    const entry = state.snapshot.sshConfigEntries.find((item) => item.alias === input.value);
    const form = input.closest<HTMLFormElement>('form[data-form="server"]');
    if (entry && form) {
      const set = (name: string, value: string) => { const field = form.elements.namedItem(name) as HTMLInputElement | null; if (field) field.value = value; };
      set("host", entry.host ?? "");
      set("username", entry.username ?? "");
      set("port", String(entry.port ?? 22));
      if (entry.keyPath) {
        const radio = form.querySelector<HTMLInputElement>('input[name="authMethod"][value="privateKey"]');
        if (radio) { radio.checked = true; renderAuthFieldsForForm(form); }
        const keySelect = form.elements.namedItem("keyPath") as HTMLSelectElement | null;
        const customKey = form.elements.namedItem("customKeyPath") as HTMLInputElement | null;
        if (keySelect && state.snapshot.sshKeys.some((key) => key.path === entry.keyPath)) {
          keySelect.value = entry.keyPath;
          const picker = keySelect.closest<HTMLElement>(".custom-select");
          if (picker) syncCustomSelect(picker);
        }
        else if (customKey) customKey.value = entry.keyPath;
      }
    }
    return;
  }
  if (input.name === "authMethod") {
    const form = input.closest<HTMLFormElement>("form");
    if (form) renderAuthFieldsForForm(form);
    return;
  }
  if (input.dataset.field === "show-hidden") { state.showHidden = (input as HTMLInputElement).checked; state.remoteFiles = []; state.filesHaveMore = false; void loadActiveView(true); }
  const logViewer = logViewerForScope(input.dataset.logScope);
  const logScope = input.dataset.logScope === "container" ? "container" : "workspace";
  if (input.dataset.field === "log-follow" && logViewer) { logViewer.following = (input as HTMLInputElement).checked; void setLogFollowing(logViewer, logScope); }
  if (input.dataset.field === "log-container" && logViewer) { logViewer.target.container = input.value || undefined; updateLogTargetLabel(logViewer); }
  if (input.dataset.field === "log-file-container" && logViewer) { logViewer.target.container = input.value || undefined; updateLogTargetLabel(logViewer); }
  if (input.dataset.field === "log-lines" && logViewer) { logViewer.lines = Number(input.value) || 100; }
  if (input.dataset.field === "log-since" && logViewer) { logViewer.since = input.value; }
  if (input.dataset.field === "log-severity" && logViewer) { logViewer.severity = input.value as LogViewerState["severity"]; updateLogViewerDom(logViewer, logScope); }
  if (logViewer && ["log-service", "log-container", "log-file-container", "log-file-path"].includes(input.dataset.field ?? "")) {
    const targetReady = logViewer.target.source === "system"
      || logViewer.target.source === "compose"
      || (logViewer.target.source === "container" && Boolean(logViewer.target.container))
      || (logViewer.target.source === "file" && Boolean(logViewer.target.filePath));
    if (targetReady) {
      logViewer.text = "";
      void loadLogViewer(logViewer, logScope);
    }
  }
}

export async function handleSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const kind = form.dataset.form;
  if (kind === "master-password") await submitMasterPasswordForm(form);
  else if (kind === "change-password") await changeMasterPasswordForm(form);
  else if (kind === "reset-credentials") await resetCredentialsForm(form);
  else if (kind === "server") await saveServerForm(form, false);
  else if (kind === "editor") await saveEditorForm(form);
  else if (kind === "folder") await createFolder(form);
  else if (kind === "docker") await createDocker(form);
  else if (kind === "input-prompt") finishTextInput(String(new FormData(form).get("value") ?? ""));
  else if (kind === "compose-scale") await submitComposeScaleForm(form);
  else if (kind === "cron") await saveCronForm(form);
  else if (kind === "user") await createUserForm(form);
  else if (kind === "user-password") await resetUserPasswordForm(form);
  else if (kind === "firewall") await submitFirewallForm(form, event.submitter as HTMLButtonElement | null);
  else if (kind === "command") await saveCommandForm(form);
  else if (kind === "tunnel") await saveTunnelForm(form);
  else if (kind === "workspace-tab-rename") saveWorkspaceTabRenameForm(form);
}

export function handleKeydown(event: KeyboardEvent): void {
  const customPicker = (event.target as HTMLElement).closest<HTMLElement>(".custom-select");
  if (customPicker) {
    const trigger = customPicker.querySelector<HTMLButtonElement>(".custom-select-trigger");
    const options = [...customPicker.querySelectorAll<HTMLButtonElement>(".custom-select-option:not(:disabled)")];
    const currentIndex = options.indexOf(event.target as HTMLButtonElement);
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && event.target === trigger) {
      event.preventDefault();
      trigger?.click();
      return;
    }
    if (currentIndex >= 0 && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options[nextIndex]?.focus();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeCustomSelects(root);
      trigger?.focus();
      return;
    }
  }
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target as HTMLElement;
  if (target.closest("[data-server-action]")) return;
  const serverItem = target.closest<HTMLElement>(".server-item[data-server-id]");
  if (!serverItem?.dataset.serverId) return;
  event.preventDefault();
  void selectServer(serverItem.dataset.serverId);
}

export const workspaceTabDrag = createWorkspaceTabDragController(
  root,
  () => state.openServerTabs,
  (tabs) => { state.openServerTabs = tabs; },
);
