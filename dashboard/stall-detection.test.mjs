// ─────────────────────────────────────────────────────────────────────────────
// HANG DETECTION — a wedged cell must never render as "nothing happening",
// and a working cell must never render as wedged.
//
//     cd okp-bench/dashboard && node --test
//
// WHY THIS EXISTS
//
// WO-NUDGE-INF-1 removed the self-termination that used to end a wedged run,
// on purpose, and moved the job elsewhere:
//
//   "a permanently wedged relay is no longer self-terminating, so hang
//    detection is the operator's / poller's job on the status stream, never a
//    nudge cap."  — RUNBOOK.md:329
//
// Stall detection was first implemented ON THIS BOARD: run-log named `stalled`
// from the launch log's mtime against a 900s threshold. That judged the wedge
// from the wrong signal — the harness writes PROGRESS at phase BOUNDARIES, one
// build phase has been observed running 86 model turns between two of them,
// and the header printed `CELL STALLED — SILENT 23:29` over a cell that was
// mid-turn (WO-HDR-FIX-01).
//
// THE MIGRATION. The verdict belongs to the PRODUCER: the control plane reads
// the harness's own 15s live.jsonl heartbeat — the only component that knows
// whether it is mid-drive — and publishes `liveness`/`state` on GET /api/run
// (control/runstate.mjs). reconcileRunLiveness lands it on the board, in both
// directions (run-liveness.test.mjs pins the reconciliation). A consumer must
// never derive a fact that a producer could state.
//
// WHAT THIS PINS
//
//  1. run-log NEVER names a stall: however long the silence, its state is
//     `running` (or `complete` on a terminal record), and the silence is
//     reported as the debug fact `log_silent_s`.
//  2. A COMPLETE run is never restated — a terminal record is a real ending,
//     and silence after one is expected.
//  3. The topbar renders a producer-stated stall LOUDLY, never as "no run
//     observed", and the duration it shows is the producer's heartbeat
//     measurement — never the launch log's.
//  4. A stall is not a failure claim. It reports the measured silence only.
//  5. The board keeps NO stall threshold of its own to drift from the
//     producer's.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyBoard } from "./contract.mjs";
import { read as readRunLog } from "./sources/run-log.mjs";

const noop = () => {};
const stubEl = () => ({
  innerHTML: "",
  style: {},
  classList: { add: noop, remove: noop },
  appendChild: noop,
  addEventListener: noop,
  childNodes: [],
  content: { childNodes: [] },
});
globalThis.document = {
  addEventListener: noop,
  getElementById: stubEl,
  createElement: stubEl,
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { appendChild: noop },
};
globalThis.window = {
  addEventListener: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop }),
};
globalThis.setInterval = noop;

const { renderTopbar } = await import("./panels/chrome.js");

// The producer's threshold is 900s (control/contract.mjs). The board holds no
// copy of it any more; this is simply a silence long past ANY threshold a
// reader might have used, to pin that the board derives no verdict from it.
const SILENCE_PAST_ANY_THRESHOLD_S = 1500;

/**
 * Write a cell log whose MTIME is `silentFor` seconds in the past.
 *
 * MTIME, NOT A TIMESTAMP IN THE TEXT. The harness writes naive local
 * timestamps and parsing them produced a constant phantom 7.1h silence in a
 * UTC container — the debug fact `log_silent_s` is measured from mtime.
 */
function runRootWithLog({ silentFor, lines }) {
  const root = mkdtempSync(join(tmpdir(), "stall-"));
  const runs = join(root, "runs");
  mkdirSync(join(runs, "cumulative"), { recursive: true });
  const log = join(runs, "off-cell-20260813T172000.log");
  writeFileSync(log, lines.join("\n") + "\n");
  const when = new Date(Date.now() - silentFor * 1000);
  utimesSync(log, when, when);
  return { root, runs };
}

// The real shape of the wedged run's tail, verbatim from the 2026-08-13 log.
const WEDGED = [
  "2026-08-13 11:35:10 PROGRESS step=serve-drive-end phase=feedback-1 run_dir=cumulative",
  "2026-08-13 11:39:52 PROGRESS step=transport-recovery phase=feedback-1 "
    + "terminal=transport_error action=nudge nudge=1 budget=unbounded",
];

