import { icon } from "../icons";
import type { ServerProfile } from "../types";
import { escapeHtml, formatBytes } from "./format";
import { render } from "./render";
import { enhanceSelects } from "./select-controls";
import { DEFAULT_INTERFACE_SCALE, INTERFACE_SCALE_LEVELS, platform, root, state } from "./state";

export function renderAppDialog(): string {
  const prompt = state.appDialogPrompt;
  if (!prompt) return "";
  const iconName = prompt.kind === "warning" ? "shield" : "info";
  return `<div class="backdrop app-dialog-backdrop" data-app-dialog><div class="modal modal-small app-dialog" role="alertdialog" aria-modal="true"><div class="modal-head"><div><div class="eyebrow">hbox-term</div><h2>${escapeHtml(prompt.title)}</h2></div><button class="close-button" data-action="cancel-app-dialog" aria-label="Close dialog">${icon("close")}</button></div><div class="modal-body form-stack"><div class="app-dialog-message ${prompt.kind}">${icon(iconName)}<p>${escapeHtml(prompt.message)}</p></div><div class="modal-actions"><span></span><div class="modal-actions-right">${prompt.cancelLabel ? `<button class="button button-quiet" data-action="cancel-app-dialog">${escapeHtml(prompt.cancelLabel)}</button>` : ""}<button class="button ${prompt.kind === "warning" ? "button-danger" : "button-primary"}" data-action="accept-app-dialog">${escapeHtml(prompt.confirmLabel)}</button></div></div></div></div></div>`;
}

export function confirm(messageText: string, options: { title?: string; kind?: string } = {}): Promise<boolean> {
  if (state.finishAppDialogWaiter) return Promise.resolve(false);
  state.appDialogPrompt = { title: options.title ?? "Confirm action", message: messageText, kind: options.kind === "warning" ? "warning" : "info", confirmLabel: "Continue", cancelLabel: "Cancel" };
  const waiter = new Promise<boolean>((resolve) => { state.finishAppDialogWaiter = resolve; });
  root.insertAdjacentHTML("beforeend", renderAppDialog());
  window.setTimeout(() => root.querySelector<HTMLButtonElement>('[data-action="accept-app-dialog"]')?.focus(), 0);
  return waiter;
}

export async function message(messageText: string, options: { title?: string } = {}): Promise<void> {
  if (state.finishAppDialogWaiter) return;
  state.appDialogPrompt = { title: options.title ?? "hbox-term", message: messageText, kind: "info", confirmLabel: "Close" };
  const waiter = new Promise<boolean>((resolve) => { state.finishAppDialogWaiter = resolve; });
  root.insertAdjacentHTML("beforeend", renderAppDialog());
  window.setTimeout(() => root.querySelector<HTMLButtonElement>('[data-action="accept-app-dialog"]')?.focus(), 0);
  await waiter;
}

export function finishAppDialog(value: boolean): void {
  const finish = state.finishAppDialogWaiter;
  state.finishAppDialogWaiter = null;
  state.appDialogPrompt = null;
  root.querySelector<HTMLElement>("[data-app-dialog]")?.remove();
  finish?.(value);
}

export function renderModal(): string {
  if (state.modal === "server") return renderServerModal();
  if (state.modal === "workspace-tab-rename") return renderWorkspaceTabRenameModal();
  if (state.modal === "service") return renderServiceModal();
  if (state.modal === "editor") return renderEditorModal();
  if (state.modal === "folder") return renderFolderModal();
  if (state.modal === "docker") return renderDockerModal();
  if (state.modal === "input-prompt") return renderTextInputModal();
  if (state.modal === "compose-scale") return renderComposeScaleModal();
  if (state.modal === "security") return renderSecurityModal();
  if (state.modal === "master-password") return renderMasterPasswordModal();
  if (state.modal === "host-key") return renderHostKeyModal();
  if (state.modal === "change-password") return renderChangePasswordModal();
  if (state.modal === "reset-credentials") return renderResetCredentialsModal();
  if (state.modal === "cron") return renderCronModal();
  if (state.modal === "user") return renderUserModal();
  if (state.modal === "user-password") return renderUserPasswordModal();
  if (state.modal === "package-details") return renderPackageDetailsModal();
  if (state.modal === "command") return renderCommandModal();
  if (state.modal === "tunnel") return renderTunnelModal();
  return renderInspectModal();
}

