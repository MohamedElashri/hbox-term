export type ConnectionPhase = "launching" | "authenticating" | "interactive" | "ready" | "disconnected" | "failed" | "cancelled";

export const phaseLabels: Record<ConnectionPhase, string> = {
  launching: "Opening session…", authenticating: "Authenticate in terminal…",
  interactive: "OpenSSH running · authentication unverified", ready: "Connected",
  disconnected: "Disconnected · reconnect to start a fresh session", failed: "Connection failed",
  cancelled: "Cancelled",
};

/** Health checks observe only. They never reconnect, send input or revive an exited pane. */
export function phaseAfterHealth(current: ConnectionPhase, running: boolean, native: boolean, shared: boolean, ready: boolean): ConnectionPhase {
  if (["launching", "disconnected", "failed", "cancelled"].includes(current)) return current;
  if (!running) return "disconnected";
  if (!native) return "ready";
  if (!shared) return "interactive";
  return ready ? "ready" : current === "ready" ? "disconnected" : "authenticating";
}

/** Commands and input buffers are deliberately excluded from reconnect requests. */
export function freshSessionRequest(sessionId: string, serverId: string, cols: number, rows: number, shellIntegration: boolean, cwd?: string) {
  return { sessionId, serverId, cols, rows, shellIntegration, cwd };
}

export function healthBatches(serverIds: string[], sessionIds: string[]) {
  const batches: { serverIds: string[]; sessionIds: string[] }[] = [];
  const count = Math.max(Math.ceil(serverIds.length / 64), Math.ceil(sessionIds.length / 512));
  for (let index = 0; index < count; index++) batches.push({ serverIds: serverIds.slice(index * 64, (index + 1) * 64), sessionIds: sessionIds.slice(index * 512, (index + 1) * 512) });
  return batches;
}
