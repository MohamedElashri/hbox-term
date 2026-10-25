// Listening sockets from `ss`/`netstat` as forwarding targets.

/**
 * Host and port to forward to for a listening address such as `0.0.0.0:5432`, `[::]:80`,
 * `*:443`, `127.0.0.53%lo:53` or `:::22`. Wildcard listeners are reached on the loopback address.
 */
export function listeningEndpoint(localAddress: string): { host: string; port: number } | null {
  const match = /^(.*)[:.](\d{1,5})$/.exec(localAddress.trim());
  if (!match) return null;
  const port = Number(match[2]);
  if (!port || port > 65535) return null;
  let host = match[1].replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (["", "*", "0.0.0.0", "::", ":::", "::ffff:0.0.0.0"].includes(host)) host = "127.0.0.1";
  if (host.endsWith(":") && !host.includes("::")) host = host.slice(0, -1);
  return { host, port };
}
