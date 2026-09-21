// TOOL JOBS — a tool run is a tracked background job, not a held HTTP request.
//
// The old contract kept POST /api/tools/run open for the whole run (up to the
// timeout): the only UI state was "RUNNING", output arrived at the end, and a
// dropped connection lost the verdict while the work kept going invisibly.
// Here the POST only STARTS the job; the record is persisted (it survives a
// control-plane restart) and published on the board frame
// (sources/tool-jobs.mjs), so the drawer shows live output, elapsed time and
// the final verdict to any client, whenever it attaches.
//
// One job per tool at a time: a second click joins the running job instead of
// starting an overlapping rebuild. A running job whose tool changes the
// substrate also blocks launching a cell (lib/validate.mjs) — the same rule as
// refusing the tool during a cell, one level up.

import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveTool } from "./tools.mjs";

/** Per-job live log cap: docker's own output, tailed (interleaved streams). */
const OUTPUT_TAIL_BYTES = 32 * 1024;
/** The store keeps this many jobs on disk, newest first. */
const JOBS_KEPT = 25;
/** Output is chatty; persist at most this often mid-run (always on settle). */
const PERSIST_MS = 400;

// benchRoot → { jobs: [...] } — loaded once per root, then owned in memory.
const stores = new Map();

function storePath(benchRoot) {
  return join(benchRoot, "data", "tool-jobs.json");
}

function loadStore(benchRoot) {
  let s = stores.get(benchRoot);
  if (s) return s;
  s = { jobs: [], lastWrite: 0 };
  try {
    const parsed = JSON.parse(readFileSync(storePath(benchRoot), "utf8"));
    if (Array.isArray(parsed?.jobs)) s.jobs = parsed.jobs.filter((j) => j && typeof j === "object");
  } catch {
    // Absent or unreadable: start empty. A corrupt store must not stop tools.
  }
  // A job still "running" here outlived its control plane. Its process may
  // have finished in the background (docker builds live with the daemon) —
  // the honest verdict is "unknown", not success, and preflight is the check
  // that can actually answer.
  let reaped = false;
  for (const j of s.jobs) {
    if (j.status === "running") {
      j.status = "failed";
      j.code = "interrupted";
      j.reason =
        "the control plane restarted while this job was running — its process may " +
        "have finished in the background, but the result was not recorded. Trust " +
        "preflight, not this line: re-press the tool only if preflight still says " +
        "the part is stale.";
      j.ended_at = new Date().toISOString();
      reaped = true;
    }
  }
  stores.set(benchRoot, s);
  if (reaped) persist(benchRoot, s, true);
  return s;
}

function persist(benchRoot, s, force = false) {
  const now = Date.now();
  if (!force && now - s.lastWrite < PERSIST_MS) return;
  s.lastWrite = now;
  try {
    mkdirSync(dirname(storePath(benchRoot)), { recursive: true });
    const tmp = `${storePath(benchRoot)}.tmp`;
    // Atomic rename: a reader never sees a half-written store.
    writeFileSync(tmp, JSON.stringify({ jobs: s.jobs.slice(0, JOBS_KEPT) }));
    renameSync(tmp, storePath(benchRoot));
  } catch {
    // The in-memory record is the live one; a lost write is a lost history line.
  }
}

/** The job as the board publishes it (the in-memory record, minus nothing). */
function publicJob(j) {
  return {
    id: j.id,
    tool_id: j.tool_id,
    tool_name: j.tool_name,
    status: j.status,
    code: j.code,
    reason: j.reason,
    started_at: j.started_at,
    ended_at: j.ended_at,
    last_output_at: j.last_output_at,
    output_tail: j.output_tail,
    result: j.result ?? null,
    reload_page: j.reload_page === true,
    external: j.external === true,
  };
}

/** Every job, newest first — what the board source publishes. */
export function listToolJobs(benchRoot) {
  return loadStore(benchRoot).jobs.map(publicJob);
}

/** The running job for one tool, or null. */
export function runningJobFor(benchRoot, toolId) {
  const j = loadStore(benchRoot).jobs.find(
    (x) => x.tool_id === String(toolId) && x.status === "running",
  );
  return j ? publicJob(j) : null;
}

