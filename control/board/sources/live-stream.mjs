// SOURCE: live-stream — ONE CELL's live.jsonl, the benchmark's one
// during-the-run surface (LIVE-STREAM.md), at the cell's own directory
// (cellLiveStreamPath). Per cell (readCell): built for every cell of the strip. Other
// sources read files written when something ends; this is what makes the gate
// wall and the learning panel move during a run.
//
// The benchmark owns the core kinds; backends own their `ext` namespaces, which
// are grouped, counted and kept newest-few but never interpreted. No
// backend-specific logic lives here.

import { int, str } from "../contract.mjs";
import { readTail, parseJsonl, cellLiveStreamPath } from "./_runtime.mjs";

export const id = "live-stream";
export const fields = ["live", "run.phase", "run.chunk"];
export function describe() {
  return "during-the-run event stream — session id, per-gate verdicts, backend telemetry";
}

/** Newest few per namespace; the file is the archive. */
const EXT_KEEP = 12;
/** Tail bound: the newest records are the live ones. */
const TAIL_BYTES = 512 * 1024;

/** "initial-chunk-3" -> 3; any other phase (a repair round) has no chunk -> null. */
function chunkOf(phase) {
  const m = /^initial-chunk-(\d+)$/.exec(phase ?? "");
  return m ? Number(m[1]) : null;
}

export async function readCell(ctx) {
  const path = await cellLiveStreamPath(ctx.runsRoot, ctx.cell);
  const raw = path ? await readTail(path, TAIL_BYTES) : "";
  if (!raw) {
    return {
      ok: false,
      // Not an error: nothing written yet, or a run from before the stream existed.
      reason: "no live.jsonl yet — written from cell start (older runs have none)",
    };
  }

  const recs = parseJsonl(raw);
  if (!recs.length) return { ok: false, reason: "live.jsonl present but held no parseable records" };

  // ── CORE: the harness's own account ──
  let sessionId = null;
  let cellSeq = null;
  let arm = null;
  // The cell's own serve endpoint, as the producer stated it on cell.start
  // (null on older streams).
  let serveHostPort = null;
  let serveUrl = null;
  let attempt = null;
  // The phase as the producer states it (phase.start); the regex-parsed
  // run.phase lags a whole grading pass.
  let phase = null;
  const phaseLog = [];
  const gates = new Map(); // gate id -> newest verdict, per the LAST attempt seen
  const attempts = new Map(); // attempt -> {verdict, failed, ts}
  // attempt → (gate → status), so each closed attempt can say what it fixed
  // and broke against the previous one.
  const byAttempt = new Map();
  let ended = null; // the producer's cell.end: how the cell stopped
  const byNs = new Map();
  let backends = new Map();

  for (const r of recs) {
    if (!r || typeof r !== "object") continue;
    const kind = str(r.kind);

    // The join key; the newest wins, so a multi-cell run names the running cell.
    const sid = str(r.session_id);
    if (sid) sessionId = sid;
    if (int(r.cell_seq) !== null) cellSeq = int(r.cell_seq);

    if (kind === "cell.start") {
      arm = str(r.arm) ?? arm;
      serveHostPort = int(r.serve_host_port) ?? serveHostPort;
      serveUrl = str(r.serve_url) ?? serveUrl;
      continue;
    }
    if (kind === "cell.end") {
      ended = { verdict: str(r.verdict), terminal_reason: str(r.terminal_reason), ts: int(r.ts) };
      continue;
    }
    if (kind === "gate.result") {
      const gid = str(r.id);
      if (!gid) continue;
      const a = int(r.attempt);
      const status = str(r.status);
      if (a !== null) attempt = Math.max(attempt ?? 0, a);

      // The runner re-grades the whole suite every attempt, so two facts are kept:
      // the newest verdict (the square's colour) and the trajectory — the earliest
      // passing attempt and whether any attempt failed. Keeping only the newest drew a
      // "2" on every gate that had passed first try.
      const prev = gates.get(gid) ?? {
        id: gid,
        status: null,
        phase: null,
        attempt: null,
        ts: null,
        first_pass_attempt: null,
        ever_failed: false,
      };

      // Newest by attempt, then ts (never rely on file order).
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
      if (a !== null && status) {
        if (!byAttempt.has(a)) byAttempt.set(a, new Map());
        byAttempt.get(a).set(gid, status);
      }

      gates.set(gid, prev);
      continue;
    }
    if (kind === "phase.start") {
      const ph = str(r.phase);
      if (!ph) continue;
      const ts = int(r.ts);
      // Newest by timestamp, not file order.
      if (phase === null || (ts ?? 0) >= (phase.ts ?? 0)) phase = { phase: ph, ts };
      phaseLog.push({ phase: ph, ts });
      continue;
    }
    if (kind === "attempt.end") {
      const a = int(r.attempt);
      if (a !== null) {
        attempts.set(a, {
          attempt: a,
          verdict: str(r.verdict),
          failed: int(r.failed),
          ts: int(r.ts),
          // Player order: the stage this round reached; null on older streams.
          stage: int(r.stage),
          stage_name: str(r.stage_name),
          withheld: int(r.withheld),
        });
      }
      continue;
    }
    if (kind === "backend") {
      const ns = str(r.ns);
      if (ns) backends.set(ns, { ns, name: str(r.name), version: str(r.version) });
      continue;
    }
    if (kind === "ext") {
      // Opaque by contract: grouped and counted, never interpreted.
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

  // Fixed / broke per closed attempt, against the one before.
  for (const entry of attempts.values()) {
    const now = byAttempt.get(entry.attempt);
    const before = byAttempt.get(entry.attempt - 1);
    if (!now || !before) continue;
    let fixed = 0;
    let broke = 0;
    for (const [gid, status] of now) {
      const was = before.get(gid);
      if (was === "fail" && status === "pass") fixed += 1;
      if (was === "pass" && status === "fail") broke += 1;
    }
    entry.fixed = fixed;
    entry.broke = broke;
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
      // The phase as the producer states it (phase.start). Merged after
      // run-log, which scrapes it from launch-log lines written only when a
      // chunk ENDS, so the phase spine lagged the cell card by one chunk.
      // null (no phase.start seen) never overwrites run-log's answer.
      run: phase
        ? { phase: phase.phase, chunk: { current: chunkOf(phase.phase) } }
        : null,
      live: {
        session_id: sessionId,
        cell_seq: cellSeq,
        arm,
        serve_host_port: serveHostPort,
        serve_url: serveUrl,
        attempt,
        // `phase` is the newest transition, `phases` the ordered history. null when
        // no phase.start is visible (older run, or scrolled past): consumers fall back.
        phase: phase?.phase ?? null,
        phase_ts: phase?.ts ?? null,
        phases: phaseLog.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)),
        records: recs.length,
        gates: gateList,
        gate_counts: counts,
        attempts: [...attempts.values()].sort((a, b) => a.attempt - b.attempt),
        // How the cell stopped, as the producer said (null while running).
        ended,
        backends: [...backends.values()],
        // Every namespace is reported, known to a panel or not.
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
