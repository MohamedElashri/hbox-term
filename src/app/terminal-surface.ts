import { Channel } from "@tauri-apps/api/core";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ImageAddon } from "@xterm/addon-image";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { opensLink, registerPathLinks, rowText, type PathLinkOptions } from "./links";
import { DEFAULT_HIGHLIGHT, type Trigger } from "./config";
import { matchTriggers, type TriggerMatch } from "./triggers";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { CommandTracker, type CommandTrackerEvents } from "./shell-integration";

// Frame tags; must match src-tauri/src/pty_output.rs.
const FRAME_DATA = 0;
const FRAME_CLOSED = 1;

// Parsed bytes are acknowledged in batches so the backend can throttle a flood of output.
const ACK_BATCH_BYTES = 256 * 1024;
const ACK_DELAY_MS = 50;

const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 72;

/** Settings that come from the config file and can change while the terminal is open. */
export interface TerminalAppearance {
  theme: ITheme;
  /** CSS font-family list. */
  fontFamily: string;
  /** Pixels. */
  fontSize: number;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  scrollback: number;
}

export interface TerminalSurfaceOptions extends CommandTrackerEvents {
  appearance: TerminalAppearance;
  onTitle: (title: string) => void;
  onOpenUrl: (url: string) => void;
  /** File path links; only for panes whose paths refer to this machine. */
  pathLinks?: PathLinkOptions;
  /** Inline image memory in MB (sixel and iTerm2's protocol); 0 turns images off. */
  imageStorageMb: number;
  /** The pane's current triggers (they change when the config is reloaded). */
  triggers: () => Trigger[];
  onTriggerNotify: (title: string, line: string) => void;
  webgl: boolean;
  onSelection: () => void;
  onFocus: () => void;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onAck: (bytes: number) => void;
  onClosed: (message: string) => void;
}

// Once WebGL fails to load, stop trying for this run and use the DOM renderer.
let webglSupported = true;

/**
 * One xterm.js instance for the lifetime of a terminal tab. The host lives in a fixed layer
 * outside the re-rendered app tree and is only shown or hidden, never moved: moving a WebGL
 * canvas leaves WebKitGTK showing stale pixels that xterm.js does not know to repaint.
 * WebGL is only held while visible to stay under the browser's WebGL context limit.
 */
export class TerminalSurface {
  readonly host = document.createElement("div");
  readonly term: Terminal;
  readonly output: Channel<ArrayBuffer>;
  readonly commands: CommandTracker;
  private readonly fit = new FitAddon();
  readonly search = new SearchAddon({ highlightLimit: 2000 });
  private readonly serializer = new SerializeAddon();
  private readonly resizeObserver: ResizeObserver;
  private webgl: WebglAddon | null = null;
  private unackedBytes = 0;
  private ackTimer: number | undefined;
  private fitFrame: number | undefined;
  private opened = false;
  /** Buffer lines below this one have not been checked against the triggers yet. */
  private scannedLine = 0;
  private readonly lastNotified = new Map<Trigger, number>();
  private useWebgl: boolean;
  private disposed = false;

