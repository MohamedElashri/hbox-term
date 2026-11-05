import { invoke } from "@tauri-apps/api/core";
import type { TerminalTab } from "../types";
import { appWindow, LOCAL_SERVER_ID, state, terminalInputChains, terminalSurfaces } from "./state";
import { confirm } from "./modals";
import { profileConfig } from "./terminal-config";
import { closeWarning, type Activity } from "./terminal-close-policy";

export async function confirmTerminalClose(tabs: TerminalTab[], title: string, background?: "quit" | "window" | "disconnect", serverId?: string): Promise<boolean> {
  const active = tabs.filter(tab => tab.sessionId && !tab.closed && !tab.connecting && profileConfig(tab.profile).confirmCloseSurface);

  let activity: Record<string, Activity> = {};
  try {
    for (let offset = 0; offset < active.length; offset += 512) Object.assign(activity, await invoke("terminal_activities", { sessionIds: active.slice(offset, offset + 512).map(tab => tab.sessionId) }));
  } catch { /* Unknown activity is confirmed conservatively. */ }
  let warning = closeWarning(active.map(tab => ({ remote: tab.serverId !== LOCAL_SERVER_ID, activity: terminalInputChains.has(tab.sessionId!) ? "busy" : activity[tab.sessionId!] ?? "unknown" })));
  if (background === "quit" || background === "disconnect") {
    try {
      const work = await invoke<{tunnels: number; transfers: number}>("background_activity", { serverId });
      const detail = [work.tunnels ? `${work.tunnels} running tunnel(s) will stop.` : "", work.transfers ? `${work.transfers} transfer(s) will stop or remain paused for later recovery.` : ""].filter(Boolean).join(" ");
      if (detail) warning = [warning, detail].filter(Boolean).join(" ");
    } catch { warning = [warning, "Background activity could not be checked."].filter(Boolean).join(" "); }
  } else if (background === "window" && state.activeOperation?.command === "run_transfer_job") warning = [warning, "This window has an active transfer. It will pause; its checkpoint is retained."].filter(Boolean).join(" ");
  if (!warning) return true;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const surface = state.activeTerminalTabId ? terminalSurfaces.get(state.activeTerminalTabId) : undefined;
  await appWindow.show().catch(() => undefined);
  await appWindow.unminimize().catch(() => undefined);
  await appWindow.setFocus().catch(() => undefined);
  const accepted = await confirm(warning, { title, kind: "warning", confirmLabel: "Close sessions" });
  if (!accepted) {
    if (state.modal && previousFocus?.isConnected) previousFocus.focus();
    else surface?.focus();
  }
  return accepted;
}
