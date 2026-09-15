// ─────────────────────────────────────────────────────────────────────────────
// LIVENESS HEARTBEAT TESTS — split VERBATIM from control/control.test.mjs
// (lines 3779–3951 + local helper writeLiveStream, 3769–3777).
// NOTE: dynamic import("./runstate.mjs") specifiers shifted to "../runstate.mjs"
// — they resolve relative to THIS module; everything else is byte-identical.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STALL_THRESHOLD_S } from "../contract.mjs";
import { campaignDirName } from "../campaign.mjs";
import { readRunState } from "../runstate.mjs";
import { BENCH, writeCampaignCell } from "./_shared.mjs";

function writeLiveStream(runs, campaignDir, records) {
  const cellDir = join(runs, campaignDir, "memoryOFF", "cell-0000");
  mkdirSync(cellDir, { recursive: true });
  writeFileSync(
    join(cellDir, "live.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""),
  );
  return join(cellDir, "live.jsonl");
}
test("LIVENESS: a fresh heartbeat means running, however old the log is", async () => {
  const root = mkdtempSync(join(tmpdir(), "liveness-beat-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("qwen/qwen3.6-flash");
    writeCampaignCell(runs, dir, { gates: [{ id: "CONF" }], results: [] });
    const first = await readRunState({ runsRoot: runs, launcher: null, aliveProbe: async () => true });
    // The log has said nothing for 25 minutes — a normal mid-drive phase.
    const old = Date.now() / 1000 - (STALL_THRESHOLD_S + 600);
    utimesSync(first.log_path, old, old);

    const state = await readRunState({
      runsRoot: runs,
      launcher: null,
      aliveProbe: async () => true,
      heartbeatProbe: async () => 3000,
    });

    assert.equal(state.state, "running", "a beating cell is not wedged, whatever the log says");
    assert.equal(state.liveness, "live");
    assert.equal(state.heartbeat_age_s, 3);
    assert.ok(state.log_silent_s >= STALL_THRESHOLD_S, "the log really is that stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LIVENESS: a stopped heartbeat IS a stall, however fresh the log is", async () => {
  // The corner that must survive every future change to this file. 15s beats
  // against a 900s threshold is 60 missed beats — nothing but a wedge reaches it.
  const root = mkdtempSync(join(tmpdir(), "liveness-stall-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("qwen/qwen3.6-flash");
    writeCampaignCell(runs, dir, { gates: [{ id: "CONF" }], results: [] });

    const state = await readRunState({
      runsRoot: runs,
      launcher: null,
      aliveProbe: async () => true,
      heartbeatProbe: async () => (STALL_THRESHOLD_S + 60) * 1000,
    });

    assert.equal(state.state, "stalled", "the log being fresh must not rescue a dead heartbeat");
    assert.equal(state.liveness, "stalled");
    assert.equal(state.can_start, false, "a stalled-but-alive cell still holds the tree");
    assert.match(String(state.blocked_reason), /strictly serial/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LIVENESS: NO heartbeat is unknown — never stalled", async () => {
  // A cell from a harness that predates the record, or one whose stream could
  // not be written, has not reported anything. Calling that a wedge is exactly
  // the defect this replaced, and inventing a zero would be the mirror of it.
  const root = mkdtempSync(join(tmpdir(), "liveness-unknown-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("qwen/qwen3.6-flash");
    writeCampaignCell(runs, dir, { gates: [{ id: "CONF" }], results: [] });
    const first = await readRunState({ runsRoot: runs, launcher: null, aliveProbe: async () => true });
    const old = Date.now() / 1000 - (STALL_THRESHOLD_S + 600);
    utimesSync(first.log_path, old, old);

    const state = await readRunState({
      runsRoot: runs,
      launcher: null,
      aliveProbe: async () => true,
      heartbeatProbe: async () => null,
    });

    assert.equal(state.liveness, "unknown");
    assert.equal(state.heartbeat_age_s, null, "no reading is null, never 0");
    assert.notEqual(state.state, "stalled", "silence from a cell that never spoke is not a wedge");
    assert.equal(state.state, "running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LIVENESS: heartbeatAge reads the real stream through the designated resolver", async () => {
  // End-to-end over an actual live.jsonl, including the two things a hand-built
  // reader gets wrong: the path is under memory<ARM>/cell-<seq>/ and NOT at the
  // campaign root, and the stream is full of non-heartbeat records.
  const { heartbeatAge } = await import("../runstate.mjs");
  const root = mkdtempSync(join(tmpdir(), "liveness-real-"));
  try {
    const runs = join(root, "runs");
    const dir = campaignDirName("qwen/qwen3.6-flash");
    const now = Date.now();
    writeLiveStream(runs, dir, [
      { v: 1, ts: now - 60000, kind: "run.start", task: "backgammon" },
      { v: 1, ts: now - 59000, kind: "cell.start", session_id: "ses_x" },
      { v: 1, ts: now - 40000, kind: "heartbeat", phase: "initial-chunk-1", since_ms: 19000 },
      { v: 1, ts: now - 30000, kind: "gate.result", id: "CONF", status: "fail" },
      { v: 1, ts: now - 5000, kind: "heartbeat", phase: "initial-chunk-2", since_ms: 54000 },
      { v: 1, ts: now - 1000, kind: "ext", ns: "okp.plugin", type: "capture" },
    ]);

    const age = await heartbeatAge({ runsRoot: runs, runDir: dir, now });
    assert.equal(age, 5000, "the NEWEST heartbeat, ignoring later records of other kinds");

    // A stream with no heartbeat at all, and a run directory with no stream.
    writeLiveStream(runs, dir, [{ v: 1, ts: now, kind: "cell.start", session_id: "ses_x" }]);
    assert.equal(await heartbeatAge({ runsRoot: runs, runDir: dir, now }), null);
    assert.equal(await heartbeatAge({ runsRoot: runs, runDir: "nope", now }), null);
    assert.equal(await heartbeatAge({ runsRoot: runs, runDir: null, now }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DRIFT: the harness's heartbeat is the one this control plane reads", async () => {
  // A CROSS-LANGUAGE DRIFT TEST, and the most valuable one here. The producer
  // is Python (harness/live_stream.py) and the consumer is this JS; nothing but
  // this test makes them agree on the record shape OR on where the file lives.
  //
  // Both halves have already been wrong about the location once: the spec said
  // `runs/<run>/live.jsonl`, both dashboard readers built the campaign-level
  // path from it, and every run reported "no live.jsonl yet" for its entire
  // life — a reason indistinguishable from a run that never wrote one. The
  // real path is <campaign>/memory<ARM>/cell-<seq>/live.jsonl, which is why
  // this writes a full campaign-shaped tree rather than a flat file.
  //
  // Skipped where python3 is unavailable rather than failing — the seam works
  // as designed in a JS-only checkout.
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "xlang-heartbeat-"));
  try {
    const runs = join(root, "runs");
    const runDir = join("tree0", "local", "p", "omlx", "model");
    const cell = join(runs, runDir, "memoryOFF", "cell-0000");
    mkdirSync(cell, { recursive: true });

    const script = [
      "import sys, time",
      `sys.path.insert(0, ${JSON.stringify(BENCH)})`,
      "from harness.live_stream import LiveStream, Heartbeat",
      `st = LiveStream.for_run(${JSON.stringify(cell)}, run_id="r1")`,
      'st.emit("cell.start", session_id="ses_x")',
      "hb = Heartbeat(st, cell_seq=0, interval_s=0.02)",
      'hb.set_phase("initial-chunk-5", attempt=1)',
      "hb.start(); time.sleep(0.12); hb.stop()",
    ].join("\n");
    try {
      execFileSync("python3", ["-c", script], { stdio: "pipe" });
    } catch {
      return; // no python3 here, or the harness package is not importable
    }

    const { heartbeatAge } = await import("../runstate.mjs");
    const age = await heartbeatAge({ runsRoot: runs, runDir });
    assert.notEqual(age, null, "the consumer must find the record the producer just wrote");
    assert.ok(age >= 0 && age < 60_000, `implausible age ${age}`);

    // The fields the verdict and the UI depend on, asserted on the real output.
    const beats = readFileSync(join(cell, "live.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.kind === "heartbeat");
    assert.ok(beats.length >= 2, "a heartbeat beats on a clock");
    assert.equal(beats.at(-1).phase, "initial-chunk-5", "the beat names the phase");
    assert.equal(beats.at(-1).attempt, 1);
    assert.equal(beats.at(-1).v, 1, "envelope version");
    assert.equal(typeof beats.at(-1).ts, "number");
    assert.equal(typeof beats.at(-1).since_ms, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

