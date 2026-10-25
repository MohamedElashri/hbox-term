// Triggers (iTerm2): a regular expression on terminal output and what to do when a line matches.
// Configured as `trigger = <action>[:<argument>] /<regex>/<flags>`, for example
//   trigger = highlight:#ff5555 /error|failed/i
//   trigger = notify:Build finished /^Finished (dev|release)/
//   trigger = mark /WARN/

import type { Trigger } from "./config";

export interface TriggerMatch { trigger: Trigger; start: number; end: number }

/** Every match of every trigger on one line of output (UTF-16 offsets). */
export function matchTriggers(triggers: Trigger[], text: string): TriggerMatch[] {
  const matches: TriggerMatch[] = [];
  for (const trigger of triggers) {
    trigger.pattern.lastIndex = 0;
    for (const match of text.matchAll(trigger.pattern)) {
      if (!match[0]) continue; // empty matches would loop or mark nothing
      matches.push({ trigger, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }
  }
  return matches;
}
