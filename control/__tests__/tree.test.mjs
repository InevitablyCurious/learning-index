// ─────────────────────────────────────────────────────────────────────────────
// TREE TESTS — split VERBATIM from control/control.test.mjs (lines 3259–3472).
// treeFixture/campaignAt are imported from ./_shared.mjs, not redefined.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isArchivedRun } from "../baselines.mjs";
import { campaignTargetFor } from "../campaign.mjs";
import {
  segment,
  subjectTriple,
  campaignSegments,
  isTreeId,
  campaignTreeId,
  mintTree,
  ensureTree,
  activeTreeId,
  readTreePointer,
  listCampaignDirs,
  listLiveCampaignDirs,
  TREE_POINTER,
} from "../tree.mjs";
import { runDirOf } from "../runstate.mjs";
import { treeFixture, campaignAt } from "./_shared.mjs";

test("TREE: a segment can never carry a dot or a slash", () => {
  // A DOT WOULD MAKE THE CAMPAIGN INVISIBLE. isArchivedRun() reads any dot as
  // the archive convention, so `qwen3.6-…` would land in a directory every floor
  // reader skips — the baseline would simply vanish with no error anywhere.
  assert.equal(segment("qwen3.6-35b-a3b-bench"), "qwen3-6-35b-a3b-bench");
  assert.equal(isArchivedRun(segment("qwen3.6-35b")), false);
  // A SLASH WOULD BE ANOTHER LEVEL OF TREE, landing the campaign one directory
  // deeper than every reader looks for it.
  assert.equal(segment("anthropic/claude-opus-5"), "anthropic-claude-opus-5");
  // An empty segment silently collapses a level, so it is named instead.
  assert.equal(segment(""), "unknown");
  assert.equal(segment(null, "unknown-model"), "unknown-model");
});

test("TREE: the subject triple is total for every shape the harness produces", () => {
  // Cloud: `{provider}/{model}` under a router — what _compose_cloud_slug builds.
  assert.deepEqual(subjectTriple({ kind: "cloud", cloud: { provider: "deepseek", model: "deepseek-v4" } }), {
    substrate: "cloud",
    router: "orcarouter",
    provider: "deepseek",
    model: "deepseek-v4",
  });
  // Local bench aliases are BARE. The proxy is the normalizer and oMLX is its
  // backend, so those are stated rather than left blank.
  assert.deepEqual(subjectTriple({ kind: "local", model: "qwen3.6-35b-a3b-bench" }), {
    substrate: "local",
    router: "local-llm-proxy",
    provider: "omlx",
    model: "qwen3-6-35b-a3b-bench",
  });
  // An explicit local slug is honoured as written.
  assert.deepEqual(subjectTriple({ kind: "local", model: "local-llm-proxy/vontra/deepseek-v4-flash" }), {
    substrate: "local",
    router: "local-llm-proxy",
    provider: "vontra",
    model: "deepseek-v4-flash",
  });
  // TOTAL MEANS TOTAL: a subject that failed to resolve would land its campaign
  // where no reader looks and present as a run that produced nothing.
  const empty = subjectTriple({});
  assert.equal(empty.substrate, "local");
  assert.ok(empty.model, "an unnameable model still gets a named directory");
  assert.equal(campaignSegments({ kind: "cloud", cloud: { provider: "p", model: "m" } }).length, 4);
});

