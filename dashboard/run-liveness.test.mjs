// ─────────────────────────────────────────────────────────────────────────────
// RUN LIVENESS — the board defers to the reader that can actually measure it
//
// THE MEASURED DEFECT (2026-09-02): a cell was interrupted with SIGINT. The
// harness tore its own containers down and exited, leaving a KeyboardInterrupt
// traceback and no terminal record. The control plane's process probe reported
// `failed`; the board's log parser reported `running` and kept a spinner turning
// over a dead process, on course to escalate to STALLED — a claim that a
// deliberately stopped cell was wedged.
//
// THE MEASURED DEFECT IN THE OTHER DIRECTION (WO-HDR-FIX-01): run-log named
// `stalled` from the launch log's mtime, and the header printed
// `CELL STALLED — SILENT 23:29` over a cell that was mid-turn — the harness
// writes PROGRESS at phase boundaries while its own 15s live.jsonl heartbeat
// beats continuously. The control plane had already migrated to the heartbeat
// as the sole liveness signal; the board's proxy survived. That derivation is
// gone from run-log; the producer's verdict now lands here in BOTH directions.
//
// The board is a read-only container with no host PID namespace and no
// heartbeat reader. It cannot probe processes or beats. That is a boundary,
// not a bug — so the fix is deference, not a smarter regex.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

const { reconcileRunLiveness } = await import("../control/board/run-liveness.mjs");

const boardWith = (run, controlRun) => ({
  run: { state: null, phase: null, ...run },
  control: controlRun === undefined ? null : { run: controlRun },
});

test("a dead process outranks a log that merely looks live", () => {
  const b = reconcileRunLiveness(
    boardWith(
      { state: "running", phase: "feedback-3" },
      { running: false, state: "failed", terminal_status: null },
    ),
  );
  assert.equal(b.run.state, "failed", "the probe saw no process — the board must not say running");
  assert.equal(b.run.liveness_source, "control-plane", "the source of the override must be stated");
  assert.match(b.run.liveness_note, /process probe/, "and why it outranks the log");
});

test("STALLED is corrected too — a stopped cell is not a wedged one", () => {
  const b = reconcileRunLiveness(
    boardWith({ state: "stalled" }, { running: false, state: "failed" }),
  );
  assert.equal(b.run.state, "failed");
});

test("A STATED STALL LANDS — the producer reads the heartbeat, the board does not", () => {
  // The wedge half of the migration: with run-log's mtime derivation gone, a
  // genuinely wedged cell (process alive, heartbeat stopped) is visible ONLY
  // through the producer's verdict. If reconcile dropped it, the 41-minute
  // wedge of 2026-08-13 would render as RUNNING again.
  const b = reconcileRunLiveness(
    boardWith(
      { state: "running", log_silent_s: 1409 },
      { running: true, state: "stalled", liveness: "stalled", heartbeat_age_s: 960, terminal_status: null },
    ),
  );
  assert.equal(b.run.state, "stalled", "the control plane's heartbeat verdict is the stall fact");
  assert.equal(
    b.run.heartbeat_age_s,
    960,
    "the producer's measurement rides with its verdict — the chip renders THIS, never log_silent_s",
  );
  assert.equal(b.run.liveness_source, "control-plane", "the source of the verdict must be stated");
  assert.match(b.run.liveness_note, /heartbeat/, "and named as the heartbeat, not the log");
});

test("WO-HDR-FIX-01: a beating cell is NEVER stalled — the measured false positive", () => {
  // The exact shape the header got wrong: log quiet between phase-boundary
  // PROGRESS writes, the harness's own heartbeat beating every 15s.
  const b = reconcileRunLiveness(
    boardWith(
      { state: "stalled", log_silent_s: 1409 },
      { running: true, state: "running", liveness: "live", heartbeat_age_s: 8 },
    ),
  );
  assert.equal(b.run.state, "running", "the producer's live verdict outranks any stall claim");
  assert.equal(b.run.liveness_source, "control-plane", "the correction is stated, not silent");
});

