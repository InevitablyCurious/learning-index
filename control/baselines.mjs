// BASELINES — the one owner of "does model X have a baseline, and what did it
// cost".
//
// A baseline: every completed, non-void OFF cell — one click on Run is one
// baseline. There is no picked floor and no selection: the numbers an ON run is
// measured against are the AVERAGE over every baseline sharing its fingerprint
// (`fingerprints`, derived at read time), so a baseline is never rationed and
// adding one is the only thing that moves a Δ.
//
// Re-baselining is ordinary: every Run in the OFF arm yields one more baseline,
// so baselines ACCUMULATE per fingerprint — how many were gathered on exactly
// this code, plus the average context/wall/turns/tokens across them, derived at
// read time. Only a cell in flight blocks another run for that model. A void
// cell (it measured the harness, not the model) is no baseline: that verdict is
// the harness's own cost.json `void.is_void` stamp, never re-derived here.
//
// <runsRoot>/baselines.json is an export, never an input: every read re-derives
// from the run folders, and a failed write is reported in `stored`, not thrown.

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listCellDirs, listLiveCampaignDirs } from "./tree.mjs";
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
 * The provider pin a model slug implies, exactly as the harness derives it
 * (`scripts/run_cumulative/roster.py` `_provider_pin_from_model`): a
 * `local-llm-proxy/<alias>` slug is pinned to the alias, anything else to its
 * first segment. The schedule entry used to carry this beside the model; a cell
 * read off disk has only its slug, so the rule is applied here.
 */
export function pinFromSlug(slug) {
  const parts = String(slug ?? "").split("/").filter(Boolean);
  if (!parts.length) return null;
  if (parts.length >= 2 && parts[0] === "local-llm-proxy") return parts[1];
  return parts[0];
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

  // Local: the pin is the bare bench alias, which matches the roster ids — a
  // slot that states one wins, else it is derived from the slug (pinFromSlug).
  const pin = str(slot?.provider_pin) ?? pinFromSlug(slug);
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
 * The six contention covariates, flat in each status record's `progress`
 * (written by the harness ProgressVector). VISIBILITY ONLY: they say what
 * conditions the cell was gathered under — they gate nothing, score nothing,
 * and are deliberately NOT fingerprint inputs (a crowded run is the same run).
 * Sticky per field across the attempt fold like every other measurement;
 * null means "not measured" (spend DB unavailable), never a coerced 0.
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
  };
}

/**
 * Every OFF cell on disk, folded per model. Identity from the cell's own
 * directory and files, measurement from the status stream, so a crashed cell
 * still appears. `includeBackups` reaches the rotated trees under
 * runs/backups (history).
 */
export async function collectOffCells(runsRoot, opts) {
  return (await collectCells(runsRoot, opts)).filter((c) => c.arm === OFF_ARM);
}

