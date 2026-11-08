// ─────────────────────────────────────────────────────────────────────────────
// SOURCE: cost — the v2 cost.json reader.
//
// The fixtures are the two real shapes plus the absent one: a v1 stamp (the
// five archived files on disk today: `phases.{build,troubleshooting,total}`
// with integer `compactions` per bucket, no schema_version), a v2 stamp with
// the full wire contract, and an epoch-only stamp (v2 identity stated by
// `system_epoch` alone). readCell is exercised against a real tmpdir so the
// file is read through the same `readJson` the board uses — no mocked fs.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  id,
  cellFields,
  normalizeV2Cost,
  readV2Cost,
  readCell,
} from "./sources/cost.mjs";

/** The v1 shape on disk today: bucket-scoped counters, no version marker. */
const V1_COST = {
  model: "model-old",
  phases: {
    build: { input_tokens: 10, output_tokens: 5, compactions: 2 },
    troubleshooting: { input_tokens: 3, output_tokens: 1, compactions: 0 },
    total: { input_tokens: 13, output_tokens: 6, compactions: 2 },
  },
};

/** The full v2 wire contract, as the harness will write it. */
const V2_COST = {
  schema_version: 2,
  system_epoch: "2026-11-08",
  model: "m-local",
  provider: "local",
  outcome: "worked",
  terminal_reason: "stopped",
  void: { is_void: false, reason: null },
  cell_wall_seconds: 1234,
  measured_wall_seconds: 1200,
  paused_seconds: 34,
  price: null, // local model: N/A, decided downstream
  cost_usd: null,
  phases: {
    by_phase: [
      {
        name: "initial-chunk-1",
        layer: "build",
        build: { turns: 2 },
        troubleshooting: {},
      },
    ],
    build: { turns: 2 },
    troubleshooting: { turns: 0 },
    total: { turns: 2, input_tokens: 10 },
  },
  compactions: {
    count: 1,
    positions: [
      { ts: "2026-11-08T00:00:00Z", measured_offset_s: 12, phase_index: 0, phase_kind: "build" },
    ],
  },
};

test("cost source: id + cellFields name the source and the field it owns", () => {
  assert.equal(id, "cost");
  assert.deepEqual(cellFields, ["cost"]);
});

test("cost source: a v1 stamp is not v2 — null, never a half-shaped projection", () => {
  assert.equal(normalizeV2Cost(V1_COST), null, "bucketed v1 phases with integer compactions");
  assert.equal(normalizeV2Cost({ phases: {} }), null, "the degenerate v1 file");
  assert.equal(
    normalizeV2Cost({ ...V1_COST, compactions: 2 }),
    null,
    "a v1 stamp that states no version marker is still v1",
  );
});

test("cost source: null and non-objects are null", () => {
  assert.equal(normalizeV2Cost(null), null);
  assert.equal(normalizeV2Cost(undefined), null);
  assert.equal(normalizeV2Cost("{\"schema_version\":2}"), null, "a string is not the stamp");
  assert.equal(normalizeV2Cost(42), null);
  assert.equal(normalizeV2Cost([]), null, "an array is not the stamp");
});

test("cost source: a schema_version-2 stamp normalizes field-for-field, verbatim", () => {
  const cost = normalizeV2Cost(V2_COST);
  assert.deepEqual(cost, {
    system_epoch: "2026-11-08",
    model: "m-local",
    provider: "local",
    outcome: "worked",
    terminal_reason: "stopped",
    void: { is_void: false, reason: null },
    cell_wall_seconds: 1234,
    measured_wall_seconds: 1200,
    paused_seconds: 34,
    price: null, // survives as null — never 0
    cost_usd: null,
    phases: V2_COST.phases, // by_phase/build/troubleshooting/total untouched
    compactions: V2_COST.compactions, // {count, positions[]} untouched
  });
  assert.deepEqual(
    cost.phases.by_phase,
    V2_COST.phases.by_phase,
    "phases.by_phase survives verbatim",
  );
  assert.deepEqual(
    cost.compactions.positions,
    V2_COST.compactions.positions,
    "compactions.positions survives verbatim",
  );
});

test("cost source: the epoch alone identifies v2 (no schema_version needed)", () => {
  const { schema_version, ...epochOnly } = V2_COST;
  assert.equal(schema_version, 2);
  const cost = normalizeV2Cost(epochOnly);
  assert.notEqual(cost, null, "system_epoch 2026-11-08 is a v2 identity");
  assert.equal(cost.system_epoch, "2026-11-08");
});

test("cost source: an absent field is null, never invented", () => {
  const cost = normalizeV2Cost({ schema_version: 2, system_epoch: "2026-11-08" });
  for (const key of [
    "model", "provider", "outcome", "terminal_reason", "void",
    "cell_wall_seconds", "measured_wall_seconds", "paused_seconds",
    "price", "cost_usd", "phases", "compactions",
  ]) {
    assert.equal(cost[key], null, `${key} is unrecorded, so null`);
  }
});

/** A tmpdir bench with one cell directory; no cost.json yet. */
function fixture() {
  const runsRoot = mkdtempSync(join(tmpdir(), "cost-source-"));
  const cellDir = join(runsRoot, "camp", "memoryOFF", "cell-0000");
  mkdirSync(cellDir, { recursive: true });
  const ctx = {
    runsRoot,
    benchRoot: runsRoot,
    cell: { run_dir: "camp", sequence_index: 0 },
  };
  return { runsRoot, cellDir, ctx };
}

test("cost source: readV2Cost reads the real file — absent and v1 are null", async () => {
  const { runsRoot, cellDir } = fixture();
  try {
    assert.equal(await readV2Cost(cellDir), null, "no cost.json yet");

    writeFileSync(join(cellDir, "cost.json"), JSON.stringify(V1_COST));
    assert.equal(await readV2Cost(cellDir), null, "a v1 stamp reads as no v2 cost");

    writeFileSync(join(cellDir, "cost.json"), JSON.stringify(V2_COST));
    assert.deepEqual(await readV2Cost(cellDir), normalizeV2Cost(V2_COST));

    assert.equal(await readV2Cost(null), null, "no directory is no cost");
    assert.equal(await readV2Cost(join(runsRoot, "missing")), null);
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});

test("cost source: readCell states the absence, then the stamp", async () => {
  const { runsRoot, cellDir, ctx } = fixture();
  try {
    assert.deepEqual(await readCell(ctx), { ok: false, reason: "no v2 cost.json" });

    writeFileSync(join(cellDir, "cost.json"), JSON.stringify(V1_COST));
    assert.deepEqual(
      await readCell(ctx),
      { ok: false, reason: "no v2 cost.json" },
      "a v1 stamp is stated as absent, not projected",
    );

    writeFileSync(join(cellDir, "cost.json"), JSON.stringify(V2_COST));
    const res = await readCell(ctx);
    assert.equal(res.ok, true);
    assert.deepEqual(res.patch.cost, normalizeV2Cost(V2_COST));

    assert.deepEqual(
      await readCell({ runsRoot, cell: { run_dir: "camp", sequence_index: 7 } }),
      { ok: false, reason: "no v2 cost.json" },
      "an unresolved cell directory is the same absence",
    );
  } finally {
    rmSync(runsRoot, { recursive: true, force: true });
  }
});
