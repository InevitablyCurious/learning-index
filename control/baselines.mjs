// BASELINES — the one owner of "does model X have a floor, and which cell is it".
//
// One floor per model: the operator's SELECTED run from the model's persisted
// batch (<run_dir>/batch.json — median over the scored runs, fingerprint-bound).
// A single run is not a baseline; an unselected batch is "awaiting_selection".
// A model with a valid floor cannot start another baseline (re-baselining means
// archiving the run); a model without one always can. A void cell (it measured
// the harness, not the model) is no baseline.
//
// <runsRoot>/baselines.json is an export, never an input: every read re-derives
// from the run folders, and a failed write is reported in `stored`, not thrown.

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listLiveCampaignDirs } from "./tree.mjs";
import { readTail } from "./runstate.mjs";
import {
  CODE_INPUTS,
  hashDir,
  computeFingerprint,
  fingerprintVerdict,
  markVoid,
  assembleBatch,
  readBatch,
  writeBatch,
  selectRun,
} from "./batch.mjs";

/**
 * A short, stable id (`base-8d1e`) derived from run dir + cell index, never
 * stored, so it cannot drift from the cell it names.
 */
export function baselineId(runDir, sequenceIndex) {
  const h = createHash("sha256").update(`${runDir}::${sequenceIndex}`).digest("hex");
  return `base-${h.slice(0, 4)}`;
}

/**
 * Which model a cell measures, and whether it was local or cloud. The slug's
 * segment count decides: `{router}/{provider}/{model}` (cloud) is identified by
 * its last two segments. provider_pin cannot be used for cloud, where it is the
 * router.
 */
export function identifyCell(slot, manifest) {
  const slug = str(slot?.model) ?? str(manifest?.model) ?? null;
  const parts = slug ? slug.split("/").filter(Boolean) : [];

  if (parts.length >= 3) {
    const [router, provider, ...rest] = parts;
    return {
      id: `${provider}/${rest.join("/")}`,
      kind: "cloud",
      provider,
      router,
      slug,
    };
  }

  // Local: provider_pin is the bare bench alias, which matches the roster ids.
  const pin = str(slot?.provider_pin);
  const id = pin ?? (parts.length ? parts[parts.length - 1] : null);
  return {
    id,
    kind: "local",
    // The relay, only when the slug names one.
    provider: parts.length >= 2 ? parts[0] : null,
    router: null,
    slug,
  };
}

/**
 * An archived run (`<name>.<why>-<date>`) never supplies a baseline: the
 * operator set it aside on purpose.
 */
export function isArchivedRun(name) {
  return String(name ?? "").includes(".");
}

const OFF_ARM = "off";

/** A cell is five phases: 1 build + 4 grades (max_attempts 5). */
const PHASES_PER_CELL = 5;

/** The repo root (Learning-Index), resolved from this module — never hardcoded by callers. */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function readJsonlOrEmpty(path) {
  try {
    const text = await fs.readFile(path, "utf8");
    const out = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // A half-written last line is normal mid-run; skip it.
      }
    }
    return out;
  } catch {
    return [];
  }
}

const int = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
// int() maps null→0 (Number(null) === 0); a covariate that was NOT measured
// must stay null, never a fabricated 0 — so guard the null before coercing.
const measuredInt = (v) => (v == null ? null : int(v));
// A boolean that yields null when absent/non-boolean — never null→false.
const bool = (v) => (typeof v === "boolean" ? v : null);

/**
 * The gate tally an attempt record carries, or null when it has no total —
 * never a ratio invented from the failures alone.
 */
function gateTotals(r) {
  const g = r?.gate_totals;
  if (!g || typeof g !== "object") return null;
  const total = int(g.total);
  if (!total) return null;
  const passed = int(g.pass);
  const failed = int(g.fail);
  return {
    passed,
    failed,
    error: int(g.error),
    not_run: int(g.not_run),
    total,
  };
}

/**
 * The seven contention covariates, flat in each status record's `progress`
 * (written by the harness ProgressVector). VISIBILITY ONLY: they say what
 * conditions the cell was gathered under — they gate nothing, score nothing,
 * and are deliberately NOT fingerprint inputs (a crowded run is the same run).
 * Sticky per field across the attempt fold like every other measurement;
 * null means "not measured" (spend DB unavailable), never a coerced 0/false.
 */
function contentionOf(p, prev) {
  const c = prev ?? {};
  return {
    http_429_count: measuredInt(p.http_429_count) ?? c.http_429_count ?? null,
    http_402_count: measuredInt(p.http_402_count) ?? c.http_402_count ?? null,
    retry_count: measuredInt(p.retry_count) ?? c.retry_count ?? null,
    upstream_error_count: measuredInt(p.upstream_error_count) ?? c.upstream_error_count ?? null,
    max_request_ms: measuredInt(p.max_request_ms) ?? c.max_request_ms ?? null,
    median_request_ms: measuredInt(p.median_request_ms) ?? c.median_request_ms ?? null,
    wall_near_timeout: bool(p.wall_near_timeout) ?? c.wall_near_timeout ?? null,
  };
}

/**
 * Every OFF cell on disk, folded per model. Identity from the schedule,
 * measurement from the status stream, so a crashed cell still appears.
 */
export async function collectOffCells(runsRoot) {
  return (await collectCells(runsRoot)).filter((c) => c.arm === OFF_ARM);
}

