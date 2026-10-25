import { icon } from "../icons";
import { errorText } from "./command-client";
import { escapeHtml, formatBytes, meter } from "./format";
import { DEFAULT_INTERFACE_SCALE, INTERFACE_SCALE_LEVELS, appWebview, root, state } from "./state";

export function renderTransferToast(): string {
  if (!state.transfer) return "";
  const percent = state.transfer.totalBytes ? state.transfer.completedBytes / state.transfer.totalBytes * 100 : 0;
  return `<div class="transfer-toast" data-transfer-direction="${state.transfer.direction}"><span class="transfer-icon" data-transfer-icon>${icon(state.transfer.direction === "upload" ? "upload" : "download")}</span><div><strong data-transfer-label>${state.transfer.direction === "upload" ? "Uploading" : "Downloading"}</strong><span data-transfer-path>${escapeHtml(state.transfer.path)}</span></div><div class="transfer-progress"><div>${meter(percent, "accent")}</div><small data-transfer-bytes>${formatBytes(state.transfer.completedBytes)} / ${formatBytes(state.transfer.totalBytes)}</small></div><button class="transfer-cancel" type="button" data-action="cancel-transfer">Cancel</button></div>`;
}

export function syncTransferToast(): void {
  const toast = root.querySelector<HTMLElement>(".transfer-toast");
  const markup = state.transfer && !state.transfer.done ? renderTransferToast() : "";
  if (toast) {
    if (!state.transfer || state.transfer.done) {
      toast.remove();
      return;
    }
    if (toast.dataset.transferDirection !== state.transfer.direction) {
      toast.dataset.transferDirection = state.transfer.direction;
      const iconContainer = toast.querySelector<HTMLElement>("[data-transfer-icon]");
      if (iconContainer) iconContainer.innerHTML = icon(state.transfer.direction === "upload" ? "upload" : "download");
    }
    const percent = state.transfer.totalBytes ? state.transfer.completedBytes / state.transfer.totalBytes * 100 : 0;
    const label = toast.querySelector<HTMLElement>("[data-transfer-label]");
    const path = toast.querySelector<HTMLElement>("[data-transfer-path]");
    const meterFill = toast.querySelector<HTMLElement>(".meter-fill");
    const bytes = toast.querySelector<HTMLElement>("[data-transfer-bytes]");
    if (label) label.textContent = state.transfer.direction === "upload" ? "Uploading" : "Downloading";
    if (path) path.textContent = state.transfer.path;
    if (meterFill) meterFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    if (bytes) bytes.textContent = `${formatBytes(state.transfer.completedBytes)} / ${formatBytes(state.transfer.totalBytes)}`;
    return;
  }
  if (!markup) return;
  const appNotification = root.querySelector<HTMLElement>(".app-toast");
  if (appNotification) appNotification.insertAdjacentHTML("beforebegin", markup);
  else root.insertAdjacentHTML("beforeend", markup);
}

export function dismissTransferToast(transferId: string): void {
  if (state.transferDismissTimer !== undefined) window.clearTimeout(state.transferDismissTimer);
  state.transferDismissTimer = window.setTimeout(() => {
    if (state.transfer?.transferId !== transferId || !state.transfer.done) return;
    state.transfer = null;
    syncTransferToast();
  }, 1600);
}

export function renderAppToast(): string {
  if (!state.appToast) return "";
  return `<div class="app-toast ${state.appToast.kind}" role="status" aria-live="polite"><span>${icon(state.appToast.kind === "success" ? "check" : "info")}</span><strong>${escapeHtml(state.appToast.message)}</strong><button data-action="dismiss-toast" aria-label="Dismiss notification">${icon("close")}</button></div>`;
}

export function showToast(message: string, kind: "success" | "info" = "success"): void {
  state.appToast = { message, kind };
  if (state.appToastTimer !== undefined) window.clearTimeout(state.appToastTimer);
  root.querySelector<HTMLElement>(".app-toast")?.remove();
  root.insertAdjacentHTML("beforeend", renderAppToast());
  state.appToastTimer = window.setTimeout(() => dismissToast(), 2600);
}

export function syncInterfaceScaleControls(): void {
  const currentIndex = INTERFACE_SCALE_LEVELS.indexOf(state.interfaceScale as typeof INTERFACE_SCALE_LEVELS[number]);
  const value = root.querySelector<HTMLElement>("[data-interface-scale-value]");
  const decrease = root.querySelector<HTMLButtonElement>("[data-action='interface-scale-decrease']");
  const increase = root.querySelector<HTMLButtonElement>("[data-action='interface-scale-increase']");
  const reset = root.querySelector<HTMLButtonElement>("[data-action='interface-scale-reset']");
  if (value) value.textContent = `${Math.round(state.interfaceScale * 100)}%`;
  if (decrease) decrease.disabled = currentIndex <= 0;
  if (increase) increase.disabled = currentIndex >= INTERFACE_SCALE_LEVELS.length - 1;
  if (reset) reset.disabled = state.interfaceScale === DEFAULT_INTERFACE_SCALE;
}

export async function setInterfaceScale(scale: number, announce = true): Promise<void> {
  if (!INTERFACE_SCALE_LEVELS.includes(scale as typeof INTERFACE_SCALE_LEVELS[number])) return;
  try {
    await appWebview.setZoom(scale);
    state.interfaceScale = scale;
    localStorage.setItem("hbox-term-interface-scale", String(scale));
    syncInterfaceScaleControls();
    if (announce) showToast(`Interface scale set to ${Math.round(scale * 100)}%.`, "info");
  } catch (error) {
    if (announce) showToast(`Could not change interface scale: ${errorText(error)}`, "info");
  }
}

export async function stepInterfaceScale(direction: -1 | 1): Promise<void> {
  const currentIndex = INTERFACE_SCALE_LEVELS.indexOf(state.interfaceScale as typeof INTERFACE_SCALE_LEVELS[number]);
  const nextIndex = Math.max(0, Math.min(INTERFACE_SCALE_LEVELS.length - 1, currentIndex + direction));
  if (nextIndex === currentIndex) return;
  await setInterfaceScale(INTERFACE_SCALE_LEVELS[nextIndex]);
}

export function dismissToast(): void {
  if (state.appToastTimer !== undefined) window.clearTimeout(state.appToastTimer);
  state.appToastTimer = undefined;
  state.appToast = null;
  root.querySelector<HTMLElement>(".app-toast")?.remove();
}
