// Presentation only; connection membership remains in SQLite.
export const collapsedGroups = new Set<string>();
try {
  const saved: unknown = JSON.parse(localStorage.getItem("collapsed-connection-groups") || "[]");
  if (Array.isArray(saved)) for (const key of saved) if (typeof key === "string") collapsedGroups.add(key);
} catch { /* A missing or corrupt preference must not prevent startup. */ }

export function rememberGroup(key: string, open: boolean): void {
  if (open) collapsedGroups.delete(key);
  else collapsedGroups.add(key);
  try { localStorage.setItem("collapsed-connection-groups", JSON.stringify([...collapsedGroups])); } catch { /* optional */ }
}