/** Every cell on disk, both arms, folded by the same rules. */
export async function collectCells(runsRoot) {
  const cells = [];

  // Walks nested campaigns in the live tree (retired trees skipped).
  let entries = [];
  try {
    entries = await listLiveCampaignDirs(runsRoot);
  } catch {
    return cells;
  }

  for (const ent of entries) {
    if (isArchivedRun(ent.name)) continue;
    const dir = ent.dir;
    const manifest = await readJsonOrNull(join(dir, "manifest.json"));
    if (!manifest) continue;

    const schedule = Array.isArray(manifest.schedule) ? manifest.schedule : [];
    if (!schedule.length) continue;

    const status = await readJsonlOrEmpty(join(dir, "manifest.status.jsonl"));

    // Fold the status stream by sequence_index; the last record carries the outcome.
    const folded = new Map();
    for (const r of status) {
      if (r.type !== undefined && r.type !== "attempt") continue;
      const seq = int(r.sequence_index) ?? 0;
      const p = r.progress ?? {};
      const prev = folded.get(seq) ?? {};
      // Phases = distinct attempt numbers actually recorded.
      const attempts = new Set(prev.attempts ?? []);
      const attemptNo = int(r.attempt);
      if (attemptNo !== null) attempts.add(attemptNo);
      // Failures per attempt: the repair trajectory (27 -> 28 -> 27 -> 26 -> 24).
      // The last record for an attempt wins; an attempt with no gate total is absent.
      const attemptFailed = new Map(prev.attemptFailed ?? []);
      const g = gateTotals(r);
      if (attemptNo !== null && g && Number.isInteger(g.failed)) attemptFailed.set(attemptNo, g.failed);
      folded.set(seq, {
        attempts,
        attemptFailed,
        verdict: str(r.verdict) ?? prev.verdict ?? null,
        turns: int(p.turns) ?? prev.turns ?? null,
        tokens: int(p.total_tokens) ?? int(p.tokens) ?? prev.tokens ?? null,
        problems_before: int(p.problems_before) ?? prev.problems_before ?? null,
        wall_seconds: int(p.wall_seconds) ?? prev.wall_seconds ?? null,
        // Contention covariates: visibility only, never a gate (contentionOf).
        contention: contentionOf(p, prev.contention),
        // Build chunks exist only on attempt 1: keep the first non-empty list.
        build_chunks: (Array.isArray(p.build_chunks) && p.build_chunks.length)
          ? p.build_chunks
          : (prev.build_chunks ?? null),
        // Gates: the last attempt's totals (a cell's correctness is where it ended).
        // Null without a real total rather than a denominator made of observed failures.
        gates: gateTotals(r) ?? prev.gates ?? null,
        terminal_reason: str(r.terminal_reason) ?? prev.terminal_reason ?? null,
        // Seeded is sticky: a later record without it must not un-seed the cell.
        seeded_from_snapshot: str(r.seeded_from_snapshot) ?? prev.seeded_from_snapshot ?? null,
        // Summed across attempts (a truncation in any attempt taints the cell). These
        // fields sit on the record itself, not under `progress`.
        truncated_turns: (prev.truncated_turns ?? 0) + (int(r.truncated_turns) ?? 0),
        // Unrecovered anomalies — the one the void check reads. Summed the same way.
        unrecovered_anomaly_turns:
          (prev.unrecovered_anomaly_turns ?? 0) + (int(r.unrecovered_anomaly_turns) ?? 0),
        provider_truncations: (prev.provider_truncations ?? 0) + (int(r.provider_truncations) ?? 0),
        // Green only if it actually passed.
        full_green: str(r.verdict) === "PASS" || prev.full_green === true,
      });
    }

    for (let i = 0; i < schedule.length; i += 1) {
      const slot = schedule[i] ?? {};

      // The harness writes `memory_mode`; the wrong key silently yields no OFF cells.
      const arm = str(slot.memory_mode) ?? str(slot.mode) ?? str(slot.arm);

      const seq = int(slot.sequence_index) ?? i;
      const meas = folded.get(seq) ?? null;

      // See identifyCell().
      const who = identifyCell(slot, manifest);
      const model = who.id;

      // Void instrument (RUNBOOK 5.10): a non-green ending with an unrecovered
      // provider-side anomaly, or a harness_error. Same rule as stack-ledger.mjs and
      // run_artifacts.py. attempt_ceiling_reached is a real result, not void. Reads
      // unrecovered_anomaly_turns: a loop the harness recovered is model behaviour.
      const voidInstrument = Boolean(
        meas
        && !meas.full_green
        && (meas.terminal_reason === "transport_incomplete"
          || meas.terminal_reason === "harness_error"
          // Grading measured nothing twice on the same code: the instrument's.
          || meas.terminal_reason === "instrument_fault"
          || (meas.provider_truncations ?? 0) > 0
          || (meas.unrecovered_anomaly_turns ?? 0) > 0),
      );

      // What the cell recorded it ran on, at its start (harness/fingerprint.py);
      // null for a cell that recorded nothing.
      const cellDir = join(dir, `memory${String(arm ?? "unknown").toUpperCase()}`, `cell-${String(seq).padStart(4, "0")}`);
      const fingerprint = await readCellFingerprint(cellDir);
      // A cell with no attempt record may still have RUN: it died before its
      // first graded attempt (e.g. IncompleteBuildError in the build). The
      // harness records how it ended on its own stream (cell.end); read that
      // rather than calling a four-hour cell "not_started".
      const ended = meas ? null : await readCellEnd(cellDir);

      cells.push({
        id: baselineId(ent.relative, seq),
        run_dir: ent.relative,
        sequence_index: seq,
        model,
        // Local or cloud, and who served it, from the manifest.
        kind: who.kind,
        provider: who.provider,
        router: who.router,
        model_slug: who.slug,
        arm,
        // complete: graded · ended: ran and stopped before a graded attempt ·
        // started: began, no end recorded yet · not_started: never began.
        state: meas ? "complete" : ended ? "ended" : fingerprint ? "started" : "not_started",
        void_instrument: voidInstrument,
        // Seeded cells skip the build, so they are never a scorable floor.
        seeded_from_snapshot: meas?.seeded_from_snapshot ?? null,
        // Capped at five phases.
        phases: { done: meas ? Math.min(meas.attempts.size, PHASES_PER_CELL) : 0, total: PHASES_PER_CELL },
        verdict: meas?.verdict ?? null,
        turns: meas?.turns ?? null,
        tokens: meas?.tokens ?? null,
        problems_before: meas?.problems_before ?? null,
        wall_seconds: meas?.wall_seconds ?? null,
        // The cell's seven contention covariates (null when never measured).
        contention: meas?.contention ?? null,
        gates: meas?.gates ?? null,
        // null means no data, never "every chunk incomplete".
        build_chunks: meas?.build_chunks ?? null,
        // Failed gates per graded attempt, in attempt order ([] = none graded).
        attempt_failures: meas
          ? [...meas.attemptFailed.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n)
          : [],
        terminal_reason: meas?.terminal_reason ?? ended?.terminal_reason ?? null,
        // The exception a harness_error ended on (cell.end), when there was one.
        terminal_exception: ended?.terminal_exception ?? null,
        // Out of context room: a result, not an instrument fault.
        context_exhausted: meas?.terminal_reason === "context_exhausted",
        created_at: str(manifest.created_at),
        fingerprint,
      });
    }
  }

  return cells;
}

