// ─────────────────────────────────────────────────────────────────────────────
// WHICH SITUATION A STALLED RUNNER WAS IN.
//
// ── WHY A HANG NEEDS ITS OWN FINDING ────────────────────────────────────────
//
// A runner that is KILLED (a dead worker, an OOM) produces `backend:runner
// <file>`, which the repair loop drops on purpose: nobody knows why it died,
// the model cannot repair gate tooling from inside its cell, and there is no
// honest sentence to send. A DEADLINE is a different fact — the code under test
// did not return — and it was being swallowed by the same rule. Measured on run
// 1789076475: the candidate's `maxPlies` recursed forever on doubles and the
// model was told NOTHING across every attempt.
//
// ── WHY THE SITUATION IS THE RUNNER, NOT THE GATE ───────────────────────────
//
// Which FILE ran out of time is known for certain, so naming the area it
// exercises cannot mis-attribute. Pointing at a single gate could: the stall
// may be in setup rather than in a test, and sending the model after an
// innocent requirement is worse than saying less.
//
// Per `06`'s calibration canon this is the GENEROUS form — shipped first,
// narrowed to a bare "it froze" if it proves too easy. Working backwards from
// too-easy is the rule; forwards is not, because nothing distinguishes "too
// hard" from "the corpus is broken".
// ─────────────────────────────────────────────────────────────────────────────

/** Runner label -> the situation a player would say they were in. */
const AREA_BY_RUNNER = [
  ["gates-01-08", "moving"],
  ["gates-09-12", "bearingoff"],
  ["gates-13-16", "aiturn"],
  ["edge", "awkwardroll"],
  ["frontend", "playing"],
  ["conformance", "startup"],
];

/** Every situation this can name. The feedback file must carry a line for each. */
export const STALL_AREAS = AREA_BY_RUNNER.map(([, area]) => area);

/**
 * The check a stalled runner reports, e.g. `REQ-RESPONSIVE/awkwardroll`.
 *
 * Falls back to `startup` for an unrecognised label rather than inventing a
 * key: an unknown key would have no symptom line, and a check with no line
 * raises `MissingFeedbackOverrideError` and ends the campaign MID-RUN, after
 * the attempt was already graded.
 */
export function stallCheckFor(label) {
  const s = String(label ?? "");
  for (const [needle, area] of AREA_BY_RUNNER) {
    if (s.includes(needle)) return `REQ-RESPONSIVE/${area}`;
  }
  return "REQ-RESPONSIVE/startup";
}