test("run-log NEVER names a stall — silence is a debug fact, not a verdict", async () => {
  const { root, runs } = runRootWithLog({ silentFor: SILENCE_PAST_ANY_THRESHOLD_S, lines: WEDGED });
  try {
    const res = await readRunLog({ runsRoot: runs });
    assert.equal(res.ok, true);
    assert.equal(
      res.patch.run.state,
      "running",
      "WO-HDR-FIX-01: this used to say `stalled` — a wedge judged from log mtime "
        + "over a cell that was mid-turn. The stall verdict is the producer's.",
    );
    assert.ok(
      res.patch.run.log_silent_s >= SILENCE_PAST_ANY_THRESHOLD_S - 5,
      "the silence is still measured and reported — as the debug fact it is",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a COMPLETE run is never restated", async () => {
  // A terminal record is a real ending. Silence after one is expected, and
  // calling it anything else would raise an alarm on every finished cell on
  // disk.
  const { root, runs } = runRootWithLog({
    silentFor: SILENCE_PAST_ANY_THRESHOLD_S * 6,
    lines: [...WEDGED, JSON.stringify({ status: "done", memory_mode: "off" })],
  });
  try {
    const res = await readRunLog({ runsRoot: runs });
    assert.equal(res.patch.run.state, "complete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the rendering half: the defect was that this had no branch ──────────────

function topbarFor(run) {
  const board = { ...emptyBoard(), run: { ...emptyBoard().run, ...run } };
  return renderTopbar(board, { stale: false, lastError: null });
}

test("a stalled cell renders LOUDLY, and never as 'no run observed'", () => {
  const html = topbarFor({ state: "stalled", heartbeat_age_s: 2520, model: "qwen3.6-35b-a3b-bench" });
  assert.ok(html.includes("CELL STALLED"), "the wedge must be named on the most-read surface");
  assert.ok(html.includes("danger"), "and carry the danger hue — this is the alarm");
  assert.ok(
    !html.includes("no run observed"),
    "THE MEASURED DEFECT: a wedged cell fell through to 'no run observed'",
  );
});

test("the stall chip reports the PRODUCER's measured silence and claims nothing else", () => {
  // The log was written 7s ago; the harness's heartbeat stopped 42 min ago.
  // The chip must render the measurement the verdict was based on — if
  // log_silent_s ever leaks back into the chip, the false-stall proxy is back
  // in the header citing evidence for a claim it did not make.
  const html = topbarFor({ state: "stalled", heartbeat_age_s: 2520, log_silent_s: 7 });
  assert.ok(/SILENT/.test(html));
  assert.ok(html.includes("42:00"), "the duration rendered is the heartbeat's, not the log's");
  // The harness may still recover — recovery is unbounded by design — so the
  // chip must not say failed, dead, or aborted.
  for (const overclaim of ["FAILED", "DEAD", "ABORTED", "CRASHED"]) {
    assert.ok(!html.includes(overclaim), `a stall is not a verdict: "${overclaim}"`);
  }
});

test("running and complete are unchanged by the stall branch", () => {
  assert.ok(topbarFor({ state: "running", elapsed_s: 120 }).includes("RUNNING"));
  assert.ok(topbarFor({ state: "complete", terminal_status: "done" }).includes("CELL COMPLETE"));
  assert.ok(topbarFor({ state: null }).includes("no run observed"));
});

test("the board keeps NO stall threshold of its own to drift from the producer's", async () => {
  // The 900s threshold used to be DUPLICATED into dashboard/contract.mjs
  // because the board judged stalls too, and a drift test pinned the two
  // copies together. Only the producer judges now (control/runstate.mjs
  // against the heartbeat); a threshold reappearing board-side is the defect
  // class returning — a consumer deriving a fact the producer states.
  const fs = await import("node:fs/promises");
  const contract = await fs.readFile(new URL("./contract.mjs", import.meta.url), "utf8");
  const runLog = await fs.readFile(new URL("./sources/run-log.mjs", import.meta.url), "utf8");
  assert.ok(!/STALL_THRESHOLD_S/.test(contract), "contract.mjs must export no stall threshold");
  assert.ok(!/STALL_THRESHOLD_S/.test(runLog), "run-log.mjs must gate on none");
  assert.ok(
    !/"stalled"/.test(runLog),
    "run-log.mjs must never produce the stalled state — it is producer-stated",
  );
});