/** Every cell on disk, both arms, folded by the same rules. */
export async function collectCells(runsRoot, { includeBackups = false } = {}) {
  const cells = [];

  // Walks nested campaigns in the live tree (retired trees skipped; rotated
  // trees only when the caller is reading history).
  let entries = [];
  try {
    entries = await listLiveCampaignDirs(runsRoot, { includeBackups });
  } catch {
    return cells;
  }

  for (const ent of entries) {
    if (isArchivedRun(ent.name)) continue;
    const dir = ent.dir;
    const manifest = await readJsonOrNull(join(dir, "manifest.json"));
    if (!manifest) continue;

    // THE CELLS ARE THE DIRECTORIES. `memory<ARM>/cell-<NNNN>` carries both
    // facts a reader needs — the arm in the container's name, the sequence in
    // the cell's. Enumeration no longer goes through the manifest: its
    // `schedule` is an APPEND LOG of clicks, not an address list, so reading
    // cells through it silently dropped every cell that no longer sat at a slot
    // index (renumbered, orphaned, clicked out of order).
    const cellDirs = await listCellDirs(dir);
    if (!cellDirs.length) continue;

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
      });
    }

    for (const cell of cellDirs) {
      // Arm and sequence are the PATH, read verbatim: the harness names a cell's
      // container `memory<ARM>` and the cell itself `cell-<NNNN>`.
      const arm = cell.arm;
      const seq = cell.seq;
      const cellDir = cell.dir;
      const meas = folded.get(seq) ?? null;

      // What the cell recorded it ran on, at its start (harness/fingerprint.py);
      // null for a cell that recorded nothing.
      const fingerprint = await readCellFingerprint(cellDir);

      // See identifyCell(). The model is read from the cell's OWN files — the
      // schedule slot that used to carry it was never an address.
      const who = identifyCell({ model: await readCellModel(cellDir) }, manifest);
      const model = who.id;

      // The cell's cost stamp, and with it the void verdict; null for a cell
      // that ended before the stamp existed (pre-standard, not void).
      const cost = await readCellCost(cellDir);
      // A cell with no attempt record may still have RUN: it died before its
      // first graded attempt (e.g. IncompleteBuildError in the build). The
      // harness records how it ended on its own stream (cell.end); read that
      // rather than calling a four-hour cell "not_started".
      const ended = meas ? null : await readCellEnd(cellDir);
      const resumed = await readCellResume(cellDir);

      cells.push({
        id: baselineId(ent.relative, seq),
        run_dir: ent.relative,
        sequence_index: seq,
        model,
        // Local or cloud, and who served it, derived from the cell's own slug.
        kind: who.kind,
        provider: who.provider,
        router: who.router,
        model_slug: who.slug,
        arm,
        // complete: graded · ended: ran and stopped before a graded attempt ·
        // started: began, no end recorded yet · not_started: never began.
        // resumed: started from a dev-loop check-point — never scored.
        state: resumed
          ? "resumed"
          : meas ? "complete" : ended ? "ended" : fingerprint ? "started" : "not_started",
        resumed_from: resumed?.resumed_from ?? null,
        // RUNBOOK 5.10, read off the harness's stamp: a cell that never
        // produced the stamp is pre-standard, and not void.
        void_instrument: cost?.void?.is_void === true,
        // Every attempt the cell actually ran; no cap, so `total` is null (unbounded).
        phases: { done: meas ? meas.attempts.size : 0, total: null },
        verdict: meas?.verdict ?? null,
        turns: meas?.turns ?? null,
        tokens: meas?.tokens ?? null,
        problems_before: meas?.problems_before ?? null,
        wall_seconds: meas?.wall_seconds ?? null,
        // The cell's six contention covariates (null when never measured).
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
        // The harness's per-cell cost stamp (scripts/run_cumulative/runner.py):
        // { outcome, phases: { build?, troubleshooting?, total? }, paused_seconds?,
        //   void: { is_void, reason } }. Carried whole — its `void.reason` is the
        // only statement of WHY a cell is void, and its `phases.total` is what
        // the per-fingerprint aggregate averages.
        cost,
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
export async function readCellEnd(cellDir) {
  const tail = await readTail(join(cellDir, "live.jsonl"));
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"cell.end"')) continue;
    try {
      const rec = JSON.parse(lines[i]);
      if (rec?.kind !== "cell.end") continue;
      return {
        verdict: str(rec.verdict),
        terminal_reason: str(rec.terminal_reason),
        terminal_exception: str(rec.terminal_exception),
      };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * A RESUMED cell's own statement (harness: runner `resume_checkpoint`), or null.
 * A resumed cell started from a dev-loop check-point and skipped the work before
 * it, so it is never a measurement: its state is "resumed", which no scoring
 * filter counts.
 */
export async function readCellResume(cellDir) {
  const rec = await readJsonOrNull(join(cellDir, "resume.json"));
  return rec && typeof rec === "object" && rec.measurement === false ? rec : null;
}

/** A cell's recorded fingerprint values (harness/fingerprint.py), or null. */
async function readCellFingerprint(cellDir) {
  const rec = await readJsonOrNull(join(cellDir, "fingerprint.json"));
  return rec?.values && typeof rec.values === "object" ? rec.values : null;
}

/**
 * How much of a cell's live stream is read looking for `cell.start`. The record
 * is emitted BEFORE any work (harness/adapters/challenge/runner.py), so it sits
 * at the head of the file; the rest of the stream is long and is never read
 * here (readCellEnd reads the tail).
 */
const CELL_START_HEAD_BYTES = 256 * 1024;

/**
 * The model slug on a cell's `cell.start` record, or null. The record's `arm` is
 * deliberately NOT read: the arm is the `memory<ARM>` directory's name, which is
 * the address, and a second source could only disagree with it.
 *
 * The head is read, not the tail: this record is the stream's opening.
 */
async function readCellStartModel(cellDir) {
  let head;
  try {
    const handle = await fs.open(join(cellDir, "live.jsonl"), "r");
    try {
      const buf = Buffer.alloc(CELL_START_HEAD_BYTES);
      const { bytesRead } = await handle.read(buf, 0, CELL_START_HEAD_BYTES, 0);
      head = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  for (const line of head.split("\n")) {
    // A line cut by the head boundary fails JSON.parse below and is skipped.
    if (!line.includes('"cell.start"')) continue;
    try {
      const rec = JSON.parse(line);
      if (rec?.kind !== "cell.start") continue;
      return str(rec.model);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The model slug a cell RAN, from the cell's own files. `cell.start` leads: it
 * is stamped before any work, even for a cell that dies before recording its
 * fingerprint. `fingerprint.json`'s `values.model` is the fallback — the same
 * slug the harness hashes into the fingerprint — and null when the cell left
 * neither on disk (there is no identity to invent).
 */
export async function readCellModel(cellDir) {
  const started = await readCellStartModel(cellDir);
  if (started) return started;
  const values = await readCellFingerprint(cellDir);
  return str(values?.model);
}

/**
 * A cell's cost stamp (scripts/run_cumulative/runner.py), or null for a cell
 * that produced none. The stamp is the harness's authority on both what the
 * cell cost per phase and whether it measured the model or itself
 * (`void.is_void`) — this module never re-derives either.
 */
export async function readCellCost(cellDir) {
  return readJsonOrNull(join(cellDir, "cost.json"));
}

const execFileP = promisify(execFile);
const WORKER_IMAGE_TAG = "bench-worker:v1";

/** The challenge the control plane measures — the dir the four tree hashes name. */
const TASK_REL = ["task", "backgammon"];
/** The worker context's baked set, mirroring images/worker/.dockerignore. */
const WORKER_BAKED_FILES = new Set(["Dockerfile", ".dockerignore"]);
/** Never hashed from the sidecar context — prefixed, exactly as harness/worker_image.py tests it. */
const WORKER_SOURCE_EXCLUDED = [".git/", ".github/", "node_modules/"];
/** Never baked into the grader image, and so never part of its identity. */
const GRADER_SOURCE_EXCLUDED = new Set(["node_modules", "test-results", ".git"]);
const OPENCODE_ARG = "ARG OPENCODE_VERSION=";

/**
 * Every regular file under `dirPath` as `{ rel, full }`, `rel` a POSIX path
 * relative to `rootPath` — Python's `Path.rglob("*")` + `is_file()`: a symlink
 * to a file counts (is_file follows it), a symlink to a directory is not
 * descended. `skipSymlinks` reproduces harness/grader_image.py's baked_paths,
 * which drops symlinks outright.
 */
async function walkRelFiles(dirPath, rootPath, { skipSymlinks = false } = {}) {
  const files = [];
  for (const entry of await fs.readdir(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkRelFiles(full, rootPath, { skipSymlinks })));
      continue;
    }
    let regular = entry.isFile();
    if (!regular && entry.isSymbolicLink() && !skipSymlinks) {
      regular = (await fs.stat(full).catch(() => null))?.isFile() === true;
    }
    if (!regular) continue;
    files.push({ rel: path.relative(rootPath, full).split(path.sep).join("/"), full });
  }
  return files;
}

/**
 * sha256 over `{rel, full}` entries, sorted by rel, mixed as
 * `rel ‖ 0x00 ‖ sha256(bytes)` — the image-source digest shape of
 * harness/worker_image.py and harness/grader_image.py. NOT hashDir's mixing:
 * the file's own digest enters, never its raw bytes.
 */
async function relPathDigest(entries) {
  const ordered = [...entries].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const digest = createHash("sha256");
  for (const { rel, full } of ordered) {
    digest.update(rel, "utf8");
    digest.update(Buffer.from([0]));
    digest.update(createHash("sha256").update(await fs.readFile(full)).digest());
  }
  return digest.digest("hex");
}

/**
 * What this tree would bake into the worker image, VANILLA (no plugin) —
 * harness/worker_image.py `source_digest(worker_dir)` byte for byte: the
 * Dockerfile and .dockerignore, plus the sibling sidecar tree under
 * `sidecar/`-prefixed rel paths. The sidecar dir is the build's second context,
 * hashed when it is there.
 */
async function workerSourceDigest(workerDir) {
  const entries = (await walkRelFiles(workerDir, workerDir)).filter(({ rel }) =>
    WORKER_BAKED_FILES.has(rel),
  );
  const sidecarDir = path.join(path.dirname(workerDir), "sidecar");
  const hasSidecar = (await fs.stat(sidecarDir).catch(() => null))?.isDirectory() === true;
  if (hasSidecar) {
    for (const { rel, full } of await walkRelFiles(sidecarDir, sidecarDir)) {
      const excluded =
        rel.endsWith(".DS_Store") || WORKER_SOURCE_EXCLUDED.some((prefix) => rel.startsWith(prefix));
      if (!excluded) entries.push({ rel: `sidecar/${rel}`, full });
    }
  }
  return relPathDigest(entries);
}

/**
 * The grader image's source identity — harness/grader_image.py
 * `source_digest(gates_dir, dockerfile)` byte for byte: every regular
 * non-symlink file under the gates dir, plus the Dockerfile itself (it pins the
 * base image and the installs, so it is part of the instrument).
 */
async function graderSourceDigest(graderDir, dockerfile) {
  const entries = (await walkRelFiles(graderDir, graderDir, { skipSymlinks: true })).filter(
    ({ rel }) => {
      const parts = rel.split("/");
      return (
        parts[parts.length - 1] !== ".DS_Store" &&
        !parts.some((part) => GRADER_SOURCE_EXCLUDED.has(part))
      );
    },
  );
  entries.push({ rel: "Dockerfile", full: dockerfile });
  return relPathDigest(entries);
}

/** The opencode version the worker Dockerfile pins (harness/worker_image.py). */
async function pinnedOpencodeVersion(workerDir) {
  const dockerfile = path.join(workerDir, "Dockerfile");
  for (const line of (await fs.readFile(dockerfile, "utf8")).split(/\r?\n/)) {
    if (line.startsWith(OPENCODE_ARG)) return line.slice(OPENCODE_ARG.length).trim();
  }
  throw new Error(`${dockerfile} pins no ${OPENCODE_ARG}`);
}

/** The commit the tree stands on — the full 40-char sha, never --short. */
async function sourceCommit(repoRoot) {
  const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  const commit = String(stdout).trim();
  if (!commit) throw new Error(`git reported no HEAD commit in ${repoRoot}`);
  return commit;
}

/** Whether the tree has uncommitted changes — a dirty run is not reproducible from its commit. */
async function sourceDirty(repoRoot) {
  const { stdout } = await execFileP("git", ["status", "--porcelain"], { cwd: repoRoot });
  return String(stdout).trim() !== "";
}

/**
 * The grader image identity a cell records (harness/grader_image.py): the
 * challenge's tag plus the digest of the gates and the Dockerfile that build
 * it. No docker — the tag is derived from challenge.json's name and the digest
 * is filesystem-only.
 */
async function graderImageIdentity(taskDir, graderDir, dockerfile) {
  const manifestPath = path.join(taskDir, "challenge.json");
  const spec = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const name = typeof spec?.name === "string" ? spec.name.trim() : "";
  if (!name) throw new Error(`${manifestPath} declares no challenge name`);
  return {
    image: `bench-grader:${name}`,
    source_digest: await graderSourceDigest(graderDir, dockerfile),
  };
}

/**
 * The CODE inputs as they stand now, all eleven: the four tree hashes over the
 * measured challenge, the harness hash, the source commit and whether the tree
 * is dirty, what this tree would bake into the worker image, the opencode
 * version the worker Dockerfile pins, the grader image identity, and the worker
 * image docker holds under the bench tag. Each is computed the way the harness
 * computes it at a cell's start (harness/fingerprint.py, worker_image.py,
 * grader_image.py), so the two never drift into disagreeing about what was
 * measured. Throws when any input cannot be computed: a batch that cannot be
 * checked is not called current.
 */
export async function currentCodeInputs({ repoRoot = REPO_ROOT } = {}) {
  const taskDir = path.join(repoRoot, ...TASK_REL);
  const workerDir = path.join(repoRoot, "images", "worker");
  const graderDir = path.join(repoRoot, "grader");
  const [
    chunk_plan_hash,
    grader_hash,
    scaffold_hash,
    golden_hash,
    harness_hash,
    source_commit,
    source_dirty,
    worker_source_digest,
    opencode_version,
    grader_image,
    image,
  ] = await Promise.all([
    hashDir(path.join(taskDir, "prompts")),
    hashDir(graderDir, { exclude: new Set(["node_modules", ".git", "test-results"]) }),
    hashDir(path.join(taskDir, "scaffold")),
    hashDir(path.join(taskDir, "golden")),
    hashDir(path.join(repoRoot, "harness"), { exclude: new Set(["__pycache__"]) }),
    sourceCommit(repoRoot),
    sourceDirty(repoRoot),
    workerSourceDigest(workerDir),
    pinnedOpencodeVersion(workerDir),
    graderImageIdentity(taskDir, graderDir, path.join(repoRoot, "images", "grader", "Dockerfile")),
    execFileP("docker", ["image", "inspect", WORKER_IMAGE_TAG, "--format", "{{.Id}}\n{{.Created}}"]),
  ]);
  const [image_id, created] = String(image.stdout).trim().split("\n");
  if (!image_id || !created) throw new Error(`docker did not identify ${WORKER_IMAGE_TAG}`);
  return {
    chunk_plan_hash,
    grader_hash,
    scaffold_hash,
    golden_hash,
    worker_image: { image_id, created },
    harness_hash,
    source_commit,
    source_dirty,
    worker_source_digest,
    opencode_version,
    grader_image,
  };
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
 * change after it ends, and re-assembling on every read would rewrite the record
 * for no reason. Only the appearance of a measurement where the record claims
 * none counts.
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
 * Re-assemble a batch from the cells as they now stand. The record is the
 * disk's: there is no operator pick to carry across (the average is taken per
 * fingerprint, not per chosen run).
 */
export async function assembleBatchForCells({ repoRoot = REPO_ROOT, runDir, cells, current = null }) {
  // The same scorability rule baselineFor applies: complete, not
  // void-instrument, and not out of context before anything was graded.
  const scored = (c) => c.state === "complete" && !c.void_instrument && !(c.context_exhausted === true && !c.gates);
  const voidReason = (c) => c.context_exhausted === true && !c.gates ? "context_exhausted"
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
 * What the BASELINES row shows inside a batch: every cell of it with its own
 * numbers, the median and the spread of the scored problem counts.
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

  return {
    median,
    spread: scoredCounts.length ? { min: Math.min(...scoredCounts), max: Math.max(...scoredCounts) } : null,
    scored_count: batch ? (batch.scored_count ?? scoredCounts.length) : 0,
    void_count: batch ? (batch.void_count ?? 0) : 0,
    cells: list,
  };
}

/**
 * The baseline for one model: its campaign's batch — the MEDIAN problem count
 * over the SCORED runs, fingerprint-bound (<runsRoot>/<run_dir>/batch.json). No
 * run is picked: every completed, non-void OFF cell is a baseline, and the
 * numbers a Δ is measured against are the per-fingerprint average across all of
 * them (`fingerprints`). The standing refusals (void, exhausted, pending,
 * never-run) are unchanged. The batch is assembled on first read and only
 * re-assembled when the cells on disk have outgrown it; nothing is fabricated.
 */
export async function baselineFor(model, offCells, { repoRoot = REPO_ROOT, runsRoot = null, current = currentGetter(repoRoot) } = {}) {
  const mine = offCells.filter((c) => c.model === model);
  // Out of room with nothing graded is not a baseline.
  const exhaustedUngraded = (c) => c.context_exhausted === true && !c.gates;
  const scorable = mine.filter(
    (c) => c.state === "complete" && !c.void_instrument && !exhaustedUngraded(c),
  );
  const exhausted = mine.filter(
    (c) => c.state === "complete" && !c.void_instrument && exhaustedUngraded(c),
  );
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
    // An existing batch is the record — read it, and assemble ONLY when absent
    // or stale: a re-assembly rewrites the record, so it is done for a reason.
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
    // does not. Re-assemble from the current cells.
    const persisted = await readBatch(runDir);
    const batch = persisted && !batchIsStale(persisted, batchCells)
      ? persisted
      : await assembleBatchForCells({ repoRoot, runDir, cells: batchCells, current });
    // Every read checks the recorded fingerprint against the code as it is
    // now: a batch the code has moved past is void, and says which input.
    if (await verifyAgainstCurrentCode(batch, { repoRoot, current })) await writeBatch(runDir, batch);

    // A fingerprint-void batch is never a baseline: its numbers measured a
    // different grader/prompts/scaffold/golden/image than the current one, so
    // every Δ against them would be invalid. Name the changed input; never
    // quietly reuse stale numbers. (The void is detected + persisted by
    // verifyAgainstCurrentCode; a freshly assembled batch is fingerprinted from
    // the current inputs and so is never void here.)
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

    // No pick, by design: the newest completed OFF cell names the row (an
    // identity plus its own measurement, for the card), while the numbers a Δ is
    // measured against are the per-fingerprint average in `fingerprints`. A
    // batch never has to be selected to be a baseline — choosing one cell WAS
    // the old measuring method.
    const rep = scorable[scorable.length - 1];
    return {
      exists: true,
      scorable: true,
      id: rep.id,
      run_dir: rep.run_dir,
      sequence_index: rep.sequence_index,
      // This cell's own problem count — one sample of the batch, not its median.
      measured_before: rep.problems_before,
      kind: rep.kind,
      provider: rep.provider,
      model_slug: rep.model_slug,
      turns: rep.turns,
      tokens: rep.tokens,
      wall_seconds: rep.wall_seconds,
      gates: rep.gates,
      verdict: rep.verdict,
      context_exhausted: rep.context_exhausted === true,
      // Run against an averaged baseline, never one cell.
      candidates: batch.scored_count,
      median: batch.median,
      batch: batchView(batchCells, batch),
      reason: null,
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
    reason: `no OFF cell has ever been run for ${model} — there is no baseline yet to measure a run against`,
  };
}

/**
 * Every baseline that exists: one row per model (a model has one campaign;
 * `candidates` is the batch's scored-run count — every scored run is one more
 * baseline). States: complete (a measured batch), running (in flight, refuses
 * runs), void (ran but measured the harness), exhausted (out of context before
 * grading), none (no row).
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
    const state = b.scorable
      ? "complete"
      : b.voided
        ? "void"
        : b.exhausted
          ? "exhausted"
          : b.pending
            ? "running"
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
      // The batch's median problem count — the row's measurement. Null when no
      // batch was ever assembled.
      median: b.median ?? null,
      // Why the batch is void (state "void"): superseded / mixed /
      // unfingerprinted, the input concerned, and the sentence; else null.
      void_kind: b.void_kind ?? null,
      void_input: b.void_input ?? null,
      void_reason: b.void_reason ?? null,
      // The batch's cells, median and spread (batchView); null for a row with
      // no batch behind it.
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
const BASELINES_CONTRACT_VERSION = 2;

/** The per-cell fields the fingerprint aggregate averages, off `phases.total`. */
const AGGREGATE_COST_FIELDS = [
  "context_peak",
  "wall_seconds",
  "turns",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
];

/**
 * Does this cell's numbers belong in its fingerprint's aggregate? Same rule the
 * baseline uses — complete, not void, not context-exhausted-ungraded — plus the
 * two the aggregate adds: the harness must have stamped a phase total to
 * average, and the cell must carry a fingerprint the current input set can
 * still hash (a record short of an input belongs to no fingerprint).
 */
function countsTowardFingerprint(c) {
  return c.state === "complete"
    && !c.void_instrument
    && !(c.context_exhausted === true && !c.gates)
    && Boolean(c.cost?.phases?.total);
}

/**
 * Per-fingerprint baselines: how many completed non-void OFF cells ran on
 * exactly this code, and what they cost on average.
 *
 * A FIELD ABSENT IN EVERY CELL IS null, never 0 — an unmeasured covariate is
 * not a free one. Each field averages over the cells that HAVE it, so a cell
 * whose stamp omitted `context_peak` cannot drag the mean toward zero.
 */
function fingerprintBaselines(cells) {
  const groups = new Map();
  for (const c of cells) {
    if (!countsTowardFingerprint(c)) continue;
    let hash;
    try {
      hash = computeFingerprint(c.fingerprint).hash;
    } catch {
      // An incomplete or pre-standard record: outside every fingerprint.
      continue;
    }
    const group = groups.get(hash) ?? { model: c.model ?? null, totals: [] };
    group.totals.push(c.cost.phases.total);
    groups.set(hash, group);
  }

  const fingerprints = [];
  for (const [fingerprint_hash, group] of groups) {
    const avg = {};
    for (const field of AGGREGATE_COST_FIELDS) {
      const values = group.totals
        .map((total) => total?.[field])
        .filter((v) => typeof v === "number" && Number.isFinite(v));
      avg[field] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    }
    fingerprints.push({
      fingerprint_hash,
      model: group.model,
      baseline_count: group.totals.length,
      avg,
    });
  }

  // By model, then the most-repeated fingerprint first.
  fingerprints.sort((a, b) =>
    String(a.model ?? "").localeCompare(String(b.model ?? ""))
    || b.baseline_count - a.baseline_count);
  return fingerprints;
}

/**
 * Every bench model's baseline. A model with no OFF cell still gets
 * `exists: false` and a reason, so the UI can render its gate.
 */
async function buildBaselineIndex({ runsRoot, models }) {
  const offCells = await collectOffCells(runsRoot);
  // The floor is about NOW; the aggregate is a HISTORY — a reset rotates runs
  // into runs/backups, and the count of baselines gathered on a fingerprint
  // must survive that. Only the aggregate reads rotated trees.
  const historyCells = await collectOffCells(runsRoot, { includeBackups: true });
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
    // One row per fingerprint ever measured: how many baselines were gathered on
    // it (live and rotated) and the average cost across them.
    fingerprints: fingerprintBaselines(historyCells),
    counts: {
      complete: list.filter((b) => b.state === "complete").length,
      running: list.filter((b) => b.state === "running").length,
      void: list.filter((b) => b.state === "void").length,
      exhausted: list.filter((b) => b.state === "exhausted").length,
    },
    note:
      "forever baselines — every completed, non-void OFF cell is a baseline. A baseline "
      + "accumulates onto its fingerprint — baselines that share one are counted and averaged "
      + "together (context, wall time, turns, tokens), each field over the cells that measured it; "
      + "a different fingerprint is a different family. A void-instrument cell is no baseline.",
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
