// Split-pane trees. A terminal tab (group) is a binary tree whose leaves are terminal sessions.
// Nodes are mutable so a divider drag can update a ratio in place.

export type SplitDirection = "right" | "down";
export type FocusDirection = "left" | "right" | "up" | "down";

export type PaneNode =
  | { kind: "leaf"; terminalId: string }
  | { kind: "split"; direction: SplitDirection; ratio: number; first: PaneNode; second: PaneNode };

export type SplitNode = Extract<PaneNode, { kind: "split" }>;

export interface Rect { x: number; y: number; width: number; height: number }

export interface Divider {
  split: SplitNode;
  rect: Rect;
  /** The area the split divides; a drag maps the pointer position into it. */
  area: Rect;
}

export const MIN_RATIO = 0.1;
/** Space between panes; the divider is drawn in it. */
export const PANE_GAP = 1;

export const leaf = (terminalId: string): PaneNode => ({ kind: "leaf", terminalId });

export function leaves(node: PaneNode): string[] {
  return node.kind === "leaf" ? [node.terminalId] : [...leaves(node.first), ...leaves(node.second)];
}

/** Replaces the leaf `targetId` with a split holding it and `newId` (after it). */
export function splitLeaf(node: PaneNode, targetId: string, newId: string, direction: SplitDirection): PaneNode {
  if (node.kind === "leaf") {
    return node.terminalId === targetId ? { kind: "split", direction, ratio: 0.5, first: node, second: leaf(newId) } : node;
  }
  node.first = splitLeaf(node.first, targetId, newId, direction);
  node.second = splitLeaf(node.second, targetId, newId, direction);
  return node;
}

/** Removes a leaf; its sibling takes the parent's place. Returns null when the tree is empty. */
export function removeLeaf(node: PaneNode, terminalId: string): PaneNode | null {
  if (node.kind === "leaf") return node.terminalId === terminalId ? null : node;
  const first = removeLeaf(node.first, terminalId);
  const second = removeLeaf(node.second, terminalId);
  if (!first) return second;
  if (!second) return first;
  node.first = first;
  node.second = second;
  return node;
}

export function replaceLeaf(node: PaneNode, oldId: string, newId: string): PaneNode {
  if (node.kind === "leaf") return node.terminalId === oldId ? leaf(newId) : node;
  node.first = replaceLeaf(node.first, oldId, newId);
  node.second = replaceLeaf(node.second, oldId, newId);
  return node;
}

/** A copy of the tree with every leaf id replaced; used to restore a saved layout. */
export function mapLeaves(node: PaneNode, rename: (terminalId: string) => string): PaneNode {
  if (node.kind === "leaf") return leaf(rename(node.terminalId));
  return { ...node, first: mapLeaves(node.first, rename), second: mapLeaves(node.second, rename) };
}

/** Computes each pane's rectangle and the dividers between them. */
export function layoutPanes(node: PaneNode, area: Rect): { panes: Map<string, Rect>; dividers: Divider[] } {
  const panes = new Map<string, Rect>();
  const dividers: Divider[] = [];
  (function place(current: PaneNode, rect: Rect): void {
    if (current.kind === "leaf") { panes.set(current.terminalId, rect); return; }
    const horizontal = current.direction === "right";
    const total = (horizontal ? rect.width : rect.height) - PANE_GAP;
    const firstSize = Math.round(total * current.ratio);
    const secondSize = total - firstSize;
    if (horizontal) {
      place(current.first, { ...rect, width: firstSize });
      place(current.second, { ...rect, x: rect.x + firstSize + PANE_GAP, width: secondSize });
      dividers.push({ split: current, area: rect, rect: { x: rect.x + firstSize, y: rect.y, width: PANE_GAP, height: rect.height } });
    } else {
      place(current.first, { ...rect, height: firstSize });
      place(current.second, { ...rect, y: rect.y + firstSize + PANE_GAP, height: secondSize });
      dividers.push({ split: current, area: rect, rect: { x: rect.x, y: rect.y + firstSize, width: rect.width, height: PANE_GAP } });
    }
  })(node, area);
  return { panes, dividers };
}

/** The pane next to `fromId` in a direction: the nearest one that overlaps it on the other axis. */
export function neighbor(panes: Map<string, Rect>, fromId: string, direction: FocusDirection): string | undefined {
  const from = panes.get(fromId);
  if (!from) return undefined;
  let best: { id: string; distance: number; offset: number } | undefined;
  for (const [id, rect] of panes) {
    if (id === fromId) continue;
    const distance = direction === "left" ? from.x - (rect.x + rect.width)
      : direction === "right" ? rect.x - (from.x + from.width)
      : direction === "up" ? from.y - (rect.y + rect.height)
      : rect.y - (from.y + from.height);
    if (distance < 0) continue;
    const horizontal = direction === "left" || direction === "right";
    const overlaps = horizontal
      ? rect.y < from.y + from.height && rect.y + rect.height > from.y
      : rect.x < from.x + from.width && rect.x + rect.width > from.x;
    if (!overlaps) continue;
    // Prefer the closest pane, then the one aligned with the top/left edge of the current pane.
    const offset = horizontal ? Math.abs(rect.y - from.y) : Math.abs(rect.x - from.x);
    if (!best || distance < best.distance || (distance === best.distance && offset < best.offset)) best = { id, distance, offset };
  }
  return best?.id;
}
