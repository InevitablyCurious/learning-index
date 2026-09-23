// Pure domain layer for the batch/median/operator-selection baseline (Step 6).
// A model's floor is no longer an arbitrary last-scorable pick: it is the
// operator's selected run from a batch of N runs, whose MEDIAN problem count
// over SCORED runs (voids excluded, never counted as failures) is the
// baseline. The batch is bound to a fingerprint of everything that determines
// what was measured; any input change voids the batch and names the changed
// input. No I/O beyond batch.json read/write and directory hashing — no
// server, no network, no state outside the passed arguments.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * The inputs that are CODE — what a later edit or rebuild can change under a
 * batch. A recorded fingerprint is compared against the current tree on these
 * only; model, challenge and compaction are the batch's own identity.
 */
export const CODE_INPUTS = ["chunk_plan_hash", "grader_hash", "scaffold_hash", "golden_hash", "worker_image"];

/**
 * The ordered fingerprint inputs. Order is contract: computeFingerprint
 * canonicalizes by this order and fingerprintVerdict reports the FIRST
 * differing input by this order.
 */
export const FINGERPRINT_INPUTS = [
  {
    name: "chunk_plan_hash",
    reason: "build prompts + AGENTS.md notes + failure prompts (the whole prompts dir)",
  },
  {
    name: "grader_hash",
    reason: "grader/gate suite — a changed test changes what a failure count means",
  },
  { name: "model", reason: "which model was measured" },
  { name: "challenge", reason: "which task was measured" },
  { name: "compaction", reason: "context-budget mode (compact on/off)" },
  { name: "scaffold_hash", reason: "the starter files" },
  { name: "golden_hash", reason: "the reference solution" },
  {
    name: "worker_image",
    reason: "the container build (pinned opencode/node/playwright/chromium)",
  },
];

/** Recursively collect POSIX relative paths of regular files, skipping excluded segments. */
async function collectFiles(dirPath, rootPath, exclude, files) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (exclude.has(entry.name)) continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(full, rootPath, exclude, files);
    } else if (entry.isFile()) {
      files.push(path.relative(rootPath, full).split(path.sep).join("/"));
    }
  }
}

/**
 * sha256 hex over a directory: sorted POSIX relative path (utf8) then raw
 * file bytes, per file. Replicates the Python compute_grader_hash /
 * compute_task_template_hash algorithm byte-for-byte (regular files only,
 * symlinks skipped). `exclude` is a Set of path-segment names; any file whose
 * relative path contains one is skipped. Throws on a missing directory.
 */
export async function hashDir(dirPath, { exclude = new Set() } = {}) {
  const files = [];
  await collectFiles(dirPath, dirPath, exclude, files);
  files.sort();
  const digest = createHash("sha256");
  for (const rel of files) {
    digest.update(rel, "utf8");
    digest.update(await fs.readFile(path.join(dirPath, rel)));
  }
  return digest.digest("hex");
}

/**
 * Canonical fingerprint: values copied in FINGERPRINT_INPUTS order, hash over
 * the JSON.stringify of each value joined with "\n" in that same order — so
 * the hash is independent of the caller's key insertion order. Fails loud on
 * a missing input rather than hashing an empty slot.
 */
export function computeFingerprint(values) {
  const canonical = {};
  const parts = [];
  for (const { name } of FINGERPRINT_INPUTS) {
    const value = values == null ? undefined : values[name];
    if (value === undefined) {
      throw new Error("fingerprint input missing: " + name);
    }
    canonical[name] =
      typeof value === "object" && value !== null ? structuredClone(value) : value;
    parts.push(JSON.stringify(value));
  }
  const hash = createHash("sha256").update(parts.join("\n"), "utf8").digest("hex");
  return { values: canonical, hash };
}

/** worker_image compares on identity fields only: image_id and created. */
function workerImageEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  return a.image_id === b.image_id && a.created === b.created;
}

/**
 * Compare a stored fingerprint against the current one. Accepts {values,hash}
 * fingerprint objects or bare values maps. Returns the FIRST differing input
 * (FINGERPRINT_INPUTS order) with its reason, or a valid verdict.
 */
export function fingerprintVerdict(stored, current) {
  const storedValues = stored && stored.values ? stored.values : stored;
  const currentValues = current && current.values ? current.values : current;
  for (const { name, reason } of FINGERPRINT_INPUTS) {
    const a = storedValues == null ? undefined : storedValues[name];
    const b = currentValues == null ? undefined : currentValues[name];
    const equal = name === "worker_image" ? workerImageEqual(a, b) : a === b;
    if (!equal) {
      return { valid: false, changedInput: name, changedReason: reason };
    }
  }
  return { valid: true, changedInput: null, changedReason: null };
}

/**
 * Median problem count over SCORED runs only. Void runs are excluded — never
 * counted as failures. Even count → mean of the two middle values. No scored
 * runs → null (there is no baseline yet).
 */
export function medianOfScored(runs) {
  const counts = runs
    .filter((run) => run.scored === true && Number.isFinite(run.problem_count))
    .map((run) => run.problem_count)
    .sort((a, b) => a - b);
  if (counts.length === 0) return null;
  const mid = Math.floor(counts.length / 2);
  return counts.length % 2 === 1 ? counts[mid] : (counts[mid - 1] + counts[mid]) / 2;
}

