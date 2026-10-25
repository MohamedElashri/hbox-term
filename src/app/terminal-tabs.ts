// Mouse interactions of the terminal tab strip (rendered by renderTabStrip): drag to reorder with
// pointer events (HTML drag and drop competes with the webview's file drop handling), middle
// click to close, double click to rename.
import { closeTerminalGroup, moveTab, renameTab } from "./terminal";

const DRAG_THRESHOLD = 5;

interface Drag { groupId: string; pointerId: number; startX: number; dragging: boolean }

let drag: Drag | null = null;
let suppressClick = false;

const tabOf = (target: EventTarget | null): HTMLElement | null =>
  (target as HTMLElement | null)?.closest?.<HTMLElement>(".term-tab[data-tab-group]") ?? null;

function clearIndicators(root: HTMLElement): void {
  root.querySelectorAll(".term-tab.drop-before, .term-tab.drop-after, .term-tab.dragging")
    .forEach((tab) => tab.classList.remove("drop-before", "drop-after", "dragging"));
}

/** The tab to insert before at a pointer position, or null for the end of the strip. */
function dropTarget(root: HTMLElement, x: number): { before: HTMLElement | null; tabs: HTMLElement[] } {
  const tabs = [...root.querySelectorAll<HTMLElement>(".tab-strip .term-tab[data-tab-group]")];
  const before = tabs.find((tab) => { const rect = tab.getBoundingClientRect(); return x < rect.left + rect.width / 2; }) ?? null;
  return { before, tabs };
}

export function installTabStripHandlers(root: HTMLElement): void {
  root.addEventListener("pointerdown", (event) => {
    const tab = tabOf(event.target);
    if (!tab || event.button !== 0 || (event.target as HTMLElement).closest(".term-tab-close")) return;
    drag = { groupId: tab.dataset.tabGroup!, pointerId: event.pointerId, startX: event.clientX, dragging: false };
  });
  root.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.dragging && Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD) return;
    drag.dragging = true;
    clearIndicators(root);
    const { before, tabs } = dropTarget(root, event.clientX);
    tabs.find((tab) => tab.dataset.tabGroup === drag?.groupId)?.classList.add("dragging");
    if (before) before.classList.add("drop-before"); else tabs.at(-1)?.classList.add("drop-after");
  });
  const finish = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { groupId, dragging } = drag;
    drag = null;
    clearIndicators(root);
    if (!dragging) return;
    suppressClick = true;
    const before = dropTarget(root, event.clientX).before?.dataset.tabGroup;
    if (before !== groupId) moveTab(groupId, { before: before ?? "" });
  };
  root.addEventListener("pointerup", finish);
  root.addEventListener("pointercancel", (event) => { if (drag?.pointerId === event.pointerId) { drag = null; clearIndicators(root); } });
  // A drag ends with a click on the tab; it must not also switch tabs.
  root.addEventListener("click", (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    if (tabOf(event.target)) { event.stopPropagation(); event.preventDefault(); }
  }, { capture: true });
  root.addEventListener("auxclick", (event) => {
    const tab = tabOf(event.target);
    if (tab && event.button === 1) { event.preventDefault(); void closeTerminalGroup(tab.dataset.tabGroup!); }
  });
  root.addEventListener("dblclick", (event) => {
    const tab = tabOf(event.target);
    if (tab && !(event.target as HTMLElement).closest(".term-tab-close")) void renameTab(tab.dataset.tabGroup!);
  });
}