/**
 * How a cell ended, from the last cell.end on its own live.jsonl
 * (harness/live_stream.py), or null when it recorded no end. The tail is
 * enough: cell.end is the stream's last word.
 */
async function readCellEnd(cellDir) {
  const tail = await readTail(join(cellDir, "live.jsonl"));
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"cell.end"')) continue;
    try {
      const rec = JSON.parse(lines[i]);
      if (rec?.kind !== "cell.end") continue;
      return { terminal_reason: str(rec.terminal_reason), terminal_exception: str(rec.terminal_exception) };
    } catch {
      continue;
    }
  }
  return null;
}

/** A cell's recorded fingerprint values (harness/fingerprint.py), or null. */
async function readCellFingerprint(cellDir) {
  const rec = await readJsonOrNull(join(cellDir, "fingerprint.json"));
  return rec?.values && typeof rec.values === "object" ? rec.values : null;
}

const execFileP = promisify(execFile);
const WORKER_IMAGE_TAG = "bench-worker:v1";

/**
 * The CODE inputs as they stand now: the four directory hashes over the
 * measured repo (harness/fingerprint.py hashes them the same way at a cell's
 * start) and the worker image docker holds under the bench tag. Throws when
 * the image cannot be read: a batch that cannot be checked is not called
 * current.
 */
export async function currentCodeInputs({ repoRoot = REPO_ROOT } = {}) {
  const [chunk_plan_hash, grader_hash, scaffold_hash, golden_hash, image] = await Promise.all([
    hashDir(path.join(repoRoot, "task", "backgammon", "prompts")),
    hashDir(path.join(repoRoot, "grader"), {
      exclude: new Set(["node_modules", ".git", "test-results"]),
    }),
    hashDir(path.join(repoRoot, "task", "backgammon", "scaffold")),
    hashDir(path.join(repoRoot, "task", "backgammon", "golden")),
    execFileP("docker", ["image", "inspect", WORKER_IMAGE_TAG, "--format", "{{.Id}}\n{{.Created}}"]),
  ]);
  const [image_id, created] = String(image.stdout).trim().split("\n");
  if (!image_id || !created) throw new Error(`docker did not identify ${WORKER_IMAGE_TAG}`);
  return { chunk_plan_hash, grader_hash, scaffold_hash, golden_hash, worker_image: { image_id, created } };
}

/**
 * Where "the code as it stands now" comes from. The default reads the repo and
 * docker; tests replace it (setCodeInputsProvider) so they depend on neither.
 */
let codeInputsProvider = currentCodeInputs;
export function setCodeInputsProvider(fn) {
  codeInputsProvider = typeof fn === "function" ? fn : currentCodeInputs;
}

/** One read of the current code per index build, and only if a batch needs it. */
function currentGetter(repoRoot) {
  let pending = null;
  return () => (pending ??= codeInputsProvider({ repoRoot }));
}

const seqName = (c) => `s${String(c.sequence_index).padStart(4, "0")}`;

/**
 * A batch's fingerprint, from what its cells RECORDED — never from the repo.
 *   recorded         every cell that ran recorded the same inputs
 *   unfingerprinted  a cell ran without recording (ran before recording existed)
 *   mixed            its cells ran on different inputs; names the first one
 *   pending          nothing has recorded yet (no cell has started)
 */
