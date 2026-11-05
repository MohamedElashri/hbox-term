import { workspaceLibraryContent } from "./workspace-library";
import { renderAboutContent } from "./about";
import { icon } from "../icons";
import type { ServerProfile } from "../types";
import { escapeHtml, formatBytes } from "./format";
import { render } from "./render";
import { enhanceSelects } from "./select-controls";
import { renderUpdateSection } from "./updater";
import { DEFAULT_INTERFACE_SCALE, INTERFACE_SCALE_LEVELS, platform, root, state } from "./state";

export function renderAppDialog(): string {
  const prompt = state.appDialogPrompt;
  if (!prompt) return "";
  const iconName = prompt.kind === "warning" ? "shield" : "info";
  return `<div class="backdrop app-dialog-backdrop" data-app-dialog><div class="modal modal-small app-dialog" role="alertdialog" aria-modal="true"><div class="modal-head"><div><div class="eyebrow">Ternway</div><h2>${escapeHtml(prompt.title)}</h2></div><button class="close-button" data-action="cancel-app-dialog" aria-label="Close dialog">${icon("close")}</button></div><div class="modal-body form-stack"><div class="app-dialog-message ${prompt.kind}">${icon(iconName)}<p>${escapeHtml(prompt.message)}</p></div><div class="modal-actions"><span></span><div class="modal-actions-right">${prompt.cancelLabel ? `<button class="button button-quiet" data-action="cancel-app-dialog">${escapeHtml(prompt.cancelLabel)}</button>` : ""}<button class="button ${prompt.kind === "warning" ? "button-danger" : "button-primary"}" data-action="accept-app-dialog">${escapeHtml(prompt.confirmLabel)}</button></div></div></div></div></div>`;
}

export function confirm(messageText: string, options: { title?: string; kind?: string; confirmLabel?: string } = {}): Promise<boolean> {
  if (state.finishAppDialogWaiter) return Promise.resolve(false);
  state.appDialogPrompt = { title: options.title ?? "Confirm action", message: messageText, kind: options.kind === "warning" ? "warning" : "info", confirmLabel: options.confirmLabel ?? "Continue", cancelLabel: "Cancel" };
  const waiter = new Promise<boolean>((resolve) => { state.finishAppDialogWaiter = resolve; });
  root.insertAdjacentHTML("beforeend", renderAppDialog());
  window.setTimeout(() => root.querySelector<HTMLButtonElement>('[data-action="accept-app-dialog"]')?.focus(), 0);
  return waiter;
}

