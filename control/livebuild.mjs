// LIVE BUILD — the model's own game, kept running for the cell in flight.
//
// The board's LIVE BUILD panel only frames what the play registry says is
// running, so it can sit on a screen and stay current with no click. This loop
// is what keeps the registry current: while a cell is in flight it boots the
// build (play.mjs, the same boot a person's click made) and boots it again
// whenever the model's source changes, once the changes have gone quiet. A new
// run therefore gets its own build on its own, and the previous run's build is
// replaced.
//
// A build somebody started by hand AFTER this run began is theirs and is left
// alone; anything started before the run began is a stale leftover and is
// replaced. A build that will not boot (half-written code) is not retried until
// the source changes again, so it never spins.

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { startPlay, playStatus, stopPlay } from "./play.mjs";
import { cellDirForRun, readRunState } from "./runstate.mjs";

export const LIVEBUILD_TICK_MS = 4_000;
/** The source must have been still this long before it is booted again. */
export const QUIET_MS = 3_000;
/** Never boot more often than this, whatever changed. */
export const MIN_BOOT_GAP_MS = 6_000;

const SKIP_DIRS = new Set(["node_modules", ".git", "test-results"]);

/** Newest modification time (ms) of the build's own files, or 0 when none. */
export async function newestSourceMtime(worktree) {
  let newest = 0;
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && depth < 6) await walk(join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        try {
          newest = Math.max(newest, (await stat(join(dir, e.name))).mtimeMs);
        } catch {
          // vanished between listing and stat
        }
      }
    }
  }
  await walk(worktree, 0);
  return newest;
}

/**
 * One look. `memo` is this loop's own memory: the cell it last booted, when,
 * and the source time that boot saw. Returns what it did, for the test and the
 * log: "idle" | "waiting" | "booted" | "failed" | "left_alone".
 */
export async function livebuildTick(deps, memo) {
  const live = await deps.liveCell();
  if (!live) {
    // The cell ended: the build this loop started goes with it (a build a person
    // started by hand is not ours to stop). The final build stays playable from
    // the run's history.
    if (memo.ok === true && memo.key !== null) {
      const playing = deps.playing();
      if (playing && `${playing.run}::${playing.cell}` === memo.key) await deps.stop();
      deps.log(`[livebuild] ${memo.key} ended; its build was stopped`);
    }
    memo.key = null;
    memo.ok = false;
    return "idle";
  }

  const key = `${live.benchmarkId}::${live.cell}`;
  const now = deps.now();
  const mtime = await deps.sourceMtime(live.worktree);
  if (mtime === 0 || !deps.hasSource(live.worktree)) return "idle"; // nothing built yet

  const playing = deps.playing();
  const ours = playing && `${playing.run}::${playing.cell}` === key;
  if (playing && !ours) {
    const startedAt = Date.parse(playing.started_at);
    const handStarted = Number.isFinite(startedAt) && startedAt >= live.startedAt;
    if (handStarted && memo.key !== `${playing.run}::${playing.cell}`) return "left_alone";
  }

  const changed = memo.key !== key || mtime > memo.mtime;
  const dead = memo.key === key && memo.ok === true && !ours; // we booted it and it is gone
  if (!changed && !dead) return "waiting";
  if (memo.key === key && now - memo.at < MIN_BOOT_GAP_MS) return "waiting";
  if (memo.key === key && now - mtime < QUIET_MS) return "waiting"; // still being written

  memo.key = key;
  memo.at = now;
  memo.mtime = mtime;
  const r = await deps.boot({ run: live.benchmarkId, cell: live.cell });
  memo.ok = r?.ok === true;
  if (memo.ok) {
    deps.log(`[livebuild] ${key} booted on port ${r.port}`);
    return "booted";
  }
  deps.log(`[livebuild] ${key} did not boot (${r?.code ?? "unknown"}); waiting for the next change`);
  return "failed";
}

export function startLivebuildLoop({ benchRoot, runsRoot }) {
  const memo = { key: null, at: 0, mtime: 0, ok: false };
  const deps = {
    now: () => Date.now(),
    log: (msg) => console.log(msg),
    sourceMtime: newestSourceMtime,
    hasSource: (worktree) => existsSync(join(worktree, "src")),
    playing: () => playStatus(benchRoot),
    boot: (args) => startPlay({ runsRoot, benchRoot, ...args }),
    stop: () => stopPlay(benchRoot),
    liveCell: async () => {
      const state = await readRunState({ runsRoot });
      const run = (state.runs ?? [])[0];
      if (!run) return null;
      const cell = await cellDirForRun(runsRoot, run.run_dir, run.sequence_index);
      if (!cell) return null;
      const segs = cell.cellDir.split("/");
      return {
        benchmarkId: segs[0],
        cell: segs.slice(1).join("/"),
        worktree: join(runsRoot, cell.cellDir, "worktree"),
        startedAt: Number(run.started_at) || 0,
      };
    },
  };
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    livebuildTick(deps, memo)
      .catch((err) => console.error(`[livebuild] ${err?.message ?? err}`))
      .finally(() => {
        busy = false;
      });
  }, LIVEBUILD_TICK_MS).unref?.();
}