export function batchFingerprintOf(cells) {
  const ran = cells.filter((c) => c.state === "complete" || c.fingerprint);
  const missing = ran.filter((c) => !c.fingerprint);
  if (missing.length) {
    return {
      status: "unfingerprinted",
      fingerprint: null,
      void_input: null,
      void_reason: `${missing.map(seqName).join(", ")} recorded nothing about what ${missing.length === 1 ? "it" : "they"} ran on — there is nothing to bind this batch to`,
    };
  }
  const recorded = cells.filter((c) => c.fingerprint);
  if (!recorded.length) return { status: "pending", fingerprint: null, void_input: null, void_reason: null };
  let fingerprint;
  try {
    fingerprint = computeFingerprint(recorded[0].fingerprint);
  } catch (err) {
    return {
      status: "unfingerprinted",
      fingerprint: null,
      void_input: null,
      void_reason: `${seqName(recorded[0])}'s record is incomplete — ${err.message}`,
    };
  }
  for (const c of recorded.slice(1)) {
    const v = fingerprintVerdict(fingerprint, c.fingerprint);
    if (!v.valid) {
      return {
        status: "mixed",
        fingerprint: null,
        void_input: v.changedInput,
        void_reason: `${seqName(recorded[0])} and ${seqName(c)} ran on different ${v.changedInput} — ${v.changedReason}`,
      };
    }
  }
  return { status: "recorded", fingerprint, void_input: null, void_reason: null };
}

/**
 * Does this persisted batch disagree with the cells now on disk?
 *
 * Stale means the record marks a run unscored while that cell has since
 * produced a measurement. That is the mid-flight case: a batch assembled when
 * the first of N cells finished, with the rest frozen as `not_started`.
 *
 * NOT stale merely because the numbers differ — a run's problem count does not
 * change after it ends, and re-assembling on every read would fight the
 * operator's selection for no reason. Only the appearance of a measurement
 * where the record claims none counts.
 */
export function batchIsStale(batch, cells) {
  const byIndex = new Map(cells.map((c) => [c.sequence_index, c]));
  for (const run of batch?.runs ?? []) {
    if (run?.scored === true) continue;
    const cell = byIndex.get(run?.sequence_index);
    if (!cell) continue;
    const measured =
      cell.state === "complete"
      && !cell.void_instrument
      && !cell.seeded_from_snapshot
      && !(cell.context_exhausted === true && !cell.gates);
    if (measured) return true;
  }
  // A cell that exists and is not in the record at all is also missing data.
  const known = new Set((batch?.runs ?? []).map((r) => r?.sequence_index));
  if (cells.some((c) => !known.has(c.sequence_index))) return true;
  // A record whose fingerprint is not what its cells RECORDED is stale too —
  // including one written before cells recorded anything, whose fingerprint
  // was hashed from the repo when it was assembled.
  const fp = batchFingerprintOf(cells);
  if (fp.status === "recorded") return batch?.fingerprint?.hash !== fp.fingerprint.hash;
  if (fp.status === "pending") return false;
  return batch?.void_kind !== fp.status
    || batch?.void_input !== fp.void_input
    || batch?.void_reason !== fp.void_reason;
}

/**
 * Re-assemble a batch from the cells as they now stand, keeping the operator's
 * pick if that run is still scored.
 *
 * The selection is the operator's; the numbers around it are the disk's. A
 * pick that is no longer scored is dropped rather than carried — a floor must
 * never point at a run the batch does not consider measured.
 */
export async function reassemblePreservingSelection({ repoRoot = REPO_ROOT, runDir, cells, persisted = null, current = null }) {
  const fresh = await assembleBatchForCells({ repoRoot, runDir, cells, current });
  const pick = persisted?.selection?.sequence_index;
  if (pick === undefined || pick === null) return fresh;
  const stillScored = (fresh.runs ?? []).some(
    (r) => r.sequence_index === pick && r.scored === true,
  );
  if (!stillScored) return fresh;
  selectRun(fresh, pick);
  await writeBatch(runDir, fresh);
  return fresh;
}

export async function assembleBatchForCells({ repoRoot = REPO_ROOT, runDir, cells, current = null }) {
  // The same scorability rule baselineFor applies: complete, not void-instrument,
  // not seeded, and not out of context before anything was graded.
  const scored = (c) => c.state === "complete" && !c.void_instrument && !c.seeded_from_snapshot && !(c.context_exhausted === true && !c.gates);
  const voidReason = (c) => c.context_exhausted === true && !c.gates ? "context_exhausted"
    : c.seeded_from_snapshot ? "seeded_from_snapshot"
      : c.void_instrument ? (c.terminal_reason === "instrument_fault" ? "instrument_fault" : "void_instrument")
        : c.state !== "complete" ? (c.terminal_exception ?? c.terminal_reason ?? c.state ?? "incomplete")
          : "no_measurement";
  const runs = cells.map((c) => ({
    sequence_index: c.sequence_index,
    problem_count: scored(c) ? c.problems_before : null,
    scored: scored(c),
    void_reason: scored(c) ? null : voidReason(c),
    // Rides along for visibility (batch.runs[].contention); never scored on.
    contention: c.contention ?? null,
  }));
  const fp = batchFingerprintOf(cells);
  const batch = assembleBatch({ runDir, runs, fingerprint: fp.fingerprint });
  if (fp.status === "unfingerprinted" || fp.status === "mixed") {
    markVoid(batch, fp.status, fp.void_input, fp.void_reason);
  } else {
    await verifyAgainstCurrentCode(batch, { repoRoot, current });
  }
  await writeBatch(runDir, batch);
  return batch;
}

