// LIVE BUILD — the build the grader judged last, kept running for the cell in
// flight.
//
// The board's LIVE BUILD panel only frames what the play registry says is
// running, so it can sit on a screen and stay current with no click. This loop
// is what keeps the registry current: while a cell is in flight it boots the
// newest GRADED round (play.mjs latestGraded: the round's checkpoint, never
// the model's working copy) and boots again when a newer round is graded. Jerry,
// 2026-10-28: the working copy mid-edit showed broken triangles and pieces the
// grader never saw — "i need to be able to see what the grader and you are
// seeing". A new run therefore gets its own build once its first round is
// graded, and the previous run's build is replaced.
//
// A build somebody started by hand AFTER this run began is theirs and is left
// alone; anything started before the run began is a stale leftover and is
// replaced. A round whose build will not boot is not retried until a newer
// round is graded, so it never spins.

import { join } from "node:path";

import { latestGraded, startPlay, playStatus, stopPlay } from "./play.mjs";
import { cellDirForRun, readRunState } from "./runstate.mjs";

export const LIVEBUILD_TICK_MS = 4_000;
/** Never boot more often than this, whatever changed. */
export const MIN_BOOT_GAP_MS = 6_000;

/**
 * One look. `memo` is this loop's own memory: the cell it last booted, when,
 * and the graded round that boot served. Returns what it did, for the test and the
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
  const graded = deps.graded(live.cellDir);
  if (!graded) return "idle"; // no round graded yet

  const playing = deps.playing();
  const ours = playing && `${playing.run}::${playing.cell}` === key;
  if (playing && !ours) {
    const startedAt = Date.parse(playing.started_at);
    const handStarted = Number.isFinite(startedAt) && startedAt >= live.startedAt;
    if (handStarted && memo.key !== `${playing.run}::${playing.cell}`) return "left_alone";
  }

  const changed = memo.key !== key || graded.attempt !== memo.attempt;
  const dead = memo.key === key && memo.ok === true && !ours; // we booted it and it is gone
  if (!changed && !dead) return "waiting";
  if (memo.key === key && now - memo.at < MIN_BOOT_GAP_MS) return "waiting";

  memo.key = key;
  memo.at = now;
  memo.attempt = graded.attempt;
  const r = await deps.boot({ run: live.benchmarkId, cell: live.cell });
  memo.ok = r?.ok === true;
  if (memo.ok) {
    deps.log(`[livebuild] ${key} round ${graded.attempt} booted on port ${r.port}`);
    return "booted";
  }
  deps.log(`[livebuild] ${key} round ${graded.attempt} did not boot (${r?.code ?? "unknown"}); waiting for the next graded round`);
  return "failed";
}

export function startLivebuildLoop({ benchRoot, runsRoot }) {
  const memo = { key: null, at: 0, attempt: null, ok: false };
  const deps = {
    now: () => Date.now(),
    log: (msg) => console.log(msg),
    graded: latestGraded,
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
        cellDir: join(runsRoot, cell.cellDir),
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
