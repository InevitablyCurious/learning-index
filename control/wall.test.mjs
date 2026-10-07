// The wall's fold: regressions are stated by the server, and the wall can be
// read as it stood after any attempt (the board's attempt tabs).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { foldGateStates, readWall } from "./wall.mjs";

const roster = { gates: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }] };
const att = (attempt, results) => ({
  type: "attempt",
  attempt,
  sequence_index: 0,
  gate_results: Object.entries(results).map(([id, status]) => ({ id, status })),
});

test("a gate that passed and then failed carries the attempt it broke on", () => {
  const out = foldGateStates({
    roster,
    attempts: [
      att(1, { A: "pass", B: "fail", C: "fail", D: "pass" }),
      att(2, { A: "fail", B: "pass", C: "fail", D: "pass" }),
      att(3, { A: "fail", B: "pass", C: "fail", D: "fail" }),
    ],
  });
  const g = Object.fromEntries(out.gates.map((x) => [x.id, x]));
  assert.equal(g.A.state, "failing");
  assert.equal(g.A.ever_passed, true);
  assert.equal(g.A.broke_attempt, 2, "A broke on attempt 2 and stayed broken");
  assert.equal(g.B.state, "passing");
  assert.equal(g.B.broke_attempt, null, "B recovered");
  assert.equal(g.C.ever_passed, false, "C never passed: plain failing, not a regression");
  assert.equal(g.C.broke_attempt, null);
  assert.equal(g.D.broke_attempt, 3, "D broke on attempt 3");
});

test("a gate that broke, recovered and broke again carries the latest break", () => {
  const out = foldGateStates({
    roster: { gates: [{ id: "A" }] },
    attempts: [att(1, { A: "pass" }), att(2, { A: "fail" }), att(3, { A: "pass" }), att(4, { A: "fail" })],
  });
  assert.equal(out.gates[0].broke_attempt, 4);
});

test("an unmeasured attempt between a pass and a failure does not move the break", () => {
  const out = foldGateStates({
    roster: { gates: [{ id: "A" }] },
    attempts: [att(1, { A: "pass" }), att(2, { A: "not_run" }), att(3, { A: "fail" })],
  });
  // The pass was not immediately before the failure, so it is a plain failure
  // that once passed — still a regression, with no clean break attempt to name.
  assert.equal(out.gates[0].ever_passed, true);
});

test("the wall can be read as it stood after attempt N", async () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "wall-"));
  const dir = path.join(runs, "r1");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "gate-roster.json"), JSON.stringify({ gates: roster.gates, total: 4 }));
  const lines = [
    att(1, { A: "pass", B: "fail", C: "fail", D: "pass" }),
    att(2, { A: "fail", B: "pass", C: "fail", D: "pass" }),
  ].map((r) => JSON.stringify(r));
  fs.writeFileSync(path.join(dir, "manifest.status.jsonl"), `${lines.join("\n")}\n`);

  const one = await readWall({ runsRoot: runs, runDir: "r1", sequenceIndex: 0, upToAttempt: 1 });
  const two = await readWall({ runsRoot: runs, runDir: "r1", sequenceIndex: 0, upToAttempt: 2 });
  const live = await readWall({ runsRoot: runs, runDir: "r1", sequenceIndex: 0 });
  const state = (w, id) => w.gates.find((g) => g.id === id).state;
  assert.equal(one.attempt, 1);
  assert.equal(state(one, "A"), "passing", "after attempt 1, A still passes");
  assert.equal(state(one, "B"), "failing");
  assert.equal(state(two, "A"), "failing", "after attempt 2, A has broken");
  assert.equal(state(two, "B"), "passing");
  assert.equal(live.attempt, 2, "no attempt asked = the latest");
  assert.equal(JSON.stringify(live.gates), JSON.stringify(two.gates), "the latest equals attempt 2 here");
  fs.rmSync(runs, { recursive: true, force: true });
});