/**
 * Compare a batch's RECORDED fingerprint with the code as it stands now, on
 * the CODE inputs only. A difference voids the batch as superseded, naming
 * the first changed input. Mutates the batch; returns whether it changed.
 * An already-void batch is left as it is. `current` is the code-inputs map or
 * a getter for it; the default asks codeInputsProvider.
 */
export async function verifyAgainstCurrentCode(batch, { repoRoot = REPO_ROOT, current = null } = {}) {
  if (batch.void === true || !batch.fingerprint?.values) return false;
  const currentInputs = typeof current === "function"
    ? await current()
    : (current ?? (await codeInputsProvider({ repoRoot })));
  const code = {};
  for (const name of CODE_INPUTS) code[name] = currentInputs[name];
  const verdict = fingerprintVerdict(batch.fingerprint, { ...batch.fingerprint.values, ...code });
  if (verdict.valid) return false;
  markVoid(
    batch,
    "superseded",
    verdict.changedInput,
    `${verdict.changedInput} changed since this batch ran — ${verdict.changedReason}`,
  );
  return true;
}

/**
 * Read the batch for a runs-root-RELATIVE run_dir and check it against the
 * current code. A batch the check voids is persisted void right here — the
 * record must not keep claiming a validity it lost. No batch is {ok:false}:
 * this path never assembles one (assembly needs the cells, which only
 * baselineFor has).
 */
export async function readBatchForRunDir({ runsRoot, runDir, repoRoot = REPO_ROOT }) {
  const abs = join(runsRoot, runDir);
  const batch = await readBatch(abs);
  if (!batch) return { ok: false, error: "no batch for run_dir" };
  if (await verifyAgainstCurrentCode(batch, { repoRoot })) await writeBatch(abs, batch);
  return { ok: true, batch };
}

/**
 * What the BASELINES row shows inside a batch: every cell of it with its own
 * numbers, the median and the spread of the scored problem counts, and the
 * operator's pick with its distance from the median.
 *
 * The problem count and the scored/void verdict come from the batch record
 * (batch.mjs) — the same numbers the median is taken over — never re-derived.
 * With no batch record yet (a batch still running) the cells come from disk
 * alone and carry no verdict. Voids are listed, never dropped: a batch that
 * hid its failures would present fewer samples with the confidence of more.
 */
export function batchView(cells, batch) {
  const median = Number.isFinite(batch?.median) ? batch.median : null;
  const runs = new Map((batch?.runs ?? []).map((r) => [r.sequence_index, r]));
  const scoredCounts = (batch?.runs ?? [])
    .filter((r) => r.scored === true && Number.isFinite(r.problem_count))
    .map((r) => r.problem_count);
  const pickIdx = Number.isInteger(batch?.selection?.sequence_index) ? batch.selection.sequence_index : null;

  const list = [...cells]
    .sort((a, b) => a.sequence_index - b.sequence_index)
    .map((c) => {
      const r = runs.get(c.sequence_index) ?? null;
      const problems = r ? (Number.isFinite(r.problem_count) ? r.problem_count : null) : null;
      return {
        sequence_index: c.sequence_index,
        state: c.state,
        scored: r ? r.scored === true : null,
        void_reason: r?.void_reason ?? null,
        problems,
        vs_median: r?.scored === true && median !== null && problems !== null ? problems - median : null,
        picked: pickIdx === c.sequence_index,
        turns: c.turns ?? null,
        tokens: c.tokens ?? null,
        wall_seconds: c.wall_seconds ?? null,
        gates: c.gates ?? null,
        verdict: c.verdict ?? null,
        terminal_reason: c.terminal_reason ?? null,
        context_exhausted: c.context_exhausted === true,
        attempt_failures: c.attempt_failures ?? [],
      };
    });

  const picked = list.find((c) => c.picked) ?? null;
  return {
    median,
    spread: scoredCounts.length ? { min: Math.min(...scoredCounts), max: Math.max(...scoredCounts) } : null,
    scored_count: batch ? (batch.scored_count ?? scoredCounts.length) : 0,
    void_count: batch ? (batch.void_count ?? 0) : 0,
    cells: list,
    // The floor: which cell, its signed deviation as stored with the pick, and
    // that deviation as a share of the median (null when the median is 0).
    pick: picked
      ? {
          sequence_index: picked.sequence_index,
          problems: picked.problems,
          signed_deviation: batch.selection.signed_deviation ?? null,
          pct_from_median: median ? Math.round(((picked.problems - median) / median) * 1000) / 10 : null,
        }
      : null,
  };
}

/**
 * The baseline for one model: the operator's SELECTED run from the model's
 * persisted batch — never an arbitrary pick. A single run is not a baseline;
 * the batch (<runsRoot>/<run_dir>/batch.json: median problem count over the
 * SCORED runs, fingerprint-bound) plus the operator's selection is. Without a
 * selection there is no floor yet (reason "awaiting_selection"); the standing
 * refusals (seeded, void, exhausted, pending, never-run) are unchanged. The
 * batch is assembled on first read and never rewritten here, so a persisted
 * selection survives every derivation; a selection is never fabricated.
 */