export function renderModalShell(title: string, subtitle: string, body: string, size = ""): string {
  return `<div class="backdrop" data-backdrop><div class="modal ${size}" role="dialog" aria-modal="true"><div class="modal-head"><div><div class="eyebrow">hbox-term</div><h2>${title}</h2><p>${subtitle}</p></div><button class="close-button" data-action="close-modal">${icon("close")}</button></div>${body}</div></div>`;
}

export function renderTextInputModal(): string {
  const prompt = state.textInputPrompt;
  if (!prompt) return "";
  const required = prompt.allowEmpty ? "" : "required";
  const control = prompt.choices
    ? `<select name="value" ${required} autofocus>${prompt.allowEmpty ? `<option value="">All services</option>` : ""}${prompt.choices.map((choice) => `<option value="${escapeHtml(choice)}" ${choice === prompt.defaultValue ? "selected" : ""}>${escapeHtml(choice)}</option>`).join("")}</select>`
    : prompt.multiline
      ? `<textarea name="value" rows="5" ${required} autofocus placeholder="${escapeHtml(prompt.placeholder ?? "")}">${escapeHtml(prompt.defaultValue)}</textarea>`
      : `<input name="value" ${required} autofocus value="${escapeHtml(prompt.defaultValue)}" placeholder="${escapeHtml(prompt.placeholder ?? "")}"/>`;
  return renderModalShell(escapeHtml(prompt.title), "Enter the value below to continue.", `<form class="modal-body form-stack" data-form="input-prompt"><label class="field"><span>${escapeHtml(prompt.label)}</span>${control}</label><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Continue</button></div></form>`, "modal-small");
}

export function requestTextInput(prompt: NonNullable<typeof state.textInputPrompt>): Promise<string | null> {
  if (state.finishTextInputWaiter) return Promise.resolve(null);
  state.textInputPrompt = prompt;
  state.modal = "input-prompt";
  const waiter = new Promise<string | null>((resolve) => { state.finishTextInputWaiter = resolve; });
  render();
  return waiter;
}

export function finishTextInput(value: string | null): void {
  const finish = state.finishTextInputWaiter;
  state.finishTextInputWaiter = null;
  state.textInputPrompt = null;
  state.modal = null;
  render();
  finish?.(value);
}

export function renderWorkspaceTabRenameModal(): string {
  const tab = state.openServerTabs.find((item) => item.id === state.renamingWorkspaceTabId);
  const server = tab && state.snapshot.servers.find((item) => item.id === tab.serverId);
  if (!tab || !server) return "";
  return renderModalShell("Rename tab", "Give this workspace tab a short label. Leave it blank to use the server name.", `<form class="modal-body form-stack" data-form="workspace-tab-rename"><label class="field"><span>Tab name</span><input name="label" value="${escapeHtml(tab.label ?? server.name)}" maxlength="80" autofocus/></label><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Save name</button></div></form>`, "modal-small");
}

export function renderHostKeyModal(): string {
  const prompt = state.hostKeyPrompt;
  if (!prompt) return "";
  if (prompt.unknown) {
    const unknown = prompt.unknown;
    return renderModalShell(
      "First connection to this server",
      `${escapeHtml(unknown.host)}:${unknown.port} is not yet saved in <code>~/.ssh/known_hosts</code>.`,
      `<div class="modal-body form-stack"><div class="credential-warning">${icon("shield")}<div><strong>Review the server's fingerprint before trusting it.</strong><p>hbox-term never trusts a first-contact host key silently. Verify this fingerprint through a trusted channel before it is added to your known hosts.</p></div></div>${prompt.error ? `<div class="inline-error">${icon("info")}<span>${escapeHtml(prompt.error)}</span></div>` : ""}<div class="host-key-comparison"><div><span>Key type</span><code>${escapeHtml(unknown.keyType)}</code></div><div><span>Fingerprint</span><code>${escapeHtml(unknown.fingerprint)}</code></div></div><p class="security-footnote">Trusting adds this key to <code>~/.ssh/known_hosts</code>; future changes will be flagged.</p><div class="modal-actions"><button type="button" class="button button-quiet" data-action="reject-host-key">Cancel</button><button type="button" class="button button-danger" data-action="trust-host-key">Trust key &amp; connect</button></div></div>`,
      "modal-security",
    );
  }
  const mismatch = prompt.mismatch;
  if (!mismatch) return "";
  const oldKeys = mismatch.oldFingerprints.length
    ? mismatch.oldFingerprints.map((fingerprint) => `<code>${escapeHtml(fingerprint)}</code>`).join("")
    : `<code>Unavailable</code>`;
  return renderModalShell(
    "SSH host identity changed",
    `${escapeHtml(mismatch.host)}:${mismatch.port} presented a different ${escapeHtml(mismatch.keyType)} host key.`,
    `<div class="modal-body form-stack"><div class="credential-warning">${icon("shield")}<div><strong>Verify this change before continuing.</strong><p>A changed host key can be expected after a server rebuild, but it can also indicate that another machine is intercepting the connection.</p></div></div>${prompt.error ? `<div class="inline-error">${icon("info")}<span>${escapeHtml(prompt.error)}</span></div>` : ""}<div class="host-key-comparison"><div><span>Previously trusted</span>${oldKeys}</div><div><span>Presented now</span><code>${escapeHtml(mismatch.newFingerprint)}</code></div></div><p class="security-footnote">Confirm the new fingerprint through a trusted channel before replacing the saved entry in <code>~/.ssh/known_hosts</code>.</p><div class="modal-actions"><button type="button" class="button button-quiet" data-action="reject-host-key">Cancel</button><button type="button" class="button button-danger" data-action="trust-host-key">Trust new key & connect</button></div></div>`,
    "modal-security",
  );
}

