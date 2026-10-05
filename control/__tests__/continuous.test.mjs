// ─────────────────────────────────────────────────────────────────────────────
// CONTINUOUS MODE TESTS — control/continuous.mjs: the chain's state, how a run's
// end decides what follows, the tick's step order against fake routes, and the
// start's refusals (lib/validate.mjs) and confirmation (contract.mjs).
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  beginChain,
  chainPayload,
  chainTick,
  decide,
  endChain,
  readChain,
  readOutcome,
} from "../continuous.mjs";
import { confirmationToken, restatement } from "../contract.mjs";
import { finishValidate } from "../lib/validate.mjs";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "okp-continuous-"));
  return { benchRoot: root, env: { BENCH_CONTINUOUS_FILE: join(root, "config", "continuous.json") } };
}

const PAYLOAD = { model: "m-a", arm: "off", kind: "local", requireTodos: false, graderWorkerTarget: 0.5 };
const FIRST = { run_id: "r1", run_dir: "t1/local/m-a", sequence_index: 0, log_path: "/l/1.log", seeded_from: null, started_at: 1 };

async function chainAt(io, link = FIRST) {
  await beginChain({ ...io, payload: { ...PAYLOAD, confirm: "tok", continuous: true, concurrency: 1 }, link, now: 1 });
}

/** Fake routes: answers by "METHOD path" (query dropped), records every call. */
function fakeDeps(io, over = {}) {
  const calls = [];
  const answers = {
    "POST /api/tree/reset/preview": { status: 200, ok: true, data: { ok: true, token: "reset-tok" } },
    "POST /api/tree/reset": { status: 200, ok: true, data: { ok: true } },
    "POST /api/snapshots/arm": { status: 200, ok: true, data: { ok: true } },
    "GET /api/preflight": { status: 200, ok: true, data: { verdict: "go", blocking_failures: 0, checks: [] } },
    "POST /api/run/preview": { status: 200, ok: true, data: { ok: true, token: "model=m-a|arm=off|snapshotId=S1" } },
    "POST /api/run/start": {
      status: 200,
      ok: true,
      data: { ok: true, runs: [{ run_id: "r2", sequence_index: 0, log_path: "/l/2.log", launched: true }] },
    },
    ...(over.answers ?? {}),
  };
  return {
    calls,
    deps: {
      ...io,
      now: () => 99,
      log: () => {},
      isLive: async () => false,
      readOutcome: async () => ({ verdict: "FAIL", terminal_reason: "attempt_ceiling_reached", produced_snapshot_id: "S1" }),
      refreshInFlight: () => null,
      devModeOn: async () => true,
      cellInFlight: async () => false,
      runDirExists: () => true,
      runRecord: () => ({ run_dir: "t2/local/m-a" }),
      call: async (method, path, body) => {
        calls.push([method, path.split("?")[0], body]);
        return answers[`${method} ${path.split("?")[0]}`];
      },
      ...over.deps,
    },
  };
}

// ── STATE ────────────────────────────────────────────────────────────────────

test("CONTINUOUS: the chained payload drops the confirmation, the flag and the cell count", () => {
  assert.deepEqual(chainPayload({ ...PAYLOAD, confirm: "x", continuous: true, concurrency: 1 }), PAYLOAD);
});

test("CONTINUOUS: a chain begins at run 1 and ends with its reason, once", async () => {
  const io = sandbox();
  assert.equal(await readChain(io), null, "no chain was ever started");
  await chainAt(io);
  const begun = await readChain(io);
  assert.equal(begun.active, true);
  assert.deepEqual(begun.payload, PAYLOAD);
  assert.equal(begun.links[0].n, 1);
  assert.equal(begun.links[0].outcome, null);

  await endChain({ ...io, code: "operator_end", reason: "ended from the board", now: 5 });
  const ended = await readChain(io);
  assert.equal(ended.active, false);
  assert.deepEqual(ended.ended, { at: 5, code: "operator_end", reason: "ended from the board" });

  // Ending an ended chain changes nothing: the first reason stands.
  await endChain({ ...io, code: "operator_stop", reason: "later", now: 6 });
  assert.deepEqual((await readChain(io)).ended, ended.ended);
});

// ── WHAT FOLLOWS A RUN ───────────────────────────────────────────────────────

