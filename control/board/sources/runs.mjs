// SOURCE: runs — one card per run: every cell of the LIVE tree, newest tree
// first. Archive roots (runs/backups/, runs/_archived-*/) are PRUNED at the
// walk — never enumerated, never rendered — and only their size is reported
// (counts.archived_excluded), so a lane that disappears is explainable. The
// dashboard's per-run cards read this section; the browser never touches the
// filesystem.
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
// precedence: manifest.status.jsonl (the attempt records) → the grader's
// per-attempt reports → the cell's own live.jsonl. A field no artifact recorded
// is null — "not recorded" — never 0 and never derived.
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
// batch.json) without calling it — one read of each, never two. Campaigns the
// run state does not name are found by walking the LIVE root only
// (tree.listLiveCampaignDirs, whose walk skips runs/backups/) and their cells by
// tree.listCellDirs; a cell the state path already emitted is skipped, so every
// (run_dir, sequence_index) appears exactly once.
//
// Archive roots are pruned, not filtered: no cell under runs/backups/ or
// runs/_archived-*/ is ever read or emitted. lib/run-class.mjs is the single
// decider — isArchivePath is the second gate for roots tree.mjs does not know.
// Their size is counts.archived_excluded: one per archived campaign home (the
// run dirs the pre-prune board built cards from; it emitted a card per CELL and
// a campaign's cells share a home, so the old card count can sit a few above).
//
// Sort: the run's tree id DESCENDING (a tree campaign = its leading tree id, a
// legacy flat campaign = the active pointer's), then sequence_index ASCENDING.

import { dirname, join, relative, sep } from "node:path";
import { readdir, readFile } from "node:fs/promises";

import { int, str } from "../contract.mjs";
import { classifyRun, isArchivePath } from "../lib/run-class.mjs";
import {
  parseJsonl,
  readTextCapped,
  readJson,
  statOrNull,
  cellLiveStreamPath,
  activeTreeId,
  isTreeId,
  LIVE_STREAM_FILENAME,
} from "./_runtime.mjs";
import { readV2Cost } from "./cost.mjs";
import { readRunState } from "../../runstate.mjs";
import { readBatch } from "../../batch.mjs";
import { listCampaignDirs, listCellDirs, listLiveCampaignDirs } from "../../tree.mjs";

export const id = "runs";
export const fields = ["runs"];
export function describe() {
  return "one card per run — every cell of the live tree, newest tree first; archive roots are pruned";
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
 * The identity-based fixed/broke delta between a cell's FIRST and LAST attempt.
 * Counts hide swaps — a run that fixes 3 gates and breaks 3 reads "53 → 53" —
 * so this diffs the failing gate IDENTITIES, not their number: fixed = failed
 * in first but not last (green), broke = failed in last but not first (red).
 * The key is `gate_results[].id` — the roster id (bare token when unique, else
 * the full slug), byte-identical to the live stream's gate key. NEVER the
 * `failed_gates` titles: parseGate's bare tokens collide (run 1791151982 lists
 * three distinct [G10] REQ-WINCLASS tests that all fold to "G10"), and
 * conformance titles live in a different id space. Conservative: null unless
 * BOTH compared attempts state a usable gate_results array — fewer than two
 * attempts with one compute nothing. Returns { fixed, broke } or null.
 */
export function attemptDelta(recs) {
  const byAttempt = new Map();
  for (const r of recs ?? []) {
    const attempt = int(r?.attempt);
    if (attempt === null || !Array.isArray(r?.gate_results)) continue;
    const failed = new Set();
    for (const gr of r.gate_results) {
      if (gr?.status === "fail") failed.add(String(gr.id));
    }
    byAttempt.set(attempt, failed); // append-only stream: last stated wins
  }
  if (byAttempt.size < 2) return null;
  const attempts = [...byAttempt.keys()].sort((a, b) => a - b);
  const first = byAttempt.get(attempts[0]);
  const last = byAttempt.get(attempts[attempts.length - 1]);
  let fixed = 0;
  let broke = 0;
  for (const id of first) if (!last.has(id)) fixed += 1;
  for (const id of last) if (!first.has(id)) broke += 1;
  return { fixed, broke };
}

