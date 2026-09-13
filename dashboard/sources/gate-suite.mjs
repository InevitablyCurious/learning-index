// ─────────────────────────────────────────────────────────────────────────────
// SOURCE: gate-suite — the wall's denominator and per-gate outcomes
//
// SPLIT OUT OF `control-plane.mjs` (2026-09-05). It used to be one of nine
// things that source fetched, which coupled the GATE WALL to the TUI MIRROR:
// both arrived in the same patch, from the same read, and neither could appear
// without the other. On a cold start an operator saw both blank together and
// had no way to tell which one was actually waiting.
//
// They answer unrelated questions and have unrelated failure modes. The wall
// needs a roster that only exists once a cell has started (and, before that, a
// live enumeration that shells out to two test runners); the mirror needs a
// PTY attached to a session. Sharing a source meant sharing a fate.
//
// Its own source row also means the provenance panel can now say "gate suite
// unwired, because X" as a first-class fact. It used to be a NOTE buried inside
// the control plane's row, where a reader looking for the wall would not think
// to look.
//
// NOTHING IS DERIVED HERE. `control/wall.mjs` folds the suite server-side from
// the write-once roster plus per-attempt gate results; this fetches it whole
// and passes it through untouched. Re-deriving gate state on the board is how
// two surfaces come to disagree about whether a gate was abandoned or merely
// untested.
// ─────────────────────────────────────────────────────────────────────────────

export const id = "gate-suite";
export const fields = ["suite"];
export function describe() {
  return "the gate roster and per-gate outcomes, folded by the control plane";
}

/** Matches the other control-plane reads: long enough for a cold enumeration
 *  to answer, short enough that a dead plane does not hold the board. */
const TIMEOUT_MS = 2500;

export async function read(ctx) {
  const base = ctx.config?.controlUrl ?? "http://127.0.0.1:7718";
  const url = `${base}/api/wall`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      return { ok: false, reason: `control plane answered ${res.status} for /api/wall` };
    }
    const data = await res.json();
    // `ok:false` from the fold is a STATED absence — no roster yet, or a run
    // whose roster could not be read. It is not an error to report as one, and
    // it must not be rendered as a suite of zero: "no roster" and "a suite with
    // no gates" are different facts and the panel says so.
    if (data?.ok !== true) {
      return { ok: false, reason: data?.reason ?? "the control plane has no gate suite to report yet" };
    }
    return { ok: true, patch: { suite: data }, provenance: { path: url, mtime: null, bytes: null } };
  } catch (err) {
    return { ok: false, reason: `gate suite unreadable — ${String(err?.message ?? err)}` };
  }
}