export function renderCronModal(): string {
  const job = state.editingCron;
  return renderModalShell(job ? "Edit cron job" : "Add cron job", "Use a five-field cron expression. Jobs run as the connected SSH user.", `<form class="modal-body form-stack" data-form="cron"><label class="field"><span>Common schedule</span><select data-field="cron-preset"><option value="">Custom expression</option><option value="*/5 * * * *">Every 5 minutes</option><option value="0 * * * *">Every hour</option><option value="0 0 * * *">Daily at midnight</option><option value="0 0 * * 0">Weekly on Sunday</option><option value="0 0 1 * *">Monthly</option></select></label><label class="field"><span>Cron expression</span><input name="schedule" value="${escapeHtml(job?.schedule ?? "0 * * * *")}" required placeholder="0 * * * *"/><small class="field-hint">minute · hour · day of month · month · day of week</small></label><label class="field"><span>Command</span><textarea name="command" required rows="4" placeholder="/usr/local/bin/backup">${escapeHtml(job?.command ?? "")}</textarea></label><label class="favorite-check"><input type="checkbox" name="enabled" ${job?.enabled === false ? "" : "checked"}/><span></span>Enabled</label><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Save cron job</button></div></form>`, "modal-small");
}

export function renderUserModal(): string {
  return renderModalShell("Create Linux user", "The password is sent through the protected SSH channel and is never saved by hbox-term.", `<form class="modal-body form-stack" data-form="user"><div class="credential-warning">${icon("info")}<div><strong>Password changes are immediate.</strong><p>Share credentials through a secure channel and require the user to rotate them after first login.</p></div></div><label class="field"><span>Username</span><input name="name" required pattern="[A-Za-z0-9_.+-]+"/></label><div class="form-grid"><label class="field"><span>Home directory</span><input name="home" placeholder="created automatically"/></label><label class="field"><span>Login shell <small>optional</small></span><input name="shell" placeholder="use the server default"/></label></div><label class="field"><span>Supplementary groups <small>comma separated</small></span><input name="groups" placeholder="sudo,docker"/></label><label class="field"><span>Initial password <small>optional</small></span><input name="password" type="password" autocomplete="new-password"/></label><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Create user</button></div></form>`, "modal-security");
}

export function renderUserPasswordModal(): string {
  return renderModalShell("Reset Linux password", `Set a new password for ${escapeHtml(state.passwordUser)}.`, `<form class="modal-body form-stack" data-form="user-password"><div class="credential-warning">${icon("info")}<div><strong>This takes effect immediately and cannot be undone.</strong><p>The password is sent through SSH stdin, is never saved locally, and should be shared securely.</p></div></div><label class="field"><span>New password</span><input name="password" type="password" required autocomplete="new-password"/></label><label class="field"><span>Confirm password</span><input name="confirmation" type="password" required autocomplete="new-password"/></label><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Cancel</button><button type="submit" class="button button-danger">Reset password</button></div></form>`, "modal-security");
}

export function renderPackageDetailsModal(): string {
  return renderModalShell("Package details", "APT metadata reported by the remote server.", `<div class="modal-body"><pre class="inspect-output package-details-output">${escapeHtml(state.packageDetailsText || "Loading…")}</pre><div class="modal-actions"><button class="button button-quiet" data-action="close-modal">Close</button><button class="button button-primary" data-action="copy-package-details">${icon("copy")} Copy</button></div></div>`, "modal-inspect");
}