/**
 * A running job whose tool changes the substrate (the same property that
 * refuses the tool during a cell) blocks a launch, or null. Read from the
 * store, not the registry: the answer must not depend on the custom-tools
 * service being up.
 */
export function substrateRefreshInFlight(benchRoot) {
  const j = loadStore(benchRoot).jobs.find((x) => x.status === "running" && x.blocks_runs);
  return j ? publicJob(j) : null;
}

/**
 * Start a tool as a tracked job. Returns immediately:
 *   { ok: true, code: "started" | "already_running", job }
 *   { ok: false, code, reason } — the resolveTool refusals, before any job
 *   exists (unknown tool, blocked precondition, missing argument).
 */
export async function startToolJob(benchRoot, id, args = {}) {
  const s = loadStore(benchRoot);

  // One job per tool: a second click joins the job already running instead of
  // starting an overlapping rebuild.
  const existing = s.jobs.find((j) => j.tool_id === String(id) && j.status === "running");
  if (existing) return { ok: true, code: "already_running", job: publicJob(existing) };

  const resolved = await resolveTool(benchRoot, id, args);
  if (!resolved.ok) return resolved;
  const { tool, handler, picked } = resolved;

  // A tool that restarts this process orphans every running job's record.
  if (tool.orphans_jobs === true) {
    const other = s.jobs.find((j) => j.status === "running");
    if (other) {
      return {
        ok: false,
        code: "job_in_flight",
        reason:
          `'${other.tool_name}' is still running — restarting the control plane now ` +
          `would orphan it (its verdict would be lost). Wait for it to finish; the ☰ menu shows it live.`,
      };
    }
  }

  const job = {
    id: `tj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    tool_id: tool.id,
    tool_name: tool.name,
    status: "running",
    code: null,
    reason: null,
    started_at: new Date().toISOString(),
    ended_at: null,
    last_output_at: null,
    output_tail: "",
    result: null,
    reload_page: tool.reload_page === true,
    external: tool.external === true,
    blocks_runs: tool.refuse_while_running === true,
  };
  s.jobs.unshift(job);
  s.jobs = s.jobs.slice(0, JOBS_KEPT);
  persist(benchRoot, s, true);

  // Fire and forget: the request already has its answer; the handler settles
  // the record. A job is never awaited by the request that started it.
  void settle(benchRoot, job, tool, handler, picked);
  return { ok: true, code: "started", job: publicJob(job) };
}

async function settle(benchRoot, job, tool, handler, picked) {
  const s = loadStore(benchRoot);
  const onChunk = (stream, text) => {
    job.output_tail = (job.output_tail + text).slice(-OUTPUT_TAIL_BYTES);
    job.last_output_at = new Date().toISOString();
    persist(benchRoot, s);
  };

  let out;
  try {
    if (tool.invoke?.kind === "service") {
      // A custom tool streams nothing through this contract (CUSTOM-TOOLS.md):
      // say so, and let the clock be the live signal.
      onChunk(
        "stdout",
        `asking the custom-tools service at ${tool.invoke.url} — it reports only when done; ` +
          `the elapsed clock on the card is live.\n`,
      );
      out = await handler({ ...tool.invoke, benchRoot, args: picked });
      if (out.stdout) onChunk("stdout", out.stdout);
      if (out.stderr) onChunk("stderr", out.stderr);
    } else {
      out = await handler({ ...tool.invoke, benchRoot, args: picked, onChunk });
    }
  } catch (err) {
    out = { ok: false, code: "handler_failed", reason: String(err?.message ?? err) };
  }

  job.status = out.ok ? "succeeded" : "failed";
  job.code = out.code ?? (out.ok ? "ok" : "tool_failed");
  job.reason = out.reason ?? null;
  job.result = out.result ?? null;
  // The verdict travels in the tail too: the settled card shows the same log
  // the live view did.
  if (!job.output_tail && (out.stdout || out.stderr)) {
    onChunk("stdout", [out.stdout, out.stderr].filter(Boolean).join("\n"));
  }
  job.ended_at = new Date().toISOString();
  persist(benchRoot, s, true);
}

/** Test hook: forget the cached store for a bench root. */
export function _forgetStore(benchRoot) {
  stores.delete(benchRoot);
}
