// SOURCE: runs — one card per run: every cell of the current tree PLUS every
// archived run under runs/backups, newest tree first. The dashboard's per-run
// cards read this section; the browser itself never touches the filesystem.
//
// ── WHY THIS IS ITS OWN SOURCE ──────────────────────────────────────────────
//
// `cells` enumerates the CURRENT batch only: readRunState scans the durable
// launch records and the live process table, and the batch record names the
// active campaign — a reset moves everything else into runs/backups/, out of
// the strip's reach. This source answers the wider question (what runs exist,
// and what did each measure) and owns the `runs` section ALONE, so `cells` —
// which feeds buildCellViews / by_cell — stays exactly as it was.
//
// ── PRODUCER STATES, CONSUMER READS ─────────────────────────────────────────
//
// Every measurement on a card is a field some artifact states, read in a fixed
// precedence: manifest.status.jsonl (the attempt records) → the archived
// backup's results-ledger.jsonl → the cell's own live.jsonl. A field no
// artifact recorded is null — "not recorded" — never 0 and never derived.
//
// The notice counts (loop kills, stalls, cap cut-offs) read the cell's WHOLE
// live.jsonl, not a tail: a tail-bounded read would silently undercount
// notices from early in a long run, and a silent undercount is exactly the
// fabricated number this board refuses. The cheap substring pre-filter before
// JSON.parse keeps the whole-file read affordable — the same walk
// runstats.turnErrors does. turnErrors itself is deliberately NOT reused: it
// is scoped to a RUN dir (it sums every cell under memory*/), while a card is
// scoped to ONE cell (sequence_index) — run-level totals on per-cell cards
// would attribute one cell's kills to its siblings, and would disagree with
// the per-cell manifest fallback below.
//
// ── ENUMERATION ─────────────────────────────────────────────────────────────
//
// Current cells mirror sources/cells.mjs (readRunState + the campaign's
// batch.json) without calling it — one read of each, never two. Archived runs
// come from history.listRunCells, which already walks runs/backups with
// listCampaignDirs(root, { includeBackups: true }); its rows carry `cell`
// relative to runs/backups ("<stamp>/<oldTree>/…/<model>/memory<ARM>/cell-NNNN")
// and `tree_id` (the inner archived tree id, null on an unrecognised layout).
//
// Sort: the run's tree id DESCENDING (current = its run_dir's leading tree id,
// falling back to the active pointer; archived = the inner oldTreeId), then
// sequence_index ASCENDING — so the current tree leads and archived runs
// follow, newest first.

import { join, sep } from "node:path";
import { readdir, readFile } from "node:fs/promises";

import { int, str } from "../contract.mjs";
import {
  parseJsonl,
  readTextCapped,
  statOrNull,
  cellLiveStreamPath,
  activeTreeId,
  isTreeId,
} from "./_runtime.mjs";
import { readRunState } from "../../runstate.mjs";
import { readBatch } from "../../batch.mjs";
import { listRunCells } from "../../history.mjs";
import { listLiveCampaignDirs, BACKUPS_DIR } from "../../tree.mjs";

export const id = "runs";
export const fields = ["runs"];
export function describe() {
  return "one card per run — current-tree cells plus archived runs, newest tree first";
}

// ── the cell's own live.jsonl ────────────────────────────────────────────────

/** The record kinds a card reads; everything else (heartbeats, gates) is skipped
 *  by a substring test before any JSON.parse — the turnErrors pre-filter. */
const WANTED = ['"notice"', '"cell.end"', '"attempt.end"'];

/** The two events whose detail.terminal classifies a killed turn. */
function isTurnKill(r) {
  return r.event === "turn_truncated_retried" || r.event === "recovery_budget_exhausted";
}

/**
 * The card facts from ONE cell's live.jsonl, read whole. null when the cell
 * has no stream — which is a different fact than a stream with zero notices
 * (null = "no live stream", 0 = "live stream, none").
 */
