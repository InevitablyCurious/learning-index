// ─────────────────────────────────────────────────────────────────────────────
// SOURCE: live-stream
//
// Reads the cell's `live.jsonl` — the benchmark's ONE during-the-run surface.
// Located via `liveStreamPath`, never constructed here: the harness writes it
// into the CELL directory, not the campaign root. See LIVE-STREAM.md.
// See LIVE-STREAM.md for the contract this implements.
//
// ── WHY THIS SOURCE EXISTS ──────────────────────────────────────────────────
// Every other source here reads an artifact written when something ENDS.
// `manifest.status.jsonl` is appended once per COMPLETED cell — all of a cell's
// attempt records at once — and `predicate-outcomes.jsonl` is written after the
// whole campaign exits. Two observed consequences:
//
//   · the learning panel resolved its session id from the newest
//     predicate-outcome line, so it read `unresolved` for entire runs; and
//   · the gate wall could only move once per cell, never per verdict-pass.
//
// Neither was a miswiring. The board was asking post-mortem files to be live.
//
// ── THE BENCHMARK OWNS THE KINDS; BACKENDS OWN THE NAMESPACES ───────────────
// This board must render a run driven by a memory backend it has never heard
// of. So this module understands the harness's core kinds and treats every
// `ext` record as opaque: it groups them by `ns`, counts them, keeps the newest
// few, and NEVER interprets `data`. A panel that recognises a namespace can
// render it richly; one that does not still shows that the namespace is live
// and how much it has said. That is the modularity claim, and it holds here by
// this file containing no backend-specific logic.
// ─────────────────────────────────────────────────────────────────────────────

import { int, str } from "../contract.mjs";
import { readTail, parseJsonl, activeRun, liveStreamPath } from "./_runtime.mjs";

export const id = "live-stream";
export const fields = ["live"];
export function describe() {
  return "during-the-run event stream — session id, per-gate verdicts, backend telemetry";
}

/** Newest-N kept per namespace. A feed, not an archive — the file is the archive. */
const EXT_KEEP = 12;
/** Tail bound. The stream is append-only, so the newest records are the live ones. */
const TAIL_BYTES = 512 * 1024;