export async function message(messageText: string, options: { title?: string } = {}): Promise<void> {
  if (state.finishAppDialogWaiter) return;
  state.appDialogPrompt = { title: options.title ?? "Ternway", message: messageText, kind: "info", confirmLabel: "Close" };
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
  if (state.modal === "workspaces") return renderModalShell("Workspaces", "Saved connections and terminal layouts for each project.", workspaceLibraryContent(), "modal-workspaces");
  if (state.modal === "server") return renderServerModal();
  if (state.modal === "workspace-tab-rename") return renderWorkspaceTabRenameModal();
  if (state.modal === "service") return renderServiceModal();
  if (state.modal === "editor") return renderEditorModal();
  if (state.modal === "folder") return renderFolderModal();
  if (state.modal === "docker") return renderDockerModal();
  if (state.modal === "input-prompt") return renderTextInputModal();
  if (state.modal === "compose-scale") return renderComposeScaleModal();
  if (state.modal === "ssh-import") return renderSshImportModal();
  if (state.modal === "identities") return renderIdentitiesModal();
  if (state.modal === "about") return renderModalShell("About Ternway", "A desktop workspace for local and remote development.", renderAboutContent(), "modal-about");
  if (state.modal === "updates") return renderModalShell("Software update", "Get the latest Ternway release from GitHub.", `<div class="modal-body">${renderUpdateSection(true)}<div class="modal-actions"><button class="button button-quiet" data-action="close-modal">Done</button></div></div>`, "modal-updates");
  if (state.modal === "security") return renderSecurityModal();
  if (state.modal === "ssh-password") return renderSshPasswordModal();
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
  return `<div class="backdrop" data-backdrop><div class="modal ${size}" role="dialog" aria-modal="true"><div class="modal-head"><div><div class="eyebrow">Ternway</div><h2>${title}</h2><p>${subtitle}</p></div><button class="close-button" data-action="close-modal" aria-label="Close dialog">${icon("close")}</button></div>${body}</div></div>`;
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
      `<div class="modal-body form-stack"><div class="credential-warning">${icon("shield")}<div><strong>Review the server's fingerprint before trusting it.</strong><p>Ternway never trusts a first-contact host key silently. Verify this fingerprint through a trusted channel before it is added to your known hosts.</p></div></div>${prompt.error ? `<div class="inline-error">${icon("info")}<span>${escapeHtml(prompt.error)}</span></div>` : ""}<div class="host-key-comparison"><div><span>Key type</span><code>${escapeHtml(unknown.keyType)}</code></div><div><span>Fingerprint</span><code>${escapeHtml(unknown.fingerprint)}</code></div></div><p class="security-footnote">Trusting adds this key to <code>~/.ssh/known_hosts</code>; future changes will be flagged.</p><div class="modal-actions"><button type="button" class="button button-quiet" data-action="reject-host-key">Cancel</button><button type="button" class="button button-danger" data-action="trust-host-key">Trust key &amp; connect</button></div></div>`,
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
  return renderModalShell("Create Linux user", "The password is sent through the protected SSH channel and is never saved by Ternway.", `<form class="modal-body form-stack" data-form="user"><div class="credential-warning">${icon("info")}<div><strong>Password changes are immediate.</strong><p>Share credentials through a secure channel and require the user to rotate them after first login.</p></div></div><label class="field"><span>Username</span><input name="name" required pattern="[A-Za-z0-9_.+-]+"/></label><div class="form-grid"><label class="field"><span>Home directory</span><input name="home" placeholder="created automatically"/></label><label class="field"><span>Login shell <small>optional</small></span><input name="shell" placeholder="use the server default"/></label></div><label class="field"><span>Supplementary groups <small>comma separated</small></span><input name="groups" placeholder="sudo,docker"/></label><label class="field"><span>Initial password <small>optional</small></span><input name="password" type="password" autocomplete="new-password"/></label><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Create user</button></div></form>`, "modal-security");
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
  return renderModalShell(tunnel ? "Edit SSH tunnel" : "Add SSH tunnel", "Tunnels remain active while Ternway is running or until you stop them.", `<form class="modal-body form-stack" data-form="tunnel"><label class="field"><span>Name</span><input name="name" required value="${escapeHtml(tunnel?.name ?? "")}" placeholder="Production database"/></label><label class="field"><span>Type</span><select name="kind"><option value="local" ${tunnel?.kind === "local" ? "selected" : ""}>Local forwarding</option><option value="remote" ${tunnel?.kind === "remote" ? "selected" : ""}>Remote forwarding</option><option value="socks" ${tunnel?.kind === "socks" ? "selected" : ""}>SOCKS5 proxy</option></select></label><div class="form-grid"><label class="field"><span>Bind host</span><input name="bindHost" required value="${escapeHtml(tunnel?.bindHost ?? "127.0.0.1")}"/></label><label class="field"><span>Bind port</span><input name="bindPort" type="number" min="1" max="65535" required value="${tunnel?.bindPort ?? 5433}"/></label><label class="field"><span>Target host</span><input name="targetHost" value="${escapeHtml(tunnel?.targetHost ?? "127.0.0.1")}" placeholder="Ignored for SOCKS"/></label><label class="field"><span>Target port</span><input name="targetPort" type="number" min="1" max="65535" value="${tunnel?.targetPort ?? 5432}"/></label></div><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Cancel</button><button class="button button-primary">Save tunnel</button></div></form>`, "modal-small");
}