test("an older plane publishing only the boolean confirms a live board, corrects a dead one", () => {
  // No `state` string: no verdict to consume. running=true confirms the board's
  // own view and must not fabricate an override; running=false still means the
  // process is gone.
  const live = reconcileRunLiveness(boardWith({ state: "running" }, { running: true }));
  assert.equal(live.run.state, "running");
  assert.equal(live.run.liveness_source, undefined, "no verdict, no override, nothing to declare");

  const dead = reconcileRunLiveness(boardWith({ state: "running" }, { running: false }));
  assert.equal(dead.run.state, "complete", "the boolean alone still says the process is gone");
});

test("a live cell is left exactly alone", () => {
  const b = reconcileRunLiveness(
    boardWith({ state: "running", phase: "backend" }, { running: true, state: "running" }),
  );
  assert.equal(b.run.state, "running");
  assert.equal(b.run.phase, "backend", "phase is not the control plane's to answer");
  assert.equal(b.run.liveness_source, undefined, "no override, so nothing to declare");
});

test("SILENCE IS NOT EVIDENCE: an unreachable control plane never marks a run dead", () => {
  for (const control of [undefined, null, {}, { state: "failed" }]) {
    const b = reconcileRunLiveness(boardWith({ state: "running" }, control));
    assert.equal(
      b.run.state,
      "running",
      "without the published `running` boolean the control plane has not answered",
    );
  }
});

test("a board already reporting an ending is not second-guessed", () => {
  // THE FIXTURE IS A STATUS THE HARNESS ACTUALLY WRITES. It was `"ok"` — a
  // string no Python file emits — which is the same phantom that had the
  // control plane classify every clean completion as `failed`.
  const b = reconcileRunLiveness(
    boardWith({ state: "complete", terminal_status: "done" }, { running: false, state: "failed" }),
  );
  assert.equal(b.run.state, "complete", "run-log owns the ending it actually observed");
  assert.equal(b.run.terminal_status, "done");
});

test("the pulse over a finished cell reads the control plane's verdict, not the status string", async () => {
  // THE BOARD DERIVES NOTHING HERE. This branch used to test
  // `terminal_status === "ok" || === "complete"` — a second copy of the Python
  // terminal vocabulary, drifted exactly like the control plane's copy. It was
  // dead only because `state` never reached `complete`; repairing that alone
  // would have turned every clean cell's pulse to failure.
  const { runPulse } = await import("./panels/chrome.js");

  assert.equal(
    runPulse({ state: "complete", terminal_status: "done", terminal_ok: true }),
    "stopped",
    "a clean ending is a clean stop",
  );
  assert.equal(
    runPulse({ state: "complete", terminal_status: "halted_on_gate", terminal_ok: false }),
    "failure",
    "a walk-gate halt ended the campaign adversely and must pull the eye",
  );
  // UNKNOWN IS NOT A FAILURE VERDICT. A cell that ended without saying how is
  // not vouched for — and is equally not accused.
  assert.equal(
    runPulse({ state: "complete", terminal_status: "some_future_status", terminal_ok: null }),
    "stopped",
    "an unrecognised ending is unvouched, not adverse",
  );
});

test("a clean completion says CELL COMPLETE — the banner that read NO RESULT over every one", async () => {
  const { renderTopbar } = await import("./panels/chrome.js");
  const html = renderTopbar(
    { run: { state: "complete", terminal_status: "done", terminal_ok: true, model: "m" }, control: null, sources: [] },
    { stale: false, lastError: null },
  );
  assert.match(html, /CELL COMPLETE/);
  assert.ok(!html.includes("CELL ENDED — NO RESULT"), "a clean completion is not a missing result");
});

test("the topbar renders `failed` as an ending without a result — not complete, not stalled", async () => {
  const { renderTopbar, runPulse } = await import("./panels/chrome.js");
  assert.equal(runPulse({ state: "failed" }), "failure", "a dead cell must not read as a clean stop");

  const html = renderTopbar(
    { run: { state: "failed", model: "m" }, control: null, sources: [] },
    { stale: false, lastError: null },
  );
  assert.match(html, /CELL ENDED — NO RESULT/);
  assert.ok(!html.includes("CELL COMPLETE"), "nothing concluded, so it is not complete");
  assert.ok(!html.includes("CELL STALLED"), "there is no process left to be wedged");
  assert.ok(!html.includes("no run observed"), "a cell that ran is not 'no run'");
  // The pulse must be static: motion over a dead cell is the whole defect.
  assert.match(html, /pulse pulse-failure/);
});
