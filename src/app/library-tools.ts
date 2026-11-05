import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { state } from "./state";
import { escapeHtml } from "./format";
import { render } from "./render";
import { confirm, requestTextInput } from "./modals";
import { refreshSnapshot } from "./workspace";
import { invokeCommand } from "./session";
import { showToast } from "./toasts";
interface Recovery { id: string; serverId: string; remotePath: string; localPath: string }
let recoveries: Recovery[] = [];
export async function openLibraryTools(): Promise<void> { recoveries = await invoke("list_remote_edit_recoveries"); await refreshSnapshot(false); state.modal = "library-tools"; render(); }
export function libraryToolsContent(): string {
  return `<div class="modal-body form-stack"><h3>Organize connections</h3><form data-form="bulk-connections" class="form-stack"><div class="import-hosts">${state.snapshot.servers.map(server => `<label class="import-host"><input type="checkbox" name="ids" value="${escapeHtml(server.id)}"/><span><strong>${escapeHtml(server.name)}</strong><small>${escapeHtml(server.groupName || "Ungrouped")} · ${escapeHtml(server.host)}</small></span></label>`).join("") || "No saved connections."}</div><label class="field"><span>Group change</span><select name="groupMode"><option value="keep">Keep existing groups</option><option value="set">Set group (blank means ungrouped)</option></select><input name="group" placeholder="Group"/></label><label class="field"><span>Tags change</span><select name="tagsMode"><option value="keep">Keep existing tags</option><option value="set">Replace tags</option></select><input name="tags" placeholder="api, production"/></label><label class="field"><span>Favorites</span><select name="favorite"><option value="keep">Keep existing</option><option value="true">Favorite selected</option><option value="false">Unfavorite selected</option></select></label><button class="button button-primary" type="submit">Apply to selected</button></form><h3>Portable library backup</h3><p>Backs up connections, identities, groups, tags, commands and tunnels. External-manager references remain references. Local paths may need updating on another machine.</p><label class="favorite-check"><input type="checkbox" data-backup-secrets/><span></span>Include encrypted saved credentials</label><p class="field-hint">Unchecked by default. Included credentials require the original vault master password after restore. Terminal output, local config and workspace layouts are excluded. Notes and saved commands may contain sensitive text.</p><div class="security-actions"><button class="button button-quiet" data-action="export-library-backup">Export backup…</button><button class="button button-quiet" data-action="restore-library-backup">Restore backup…</button></div><h3>Recovered remote edits</h3>${recoveries.length ? recoveries.map(edit => `<article class="panel"><strong>${escapeHtml(edit.remotePath)}</strong><p>Local recovery copy: ${escapeHtml(edit.localPath)}</p><button class="button button-quiet" data-action="retry-edit-recovery" data-recovery-id="${escapeHtml(edit.id)}" data-server-id="${escapeHtml(edit.serverId)}">Retry safe upload</button></article>`).join("") : "<p>No abandoned remote edits.</p>"}<p>Failed saves in an open editor retain their local copy too. Close the editor again to retry; conflict uploads require explicit approval.</p></div>`;
}
export async function applyBulkConnections(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form); const ids = data.getAll("ids").map(String);
  if (!ids.length) throw new Error("Select at least one connection.");
  await invoke("bulk_connection_metadata", { ids, group: data.get("groupMode") === "set" ? String(data.get("group") || "") : undefined, tags: data.get("tagsMode") === "set" ? String(data.get("tags") || "").split(",") : undefined, favorite: data.get("favorite") === "keep" ? undefined : data.get("favorite") === "true" });
  await openLibraryTools(); showToast(`Updated ${ids.length} connections.`, "success");
}
async function backupPath(exporting: boolean): Promise<string | null> {
  try { const path = exporting ? await save({ defaultPath: "ternway-library.json" }) : await open({ multiple: false, directory: false }); return Array.isArray(path) ? path[0] ?? null : path; }
  catch { return requestTextInput({ title: exporting ? "Export library" : "Restore library", label: "Backup file path", placeholder: "~/Downloads/ternway-library.json", defaultValue: "~/Downloads/ternway-library.json" }); }
}
export async function exportLibraryBackup(includeSecrets: boolean): Promise<void> { const path = await backupPath(true); if (!path) return; await invoke("export_library_backup", { path, includeSecrets }); showToast("Library backup saved.", "success"); }
export async function restoreLibraryBackup(): Promise<void> {
  const path = await backupPath(false); if (!path) return;
  const preview = await invoke<{connections: number; identities: number; includesSecrets: boolean; checksum: string}>("preview_library_backup", { path });
  if (!await confirm(`Restore ${preview.connections} connections and ${preview.identities} identities? This replaces your current library and saved credentials. ${preview.includesSecrets ? "The backup includes an encrypted vault; unlock with its original master password." : "This backup has no saved passwords."} An automatic backup of your current library and encrypted vault is saved first. Active remote sessions will disconnect.`, { title: "Restore library backup", kind: "warning", confirmLabel: "Restore library" })) return;
  const recovery = await invoke<string>("restore_library_backup", { path, checksum: preview.checksum });
  await openLibraryTools(); showToast(`Library restored. Previous library saved at ${recovery}`, "success");
}
export async function retryEditRecovery(id: string, serverId: string): Promise<void> { await invokeCommand("retry_remote_edit_recovery", { id, serverId, overwrite: false }); await openLibraryTools(); }
