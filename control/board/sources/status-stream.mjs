// SOURCE: status-stream — the active run's manifest.status.jsonl, the
// authoritative per-attempt record (gates, arm, verdict, tokens). Records:
// `attempt` (memory_mode, failed_gates, verdict, progress) and `turn_terminal`
// (per anomalous turn). Appended at attempt end (~30 min), so it is not the live
// pulse. It does not build the gate wall (that is GET /api/wall); failed_gates is
// used here for resolved gates and the arm delta.

import { parseGate, int, str, median, finalizeDelta, cellValidity } from "../contract.mjs";
import { join } from "node:path";
import { readTail, parseJsonl, activeRun, statOrNull } from "./_runtime.mjs";

export const id = "status-stream";
export const fields = ["arm_delta", "history"];
/** What readCell adds to one cell's view. */
export const cellFields = ["run.arm", "run.attempt", "run.turns", "run.tokens", "honesty"];
export function describe() {
  return "append-only per-attempt status stream (RC-5) — authoritative for gates, arm, verdict";
}

export async function read(ctx) {
  // One run only (activeRun), never a fold across run folders.
  const run = await activeRun(ctx.runsRoot);
  if (!run?.statusPath) {
    return {
      ok: false,
      reason: "no manifest.status.jsonl yet — appended at attempt end (~30 min)",
    };
  }

  const records = parseJsonl(await readTail(run.statusPath));
  const cells = cellsFromRecords(records, run.name);
  if (!cells.length) {
    return { ok: false, reason: "status stream present but carries no attempt records" };
  }

  cells.sort((a, b) => (b.last_seen ?? 0) - (a.last_seen ?? 0));

  const arm_delta = buildDelta(cells);
  const history = cells
    .filter((c) => c.complete)
    .map((c) => ({
      cell_label: c.cell_label,
      arm: c.arm,
      started_at: null,
      duration_s: c.wall_seconds,
      segments: segmentsFor(c),
      triggers: [],
      gates_resolved: c.resolved_gates.length,
      verdict: c.verdict,
    }));

  return {
    ok: true,
    provenance: {
      path: run.statusPath,
      mtime: run.statusStat?.mtimeMs ?? null,
      bytes: run.statusStat?.size ?? null,
      run: run.name,
    },
    // Across the campaign's cells on purpose: the OFF/ON delta and the history
    // are about the batch, not one cell.
    patch: { arm_delta, history },
  };
}

/**
 * ONE CELL's own attempt records: its arm, attempt, turns, tokens and
 * transport honesty. Never the newest cell's, never a sum over cells.
 */
export async function readCell(ctx) {
  const path = join(ctx.runsRoot, ctx.cell.run_dir, "manifest.status.jsonl");
  const st = await statOrNull(path);
  if (!st?.isFile()) {
    return { ok: false, reason: "no manifest.status.jsonl yet — appended at attempt end (~30 min)" };
  }
  const records = parseJsonl(await readTail(path));
  const c = cellsFromRecords(records, ctx.cell.run_dir).find((x) => x.seq === ctx.cell.sequence_index);
  if (!c) return { ok: false, reason: "this cell has no attempt record yet — written at attempt end" };
  const one = [c];

  return {
    ok: true,
    provenance: { path, mtime: st.mtimeMs, bytes: st.size, run: ctx.cell.run_dir },
    patch: {
      run: {
        arm: c.arm,
        cell_label: c.cell_label,
        org_id: c.org_id,
        attempt: { current: c.attempt, max: 5 },
        turns: c.turns,
        tokens: {
          input: c.input_tokens,
          output: c.output_tokens,
          injected_block: c.injected_block_est_tokens,
        },
      },
      honesty: {
        transport: {
          truncations: sum(one, "truncated_turns"),
          finalize_timeouts: sum(one, "finalize_timeouts"),
          finalize_timeout_turns: sum(one, "finalize_timeout_turns"),
          guard_aborts: sum(one, "guard_aborted_turns"),
        },
        // Real turns, excluded from the measurement, from the status records.
        recovered_turns: sum(one, "guard_aborted_turns") + sum(one, "finalize_timeout_turns"),
        serves: {
          sent: nullSum(one, "served_attempted"),
          confirmed_on_chain: nullSum(one, "served_confirmed"),
          rejected: nullSum(one, "served_failed"),
        },
      },
    },
  };
}

