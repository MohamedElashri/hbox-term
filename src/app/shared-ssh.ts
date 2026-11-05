import { invoke } from "@tauri-apps/api/core";
import { connectedServerIds, LOCAL_SERVER_ID, state, terminalSurfaces } from "./state";
import { render } from "./render";
import { healthBatches, phaseAfterHealth } from "./connection-lifecycle";

interface Health { sessions: Record<string, boolean>; connections: Record<string, boolean> }

/** Polling, wake and network events only observe existing sessions. Reconnect is explicit. */
export function watchSharedSsh(): void {
  let checking = false;
  const check = async (): Promise<void> => {
    if (checking) return;
    checking = true;
    const version = state.navigationVersion;
    const tabs = state.terminalTabs.filter(tab => !tab.connecting && !tab.closed && tab.sessionId);
    const serverIds = [...new Set(state.openServerTabs.map(tab => tab.serverId))];
    try {
      const responses = await Promise.all(healthBatches(serverIds, tabs.map(tab => tab.sessionId!)).map(args => invoke<Health>("connection_health", args)));
      const health: Health = { sessions: Object.assign({}, ...responses.map(response => response.sessions)), connections: Object.assign({}, ...responses.map(response => response.connections)) };
      if (version !== state.navigationVersion) return;
      let changed = false;
      for (const serverId of serverIds) {
        if (!state.openServerTabs.some(tab => tab.serverId === serverId)) continue;
        const ready = health.connections[serverId] === true;
        if (ready !== connectedServerIds.has(serverId)) {
          changed = true;
          if (ready) connectedServerIds.add(serverId); else connectedServerIds.delete(serverId);
        }
      }
      for (const tab of tabs) {
        if (!state.terminalTabs.includes(tab) || tab.closed || tab.connecting) continue;
        const profile = state.snapshot.servers.find(server => server.id === tab.serverId);
        const phase = phaseAfterHealth(tab.phase ?? "ready", health.sessions[tab.sessionId!] === true, profile?.authMethod === "openSsh", profile?.openSsh?.shareConnection !== false, health.connections[tab.serverId] === true);
        if (phase !== tab.phase) {
          tab.phase = phase; changed = true;
          if (phase === "disconnected") {
            tab.closed = true;
            void invoke("close_terminal", { sessionId: tab.sessionId }).catch(() => undefined);
            terminalSurfaces.get(tab.id)?.notice(tab.serverId === LOCAL_SERVER_ID ? "Shell exited" : "Connection lost. Reconnect opens a fresh session; previous commands are not replayed.");
          }
        }
      }
      if (changed) render();
    } catch { /* An unavailable IPC endpoint is not evidence that a remote process died. */ }
    finally { checking = false; }
  };
  window.setInterval(() => { void check(); }, 2000);
  window.addEventListener("online", () => { void check(); });
  window.addEventListener("offline", () => { void check(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void check(); });
  window.addEventListener("focus", () => { void check(); });
}