export async function baselineFor(model, offCells, { repoRoot = REPO_ROOT, runsRoot = null, current = currentGetter(repoRoot) } = {}) {
  const mine = offCells.filter((c) => c.model === model);
  // Out of room with nothing graded is not a floor.
  const exhaustedUngraded = (c) => c.context_exhausted === true && !c.gates;
  const scorable = mine.filter(
    (c) => c.state === "complete" && !c.void_instrument && !c.seeded_from_snapshot && !exhaustedUngraded(c),
  );
  const exhausted = mine.filter(
    (c) => c.state === "complete" && !c.void_instrument && !c.seeded_from_snapshot && exhaustedUngraded(c),
  );
  const seeded = mine.filter((c) => c.state === "complete" && Boolean(c.seeded_from_snapshot));
  // Void: graded but measuring the harness, or ended before any graded attempt.
  const voids = mine.filter((c) => (c.state === "complete" && c.void_instrument) || c.state === "ended");
  // Still to finish: not begun, or begun with no end recorded. A cell that
  // ENDED without a graded attempt is not running — it is a void result.
  const running = mine.filter((c) => c.state === "not_started" || c.state === "started");

  if (scorable.length) {
    // The batch is per campaign run dir, and a campaign schedules ONE model —
    // the primary case is every cell of the model sharing one run_dir, so that
    // dir's batch is the model's batch. run_dir is runs-root-relative
    // (tree.mjs), so it resolves against runsRoot — never against the cwd.
    const relDir = mine[0].run_dir;
    if (!runsRoot) {
      throw new Error(
        `baselineFor(${model}): runsRoot is required to resolve the batch at run_dir '${relDir}'`,
      );
    }
    const runDir = join(runsRoot, relDir);
    // One batch per run dir: this dir's batch is assembled from this dir's
    // cells (identical to `mine` in the single-dir case).
    const batchCells = mine.filter((c) => c.run_dir === relDir);
    // An existing batch is the operator's record — read it, and assemble ONLY
    // when absent: re-assembling would wipe a persisted selection.
    //
    // ── BUT A BATCH ASSEMBLED MID-FLIGHT IS NOT A RECORD, IT IS A SNAPSHOT ──
    //
    // Measured on the first concurrent batch: four cells launched, the first
    // finished at 23:05:38, and batch.json was written two seconds later with
    // the other three frozen as `not_started`. They finished at 23:45 and
    // 00:04. Nothing ever refreshed it, so the median read 23 — one sample —
    // when the set was 24, 22 and 18. Every concurrent batch would have
    // reported the first cell to finish as though it were the whole batch.
    //
    // So a batch is STALE when the cells on disk now carry measurements it
    // does not. Re-assemble from the current cells and carry the operator's
    // selection across if that run is still scored — the selection is theirs
    // to keep; the numbers around it are not theirs to freeze.
    const persisted = await readBatch(runDir);
    const batch = persisted && !batchIsStale(persisted, batchCells)
      ? persisted
      : await reassemblePreservingSelection({ repoRoot, runDir, cells: batchCells, persisted, current });
    // Every read checks the recorded fingerprint against the code as it is
    // now: a batch the code has moved past is void, and says which input.
    if (await verifyAgainstCurrentCode(batch, { repoRoot, current })) await writeBatch(runDir, batch);

    // A fingerprint-void batch is never a floor: its numbers measured a
    // different grader/prompts/scaffold/golden/image than the current one, so
    // every Δ against them would be invalid — even a persisted selection does
    // not rescue it. Name the changed input; never quietly reuse stale
    // numbers. (The void is detected + persisted by readBatchForRunDir; a
    // freshly assembled batch is fingerprinted from the current inputs and so
    // is never void here.)
    if (batch.void === true) {
      const rep = mine[0];
      return {
        exists: false,
        scorable: false,
        voided: true,
        id: rep.id,
        run_dir: rep.run_dir,
        sequence_index: rep.sequence_index,
        kind: rep.kind,
        provider: rep.provider,
        model_slug: rep.model_slug,
        candidates: batch.scored_count,
        median: batch.median,
        void_kind: batch.void_kind ?? null,
        void_input: batch.void_input,
        void_reason: batch.void_reason ?? null,
        batch: batchView(batchCells, batch),
        reason: "batch_void",
      };
    }

    if (batch.selection) {
      const sel = batchCells.find((c) => c.sequence_index === batch.selection.sequence_index);
      if (!sel) {
        throw new Error(
          `baselineFor(${model}): the batch selection names sequence_index `
          + `${batch.selection.sequence_index}, which no OFF cell of ${relDir} matches — `
          + "the persisted batch and the cells on disk disagree",
        );
      }
      return {
        exists: true,
        scorable: true,
        id: sel.id,
        run_dir: sel.run_dir,
        sequence_index: sel.sequence_index,
        // The floor's MEASUREMENT: the selected run's problem count. (Under the
        // single-run pick this was the campaign's created_at timestamp.)
        measured_before: sel.problems_before,
        kind: sel.kind,
        provider: sel.provider,
        model_slug: sel.model_slug,
        turns: sel.turns,
        tokens: sel.tokens,
        wall_seconds: sel.wall_seconds,
        gates: sel.gates,
        verdict: sel.verdict,
        context_exhausted: sel.context_exhausted === true,
        // The batch's scored-run count; only the selected run is the floor.
        candidates: batch.scored_count,
        median: batch.median,
        batch: batchView(batchCells, batch),
        reason: null,
      };
    }

    // Batch assembled, operator hasn't picked: a batch exists, a floor does
    // not. No pick is fabricated — this is the awaiting-selection state.
    const rep = mine[0];
    return {
      exists: true,
      scorable: false,
      id: rep.id,
      run_dir: rep.run_dir,
      sequence_index: rep.sequence_index,
      kind: rep.kind,
      provider: rep.provider,
      model_slug: rep.model_slug,
      candidates: batch.scored_count,
      median: batch.median,
      batch: batchView(batchCells, batch),
      reason: "awaiting_selection",
    };
  }

  // Seeded is checked before void; it is the more fundamental refusal.
  if (seeded.length) {
    const s = seeded[seeded.length - 1];
    return {
      exists: false,
      scorable: false,
      seeded: true,
      // No voided/pending flag: the row resolves to "none" and never reaches the card.
      id: s.id,
      run_dir: s.run_dir,
      sequence_index: s.sequence_index,
      kind: s.kind,
      provider: s.provider,
      model_slug: s.model_slug,
      candidates: 0,
      reason:
        `seeded from snapshot \`${s.seeded_from_snapshot}\` — a seeded cell skips the build `
        + "and sits on a different turn/token scale than the floor a Δ is measured against.",
    };
  }

  if (voids.length) {
    const v = voids[voids.length - 1];
    return {
      exists: false,
      scorable: false,
      voided: true,
      // A void floor keeps its id so the operator can find and archive it.
      id: v.id,
      run_dir: v.run_dir,
      sequence_index: v.sequence_index,
      kind: v.kind,
      provider: v.provider,
      model_slug: v.model_slug,
      candidates: 0,
      reason: v.state === "ended"
        ? `the last OFF cell for ${model} ended before any graded attempt (${v.terminal_exception ?? v.terminal_reason ?? "no reason recorded"}) — ` +
          "there is no measurement to compare a run against. Run a new baseline."
        : `the last OFF cell for ${model} is void-instrument (${v.terminal_exception ?? v.terminal_reason ?? "instrument fault"}) — ` +
          "it produced numbers, but they measure the harness rather than the model, so every Δ " +
          "computed against them would be invalid. Run a new baseline.",
    };
  }

  if (exhausted.length) {
    const x = exhausted[exhausted.length - 1];
    return {
      exists: false,
      scorable: false,
      exhausted: true,
      id: x.id,
      run_dir: x.run_dir,
      sequence_index: x.sequence_index,
      kind: x.kind,
      provider: x.provider,
      model_slug: x.model_slug,
      candidates: 0,
      reason:
        `the last OFF cell for ${model} ran out of context during the build and was stopped before `
        + "anything was graded — there is no measurement to compare a run against. Run a new baseline.",
    };
  }

  if (running.length) {
    const r = running[running.length - 1];
    return {
      exists: false,
      scorable: false,
      pending: true,
      // A running baseline holds its row, with an id and kind like a closed one.
      id: r.id,
      run_dir: r.run_dir,
      sequence_index: r.sequence_index,
      kind: r.kind,
      provider: r.provider,
      model_slug: r.model_slug,
      // When the campaign folder was created, not this attempt.
      campaign_started_at: r.created_at,
      candidates: 0,
      // No batch record until a cell scores: the cells, from disk, no verdicts.
      batch: batchView(mine.filter((c) => c.run_dir === r.run_dir), null),
      reason: `an OFF cell for ${model} is scheduled or in flight but has not produced a measurement yet`,
    };
  }

  return {
    exists: false,
    scorable: false,
    candidates: 0,
    reason: `no OFF cell has ever been run for ${model} — the floor every Δ is measured against does not exist yet`,
  };
}

