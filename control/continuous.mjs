// CONTINUOUS MODE — when a run ends, the next one starts from its end snapshot,
// and so on until the model passes everything.
//
// Set on the + baseline sequence's confirm frame, for a system already judged
// healthy: there is no analysis between runs and no judgement of faults. The
// chain drives this process's OWN routes — tree reset, arm, preflight, preview,
// start — in the order an operator's run takes, so a chained run passes every
// gate a hand-started one does and is refused for the same reasons.
//
// The state is one file beside the armed snapshot (config/continuous.json): a
// tree reset never moves it, and a restart picks the chain up where it was.
// Each run's outcome is written down BEFORE the reset that archives its folder,
// so a restart mid-chain never needs to read a run that has moved.
//
// The chain ENDS — it never retries — when the model passes everything, a run
// is stopped, a run leaves no end snapshot, or any step is refused. It WAITS
// (the next tick) only while a substrate refresh is running. It never resets the
// tree under a cell in flight, and a chained run must preview as seeded from the
// snapshot it armed, or the chain ends rather than start a fresh build.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { readCellEnd } from "./baselines.mjs";
import { cellDirForRun, readRunState } from "./runstate.mjs";
import { getRun } from "./run-ledger.mjs";
import { resolveDevMode } from "./devmode.mjs";
import { substrateRefreshInFlight } from "./tooljobs.mjs";

export const CONTINUOUS_ENV_VAR = "BENCH_CONTINUOUS_FILE";

/** How often the chain looks at its run. */
export const CHAIN_TICK_MS = 15_000;

