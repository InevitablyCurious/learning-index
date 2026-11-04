// THE PHASE LIST SAYS WHAT EACH ROUND CHANGED, AND NEVER CALLS AN UNGRADED
// ROUND DONE. Run 1789632137: round 2 fixed two gates and broke two, so every
// row read "FAIL · 27 failed"; and the cell stopped (context exhausted) inside
// repair round 4, whose row still said DONE.
//
// The list is not a budget: it is one BUILD row plus one GRADE row per round the
// cell was OBSERVED in, so a cell graded seven times draws seven GRADE rows and a
// cell that never reported a round draws BUILD alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spine } from "./panels/live.js";
import { readCell } from "../control/board/sources/live-stream.mjs";

const STOPPED = { state: "complete", chunk: { current: 6, total: 6 } };

function board(attempts, ended) {
  return { live: { phase: "feedback-4", phase_ts: 5, attempts, ended } };
}

/** The spine's rows in draw order — one per phase the cell was observed in. */
const rows = (html) => html.split('<div class="ph ').slice(1);
const flat = (h) => h.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

test("a graded round reads -fixed / +broke / total, and an unobserved figure is a dash", () => {
  const html = spine(STOPPED, board([
    { attempt: 1, verdict: "FAIL", failed: 27 },
    { attempt: 2, verdict: "FAIL", failed: 27, fixed: 2, broke: 2 },
    { attempt: 3, verdict: "FAIL", failed: 27, fixed: 0, broke: 0 },
  ], null));
  // BUILD plus one GRADE row per observed round: four here, because the stated
  // phase (feedback-4) proves round 4 was reached even though only three
  // attempt.end records closed.
  assert.equal(rows(html).length, 5);
  const row2 = html.slice(html.indexOf("2 —"), html.indexOf("3 —"));
  assert.match(flat(row2), /FAIL ?-2 \/ \+2 \/ 27/);
  const row3 = html.slice(html.indexOf("3 —"), html.indexOf("4 —"));
  assert.match(flat(row3), /FAIL ?-0 \/ \+0 \/ 27/);
  // The first round has no fixed/broke yet: dashes, never zeros.
  const row1 = html.slice(html.indexOf("1 —"), html.indexOf("2 —"));
  assert.match(flat(row1), /FAIL ?— \/ — \/ 27/);
});

test("the phase a stopped cell was in reads STOPPED and NOT GRADED, never DONE", () => {
  const html = spine(STOPPED, board([
    { attempt: 1, verdict: "FAIL", failed: 27 },
    { attempt: 2, verdict: "FAIL", failed: 27 },
    { attempt: 3, verdict: "FAIL", failed: 27 },
    { attempt: 4, verdict: "FAIL", failed: 27 },
  ], { verdict: "FAIL", terminal_reason: "context_exhausted" }));
  // Exactly the observed rounds — no row is drawn for a budget nobody measured.
  assert.equal(rows(html).length, 5);
  const row5 = html.slice(html.indexOf("5 —"));
  assert.ok(!row5.includes("DONE"), "a phase that was never graded is not done");
  assert.match(row5, /STOPPED/);
  assert.match(row5, /NOT GRADED — CONTEXT EXHAUSTED/);
});

test("a cell is drawn for the rounds it was observed in, and nothing more", () => {
  // Nothing reported a round: BUILD alone, and no phantom GRADE row claiming
  // round 1 exists.
  const none = spine(STOPPED, { live: { phase: "initial-chunk-3", attempts: [], ended: { terminal_reason: "context_exhausted" } } });
  assert.equal(rows(none).length, 1, "0 observed rounds is BUILD with no GRADE row");
  assert.match(flat(rows(none)[0]), /1 — BUILD/);
  assert.match(rows(none)[0], /STOPPED/);
  assert.match(none, /NOT GRADED — CONTEXT EXHAUSTED/);
  assert.ok(!none.includes("2 —"), "no round was observed, so none is drawn");

  // An observed round the cell never reached still reads NOT RUN rather than
  // being erased: the producer spoke about three rounds, the cell stopped in the
  // first.
  const beyond = spine(STOPPED, {
    live: { phase: "initial-chunk-3", attempts: [], attempt: 3, ended: { terminal_reason: "context_exhausted" } },
  });
  assert.equal(rows(beyond).length, 4, "BUILD plus the three observed rounds");
  for (const r of rows(beyond).slice(1)) assert.match(r, /NOT RUN/);
});

test("a cell observed in seven rounds draws BUILD + seven GRADE rows — round 7 is not dropped", () => {
  // Row n carries attempt n's closing verdict (the build is graded as attempt 1),
  // so the row named verdict-pass-i is round i's repair round. Seven closed
  // attempts therefore means rounds 1..7 were reached, with round 7's own row
  // still ungraded when the cell stopped. Under the fixed five-slot spine this
  // phase was refused outright — phaseIndex("verdict-pass-7") → null — and round
  // 7 vanished from the board.
  const closed = Array.from({ length: 7 }, (_, i) => ({ attempt: i + 1, verdict: "FAIL", failed: 30 - (i + 1), fixed: 1, broke: 1 }));
  const html = spine(STOPPED, {
    live: { phase: "verdict-pass-7", phase_ts: 5, attempts: closed, ended: { verdict: "FAIL", terminal_reason: "context_exhausted" } },
  });
  const r = rows(html);
  assert.equal(r.length, 8, "BUILD plus one GRADE row per observed round");
  assert.match(flat(r[0]), /1 — BUILD/);
  for (let n = 1; n <= 7; n += 1) {
    if (n > 1) assert.match(flat(r[n - 1]), new RegExp(`${n} — GRADE · verdict-pass-${n - 1}`));
    assert.match(flat(r[n - 1]), /DONE/, `attempt ${n}'s closed verdict is drawn`);
    assert.match(flat(r[n - 1]), new RegExp(`/ ${closed[n - 1].failed}`), `row ${n} carries attempt ${n}'s own count, not a neighbour's`);
  }
  // The eighth row IS round 7: its own label, and its state — stopped before the
  // closing grade landed, so never done and never dropped.
  assert.match(flat(r[7]), /8 — GRADE · verdict-pass-7/);
  assert.match(flat(r[7]), /NOT GRADED — CONTEXT EXHAUSTED/);
  assert.ok(!r[7].includes("DONE"), "round 7 never closed, so its row is not done");
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
  const out = await readCell({ runsRoot: root, cell: { run_dir: "1789632137/local/p/m", sequence_index: 0 } });
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

test("the stage line is not drawn on a graded round", () => {
  const html = spine(STOPPED, board([
    { attempt: 1, verdict: "FAIL", failed: 27, stage: 2, stage_name: "A new game looks right", withheld: 24 },
  ], null));
  assert.doesNotMatch(html, /held back/);
});

test("a round cut off by a dead worker or a board stop says which", () => {
  const died = spine(STOPPED, board([{ attempt: 1, verdict: "FAIL", failed: 20 }], { terminal_reason: "worker_died" }));
  assert.match(died, /NOT GRADED — WORKER DIED/);
  const stopped = spine(STOPPED, board([{ attempt: 1, verdict: "FAIL", failed: 20 }], { terminal_reason: "stopped" }));
  assert.match(stopped, /NOT GRADED — STOPPED FROM THE BOARD/);
});
