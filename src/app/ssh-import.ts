import { escapeHtml } from "./format.ts";
import type { SshConfigEntry } from "../types";

export function renderImportChoices(entries: SshConfigEntry[]): string {
  return entries.length ? entries.map((entry, index) => {
    const issues = entry.issues ?? [];
    const checked = !entry.service && !issues.length ? "checked" : "";
    const disabled = issues.length ? "disabled" : "";
    const detail = [entry.service, ...issues].filter(Boolean).map(value => `<small>${escapeHtml(value)}</small>`).join("");
    return `<label class="import-host"><input type="checkbox" name="hosts" value="${index}" ${checked} ${disabled}/><span><strong>${escapeHtml(entry.alias)}</strong><small>${escapeHtml(entry.username || "default user")}@${escapeHtml(entry.host || entry.alias)}:${entry.port || 22}</small>${detail}</span></label>`;
  }).join("") : "No explicit Host aliases found.";
}

export function importedDraft(entry: SshConfigEntry, username: string, groupName: string, identityId: string) {
  if (entry.issues?.length) throw new Error(`${entry.alias} needs manual configuration: ${entry.issues.join("; ")}`);
  const user = entry.username || username.trim();
  if (!identityId && !user) throw new Error(`Enter a default username for ${entry.alias}.`);
  return {
    name: entry.alias, host: entry.host || entry.alias, port: entry.port || 22,
    username: user, groupName: groupName.trim(), tags: [], favorite: false,
    authMethod: identityId ? "sshAgent" : entry.authMethod ?? (entry.keyPath ? "privateKey" : "password"),
    identityId: identityId || undefined, keyPath: identityId ? undefined : entry.keyPath,
  };
}