export function renderCommandModal(): string {
  return renderModalShell(state.editingCommand ? "Edit saved command" : "Save a command", "Named commands can belong to this server or be available everywhere.", `<form class="modal-body form-stack" data-form="command"><label class="field"><span>Name</span><input name="name" required value="${escapeHtml(state.editingCommand?.name ?? "")}" placeholder="Tail API logs"/></label><label class="field"><span>Command</span><textarea name="command" required rows="6" spellcheck="false" placeholder="journalctl -u api.service -f">${escapeHtml(state.editingCommand?.command ?? "")}</textarea></label><label class="favorite-check"><input type="checkbox" name="global" ${state.editingCommand && !state.editingCommand.serverId ? "checked" : ""}/><span></span>Available on every server</label><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Cancel</button><button class="button button-primary">Save command</button></div></form>`, "modal-small");
}

export function renderTunnelModal(): string {
  const tunnel = state.editingTunnel;
  return renderModalShell(tunnel ? "Edit SSH tunnel" : "Add SSH tunnel", "Tunnels remain active while hbox-term is running or until you stop them.", `<form class="modal-body form-stack" data-form="tunnel"><label class="field"><span>Name</span><input name="name" required value="${escapeHtml(tunnel?.name ?? "")}" placeholder="Production database"/></label><label class="field"><span>Type</span><select name="kind"><option value="local" ${tunnel?.kind === "local" ? "selected" : ""}>Local forwarding</option><option value="remote" ${tunnel?.kind === "remote" ? "selected" : ""}>Remote forwarding</option><option value="socks" ${tunnel?.kind === "socks" ? "selected" : ""}>SOCKS5 proxy</option></select></label><div class="form-grid"><label class="field"><span>Bind host</span><input name="bindHost" required value="${escapeHtml(tunnel?.bindHost ?? "127.0.0.1")}"/></label><label class="field"><span>Bind port</span><input name="bindPort" type="number" min="1" max="65535" required value="${tunnel?.bindPort ?? 5433}"/></label><label class="field"><span>Target host</span><input name="targetHost" value="${escapeHtml(tunnel?.targetHost ?? "127.0.0.1")}" placeholder="Ignored for SOCKS"/></label><label class="field"><span>Target port</span><input name="targetPort" type="number" min="1" max="65535" value="${tunnel?.targetPort ?? 5432}"/></label></div><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Cancel</button><button class="button button-primary">Save tunnel</button></div></form>`, "modal-small");
}

export function renderServerModal(): string {
  const server = state.editingServer;
  const isEdit = Boolean(server);
  const bastions = state.snapshot.servers.filter((candidate) => candidate.id !== server?.id && !profileRouteContains(candidate, server?.id));
  const route = `<div class="form-divider"><span>Connection route</span></div><label class="field"><span>Bastion host <small>optional</small></span><select name="jumpHostId"><option value="">Direct connection</option>${bastions.map((candidate) => `<option value="${escapeHtml(candidate.id)}" ${server?.jumpHostId === candidate.id ? "selected" : ""}>${escapeHtml(profileRouteLabel(candidate))}</option>`).join("")}</select><small class="field-hint">hbox-term connects to this profile through the selected bastion. Bastions may use another bastion, creating a secure jump chain.</small></label>`;
  return renderModalShell(isEdit ? "Edit connection" : "Connect a server", isEdit ? "Update the profile without losing its saved secrets." : "Credentials are encrypted locally with your master password.", `<form class="modal-body form-stack" data-form="server"><div class="form-grid"><label class="field"><span>Display name</span><input name="name" required value="${escapeHtml(server?.name ?? "")}" placeholder="Production API"/></label><label class="field"><span>Group</span><input name="groupName" value="${escapeHtml(server?.groupName ?? "")}" placeholder="Production"/></label><label class="field field-wide"><span>Host or IP</span><input name="host" required value="${escapeHtml(server?.host ?? "")}" placeholder="203.0.113.10"/></label><label class="field"><span>Port</span><input name="port" type="number" min="1" max="65535" value="${server?.port ?? 22}"/></label><label class="field"><span>Username</span><input name="username" required value="${escapeHtml(server?.username ?? "root")}" placeholder="ubuntu"/></label></div>${state.snapshot.sshConfigEntries.length ? `<label class="field"><span>Import from ~/.ssh/config</span><select data-field="ssh-config"><option value="">Choose a saved host alias…</option>${state.snapshot.sshConfigEntries.map((entry) => `<option value="${escapeHtml(entry.alias)}">${escapeHtml(entry.alias)}${entry.host ? ` · ${escapeHtml(entry.host)}` : ""}</option>`).join("")}</select></label>` : ""}${route}<div class="form-divider"><span>Authentication</span></div><div class="auth-switch"><label class="auth-option"><input type="radio" name="authMethod" value="password" ${!server || server.authMethod === "password" ? "checked" : ""}/><span>${icon("shield")}<strong>Password</strong><small>Encrypted in the local vault</small></span></label><label class="auth-option"><input type="radio" name="authMethod" value="privateKey" ${server?.authMethod === "privateKey" ? "checked" : ""}/><span>${icon("key")}<strong>Private key</strong><small>Use a key from ~/.ssh</small></span></label></div><div class="auth-fields" data-auth-fields>${renderAuthFields(server)}</div><div class="form-divider"><span>Organization & context</span></div><label class="field"><span>Tags <small>comma separated</small></span><input name="tags" value="${escapeHtml(server?.tags.join(", ") ?? "")}" placeholder="production, api, eu-west"/></label><label class="field"><span>Notes <small>stored locally and included in search</small></span><textarea name="notes" rows="5" placeholder="Purpose, provider, URLs, emergency steps…">${escapeHtml(server?.notes ?? "")}</textarea></label><label class="favorite-check"><input type="checkbox" name="favorite" ${server?.favorite ? "checked" : ""}/><span></span>Keep this server near the top</label><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Cancel</button><div class="modal-actions-right"><button type="button" class="button button-quiet" data-action="save-and-test">${icon("refresh")} Save & test</button><button type="submit" class="button button-primary">${isEdit ? "Save changes" : "Save connection"}</button></div></div></form>`, "modal-server");
}