async function readCellStream(path) {
  if (!path) return null;
  const st = await statOrNull(path);
  if (!st?.isFile()) return null;
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const facts = { loop: 0, stalled: 0, cutoffs: 0, cell_end: null, attempt_ends: [] };
  for (const line of raw.split("\n")) {
    if (!WANTED.some((w) => line.includes(w))) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // a half-flushed last line is normal on a growing stream
    }
    if (r?.kind === "notice") {
      // Cap cut-offs are their own event; killed turns classify by terminal.
      if (r.event === "length_cutoff") facts.cutoffs += 1;
      else if (isTurnKill(r)) {
        const terminal = String(r.detail?.terminal ?? "");
        if (terminal === "guard_abort") facts.loop += 1;
        else if (terminal === "turn_stalled") facts.stalled += 1;
      }
    } else if (r?.kind === "cell.end") {
      facts.cell_end = r; // the last cell.end is the terminal one
    } else if (r?.kind === "attempt.end") {
      facts.attempt_ends.push(r);
    }
  }
  return facts;
}

// ── the run's manifest.status.jsonl ──────────────────────────────────────────

/**
 * One run's attempt records grouped by sequence_index, in file order. Read
 * WHOLE (capped at readTextCapped's 4MB): a real run's status stream exceeds
 * the 256KB tail budget (335KB observed), and a tail would silently drop the
 * early cells' records. Memoized per run_dir per read() call — cells of one
 * run share the file, and a per-call memo cannot go stale.
 */
async function manifestBySeq(modelDir) {
  const by = new Map();
  const text = await readTextCapped(join(modelDir, "manifest.status.jsonl"));
  if (text === null) return by;
  for (const r of parseJsonl(text)) {
    // Only attempt records (or legacy ones with no type) carry cell state —
    // the same filter status-stream applies.
    if (r.type !== undefined && r.type !== "attempt") continue;
    const seq = int(r.sequence_index);
    if (seq === null) continue;
    if (!by.has(seq)) by.set(seq, []);
    by.get(seq).push(r);
  }
  return by;
}

/**
 * Fold one cell's attempt records into the fields a card reads. Cumulative
 * fields (progress.*) take the LAST stated value — the terminal attempt's
 * progress is the cell's final progress. Cell-level counters
 * (guard_aborted_turns, stalled_turns, cap_cutoffs) are copied to every
 * attempt row, so last stated = the value. context_peak is PER ATTEMPT: the
 * run's peak is the highest peak stated, never the last attempt's. A field no
 * record states stays null.
 */
function foldManifest(recs) {
  const out = {
    turns: null,
    problems_before: null,
    problems_after: null,
    context_peak: null,
    context_window: null,
    guard_aborted_turns: null,
    stalled_turns: null,
    cap_cutoffs: null,
    terminal_reason: null,
    model: null,
    arm: null,
  };
  for (const r of recs) {
    const p = r.progress ?? {};
    out.turns = int(p.turns) ?? out.turns;
    out.problems_before = int(p.problems_before) ?? out.problems_before;
    out.problems_after = int(p.problems_after) ?? out.problems_after;
    const peak = int(r.context_peak);
    if (peak !== null) out.context_peak = out.context_peak === null ? peak : Math.max(out.context_peak, peak);
    out.context_window = int(r.context_window) ?? out.context_window;
    out.guard_aborted_turns = int(r.guard_aborted_turns) ?? out.guard_aborted_turns;
    out.stalled_turns = int(r.stalled_turns) ?? out.stalled_turns;
    out.cap_cutoffs = int(r.cap_cutoffs) ?? out.cap_cutoffs;
    out.terminal_reason = str(r.terminal_reason) ?? out.terminal_reason;
    out.model = str(r.served_model?.model) ?? out.model;
    out.arm = str(r.memory_mode) ?? out.arm;
  }
  return out;
}

// ── the archived backup's results-ledger.jsonl ───────────────────────────────

/**
 * One backup stamp's results-ledger rows. Often an EMPTY file (0 lines) —
 * parseJsonl yields [] and the ledger simply states nothing. Memoized per
 * stamp per read() call: every archived cell of one backup shares the file.
 */
async function ledgerRows(stampDir) {
  const text = await readTextCapped(join(stampDir, "results-ledger.jsonl"));
  return text === null ? [] : parseJsonl(text);
}

