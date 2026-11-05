import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { finishMasterPasswordPrompt, finishSshPasswordPrompt } from "./session";
import { clearClipboardHistory } from "./terminal";
import { root, state } from "./state";
import { render } from "./render";

/** Clears form copies in every window; active SSH transports retain their own authentication. */
export async function installCredentialPrivacy(): Promise<void> {
  await listen("vault-locked", () => {
    state.credentialStatus.unlocked = false;
    root.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach(input => { input.value = ""; });
    clearClipboardHistory();
    if (state.masterPasswordWaiter) finishMasterPasswordPrompt(null);
    if (state.finishSshPasswordWaiter) finishSshPasswordPrompt(null);
    if (["server", "change-password", "reset-credentials", "user-password"].includes(state.modal ?? "")) state.modal = null;
    render();
  });
  // Also protects systems whose screen locker does not publish a native session signal.
  window.addEventListener("blur", () => { void invoke("lock_credentials"); });
  let lastActivity = 0;
  const activity = () => {
    if (Date.now() - lastActivity < 30_000) return;
    lastActivity = Date.now();
    void invoke("credential_activity");
  };
  for (const event of ["keydown", "pointerdown", "pointermove"]) window.addEventListener(event, activity, { passive: true });
}