/**
 * Fold one cell's attempt records into the fields a card reads. Cumulative
 * fields (progress.*) take the LAST stated value — the terminal attempt's
 * progress is the cell's final progress. Cell-level counters
 * (guard_aborted_turns, stalled_turns, cap_cutoffs) are copied to every
 * attempt row, so last stated = the value. context_peak is PER ATTEMPT: the
 * run's peak is the highest peak stated, never the last attempt's.
 * problems_fixed/problems_broke are NOT cumulative — they are the identity
 * delta (attemptDelta) between the first and last attempt's failed-gate sets.
 * A field no record states stays null.
 */
function foldManifest(recs) {
  const out = {
    turns: null,
    problems_before: null,
    problems_after: null,
    problems_fixed: null,
    problems_broke: null,
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
  const delta = attemptDelta(recs);
  if (delta !== null) {
    out.problems_fixed = delta.fixed;
    out.problems_broke = delta.broke;
  }
  return out;
}

// ── the read ─────────────────────────────────────────────────────────────────

async function memo(cache, key, make) {
  if (!cache.has(key)) cache.set(key, await make());
  return cache.get(key);
}

/** The identity a card is keyed by everywhere: one card per cell. */
function cellKey(base) {
  return `${base.run_dir ?? ""}::${base.sequence_index ?? ""}`;
}

/**
 * How many run entries the board excluded because their path is under an
 * archive root. Unit: archived campaign HOMES — a directory bearing a manifest,
 * i.e. the run dirs the pre-prune board built cards from. That board emitted one
 * card per CELL and a campaign's cells share one home, so the old card count can
 * sit a few above this. Directory walk only: no artifact is read and no card is
 * built from these dirs. 0 when the walk finds nothing, never an invented count.
 */
async function countArchivedCampaigns(runsRoot) {
  try {
    const all = await listCampaignDirs(runsRoot, { includeBackups: true });
    return all.filter((c) => isArchivePath(c.relative)).length;
  } catch {
    return 0;
  }
}

/**
 * The play-able pair for a LIVE cell — the same {benchmark_id, cell} shape
 * history.listRunCells emits (a shared wire shape, not a call: this source
 * reads the live root directly), derived from the cell's on-disk stream path
 * (no second scan): the first segment relative to runsRoot is the resolvable
 * benchmark_id, the rest is the cell. Both null when the cell has no stream.
 */
function livePlayPair(runsRoot, livePath) {
  if (!livePath) return { benchmark_id: null, cell: null };
  const segs = relative(runsRoot, livePath).split(sep).slice(0, -1);
  return {
    benchmark_id: segs[0] ?? null,
    cell: segs.length > 1 ? segs.slice(1).join(sep) : null,
  };
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
  const batchByIndex = new Map();
  for (const r of batch?.runs ?? []) {
    if (Number.isFinite(r?.sequence_index)) batchByIndex.set(r.sequence_index, r);
  }

  const seen = new Set();
  for (const r of live) {
    const idx = r.sequence_index;
    if (idx !== null && idx !== undefined) seen.add(idx);
    const livePath = await cellLiveStreamPath(ctx.runsRoot, { run_dir: r.run_dir ?? null, sequence_index: idx ?? null });
    const play = livePlayPair(ctx.runsRoot, livePath);
    bases.push({
      sequence_index: idx ?? null,
      run_dir: r.run_dir ?? null,
      benchmark_id: play.benchmark_id,
      cell: play.cell,
      model: r.model ?? null,
      arm: r.arm ?? null,
      running: true,
      sort_key: null, // filled below, once the active tree id is known
      live_path: livePath,
    });
  }
  for (const [idx] of batchByIndex) {
    if (seen.has(idx)) continue;
    const e = endedByIndex.get(idx);
    const livePath = await cellLiveStreamPath(ctx.runsRoot, { run_dir: e?.run_dir ?? runDir, sequence_index: idx });
    const play = livePlayPair(ctx.runsRoot, livePath);
    bases.push({
      sequence_index: idx,
      run_dir: e?.run_dir ?? runDir,
      benchmark_id: play.benchmark_id,
      cell: play.cell,
      model: e?.model ?? null,
      arm: e?.arm ?? "off",
      running: false,
      sort_key: null,
      live_path: livePath,
    });
  }
  for (const e of ended) {
    const idx = e?.sequence_index;
    if (!Number.isFinite(idx)) continue;
    if (seen.has(idx) || batchByIndex.has(idx)) continue;
    const livePath = await cellLiveStreamPath(ctx.runsRoot, { run_dir: e.run_dir ?? runDir, sequence_index: idx });
    const play = livePlayPair(ctx.runsRoot, livePath);
    bases.push({
      sequence_index: idx,
      run_dir: e.run_dir ?? runDir,
      benchmark_id: play.benchmark_id,
      cell: play.cell,
      model: e.model ?? null,
      arm: e.arm ?? "off",
      running: false,
      sort_key: null,
      live_path: livePath,
    });
    seen.add(idx);
  }

  // ── LIVE-ROOT CAMPAIGNS ── every campaign the run state did not name, from
  // the PRUNED walk: tree.listLiveCampaignDirs skips runs/backups/ at the
  // readdir, so an archive is never enumerated and no archived cell is read. A
  // cell the state path already emitted (it carries the launch record's model
  // and arm) is skipped, never overwritten.
  const emitted = new Set(bases.map(cellKey));
  let campaigns = [];
  try {
    campaigns = await listLiveCampaignDirs(ctx.runsRoot);
  } catch {
    campaigns = [];
  }
  for (const campaign of campaigns) {
    // The classifier's second gate: an archive root tree.mjs does not know
    // about (runs/_archived-<date>/) never becomes a card either.
    if (isArchivePath(campaign.relative)) continue;
    let cells = [];
    try {
      cells = await listCellDirs(campaign.dir);
    } catch {
      continue; // the campaign vanished between the listing and the read
    }
    const relParts = campaign.relative.split(sep);
    const campaignRoot = join(ctx.runsRoot, campaign.relative);
    for (const cell of cells) {
      if (emitted.has(`${campaign.relative}::${cell.seq}`)) continue;
      emitted.add(`${campaign.relative}::${cell.seq}`);
      // `cell` is the resolvable pair half: relative to the benchmark root (the
      // campaign path's first segment), the same shape livePlayPair emits.
      bases.push({
        sequence_index: cell.seq,
        run_dir: campaign.relative,
        benchmark_id: relParts[0] ?? null,
        cell: [...relParts.slice(1), ...relative(campaignRoot, cell.dir).split(sep)].join("/"),
        model: null,
        arm: cell.arm,
        running: false,
        sort_key: null,
        live_path: join(cell.dir, LIVE_STREAM_FILENAME),
      });
    }
  }

  // The state path can name a run that has since been archived (a launch record
  // outlives its tree). Its path is the fact: it is never rendered. Nothing is
  // counted here — archived_excluded is the archive root's own size.
  const visible = bases.filter((b) => !isArchivePath(b.run_dir));

  // Cards sort by their own tree: the run_dir's leading segment when it is a
  // tree id, else the active pointer's (a legacy flat campaign belongs to the
  // era the pointer names).
  const activeId = Number(await activeTreeId(ctx.runsRoot)) || 0;
  for (const b of visible) {
    const head = String(b.run_dir ?? "").split("/")[0];
    b.sort_key = isTreeId(head) ? Number(head) : activeId;
  }

  // ── CARD FIELDS ── per-cell artifacts, memoized per run_dir for this call
  // only (a per-call memo cannot go stale; nothing is cached across polls).
  const manifestCache = new Map();
  const scorecardCache = new Map();
  // A card's run-level manifest.json is read once per run_dir: the cells of one
  // campaign share it, and `system_epoch`/`class` are properties of the run.
  const runManifestCache = new Map();
  const cards = [];
  for (const b of visible) {
    const modelDir = b.run_dir ? join(ctx.runsRoot, b.run_dir) : null;

    let man = null;
    if (modelDir && b.sequence_index !== null) {
      const by = await memo(manifestCache, b.run_dir, () => manifestBySeq(modelDir));
      const recs = by.get(b.sequence_index);
      man = recs?.length ? foldManifest(recs) : null;
    }

    const stream = await readCellStream(b.live_path);

    // A run that aborted before its status stream was written (run 1790202713,
    // harness_error) still has the grader's own per-attempt reports beside its
    // stream: the problem counts they state, first and last MEASURED attempt.
    const graded = man ? null : await gradedCounts(b.live_path);

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
    // The cell's own peak, stated on cell.end: a last round that never reached
    // grading counts (1790258326 ran out of room at 256,688 after its last
    // attempt.end said 192,334).
    const endPeak = int(stream?.cell_end?.context_peak);
    if (endPeak !== null) {
      contextPeak = contextPeak === null ? endPeak : Math.max(contextPeak, endPeak);
      contextWindow = contextWindow ?? int(stream.cell_end.context_window);
    }

    // The run's declared system epoch and the cell's v2 cost stamp. Both are
    // read from artifacts the card's own identity names: manifest.json in the
    // MODEL dir (b.run_dir, relative to runsRoot; deduped per poll) and the cell
    // dir the card's live path already points into (the same slice gradedCounts
    // takes). Absent either is null — a v1 cost stamp is not this contract, and
    // a run that never declared an epoch did not state one.
    const systemEpoch = b.run_dir
      ? await memo(runManifestCache, b.run_dir, async () =>
          (await readJson(join(ctx.runsRoot, b.run_dir, "manifest.json")))?.system_epoch ?? null,
        )
      : null;
    const cellDir = b.live_path ? dirname(b.live_path) : null;
    const cost = await readV2Cost(cellDir);
    const epoch = str(systemEpoch);

    cards.push({
      sort_key: b.sort_key,
      card: {
        run_dir: b.run_dir ?? null,
        sequence_index: b.sequence_index ?? null,
        benchmark_id: b.benchmark_id ?? null,
        cell: b.cell ?? null,
        archived: false,
        // The run's lane: "living" (v2 epoch) or "legacy" (declares none).
        // "archived" is unrepresentable here — archive roots are pruned at the
        // walk, which is what makes the lane disappear instead of shrinking.
        class: classifyRun({ relative: b.run_dir, systemEpoch: epoch }),
        model: b.model ?? man?.model ?? null,
        arm: b.arm ?? man?.arm ?? null,
        status,
        problems_before: man?.problems_before ?? graded?.first ?? null,
        problems_after: man?.problems_after ?? graded?.last ?? null,
        // Identity delta: only the manifest's attempt records carry gate
        // identities — the grader reports state counts alone, so that fallback
        // leaves these null ("not recorded").
        problems_fixed: man?.problems_fixed ?? null,
        problems_broke: man?.problems_broke ?? null,
        context_peak: contextPeak,
        context_window: contextWindow,
        turns: man?.turns ?? null,
        loop_errors: loopErrors,
        stalled_limit_errors: stalledLimit,
        system_epoch: epoch,
        cost,
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
          // The lanes of the emitted list. `living` is the v2 epoch (what the
          // default board view keeps), `legacy` the pre-v2 runs still on the
          // live root. Distinct from `live`, which is STATUS (a running process).
          living: list.filter((c) => c.class === "living").length,
          legacy: list.filter((c) => c.class === "legacy").length,
          // Not a card count: the archive roots' own size, so a vanished lane
          // is explained rather than silently gone.
          archived_excluded: await countArchivedCampaigns(ctx.runsRoot),
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
 * Scored is not passed: a failing cell is scored. The run's own
 * manifest.scorecard.json, current or archived, lists every cell dropped from
 * the scored set (void_instrument, not_scored); a cell it does not drop
 * scored. No scorecard = the run never published a measurement (it wrote one
 * only when a cell completed) = void. It used to count only a green or PASS
 * cell as scored, and a `conformed` attempt (the pre-gate passed) as scored —
 * run 1790200233, voided instrument_fault, showed SCORED. A CURRENT run read
 * the batch record instead — the BASELINES record, which marks every seeded
 * run not-scored because it is no floor — so seeded run 1790258326 read VOID
 * while current and SCORED once archived.
 */
async function isScored(base, modelDir, cache) {
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
