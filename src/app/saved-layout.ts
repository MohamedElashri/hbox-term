import type { PaneNode } from "./panes";

export interface SavedPane { cwd?: string; profile?: string; snapshot?: string }
export interface SavedGroup { workspace?: string; title: string; customTitle?: boolean; root: PaneNode; focusedId: string; panes: Record<string, SavedPane> }
export interface SavedSession {
  version: 1 | 2;
  activeGroup: number;
  activeWorkspace?: string;
  workspaces?: { id: string; serverId: string; label?: string }[];
  groups: SavedGroup[];
}

function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length <= max && !value.includes("\0"); }

/** Treat saved files as data, with bounded trees and no command/input fields. */
export function parseSavedLayout(value: unknown): SavedSession {
  const input = value as SavedSession | null;
  if (!input || ![1, 2].includes(input.version) || !Array.isArray(input.groups) || input.groups.length > 128) throw new Error("Unsupported or invalid workspace layout");
  const workspaceIds = new Set(["local"]);
  const workspaces = input.version === 2 ? input.workspaces ?? [] : [];
  if (!Array.isArray(workspaces) || workspaces.length > 128) throw new Error("Too many saved workspaces");
  const safeWorkspaces = workspaces.map(item => {
    if (!item || !text(item.id, 128) || !item.id || workspaceIds.has(item.id) || !text(item.serverId, 128) || !item.serverId || item.label !== undefined && !text(item.label, 200)) throw new Error("Invalid workspace reference");
    workspaceIds.add(item.id);
    return { id: item.id, serverId: item.serverId, label: item.label };
  });
  let totalLeaves = 0;
  const groups = input.groups.map(group => {
    if (!group || !text(group.title, 200) || !text(group.focusedId, 128) || !group.panes || typeof group.panes !== "object" || Array.isArray(group.panes)) throw new Error("Invalid saved terminal group");
    const workspace = input.version === 1 ? "local" : group.workspace ?? "local";
    if (!workspaceIds.has(workspace)) throw new Error("Unknown saved workspace");
    const ids = new Set<string>();
    const tree = (node: PaneNode, depth: number): PaneNode => {
      if (!node || depth > 12) throw new Error("Saved pane layout is too deep");
      if (node.kind === "leaf") {
        if (!text(node.terminalId, 128) || !node.terminalId || ids.has(node.terminalId) || ++totalLeaves > 512) throw new Error("Invalid or duplicate saved pane");
        ids.add(node.terminalId); return { kind: "leaf", terminalId: node.terminalId };
      }
      if (node.kind !== "split" || !["right", "down"].includes(node.direction) || !Number.isFinite(node.ratio) || node.ratio < .1 || node.ratio > .9) throw new Error("Invalid saved pane split");
      return { kind: "split", direction: node.direction, ratio: node.ratio, first: tree(node.first, depth + 1), second: tree(node.second, depth + 1) };
    };
    const root = tree(group.root, 0);
    const panes: Record<string, SavedPane> = Object.create(null);
    for (const id of ids) {
      const pane = Object.hasOwn(group.panes, id) ? group.panes[id] : {};
      if (!pane || typeof pane !== "object" || pane.cwd !== undefined && !text(pane.cwd, 32768) || pane.profile !== undefined && !text(pane.profile, 200) || pane.snapshot !== undefined && !text(pane.snapshot, 1_000_000)) throw new Error("Invalid saved pane contents");
      panes[id] = { cwd: pane.cwd, profile: pane.profile, snapshot: pane.snapshot };
    }
    return { workspace, title: group.title, customTitle: group.customTitle === true, root, focusedId: ids.has(group.focusedId) ? group.focusedId : [...ids][0], panes };
  });
  return { version: 2, activeGroup: Number.isSafeInteger(input.activeGroup) && input.activeGroup >= 0 ? input.activeGroup : 0, activeWorkspace: workspaceIds.has(input.activeWorkspace ?? "") ? input.activeWorkspace : "local", workspaces: safeWorkspaces, groups };
}
