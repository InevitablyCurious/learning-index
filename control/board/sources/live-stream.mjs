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
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { readTail, parseJsonl, cellLiveStreamPath, readAttemptGateResults } from "./_runtime.mjs";

export const id = "live-stream";
export const fields = ["live", "run.phase", "run.chunk"];
export function describe() {
  return "during-the-run event stream — session id, per-gate verdicts, backend telemetry";
}

/** Newest few per namespace; the file is the archive. */
const EXT_KEEP = 12;
/** Tail bound: the newest records are the live ones. */
const TAIL_BYTES = 512 * 1024;

/**
 * The five token categories on every `turn.tokens` delta (canonical harness
 * order) — the same spelling as the delta on the wire.
 */
const TOKEN_FIELDS = ["input", "output", "reasoning", "cache_read", "cache_write"];

/**
 * The record kinds the progress fold reads. A substring test before
 * JSON.parse skips the rest of a whole-file read — the runs.mjs pre-filter.
 * The token fold reads the WHOLE file: a 512KB tail would silently undercount
 * early turns of a long run, and a silent undercount is a fabricated number.
 */
const PROGRESS_KINDS = ['"turn.tokens"', '"compaction"', '"pause.start"', '"pause.end"'];

/** Phase kinds the benchmark names; anything else folds into "unknown". */
const KNOWN_PHASE_KINDS = new Set(["build", "troubleshooting"]);

/** "initial-chunk-3" -> 3; any other phase (a repair round) has no chunk -> null. */
function chunkOf(phase) {
  const m = /^initial-chunk-(\d+)$/.exec(phase ?? "");
  return m ? Number(m[1]) : null;
}

// ── TOKEN PROGRESS ─────────────────────────────────────────────────────────
// The board's only cumulative token axis for a LIVING cell. It is folded from
// the WHOLE live.jsonl (not the live tail): turn.tokens marks spend as it
// happens, and the early turns of a long run sit far outside a tail read.
//
// The axis is the sum of `delta` (the harness's increment since the previous
// completed turn of the same session), NEVER its session-scoped `cumulative`:
// a new session resets that counter, so summing it would double-count, while
// the deltas are monotonic per session and additive across sessions.

/** A zeroed token accumulator — the exact five + their total. */
function zeroTokens() {
  const t = {};
  for (const f of TOKEN_FIELDS) t[f] = 0;
  t.total = 0;
  return t;
}

/** The delta's own total, falling back to the sum of the five when unstated. */
function deltaTotal(delta) {
  const stated = int(delta?.total);
  if (stated !== null) return stated;
  let sum = 0;
  for (const f of TOKEN_FIELDS) sum += int(delta?.[f]) ?? 0;
  return sum;
}

/** Add one turn delta into an accumulator (five fields + total), in place. */
function addTokens(acc, delta) {
  for (const f of TOKEN_FIELDS) acc[f] += int(delta?.[f]) ?? 0;
  acc.total += deltaTotal(delta);
  return acc;
}

/** The byKind bucket a phase_kind belongs to: the two named kinds, or unknown. */
function kindBucket(phaseKind) {
  return KNOWN_PHASE_KINDS.has(phaseKind) ? phaseKind : "unknown";
}

/**
 * Fold the token-relevant records into the `progress` payload. Records arrive
 * in file order and are sorted by `ts` here — file position is never trusted.
 * Zero turn.tokens records (a run from before the harness emitted them) states
 * `available: false` and carries NO totals: absence is not zero.
 */
