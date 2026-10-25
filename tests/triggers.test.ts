import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTrigger, type Trigger } from "../src/app/config.ts";
import { matchTriggers } from "../src/app/triggers.ts";

const parse = (value: string): Trigger => {
  const trigger = parseTrigger(value);
  assert.equal(typeof trigger, "object", String(trigger));
  return trigger as Trigger;
};

test("parses actions, arguments and flags", () => {
  const highlight = parse("highlight:#ff5555 /error|failed/i");
  assert.equal(highlight.action, "highlight");
  assert.equal(highlight.argument, "#ff5555");
  assert.equal(highlight.pattern.flags, "gi");
  assert.equal(parse("notify:Build finished /^Finished (dev|release)/").argument, "Build finished");
  assert.equal(parse("mark /WARN/").argument, undefined);
  assert.equal(parse("mark /a\\/b/").pattern.source, "a\\/b");
});

test("rejects invalid triggers with a reason", () => {
  assert.match(String(parseTrigger("explode /x/")), /unknown trigger action/);
  assert.match(String(parseTrigger("highlight:red /x/")), /#rrggbb/);
  assert.match(String(parseTrigger("mark /(unclosed/")), /invalid regular expression/);
  assert.match(String(parseTrigger("mark no-slashes")), /expected/);
});

test("finds every match on a line", () => {
  const triggers = [parse("highlight /err\\w*/i"), parse("mark /WARN/")];
  const found = matchTriggers(triggers, "Error: x; WARN; error again");
  assert.deepEqual(found.map((match) => [match.trigger.action, match.start, match.end]), [
    ["highlight", 0, 5], ["highlight", 16, 21], ["mark", 10, 14],
  ]);
  // Repeated calls are not affected by the regex's lastIndex.
  assert.equal(matchTriggers(triggers, "Error").length, 1);
  assert.equal(matchTriggers([parse("mark /x*/")], "abc").length, 0, "empty matches are ignored");
});
