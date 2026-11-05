export type Activity = "idle" | "busy" | "unknown" | "closed";

export function closeWarning(sessions: { remote: boolean; activity: Activity }[]): string | undefined {
  const live = sessions.filter(session => session.activity !== "closed");
  const remote = live.filter(session => session.remote).length;
  const busy = live.filter(session => !session.remote && session.activity === "busy").length;
  const unknown = live.filter(session => !session.remote && session.activity === "unknown").length;
  if (!remote && !busy && !unknown) return undefined;
  const reasons: string[] = [];
  if (busy) reasons.push(`${busy} local ${busy === 1 ? "job is" : "jobs are"} still running.`);
  if (remote) reasons.push(`${remote} SSH ${remote === 1 ? "session will" : "sessions will"} disconnect.`);
  if (unknown) reasons.push(`The activity of ${unknown} local ${unknown === 1 ? "session could" : "sessions could"} not be checked.`);
  return `${reasons.join(" ")} Running programs may stop. Save changes in your editors before closing.`;
}