function buildProgress(records) {
  const turnRecs = records.filter((r) => str(r.kind) === "turn.tokens");
  const controlRecs = records.filter((r) => {
    const k = str(r.kind);
    return k === "pause.start" || k === "pause.end" || k === "compaction";
  });
  // ts order across every kind: a pause/compaction is positioned against the
  // segments it actually followed, never against where the line landed.
  const ordered = [...turnRecs, ...controlRecs].sort(
    (a, b) => (int(a.ts) ?? 0) - (int(b.ts) ?? 0),
  );

  // pending pause state: last pause.* in ts order wins.
  let paused = false;
  for (const r of ordered) {
    const k = str(r.kind);
    if (k === "pause.start") paused = true;
    else if (k === "pause.end") paused = false;
  }

  if (!turnRecs.length) return { available: false, paused };

  const totals = zeroTokens();
  const byKind = { build: zeroTokens(), troubleshooting: zeroTokens() };
  const byPhaseKind = [];
  const phaseKindAt = new Map(); // "<index>::<kind>" -> the same entry object
  const segments = [];
  const boundaries = [];
  const compactionRecs = [];
  let running = 0;
  let prevKey = null;

  for (const r of ordered) {
    const kind = str(r.kind);
    if (kind === "compaction") {
      compactionRecs.push(r);
      continue;
    }
    if (kind !== "turn.tokens") continue;

    const phaseIndex = int(r.phase_index);
    const phaseKind = str(r.phase_kind) ?? "unknown";
    const key = `${phaseIndex}::${phaseKind}`;

    const delta = zeroTokens();
    addTokens(delta, r.delta);
    const startTotal = running;
    addTokens(totals, r.delta);
    running += delta.total;
    const endTotal = running;

    segments.push({
      phase_index: phaseIndex,
      phase_kind: phaseKind,
      phase_name: str(r.phase_name),
      ts: int(r.ts),
      delta,
      start_total: startTotal,
      end_total: endTotal,
    });

    const bucket = kindBucket(phaseKind);
    if (!byKind[bucket]) byKind[bucket] = zeroTokens();
    addTokens(byKind[bucket], r.delta);

    if (!phaseKindAt.has(key)) {
      const entry = { phase_index: phaseIndex, phase_kind: phaseKind, tokens: zeroTokens() };
      phaseKindAt.set(key, entry);
      byPhaseKind.push(entry);
    }
    addTokens(phaseKindAt.get(key).tokens, r.delta);

    // A new (phase_index, phase_kind) — build → grade or a new chunk — starts
    // at this segment's start_total: both kinds of boundary, one rule.
    if (prevKey !== null && prevKey !== key) {
      boundaries.push({ phase_index: phaseIndex, phase_kind: phaseKind, offset: startTotal });
    }
    prevKey = key;
  }

  // A compaction's geometric offset is the cumulative axis at its own ts: the
  // end_total of the last segment at or before it. `tokens_before` is the
  // harness's context peak — a different unit — kept verbatim as a data
  // attribute, never used as the offset.
  const compactions = compactionRecs
    .map((r) => {
      const ts = int(r.ts);
      let offset = 0;
      for (const seg of segments) {
        if ((seg.ts ?? 0) <= (ts ?? 0)) offset = seg.end_total;
      }
      return { ts, tokens_before: r.tokens_before ?? null, offset };
    })
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  return {
    available: true,
    paused,
    totals,
    byKind,
    byPhaseKind,
    segments,
    boundaries,
    compactions,
  };
}

/**
 * The token progress for ONE cell, from its whole live.jsonl. Unreadable is
 * "no token data", never an observed pause or a zero total.
 */
async function readProgress(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { available: false, paused: false };
  }
  const records = [];
  for (const line of text.split("\n")) {
    if (!PROGRESS_KINDS.some((w) => line.includes(w))) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // a half-flushed last line is normal on a growing stream
    }
    if (r && typeof r === "object") records.push(r);
  }
  return buildProgress(records);
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

  // One gate verdict into the fold: the newest verdict (the square's colour) and
  // the trajectory — the earliest passing attempt and whether any attempt failed.
  function foldGate(gid, a, status, phase, ts) {
    if (a !== null) attempt = Math.max(attempt ?? 0, a);
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
      (a === prev.attempt && (ts ?? 0) >= (prev.ts ?? 0));
    if (newer) {
      prev.status = status;
      prev.phase = phase ?? prev.phase;
      prev.attempt = a ?? prev.attempt;
      prev.ts = ts ?? prev.ts;
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
  }

  // Every graded attempt from its report first: the tail below loses earlier
  // attempts' gate.result rows as the next round writes (readAttemptGateResults).
  for (const row of await readAttemptGateResults(dirname(path))) {
    foldGate(row.id, row.attempt, row.status, row.phase, null);
  }

  // The cumulative token axis, from the whole file (never the tail above).
  const progress = await readProgress(path);

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
      // The runner re-grades the whole suite every attempt; foldGate keeps the
      // newest verdict and the trajectory (keeping only the newest drew a "2" on
      // every gate that had passed first try).
      foldGate(gid, int(r.attempt), str(r.status), str(r.phase), int(r.ts));
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
          told: int(r.told),
          unevaluated: int(r.unevaluated),
          // Carried verbatim (null | {reason, evidence, gates}); absence means healthy.
          render_blocked: r.render_blocked ?? null,
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
        // The cumulative token axis for a LIVING cell, folded from the whole
        // file: per-(phase,kind) totals, turn-ordered segments, boundaries and
        // compaction offsets. `available:false` for a run that predates
        // turn.tokens — no zero-filled totals.
        progress,
      },
    },
  };
}
