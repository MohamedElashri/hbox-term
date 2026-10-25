// Shell integration: OSC 133 prompt/command marks and OSC 7 working directory, as emitted by the
// scripts in src-tauri/shell-integration (and by Ghostty's, iTerm2's or VS Code's integrations).
import type { IDecoration, IDisposable, IMarker, Terminal } from "@xterm/xterm";

export interface TrackedCommand {
  prompt: IMarker;
  /** Where the command's output starts (OSC 133;C). */
  output?: IMarker;
  /** The line after the output (OSC 133;D). */
  end?: IMarker;
  exitCode?: number;
  startedAt?: number;
  decoration?: IDecoration;
}

export interface CommandTrackerEvents {
  onDirectory: (path: string, host: string) => void;
  onFinished: (command: TrackedCommand, seconds: number) => void;
}

/** Parses an OSC 7 `file://host/path` report. */
export function parseDirectoryReport(data: string): { host: string; path: string } | null {
  const match = /^file:\/\/([^/]*)(\/.*)$/.exec(data);
  if (!match) return null;
  try {
    return { host: match[1], path: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

export class CommandTracker {
  readonly commands: TrackedCommand[] = [];
  private readonly term: Terminal;
  private readonly events: CommandTrackerEvents;
  private readonly handlers: IDisposable[];

  constructor(term: Terminal, events: CommandTrackerEvents) {
    this.term = term;
    this.events = events;
    this.handlers = [
      term.parser.registerOscHandler(133, (data) => { this.handleMark(data); return true; }),
      term.parser.registerOscHandler(7, (data) => {
        const report = parseDirectoryReport(data);
        if (report) events.onDirectory(report.path, report.host);
        return true;
      }),
    ];
  }

  /** Whether the shell has reported any prompt, i.e. integration is active. */
  get active(): boolean { return this.commands.length > 0; }

  private handleMark(data: string): void {
    const [kind, ...args] = data.split(";");
    const last = this.commands.at(-1);
    if (kind === "A") {
      // Markers are disposed when their line leaves the scrollback.
      while (this.commands.length && this.commands[0].prompt.isDisposed) this.commands.shift()?.decoration?.dispose();
      this.commands.push({ prompt: this.term.registerMarker(0) });
    } else if (kind === "C" && last && !last.output) {
      last.output = this.term.registerMarker(0);
      last.startedAt = performance.now();
    } else if (kind === "D" && last?.output && !last.end) {
      // A D without a C (an empty command line) is ignored.
      last.end = this.term.registerMarker(0);
      last.exitCode = Number(args[0]) || 0;
      this.decorate(last);
      this.events.onFinished(last, (performance.now() - (last.startedAt ?? performance.now())) / 1000);
    }
  }

  /** A mark in the left gutter at the prompt line: green for success, red for failure. */
  private decorate(command: TrackedCommand): void {
    const failed = command.exitCode !== 0;
    const decoration = this.term.registerDecoration({
      marker: command.prompt,
      x: 0,
      width: 1,
      overviewRulerOptions: { color: failed ? "#ff5555" : "#50fa7b", position: "left" },
    });
    decoration?.onRender((element) => {
      element.classList.add("command-mark", failed ? "failed" : "succeeded");
      element.title = failed ? `Exited with ${command.exitCode}` : "Succeeded";
    });
    command.decoration = decoration;
  }

  /** The prompt line above (direction -1) or below (1) the top of the viewport. */
  promptLine(direction: -1 | 1): number | undefined {
    const top = this.term.buffer.active.viewportY;
    const lines = this.commands.filter((command) => !command.prompt.isDisposed).map((command) => command.prompt.line);
    return direction < 0 ? lines.filter((line) => line < top).at(-1) : lines.find((line) => line > top);
  }

  /** Text printed by the last finished command. */
  lastOutput(): string | null {
    const command = [...this.commands].reverse().find((item) => item.output && item.end && !item.end.isDisposed);
    if (!command?.output || !command.end) return null;
    // `clear; cmd` erases the line where the output began; the output then starts at the top.
    const start = command.output.isDisposed ? 0 : command.output.line;
    const buffer = this.term.buffer.active;
    let text = "";
    for (let line = start; line < command.end.line; line++) {
      const row = buffer.getLine(line);
      if (!row) continue;
      // Wrapped rows continue the previous line.
      text += (line > start && !row.isWrapped ? "\n" : "") + row.translateToString(true);
    }
    return text.replace(/\n+$/, "");
  }

  dispose(): void {
    this.handlers.forEach((handler) => handler.dispose());
    this.commands.forEach((command) => command.decoration?.dispose());
  }
}
