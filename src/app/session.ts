import { invoke } from "@tauri-apps/api/core";
import type { CredentialStatus } from "../types";
import { createCommandClient, errorText, OperationCancelledError } from "./command-client";
import { render } from "./render";
import { connectedServerIds, root, state } from "./state";
import type { HostKeyMismatch, HostKeyUnknown, MasterPasswordPromptMode } from "./types";

export function errorKind(error: unknown): string | null {
  const structured = error !== null && typeof error === "object" ? (error as { kind?: unknown }) : null;
  return structured && typeof structured.kind === "string" ? structured.kind : null;
}

export function requestHostKeyDecision(mismatch: HostKeyMismatch): Promise<boolean> {
  if (state.hostKeyWaiter) return state.hostKeyWaiter;
  state.hostKeyPrompt = { mismatch, error: "" };
  state.modal = "host-key";
  state.errorMessage = "";
  state.hostKeyWaiter = new Promise<boolean>((resolve) => { state.finishHostKeyWaiter = resolve; });
  render();
  return state.hostKeyWaiter;
}

export function requestHostKeyTrust(unknown: HostKeyUnknown): Promise<boolean> {
  if (state.hostKeyWaiter) return state.hostKeyWaiter;
  state.hostKeyPrompt = { unknown, error: "" };
  state.modal = "host-key";
  state.errorMessage = "";
  state.hostKeyWaiter = new Promise<boolean>((resolve) => { state.finishHostKeyWaiter = resolve; });
  render();
  return state.hostKeyWaiter;
}

export function finishHostKeyPrompt(trust: boolean): void {
  const finish = state.finishHostKeyWaiter;
  state.finishHostKeyWaiter = null;
  state.hostKeyWaiter = null;
  state.hostKeyPrompt = null;
  state.modal = null;
  render();
  finish?.(trust);
}

export function credentialPromptMode(error: unknown): MasterPasswordPromptMode {
  return errorKind(error) === "masterPasswordSetupRequired" ? "setup" : "unlock";
}

export function requestMasterPassword(mode: MasterPasswordPromptMode, error = ""): Promise<string | null> {
  if (state.masterPasswordWaiter) return state.masterPasswordWaiter;
  state.masterPasswordPrompt = { mode, error };
  state.modal = "master-password";
  state.errorMessage = "";
  state.masterPasswordWaiter = new Promise<string | null>((resolve) => { state.finishMasterPasswordWaiter = resolve; });
  render();
  window.setTimeout(() => root.querySelector<HTMLInputElement>('form[data-form="master-password"] input')?.focus(), 0);
  return state.masterPasswordWaiter;
}

export function finishMasterPasswordPrompt(value: string | null): void {
  const finish = state.finishMasterPasswordWaiter;
  state.finishMasterPasswordWaiter = null;
  state.masterPasswordWaiter = null;
  state.masterPasswordPrompt = null;
  state.modal = null;
  render();
  finish?.(value);
}

export async function unlockForCredentialError(error: unknown): Promise<void> {
  const mode = credentialPromptMode(error);
  let promptError = "";
  while (true) {
    const password = await requestMasterPassword(mode, promptError);
    if (password === null) throw new OperationCancelledError();
    try {
      state.credentialStatus = await invoke<CredentialStatus>("unlock_credentials", { masterPassword: password });
      return;
    } catch (unlockError) {
      if (errorKind(unlockError) === "masterPasswordInvalid") {
        promptError = "That master password did not unlock the local credential vault. Try again.";
        continue;
      }
      throw unlockError;
    }
  }
}

export const { cancelCurrentOperation, invokeCommand } = createCommandClient({
  getActiveOperation: () => state.activeOperation,
  setActiveOperation: (operation) => { state.activeOperation = operation; },
  onRemoteOperationSuccess: (serverId) => { connectedServerIds.add(serverId); },
  render,
  unlockForCredentialError,
  requestHostKeyDecision,
  requestHostKeyTrust,
});

export function setError(error: unknown): void {
  if (error instanceof OperationCancelledError || errorText(error).toLowerCase().includes("operation cancelled")) return;
  state.errorMessage = errorText(error);
  render();
}
