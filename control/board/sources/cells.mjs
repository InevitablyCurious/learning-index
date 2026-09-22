// SOURCE: cells — one record per cell of the current batch, for the board's
// cell strip.
//
// ── WHY THIS IS ITS OWN SOURCE ──────────────────────────────────────────────
//
// `run-log` parses ONE log — the newest — into the scalar `run.*` fields the
// board has always shown. That was right while exactly one cell could be live.
// With N concurrent cells of the SAME model and arm, every distinguishing
// field on a run record is identical: same model, same arm, same run_dir. What
// separates them is the sequence index, how far each has got, and whether each
// is still healthy — and nothing was reading that per cell.
//
// So this source answers one question: what are all the cells of this batch,
// and what is each one doing? It parses each live cell's own log, and folds in
// the batch record (control/batch.mjs) so a finished cell carries its problem
// count and a void one carries its reason.
//
// ── THE STRIP IS NAVIGATION, THE BATCH PANEL IS THE PICK ────────────────────
//
// `panels/batch.js` renders the operator's FLOOR SELECTION — the median, the
// pick buttons, the fingerprint verdict. This is not that. This is how an
// operator moves between the runs of a batch to look at one, including a void
// one, whose whole value is showing why it died. The median marker travels
// here so the two surfaces cannot disagree about which run is representative.

import { join } from "node:path";
import { readTail } from "./_runtime.mjs";
import { readRunState } from "../../runstate.mjs";
import { readBatch } from "../../batch.mjs";
import { countChunkPrompts } from "../../challenges.mjs";

export const id = "cells";
export const fields = ["cells"];
export function describe() {
  return "one record per cell of the current batch — phase, turns, outcome, health";
}

/** "initial-chunk-3" -> 3. Only build chunks; a feedback phase is not one. */
function chunkOf(phase) {
  const m = /^initial-chunk-(\d+)$/.exec(phase ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * The last phase and the scoring-turn total from one cell's own log.
 *
 * Deliberately a SMALL read: the strip shows where a cell is, not everything
 * about it. Every PROGRESS line is emitted twice (structured and bare), so
 * turns are kept per phase and counted once — the same rule run-log follows,
 * because two sources disagreeing about a cell's turn count would be worse
 * than neither showing it.
 */
async function readCellLog(path) {
  let text;
  try {
    text = await readTail(path);
  } catch {
    return { phase: null, chunk: null, turns: null };
  }
  const byPhase = new Map();
  let phase = null;
  for (const line of text.split("\n")) {
    if (!line.includes("PROGRESS")) continue;
    const kv = {};
    for (const m of line.matchAll(/(\w+)=([^\s]+)/g)) kv[m[1]] = m[2];
    if (kv.phase) phase = kv.phase;
    if (kv.turns && kv.phase) byPhase.set(kv.phase, Number(kv.turns));
  }
  let turns = null;
  for (const n of byPhase.values()) {
    if (Number.isFinite(n)) turns = (turns ?? 0) + n;
  }
  return { phase, chunk: chunkOf(phase), turns };
}

/** Seconds since a start stamp, or null when there is nothing to measure. */
function elapsed(startedAt) {
  const t = Date.parse(startedAt ?? "");
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
}

export async function read(ctx) {
  const state = await readRunState({ runsRoot: ctx.runsRoot });
  const live = Array.isArray(state?.runs) ? state.runs : [];

  // One batch per run_dir. Concurrent cells share it, so the newest live cell
  // names the batch; with nothing live there is no strip to draw.
  const runDir = live[0]?.run_dir ?? state?.run_dir ?? null;

  let batch = null;
  if (runDir) {
    try {
      // readBatch takes the ABSOLUTE run dir (batch.json sits inside it), not
      // the runs-root-relative name the board passes around.
      batch = await readBatch(join(ctx.runsRoot, runDir));
    } catch {
      // A batch that cannot be read is not an error on this surface — the live
      // cells still render. The batch panel is where that failure belongs.
      batch = null;
    }
  }

  const scoredByIndex = new Map();
  for (const r of batch?.runs ?? []) {
    if (Number.isFinite(r?.sequence_index)) scoredByIndex.set(r.sequence_index, r);
  }

  const total = await countChunkPrompts(
    process.env.BENCH_TASK_DIR || join(ctx.benchRoot, "task", "backgammon"),
  );

  const list = [];
  const seen = new Set();

  for (const r of live) {
    const idx = r.sequence_index;
    if (idx !== null && idx !== undefined) seen.add(idx);
    const log = await readCellLog(r.log_path);
    const rec = scoredByIndex.get(idx) ?? null;
    list.push({
      sequence_index: idx ?? null,
      run_id: r.run_id ?? null,
      run_dir: r.run_dir ?? null,
      session_id: r.session_id ?? null,
      model: r.model ?? null,
      arm: r.arm ?? null,
      liveness: r.liveness ?? null,
      running: r.running === true,
      state: r.state ?? null,
      terminal_status: r.terminal_status ?? null,
      heartbeat_age_s: r.heartbeat_age_s ?? null,
      elapsed_s: elapsed(r.started_at),
      phase: log.phase,
      chunk: { current: log.chunk, total },
      turns: log.turns,
      // From the batch record when it has one: the verdict, never re-derived.
      scored: rec?.scored ?? null,
      problems: rec?.problem_count ?? null,
      void_reason: rec?.void_reason ?? null,
    });
  }

  // Cells that have ENDED are still part of the batch and still worth opening —
  // a void cell is where an operator finds out why it died. They carry no live
  // record, so they come from the batch alone, which holds only the verdict:
  // the count, whether it scored, and why not. Everything else is null rather
  // than guessed.
  for (const [idx, rec] of scoredByIndex) {
    if (seen.has(idx)) continue;
    list.push({
      sequence_index: idx,
      run_id: null,
      run_dir: runDir,
      session_id: null,
      model: null,
      arm: "off",
      liveness: "ended",
      running: false,
      state: "complete",
      terminal_status: null,
      heartbeat_age_s: null,
      elapsed_s: null,
      phase: null,
      chunk: { current: null, total },
      turns: null,
      scored: rec?.scored ?? null,
      problems: rec?.problem_count ?? null,
      void_reason: rec?.void_reason ?? null,
    });
  }

  list.sort((a, b) => (a.sequence_index ?? 0) - (b.sequence_index ?? 0));

  return {
    ok: true,
    provenance: runDir ? { run_dir: runDir } : null,
    patch: {
      cells: {
        run_dir: runDir,
        list,
        // The batch's own numbers, carried so the strip and the batch panel
        // cannot disagree about which run is representative.
        median: batch?.median ?? null,
        fingerprint: batch?.fingerprint ?? null,
        batch_void: batch?.void === true,
        void_reason: batch?.void_reason ?? null,
        counts: {
          total: list.length,
          live: list.filter((c) => c.running).length,
          scored: list.filter((c) => c.scored === true).length,
          void: list.filter((c) => c.scored === false).length,
        },
      },
    },
  };
}