/**
 * Every baseline that exists: one row per model (a model has one floor;
 * `candidates` counts the others). States: complete (a floor), awaiting (a
 * batch assembled but unselected — visible so the operator can pick), running
 * (in flight, refuses runs), void (ran but measured the harness), exhausted
 * (out of context before grading), none (no row — e.g. only seeded cells).
 */
async function baselineList(offCells, { repoRoot = REPO_ROOT, runsRoot = null, current = currentGetter(repoRoot) } = {}) {
  const byModel = new Map();
  for (const c of offCells) {
    if (!c.model) continue;
    if (!byModel.has(c.model)) byModel.set(c.model, []);
    byModel.get(c.model).push(c);
  }

  const rows = [];
  for (const [model, cells] of byModel) {
    const b = await baselineFor(model, cells, { repoRoot, runsRoot, current });
    // An awaiting-selection batch is a VISIBLE row: the operator must see the
    // batch (and its median) to pick from it — dropping it hides the pick.
    const state = b.scorable
      ? "complete"
      : b.voided
        ? "void"
        : b.exhausted
          ? "exhausted"
          : b.pending
            ? "running"
            : b.reason === "awaiting_selection"
              ? "awaiting"
              : "none";
    if (state === "none") continue;

    // Identity from the resolved baseline, else the newest cell.
    const newest = cells[cells.length - 1];

    rows.push({
      id: b.id ?? baselineId(newest.run_dir, newest.sequence_index),
      model,
      kind: b.kind ?? newest.kind,
      provider: b.provider ?? newest.provider,
      model_slug: b.model_slug ?? newest.model_slug,
      state,
      scorable: b.scorable === true,
      run_dir: b.run_dir ?? newest.run_dir,
      sequence_index: b.sequence_index ?? newest.sequence_index,
      measured_before: b.measured_before ?? null,
      campaign_started_at: b.campaign_started_at ?? newest.created_at ?? null,
      turns: b.turns ?? null,
      tokens: b.tokens ?? null,
      wall_seconds: b.wall_seconds ?? null,
      gates: b.gates ?? null,
      verdict: b.verdict ?? null,
      // Stopped at the context limit — on a floor (graded) or on a row that
      // is not one (state "exhausted", nothing graded).
      context_exhausted: b.context_exhausted === true || state === "exhausted",
      // Cells found vs valid: what to check when an expected floor is missing.
      cells_seen: cells.length,
      candidates: b.candidates ?? 0,
      // The batch's median problem count — the awaiting row's measurement and
      // the void row's stale one. Null when no batch was ever assembled.
      median: b.median ?? null,
      // Why the batch is void (state "void"): superseded / mixed /
      // unfingerprinted, the input concerned, and the sentence; else null.
      void_kind: b.void_kind ?? null,
      void_input: b.void_input ?? null,
      void_reason: b.void_reason ?? null,
      // The batch's cells, median, spread and pick (batchView); null for a row
      // with no batch behind it.
      batch: b.batch ?? null,
      reason: b.reason ?? null,
    });
  }

  // Newest first — by campaign timestamp. measured_before is the floor's
  // problem count now, not a time, so it must never key this sort.
  rows.sort((a, b) =>
    String(b.campaign_started_at ?? "").localeCompare(String(a.campaign_started_at ?? "")),
  );
  return rows;
}

