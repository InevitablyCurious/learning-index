// ─────────────────────────────────────────────────────────────────────────────
// STATS TESTS — split VERBATIM from control/control.test.mjs
// (lines 4572–4957 + 5647–5695 + local helper withStatsManifest, 4560–4570).
// NOTE: dynamic import("./runstats.mjs") specifiers shifted to "../runstats.mjs"
// — they resolve relative to THIS module; everything else is byte-identical.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HERE } from "./_shared.mjs";

async function withStatsManifest(path, fn) {
  const saved = process.env.BENCH_STATS_MANIFEST;
  if (path === null) delete process.env.BENCH_STATS_MANIFEST;
  else process.env.BENCH_STATS_MANIFEST = path;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.BENCH_STATS_MANIFEST;
    else process.env.BENCH_STATS_MANIFEST = saved;
  }
}
test("STATS: a fresh clone gets both zones, empty, and is told the manifest is absent", async () => {
  // The empty CUSTOM zone must be distinguishable from an attached manifest
  // that contributed nothing — one is "you have no such services", the other is
  // "your services said nothing", and only the second is a defect to chase.
  const { collectStats } = await import("../runstats.mjs");
  const out = await withStatsManifest(null, () => collectStats());

  // THE NATIVE SLOTS ARE CLAIMED, AND SAY THEY HAVE NOTHING TO SAY. They were
  // `[]` while which numbers belong in the footer was an open question, and the
  // strip drew PLACEHOLDER for each. Now that they are chosen, an idle board
  // must render the readout with no reading — not a vacant slot, which would
  // claim the number had never been decided on.
  assert.deepEqual(
    out.bench.map((s) => s.id),
    ["scored", "voided", "unmeasured", "loop_errors", "stream_errors", "stalled_errors", "cutoffs"],
  );
  // NO RUN IS `absent`, NEVER A ZERO AND NEVER A FAILURE. Nothing could not be
  // reached; there is no run for these to describe.
  for (const stat of out.bench) {
    assert.equal(stat.state, "absent", `${stat.id} must be absent with no run`);
    assert.equal(stat.value, null, `${stat.id} must carry no value with no run`);
  }

  assert.deepEqual(out.custom, [], "a clone contributes nothing without a manifest");
  assert.equal(out.custom_manifest_attached, false);
});