test("TREE: minting points the pointer forward and DELETES NOTHING", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    const first = await mintTree(runs, { now: 1787310000_000 });
    campaignAt(runs, join(first.active, "local", "local-llm-proxy", "omlx", "model-a"));
    assert.equal(await activeTreeId(runs), first.active);

    const second = await mintTree(runs, { now: 1787320000_000 });
    assert.equal(second.previous, first.active, "the retired tree is named back to the caller");
    assert.equal(await activeTreeId(runs), second.active);

    // THE WHOLE SAFETY PROPERTY. A reset that unlinked would be the same class
    // of irreversible act that cost this bench a night of records once.
    assert.ok(existsSync(join(runs, first.active)), "the retired tree is still on disk");
    assert.ok(
      existsSync(join(runs, first.active, "local", "local-llm-proxy", "omlx", "model-a", "manifest.json")),
      "the retired tree's measurements are untouched",
    );
    const pointer = await readTreePointer(runs);
    assert.deepEqual(pointer.history, [first.active], "the retired tree stays findable by id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TREE: two resets inside one second are refused rather than sharing a tree", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    await mintTree(runs, { now: 1787310000_000 });
    // Silently re-pointing at an existing tree would put the second operator's
    // cells on top of the first operator's measurements.
    await assert.rejects(() => mintTree(runs, { now: 1787310000_400 }), /already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TREE: an unreadable pointer raises rather than silently starting a new tree", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, TREE_POINTER), "{ this is not json");
    // Absent and unreadable are DIFFERENT answers. Collapsing them would route a
    // live campaign into a brand new tree and present as the whole run history
    // having vanished.
    await assert.rejects(() => readTreePointer(runs), /refusing to guess/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TREE: discovery finds nested campaigns AND legacy flat ones", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    const t = await mintTree(runs, { now: 1787310000_000 });
    campaignAt(runs, join(t.active, "local", "local-llm-proxy", "omlx", "model-a"));
    campaignAt(runs, join(t.active, "cloud", "orcarouter", "deepseek", "deepseek-v4"));
    // Pre-tree history must not disappear the moment this ships.
    campaignAt(runs, "cumulative-legacy-model");

    const found = await listCampaignDirs(runs);
    assert.equal(found.length, 3, "two nested and one flat");
    assert.ok(found.some((c) => c.name === "model-a"));
    assert.ok(found.some((c) => c.name === "cumulative-legacy-model"));

    // A campaign never contains another campaign — the walk must not descend
    // into worktrees and node_modules on a 2s board poll.
    mkdirSync(join(runs, t.active, "local", "local-llm-proxy", "omlx", "model-a", "memoryOFF", "cell-0000"), {
      recursive: true,
    });
    assert.equal((await listCampaignDirs(runs)).length, 3, "cells are not campaigns");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TREE: a retired tree stops being read, and that is the whole of the wipe", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    const first = await mintTree(runs, { now: 1787310000_000 });
    campaignAt(runs, join(first.active, "local", "local-llm-proxy", "omlx", "model-a"));
    campaignAt(runs, "cumulative-legacy-model");
    assert.equal((await listLiveCampaignDirs(runs)).length, 2);

    await mintTree(runs, { now: 1787320000_000 });
    const live = await listLiveCampaignDirs(runs);
    // The retired tree's campaign is gone from the board WITHOUT being deleted.
    assert.ok(!live.some((c) => c.name === "model-a"), "the retired tree is not read");
    // Legacy flat campaigns are not inside any tree and are never retired by a
    // reset — retiring them would be a deletion the operator never asked for.
    assert.ok(live.some((c) => c.name === "cumulative-legacy-model"), "legacy history survives a reset");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TREE: campaignTargetFor composes the tree path, and falls back when there is no tree", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });

    // No tree yet → the legacy resolver, byte-identical to before.
    const legacy = await campaignTargetFor({ model: "model-a", kind: "local" }, runs);
    assert.equal(legacy.tree, null);
    assert.ok(legacy.manifest_arg.endsWith(join("cumulative-model-a", "manifest.json")));

    const t = await ensureTree(runs, { now: 1787310000_000 });
    assert.equal(t.minted, true, "a fresh bench self-initialises rather than requiring a reset first");

    const local = await campaignTargetFor({ model: "qwen3.6-35b", kind: "local" }, runs);
    assert.equal(local.tree, t.active);
    assert.ok(
      local.manifest_arg.endsWith(join(t.active, "local", "local-llm-proxy", "omlx", "qwen3-6-35b", "manifest.json")),
      `unexpected local path: ${local.manifest_arg}`,
    );

    const cloud = await campaignTargetFor(
      { model: "deepseek-v4", kind: "cloud", cloud: { provider: "deepseek", model: "deepseek-v4" } },
      runs,
    );
    assert.ok(
      cloud.manifest_arg.endsWith(join(t.active, "cloud", "orcarouter", "deepseek", "deepseek-v4", "manifest.json")),
      `unexpected cloud path: ${cloud.manifest_arg}`,
    );

    // A bare string is still accepted — every pre-tree call site keeps working.
    const bare = await campaignTargetFor("model-a", runs);
    assert.equal(bare.tree, t.active);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TREE: a run dir is resolved as a PATH, so a retired tree cannot read as live", () => {
  // The campaign home is nested; a capture that stops at the first slash yields
  // the TREE ID, which exists on disk for every retired tree — so a dead log
  // would resolve as live and the wipe boundary would never trip.
  assert.equal(
    runDirOf("PROGRESS step=worktree-git-init path=/x/runs/1787310000/local/local-llm-proxy/omlx/m/memoryOFF/cell-0000/worktree\n"),
    "1787310000/local/local-llm-proxy/omlx/m",
  );
  // Legacy paths resolve EXACTLY as they always did.
  assert.equal(runDirOf("path=/x/runs/cumulative/sessions/cell/worktree\n"), "cumulative");
  assert.equal(runDirOf("path=/x/runs/cumulative.gone/s/w\n"), "cumulative.gone");
  assert.equal(runDirOf("no path here"), null);
  assert.equal(isTreeId("1787310000"), true);
  assert.equal(isTreeId("cumulative"), false);
  assert.equal(campaignTreeId(join("1787310000", "local", "r", "p", "m")), "1787310000");
  assert.equal(campaignTreeId(join("cumulative-model", "x")), null);
});


// ═════════════════════════════════════════════════════════════════════════════
// RESET ALL BENCHMARK DATA
// ═════════════════════════════════════════════════════════════════════════════

