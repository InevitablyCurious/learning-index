// ─────────────────────────────────────────────────────────────────────────────
// BATCH PANEL — the operator's floor pick, end to end at the module level
//
// Pins what panels/batch.js promises:
//
//  1. renderBatch states the median and the scored/void counts, marks the
//     median run(s) with ◀, and gives every SCORED run a pick button — void
//     runs show their reason and get none.
//  2. A void batch renders BATCH VOID + the changed input and NO pick buttons:
//     a selection never rides on stale numbers.
//  3. A selection renders with its server-signed deviation, never re-derived.
//  4. pickRun POSTs /api/batch/select with {run_dir, sequence_index};
//     loadBatch encodes run_dir and answers null when the server has no batch.
//
// Mock-fetch idiom from concurrency.test.mjs: globalThis.fetch is assigned
// BEFORE the module import; batch.js keeps its fetch calls inside functions,
// so nothing reaches the network. board.js is bare-import safe (boot guard),
// so the import graph loads under Node with no DOM.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

/** Every fetch the panel makes, and the canned answer it gets. */
const seen = [];
let respond = null;
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

globalThis.fetch = async (url, opts = {}) => {
  seen.push({ url: String(url), opts });
  return respond;
};

const { renderBatch, loadBatch, pickRun } = await import("./panels/batch.js");

/** seq 0: 10 problems · seq 1: void (context) · seq 2: 20 problems → median 15. */
function fixture(over = {}) {
  return {
    schema_version: 1,
    run_dir: "base-1234/cumulative",
    runs: [
      { sequence_index: 0, problem_count: 10, scored: true, void_reason: null },
      { sequence_index: 1, problem_count: null, scored: false, void_reason: "context_exhausted" },
      { sequence_index: 2, problem_count: 20, scored: true, void_reason: null },
    ],
    scored_count: 2,
    void_count: 1,
    median: 15,
    selection: null,
    void: false,
    void_input: null,
    ...over,
  };
}

const picks = (html) => [...html.matchAll(/data-batch-pick="(\d+)"/g)].map((m) => m[1]);

// ── A: the record renders ────────────────────────────────────────────────────

test("renderBatch states the median and the scored/void counts", () => {
  const html = renderBatch(fixture());
  assert.ok(html.includes("median: 15 · 2 of 3 scored, 1 void"), html);
});

test("every scored run gets a pick button; the void run shows its reason and gets none", () => {
  const html = renderBatch(fixture());
  assert.deepEqual(picks(html), ["0", "2"], "one pick per scored run, keyed by sequence_index");
  assert.ok(html.includes("void · context_exhausted"), "the void reason is printed, not hidden");
  assert.ok(html.includes("10 problems") && html.includes("20 problems"), "scored runs show their counts");
});

test("the ◀ median marker lands on the run whose count IS the median", () => {
  const odd = fixture({
    runs: [
      { sequence_index: 0, problem_count: 10, scored: true, void_reason: null },
      { sequence_index: 1, problem_count: 15, scored: true, void_reason: null },
      { sequence_index: 2, problem_count: 20, scored: true, void_reason: null },
    ],
    scored_count: 3,
    void_count: 0,
    median: 15,
  });
  const html = renderBatch(odd);
  assert.equal(html.split("◀ median").length - 1, 1, "exactly one median run");
  // The marker rides the row of the median count, not another run's.
  const row = html.split("<div").find((s) => s.includes("15 problems"));
  assert.ok(row.includes("◀ median"), "the 15-problem run carries the marker");
});

test("a fractional even-count median marks BOTH middle runs (floor and ceil)", () => {
  const even = fixture({
    runs: [
      { sequence_index: 0, problem_count: 10, scored: true, void_reason: null },
      { sequence_index: 1, problem_count: 11, scored: true, void_reason: null },
    ],
    scored_count: 2,
    void_count: 0,
    median: 10.5,
  });
  const html = renderBatch(even);
  assert.ok(html.includes("median: 10.5 ·"), "the fractional median is stated");
  assert.equal(html.split("◀ median").length - 1, 2, "floor and ceil both carry the marker");
});

test("an even-count median no run equals marks nothing", () => {
  const html = renderBatch(fixture()); // median 15 over {10, 20}: no run IS 15
  assert.ok(!html.includes("◀ median"), "the marker is a fact about a run, never a decoration");
});

// ── B: void and selection ────────────────────────────────────────────────────

test("a void batch renders BATCH VOID + the changed input, and no pick buttons", () => {
  const html = renderBatch(fixture({ void: true, void_input: "grader_hash" }));
  assert.ok(html.includes("BATCH VOID — grader_hash changed"), html);
  assert.deepEqual(picks(html), [], "a void batch is never a pickable list");
});

test("a selection renders with its signed deviation, as the server signed it", () => {
  const worse = renderBatch(fixture({
    selection: { sequence_index: 2, problem_count: 20, signed_deviation: 5 },
  }));
  assert.ok(worse.includes("selected: seq 2 · deviation 5"), worse);

  const better = renderBatch(fixture({
    selection: { sequence_index: 0, problem_count: 10, signed_deviation: -2.5 },
  }));
  assert.ok(better.includes("selected: seq 0 · deviation -2.5"), better);
});

// ── C: the two network acts ──────────────────────────────────────────────────

test("pickRun POSTs /api/batch/select with {run_dir, sequence_index}", async () => {
  seen.length = 0;
  respond = json({ ok: true, batch: fixture() });
  await pickRun("base-1234/cumulative", 2);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/api/batch/select");
  assert.equal(seen[0].opts.method, "POST");
  assert.equal(seen[0].opts.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(seen[0].opts.body), {
    run_dir: "base-1234/cumulative",
    sequence_index: 2,
  });
});

test("pickRun throws on a refusal, carrying the server's message", async () => {
  seen.length = 0;
  respond = json({ ok: false, error: "batch is void: grader_hash" }, 409);
  await assert.rejects(
    () => pickRun("base-1234/cumulative", 0),
    /batch select refused: HTTP 409 — batch is void: grader_hash/,
  );
});

test("loadBatch encodes run_dir and returns the batch record", async () => {
  seen.length = 0;
  const b = fixture();
  respond = json({ ok: true, batch: b });
  const out = await loadBatch("a b/c&d");

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/api/batch?run_dir=a%20b%2Fc%26d");
  assert.deepEqual(out, b);
});

test("loadBatch answers null when the server has no batch — never an empty list", async () => {
  seen.length = 0;
  respond = json({ ok: false, error: "no batch" }, 404);
  assert.equal(await loadBatch("base-1234/cumulative"), null);
});
