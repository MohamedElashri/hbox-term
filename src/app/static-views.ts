import { icon } from "../icons";
import { escapeHtml } from "./format";

export interface TitlebarViewData {
  platform: string;
  /** What the active workspace is: the local machine or a server. */
  context?: { title: string; detail: string };
}

export function renderTitlebarView({ platform, context }: TitlebarViewData): string {
  return `<header class="titlebar" data-tauri-drag-region data-platform="${platform}">
    <div class="titlebar-brand"><span class="titlebar-mark">${icon("logo")}</span><span>hbox-term</span></div>
    ${context ? `<div class="titlebar-caption"><div class="titlebar-context"><strong>${escapeHtml(context.title)}</strong><span>${escapeHtml(context.detail)}</span></div></div>` : ""}
    <div class="window-controls" aria-label="Window controls">
      <button class="window-control window-control-minimize" data-window="minimize" title="Minimize window" aria-label="Minimize window">${icon("minus")}</button>
      <button class="window-control window-control-maximize" data-window="maximize" title="Maximize window" aria-label="Maximize window">${icon("square")}</button>
      <button class="window-control window-control-close" data-window="close" title="Close window" aria-label="Close window">${icon("close")}</button>
    </div>
  </header>`;
}

export function renderLoadingView(): string {
  return `<main class="boot-screen"><div class="boot-card"><div class="brand-mark">${icon("logo")}</div><div class="eyebrow">hbox-term</div><h1>Starting up</h1><p>Your shell opens first. Saved servers, keys and credentials stay on this device.</p><div class="loading-line"><span></span></div></div></main>`;
}

export function renderWelcomeView(): string {
  return `<div class="welcome-page"><div class="welcome-art"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><span>${icon("logo")}</span></div><div class="eyebrow">Local and remote, one window</div><h1>Your shell,<br/><em>and every server.</em></h1><p class="welcome-copy">Work in a local terminal and add servers over SSH when you need them. Nothing is installed on the remote side.</p><div class="welcome-actions"><button class="button button-primary" data-action="open-local">${icon("terminalSmall")} Open local shell</button><button class="button button-quiet" data-action="add-server">${icon("plus")} Add server</button></div></div>`;
}

export function renderEmptyWorkspaceView(): string {
  return renderWelcomeView();
}

export function renderErrorView(error: string): string {
  return `<div class="error-state"><div class="error-icon">${icon("info")}</div><div><strong>hbox-term couldn't complete that request</strong><p>${escapeHtml(error)}</p><button class="button button-quiet" data-action="retry">${icon("refresh")} Refresh this view</button></div></div>`;
}

export function renderInlineErrorView(error: string): string {
  return `<div class="inline-error">${icon("info")}<span>${escapeHtml(error)}</span><button data-action="dismiss-error">${icon("close")}</button></div>`;
}

export function renderUnsupportedView(title: string, copy: string): string {
  return `<div class="unsupported"><div class="unsupported-art">${icon("shield")}</div><div class="eyebrow">Capability not detected</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(copy)}</p><button class="button button-quiet" data-action="refresh">${icon("refresh")} Check again</button></div>`;
}