export function renderServerModal(): string {
  const server = state.editingServer;
  const isEdit = Boolean(server);
  const bastions = state.snapshot.servers.filter((candidate) => candidate.authMethod !== "openSsh" && candidate.id !== server?.id && !profileRouteContains(candidate, server?.id));
  const route = `<div class="form-divider"><span>Connection route</span></div><label class="field"><span>Bastion host <small>optional</small></span><select name="jumpHostId"><option value="">Direct connection</option>${bastions.map((candidate) => `<option value="${escapeHtml(candidate.id)}" ${server?.jumpHostId === candidate.id ? "selected" : ""}>${escapeHtml(profileRouteLabel(candidate))}</option>`).join("")}</select><small class="field-hint">Ternway connects to this profile through the selected bastion. Bastions may use another bastion, creating a secure jump chain.</small></label>`;
  return renderModalShell(isEdit ? "Edit connection" : "New SSH connection", isEdit ? "Update the profile without losing its saved secrets." : "Choose a host and how to sign in. You can organize the connection later.", `<form class="modal-body form-stack" data-form="server" data-connection-id="${escapeHtml(server?.id ?? "new")}"><div class="form-grid"><label class="field"><span>Display name <small>optional</small></span><input name="name" value="${escapeHtml(server?.name ?? "")}" placeholder="Uses the hostname when blank"/></label><label class="field field-wide"><span>Host or IP</span><input name="host" ${server?.authMethod === "openSsh" ? "disabled" : "required autofocus"} autocapitalize="none" spellcheck="false" value="${escapeHtml(server?.host ?? "")}" placeholder="203.0.113.10"/></label><label class="field"><span>Username</span><input name="username" ${server?.authMethod === "sshAgent" || server?.authMethod === "openSsh" ? "disabled" : "required"} value="${escapeHtml(server?.username ?? "")}" placeholder="ubuntu"/></label></div>${state.snapshot.sshConfigEntries.length ? `<label class="field"><span>Import from ~/.ssh/config</span><select data-field="ssh-config"><option value="">Choose a saved host alias…</option>${state.snapshot.sshConfigEntries.map((entry) => `<option value="${escapeHtml(entry.alias)}" ${entry.service || entry.issues?.length ? "disabled" : ""}>${escapeHtml(entry.alias)}${entry.host ? ` · ${escapeHtml(entry.host)}` : ""}</option>`).join("")}</select></label>` : ""}<div class="form-divider"><span>Authentication</span></div><div class="auth-switch"><label class="auth-option"><input type="radio" name="authMethod" value="password" ${!server || server.authMethod === "password" ? "checked" : ""}/><span>${icon("shield")}<strong>Password</strong><small>Ask when connecting or save locally</small></span></label><label class="auth-option"><input type="radio" name="authMethod" value="privateKey" ${server?.authMethod === "privateKey" ? "checked" : ""}/><span>${icon("key")}<strong>Private key</strong><small>Use a key from ~/.ssh</small></span></label><label class="auth-option"><input type="radio" name="authMethod" value="sshAgent" ${server?.authMethod === "sshAgent" ? "checked" : ""}/><span>${icon("key")}<strong>SSH agent</strong><small>Reusable identity</small></span></label><label class="auth-option"><input type="radio" name="authMethod" value="openSsh" ${server?.authMethod === "openSsh" ? "checked" : ""}/><span>${icon("terminalSmall")}<strong>OpenSSH config</strong><small>Use your config unchanged</small></span></label></div><div class="auth-fields" data-auth-fields>${renderAuthFields(server)}</div><details class="connection-options" data-managed-route ${server?.authMethod === "openSsh" ? "hidden" : ""} ${server?.jumpHostId || (server && server.port !== 22) ? "open" : ""}><summary>Connection route <small>Port and jump host</small></summary><div class="form-stack"><label class="field"><span>Port</span><input name="port" type="number" min="1" max="65535" value="${server?.port ?? 22}"/></label>${route}</div></details><details class="connection-options" open><summary>Organization <small>Group, tags and notes</small></summary><div class="form-stack"><label class="field"><span>Group</span><input name="groupName" list="connection-groups" value="${escapeHtml(server?.groupName ?? "")}" placeholder="Production"/><datalist id="connection-groups">${[...new Set(state.snapshot.servers.map(s => s.groupName).filter(Boolean))].map(g => `<option value="${escapeHtml(g!)}"></option>`).join("")}</datalist></label><label class="field"><span>Tags <small>comma separated</small></span><input name="tags" value="${escapeHtml(server?.tags.join(", ") ?? "")}" placeholder="production, api, eu-west"/></label><label class="field"><span>Notes <small>stored locally and included in search</small></span><textarea name="notes" rows="5" placeholder="Purpose, provider, URLs, emergency steps…">${escapeHtml(server?.notes ?? "")}</textarea></label><label class="favorite-check"><input type="checkbox" name="favorite" ${server?.favorite ? "checked" : ""}/><span></span>Favorite connection</label></div></details><div class="connection-form-error inline-error" data-connection-error role="alert" hidden></div><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Cancel</button><div class="modal-actions-right"><button type="button" class="button button-quiet" data-action="save-and-test">${icon("refresh")} ${server?.authMethod === "openSsh" ? "Save & open" : "Save & test"}</button><button type="submit" class="button button-primary">${isEdit ? "Save changes" : "Save connection"}</button></div></div></form>`, "modal-server");
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
  if (auth === "openSsh") return `<p>OpenSSH handles authentication, jump hosts, proxies, certificates, forwarding and config rules. File browsing and tunnels can share the authenticated connection.</p><label class="field"><span>OpenSSH host alias</span><input name="openSshAlias" required value="${escapeHtml(server?.openSsh?.alias ?? server?.host ?? "")}" placeholder="work-server" autocapitalize="none" spellcheck="false"/></label><label class="field"><span>SSH config file <small>optional</small></span><input name="openSshConfigPath" value="${escapeHtml(server?.openSsh?.configPath ?? "")}" placeholder="Leave blank for normal user and system config" spellcheck="false"/></label><label class="field"><span>Connection sharing</span><select name="openSshSharing"><option value="shared" ${server?.openSsh?.shareConnection !== false ? "selected" : ""}>Share with files and tunnels</option><option value="config" ${server?.openSsh?.shareConnection === false ? "selected" : ""}>Use configured multiplexing (terminal only)</option></select></label><p class="field-hint">Config changes apply next time you connect. Configured commands and forwarding run only when you open a terminal. Passwords, key passphrases and host-key questions appear in the terminal.</p>`;
  if (auth === "sshAgent") return `<label class="field"><span>Identity</span><select name="identityId" required><option value="">Choose an identity…</option>${state.snapshot.identities.filter(i => i.provider === "sshAgent").map(i => `<option value="${escapeHtml(i.id)}" ${server?.identityId === i.id ? "selected" : ""}>${escapeHtml(i.name)} (${escapeHtml(i.username)})</option>`).join("")}</select><small class="field-hint">Uses the identity's username. Create identities in Settings → SSH identities. Your agent may ask you to approve access.</small></label>`;
  if (auth === "privateKey") return `<label class="field"><span>Private key</span><select name="keyPath"><option value="">Choose a key…</option>${state.snapshot.sshKeys.map((key) => `<option value="${escapeHtml(key.path)}" ${server?.keyPath === key.path ? "selected" : ""}>${escapeHtml(key.name)} · ${escapeHtml(key.kind)}</option>`).join("")}</select>${state.snapshot.sshKeys.length ? "" : `<small class="field-hint">No keys detected in ~/.ssh. You can still paste a path below.</small>`}<input name="customKeyPath" value="${escapeHtml(server?.keyPath && !state.snapshot.sshKeys.some((key) => key.path === server.keyPath) ? server.keyPath : "")}" placeholder="Absolute path to your private key"/></label><label class="field"><span>Key passphrase <small>optional · leave blank to keep</small></span><input name="keyPassphrase" type="password" autocomplete="new-password" placeholder="Only if the key is encrypted"/></label><label class="field"><span>Sudo password <small>optional · for protected actions</small></span><input name="sudoPassword" type="password" autocomplete="new-password" placeholder="Leave blank if sudo is passwordless"/></label>`;
  return `<label class="field"><span>Password source</span><select name="passwordProvider"><option value="local" ${!server?.passwordReference ? "selected" : ""}>Ask when connecting / encrypted local vault</option><option value="onePassword" ${server?.passwordReference?.provider === "onePassword" ? "selected" : ""}>1Password CLI</option><option value="bitwarden" ${server?.passwordReference?.provider === "bitwarden" ? "selected" : ""}>Bitwarden CLI</option></select></label><label class="field"><span>Password reference <small>external providers only</small></span><input name="passwordReference" value="${escapeHtml(server?.passwordReference?.reference ?? "")}" placeholder="op://vault/item/password or Bitwarden item UUID" autocomplete="off" spellcheck="false"/><small class="field-hint">Only the reference is saved. Sign in to the provider CLI first; the password is read only when connecting. Leave the password below empty for external providers.</small></label><label class="field"><span>Password <small>${server ? "leave blank to keep" : ""}</small></span><input name="password" type="password" autocomplete="current-password" placeholder="Leave blank to ask when connecting"/></label><label class="field"><span>Sudo password <small>optional · leave blank to use passwordless sudo</small></span><input name="sudoPassword" type="password" autocomplete="new-password" placeholder="Only needed for protected actions"/></label>`;
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
  const configured = state.credentialStatus.configured;
  const status = !configured ? "Not set up" : state.credentialStatus.unlocked ? "Unlocked for this session" : "Locked";
  const scalePercent = Math.round(state.interfaceScale * 100);
  const scaleIndex = INTERFACE_SCALE_LEVELS.indexOf(state.interfaceScale as typeof INTERFACE_SCALE_LEVELS[number]);
  const sections = [["appearance", "Appearance"], ["terminal", "Terminal"], ["connections", "Connections"], ["updates", "Updates"], ["about", "About"]] as const;
  return renderModalShell("Settings", "Appearance, terminal preferences and connection security.", `
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings sections">
        ${sections.map(([id, label]) => `<button class="button button-quiet" data-action="settings-jump" data-settings-target="settings-${id}">${label}</button>`).join("")}
      </nav>
      <div class="settings-content">
        <section class="settings-group" id="settings-appearance" tabindex="-1" aria-labelledby="settings-appearance-title">
          <h3 id="settings-appearance-title">Appearance</h3>
          <div class="settings-row"><div class="settings-row-copy"><h4>Theme</h4><p>Choose a light or dark workspace.</p></div><button class="button button-quiet" data-action="theme">${icon(state.darkMode ? "sun" : "moon")} Use ${state.darkMode ? "light" : "dark"} theme</button></div>
          <div class="settings-row"><div class="settings-row-copy"><h4>Interface scale</h4><p>Resize the interface. Use ${platform === "macos" ? "Command" : "Ctrl"} +/− or 0 outside the terminal.</p></div>
            <div class="interface-scale-control" role="group" aria-label="Interface scale">
              <button class="icon-button" type="button" data-action="interface-scale-decrease" aria-label="Decrease interface scale" ${scaleIndex <= 0 ? "disabled" : ""}>${icon("minus")}</button>
              <output data-interface-scale-value aria-live="polite">${scalePercent}%</output>
              <button class="icon-button" type="button" data-action="interface-scale-increase" aria-label="Increase interface scale" ${scaleIndex >= INTERFACE_SCALE_LEVELS.length - 1 ? "disabled" : ""}>${icon("plus")}</button>
              <button class="button button-quiet scale-reset" type="button" data-action="interface-scale-reset" ${state.interfaceScale === DEFAULT_INTERFACE_SCALE ? "disabled" : ""}>Reset</button>
            </div>
          </div>
        </section>
        <section class="settings-group" id="settings-terminal" tabindex="-1" aria-labelledby="settings-terminal-title">
          <h3 id="settings-terminal-title">Terminal</h3>
          <div class="settings-row"><div class="settings-row-copy"><h4>Renderer</h4><p>Automatic chooses the renderer for your platform. Try DOM if WebGL has display issues.</p></div>
            <label class="field settings-renderer"><span class="sr-only">Terminal renderer</span><select data-field="terminal-renderer" aria-label="Terminal renderer">${(["auto", "webgl", "dom"] as const).map(value => `<option value="${value}" ${state.terminalRenderer === value ? "selected" : ""}>${{ auto: "Automatic", webgl: "WebGL", dom: "DOM" }[value]}</option>`).join("")}</select></label>
          </div>
          ${renderConfigSettings()}
        </section>
        <section class="settings-group" id="settings-connections" tabindex="-1" aria-labelledby="settings-connections-title">
          <h3 id="settings-connections-title">Connections</h3>
          <div class="settings-row"><div class="settings-row-copy"><h4>SSH identities</h4><p>Manage the SSH agents used by your saved connections.</p></div><button class="button button-quiet" data-action="manage-identities">Manage identities</button></div>
          <div class="settings-row"><div class="settings-row-copy"><h4>Credential vault <span class="settings-status">${status}</span></h4><p>Saved passwords stay encrypted on this device.</p></div><button class="button button-quiet" data-action="change-master-password" ${configured ? "" : "disabled"}>Change master password</button></div>
          ${state.credentialSettingsNotice ? `<div class="security-notice" role="status">${icon("check")}<span>${escapeHtml(state.credentialSettingsNotice)}</span></div>` : ""}
          ${state.credentialSettingsError ? `<div class="inline-error" role="alert">${icon("info")}<span>${escapeHtml(state.credentialSettingsError)}</span></div>` : ""}
          <div class="settings-row"><div class="settings-row-copy"><h4>Lock saved credentials</h4><p>Locks after 15 minutes without activity, on screen lock, or when Ternway loses focus. Running sessions stay connected.</p></div><button class="button button-quiet" data-action="lock-vault">Lock now</button></div>
          <div class="settings-row"><div class="settings-row-copy"><h4>Terminal privacy</h4><p>Clipboard history and saved scrollback are off by default. Configure clipboard-history and save-scrollback in your terminal config to opt in. Raw terminal logs may contain secrets.</p></div><button class="button button-quiet" data-action="clear-private-history">Clear clipboard and logs</button></div>
          <details class="settings-reset"><summary>Credential recovery and reset</summary>${renderCredentialWarning()}<p>Resetting deletes saved secrets and keeps your connection profiles. You can create a new vault when you next save a password.</p><button class="button button-danger" data-action="reset-credentials" ${configured ? "" : "disabled"}>${icon("trash")} Reset saved credentials</button></details>
        </section>
        <div class="settings-group" id="settings-updates" tabindex="-1" role="region" aria-label="Updates">${renderUpdateSection()}</div>
        <section class="settings-group" id="settings-about" tabindex="-1" aria-labelledby="settings-about-title">
          <h3 id="settings-about-title">About</h3>
          <div class="settings-row"><div class="settings-row-copy"><h4>Ternway</h4><p>Version, build details, credits and project links.</p></div><button class="button button-quiet" data-action="show-about">About Ternway</button></div>
        </section>
      </div>
    </div>
    <div class="settings-footer"><button class="button button-primary" data-action="close-modal">Done</button></div>
  `, "modal-settings");
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
    const username = form.elements.namedItem("username") as HTMLInputElement | null;
    const linked = selected === "openSsh";
    if (username) { username.disabled = selected === "sshAgent" || linked; username.required = selected !== "sshAgent" && !linked; }
    const host = form.elements.namedItem("host") as HTMLInputElement | null;
    if (host) { host.disabled = linked; host.required = !linked; }
    const route = form.querySelector<HTMLElement>("[data-managed-route]");
    if (route) {
      route.hidden = linked;
      route.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select").forEach(field => { field.disabled = linked; });
    }
    const test = form.querySelector<HTMLButtonElement>('[data-action="save-and-test"]');
    if (test) test.textContent = linked ? "Save & open" : "Save & test";
    target.innerHTML = renderAuthFields(state.editingServer, selected as "password" | "privateKey" | "sshAgent");
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
  return `<section class="settings-section settings-section-stacked" aria-labelledby="config-settings-title"><div class="settings-section-copy"><h4 id="config-settings-title">Configuration file</h4><p>Terminal settings use Ghostty's config format and include your Ghostty config. Changes apply when the file is saved.</p><code class="config-path">${escapeHtml(path || "not loaded")}</code>${profileList}${problems}${unsupported}</div><div class="config-actions"><button class="button button-quiet" type="button" data-action="open-config">Open config file</button><button class="button button-quiet" type="button" data-action="reload-config">Reload</button></div></section>`;
}