function sum(cells, key) {
  return cells.reduce((acc, c) => acc + (c[key] ?? 0), 0);
}

/** Sum that stays null when NO cell ever reported the field (unobserved ≠ 0). */
function nullSum(cells, key) {
  const seen = cells.filter((c) => c[key] !== null && c[key] !== undefined);
  if (!seen.length) return null;
  return seen.reduce((acc, c) => acc + c[key], 0);
}

/**
 * Fold a stream's records into per-cell state by sequence_index, gate history
 * ordered by attempt.
 */
function cellsFromRecords(records, dirName) {
  const by = new Map();

  for (const r of records) {
    const seq = int(r.sequence_index) ?? 0;
    const key = `${dirName}#${seq}`;
    if (!by.has(key)) {
      by.set(key, {
        cell_label: `${dirName}-${String(seq).padStart(4, "0")}`,
        seq,
        arm: null,
        org_id: null,
        attempt: null,
        attempts: new Map(), // attempt -> Set(gate id)
        gateMeta: new Map(), // gate id -> parsed
        verdict: null,
        complete: false,
        turns: null,
        wall_seconds: null,
        input_tokens: null,
        output_tokens: null,
        injected_block_est_tokens: null,
        truncated_turns: 0,
        guard_aborted_turns: 0,
        finalize_timeout_turns: 0,
        finalize_timeouts: 0,
        served_attempted: null,
        served_confirmed: null,
        served_failed: null,
        problems_before: null,
        problems_after: null,
        // Void-instrument inputs (RUNBOOK 5.10; see contract.cellValidity).
        full_green: false,
        terminal_reason: null,
        provider_truncations: 0,
        unrecovered_anomaly_turns: 0,
        last_seen: 0,
        resolved_gates: [],
      });
    }
    const c = by.get(key);

    if (r.type === "turn_terminal") {
      // Both relay stream-death kinds count in one tile.
      const reason = str(r.reason);
      if (reason === "stream_finalize_timeout" || reason === "relay_stream_incomplete") {
        c.finalize_timeouts += 1;
      }
      continue;
    }

    // Only `attempt` records (or legacy ones with no type) carry gate/progress
    // state; other types are skipped.
    if (r.type !== undefined && r.type !== "attempt") continue;
    const gates = Array.isArray(r.failed_gates)
      ? r.failed_gates
      : Array.isArray(r.progress?.failed_gates)
        ? r.progress.failed_gates
        : null;

    const attempt = int(r.attempt);
    if (attempt !== null && gates) {
      const set = new Set();
      for (const raw of gates) {
        const g = parseGate(raw);
        if (!g) continue;
        set.add(g.id);
        if (!c.gateMeta.has(g.id)) c.gateMeta.set(g.id, g);
      }
      c.attempts.set(attempt, set);
      c.attempt = Math.max(c.attempt ?? 0, attempt);
    }

    c.arm = str(r.memory_mode) ?? c.arm;
    c.org_id = str(r.org_id) ?? c.org_id;
    c.verdict = str(r.verdict) ?? c.verdict;
    if (r.terminal_outcome === true || str(r.terminal_reason)) c.complete = true;

    const p = r.progress ?? {};
    c.turns = int(p.turns) ?? c.turns;
    c.wall_seconds = Math.round(Number(p.wall_seconds ?? 0)) || c.wall_seconds;
    c.input_tokens = int(r.work_input_tokens) ?? int(p.input_tokens) ?? c.input_tokens;
    c.output_tokens = int(r.work_output_tokens) ?? int(p.output_tokens) ?? c.output_tokens;
    c.injected_block_est_tokens = int(r.injected_block_est_tokens) ?? c.injected_block_est_tokens;
    c.truncated_turns = Math.max(c.truncated_turns, int(r.truncated_turns) ?? 0);
    c.guard_aborted_turns = Math.max(c.guard_aborted_turns, int(r.guard_aborted_turns) ?? 0);
    // Carried on the status stream; absent on older records stays 0.
    c.finalize_timeout_turns = Math.max(
      c.finalize_timeout_turns,
      int(r.finalize_timeout_turns) ?? 0,
    );
    c.served_attempted = int(p.served_attempted) ?? c.served_attempted;
    c.served_confirmed = int(p.served_confirmed) ?? c.served_confirmed;
    c.served_failed = int(p.served_failed) ?? c.served_failed;
    c.problems_before = int(p.problems_before) ?? c.problems_before;
    c.problems_after = int(p.problems_after) ?? c.problems_after;
    // Validity inputs from the last (terminal) attempt, as the scorecard does.
    c.full_green = p.full_green === true;
    c.terminal_reason = str(r.terminal_reason) ?? c.terminal_reason;
    c.provider_truncations = Math.max(c.provider_truncations, int(r.provider_truncations) ?? 0);
    // The unrecovered subset decides validity; truncated_turns (which counts
    // recovered loops too) feeds only the transport honesty figure.
    c.unrecovered_anomaly_turns = Math.max(
      c.unrecovered_anomaly_turns,
      int(r.unrecovered_anomaly_turns) ?? 0,
    );
    c.last_seen += 1;
  }

  for (const c of by.values()) c.resolved_gates = resolvedGates(c);
  return [...by.values()];
}

