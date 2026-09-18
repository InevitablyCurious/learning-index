// THE PHASE LIST SAYS WHAT EACH ROUND CHANGED, AND NEVER CALLS AN UNGRADED
// ROUND DONE. Run 1789632137: round 2 fixed two gates and broke two, so every
// row read "FAIL · 27 failed"; and the cell stopped (context exhausted) inside
// repair round 4, whose row still said DONE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spine } from "./panels/live.js";
import { read } from "../control/board/sources/live-stream.mjs";

const STOPPED = { state: "complete", chunk: { current: 6, total: 6 } };

function board(attempts, ended) {
  return { live: { phase: "feedback-4", phase_ts: 5, attempts, ended } };
}

test("a round that fixed and broke gates says so beside its failing count", () => {
  const html = spine(STOPPED, board([
    { attempt: 1, verdict: "FAIL", failed: 27 },
    { attempt: 2, verdict: "FAIL", failed: 27, fixed: 2, broke: 2 },
    { attempt: 3, verdict: "FAIL", failed: 27, fixed: 0, broke: 0 },
  ], null));
  const row2 = html.slice(html.indexOf("2 —"), html.indexOf("3 —"));
  assert.match(row2, /FAIL · 27 failed/);
  assert.match(row2, /2 fixed/);
  assert.match(row2, /2 broke/);
  const row3 = html.slice(html.indexOf("3 —"), html.indexOf("4 —"));
  assert.match(row3, /no change/);
});

test("the phase a stopped cell was in reads STOPPED and NOT GRADED, never DONE", () => {
  const html = spine(STOPPED, board([
    { attempt: 1, verdict: "FAIL", failed: 27 },
    { attempt: 2, verdict: "FAIL", failed: 27 },
    { attempt: 3, verdict: "FAIL", failed: 27 },
    { attempt: 4, verdict: "FAIL", failed: 27 },
  ], { verdict: "FAIL", terminal_reason: "context_exhausted" }));
  const row5 = html.slice(html.indexOf("5 —"));
  assert.ok(!row5.includes("DONE"), "a phase that was never graded is not done");
  assert.match(row5, /STOPPED/);
  assert.match(row5, /NOT GRADED — CONTEXT EXHAUSTED/);
});

test("phases after the one a cell stopped in read NOT RUN", () => {
  const html = spine(STOPPED, { live: { phase: "initial-chunk-3", attempts: [], ended: { terminal_reason: "context_exhausted" } } });
  assert.match(html.slice(html.indexOf("1 —"), html.indexOf("2 —")), /STOPPED/);
  assert.match(html.slice(html.indexOf("2 —"), html.indexOf("3 —")), /NOT RUN/);
});

test("the stream reader counts fixed and broke per attempt and reports how the cell ended", async () => {
  const root = mkdtempSync(join(tmpdir(), "churn-"));
  const run = join(root, "1789632137");
  const campaign = join(run, "local", "p", "m");
  const cell = join(campaign, "memoryOFF", "cell-0000");
  mkdirSync(cell, { recursive: true });
  writeFileSync(join(root, "active-tree.json"), JSON.stringify({ active: "1789632137" }));
  writeFileSync(join(campaign, "manifest.json"), JSON.stringify({ created_at: "2026-09-17T08:02:17Z", schedule: [] }));
  const g = (attempt, id, status) => ({ kind: "gate.result", attempt, id, status, ts: attempt });
  const lines = [
    { kind: "cell.start", arm: "off" },
    g(1, "A", "fail"), g(1, "B", "pass"), g(1, "C", "fail"),
    { kind: "attempt.end", attempt: 1, verdict: "FAIL", failed: 2 },
    g(2, "A", "pass"), g(2, "B", "fail"), g(2, "C", "fail"),
    { kind: "attempt.end", attempt: 2, verdict: "FAIL", failed: 2 },
    { kind: "cell.end", verdict: "FAIL", terminal_reason: "context_exhausted" },
  ];
  writeFileSync(join(cell, "live.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const out = await read({ runsRoot: root });
  if (!out.ok) {
    rmSync(root, { recursive: true, force: true });
    assert.fail(`reader did not open the fixture: ${out.reason}`);
  }
  const a2 = out.patch.live.attempts.find((a) => a.attempt === 2);
  assert.equal(a2.fixed, 1);
  assert.equal(a2.broke, 1);
  assert.equal(out.patch.live.ended.terminal_reason, "context_exhausted");
  rmSync(root, { recursive: true, force: true });
});

test("each graded round names the stage it reached and how much was held back", () => {
  const html = spine(STOPPED, board([
    { attempt: 1, verdict: "FAIL", failed: 27, stage: 2, stage_name: "A new game looks right", withheld: 24 },
  ], null));
  assert.match(html, /stage 2 · A new game looks right · 24 held back/);
});

test("a round cut off by a dead worker or a board stop says which", () => {
  const died = spine(STOPPED, board([{ attempt: 1, verdict: "FAIL", failed: 20 }], { terminal_reason: "worker_died" }));
  assert.match(died, /NOT GRADED — WORKER DIED/);
  const stopped = spine(STOPPED, board([{ attempt: 1, verdict: "FAIL", failed: 20 }], { terminal_reason: "stopped" }));
  assert.match(stopped, /NOT GRADED — STOPPED FROM THE BOARD/);
});
