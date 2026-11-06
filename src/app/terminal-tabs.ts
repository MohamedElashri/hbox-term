// Mouse interactions of the terminal tab strip (rendered by renderTabStrip): drag to reorder with
// pointer events (HTML drag and drop competes with the webview's file drop handling), middle
// click to close, double click to rename.
interface TabActions {
  closeTerminalGroup: (groupId: string) => Promise<void>;
  moveTab: (groupId: string, to: { before: string }) => void;
  renameTab: (groupId: string) => Promise<void>;
}

const DRAG_THRESHOLD = 5;

interface Drag { groupId: string; pointerId: number; tab: HTMLElement; startX: number; dragging: boolean }

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

export function installTabStripHandlers(root: HTMLElement, { closeTerminalGroup, moveTab, renameTab }: TabActions): void {
  let drag: Drag | null = null;
  let suppressClick = false;
  const release = (previous: Drag): void => {
    for (const target of [root, previous.tab]) {
      if (target.hasPointerCapture(previous.pointerId)) target.releasePointerCapture(previous.pointerId);
    }
  };
  const cancel = (event: PointerEvent): void => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const previous = drag;
    drag = null;
    clearIndicators(root);
    release(previous);
    if (previous.dragging) root.ownerDocument.defaultView!.setTimeout(() => { suppressClick = false; }, 0);
  };
  root.addEventListener("pointerdown", (event) => {
    const tab = tabOf(event.target);
    if (!tab || !event.isPrimary || event.button !== 0 || (event.target as HTMLElement).closest(".term-tab-close")) return;
    drag = { groupId: tab.dataset.tabGroup!, pointerId: event.pointerId, tab, startX: event.clientX, dragging: false };
    // Keep ordinary clicks targeted at the tab; capture the very first move even
    // when a fast drag jumps straight onto the terminal's separate overlay.
    tab.setPointerCapture(event.pointerId);
  });
  root.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.dragging && Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD) return;
    if (!drag.dragging) {
      drag.dragging = true;
      suppressClick = true;
      // The root survives renders and receives pointerup even outside the window.
      root.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    clearIndicators(root);
    const { before, tabs } = dropTarget(root, event.clientX);
    tabs.find((tab) => tab.dataset.tabGroup === drag?.groupId)?.classList.add("dragging");
    if (before) before.classList.add("drop-before"); else tabs.at(-1)?.classList.add("drop-after");
  });
  const finish = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const previous = drag;
    const { groupId, dragging } = previous;
    drag = null;
    clearIndicators(root);
    release(previous);
    if (!dragging) return;
    // A release outside the app may not dispatch a click to consume this flag.
    root.ownerDocument.defaultView!.setTimeout(() => { suppressClick = false; }, 0);
    const before = dropTarget(root, event.clientX).before?.dataset.tabGroup;
    if (before !== groupId) moveTab(groupId, { before: before ?? "" });
  };
  root.addEventListener("pointerup", finish);
  root.addEventListener("pointercancel", cancel);
  root.addEventListener("lostpointercapture", (event) => {
    // Transferring capture from a tab to the stable root also emits this event.
    if (!root.hasPointerCapture(event.pointerId)) cancel(event);
  });
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