/**
 * Gates red in an earlier attempt and absent in the latest — the only
 * defensible "resolved" from this stream.
 */
function resolvedGates(cell) {
  const attempts = [...cell.attempts.keys()].sort((a, b) => a - b);
  if (attempts.length < 2) return [];
  const first = cell.attempts.get(attempts[0]);
  const last = cell.attempts.get(attempts[attempts.length - 1]);
  return [...first].filter((g) => !last.has(g));
}

/**
 * Per-arm resolution (resolved / ever red) over scored cells only
 * (cellValidity); excluded cells are counted, never silently dropped. An
 * unscored cell would add a guaranteed 0% and fake lift for the memory arm.
 */
function buildDelta(cells) {
  const build = (arm) => {
    const observed = cells.filter((c) => c.arm === arm && c.attempts.size);
    const excluded = { total: 0, void_instrument: 0, resolution_unmeasurable: 0 };
    const mine = [];
    for (const c of observed) {
      const v = cellValidity(c);
      if (v.scored) {
        mine.push(c);
        continue;
      }
      excluded.total += 1;
      excluded[v.reason] += 1;
    }

    if (!mine.length) {
      return {
        cells: 0,
        gates_resolved: null,
        gates_total: null,
        resolution_rate: null,
        median_turns_to_green: null,
        excluded,
      };
    }
    let resolved = 0;
    let total = 0;
    for (const c of mine) {
      const attempts = [...c.attempts.keys()].sort((a, b) => a - b);
      const everRed = new Set();
      for (const a of attempts) for (const g of c.attempts.get(a)) everRed.add(g);
      resolved += c.resolved_gates.length;
      total += everRed.size;
    }
    return {
      cells: mine.length,
      gates_resolved: resolved,
      gates_total: total,
      resolution_rate: total > 0 ? resolved / total : null,
      median_turns_to_green: median(mine.filter((c) => c.verdict === "PASS").map((c) => c.turns)),
      excluded,
    };
  };

  return finalizeDelta({
    sufficient: false,
    min_cells_per_arm: 3,
    a: build("on"),
    b: build("off"),
    delta: null,
    ci: null,
    statement: null,
    note: "gate-level results are clustered within cell — 68 gates from one cell are not 68 independent samples. no CI over gate counts.",
  });
}

/** Build phase vs error phase. */
function segmentsFor(cell) {
  const total = cell.wall_seconds ?? 0;
  if (!total) return [];
  const attempts = [...cell.attempts.keys()].length || 1;
  const build = total / attempts;
  return [
    { kind: "build", from_s: 0, to_s: Math.round(build) },
    { kind: "error", from_s: Math.round(build), to_s: total },
  ];
}
