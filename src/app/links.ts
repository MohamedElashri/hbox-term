// File path links in terminal output, like iTerm2's semantic history: `src/main.rs:12:5`,
// `./build.sh`, `/etc/hosts`, `~/notes.md`. Candidates are checked against the file system
// before they become links, so ordinary words are never underlined.
import type { IBufferLine, ILink, Terminal } from "@xterm/xterm";

export interface PathCandidate {
  /** The path as printed, without the line and column. */
  path: string;
  line?: number;
  column?: number;
  /** UTF-16 offsets of the whole match (path plus :line:column) in the text. */
  start: number;
  end: number;
}

const PATH_PATTERN = /(?:~|\.{1,2})?\/?(?:[\w.+@-]+\/)*[\w.+@-]+(?::(\d+))?(?::(\d+))?/g;

export function findPathCandidates(text: string): PathCandidate[] {
  const candidates: PathCandidate[] = [];
  for (const match of text.matchAll(PATH_PATTERN)) {
    const start = match.index ?? 0;
    const before = text.slice(0, start);
    // Part of a longer token or of a URL (handled by the URL links).
    if (/[\w/.~-]$/.test(before) || /\w+:\/\/\S*$/.test(before)) continue;
    const full = match[0];
    const path = full.replace(/(?::\d+){1,2}$/, "");
    const hasDirectory = path.includes("/");
    const hasExtension = /[^./]\.[A-Za-z][\w-]{0,15}$/.test(path);
    if (!hasDirectory && !hasExtension) continue;
    if (/^\d[\d.]*$/.test(path)) continue; // version numbers, IP fragments
    candidates.push({
      path,
      line: match[1] ? Number(match[1]) : undefined,
      column: match[2] ? Number(match[2]) : undefined,
      start,
      end: start + full.length,
    });
  }
  return candidates;
}

// --- xterm.js link provider ------------------------------------------------------------------

export interface PathLinkOptions {
  /** Directory relative paths are resolved against (the pane's OSC 7 directory). */
  cwd: () => string | undefined;
  /** Which candidates exist, as absolute paths (or null). */
  resolve: (base: string | undefined, paths: string[]) => Promise<(string | null)[]>;
  open: (path: string, line?: number, column?: number) => void;
}

/** Links open with Ctrl+click (Cmd+click on macOS), so plain clicks still select text. */
export const opensLink = (event: MouseEvent): boolean => event.ctrlKey || event.metaKey;

/** The row's text plus, for each UTF-16 unit, the terminal column it is drawn in. */
export function rowText(row: IBufferLine): { text: string; cells: number[] } {
  let text = "";
  const cells: number[] = [];
  for (let x = 0; x < row.length; x++) {
    const cell = row.getCell(x);
    if (!cell || cell.getWidth() === 0) continue; // second half of a wide character
    const chars = cell.getChars() || " ";
    text += chars;
    for (let i = 0; i < chars.length; i++) cells.push(x);
  }
  return { text, cells };
}

// Short-lived, so files created after a check (build outputs) become links soon after.
const resolved = new Map<string, { paths: (string | null)[]; at: number }>();
const RESOLVE_CACHE_SIZE = 500;
const RESOLVE_CACHE_MS = 10_000;

export function registerPathLinks(term: Terminal, options: PathLinkOptions): { dispose(): void } {
  return term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const row = term.buffer.active.getLine(lineNumber - 1);
      if (!row) { callback(undefined); return; }
      const { text, cells } = rowText(row);
      const candidates = findPathCandidates(text);
      if (!candidates.length) { callback(undefined); return; }
      const base = options.cwd();
      const key = `${base ?? ""}\0${candidates.map((candidate) => candidate.path).join("\0")}`;
      const finish = (paths: (string | null)[]) => {
        const links: ILink[] = [];
        candidates.forEach((candidate, index) => {
          const path = paths[index];
          if (!path) return;
          links.push({
            text: text.slice(candidate.start, candidate.end),
            range: { start: { x: cells[candidate.start] + 1, y: lineNumber }, end: { x: cells[candidate.end - 1] + 1, y: lineNumber } },
            activate: (event) => { if (opensLink(event)) options.open(path, candidate.line, candidate.column); },
          });
        });
        callback(links.length ? links : undefined);
      };
      const cached = resolved.get(key);
      if (cached && performance.now() - cached.at < RESOLVE_CACHE_MS) { finish(cached.paths); return; }
      options.resolve(base, candidates.map((candidate) => candidate.path)).then((paths) => {
        resolved.delete(key);
        if (resolved.size >= RESOLVE_CACHE_SIZE) resolved.delete(resolved.keys().next().value!);
        resolved.set(key, { paths, at: performance.now() });
        finish(paths);
      }, () => callback(undefined));
    },
  });
}