function renderIdentitiesModal(): string {
  return renderModalShell("SSH identities", "Reuse an agent identity across connections. Private keys remain with your SSH agent or password manager.", `<div class="modal-body form-stack">${state.snapshot.identities.map(i => `<div class="identity-row"><div><strong>${escapeHtml(i.name)}</strong><p>${escapeHtml(i.username)} · ${escapeHtml(i.reference)}</p></div><button class="button button-quiet" data-action="delete-identity" data-identity-id="${escapeHtml(i.id)}" aria-label="Delete ${escapeHtml(i.name)}">Delete</button></div>`).join("") || `<p>No identities yet. Use your system SSH agent or configure an agent socket below.</p>`}<form class="form-stack" data-form="identity"><label class="field"><span>Name</span><input name="name" required placeholder="Work SSH agent"/></label><label class="field"><span>SSH username</span><input name="username" required placeholder="alice"/></label><label class="field"><span>Agent endpoint</span><input name="reference" required value="env:SSH_AUTH_SOCK" placeholder="env:SSH_AUTH_SOCK or an absolute socket path" spellcheck="false"/><small class="field-hint">Uses the standard SSH-agent protocol. The system endpoint reads SSH_AUTH_SOCK when you connect; an explicit socket works with OpenSSH and compatible agents. The agent handles key access and signing approval.</small></label><div class="security-actions"><button type="button" class="button button-quiet" data-action="use-system-ssh-agent">Use system agent</button><button type="button" class="button button-quiet" data-action="check-ssh-agent">Check agent</button></div><details class="connection-options"><summary>Agent shortcuts</summary><button type="button" class="button button-quiet" data-action="find-onepassword-agent">Find 1Password socket</button><p>This only fills the endpoint. All agents use the same signing flow.</p></details><p data-agent-status role="status" aria-live="polite"></p><div data-identity-error class="connection-form-error inline-error" role="alert" hidden></div><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Close</button><button type="submit" class="button button-primary">Create identity</button></div></form></div>`, "modal-security");
}