export function chainStateFile(benchRoot, env = process.env) {
  return env[CONTINUOUS_ENV_VAR] || join(benchRoot, "config", "continuous.json");
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The chain, or null when none was ever started. */
export async function readChain({ benchRoot, env = process.env } = {}) {
  const raw = await readJsonOrNull(chainStateFile(benchRoot, env));
  return raw && Array.isArray(raw.links) ? raw : null;
}

/** Written whole through a temp file, so a reader never sees half a chain. */
async function writeChain({ benchRoot, env = process.env }, state) {
  const path = chainStateFile(benchRoot, env);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  return state;
}

/**
 * The payload every chained run repeats: the operator's own start request,
 * without the one-time parts (the confirmation, the continuous flag itself, and
 * a cell count, which is always one).
 */
export function chainPayload(payload) {
  const { confirm, continuous, concurrency, ...rest } = payload ?? {};
  return rest;
}

/** Start a chain at its first run (the start route, after a launch). */
export async function beginChain({ benchRoot, env = process.env, payload, link, now = Date.now() }) {
  return writeChain({ benchRoot, env }, {
    active: true,
    started_at: now,
    payload: chainPayload(payload),
    links: [{ n: 1, outcome: null, ...link }],
    waiting: null,
    ended: null,
  });
}

/** End the chain with its reason. A chain that is not running is left as it is. */
export async function endChain({ benchRoot, env = process.env, code, reason, now = Date.now() }) {
  const state = await readChain({ benchRoot, env });
  if (!state?.active) return state;
  return writeChain({ benchRoot, env }, { ...state, active: false, waiting: null, ended: { at: now, code, reason } });
}

/**
 * How a run ended, read from what the harness wrote: the verdict and the reason
 * from the cell's own cell.end, the end snapshot from its campaign manifest.
 */
export async function readOutcome({ runsRoot, link }) {
  const cell = await cellDirForRun(runsRoot, link.run_dir, link.sequence_index);
  const end = cell ? await readCellEnd(join(runsRoot, cell.cellDir)) : null;
  const manifest = link.run_dir ? await readJsonOrNull(join(runsRoot, link.run_dir, "manifest.json")) : null;
  const rec = (Array.isArray(manifest?.session_records) ? manifest.session_records : [])
    .find((r) => r?.sequence_index === link.sequence_index);
  return {
    verdict: end?.verdict ?? null,
    terminal_reason: end?.terminal_reason ?? null,
    produced_snapshot_id: str(rec?.produced_snapshot_id),
  };
}

/** What follows run n: { end: { code, reason } } or { chain: <snapshot id> }. */
export function decide(outcome, n) {
  if (outcome.verdict === "PASS") {
    return { end: { code: "passed", reason: `the model passed everything in run ${n}` } };
  }
  if (outcome.terminal_reason === "stopped") {
    return { end: { code: "run_stopped", reason: `run ${n} was stopped` } };
  }
  if (outcome.produced_snapshot_id) return { chain: outcome.produced_snapshot_id };
  return {
    end: {
      code: "no_end_snapshot",
      reason:
        `run ${n} ended (${outcome.terminal_reason ?? "no end recorded"}) without an end snapshot — ` +
        "there is nothing to continue from",
    },
  };
}

function refusal(step, res) {
  return `${step} refused — ${res.data?.code ?? `HTTP ${res.status}`}: ${res.data?.reason ?? "no reason given"}`;
}

let ticking = false;

/**
 * One look at the chain. Does nothing while its run is in flight; when the run
 * has ended, writes down how, then ends the chain or starts the next run.
 * Overlapping ticks are dropped, never queued. Anything that throws ends the
 * chain with the error: a step that failed in a way nobody named is not retried.
 */
export async function chainTick(deps) {
  if (ticking) return;
  ticking = true;
  try {
    await tickOnce(deps);
  } catch (err) {
    const reason = `the chain failed: ${err?.message ?? err}`;
    deps.log(`[continuous] ${reason}`);
    await endChain({ benchRoot: deps.benchRoot, env: deps.env ?? process.env, code: "chain_error", reason, now: deps.now() });
  } finally {
    ticking = false;
  }
}

async function tickOnce(deps) {
  const io = { benchRoot: deps.benchRoot, env: deps.env ?? process.env };
  let state = await readChain(io);
  if (!state?.active) return;
  const link = state.links[state.links.length - 1];

  if (!link.outcome) {
    if (await deps.isLive(link.run_id)) return;
    link.outcome = await deps.readOutcome(link);
    state = await writeChain(io, state);
    deps.log(`[continuous] run ${link.n} ended: ${JSON.stringify(link.outcome)}`);
  }

  const next = decide(link.outcome, link.n);
  const end = async (code, reason) => {
    deps.log(`[continuous] ended after run ${link.n}: ${code} — ${reason}`);
    await endChain({ ...io, code, reason, now: deps.now() });
  };
  if (next.end) return end(next.end.code, next.end.reason);
  const snapshot = next.chain;

  const refresh = deps.refreshInFlight();
  if (refresh) {
    const waiting = `'${refresh.tool_name}' is running and changes the substrate — run ${link.n + 1} starts when it finishes`;
    if (state.waiting !== waiting) await writeChain(io, { ...state, waiting });
    return;
  }
  if (!(await deps.devModeOn())) {
    return end("dev_mode_off", `run ${link.n + 1} starts from snapshot ${snapshot}, and seeding is a dev-mode capability — dev mode is off`);
  }
  if (await deps.cellInFlight()) {
    return end("cell_in_flight", "a cell outside the chain is in flight — the chain never resets the tree under a running cell");
  }

  // A restart after the reset finds the run's folder already archived.
  if (deps.runDirExists(link.run_dir)) {
    const preview = await deps.call("POST", "/api/tree/reset/preview", {});
    if (!preview.ok) return end("reset_refused", refusal("tree reset", preview));
    const reset = await deps.call("POST", "/api/tree/reset", { confirm: preview.data.token });
    if (!reset.ok) return end("reset_refused", refusal("tree reset", reset));
  }

  const payload = state.payload;
  const armed = await deps.call("POST", "/api/snapshots/arm", { snapshot_id: snapshot, model: payload.model });
  if (!armed.ok) return end("arm_refused", refusal("arming the snapshot", armed));

  // The board's preflight: compaction is checked unless explicitly off.
  const query = new URLSearchParams({ model: payload.model });
  if (payload.compact !== false) query.set("compact", "1");
  const pf = await deps.call("GET", `/api/preflight?${query}`);
  if (!pf.ok || pf.data?.verdict !== "go" || (pf.data?.blocking_failures ?? 0) !== 0) {
    const failed = (pf.data?.checks ?? []).filter((c) => c.status !== "pass");
    return end(
      "preflight_failed",
      `preflight ${pf.data?.verdict ?? `HTTP ${pf.status}`} — ` +
        (failed.map((c) => `${c.id ?? c.name}: ${c.detail ?? "failed"}`).join(" · ") || "no check named"),
    );
  }

  const preview = await deps.call("POST", "/api/run/preview", payload);
  if (!preview.ok) return end("preview_refused", refusal("the run preview", preview));
  if (!String(preview.data?.token ?? "").split("|").includes(`snapshotId=${snapshot}`)) {
    return end("not_seeded", `run ${link.n + 1} previewed without snapshot ${snapshot} armed — the chain never starts a fresh build in its place`);
  }
  const started = await deps.call("POST", "/api/run/start", { ...payload, confirm: preview.data.token });
  if (!started.ok) return end("start_refused", refusal("the run start", started));

  const run = started.data.runs[0];
  state.links.push({
    n: link.n + 1,
    run_id: run.run_id,
    run_dir: deps.runRecord(run.run_id)?.run_dir ?? null,
    sequence_index: run.sequence_index,
    log_path: run.log_path,
    seeded_from: snapshot,
    started_at: deps.now(),
    outcome: null,
  });
  await writeChain(io, { ...state, waiting: null });
  deps.log(`[continuous] run ${link.n + 1} started from snapshot ${snapshot}`);
}

/** A request to this control plane, answered as { status, ok, data }. */
async function callSelf(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok && data !== null && data.ok !== false, data };
}

/** The chain's watcher, started once the control plane is listening. */
export function startChainLoop({ benchRoot, runsRoot, port }) {
  const deps = {
    benchRoot,
    now: () => Date.now(),
    log: (msg) => console.log(msg),
    isLive: async (runId) => ((await readRunState({ runsRoot })).runs ?? []).some((r) => r.run_id === runId),
    cellInFlight: async () => (await readRunState({ runsRoot })).running === true,
    readOutcome: (link) => readOutcome({ runsRoot, link }),
    refreshInFlight: () => substrateRefreshInFlight(benchRoot),
    devModeOn: async () => (await resolveDevMode({ benchRoot })).enabled === true,
    runDirExists: (runDir) => Boolean(runDir) && existsSync(join(runsRoot, runDir)),
    runRecord: (runId) => getRun(runId) ?? null,
    call: (method, path, body) => callSelf(port, method, path, body),
  };
  setInterval(() => {
    // Only the final endChain can reject here (the state file unwritable).
    chainTick(deps).catch((err) => console.error(`[continuous] could not record the chain's end: ${err?.message ?? err}`));
  }, CHAIN_TICK_MS).unref?.();
}