/**
 * The ledger row for one archived cell, or null. Matched on ALL THREE stated
 * identity fields (tree_id, run_id = the model dir name, sequence_index):
 * one backup can hold several campaigns whose sequence indexes overlap, and a
 * row that cannot be tied to exactly one cell vouches for none. The ledger is
 * append-only, so the LAST match is the newest statement.
 */
function matchLedger(rows, treeId, modelName, seq) {
  if (treeId === null || seq === null) return null;
  let found = null;
  for (const r of rows) {
    if (String(r?.tree_id ?? "") !== treeId) continue;
    if (str(r?.run_id) !== modelName) continue;
    if (int(r?.sequence_index) !== seq) continue;
    found = r;
  }
  return found;
}

// ── the read ─────────────────────────────────────────────────────────────────

async function memo(cache, key, make) {
  if (!cache.has(key)) cache.set(key, await make());
  return cache.get(key);
}

export async function read(ctx) {
  const bases = [];

  // ── CURRENT-TREE CELLS ── the same enumeration sources/cells.mjs uses,
  // mirrored (not called — one read of each artifact, never two): the durable
  // run state, then the active campaign's batch record for the verdicts.
  const state = await readRunState({ runsRoot: ctx.runsRoot });
  const live = Array.isArray(state?.runs) ? state.runs : [];
  const ended = Array.isArray(state?.ended) ? state.ended : [];
  const endedByIndex = new Map();
  for (const e of ended) {
    if (Number.isFinite(e?.sequence_index)) endedByIndex.set(e.sequence_index, e);
  }

  let runDir = live[0]?.run_dir ?? state?.run_dir ?? null;
  if (!runDir) {
    try {
      const dirs = await listLiveCampaignDirs(ctx.runsRoot);
      runDir = dirs.length ? dirs[dirs.length - 1].relative : null;
    } catch {
      runDir = null;
    }
  }

  let batch = null;
  if (runDir) {
    try {
      batch = await readBatch(join(ctx.runsRoot, runDir));
    } catch {
      batch = null;
    }
  }
  const scoredByIndex = new Map();
  for (const r of batch?.runs ?? []) {
    if (Number.isFinite(r?.sequence_index)) scoredByIndex.set(r.sequence_index, r);
  }

  const seen = new Set();
  for (const r of live) {
    const idx = r.sequence_index;
    if (idx !== null && idx !== undefined) seen.add(idx);
    const rec = scoredByIndex.get(idx) ?? null;
    bases.push({
      sequence_index: idx ?? null,
      run_dir: r.run_dir ?? null,
      model: r.model ?? null,
      arm: r.arm ?? null,
      running: true,
      scored: rec?.scored ?? null,
      archived: false,
      sort_key: null, // filled below, once the active tree id is known
      live_path: await cellLiveStreamPath(ctx.runsRoot, { run_dir: r.run_dir ?? null, sequence_index: idx ?? null }),
    });
  }
  for (const [idx, rec] of scoredByIndex) {
    if (seen.has(idx)) continue;
    const e = endedByIndex.get(idx);
    bases.push({
      sequence_index: idx,
      run_dir: e?.run_dir ?? runDir,
      model: e?.model ?? null,
      arm: e?.arm ?? "off",
      running: false,
      scored: rec?.scored === true ? true : (rec?.scored === false || e ? false : null),
      archived: false,
      sort_key: null,
      live_path: await cellLiveStreamPath(ctx.runsRoot, { run_dir: e?.run_dir ?? runDir, sequence_index: idx }),
    });
  }
  for (const e of ended) {
    const idx = e?.sequence_index;
    if (!Number.isFinite(idx)) continue;
    if (seen.has(idx) || scoredByIndex.has(idx)) continue;
    bases.push({
      sequence_index: idx,
      run_dir: e.run_dir ?? runDir,
      model: e.model ?? null,
      arm: e.arm ?? "off",
      running: false,
      scored: false,
      archived: false,
      sort_key: null,
      live_path: await cellLiveStreamPath(ctx.runsRoot, { run_dir: e.run_dir ?? runDir, sequence_index: idx }),
    });
    seen.add(idx);
  }

  // ── ARCHIVED RUNS ── every cell of every backup, from the history reader
  // that already walks runs/backups. Its `cell` is relative to runs/backups:
  // "<stamp>/<oldTree>/…/<model>/memory<ARM>/cell-NNNN"; stripping the last
  // two segments leaves the archived run's model dir.
  for (const row of await listRunCells(ctx.runsRoot)) {
    if (row.archived !== true) continue;
    const parts = String(row.cell ?? "").split(sep);
    const seqMatch = /^cell-(\d+)$/i.exec(parts[parts.length - 1] ?? "");
    const armMatch = /^memory(.+)$/i.exec(parts[parts.length - 2] ?? "");
    bases.push({
      sequence_index: seqMatch ? Number(seqMatch[1]) : null,
      run_dir: [BACKUPS_DIR, ...parts.slice(0, -2)].join("/"),
      model: null,
      arm: armMatch ? armMatch[1].toLowerCase() : null,
      running: false,
      scored: null,
      archived: true,
      // The inner archived tree id (null on an unrecognised layout → sorts oldest).
      sort_key: Number(row.tree_id) || 0,
      stamp: parts[0],
      model_name: parts[parts.length - 3] ?? null,
      tree_id: row.tree_id ?? null,
      live_path: join(ctx.runsRoot, BACKUPS_DIR, row.cell, "live.jsonl"),
    });
  }

  // Current cards sort by their own tree: the run_dir's leading segment when
  // it is a tree id, else the active pointer's (a legacy flat campaign belongs
  // to the era the pointer names).
  const activeId = Number(await activeTreeId(ctx.runsRoot)) || 0;
  for (const b of bases) {
    if (b.sort_key !== null) continue;
    const head = String(b.run_dir ?? "").split("/")[0];
    b.sort_key = isTreeId(head) ? Number(head) : activeId;
  }

  // ── CARD FIELDS ── per-cell artifacts, memoized per run_dir / stamp for
  // this call only (a per-call memo cannot go stale; nothing is cached across
  // polls).
  const manifestCache = new Map();
  const ledgerCache = new Map();
  const scorecardCache = new Map();
  const cards = [];
  for (const b of bases) {
    const modelDir = b.run_dir ? join(ctx.runsRoot, b.run_dir) : null;

    let man = null;
    if (modelDir && b.sequence_index !== null) {
      const by = await memo(manifestCache, b.run_dir, () => manifestBySeq(modelDir));
      const recs = by.get(b.sequence_index);
      man = recs?.length ? foldManifest(recs) : null;
    }

    const stream = await readCellStream(b.live_path);

    let ledger = null;
    if (b.archived) {
      const rows = await memo(ledgerCache, b.stamp, () =>
        ledgerRows(join(ctx.runsRoot, BACKUPS_DIR, b.stamp)),
      );
      ledger = matchLedger(rows, b.tree_id, b.model_name, b.sequence_index);
    }

    // A run that aborted before its status stream was written (run 1790202713,
    // harness_error) still has the grader's own per-attempt reports beside its
    // stream: the problem counts they state, first and last MEASURED attempt.
    const graded = man || ledger ? null : await gradedCounts(b.live_path);

    // status: live → harness_error → scored → void, in that precedence.
    const terminalReason =
      man?.terminal_reason ?? (stream?.cell_end ? str(stream.cell_end.terminal_reason) : null);
    let status;
    if (b.running) status = "live";
    else if (terminalReason === "harness_error") status = "harness_error";
    else if (await isScored(b, modelDir, scorecardCache)) status = "scored";
    else status = "void";

    // Error counts: the cell's own stream when it has one (0 = stream, none);
    // else the manifest's stated counters; else null — never 0 for "absent".
    // The manifest fallback for stalled_limit_errors sums TWO stated counters;
    // an artifact old enough to lack cap_cutoffs never states the composite,
    // so it reads null rather than treating the unrecorded subtrahend as 0.
    let loopErrors = null;
    let stalledLimit = null;
    if (stream) {
      loopErrors = stream.loop;
      stalledLimit = stream.stalled + stream.cutoffs;
    } else if (man) {
      loopErrors = man.guard_aborted_turns;
      stalledLimit =
        man.stalled_turns !== null && man.cap_cutoffs !== null
          ? man.stalled_turns + man.cap_cutoffs
          : null;
    }

    // context: manifest top-level → the stream's attempt.end records → null.
    let contextPeak = man?.context_peak ?? null;
    let contextWindow = man?.context_window ?? null;
    if (stream && (contextPeak === null || contextWindow === null)) {
      for (const r of stream.attempt_ends) {
        const peak = int(r?.context_peak);
        if (peak !== null) contextPeak = contextPeak === null ? peak : Math.max(contextPeak, peak);
        contextWindow = int(r?.context_window) ?? contextWindow;
      }
    }

    cards.push({
      sort_key: b.sort_key,
      card: {
        run_dir: b.run_dir ?? null,
        sequence_index: b.sequence_index ?? null,
        archived: b.archived,
        model: b.model ?? man?.model ?? (b.archived ? str(ledger?.model) : null) ?? null,
        arm: b.arm ?? man?.arm ?? (b.archived ? str(ledger?.arm) : null) ?? null,
        status,
        problems_before: man?.problems_before ?? int(ledger?.problems_before) ?? graded?.first ?? null,
        problems_after: man?.problems_after ?? int(ledger?.problems_after) ?? graded?.last ?? null,
        context_peak: contextPeak,
        context_window: contextWindow,
        turns: man?.turns ?? int(ledger?.turns) ?? null,
        loop_errors: loopErrors,
        stalled_limit_errors: stalledLimit,
      },
    });
  }

  // Newest tree first; within one tree, the batch order.
  cards.sort((a, b) => b.sort_key - a.sort_key || (a.card.sequence_index ?? 0) - (b.card.sequence_index ?? 0));
  const list = cards.map((c) => c.card);

  return {
    ok: true,
    provenance: runDir ? { run_dir: runDir } : null,
    patch: {
      runs: {
        list,
        counts: {
          total: list.length,
          live: list.filter((c) => c.status === "live").length,
          scored: list.filter((c) => c.status === "scored").length,
          void: list.filter((c) => c.status === "void").length,
          harness_error: list.filter((c) => c.status === "harness_error").length,
        },
      },
    },
  };
}