function renderSshPasswordModal(): string {
  const prompt = state.sshPasswordPrompt;
  if (!prompt) return "";
  const server = state.snapshot.servers.find(item => item.id === prompt.serverId);
  const target = server ? `${server.username}@${server.host}:${server.port}` : "your SSH connection";
  return renderModalShell("SSH password", escapeHtml(target), `<form class="modal-body form-stack" data-form="ssh-password" data-connection-id="${escapeHtml(prompt.serverId)}"><p>${escapeHtml(prompt.message)}</p><label class="field"><span>SSH password</span><input name="password" type="password" required autofocus autocomplete="current-password"/></label><label class="favorite-check"><input name="remember" type="checkbox"/><span></span>Save in the encrypted vault</label><p class="field-hint">Otherwise, keep it in memory until you disconnect or quit Ternway. Your SSH password is separate from your vault master password.</p><div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Cancel</button><button type="submit" class="button button-primary">Connect</button></div></form>`, "modal-security");
}

function renderSshImportModal(): string {
  return renderModalShell("Import SSH config", "Select hosts to save in your connection library.", `<form class="modal-body form-stack" data-form="ssh-import" data-connection-id="ssh-import">
    <label class="field"><span>Configuration file</span><input name="path" value="~/.ssh/config"/><small>Finds explicit aliases without running config commands. Git services are left unchecked; advanced aliases need an explicit selection.</small></label>
    <button type="button" class="button button-quiet" data-action="load-ssh-config">Read configuration</button>
    <label class="field"><span>Connection mode</span><select name="importMode" data-field="import-mode"><option value="linked">Keep linked to OpenSSH config (recommended)</option><option value="managed">Copy supported settings into managed connections</option></select><small>Linked connections use OpenSSH routing and authentication, with shared file browsing and tunnels. Managed connections offer additional server tools with limited config support.</small></label>
    <div data-import-hosts>Select a file and read its configuration.</div>
    <label class="field"><span>Destination group</span><input name="groupName" value="Imported" required/></label>
    <label class="field"><span>Default username <small>for hosts without User</small></span><input name="username" placeholder="ubuntu" disabled/></label>
    <label class="field"><span>SSH agent identity <small>optional; overrides imported username and key</small></span><select name="identityId" disabled><option value="">Use imported key or configure password later</option>${state.snapshot.identities.filter(i => i.provider === "sshAgent").map(i => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}</option>`).join("")}</select></label>
    <p>Existing profiles are kept. Imported profiles do not connect automatically. OpenSSH-linked profiles always read the source config when connecting.</p>
    <div data-import-error role="status"></div>
    <div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Close</button><button type="submit" class="button button-primary">Import selected hosts</button></div>
  </form>`, "modal-ssh-import");
}
