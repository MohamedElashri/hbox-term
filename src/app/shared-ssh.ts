import { invoke } from "@tauri-apps/api/core";
import { connectedServerIds, state } from "./state";
import { render } from "./render";

/** Readiness comes from the owned control socket, never from a spawned process. */
export function watchSharedSsh(): void {
  let checking = false;
  window.setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const profiles = state.snapshot.servers.filter(server => server.authMethod === "openSsh" && state.openServerTabs.some(tab => tab.serverId === server.id));
      let changed = false;
      await Promise.all(profiles.map(async server => {
        const ready = await invoke<boolean>("shared_ssh_ready", { serverId: server.id }).catch(() => false);
        // A tab/profile may have been removed while checking.
        if (!state.openServerTabs.some(tab => tab.serverId === server.id)) return;
        if (ready !== connectedServerIds.has(server.id)) {
          changed = true;
          if (ready) connectedServerIds.add(server.id); else connectedServerIds.delete(server.id);
        }
      }));
      if (changed) render();
    } finally { checking = false; }
  }, 1500);
}
