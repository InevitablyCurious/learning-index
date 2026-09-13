// ─────────────────────────────────────────────────────────────────────────────
// BENCHMARK TREE — the reader half
//
// This board ships as a container that copies `dashboard/` alone, so it carries
// its OWN copy of the tree rules rather than importing control/tree.mjs. A
// duplicated rule is a rule that can drift, and the drift would be silent: the
// control plane would write campaigns into a tree this board never reads, and
// the board would show a bench that looks idle while a cell burns hours.
//
// These tests pin the reader against the same behaviour control/control.test.mjs
// pins the writer against.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listCampaignDirs, activeTreeId, isTreeId, activeRun } from "./sources/_runtime.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dashtree-"));
  const runs = join(root, "runs");
  mkdirSync(runs, { recursive: true });
  return { root, runs };
}

function pointAt(runs, id) {
  writeFileSync(join(runs, "active-tree.json"), JSON.stringify({ active: id, created_at: null, history: [] }));
}

function campaignAt(runs, rel, createdAt = "2026-08-20T00:00:00Z") {
  const dir = join(runs, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ created_at: createdAt }));
  writeFileSync(join(dir, "manifest.status.jsonl"), "");
  return dir;
}

test("READER: tree ids are unix seconds and nothing else", () => {
  assert.equal(isTreeId("1787310000"), true);
  assert.equal(isTreeId("cumulative-model"), false);
  assert.equal(isTreeId(""), false);
});

test("READER: nested campaigns are found, and cells inside them are not campaigns", async () => {
  const { root, runs } = fixture();
  try {
    pointAt(runs, "1787310000");
    campaignAt(runs, join("1787310000", "local", "local-llm-proxy", "omlx", "model-a"));
    campaignAt(runs, join("1787310000", "cloud", "orcarouter", "deepseek", "deepseek-v4"));
    // Depth-bounded: a cell must not be walked into on a 2s poll.
    mkdirSync(join(runs, "1787310000", "local", "local-llm-proxy", "omlx", "model-a", "memoryOFF", "cell-0000"), {
      recursive: true,
    });

    const found = await listCampaignDirs(runs);
    assert.equal(found.length, 2);
    assert.ok(found.some((c) => c.name === "model-a"));
    assert.ok(found.some((c) => c.name === "deepseek-v4"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("READER: a retired tree is not read, and legacy flat history still is", async () => {
  const { root, runs } = fixture();
  try {
    campaignAt(runs, join("1787310000", "local", "local-llm-proxy", "omlx", "old-model"));
    campaignAt(runs, join("1787320000", "local", "local-llm-proxy", "omlx", "new-model"));
    campaignAt(runs, "cumulative-legacy-model");
    pointAt(runs, "1787320000");

    const live = await listCampaignDirs(runs);
    const names = live.map((c) => c.name).sort();
    // THE WIPE, ENTIRELY: the retired tree's campaign is absent from the board
    // while its files sit untouched on disk.
    assert.deepEqual(names, ["cumulative-legacy-model", "new-model"]);

    // liveOnly:false is the audit view — everything on disk, including retired.
    assert.equal((await listCampaignDirs(runs, { liveOnly: false })).length, 3);
    assert.equal(await activeTreeId(runs), "1787320000");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("READER: activeRun resolves a nested campaign — the board is not blind under the tree", async () => {
  const { root, runs } = fixture();
  try {
    pointAt(runs, "1787310000");
    const dir = campaignAt(runs, join("1787310000", "local", "local-llm-proxy", "omlx", "model-a"));

    const run = await activeRun(runs);
    assert.ok(run, "a nested campaign must resolve — a one-level scan reported none");
    assert.equal(run.name, "model-a");
    assert.equal(run.dir, dir);
    assert.ok(run.manifestPath?.endsWith("manifest.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("READER: with no pointer at all, every campaign is read (a pre-tree bench)", async () => {
  const { root, runs } = fixture();
  try {
    campaignAt(runs, "cumulative-a");
    campaignAt(runs, "cumulative-b");
    // No pointer written: this bench predates the tree and must not go blank.
    assert.equal((await listCampaignDirs(runs)).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("READER: the backup folder is never read as bench data", async () => {
  const { root, runs } = fixture();
  try {
    pointAt(runs, "1787320000");
    campaignAt(runs, join("1787320000", "local", "local-llm-proxy", "omlx", "new-model"));
    // Exactly the shape resetAll leaves behind.
    campaignAt(runs, join("backups", "1787320000", "1787310000", "local", "local-llm-proxy", "omlx", "old-model"));
    campaignAt(runs, join("backups", "1787320000", "cumulative-legacy-model"));

    const live = await listCampaignDirs(runs);
    assert.deepEqual(live.map((c) => c.name), ["new-model"],
      "a board that reads the backup would repopulate itself from the data the reset just moved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
