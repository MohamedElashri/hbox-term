import { invoke } from "@tauri-apps/api/core";
import { render } from "./render";
import { state } from "./state";
import { confirm, requestTextInput } from "./modals";
import { snapshotSession } from "./terminal";
import { showToast } from "./toasts";
import { renderWorkspaceRows, type SavedWorkspace } from "./workspace-library-view";

let entries: SavedWorkspace[] = [];
let skipped: string[] = [];
export function workspaceLibraryContent(): string {
  return `<div class="modal-body workspace-library"><p class="workspace-restore-note">Layouts reopen idle. Start each session when you’re ready. Running programs are not restored.</p><div class="workspace-library-list">${renderWorkspaceRows(entries)}</div>${skipped.length ? `<p role="status">${skipped.length} damaged layout file(s) could not be read. The files have been kept.</p>` : ""}<div class="modal-actions"><button class="button button-quiet" data-action="new-workspace-window">New window</button><button class="button button-primary" data-action="save-workspace-layout">Save current layout</button></div></div>`;
}
export async function openWorkspaceLibrary(): Promise<void> {
  const result = await invoke<{entries: SavedWorkspace[]; skipped: string[]}>("list_workspaces");
  entries = result.entries; skipped = result.skipped;
  state.modal = "workspaces"; render();
}
export async function saveWorkspaceLayout(): Promise<void> {
  const layout = snapshotSession();
  const name = await requestTextInput({ title: "Save workspace", label: "Workspace name", defaultValue: "", placeholder: "Project or task" });
  if (name === null) { await openWorkspaceLibrary(); return; }
  await invoke("save_workspace", { id: null, name, layout });
  await openWorkspaceLibrary(); showToast("Workspace saved", "info");
}
export async function openSavedWorkspace(id: string): Promise<void> {
  await invoke("new_workspace_window", { layoutId: id });
}
export async function deleteSavedWorkspace(id: string): Promise<void> {
  const entry = entries.find(entry => entry.id === id); if (!entry) return;
  if (!await confirm(`Delete the saved layout “${entry.name}”? Open windows and connections stay available.`, { title: "Delete workspace", kind: "warning", confirmLabel: "Delete layout" })) return;
  await invoke("delete_workspace", { id }); await openWorkspaceLibrary();
}