test("STATS: an unreachable source reads as unavailable, NEVER as zero", async () => {
  // THE PROPERTY THIS WHOLE SURFACE TURNS ON. The founding stat is a loop-guard
  // FIRE COUNT: a relay that is down rendering as 0 says "this run tripped the
  // guard zero times", which is a measurement nobody took. `value` must be null
  // so the strip can draw "—".
  const { collectStats } = await import("../runstats.mjs");
  const dir = mkdtempSync(join(tmpdir(), "okp-stats-"));
  const manifest = join(dir, "stats.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      // Port 1 is reserved and never listening; no service is harmed to fail.
      stats: [{ id: "dead", label: "LOOP ERRORS", url: "http://127.0.0.1:1/nope", pick: "fires" }],
    }),
  );
  try {
    const out = await withStatsManifest(manifest, () => collectStats());
    assert.equal(out.custom.length, 1);
    assert.equal(out.custom[0].state, "unavailable");
    assert.equal(out.custom[0].value, null, "a dead source must not report a number");
    assert.notEqual(out.custom[0].value, 0, "unavailable and zero are different facts");
    assert.equal(out.custom_manifest_attached, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("STATS: a live source is read through its dotted pick path", async () => {
  const { collectStats } = await import("../runstats.mjs");
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ fires: 0, byChannel: { reasoning: 7 } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), "okp-stats-"));
  const manifest = join(dir, "stats.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      stats: [
        { id: "fires", label: "LOOP ERRORS", url: `http://127.0.0.1:${port}/`, pick: "fires" },
        { id: "reason", label: "REASONING", url: `http://127.0.0.1:${port}/`, pick: "byChannel.reasoning" },
      ],
    }),
  );
  try {
    const out = await withStatsManifest(manifest, () => collectStats());
    // A REAL zero is a reading and must survive as one. This is the other half
    // of the rule above: the surface refuses to invent zeros, and equally
    // refuses to discard one it was actually given.
    assert.deepEqual(
      out.custom.map((s) => [s.label, s.state, s.value]),
      [
        ["LOOP ERRORS", "ok", 0],
        ["REASONING", "ok", 7],
      ],
    );
    // THE ZONES ARE NEVER CONCATENATED: a contributor's number is not a result.
    // Asserted as the actual invariant rather than as `bench` being empty —
    // `bench` now carries the three native readouts, and a test that only said
    // "empty" would have stopped checking the separation the moment it filled.
    const customIds = out.custom.map((s) => s.id);
    const benchIds = out.bench.map((s) => s.id);
    assert.deepEqual(benchIds, ["scored", "voided", "unmeasured", "loop_errors", "stream_errors", "stalled_errors", "cutoffs"]);
    for (const id of customIds) {
      assert.ok(!benchIds.includes(id), `custom stat '${id}' leaked into the BENCHMARK zone`);
    }
    for (const id of benchIds) {
      assert.ok(!customIds.includes(id), `native stat '${id}' leaked into the CUSTOM zone`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

test("STATS: the native readouts come off the published scorecard, not a re-fold", async () => {
  // WHY THE ARTIFACT AND NOT A DERIVATION. The scored/void split is decided by
  // `build_scorecard` in Python. The control plane could fold the run manifest
  // and status stream itself — and would then be a SECOND implementation of the
  // VOID-INSTRUMENT rule, which is how the two paths come to disagree. So the
  // producer publishes and this reads. The fixture is a scorecard exactly as the
  // harness writes it.
  const { collectStats } = await import("../runstats.mjs");
  const dir = mkdtempSync(join(tmpdir(), "okp-scorecard-"));
  writeFileSync(
    join(dir, "manifest.scorecard.json"),
    JSON.stringify({
      schema_version: 1,
      scored_sessions: 2,
      void_instrument: [{ sequence_index: 0, memory_mode: "off", void_reason: "provider_truncation" }],
      error_totals: {
        guard_aborted_turns: 3,
        finalize_timeout_turns: 2,
        instrument_anomaly_turns: 2,
        stalled_turns: 1,
      },
    }),
  );
  try {
    const out = await withStatsManifest(null, () => collectStats({ runDir: dir }));
    const by = Object.fromEntries(out.bench.map((s) => [s.id, s]));
    assert.deepEqual([by.scored.state, by.scored.value], ["ok", 2]);
    assert.deepEqual([by.voided.state, by.voided.value], ["ok", 1]);
    assert.deepEqual([by.loop_errors.label, by.loop_errors.state, by.loop_errors.value], ["LOOP ERRORS", "ok", 3]);
    assert.deepEqual([by.stream_errors.label, by.stream_errors.state, by.stream_errors.value], ["STREAM ERRORS", "ok", 2]);
    assert.deepEqual([by.stalled_errors.label, by.stalled_errors.state, by.stalled_errors.value], ["STALLED ERRORS", "ok", 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("STATS: a run with no scorecard yet is unavailable, NEVER zero", async () => {
  // Before the first cell completes the harness has published no scorecard.
  // "No cell has finished" is not "no cell scored", and a fabricated 0 in the
  // first hour of a healthy campaign reads as a run producing nothing — the
  // exact class of lie this surface refuses everywhere else.
  const { collectStats } = await import("../runstats.mjs");
  const dir = mkdtempSync(join(tmpdir(), "okp-scorecard-none-"));
  try {
    const out = await withStatsManifest(null, () => collectStats({ runDir: dir }));
    const by = Object.fromEntries(out.bench.map((s) => [s.id, s]));
    for (const id of ["scored", "voided", "loop_errors", "stream_errors", "stalled_errors", "cutoffs"]) {
      assert.equal(by[id].state, "unavailable", `${id} must not invent a reading`);
      assert.equal(by[id].value, null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("STATS: a corrupt scorecard is unavailable and does not take the board down", async () => {
  // A half-written or truncated artifact must read as unavailable, exactly like
  // an unreachable source. It is replaced atomically by the writer, so this
  // should not occur — which is the reason to assert it rather than assume it.
  const { collectStats } = await import("../runstats.mjs");
  const dir = mkdtempSync(join(tmpdir(), "okp-scorecard-bad-"));
  writeFileSync(join(dir, "manifest.scorecard.json"), '{"scored_sessions": 2, "void_ins');
  try {
    const out = await withStatsManifest(null, () => collectStats({ runDir: dir }));
    const by = Object.fromEntries(out.bench.map((s) => [s.id, s]));
    assert.equal(by.scored.state, "unavailable");
    assert.equal(by.voided.state, "unavailable");
    for (const id of ["loop_errors", "stream_errors", "stalled_errors", "cutoffs"]) {
      assert.equal(by[id].state, "unavailable");
      assert.equal(by[id].value, null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("STATS: error totals are per-run and do not leak across runs", async () => {
  // The three error totals are read fresh from each run's own scorecard —
  // readScorecard is uncached and keyed on ctx.runDir. A new run's directory
  // must not inherit the previous run's numbers, and a run whose scorecard has
  // not published error totals yet must read unavailable, never the prior
  // run's value. (This is the reset-on-new-benchmark guarantee: it is natural —
  // no explicit clear is needed.)
  const { collectStats } = await import("../runstats.mjs");
  const dirA = mkdtempSync(join(tmpdir(), "okp-err-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "okp-err-b-"));
  writeFileSync(
    join(dirA, "manifest.scorecard.json"),
    JSON.stringify({
      schema_version: 1,
      scored_sessions: 1,
      void_instrument: [],
      // `instrument_anomaly_turns` is every anomalous turn EXCEPT the loop
      // guard's, and it CONTAINS the narrow finalize-timeout kind — so 3 here
      // means three stream failures, two of which were finalize timeouts.
      // STREAM ERRORS reads the containing field: reading the subset alone left
      // the slot at 0 through a run whose stream died mid-turn.
      error_totals: {
        guard_aborted_turns: 5,
        finalize_timeout_turns: 2,
        instrument_anomaly_turns: 3,
        stalled_turns: 1,
      },
    }),
  );
  // dirB is a fresh run with no scorecard yet.
  try {
    const a = await withStatsManifest(null, () => collectStats({ runDir: dirA }));
    const byA = Object.fromEntries(a.bench.map((s) => [s.id, s]));
    assert.deepEqual([byA.loop_errors.label, byA.loop_errors.state, byA.loop_errors.value], ["LOOP ERRORS", "ok", 5]);
    assert.deepEqual([byA.stream_errors.label, byA.stream_errors.state, byA.stream_errors.value], ["STREAM ERRORS", "ok", 3]);
    assert.deepEqual([byA.stalled_errors.label, byA.stalled_errors.state, byA.stalled_errors.value], ["STALLED ERRORS", "ok", 1]);

    const b = await withStatsManifest(null, () => collectStats({ runDir: dirB }));
    const byB = Object.fromEntries(b.bench.map((s) => [s.id, s]));
    for (const id of ["loop_errors", "stream_errors", "stalled_errors", "cutoffs"]) {
      assert.equal(byB[id].state, "unavailable", `${id} must not leak across runs`);
      assert.equal(byB[id].value, null);
    }
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

// ── CUT-OFFS — the harness's length_cutoff notices, counted live ─────────────
//
// The seventh slot reads ONLY the cells' live.jsonl streams (never the
// scorecard): a run with no stream reads unavailable, "—", never 0 — pinned by
// the unavailable-on-empty / corrupt-scorecard / no-leak groups above. No run
// artifact on disk carries a length_cutoff notice yet (the harness side landed
// in 3fbe190), so the coverage here is synthetic fixtures in the exact record
// shape serve.py writes.
const cutoffNotice = (nudged, reason) =>
  JSON.stringify({
    v: 1,
    kind: "notice",
    event: "length_cutoff",
    source: "harness",
    detail: { nudged, reason, attempt: 1 },
  });

function cutoffRun(cells) {
  const root = mkdtempSync(join(tmpdir(), "cutoffs-"));
  cells.forEach((lines, i) => {
    const dir = join(root, "memoryOFF", `cell-000${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "live.jsonl"), lines.join("\n") + "\n");
  });
  return root;
}

test("STATS: CUT-OFFS counts length_cutoff notices and how many were nudged", async () => {
  const { collectStats } = await import("../runstats.mjs");
  const root = cutoffRun([
    [
      cutoffNotice(true, "nudged"),
      cutoffNotice(false, "budget_spent"),
      // A different notice kind on the same stream must not be counted.
      JSON.stringify({ v: 1, kind: "notice", event: "turn_truncated_retried", source: "harness", detail: { terminal: "guard_abort" } }),
    ],
  ]);
  try {
    const out = await withStatsManifest(null, () => collectStats({ runDir: root, runsRoot: root }));
    const by = Object.fromEntries(out.bench.map((s) => [s.id, s]));
    assert.deepEqual(
      [by.cutoffs.label, by.cutoffs.state, by.cutoffs.value],
      ["CUT-OFFS", "ok", "2 · 1 nudged"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("STATS: a live stream with no length_cutoff reads a MEASURED 0, never '—'", async () => {
  // The other half of the never-invent rule: a stream that ran and hit no cap
  // cut-off is a real zero, and discarding it would read as "no stream".
  const { collectStats } = await import("../runstats.mjs");
  const root = cutoffRun([
    [JSON.stringify({ v: 1, kind: "notice", event: "snapshot_validity_relaxed", source: "harness", detail: {} })],
  ]);
  try {
    const out = await withStatsManifest(null, () => collectStats({ runDir: root, runsRoot: root }));
    const by = Object.fromEntries(out.bench.map((s) => [s.id, s]));
    assert.deepEqual([by.cutoffs.state, by.cutoffs.value], ["ok", "0"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("STATS: a malformed manifest contributes nothing and does not throw", async () => {
  // A dev shim that cannot load must not be able to take the board down.
  const { collectStats } = await import("../runstats.mjs");
  const dir = mkdtempSync(join(tmpdir(), "okp-stats-"));
  const manifest = join(dir, "stats.json");
  writeFileSync(manifest, "{ not json at all");
  try {
    const out = await withStatsManifest(manifest, () => collectStats());
    assert.deepEqual(out.custom, []);
    assert.equal(out.custom_manifest_attached, true, "attached-but-broken is still attached");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── DELTA MODE — scoping a monotonic source to the run ───────────────────────
//
// The defect these pin: the relay's loop-guard counter is monotonic since the
// RELAY process started, and the footer drew that lifetime total as if it were
// the running cell's. 13 fires over 13 hours and 812 turns were read as 13
// loops in one 40-minute build chunk. The number was never wrong; it was
// answering a question nobody asked.

test("STATS/delta: a monotonic source is reported against the run's own zero", async () => {
  const { collectStats } = await import("../runstats.mjs");
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ fires: 14 }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), "okp-stats-"));
  const manifest = join(dir, "stats.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      stats: [{ id: "fires", label: "LOOP ERRORS", url: `http://127.0.0.1:${port}/`, pick: "fires", mode: "delta" }],
    }),
  );
  try {
    const out = await withStatsManifest(manifest, () =>
      collectStats({ baselines: { fires: 10 } }),
    );
    // 14 lifetime, 10 of them before this run started => 4 belong to this run.
    assert.deepEqual(out.custom.map((s) => [s.state, s.value]), [["ok", 4]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

test("STATS/delta: with NO baseline it reads unavailable, NEVER the lifetime total", async () => {
  // THE REGRESSION GUARD. Falling back to the source's own number is the exact
  // bug — it is the most plausible-looking wrong answer on the board, because
  // it is a real number from a healthy service. A run this control plane never
  // queued has no zero, and "no zero" is a fact the footer must state.
  const { collectStats } = await import("../runstats.mjs");
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ fires: 14 }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), "okp-stats-"));
  const manifest = join(dir, "stats.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      stats: [{ id: "fires", label: "LOOP ERRORS", url: `http://127.0.0.1:${port}/`, pick: "fires", mode: "delta" }],
    }),
  );
  try {
    const out = await withStatsManifest(manifest, () => collectStats());
    assert.deepEqual(out.custom.map((s) => [s.state, s.value]), [["unavailable", null]]);
    assert.notEqual(out.custom[0].value, 14, "the lifetime total must never leak through");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

test("STATS/delta: scopeToRun holds the whole contract", async () => {
  const { scopeToRun } = await import("../runstats.mjs");
  assert.deepEqual(scopeToRun(14, 10), { state: "ok", value: 4 });
  // A run that has fired nothing yet is a MEASURED zero and stays one.
  assert.deepEqual(scopeToRun(10, 10), { state: "ok", value: 0 });
  // No zero recorded for this run.
  assert.deepEqual(scopeToRun(14, undefined), { state: "unavailable", value: null });
  // The counter went BACKWARDS: the source restarted and began again, so the
  // snapshot describes a generation that no longer exists. Clamping to 0 here
  // would draw a freshly-restarted relay as a clean run.
  assert.deepEqual(scopeToRun(2, 10), { state: "unavailable", value: null });
});

test("STATS/delta: the baseline is taken per-run, sits beside the log, and round-trips", async () => {
  const { captureStatsBaseline, readStatsBaseline, baselinePathFor } = await import("../runstats.mjs");
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ fires: 10, turns: 684 }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), "okp-stats-"));
  const manifest = join(dir, "stats.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      stats: [
        { id: "fires", label: "LOOP ERRORS", url: `http://127.0.0.1:${port}/`, pick: "fires", mode: "delta" },
        // Not monotonic: no zero is taken for it and none is needed.
        { id: "turns", label: "TURNS", url: `http://127.0.0.1:${port}/`, pick: "turns" },
      ],
    }),
  );
  const logPath = join(dir, "off-cell-20260904T054056.log");
  try {
    const captured = await withStatsManifest(manifest, () => captureStatsBaseline({ logPath }));
    assert.deepEqual(captured, { fires: 10 }, "only monotonic sources get a zero");
    // BESIDE THE LOG, so retiring the tree retires the baseline with it. A
    // baseline that outlived its run would scope the NEXT run to the wrong zero.
    assert.equal(baselinePathFor(logPath), `${logPath}.stats-baseline.json`);
    assert.ok(existsSync(baselinePathFor(logPath)));
    assert.deepEqual(await readStatsBaseline({ logPath }), { fires: 10 });
    // A run with no baseline file gets `{}`, not a throw and not a guess.
    assert.deepEqual(await readStatsBaseline({ logPath: join(dir, "never-ran.log") }), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

test("STATS/delta: a source that is down at queue time does not block the launch", async () => {
  // captureStatsBaseline runs on the launch path, ahead of the spawn. A relay
  // that is down must cost the tile for that run, never the run.
  const { captureStatsBaseline } = await import("../runstats.mjs");
  const dir = mkdtempSync(join(tmpdir(), "okp-stats-"));
  const manifest = join(dir, "stats.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      // Port 1 is closed; the fetch fails rather than answering.
      stats: [{ id: "fires", label: "LOOP ERRORS", url: "http://127.0.0.1:1/", pick: "fires", mode: "delta" }],
    }),
  );
  const logPath = join(dir, "off-cell-20260904T054056.log");
  try {
    const captured = await withStatsManifest(manifest, () => captureStatsBaseline({ logPath }));
    assert.deepEqual(captured, {}, "an unreachable source contributes no zero and no exception");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The error slots count from the live streams (control/__tests__/turn-errors
// .test.mjs); the scorecard is their fallback for runs with no stream. The
// fallback table still has to hold: one distinct counter per slot, and the
// stream slot on the whole stream-failure family.
function scorecardErrorFields() {
  const src = readFileSync(join(HERE, "runstats.mjs"), "utf-8");
  const table = /const SCORECARD_ERROR_FIELD = \{([\s\S]*?)\};/.exec(src);
  assert.ok(table, "the scorecard fallback table has moved");
  return Object.fromEntries([...table[1].matchAll(/(\w+): "(\w+)"/g)].map((m) => [m[1], m[2]]));
}

test("STATS: STREAM ERRORS falls back to the whole stream-failure family, not one kind", () => {
  const fields = scorecardErrorFields();
  assert.equal(
    fields.stream,
    "instrument_anomaly_turns",
    "STREAM ERRORS must fall back to instrument_anomaly_turns — finalize_timeout_turns is a subset",
  );
});

test("STATS: each error slot reads a DIFFERENT counter", () => {
  const fields = Object.values(scorecardErrorFields());
  assert.equal(fields.length, 3, `expected three error counters, found ${fields.join(", ")}`);
  assert.equal(new Set(fields).size, 3, `two error slots read the same counter: ${fields.join(", ")}`);
});

test("STATS: every counter a slot reads is one the scorecard actually writes", () => {
  // The producer/consumer seam. A slot reading a field `build_scorecard` never
  // emits sits at "—" forever and nothing says why — which is how the missing
  // `instrument_anomaly_turns` went unnoticed.
  const src = readFileSync(join(HERE, "runstats.mjs"), "utf-8");
  const py = readFileSync(
    join(HERE, "..", "harness", "cumulative", "run_artifacts.py"),
    "utf-8",
  );
  const emitted = /error_totals = \{([\s\S]*?)\n    \}/.exec(py);
  assert.ok(emitted, "build_scorecard no longer builds error_totals");
  void src;
  for (const field of Object.values(scorecardErrorFields())) {
    assert.match(
      emitted[1],
      new RegExp(`"${field}"`),
      `the board reads error_totals.${field}, which build_scorecard does not write`,
    );
  }
});
