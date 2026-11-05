/** The alert dialog, when present, sits above the ordinary modal. */
function activeModal(root: HTMLElement): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('.modal[role="dialog"], .modal[role="alertdialog"]')].at(-1);
}

function visible(element: HTMLElement, modal: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.hasAttribute("inert") || current.getAttribute("aria-hidden") === "true") return false;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === "none" || style?.visibility === "hidden") return false;
    if (current.tagName === "DETAILS" && !current.hasAttribute("open")) {
      const summary = current.querySelector(":scope > summary");
      if (!summary?.contains(element)) return false;
    }
    if (current === modal) break;
  }
  return true;
}

function focusable(modal: HTMLElement): HTMLElement[] {
  return [...modal.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex], [contenteditable="true"]')]
    .filter(element => element.tabIndex >= 0 && !element.matches(":disabled") && !element.classList.contains("native-select-source") && visible(element, modal));
}

/** Runs after a redraw, including dialogs without an explicit autofocus field. */
export function focusModal(root: HTMLElement, previousFocus?: Element | null): void {
  const modal = activeModal(root);
  if (!modal) return;
  if (previousFocus?.isConnected && modal.contains(previousFocus) && visible(previousFocus as HTMLElement, modal)) {
    (previousFocus as HTMLElement).focus({ preventScroll: true });
    return;
  }
  if (modal.contains(root.ownerDocument.activeElement)) return;
  const controls = focusable(modal);
  const target = controls.find(element => element.hasAttribute("autofocus")) ?? controls[0] ?? modal;
  if (target === modal) modal.tabIndex = -1;
  target.focus({ preventScroll: true });
}

/** Prevent programmatic terminal focus from taking typing out of an open dialog. */
export function containModalFocus(root: HTMLElement, event: FocusEvent): void {
  const modal = activeModal(root);
  if (modal && !modal.contains(event.target as Node)) focusModal(root);
}

export function handleModalKeydown(root: HTMLElement, event: KeyboardEvent): boolean {
  const modal = activeModal(root);
  if (!modal) return false;
  const controls = focusable(modal);
  const focused = root.ownerDocument.activeElement;
  const outside = !modal.contains(event.target as Node);
  const wrap = event.key === "Tab" && (outside || !controls.includes(focused as HTMLElement)
    || (event.shiftKey ? focused === controls[0] : focused === controls.at(-1)));
  if (!outside && !wrap) return false;
  event.preventDefault();
  event.stopPropagation();
  if (wrap && controls.length) (event.shiftKey ? controls.at(-1)! : controls[0]).focus();
  else focusModal(root);
  return true;
}

/** Retain live form controls, including auth choices, instead of copying secrets into state. */
export function restoreConnectionForm(root: HTMLElement, previous: HTMLFormElement | null): void {
  const kind = previous?.dataset.form;
  if (kind !== "server" && kind !== "ssh-password") return;
  const next = root.querySelector<HTMLFormElement>(`form[data-form="${kind}"]`);
  if (previous && next && previous.dataset.connectionId === next.dataset.connectionId) next.replaceWith(previous);
}
