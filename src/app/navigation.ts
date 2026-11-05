import type { ServerCapabilities } from "../types";

/** Capability checks use the remote host, never the desktop operating system. */
export function unavailableToolReason(view: string, capabilities: ServerCapabilities | null | undefined, authMethod?: string): string | undefined {
  if (authMethod === "openSsh" && !["terminal", "files", "tunnels"].includes(view)) return "OpenSSH config connections use the terminal; graphical tools need a managed connection";
  if (!capabilities) return undefined;
  if (view === "docker" && !capabilities.docker && !capabilities.podman) return "Requires Docker or Podman";
  if (view === "services" && !capabilities.systemd) return "Requires systemd";
  if (view === "cron" && !capabilities.cron) return "Requires cron";
  if (view === "packages" && capabilities.packageManager !== "apt-get") return "Requires APT";
  if (view === "network" && !capabilities.networkTool) return "No supported network tool";
  return undefined;
}