/** Signed deviation of a pick from the median: + = worse, - = better. */
export function signedDeviation(problemCount, median) {
  if (median == null) return null;
  return problemCount - median;
}

/**
 * Batch-level contention summary over the SCORED runs only — the same
 * population the median is derived from. VISIBILITY ONLY: it lets an operator
 * tell a crowded batch from a quiet one; it gates nothing, scores nothing, and
 * is deliberately NOT a fingerprint input (a slower/crowded run is still the
 * same run). Aggregation over scored runs carrying a contention object:
 *   - the four counts (http_429_count, http_402_count, retry_count,
 *     upstream_error_count) are SUMMED;
 *   - the two latencies (max_request_ms, median_request_ms) take the MAX;
 *   - wall_near_timeout is ANY (true when any scored run is true).
 * A field no scored run measured is null — never a fabricated 0/false.
 */
export function contentionSummary(runs) {
  const measured = runs
    .filter((run) => run.scored === true && run.contention && typeof run.contention === "object")
    .map((run) => run.contention);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const sum = (key) => {
    let out = null;
    for (const c of measured) {
      const v = num(c[key]);
      if (v !== null) out = (out ?? 0) + v;
    }
    return out;
  };
  const max = (key) => {
    let out = null;
    for (const c of measured) {
      const v = num(c[key]);
      if (v !== null) out = out === null ? v : Math.max(out, v);
    }
    return out;
  };
  const any = (key) => {
    let out = null;
    for (const c of measured) {
      if (typeof c[key] === "boolean") out = out === null ? c[key] : out || c[key];
    }
    return out;
  };
  return {
    http_429_count: sum("http_429_count"),
    http_402_count: sum("http_402_count"),
    retry_count: sum("retry_count"),
    upstream_error_count: sum("upstream_error_count"),
    max_request_ms: max("max_request_ms"),
    median_request_ms: max("median_request_ms"),
    wall_near_timeout: any("wall_near_timeout"),
  };
}

/**
 * Build the batch record. Runs are normalized (problem_count number|null,
 * scored boolean, void_reason string|null, contention object|null); counts,
 * median and the contention summary are derived from the normalized list so
 * the record never disagrees with itself.
 */
export function assembleBatch({ runDir, runs, fingerprint, now = new Date().toISOString() }) {
  const normalized = runs.map((run) => ({
    sequence_index: run.sequence_index,
    problem_count: Number.isFinite(run.problem_count) ? run.problem_count : null,
    scored: run.scored === true,
    void_reason: typeof run.void_reason === "string" ? run.void_reason : null,
    // The run's seven contention covariates, copied so the record never
    // aliases the caller's object. Visibility only — NOT a fingerprint input.
    contention: run.contention && typeof run.contention === "object" ? { ...run.contention } : null,
  }));
  const scoredCount = normalized.filter((run) => run.scored).length;
  return {
    schema_version: 1,
    run_dir: runDir,
    created_at: now,
    updated_at: now,
    fingerprint,
    runs: normalized,
    scored_count: scoredCount,
    void_count: normalized.length - scoredCount,
    median: medianOfScored(normalized),
    // What conditions the batch was gathered under, over the SCORED runs only
    // (contentionSummary). Visibility only, never a gate, never fingerprinted.
    contention: contentionSummary(normalized),
    selection: null,
    void: false,
    // Why the batch is void: "superseded" (the code changed since it ran),
    // "mixed" (its cells ran on different inputs) or "unfingerprinted" (its
    // cells recorded nothing to bind it to). null while valid.
    void_kind: null,
    void_input: null,
    void_reason: null,
  };
}

/** Void the batch, naming why and the input concerned. Mutates + returns batch. */
export function markVoid(batch, kind, changedInput, changedReason) {
  batch.void = true;
  batch.void_kind = kind;
  batch.void_input = changedInput;
  batch.void_reason = changedReason;
  batch.updated_at = new Date().toISOString();
  return batch;
}

/**
 * Record the operator's pick: the scored run at sequenceIndex, with its
 * signed deviation from the batch median. Fails loud on an absent or void
 * sequence_index — a void run is never selectable as the artifact.
 */
export function selectRun(batch, sequenceIndex) {
  const run = batch.runs.find(
    (candidate) => candidate.scored === true && candidate.sequence_index === sequenceIndex,
  );
  if (!run) throw new Error("no scored run with sequence_index " + sequenceIndex);
  batch.selection = {
    sequence_index: run.sequence_index,
    problem_count: run.problem_count,
    signed_deviation: signedDeviation(run.problem_count, batch.median),
  };
  batch.updated_at = new Date().toISOString();
  return batch;
}

/** Where the batch record lives for a run dir. */
export function batchPath(runDir) {
  return path.join(runDir, "batch.json");
}

/** Parse a JSON file, or null when absent/unparseable. */
async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** Read the batch record for a run dir, or null when absent/unparseable. */
export async function readBatch(runDir) {
  return readJsonOrNull(batchPath(runDir));
}

let tmpCounter = 0;

/** Atomic write: temp file in the same dir, then rename over batch.json. */
export async function writeBatch(runDir, batch) {
  await fs.mkdir(runDir, { recursive: true });
  const tmp = path.join(runDir, `batch.json.${process.pid}.${tmpCounter++}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(batch, null, 2) + "\n", "utf8");
  await fs.rename(tmp, batchPath(runDir));
}
