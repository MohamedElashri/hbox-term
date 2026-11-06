// The Updates section of Settings, driving UpdateController with the updater plugin.
import { invoke } from "@tauri-apps/api/core";

import { check } from "@tauri-apps/plugin-updater";
import { icon } from "../icons";
import { escapeHtml, formatBytes } from "./format";
import { root } from "./state";
import { UpdateController } from "./updates";
import { BRAND } from "./brand";

export const RELEASES_URL = BRAND.releases;

interface AppMetadata { version: string; updateUnsupportedReason: string }
let metadata: AppMetadata | null = null;
let metadataError = "";

/** Re-renders only the Updates section, so download progress does not rebuild the whole app. */
function refreshSection(): void {
  const section = root.querySelector<HTMLElement>("[data-update-section]");
  if (section) {
    const notesScroll = section.querySelector<HTMLElement>(".update-notes")?.scrollTop;
    const standalone = section.dataset.updateStandalone === "true";
    section.outerHTML = renderUpdateSection(standalone);
    const notes = root.querySelector<HTMLElement>(".update-notes");
    if (notes && notesScroll !== undefined) notes.scrollTop = notesScroll;
  }
}

async function loadMetadata(): Promise<void> {
  try {
    metadata = await invoke<AppMetadata>("app_metadata");
    metadataError = "";
  } catch {
    metadata = null;
    metadataError = "Installation details are unavailable. Check again to retry.";
  }
  refreshSection();
}

export const updates = new UpdateController(() => check({ timeout: 20_000 }), async () => {
  await invoke("request_app_restart");
}, refreshSection, async () => {
  await loadMetadata();
  if (!metadata) throw new Error(metadataError);
  if (metadata.updateUnsupportedReason) throw new Error(metadata.updateUnsupportedReason);
});

void loadMetadata();

export async function checkForUpdates(): Promise<void> {
  await Promise.all([loadMetadata(), updates.checkNow()]);
}

function status(): string {
  const { phase, version, downloaded, total } = updates.state;
  switch (phase) {
    case "checking": return "Checking GitHub releases…";
    case "current": return "Ternway is up to date.";
    case "available": return `Ternway ${escapeHtml(version ?? "")} is available.`;
    case "downloading": return total ? `Downloading… ${Math.min(100, Math.floor((downloaded / total) * 100))}% of ${formatBytes(total)}` : `Downloading… ${formatBytes(downloaded)}`;
    case "installing": return "Verified. Installing… Approve the system prompt if one appears.";
    case "installed": return `Ternway ${escapeHtml(version ?? "")} is installed. Restart to use it.`;
    case "restarting": return "Restarting…";
    default: return "";
  }
}

function actions(): string {
  const { phase } = updates.state;
  const reason = metadata?.updateUnsupportedReason ?? "";
  const releases = `<button class="button button-quiet" type="button" data-action="open-releases">View GitHub releases</button>`;
  if (phase === "available") {
    return reason ? releases : `<button class="button button-primary" type="button" data-action="install-update" ${metadata ? "" : "disabled"}>Download and install</button>${releases}`;
  }
  if (phase === "installed") return `<button class="button button-primary" type="button" data-action="restart-update">Restart now</button>${releases}`;
  const label = ({ checking: "Checking…", downloading: "Downloading…", installing: "Installing…", restarting: "Restarting…", error: "Try again" } as Partial<Record<typeof phase, string>>)[phase] ?? "Check for updates";
  return `<button class="button button-quiet" type="button" data-action="check-updates" ${updates.busy ? "disabled" : ""}>${label}</button>${releases}`;
}

export function renderUpdateSection(standalone = false): string {
  const { phase, notes, error, downloaded, total } = updates.state;
  const version = metadata ? `Running version: ${escapeHtml(metadata.version)}.` : metadataError ? "Running version unavailable." : "Loading version…";
  const message = status();
  const hint = metadataError || metadata?.updateUnsupportedReason || "";
  const progress = phase === "downloading" ? `<progress class="update-progress" aria-label="Update download" ${total ? `max="${total}" value="${Math.min(downloaded, total)}"` : ""}></progress>` : "";
  return `<section class="settings-section settings-section-stacked update-section" data-update-section data-update-standalone="${standalone}" ${standalone ? 'aria-label="Update status"' : 'aria-labelledby="update-settings-title"'}><div class="settings-section-copy">${standalone ? "" : '<h3 id="update-settings-title">Updates</h3>'}<p class="update-version">${version}</p><p>Check GitHub releases for the latest version. Downloads are verified before installation.</p><p class="update-status" role="status" aria-live="polite">${message}</p>${progress}${phase === "available" && notes ? `<div class="update-release-notes"><h4>What’s new</h4><pre class="update-notes">${escapeHtml(notes)}</pre></div>` : ""}${hint ? `<p class="update-hint">${escapeHtml(hint)}</p>` : ""}${error ? `<div class="inline-error" role="alert">${icon("info")}<span>${escapeHtml(error)}</span></div>` : ""}</div><div class="config-actions">${actions()}</div>${(phase === "available" && !hint) || phase === "installed" ? '<p class="update-restart-hint">Restart when you’re ready. Restarting ends active terminal sessions.</p>' : ""}</section>`;
}
