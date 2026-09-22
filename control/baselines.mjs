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
import { listLiveCampaignDirs } from "./tree.mjs";
import {
  hashDir,
  computeFingerprint,
  fingerprintVerdict,
  markVoid,
  assembleBatch,
  readBatch,
  writeBatch,
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
      folded.set(seq, {
        attempts,
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
        length_truncations: (prev.length_truncations ?? 0) + (int(r.length_truncations) ?? 0),
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
          || (meas.length_truncations ?? 0) > 0
          || (meas.unrecovered_anomaly_turns ?? 0) > 0),
      );

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
        state: meas ? "complete" : "not_started",
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
        terminal_reason: meas?.terminal_reason ?? null,
        // Out of context room: a result, not an instrument fault.
        context_exhausted: meas?.terminal_reason === "context_exhausted",
        created_at: str(manifest.created_at),
      });
    }
  }

  return cells;
}

/**
 * The eight fingerprint inputs that determine what a batch measured: four
 * directory hashes over the measured repo, plus identity fields from the
 * run-manifest. A run without a manifest is genuinely unidentifiable — the
 * identity fields are null/false, never fabricated.
 */
export async function collectFingerprintInputs({ repoRoot = REPO_ROOT, runDir }) {
  const [chunk_plan_hash, grader_hash, scaffold_hash, golden_hash] = await Promise.all([
    hashDir(path.join(repoRoot, "task", "backgammon", "prompts")),
    hashDir(path.join(repoRoot, "grader"), {
      exclude: new Set(["node_modules", ".git", "test-results"]),
    }),
    hashDir(path.join(repoRoot, "task", "backgammon", "scaffold")),
    hashDir(path.join(repoRoot, "task", "backgammon", "golden")),
  ]);

  const manifest = await readJsonOrNull(path.join(runDir, "manifest.run-manifest.json"));

  return {
    chunk_plan_hash,
    grader_hash,
    scaffold_hash,
    golden_hash,
    model: str(manifest?.requested_model) ?? str(manifest?.served_model) ?? null,
    challenge: str(manifest?.challenge) ?? null,
    compaction: manifest?.compact === true,
    worker_image: manifest?.worker_image_fingerprint ?? null,
  };
}

/**
 * Build and persist the batch record for one model's OFF cells: the median
 * problem count over SCORED runs (voids excluded, never counted as failures),
 * bound to the current fingerprint. Written atomically to <runDir>/batch.json.
 */
export async function assembleBatchForCells({ repoRoot = REPO_ROOT, runDir, cells }) {
  // The same scorability rule baselineFor applies: complete, not void-instrument,
  // not seeded, and not out of context before anything was graded.
  const scored = (c) => c.state === "complete" && !c.void_instrument && !c.seeded_from_snapshot && !(c.context_exhausted === true && !c.gates);
  const voidReason = (c) => c.context_exhausted === true && !c.gates ? "context_exhausted"
    : c.seeded_from_snapshot ? "seeded_from_snapshot"
      : c.void_instrument ? "void_instrument"
        : c.state !== "complete" ? (c.terminal_reason ?? c.state ?? "incomplete")
          : "no_measurement";
  const runs = cells.map((c) => ({
    sequence_index: c.sequence_index,
    problem_count: scored(c) ? c.problems_before : null,
    scored: scored(c),
    void_reason: scored(c) ? null : voidReason(c),
    // Rides along for visibility (batch.runs[].contention); never scored on.
    contention: c.contention ?? null,
  }));
  const values = await collectFingerprintInputs({ repoRoot, runDir });
  const fingerprint = computeFingerprint(values);
  const batch = assembleBatch({ runDir, runs, fingerprint });
  await writeBatch(runDir, batch);
  return batch;
}

/**
 * Verify a persisted batch's fingerprint against the CURRENT inputs: any
 * changed input voids the batch (markVoid mutates it) and is named — the
 * first differing one in FINGERPRINT_INPUTS order. This helper never writes;
 * persisting the void is the CALLER's decision. `currentInputs` (a bare
 * values map) is injectable for tests; the default re-collects the eight
 * live inputs from the measured repo plus the batch's own run_dir manifest.
 */
export async function verifyBatchFingerprint(batch, { repoRoot = REPO_ROOT, currentInputs = null } = {}) {
  const current = currentInputs
    ? computeFingerprint(currentInputs)
    : computeFingerprint(await collectFingerprintInputs({ repoRoot, runDir: batch.run_dir }));
  const verdict = fingerprintVerdict(batch.fingerprint, current);
  if (!verdict.valid) {
    markVoid(batch, verdict.changedInput, verdict.changedReason);
    return { batch, void: true, void_input: verdict.changedInput };
  }
  return { batch, void: false, void_input: null };
}

/**
 * Read the batch for a runs-root-RELATIVE run_dir and verify its fingerprint
 * against the current inputs. A batch the verification voids is persisted
 * void right here — the record must not keep claiming a validity it lost.
 * No batch is {ok:false}: this path never assembles one (assembly needs the
 * cells, which only baselineFor has).
 */
export async function readBatchForRunDir({ runsRoot, runDir, repoRoot = REPO_ROOT }) {
  const abs = join(runsRoot, runDir);
  const batch = await readBatch(abs);
  if (!batch) return { ok: false, error: "no batch for run_dir" };
  const verified = await verifyBatchFingerprint(batch, { repoRoot });
  if (verified.void) await writeBatch(abs, verified.batch);
  return { ok: true, batch: verified.batch };
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
export async function baselineFor(model, offCells, { repoRoot = REPO_ROOT, runsRoot = null } = {}) {
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
  const voids = mine.filter((c) => c.state === "complete" && c.void_instrument);
  const running = mine.filter((c) => c.state !== "complete");

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
    const batch = (await readBatch(runDir))
      ?? (await assembleBatchForCells({ repoRoot, runDir, cells: batchCells }));

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
        void_input: batch.void_input,
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
      reason:
        `the last OFF cell for ${model} is void-instrument (${voids[voids.length - 1].terminal_reason ?? "instrument fault"}) — ` +
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
async function baselineList(offCells, { repoRoot = REPO_ROOT, runsRoot = null } = {}) {
  const byModel = new Map();
  for (const c of offCells) {
    if (!c.model) continue;
    if (!byModel.has(c.model)) byModel.set(c.model, []);
    byModel.get(c.model).push(c);
  }

  const rows = [];
  for (const [model, cells] of byModel) {
    const b = await baselineFor(model, cells, { repoRoot, runsRoot });
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
      // The fingerprint input that voided the batch (state "void"); else null.
      void_input: b.void_input ?? null,
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

  const out = {};
  for (const id of ids) out[id] = await baselineFor(id, offCells, { runsRoot });

  const list = await baselineList(offCells, { runsRoot });

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
