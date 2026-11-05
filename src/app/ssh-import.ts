import type { SshConfigEntry } from "../types";

export function importedDraft(entry: SshConfigEntry, username: string, groupName: string, identityId: string) {
  const user = entry.username || username.trim();
  if (!identityId && !user) throw new Error(`Enter a default username for ${entry.alias}.`);
  return {
    name: entry.alias, host: entry.host || entry.alias, port: entry.port || 22,
    username: user, groupName: groupName.trim(), tags: [], favorite: false,
    authMethod: identityId ? "sshAgent" : entry.keyPath ? "privateKey" : "password",
    identityId: identityId || undefined, keyPath: identityId ? undefined : entry.keyPath,
  };
}