test("CONTINUOUS: passing everything ends the chain; a stuck run with an end snapshot chains", () => {
  assert.equal(decide({ verdict: "PASS", terminal_reason: "gates_green", produced_snapshot_id: null }, 3).end.code, "passed");
  assert.equal(decide({ verdict: "FAIL", terminal_reason: "stopped", produced_snapshot_id: null }, 3).end.code, "run_stopped");
  assert.deepEqual(decide({ verdict: "FAIL", terminal_reason: "context_exhausted", produced_snapshot_id: "S9" }, 3), { chain: "S9" });
  const none = decide({ verdict: "FAIL", terminal_reason: "transport_incomplete", produced_snapshot_id: null }, 3);
  assert.equal(none.end.code, "no_end_snapshot");
  assert.match(none.end.reason, /run 3 ended \(transport_incomplete\)/);
});

test("CONTINUOUS: a run's outcome is read from its cell.end and its campaign manifest", async () => {
  const runsRoot = mkdtempSync(join(tmpdir(), "okp-continuous-runs-"));
  const runDir = "t1/local/local-llm-proxy/omlx/m-a";
  const cell = join(runsRoot, runDir, "memoryOFF", "cell-0000");
  mkdirSync(cell, { recursive: true });
  writeFileSync(join(cell, "live.jsonl"), [
    JSON.stringify({ kind: "cell.start", cell_seq: 0 }),
    JSON.stringify({ kind: "cell.end", verdict: "FAIL", terminal_reason: "attempt_ceiling_reached" }),
  ].join("\n") + "\n");
  writeFileSync(join(runsRoot, runDir, "manifest.json"), JSON.stringify({
    session_records: [{ sequence_index: 0, produced_snapshot_id: "1791-end" }],
  }));
  assert.deepEqual(await readOutcome({ runsRoot, link: { run_dir: runDir, sequence_index: 0 } }), {
    verdict: "FAIL",
    terminal_reason: "attempt_ceiling_reached",
    produced_snapshot_id: "1791-end",
  });
});

// ── THE TICK ─────────────────────────────────────────────────────────────────

test("CONTINUOUS: nothing happens while the chain's run is in flight", async () => {
  const io = sandbox();
  await chainAt(io);
  const { calls, deps } = fakeDeps(io, { deps: { isLive: async () => true } });
  await chainTick(deps);
  assert.deepEqual(calls, []);
  assert.equal((await readChain(io)).links[0].outcome, null);
});

test("CONTINUOUS: a stuck run is followed by reset, arm, preflight, preview and start, in that order", async () => {
  const io = sandbox();
  await chainAt(io);
  const { calls, deps } = fakeDeps(io);
  await chainTick(deps);
  assert.deepEqual(calls.map(([m, p]) => `${m} ${p}`), [
    "POST /api/tree/reset/preview",
    "POST /api/tree/reset",
    "POST /api/snapshots/arm",
    "GET /api/preflight",
    "POST /api/run/preview",
    "POST /api/run/start",
  ]);
  assert.deepEqual(calls[1][2], { confirm: "reset-tok" });
  assert.deepEqual(calls[2][2], { snapshot_id: "S1", model: "m-a" });
  assert.deepEqual(calls[4][2], PAYLOAD, "every chained run repeats the operator's payload");
  assert.deepEqual(calls[5][2], { ...PAYLOAD, confirm: "model=m-a|arm=off|snapshotId=S1" });

  const state = await readChain(io);
  assert.equal(state.active, true);
  assert.equal(state.links[0].outcome.produced_snapshot_id, "S1", "the outcome is written down before the reset");
  assert.deepEqual(
    { ...state.links[1] },
    { n: 2, run_id: "r2", run_dir: "t2/local/m-a", sequence_index: 0, log_path: "/l/2.log", seeded_from: "S1", started_at: 99, outcome: null },
  );
});

test("CONTINUOUS: a restart after the reset does not reset again", async () => {
  const io = sandbox();
  await chainAt(io);
  const { calls, deps } = fakeDeps(io, { deps: { runDirExists: () => false } });
  await chainTick(deps);
  assert.equal(calls[0][1], "/api/snapshots/arm");
  assert.equal(calls.some(([, p]) => p.startsWith("/api/tree/reset")), false);
});

test("CONTINUOUS: passing everything ends the chain without a call", async () => {
  const io = sandbox();
  await chainAt(io);
  const { calls, deps } = fakeDeps(io, {
    deps: { readOutcome: async () => ({ verdict: "PASS", terminal_reason: "gates_green", produced_snapshot_id: null }) },
  });
  await chainTick(deps);
  assert.deepEqual(calls, []);
  const state = await readChain(io);
  assert.equal(state.active, false);
  assert.equal(state.ended.code, "passed");
  assert.match(state.ended.reason, /passed everything in run 1/);
});

