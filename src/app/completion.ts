// Autocomplete from scrollback (iTerm2's Cmd+;): words seen in the pane's output, newest first.

const WORD = /[\w./@:+~=-]{2,}/g;

/** The word being typed: the run of word characters just before the cursor. */
export function wordBeforeCursor(lineBeforeCursor: string): string {
  return /[\w./@:+~=-]*$/.exec(lineBeforeCursor)?.[0] ?? "";
}

/** Distinct words from `lines` (oldest first) that extend `prefix`, most recent first. */
export function completions(lines: string[], prefix: string, limit = 50): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (let index = lines.length - 1; index >= 0 && found.length < limit; index--) {
    const words = lines[index].match(WORD) ?? [];
    for (let w = words.length - 1; w >= 0 && found.length < limit; w--) {
      // Sentence punctuation is not part of the word.
      const word = words[w].replace(/[.:,;=-]+$/, "");
      if (word.length <= prefix.length || !word.startsWith(prefix) || seen.has(word)) continue;
      seen.add(word);
      found.push(word);
    }
  }
  return found;
}
