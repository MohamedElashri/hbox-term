import { invoke } from "@tauri-apps/api/core";
import { state } from "./state";
import { snapshotSession } from "./terminal";
import { SessionWriter } from "./session-writer";

const writer = new SessionWriter(contents => invoke("save_session", { contents }));

export const sessionSavingEnabled = (): boolean => state.terminalConfig.config.windowSaveState !== "never";

export async function saveSession(): Promise<void> {
  await invoke("set_window_restore", { enabled: sessionSavingEnabled() });
  if (sessionSavingEnabled()) await writer.save(JSON.stringify(snapshotSession()));
}
