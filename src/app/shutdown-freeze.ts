import { invoke } from "@tauri-apps/api/core";
import { ShutdownToken } from "./shutdown-token";
const token = new ShutdownToken();
let overlay: HTMLElement | null = null;
let previousFocus: HTMLElement | null = null;
export const shutdownFrozen = (): boolean => token.active;
/** Keep an acknowledged window stable while another window is still saving. */
export function freezeShutdown(value: string, restart: boolean): void {
  token.freeze(value);
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlay?.remove();
  overlay = document.createElement("div"); overlay.className = "shutdown-freeze";
  const panel = document.createElement("div");
  const title = document.createElement("strong"); title.textContent = restart ? "Preparing to restart" : "Preparing to quit";
  const status = document.createElement("p"); status.setAttribute("role", "status"); status.textContent = "Saving workspaces. Waiting for all windows to finish.";
  const cancel = document.createElement("button"); cancel.className = "button button-quiet"; cancel.textContent = "Cancel";
  cancel.onclick = () => { void invoke("cancel_app_shutdown", { token: value }).catch(() => { status.textContent = "Could not cancel yet. Try again."; }); };
  panel.append(title, status, cancel); overlay.append(panel); document.body.append(overlay); cancel.focus();
}
export function releaseShutdown(value: string): void {
  if (!token.release(value)) return;
  overlay?.remove(); overlay = null;
  if (previousFocus?.isConnected) previousFocus.focus(); previousFocus = null;
}
