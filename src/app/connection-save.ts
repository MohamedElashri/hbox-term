import type { ServerSaveResult } from "../types";

export interface ConnectionSaveEffects {
  persist: () => Promise<ServerSaveResult>;
  invalidate: (serverId: string) => Promise<void>;
  refresh: () => Promise<void>;
  finish: () => void;
  connect: (serverId: string) => Promise<void>;
}

/** Saving a library entry does not contact its host. Only Save & test connects. */
export async function saveConnection(testAfter: boolean, effects: ConnectionSaveEffects): Promise<void> {
  const result = await effects.persist();
  for (const serverId of result.invalidatedServerIds) await effects.invalidate(serverId);
  await effects.refresh();
  effects.finish();
  if (testAfter) await effects.connect(result.server.id);
}