export function profileRouteContains(profile: ServerProfile, serverId?: string): boolean {
  if (!serverId) return false;
  const seen = new Set<string>();
  let current: ServerProfile | undefined = profile;
  while (current && !seen.has(current.id)) {
    if (current.id === serverId) return true;
    seen.add(current.id);
    current = state.snapshot.servers.find((candidate) => candidate.id === current?.jumpHostId);
  }
  return false;
}

export function profileRouteLabel(profile: ServerProfile): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let current: ServerProfile | undefined = profile;
  while (current && !seen.has(current.id)) {
    names.push(current.name);
    seen.add(current.id);
    current = state.snapshot.servers.find((candidate) => candidate.id === current?.jumpHostId);
  }
  return names.reverse().join(" → ");
}

export function renderAuthFields(server: ServerProfile | null, auth = server?.authMethod ?? "password"): string {
  if (auth === "privateKey") return `<label class="field"><span>Private key</span><select name="keyPath"><option value="">Choose a key…</option>${state.snapshot.sshKeys.map((key) => `<option value="${escapeHtml(key.path)}" ${server?.keyPath === key.path ? "selected" : ""}>${escapeHtml(key.name)} · ${escapeHtml(key.kind)}</option>`).join("")}</select>${state.snapshot.sshKeys.length ? "" : `<small class="field-hint">No keys detected in ~/.ssh. You can still paste a path below.</small>`}<input name="customKeyPath" value="${escapeHtml(server?.keyPath && !state.snapshot.sshKeys.some((key) => key.path === server.keyPath) ? server.keyPath : "")}" placeholder="/Users/you/.ssh/id_ed25519"/></label><label class="field"><span>Key passphrase <small>optional · leave blank to keep</small></span><input name="keyPassphrase" type="password" autocomplete="new-password" placeholder="Only if the key is encrypted"/></label><label class="field"><span>Sudo password <small>optional · for protected actions</small></span><input name="sudoPassword" type="password" autocomplete="new-password" placeholder="Leave blank if sudo is passwordless"/></label>`;
  return `<label class="field"><span>Password <small>${server ? "leave blank to keep" : ""}</small></span><input name="password" type="password" autocomplete="current-password" placeholder="SSH password"/></label><label class="field"><span>Sudo password <small>optional · leave blank to use passwordless sudo</small></span><input name="sudoPassword" type="password" autocomplete="new-password" placeholder="Only needed for protected actions"/></label>`;
}