  constructor(private readonly options: TerminalSurfaceOptions) {
    this.useWebgl = options.webgl;
    this.host.className = "terminal-host";
    const { appearance } = options;
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: appearance.cursorBlink,
      cursorStyle: appearance.cursorStyle,
      fontFamily: appearance.fontFamily,
      fontSize: appearance.fontSize,
      scrollback: appearance.scrollback,
      theme: appearance.theme,
      // Shows command marks (green/red) next to the scrollbar.
      overviewRuler: { width: 8 },
    });
    this.commands = new CommandTracker(this.term, options);
    this.term.onTitleChange(options.onTitle);
    this.term.onWriteParsed(() => this.scanTriggers());
    this.host.style.setProperty("--terminal-background", appearance.theme.background ?? "");
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(this.serializer);
    this.term.loadAddon(new WebLinksAddon((event, url) => { if (opensLink(event)) options.onOpenUrl(url); }));
    if (options.pathLinks) registerPathLinks(this.term, options.pathLinks);
    if (options.imageStorageMb > 0) {
      this.term.loadAddon(new ImageAddon({ sixelSupport: true, iipSupport: true, storageLimit: options.imageStorageMb }));
    }
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.onData(options.onInput);
    this.term.onSelectionChange(() => { if (this.term.hasSelection()) options.onSelection(); });
    this.term.onResize(({ cols, rows }) => options.onResize(cols, rows));
    this.host.addEventListener("click", () => this.term.focus());
    this.host.addEventListener("focusin", () => options.onFocus());
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.output = new Channel<ArrayBuffer>((message) => this.receive(message));
  }

  get cols(): number { return this.term.cols; }
  get rows(): number { return this.term.rows; }

  get fontSize(): number { return this.term.options.fontSize ?? 16; }

  /** Applies changed config settings. Font size changes reset any per-pane zoom. */
  configure(appearance: TerminalAppearance): void {
    const options = this.term.options;
    if (options.theme !== appearance.theme) {
      options.theme = appearance.theme;
      this.host.style.setProperty("--terminal-background", appearance.theme.background ?? "");
    }
    if (options.cursorStyle !== appearance.cursorStyle) options.cursorStyle = appearance.cursorStyle;
    if (options.cursorBlink !== appearance.cursorBlink) options.cursorBlink = appearance.cursorBlink;
    if (options.scrollback !== appearance.scrollback) options.scrollback = appearance.scrollback;
    if (options.fontFamily !== appearance.fontFamily || options.fontSize !== appearance.fontSize) {
      options.fontFamily = appearance.fontFamily;
      options.fontSize = appearance.fontSize;
      this.scheduleFit();
    }
  }

  show(layer: HTMLElement): void {
    if (this.host.parentElement !== layer) layer.append(this.host);
    if (!this.host.hidden && this.opened) return;
    this.host.hidden = false;
    // Opening measures the font, so it waits until the host is in the document.
    if (!this.opened) {
      this.term.open(this.host);
      this.opened = true;
    }
    this.resizeObserver.observe(this.host);
    this.enableWebgl();
    this.scheduleFit();
  }

  hide(): void {
    this.host.hidden = true;
    this.resizeObserver.disconnect();
    this.webgl?.dispose();
    this.webgl = null;
  }

  hasFocus(): boolean { return this.host.contains(document.activeElement); }

  /** Positions the pane inside the terminal layer. */
  place(rect: { x: number; y: number; width: number; height: number }): void {
    Object.assign(this.host.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }

  /** Dims unfocused split panes, like Ghostty's unfocused-split-opacity. */
  setWebgl(enabled: boolean): void {
    this.useWebgl = enabled;
    if (!enabled) { this.webgl?.dispose(); this.webgl = null; }
    else if (!this.host.hidden && this.opened) this.enableWebgl();
    this.term.refresh(0, this.term.rows - 1);
  }

  setDimmed(dimmed: boolean): void { this.host.classList.toggle("dimmed", dimmed); }

  setFontSize(size: number): void {
    const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
    if (next === this.fontSize) return;
    this.term.options.fontSize = next;
    this.scheduleFit();
  }

  /** The selection, optionally with trailing spaces trimmed from each line as Ghostty does. */
  selectionText(trimTrailingSpaces: boolean): string {
    const text = this.term.getSelection();
    return trimTrailingSpaces ? text.split("\n").map((line) => line.trimEnd()).join("\n") : text;
  }

  /** Whether the running program has asked for bracketed paste, which makes multi-line pastes safe. */
  get bracketedPaste(): boolean { return this.term.modes.bracketedPasteMode; }

  paste(text: string): void { this.term.paste(text); }

  selectAll(): void { this.term.selectAll(); }

  /** Applies the triggers to output lines finished since the last check. */
  private scanTriggers(): void {
    const triggers = this.options.triggers();
    const buffer = this.term.buffer.active;
    const cursorLine = buffer.baseY + buffer.cursorY;
    // Full-screen programs redraw constantly; their output is not line-based.
    if (!triggers.length || buffer.type === "alternate") { this.scannedLine = cursorLine; return; }
    if (this.scannedLine > cursorLine) this.scannedLine = cursorLine; // the screen was cleared
    for (let line = Math.max(this.scannedLine, cursorLine - 500); line < cursorLine; line++) {
      const row = buffer.getLine(line);
      if (!row) continue;
      const { text, cells } = rowText(row);
      for (const match of matchTriggers(triggers, text)) this.applyTrigger(match, line - cursorLine, text, cells);
    }
    this.scannedLine = cursorLine;
  }

  private applyTrigger({ trigger, start, end }: TriggerMatch, offset: number, text: string, cells: number[]): void {
    if (trigger.action === "notify") {
      // At most one notification per trigger every few seconds.
      const now = performance.now();
      if (now - (this.lastNotified.get(trigger) ?? -Infinity) < 3000) return;
      this.lastNotified.set(trigger, now);
      this.options.onTriggerNotify(trigger.argument ?? "Trigger matched", text.trim().slice(0, 200));
      return;
    }
    const marker = this.term.registerMarker(offset);
    if (!marker) return;
    if (trigger.action === "mark") {
      this.term.registerDecoration({ marker, overviewRulerOptions: { color: trigger.argument ?? "#8be9fd", position: "center" } });
      return;
    }
    const x = cells[start];
    this.term.registerDecoration({
      marker,
      x,
      width: cells[end - 1] - x + 1,
      backgroundColor: trigger.argument ?? DEFAULT_HIGHLIGHT,
      foregroundColor: "#282a36",
      layer: "bottom",
      overviewRulerOptions: { color: trigger.argument ?? DEFAULT_HIGHLIGHT, position: "center" },
    });
  }

  /** The screen and recent scrollback with colors, for session restore. Full-screen programs are left out. */
  snapshot(lines: number): string {
    return this.serializer.serialize({ scrollback: lines, excludeAltBuffer: true, excludeModes: true });
  }

  /** Scrolls to the previous (-1) or next (1) prompt; false without shell integration. */
  jumpToPrompt(direction: -1 | 1): boolean {
    const line = this.commands.promptLine(direction);
    if (line === undefined) return false;
    this.term.scrollToLine(line);
    return true;
  }

  /** Finds the next or previous match in the scrollback, highlighting all of them. */
  find(term: string, backwards: boolean, options: Pick<ISearchOptions, "caseSensitive" | "regex">): boolean {
    if (!term) { this.search.clearDecorations(); return false; }
    const searchOptions: ISearchOptions = {
      ...options,
      decorations: {
        matchBackground: "#44475a", matchBorder: "#6272a4", matchOverviewRuler: "#6272a4",
        activeMatchBackground: "#6272a4", activeMatchBorder: "#ffb86c", activeMatchColorOverviewRuler: "#ffb86c",
      },
    };
    try {
      return backwards ? this.search.findPrevious(term, searchOptions) : this.search.findNext(term, searchOptions);
    } catch {
      return false; // An incomplete regex while typing.
    }
  }

  clearSearch(): void { this.search.clearDecorations(); this.term.clearSelection(); }

  focus(): void { this.term.focus(); }

  clear(): void { this.term.clear(); }

  /** Writes a local status line, e.g. "[Remote shell exited]". */
  notice(text: string): void { this.term.write(`\r\n[${text}]\r\n`); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.commands.dispose();
    this.flushAck();
    window.clearTimeout(this.ackTimer);
    if (this.fitFrame !== undefined) window.cancelAnimationFrame(this.fitFrame);
    this.resizeObserver.disconnect();
    this.host.remove();
    this.term.dispose();
  }

  private receive(message: ArrayBuffer): void {
    if (this.disposed) return;
    const frame = new Uint8Array(message);
    const payload = frame.subarray(1);
    if (frame[0] === FRAME_DATA) {
      this.term.write(payload, () => this.ack(payload.length));
    } else if (frame[0] === FRAME_CLOSED) {
      this.options.onClosed(new TextDecoder().decode(payload));
    }
  }

  private ack(bytes: number): void {
    this.unackedBytes += bytes;
    if (this.unackedBytes >= ACK_BATCH_BYTES) this.flushAck();
    else if (this.ackTimer === undefined) this.ackTimer = window.setTimeout(() => this.flushAck(), ACK_DELAY_MS);
  }

  private flushAck(): void {
    window.clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    if (!this.unackedBytes) return;
    this.options.onAck(this.unackedBytes);
    this.unackedBytes = 0;
  }

  private enableWebgl(): void {
    if (this.webgl || !webglSupported || !this.useWebgl) return;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (this.webgl === webgl) this.webgl = null;
      });
      this.term.loadAddon(webgl);
      this.webgl = webgl;
    } catch (error) {
      webglSupported = false;
      console.warn("WebGL renderer unavailable; using the DOM renderer.", error);
    }
  }

  private scheduleFit(): void {
    if (this.fitFrame !== undefined) return;
    this.fitFrame = window.requestAnimationFrame(() => {
      this.fitFrame = undefined;
      if (this.disposed || !this.host.isConnected || this.host.clientWidth === 0) return;
      this.fit.fit();
      // WebKitGTK can present a resized WebGL canvas without the rows xterm.js did not mark dirty.
      this.term.refresh(0, this.term.rows - 1);
    });
  }
}