/**
 * The failing counts the grader's own attempt-N-report.json files state, for
 * the first and last attempt it MEASURED (a report it marked gradable:false is
 * not a measurement). null when the cell has no readable report.
 */
async function gradedCounts(livePath) {
  if (!livePath) return null;
  const cellDir = livePath.slice(0, livePath.lastIndexOf(sep));
  let names = [];
  try {
    names = await readdir(cellDir);
  } catch {
    return null;
  }
  const counts = [];
  for (const name of names) {
    const m = /^attempt-(\d+)-report\.json$/.exec(name);
    if (!m) continue;
    try {
      const report = JSON.parse(await readFile(join(cellDir, name), "utf8"));
      if (report?.gradable === false || !Array.isArray(report?.problems)) continue;
      counts.push([Number(m[1]), report.problems.length]);
    } catch {
      continue;
    }
  }
  if (!counts.length) return null;
  counts.sort((a, b) => a[0] - b[0]);
  return { first: counts[0][1], last: counts[counts.length - 1][1] };
}

/**
 * Did this run SCORE — produce a measurement — as the harness stated it?
 * Scored is not passed: a failing cell is scored. Current: the batch record's
 * verdict. Archived: the run's own manifest.scorecard.json, which lists every
 * cell dropped from the scored set (void_instrument, not_scored); a cell it
 * does not drop scored. No scorecard = the run never published a measurement
 * (it wrote one only when a cell completed) = void. It used to count only a
 * green or PASS cell as scored, and a `conformed` attempt (the pre-gate passed)
 * as scored — run 1790200233, voided instrument_fault, showed SCORED.
 */
async function isScored(base, modelDir, cache) {
  if (!base.archived) return base.scored === true;
  if (!modelDir || base.sequence_index === null) return false;
  const card = await memo(cache, modelDir, async () => {
    try {
      return JSON.parse(await readFile(join(modelDir, "manifest.scorecard.json"), "utf8"));
    } catch {
      return null;
    }
  });
  if (!card) return false;
  const dropped = [...(card.void_instrument ?? []), ...(card.not_scored ?? [])];
  return !dropped.some((r) => int(r?.sequence_index) === base.sequence_index);
}