export function renderServiceModal(): string {
  if (!state.serviceDetails) return renderModalShell("Service details", "Loading the unit profile…", `<div class="modal-body"><div class="view-loading"><div class="spinner"></div></div></div>`, "modal-service");
  return renderModalShell(escapeHtml(state.serviceDetails.name), "Unit properties and its latest journal entries.", `<div class="modal-body service-details"><div class="service-properties">${state.serviceDetails.properties.map(([key, value]) => `<div><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}</div>${state.serviceDetails.unitFile ? `<div class="unit-file"><span>Unit file</span><code>${escapeHtml(state.serviceDetails.unitFile)}</code></div>` : ""}<div class="detail-log-label">Recent journal</div><pre class="log-output detail-log">${escapeHtml(state.serviceDetails.journal || "No recent journal entries.")}</pre><div class="modal-actions"><button class="button button-quiet" data-action="close-modal">Close</button><div class="modal-actions-right"><button class="button button-quiet" data-service-action="enable" data-service="${escapeHtml(state.serviceDetails.name)}">Enable</button><button class="button button-primary" data-service-action="restart" data-service="${escapeHtml(state.serviceDetails.name)}">${icon("restart")} Restart</button></div></div></div>`, "modal-service");
}

export function renderEditorModal(): string {
  return renderModalShell("Edit remote file", escapeHtml(state.editorPath), `<form class="modal-body editor-modal-body" data-form="editor"><textarea name="content" data-field="editor-content" spellcheck="false">${escapeHtml(state.editorContent)}</textarea><div class="editor-footer"><span class="editor-status">${state.editorDirty ? "Unsaved changes" : "Saved"} · ${formatBytes(new Blob([state.editorContent]).size)}</span><div class="modal-actions-right"><button type="button" class="button button-quiet" data-action="close-editor">Cancel</button><button type="submit" class="button button-primary" ${state.editorDirty ? "" : "disabled"}>${icon("check")} Save remotely</button></div></div></form>`, "modal-editor");
}

export function renderFolderModal(): string {
  return renderModalShell("Create folder", `A new folder inside ${escapeHtml(state.remotePath)}`, `<form class="modal-body form-stack" data-form="folder"><label class="field"><span>Folder name</span><input name="name" required autofocus placeholder="logs"/></label><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Create folder</button></div></form>`, "modal-small");
}

export function renderDockerModal(): string {
  return renderModalShell("Create container", "A compact form for the common Docker run options.", `<form class="modal-body form-stack" data-form="docker"><div class="form-grid"><label class="field field-wide"><span>Image</span><input name="image" required placeholder="nginx:latest"/></label><label class="field"><span>Name</span><input name="name" placeholder="web"/></label><label class="field"><span>Restart policy</span><select name="restartPolicy"><option value="no">No restart</option><option value="unless-stopped">Unless stopped</option><option value="always">Always</option><option value="on-failure">On failure</option></select></label><label class="field field-wide"><span>Command <small>optional</small></span><input name="command" placeholder="npm run start"/></label><label class="field field-wide"><span>Ports <small>one per line · host:container</small></span><textarea name="ports" rows="2" placeholder="8080:80"></textarea></label><label class="field field-wide"><span>Environment <small>one KEY=value per line</small></span><textarea name="environment" rows="2" placeholder="NODE_ENV=production"></textarea></label><label class="field field-wide"><span>Volumes <small>one per line · host:container</small></span><textarea name="volumes" rows="2" placeholder="/srv/app:/app"></textarea></label><label class="field field-wide"><span>Networks <small>one per line</small></span><input name="networks" placeholder="bridge"/></label><label class="field"><span>Memory limit <small>optional</small></span><input name="memoryLimit" placeholder="512m"/></label><label class="field"><span>CPU limit <small>optional</small></span><input name="cpuLimit" placeholder="1.5"/></label></div><div class="inline-form-options"><label class="favorite-check"><input type="checkbox" name="detached" checked/><span></span>Run detached</label><label class="favorite-check"><input type="checkbox" name="removeOnExit"/><span></span>Remove on exit</label></div><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Create container</button></div></form>`, "modal-docker");
}

export function renderComposeScaleModal(): string {
  const project = state.composeScaleProject;
  if (!project) return "";
  const serviceOptions = project.services.map((service) => `<option value="${escapeHtml(service)}">${escapeHtml(service)}</option>`).join("");
  return renderModalShell("Scale Compose service", `Choose how many replicas to run in ${escapeHtml(project.name)}.`, `<form class="modal-body form-stack" data-form="compose-scale"><label class="field"><span>Service</span><select name="service" required>${serviceOptions}</select></label><label class="field"><span>Replicas</span><input name="replicas" type="number" min="0" step="1" value="2" required autofocus/><small class="field-hint">Use 0 to stop every container for this service.</small></label><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Scale service</button></div></form>`, "modal-small");
}

export function renderInspectModal(): string {
  return renderModalShell("Resource inspect", "Raw JSON from the remote container runtime.", `<div class="modal-body"><pre class="inspect-output">${escapeHtml(state.inspectText || "Loading…")}</pre><div class="modal-actions"><button class="button button-quiet" data-action="close-modal">Close</button><button class="button button-primary" data-action="copy-inspect">${icon("copy")} Copy JSON</button></div></div>`, "modal-inspect");
}

export function renderCredentialWarning(): string {
  return `<div class="credential-warning" role="note">${icon("info")}<div><strong>Important: your master password cannot be recovered.</strong><p>Write it down somewhere safe. If you forget it, the only recovery option is a complete reset, which permanently deletes every saved SSH password, key passphrase, and sudo password.</p></div></div>`;
}

export function renderSecurityModal(): string {
  const status = !state.credentialStatus.configured
    ? "Not set up yet"
    : state.credentialStatus.unlocked
      ? "Unlocked for this session"
      : "Locked until you enter your master password";
  const scalePercent = Math.round(state.interfaceScale * 100);
  const scaleIndex = INTERFACE_SCALE_LEVELS.indexOf(state.interfaceScale as typeof INTERFACE_SCALE_LEVELS[number]);
  return renderModalShell("Settings", "Adjust the appearance and manage locally saved credentials.", `<div class="modal-body security-modal-body"><section class="settings-section" aria-labelledby="appearance-settings-title"><div class="settings-section-copy"><h3 id="appearance-settings-title">Interface scale</h3><p>Increase the entire interface on HiDPI displays. Outside the terminal you can also use ${platform === "macos" ? "Command" : "Ctrl"} +/− and ${platform === "macos" ? "Command" : "Ctrl"} 0; in the terminal they change the font size.</p></div><div class="interface-scale-control" role="group" aria-label="Interface scale"><button class="icon-button" type="button" data-action="interface-scale-decrease" aria-label="Decrease interface scale" title="Decrease interface scale" ${scaleIndex <= 0 ? "disabled" : ""}>${icon("minus")}</button><output data-interface-scale-value aria-live="polite">${scalePercent}%</output><button class="icon-button" type="button" data-action="interface-scale-increase" aria-label="Increase interface scale" title="Increase interface scale" ${scaleIndex >= INTERFACE_SCALE_LEVELS.length - 1 ? "disabled" : ""}>${icon("plus")}</button><button class="button button-quiet scale-reset" type="button" data-action="interface-scale-reset" ${state.interfaceScale === DEFAULT_INTERFACE_SCALE ? "disabled" : ""}>Reset</button></div></section><div class="settings-divider"></div>${renderConfigSettings()}<div class="settings-divider"></div><section class="settings-section" aria-labelledby="renderer-settings-title"><div class="settings-section-copy"><h3 id="renderer-settings-title">Terminal renderer</h3><p>WebGL is faster for heavy output. Auto uses WebGL on macOS and the DOM renderer on Linux, where WebKitGTK did not always repaint resized WebGL terminals.</p></div><select data-field="terminal-renderer" aria-label="Terminal renderer">${(["auto", "webgl", "dom"] as const).map((value) => `<option value="${value}" ${state.terminalRenderer === value ? "selected" : ""}>${{ auto: "Auto", webgl: "WebGL", dom: "DOM" }[value]}</option>`).join("")}</select></section><div class="settings-divider"></div><div class="credential-status-card"><span>Vault status</span><strong>${status}</strong><small>Server names and connection details remain in the local profile database; saved secrets are kept in a separate encrypted file.</small></div>${renderCredentialWarning()}${state.credentialSettingsNotice ? `<div class="security-notice">${icon("check")}<span>${escapeHtml(state.credentialSettingsNotice)}</span></div>` : ""}${state.credentialSettingsError ? `<div class="inline-error">${icon("info")}<span>${escapeHtml(state.credentialSettingsError)}</span></div>` : ""}<div class="security-actions"><button class="button button-quiet" data-action="change-master-password" ${state.credentialStatus.configured ? "" : "disabled"}>${icon("key")} Change master password</button><button class="button button-danger" data-action="reset-credentials" ${state.credentialStatus.configured ? "" : "disabled"}>${icon("trash")} Reset all saved credentials</button></div><p class="security-footnote">Resetting removes saved credentials from this device but leaves your server profiles in place. You will create a new master password the next time you save credentials.</p><div class="modal-actions"><button class="button button-quiet" data-action="close-modal">Close</button></div></div>`, "modal-security");
}

export function renderMasterPasswordModal(): string {
  const mode = state.masterPasswordPrompt?.mode ?? "unlock";
  const setup = mode === "setup";
  const promptError = state.masterPasswordPrompt?.error;
  return renderModalShell(setup ? "Create a master password" : "Unlock saved credentials", setup ? "Protect your local credential vault before continuing." : "Enter your master password to continue the pending operation.", `<form class="modal-body form-stack" data-form="master-password">${renderCredentialWarning()}${promptError ? `<div class="inline-error">${icon("info")}<span>${escapeHtml(promptError)}</span></div>` : ""}<label class="field"><span>Master password</span><input name="masterPassword" type="password" required autocomplete="${setup ? "new-password" : "current-password"}" placeholder="At least 8 characters"/></label>${setup ? `<label class="field"><span>Confirm master password</span><input name="confirmPassword" type="password" required autocomplete="new-password" placeholder="Enter it again"/></label>` : ""}<div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">${setup ? "Protect credentials" : "Unlock and continue"}</button></div></form>`, "modal-security");
}

