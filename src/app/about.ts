import { invoke } from "@tauri-apps/api/core";
import { BRAND, buildSummary, type BuildMetadata } from "./brand";
import { escapeHtml } from "./format";
import appIcon from "../app-icon.svg";

let metadata: BuildMetadata | null = null;
export async function loadAboutMetadata(): Promise<void> {
  metadata = await invoke<BuildMetadata>("app_metadata");
}
export function aboutBuildSummary(): string {
  return metadata ? buildSummary(metadata) : "Ternway — build details unavailable";
}
export function renderAboutContent(): string {
  return `<div class="about-content">
    <div class="about-brand"><img src="${appIcon}" alt="" width="96" height="96"/><div><h3>Ternway</h3><p>${metadata ? `Version ${escapeHtml(metadata.version)}` : "Loading version…"}</p></div></div>
    <h4>Your machines. One workspace.</h4><p class="about-description">Local shells, organized SSH connections and server tools together on macOS and Linux.</p>
    <dl class="about-details"><div><dt>Created by</dt><dd>${BRAND.author}</dd></div><div><dt>License</dt><dd>MIT</dd></div><div><dt>Built with</dt><dd>Rust, Tauri and xterm.js</dd></div><div><dt>This build</dt><dd>${metadata ? `${escapeHtml(metadata.os)} / ${escapeHtml(metadata.arch)}${metadata.debug ? " · Development" : ""}` : "Loading…"}</dd></div></dl>
    <nav class="about-links" aria-label="Project links">${[["source","Source code"],["issues","Report an issue"],["releases","Release notes"],["license","License"]].map(([key,label]) => `<button class="button button-quiet" data-action="open-project-link" data-project-link="${key}">${label}</button>`).join("")}</nav>
    <div class="about-footer"><button class="button button-quiet" data-action="copy-build-info" ${metadata ? "" : "disabled"}>Copy build details</button><button class="button button-quiet" data-action="check-updates">Check for updates…</button></div>
    <div class="modal-actions"><button class="button button-quiet" data-action="credential-settings">Settings</button><button class="button button-primary" data-action="close-modal">Done</button></div>
  </div>`;
}