/** The stored export. One file, rewritten only when the answer changes. */
export const BASELINES_FILE = "baselines.json";
const BASELINES_CONTRACT_VERSION = 1;

/**
 * Every bench model's floor. A model with no OFF cell still gets
 * `exists: false` and a reason, so the UI can render its gate.
 */
async function buildBaselineIndex({ runsRoot, models }) {
  const offCells = await collectOffCells(runsRoot);
  const ids = (models ?? []).map((m) => (typeof m === "string" ? m : str(m?.id))).filter(Boolean);

  // One read of the current code for the whole index, taken only if a batch
  // needs checking.
  const current = currentGetter(REPO_ROOT);
  const out = {};
  for (const id of ids) out[id] = await baselineFor(id, offCells, { runsRoot, current });

  const list = await baselineList(offCells, { runsRoot, current });

  return {
    contract_version: BASELINES_CONTRACT_VERSION,
    generated_at: new Date().toISOString(),
    runs_root: runsRoot,
    off_cells_seen: offCells.length,
    models: out,
    // `models` is keyed by the roster (what every gate asks). `list` is derived
    // from the cells (what the BASELINES card shows): it includes cloud floors and
    // models that left the roster, and omits rostered models that never ran.
    list,
    counts: {
      complete: list.filter((b) => b.state === "complete").length,
      running: list.filter((b) => b.state === "running").length,
      void: list.filter((b) => b.state === "void").length,
      exhausted: list.filter((b) => b.state === "exhausted").length,
    },
    note:
      "one floor per model. A model with no scorable floor may always start a baseline; a model "
      + "with one may not — re-baselining is a declared act (archive the run), not a button. "
      + "Void-instrument cells are not floors.",
  };
}

/**
 * Derive, publish, return. The write is best-effort and its outcome reported;
 * unchanged content is not rewritten.
 */
export async function readBaselines({ runsRoot, models }) {
  const index = await buildBaselineIndex({ runsRoot, models });
  const stored = await publishBaselines(runsRoot, index);
  return { ok: true, ...index, stored };
}

async function publishBaselines(runsRoot, index) {
  const path = join(runsRoot, BASELINES_FILE);
  // generated_at changes every derivation, so it is left out of the comparison.
  const { generated_at: _ignored, ...stable } = index;
  const body = `${JSON.stringify(index, null, 2)}\n`;

  // Missing is expected (first run, fresh tree). Anything unreadable is named
  // before it is overwritten; the overwrite always happens.
  let overwrote_unreadable = null;
  try {
    const prev = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(prev);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      // Parses cleanly but is not an index.
      overwrote_unreadable = `the previous export parsed as ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed}, not a baseline index`;
    } else {
      const { generated_at: _prevGen, ...prevStable } = parsed;
      if (JSON.stringify(prevStable) === JSON.stringify(stable)) {
        return { path, written: false, reason: "unchanged since the last derivation" };
      }
    }
  } catch (err) {
    if (err?.code !== "ENOENT") {
      overwrote_unreadable = `the previous export could not be read back: ${String(err?.message ?? err)}`;
    }
  }

  if (overwrote_unreadable !== null) {
    console.error(`[baselines] overwriting an unreadable export at ${path}: ${overwrote_unreadable}`);
  }

  try {
    await fs.writeFile(path, body, "utf8");
    return { path, written: true, reason: null, overwrote_unreadable };
  } catch (err) {
    return {
      path,
      written: false,
      reason: `could not write the baseline export: ${String(err?.message ?? err)}`,
      overwrote_unreadable,
    };
  }
}