export function renderChangePasswordModal(): string {
  return renderModalShell("Change master password", "Verify the current password, then re-encrypt every saved credential with the new one.", `<form class="modal-body form-stack" data-form="change-password">${renderCredentialWarning()}${state.credentialSettingsError ? `<div class="inline-error">${icon("info")}<span>${escapeHtml(state.credentialSettingsError)}</span></div>` : ""}<label class="field"><span>Current master password</span><input name="currentPassword" type="password" required autocomplete="current-password"/></label><div class="form-divider"><span>New password</span></div><label class="field"><span>New master password</span><input name="newPassword" type="password" required autocomplete="new-password" placeholder="At least 8 characters"/></label><label class="field"><span>Confirm new password</span><input name="confirmPassword" type="password" required autocomplete="new-password"/></label><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Re-encrypt credentials</button></div></form>`, "modal-security");
}

export function renderResetCredentialsModal(): string {
  return renderModalShell("Reset all saved credentials", "This permanently removes every saved secret from this device.", `<form class="modal-body form-stack" data-form="reset-credentials">${renderCredentialWarning()}${state.credentialSettingsError ? `<div class="inline-error">${icon("info")}<span>${escapeHtml(state.credentialSettingsError)}</span></div>` : ""}<label class="field"><span>Master password</span><input name="masterPassword" type="password" required autocomplete="current-password"/></label><label class="field"><span>Type RESET to confirm</span><input name="confirmation" required autocomplete="off" placeholder="RESET"/></label><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Keep credentials</button><button type="submit" class="button button-danger">Delete saved credentials</button></div></form>`, "modal-security");
}

