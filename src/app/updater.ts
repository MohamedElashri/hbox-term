// The Updates section of Settings, driving UpdateController with the updater plugin.
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { icon } from "../icons";
import { escapeHtml, formatBytes } from "./format";
import { root } from "./state";
import { UpdateController } from "./updates";

export const RELEASES_URL = "https://github.com/MohamedElashri/hbox-term/releases";

interface AppMetadata { version: string; updateUnsupportedReason: string }
let metadata: AppMetadata | null = null;

/** Re-renders only the Updates section, so download progress does not rebuild the whole app. */
function refreshSection(): void {
  const section = root.querySelector<HTMLElement>("[data-update-section]");
  if (section) section.outerHTML = renderUpdateSection();
}

void invoke<AppMetadata>("app_metadata").then((value) => { metadata = value; refreshSection(); }).catch(() => undefined);

export const updates = new UpdateController(() => check({ timeout: 20_000 }), relaunch, refreshSection);

function status(): string {
  const { phase, version, downloaded, total } = updates.state;
  switch (phase) {
    case "checking": return "Checking GitHub releases…";
    case "current": return "hbox-term is up to date.";
    case "available": return `hbox-term ${escapeHtml(version ?? "")} is available.`;
    case "downloading": return total ? `Downloading… ${Math.floor((downloaded / total) * 100)}% of ${formatBytes(total)}` : `Downloading… ${formatBytes(downloaded)}`;
    case "installing": return "Verified. Installing… Approve the system prompt if one appears.";
    case "installed": return `hbox-term ${escapeHtml(version ?? "")} is installed. Restart to use it.`;
    case "restarting": return "Restarting…";
    default: return "";
  }
}

function actions(): string {
  const { phase } = updates.state;
  const reason = metadata?.updateUnsupportedReason ?? "";
  const releases = `<button class="button button-quiet" type="button" data-action="open-releases">Releases page</button>`;
  if (phase === "available") {
    return reason
      ? `<p class="update-hint">${escapeHtml(reason)}</p>${releases}`
      : `<button class="button button-primary" type="button" data-action="install-update">Install update</button>${releases}`;
  }
  if (phase === "installed") return `<button class="button button-primary" type="button" data-action="restart-update">Restart now</button>`;
  return `<button class="button button-quiet" type="button" data-action="check-updates" ${updates.busy ? "disabled" : ""}>Check for updates</button>`;
}

export function renderUpdateSection(): string {
  const { phase, notes, error } = updates.state;
  const version = metadata ? `You have hbox-term ${escapeHtml(metadata.version)}.` : "";
  const message = status();
  return `<section class="settings-section settings-section-stacked update-section" data-update-section aria-labelledby="update-settings-title"><div class="settings-section-copy"><h3 id="update-settings-title">Updates</h3><p>${version} hbox-term checks GitHub only when you ask, and verifies the signature of every update before installing it.</p>${message ? `<p class="update-status" aria-live="polite">${message}</p>` : ""}${phase === "available" && notes ? `<pre class="update-notes">${escapeHtml(notes)}</pre>` : ""}${error ? `<div class="inline-error">${icon("info")}<span>${escapeHtml(error)}</span></div>` : ""}</div><div class="config-actions">${actions()}</div></section>`;
}
