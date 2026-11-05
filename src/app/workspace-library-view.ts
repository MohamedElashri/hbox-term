import { escapeHtml } from "./format.ts";
import { parseSavedLayout } from "./saved-layout.ts";
import type { PaneNode } from "./panes";

export interface SavedWorkspace { version: number; id: string; name: string; layout: unknown }

function miniature(node: PaneNode): string {
  if (node.kind === "leaf") return '<span class="workspace-preview-pane"></span>';
  const columns = node.direction === "right";
  return `<span class="workspace-preview-split" style="${columns ? "grid-template-columns" : "grid-template-rows"}:${node.ratio}fr ${1-node.ratio}fr">${miniature(node.first)}${miniature(node.second)}</span>`;
}
export function renderWorkspaceRows(entries: SavedWorkspace[]): string {
  return entries.map(entry => {
    try {
      const saved = parseSavedLayout(entry.layout);
      const local = saved.groups.filter(group => group.workspace === "local").length;
      const remote = saved.groups.length-local;
      return `<article class="saved-workspace"><div class="workspace-preview" aria-hidden="true">${saved.groups[0] ? miniature(saved.groups[0].root) : '<span class="workspace-preview-pane"></span>'}</div><div class="saved-workspace-copy"><strong>${escapeHtml(entry.name)}</strong><p>${local} local ${local === 1 ? "tab" : "tabs"}, ${remote} remote ${remote === 1 ? "tab" : "tabs"}</p></div><div class="saved-workspace-actions"><button class="button button-quiet" data-action="open-saved-workspace" data-workspace-id="${escapeHtml(entry.id)}">Open in new window</button><button class="icon-button" data-action="delete-saved-workspace" data-workspace-id="${escapeHtml(entry.id)}" aria-label="Delete ${escapeHtml(entry.name)}">×</button></div></article>`;
    } catch {
      return `<article class="saved-workspace"><div class="saved-workspace-copy"><strong>${escapeHtml(entry.name)}</strong><p>This layout cannot be opened by this version.</p></div></article>`;
    }
  }).join("") || '<div class="workspace-library-empty"><strong>Keep a layout for each project.</strong><p>Save this window’s connections and split panes, then reopen them when you need them.</p></div>';
}