export function renderAuthFieldsForForm(form: HTMLFormElement): void {
  const selected = form.querySelector<HTMLInputElement>('input[name="authMethod"]:checked')?.value ?? "password";
  const target = form.querySelector<HTMLElement>("[data-auth-fields]");
  if (target) {
    target.innerHTML = renderAuthFields(state.editingServer, selected as "password" | "privateKey");
    enhanceSelects(root, target);
  }
}

function renderConfigSettings(): string {
  const { path, errors, ignored, profiles } = state.terminalConfig;
  const profileNames = [...profiles.keys()];
  const profileList = `<p class="config-profiles">${profileNames.length ? `Profiles: ${profileNames.map((name) => `<code>${escapeHtml(name)}</code>`).join(" ")}` : "No profiles yet. Add files to <code>profiles/</code> next to the config; open them from the command palette."}</p>`;
  const problems = errors.length ? `<ul class="config-problems">${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>` : "";
  const unsupported = ignored.length
    ? `<details class="config-ignored"><summary>${ignored.length} setting${ignored.length === 1 ? "" : "s"} not supported yet</summary><ul>${ignored.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join("")}</ul></details>`
    : "";
  return `<section class="settings-section settings-section-stacked" aria-labelledby="config-settings-title"><div class="settings-section-copy"><h3 id="config-settings-title">Configuration</h3><p>Terminal settings use Ghostty's config format and include your Ghostty config. Changes apply when the file is saved.</p><code class="config-path">${escapeHtml(path || "not loaded")}</code>${profileList}${problems}${unsupported}</div><div class="config-actions"><button class="button button-quiet" type="button" data-action="open-config">Open config file</button><button class="button button-quiet" type="button" data-action="reload-config">Reload</button></div></section>`;
}
