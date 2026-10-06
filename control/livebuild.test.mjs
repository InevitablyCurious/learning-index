// The live-build loop: boots the cell in flight's build, again after the source
// goes quiet, never for a build somebody started by hand during the run.

import assert from "node:assert/strict";
import test from "node:test";

import { livebuildTick, MIN_BOOT_GAP_MS, QUIET_MS } from "./livebuild.mjs";

const LIVE = { benchmarkId: "t1", cell: "memoryOFF/cell-0000", worktree: "/w", startedAt: 1_000 };

function rig({ mtime = 5_000, now = 100_000, playing = null, live = LIVE, bootOk = true } = {}) {
  const calls = [];
  const r = { mtime, now, playing, live, calls };
  r.deps = {
    now: () => r.now,
    log: () => {},
    liveCell: async () => r.live,
    sourceMtime: async () => r.mtime,
    hasSource: () => true,
    playing: () => r.playing,
    boot: async (a) => {
      calls.push(a);
      if (bootOk) r.playing = { run: a.run, cell: a.cell, started_at: new Date(r.now).toISOString() };
      return bootOk ? { ok: true } : { ok: false, code: "boot_failed" };
    },
  };
  return r;
}

test("no cell in flight: nothing happens", async () => {
  const r = rig({ live: null });
  assert.equal(await livebuildTick(r.deps, { key: null, at: 0, mtime: 0 }), "idle");
  assert.equal(r.calls.length, 0);
});

test("a new run is booted, then left alone until its source changes", async () => {
  const r = rig();
  const memo = { key: null, at: 0, mtime: 0 };
  assert.equal(await livebuildTick(r.deps, memo), "booted");
  assert.equal(await livebuildTick(r.deps, memo), "waiting");
  assert.equal(r.calls.length, 1);
});

test("a change is booted only after it has been quiet, and not faster than the gap", async () => {
  const r = rig();
  const memo = { key: null, at: 0, mtime: 0 };
  await livebuildTick(r.deps, memo);
  r.now += MIN_BOOT_GAP_MS + 1;
  r.mtime = r.now - 1_000; // changed a second ago: still being written
  assert.equal(await livebuildTick(r.deps, memo), "waiting");
  r.now += QUIET_MS + 1;
  assert.equal(await livebuildTick(r.deps, memo), "booted");
  assert.equal(r.calls.length, 2);
});

test("a build that will not boot is not retried until the source changes", async () => {
  const r = rig({ bootOk: false });
  const memo = { key: null, at: 0, mtime: 0 };
  assert.equal(await livebuildTick(r.deps, memo), "failed");
  r.now += MIN_BOOT_GAP_MS * 5;
  assert.equal(await livebuildTick(r.deps, memo), "waiting");
  assert.equal(r.calls.length, 1);
});

test("a stale build from before the run is replaced; one started by hand during it is not", async () => {
  const stale = rig({ playing: { run: "old", cell: "c", started_at: new Date(500).toISOString() } });
  assert.equal(await livebuildTick(stale.deps, { key: null, at: 0, mtime: 0 }), "booted");
  const hand = rig({ playing: { run: "old", cell: "c", started_at: new Date(50_000).toISOString() } });
  assert.equal(await livebuildTick(hand.deps, { key: null, at: 0, mtime: 0 }), "left_alone");
  assert.equal(hand.calls.length, 0);
});

test("a build that died is booted again", async () => {
  const r = rig();
  const memo = { key: null, at: 0, mtime: 0 };
  await livebuildTick(r.deps, memo);
  r.playing = null;
  r.now += MIN_BOOT_GAP_MS + 1;
  assert.equal(await livebuildTick(r.deps, memo), "booted");
});