export async function read(ctx) {
  const run = await activeRun(ctx.runsRoot);
  if (!run) return { ok: false, reason: "no active run directory — nothing to read yet" };

  // The stream is written into the CELL directory, not the campaign directory
  // this `run.dir` names — see `liveStreamPath`. Joining the filename onto
  // `run.dir` here is what kept the wall empty through a live run.
  const path = await liveStreamPath(run.dir);
  const raw = path ? await readTail(path, TAIL_BYTES) : "";
  if (!raw) {
    return {
      ok: false,
      // NOT an error. A cell that has not opened its session yet has written
      // nothing, and a run started before the stream existed never will.
      reason: "no live.jsonl yet — written from cell start (older runs have none)",
    };
  }

  const recs = parseJsonl(raw);
  if (!recs.length) return { ok: false, reason: "live.jsonl present but held no parseable records" };

  // ── CORE: the harness's own account ───────────────────────────────────────
  let sessionId = null;
  let cellSeq = null;
  let arm = null;
  let attempt = null;
  // ── THE PHASE, AS THE PRODUCER STATES IT ──────────────────────────────────
  //
  // `phase.start` is a documented core kind and this reader ignored it, while
  // the board's phase spine read `run.phase` — which sources/run-log.mjs
  // recovers BY REGEX from PROGRESS lines in the launch log. That is the exact
  // shape of defect this whole surface exists to remove: a consumer deriving a
  // fact a producer states.
  //
  // It is not academic. PROGRESS lines are emitted by the build/serve loop, so
  // when the build ended and grading began the parsed phase sat on
  // `initial-chunk-6` while gate verdicts were already landing — the spine said
  // BUILD · RUNNING against a wall showing 36/53 passing. The producer had
  // written `phase.start feedback-1` six milliseconds after `attempt.end`, and
  // nothing read it.
  let phase = null;
  const phaseLog = [];
  const gates = new Map(); // gate id -> newest verdict, per the LAST attempt seen
  const attempts = new Map(); // attempt -> {verdict, failed, ts}
  const byNs = new Map();
  let backends = new Map();

  for (const r of recs) {
    if (!r || typeof r !== "object") continue;
    const kind = str(r.kind);

    // The join key. Carried on every cell-scoped record; the newest wins so a
    // multi-cell run reports the cell actually running.
    const sid = str(r.session_id);
    if (sid) sessionId = sid;
    if (int(r.cell_seq) !== null) cellSeq = int(r.cell_seq);

    if (kind === "cell.start") {
      arm = str(r.arm) ?? arm;
      continue;
    }
    if (kind === "gate.result") {
      const gid = str(r.id);
      if (!gid) continue;
      const a = int(r.attempt);
      const status = str(r.status);
      if (a !== null) attempt = Math.max(attempt ?? 0, a);

      // ── TWO DIFFERENT FACTS, AND KEEPING ONLY ONE OF THEM WAS THE BUG ─────
      //
      // The gate runner re-grades the WHOLE suite every attempt, so a gate that
      // passed on attempt 1 emits `pass` again on attempt 2. Collapsing to the
      // newest record threw away the trajectory, and the wall then had nothing
      // to compute "first passed on attempt N" from — so it used the newest
      // attempt instead and drew a `2` on all 65 gates that had passed first
      // try. Attempts-to-green is a headline measurement of this bench; a wall
      // that reports 2 for a gate that never failed is not a cosmetic defect.
      //
      //   status/phase/attempt/ts  the NEWEST verdict — the current state of
      //                            the code, which is what the square's colour
      //                            means.
      //   first_pass_attempt       the EARLIEST attempt that recorded a pass.
      //   ever_failed              did ANY attempt record a fail.
      //
      // The last two are folds across every record seen, and they are what
      // separates a green-first-try square from a repaired one.
      const prev = gates.get(gid) ?? {
        id: gid,
        status: null,
        phase: null,
        attempt: null,
        ts: null,
        first_pass_attempt: null,
        ever_failed: false,
      };

      // Newest wins. Ordered by attempt, then ts — the file is appended in
      // order, but a reader must not depend on that to stay correct.
      const newer =
        prev.attempt === null ||
        (a !== null && a > prev.attempt) ||
        (a === prev.attempt && (int(r.ts) ?? 0) >= (prev.ts ?? 0));
      if (newer) {
        prev.status = status;
        prev.phase = str(r.phase) ?? prev.phase;
        prev.attempt = a ?? prev.attempt;
        prev.ts = int(r.ts) ?? prev.ts;
      }

      if (status === "pass" && a !== null) {
        prev.first_pass_attempt =
          prev.first_pass_attempt === null ? a : Math.min(prev.first_pass_attempt, a);
      }
      if (status === "fail") prev.ever_failed = true;

      gates.set(gid, prev);
      continue;
    }
    if (kind === "phase.start") {
      const ph = str(r.phase);
      if (!ph) continue;
      const ts = int(r.ts);
      // NEWEST WINS BY TIMESTAMP, not by file order. The file is appended in
      // order and a reader must still not depend on that — the same rule
      // `gate.result` already follows above.
      if (phase === null || (ts ?? 0) >= (phase.ts ?? 0)) phase = { phase: ph, ts };
      phaseLog.push({ phase: ph, ts });
      continue;
    }
    if (kind === "attempt.end") {
      const a = int(r.attempt);
      if (a !== null) attempts.set(a, { attempt: a, verdict: str(r.verdict), failed: int(r.failed), ts: int(r.ts) });
      continue;
    }
    if (kind === "backend") {
      const ns = str(r.ns);
      if (ns) backends.set(ns, { ns, name: str(r.name), version: str(r.version) });
      continue;
    }
    if (kind === "ext") {
      // OPAQUE BY CONTRACT. Grouped and counted, never interpreted.
      const ns = str(r.ns) ?? "(unnamed)";
      if (!byNs.has(ns)) byNs.set(ns, { ns, count: 0, last_ts: null, types: new Map(), recent: [] });
      const slot = byNs.get(ns);
      slot.count += 1;
      slot.last_ts = int(r.ts) ?? slot.last_ts;
      const t = str(r.type) ?? "(untyped)";
      slot.types.set(t, (slot.types.get(t) ?? 0) + 1);
      slot.recent.push({ type: t, ts: int(r.ts), data: r.data ?? null });
      if (slot.recent.length > EXT_KEEP) slot.recent.shift();
    }
  }

  const gateList = [...gates.values()];
  const counts = { pass: 0, fail: 0, other: 0 };
  for (const g of gateList) {
    if (g.status === "pass") counts.pass += 1;
    else if (g.status === "fail") counts.fail += 1;
    else counts.other += 1;
  }

  return {
    ok: true,
    provenance: { path, mtime: null, bytes: raw.length },
    patch: {
      live: {
        session_id: sessionId,
        cell_seq: cellSeq,
        arm,
        attempt,
        // The producer's own account of where the cell is. `phase` is the
        // newest transition; `phases` is the ordered history, which is what
        // lets a consumer show when each one started without re-reading the
        // file. Null when the stream carries no `phase.start` at all — an
        // older run, or a tail window that has scrolled past them — and a
        // consumer must fall back rather than treat null as "no phase".
        phase: phase?.phase ?? null,
        phase_ts: phase?.ts ?? null,
        phases: phaseLog.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)),
        records: recs.length,
        gates: gateList,
        gate_counts: counts,
        attempts: [...attempts.values()].sort((a, b) => a.attempt - b.attempt),
        backends: [...backends.values()],
        // Namespaces are reported whether or not any panel knows them: an
        // unrecognised backend must still be visibly ALIVE rather than absent.
        ext: [...byNs.values()]
          .map((s) => ({
            ns: s.ns,
            count: s.count,
            last_ts: s.last_ts,
            types: [...s.types.entries()].map(([type, n]) => ({ type, n })),
            recent: s.recent,
          }))
          .sort((a, b) => b.count - a.count),
      },
    },
  };
}
