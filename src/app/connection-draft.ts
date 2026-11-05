/** Build the existing save_server contract without copying secrets into UI state. */
export function connectionDraft(data: Pick<FormData, "get">, id?: string): Record<string, unknown> {
  const text = (key: string) => String(data.get(key) ?? "");
  const authMethod = text("authMethod") || "password";
  const linked = authMethod === "openSsh";
  const host = text(linked ? "openSshAlias" : "host").trim();
  const username = linked ? "" : text("username").trim();
  const port = linked ? 22 : text("port").trim() ? Number(text("port")) : 22;
  if (linked && (!host || host.startsWith("-") || /\s|[\u0000-\u001f\u007f]/u.test(host))) throw new Error("Enter a single OpenSSH host alias without options or whitespace.");
  if (!host || (!username && authMethod !== "sshAgent" && !linked)) throw new Error("Enter a host and username.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter a port between 1 and 65535.");
  if (authMethod !== "password" && authMethod !== "privateKey" && authMethod !== "sshAgent" && !linked) throw new Error("Choose a supported authentication method.");
  const identityId = text("identityId").trim();
  if (authMethod === "sshAgent" && !identityId) throw new Error("Choose an SSH agent identity in Settings first.");
  const keyPath = text("customKeyPath").trim() || text("keyPath").trim();
  if (authMethod === "privateKey" && !keyPath) throw new Error("Choose a private key or enter its path.");
  const draft: Record<string, unknown> = {
    identityId: authMethod === "sshAgent" ? identityId : undefined,
    id, name: text("name").trim() || host, host, username, port, authMethod,
    keyPath: authMethod === "privateKey" ? keyPath : undefined,
    openSsh: linked ? { alias: host, configPath: text("openSshConfigPath").trim() || undefined } : undefined,
    jumpHostId: linked ? undefined : text("jumpHostId").trim() || undefined,
    groupName: text("groupName").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/gu, "").trim().replace(/\s+/gu, " ") || undefined,
    tags: [...new Set(text("tags").split(",").map(tag => tag.trim()).filter(Boolean))],
    notes: text("notes"), favorite: data.get("favorite") === "on",
  };
  for (const key of ["password", "keyPassphrase", "sudoPassword"]) {
    if (linked || (authMethod === "sshAgent" && key !== "sudoPassword")) continue;
    if (!id || text(key)) draft[key] = text(key);
  }
  return draft;
}
