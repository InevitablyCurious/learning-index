// The live-build loop: boots the cell in flight's newest GRADED round, again
// when a newer round is graded, never the working copy, and never a build
// somebody started by hand during the run.

import assert from "node:assert/strict";
import test from "node:test";

import { livebuildTick, MIN_BOOT_GAP_MS } from "./livebuild.mjs";

const LIVE = { benchmarkId: "t1", cell: "memoryOFF/cell-0000", cellDir: "/c", startedAt: 1_000 };

function rig({ attempt = 1, now = 100_000, playing = null, live = LIVE, bootOk = true } = {}) {
  const calls = [];
  const r = { attempt, now, playing, live, calls };
  r.deps = {
    now: () => r.now,
    log: () => {},
    liveCell: async () => r.live,
    graded: () => (r.attempt === null ? null : { attempt: r.attempt, tree: `/c/checkpoints/cp-0${r.attempt}/tree` }),
    stop: async () => {
      calls.push({ stop: true });
      r.playing = null;
    },
    playing: () => r.playing,
    boot: async (a) => {
      calls.push(a);
      if (bootOk) r.playing = { run: a.run, cell: a.cell, started_at: new Date(r.now).toISOString() };
      return bootOk ? { ok: true } : { ok: false, code: "boot_failed" };
    },
  };
  return r;
}

const fresh = () => ({ key: null, at: 0, attempt: null, ok: false });

test("no cell in flight: nothing happens", async () => {
  const r = rig({ live: null });
  assert.equal(await livebuildTick(r.deps, fresh()), "idle");
  assert.equal(r.calls.length, 0);
});

test("before the first round is graded there is nothing to show", async () => {
  const r = rig({ attempt: null });
  assert.equal(await livebuildTick(r.deps, fresh()), "idle");
  assert.equal(r.calls.length, 0);
});

test("a graded round is booted, then left alone while the model works", async () => {
  const r = rig();
  const memo = fresh();
  assert.equal(await livebuildTick(r.deps, memo), "booted");
  r.now += MIN_BOOT_GAP_MS * 10;
  assert.equal(await livebuildTick(r.deps, memo), "waiting");
  assert.equal(r.calls.length, 1);
});

test("a newer graded round is booted, not faster than the gap", async () => {
  const r = rig();
  const memo = fresh();
  await livebuildTick(r.deps, memo);
  r.attempt = 2;
  assert.equal(await livebuildTick(r.deps, memo), "waiting");
  r.now += MIN_BOOT_GAP_MS + 1;
  assert.equal(await livebuildTick(r.deps, memo), "booted");
  assert.equal(memo.attempt, 2);
  assert.equal(r.calls.length, 2);
});

test("a round that will not boot is not retried until a newer round is graded", async () => {
  const r = rig({ bootOk: false });
  const memo = fresh();
  assert.equal(await livebuildTick(r.deps, memo), "failed");
  r.now += MIN_BOOT_GAP_MS * 5;
  assert.equal(await livebuildTick(r.deps, memo), "waiting");
  assert.equal(r.calls.length, 1);
});

test("a stale build from before the run is replaced; one started by hand during it is not", async () => {
  const stale = rig({ playing: { run: "old", cell: "c", started_at: new Date(500).toISOString() } });
  assert.equal(await livebuildTick(stale.deps, fresh()), "booted");
  const hand = rig({ playing: { run: "old", cell: "c", started_at: new Date(50_000).toISOString() } });
  assert.equal(await livebuildTick(hand.deps, fresh()), "left_alone");
  assert.equal(hand.calls.length, 0);
});

test("a build that died is booted again", async () => {
  const r = rig();
  const memo = fresh();
  await livebuildTick(r.deps, memo);
  r.playing = null;
  r.now += MIN_BOOT_GAP_MS + 1;
  assert.equal(await livebuildTick(r.deps, memo), "booted");
});

test("when the cell ends, the build this loop started is stopped; a hand-started one is not", async () => {
  const r = rig();
  const memo = fresh();
  await livebuildTick(r.deps, memo);
  r.live = null;
  assert.equal(await livebuildTick(r.deps, memo), "idle");
  assert.equal(r.calls.filter((c) => c.stop).length, 1);
  assert.equal(memo.key, null);

  const hand = rig({ playing: { run: "x", cell: "y", started_at: new Date(50_000).toISOString() } });
  const m2 = fresh();
  hand.live = null;
  await livebuildTick(hand.deps, m2);
  assert.equal(hand.calls.length, 0);
});
