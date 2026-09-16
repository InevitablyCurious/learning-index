// The hover card's facts: each gate gets the challenge's plain description,
// its result per round, the grader's words for its latest failure, and what
// the model was told about it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachGateDetail, describeGate, gateToken, technicalLine } from "../gate-detail.mjs";

import { BENCH } from "./_shared.mjs";

const DESCRIPTIONS = {
  schema_version: 1,
  checks: { E04: { name: "Shut out on the bar", what: "No legal move.", how: "White on the bar, 19–24 held." } },
  setup: [{ title: "{x} exists", key: "REQ-FILE {x}", name: "File {x}", what: "{x} is present.", how: "Looks for {x}." }],
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gate-detail-"));
  const grader = join(root, "grader");
  mkdirSync(grader);
  writeFileSync(join(grader, "checks.json"), JSON.stringify(DESCRIPTIONS));
  writeFileSync(
    join(grader, "feedback.json"),
    JSON.stringify({ gates: { E04: { first: "The bar is wrong.", repeat: "Still wrong." }, CONF: { first: "Setup.", repeat: "Setup again." } } }),
  );
  const cell = join(root, "run", "memoryOFF", "cell-01");
  mkdirSync(cell, { recursive: true });
  const problem = (n) => ({
    check: "edge [E04] shut out",
    observed: `AssertionError: expected ${n} to be +0\n    at /gates/backend/edge/edge-gates.test.ts:116:20`,
  });
  writeFileSync(join(cell, "attempt-1-report.json"), JSON.stringify({ problems: [problem(3)] }));
  writeFileSync(join(cell, "attempt-2-report.json"), JSON.stringify({ problems: [problem(2)] }));
  return { root, grader, run: join(root, "run") };
}

test("GATE DETAIL: ids resolve in both bare and bracketed forms", () => {
  assert.equal(gateToken("G01"), "G01");
  assert.equal(gateToken("backend.test.ts > [E04] shut out"), "E04");
  assert.equal(gateToken("[CONF] package.json exists"), null, "setup checks carry no numbered id");
});

test("GATE DETAIL: setup checks fill their pattern; unknown checks say null, never a guess", () => {
  assert.deepEqual(describeGate({ id: "[CONF] src/server.ts exists" }, DESCRIPTIONS), {
    key: "REQ-FILE src/server.ts",
    name: "File src/server.ts",
    what: "src/server.ts is present.",
    how: "Looks for src/server.ts.",
  });
  assert.equal(describeGate({ id: "Z99" }, DESCRIPTIONS), null);
});

test("GATE DETAIL: the failure line is the assertion's own words, newest round first", async () => {
  const f = fixture();
  try {
    const [g] = await attachGateDetail({
      gates: [{ id: "E04", state: "failing" }],
      attempts: [
        { attempt: 1, gate_results: [{ id: "E04", status: "fail" }] },
        { attempt: 2, gate_results: [{ id: "E04", status: "fail" }] },
      ],
      runPath: f.run,
      graderDir: f.grader,
    });
    assert.equal(g.detail.description.name, "Shut out on the bar");
    assert.deepEqual(g.detail.rounds, [{ attempt: 1, status: "fail" }, { attempt: 2, status: "fail" }]);
    assert.deepEqual(g.detail.last_failure, {
      attempt: 2,
      message: "AssertionError: expected 2 to be +0",
      location: "backend/edge/edge-gates.test.ts:116",
    });
    assert.deepEqual(g.detail.told, { first: "The bar is wrong.", repeat: "Still wrong." });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("GATE DETAIL: a run with no grader folder still returns every gate, with nothing invented", async () => {
  const [g] = await attachGateDetail({ gates: [{ id: "G01", state: "untested" }], attempts: [], runPath: null, graderDir: null });
  assert.deepEqual(g.detail, { description: null, rounds: [], last_failure: null, told: null });
});

test("GATE DETAIL: technicalLine drops the stack and keeps only the gate file location", () => {
  assert.deepEqual(technicalLine("Error: boom\n  at /gates/a.test.ts:3:9\n  at node:internal"), {
    message: "Error: boom",
    location: "a.test.ts:3",
  });
});

test("GATE DETAIL: every check the shipped example challenge grades has a description", () => {
  const checks = JSON.parse(readFileSync(join(BENCH, "grader", "checks.json"), "utf8"));
  for (const [id, d] of Object.entries(checks.checks)) {
    for (const field of ["name", "what", "how"]) assert.ok(d[field]?.trim(), `${id} has no ${field}`);
  }
});