test("CONTINUOUS: a preview that is not seeded from the armed snapshot never starts", async () => {
  const io = sandbox();
  await chainAt(io);
  const { calls, deps } = fakeDeps(io, {
    answers: { "POST /api/run/preview": { status: 200, ok: true, data: { ok: true, token: "model=m-a|arm=off|snapshotId=" } } },
  });
  await chainTick(deps);
  assert.equal(calls.some(([, p]) => p === "/api/run/start"), false);
  assert.equal((await readChain(io)).ended.code, "not_seeded");
});

test("CONTINUOUS: a refused step ends the chain with the server's own reason, and stops there", async () => {
  const io = sandbox();
  await chainAt(io);
  const { calls, deps } = fakeDeps(io, {
    answers: { "POST /api/snapshots/arm": { status: 409, ok: false, data: { ok: false, code: "not_seedable", reason: "built by another model" } } },
  });
  await chainTick(deps);
  assert.equal(calls[calls.length - 1][1], "/api/snapshots/arm");
  const state = await readChain(io);
  assert.equal(state.ended.code, "arm_refused");
  assert.match(state.ended.reason, /not_seedable: built by another model/);
});

test("CONTINUOUS: a refresh in flight waits; dev mode off and a foreign cell end the chain", async () => {
  const waitIo = sandbox();
  await chainAt(waitIo);
  const waiting = fakeDeps(waitIo, { deps: { refreshInFlight: () => ({ tool_name: "worker image rebuild" }) } });
  await chainTick(waiting.deps);
  assert.deepEqual(waiting.calls, []);
  const held = await readChain(waitIo);
  assert.equal(held.active, true);
  assert.match(held.waiting, /worker image rebuild/);

  const devIo = sandbox();
  await chainAt(devIo);
  await chainTick(fakeDeps(devIo, { deps: { devModeOn: async () => false } }).deps);
  assert.equal((await readChain(devIo)).ended.code, "dev_mode_off");

  const busyIo = sandbox();
  await chainAt(busyIo);
  const busy = fakeDeps(busyIo, { deps: { cellInFlight: async () => true } });
  await chainTick(busy.deps);
  assert.deepEqual(busy.calls, [], "the tree is never reset under a running cell");
  assert.equal((await readChain(busyIo)).ended.code, "cell_in_flight");
});

test("CONTINUOUS: anything that throws ends the chain with the error, never a retry", async () => {
  const io = sandbox();
  await chainAt(io);
  await chainTick(fakeDeps(io, { deps: { call: async () => { throw new Error("socket hang up"); } } }).deps);
  const state = await readChain(io);
  assert.equal(state.ended.code, "chain_error");
  assert.match(state.ended.reason, /socket hang up/);
});

// ── THE START ────────────────────────────────────────────────────────────────

test("CONTINUOUS: the confirmation separates a chain from one run, and the restatement says so", () => {
  const p = { model: "m", arm: "off", org: null, context: null, kind: "local", compact: false, snapshotId: null };
  assert.equal(confirmationToken(p), confirmationToken({ ...p, continuous: false }), "off leaves every existing token as it was");
  assert.notEqual(confirmationToken({ ...p, continuous: true }), confirmationToken(p));
  assert.match(restatement({ ...p, continuous: true }), /continuous: ON/);
  assert.doesNotMatch(restatement(p), /continuous/);
});

async function validateContinuous(payload, env) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  delete process.env.BENCH_SEED_SNAPSHOT;
  try {
    return await finishValidate(
      { model: "m-a", arm: payload.arm ?? "off", org: null, context: null, kind: "local", entry: {}, cloud: null },
      { requireConfirm: false, runsRoot: null, payload },
    );
  } finally {
    process.env = saved;
  }
}

test("CONTINUOUS: the start refuses a chain on the ON arm, with several cells, with dev mode off, or beside another chain", async () => {
  const io = sandbox();
  const env = {
    BENCH_DEV_MODE: "on",
    BENCH_CONTINUOUS_FILE: io.env.BENCH_CONTINUOUS_FILE,
    BENCH_SEED_SNAPSHOT_FILE: join(io.benchRoot, "config", "armed-snapshot.json"),
  };
  const ok = await validateContinuous({ continuous: true }, env);
  assert.equal(ok.ok, true);
  assert.equal(ok.continuous, true);

  assert.equal((await validateContinuous({ continuous: true, concurrency: 2 }, env)).code, "continuous_one_cell");
  assert.equal((await validateContinuous({ continuous: true }, { ...env, BENCH_DEV_MODE: "off" })).code, "dev_mode_off");
  assert.equal((await validateContinuous({ continuous: false, concurrency: 2 }, { ...env, BENCH_DEV_MODE: "off" })).ok, true,
    "a run without the flag is untouched");

  await chainAt(io);
  assert.equal((await validateContinuous({ continuous: true }, env)).code, "continuous_active");
});
