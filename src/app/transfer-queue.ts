import { invoke } from "@tauri-apps/api/core";
import { invokeCommand } from "./session";
import { errorText } from "./command-client";
import { state } from "./state";
import { render } from "./render";
import { confirm } from "./modals";
import { renderTransferQueue, type TransferJob } from "./transfer-queue-view";
import { syncTransferToast } from "./toasts";
import type { TransferProgress } from "../types";
let jobs: TransferJob[] = [];
let running = false;
export async function refreshTransferQueue(): Promise<void> { jobs = await invoke("list_transfer_jobs"); if (state.modal === "transfers") render(); }
export async function openTransferQueue(): Promise<void> { await refreshTransferQueue(); state.modal = "transfers"; render(); }
export async function enqueueTransfer(serverId: string, direction: "upload" | "download", localPath: string, remotePath: string): Promise<void> {
  await invoke("enqueue_transfer", { serverId, direction, localPath, remotePath });
  await refreshTransferQueue(); void runQueue();
}
export async function runQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (true) {
      await refreshTransferQueue(); const job = jobs.find(job => job.status === "queued"); if (!job) break;
      try { state.transfer = await invokeCommand<TransferProgress>("run_transfer_job", { id: job.id, serverId: job.serverId }); syncTransferToast(); }
      catch (error) { await refreshTransferQueue(); if (jobs.some(item => item.status === "running" || item.id === job.id && item.status === "queued")) break; if (errorText(error).includes("cancelled")) break; }
    }
  } finally { running = false; await refreshTransferQueue(); }
}
export async function transferAction(id: string, action: string): Promise<void> {
  const job = jobs.find(job => job.id === id); if (!job) return;
  if (action === "replace" && !await confirm(`Replace existing remote files for ${job.localPath}?`, { title: "Replace remote files", kind: "warning" })) return;
  await invoke("transfer_job_action", { id, action }); await refreshTransferQueue();
  if (action === "retry" || action === "replace") void runQueue();
}
export function transferQueueContent(): string { return renderTransferQueue(jobs); }
