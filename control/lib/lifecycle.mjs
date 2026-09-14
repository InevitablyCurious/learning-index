// ─────────────────────────────────────────────────────────────────────────────
// CONTROL PLANE — RUN LIFECYCLE
//
// Split out of server.mjs (LI-14 phase 1), byte-verbatim: which run directory
// a run-scoped read defaults to, the watch on services that announce nothing,
// and the stop path. The mutable cells these read and reassign (launcher,
// counterWatch) live in ../state.mjs behind get/set accessors — an ESM import
// binding is READ-ONLY in the importer, so a bare `let` export could never be
// reassigned from here.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from "node:child_process";

import { readRunState, pidAlive, findHarnessProcs } from "../runstate.mjs";
import { notice } from "../notices.mjs";
import {
  RUNS_ROOT,
  tui,
  getLauncher,
  setLauncher,
  getCounterWatch,
  setCounterWatch,
} from "../state.mjs";

/**
 * WHICH RUN DIRECTORY A RUN-SCOPED READ SHOULD DEFAULT TO.
 *
 * ── THE HOLE THIS FILLS ─────────────────────────────────────────────────────
 *
 * Run-scoped surfaces (`/api/wall`, `/api/feedback`) take `?run_dir=` and fell
 * back to the literal `"cumulative"` when the caller named none. That was true
 * while every cell wrote to `runs/cumulative`, and stopped being true when
 * campaigns became per-model: `campaign.mjs:campaignDirName` now lands a cell in
 * `runs/cumulative-<model>`, and the legacy directory is ARCHIVED on a wipe
 * (RUNBOOK §2) rather than reused.
 *
 * So the default addressed a directory that does not exist. `readWall` handled
 * that exactly as designed — no pinned roster, so it enumerated the live suite,
 * and no `manifest.status.jsonl`, so no gate carried an outcome — and served a
 * TRUE 71-gate denominator with zero results against it. The board rendered
 * what it was sent: `0/71 passing` over 71 empty squares, on a run whose own
 * artifacts recorded 16 passing, 2 failing, 53 not run.
 *
 * THE LOG IS THE AUTHORITY, not a name pattern. `newestLog` (via `readRunState`)
 * resolves the run directory from the harness's own PROGRESS lines and rejects a
 * log whose directory is gone, so this follows a rename, a per-model campaign,
 * and the legacy layout without knowing about any of them — `readGateActivity`
 * already resolves the live run this way.
 *
 * NULL IS A REAL ANSWER. A bench with no cell log has no active run, and this
 * returns null so `resolveRunDir` falls through to `DEFAULT_RUN_DIR` and the
 * reader reports `unwired` with its reason. An invented directory would be the
 * fabrication invariant I-2 forbids.
 */
export async function activeRunDir() {
  try {
    const run = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
    return run?.run_dir ?? null;
  } catch {
    return null;
  }
}

// ── WATCHING A SERVICE THAT ANNOUNCES NOTHING ───────────────────────────────
//
// THE PROBLEM. A contributor's service — the relay's loop-guard counter is the
// founding case — serves monotonic counters over HTTP and knows nothing about
// cells or runs. It pushes no events and never will. So when its count moves,
// there is no record of it anywhere, and a loop-guard fire that ultimately
// VOIDS a whole cell leaves the feed completely silent.
//
// THE ATTRIBUTION IS THE WHOLE POINT. This notice is written by the control
// plane, under `control`, and says what the control plane OBSERVED. It is not
// attributed to the relay, because the relay said nothing — synthesising a row
// in another process's voice about an event that process never reported is
// fabrication however accurate the number is. `detail.stat` names what was
// watched, so a reader can see both who spoke and what about.
//
// WHY HERE AND NOT ON A TIMER. This route already polls every custom source,
// throttled by the board. A dedicated poller would be a SECOND reader of a
// service the bench does not ship, and `events.mjs` states the reason that is
// unwelcome: one predictable consumer, never N. The side effect on a GET is a
// record of what that GET saw, which is self-describing rather than surprising.
//
// A FIRST SIGHTING IS NOT A MOVE. The first reading of a run establishes what
// the counter says; only a CHANGE is an event. Without this every board poll
// after a restart would announce a fire that never happened.
//
// MEMORY IS PER RUN and reset when the run changes, so one campaign's readings
// can never be compared against the next run's, and the map cannot grow across
// runs.
export async function watchExternalCounters(logPath, stats) {
  if (!logPath) return stats;
  if (getCounterWatch().logPath !== logPath) setCounterWatch({ logPath, seen: new Map() });
  const counterWatch = getCounterWatch();

  for (const stat of stats.custom ?? []) {
    // Only real readings. `unavailable` is not a value and must never be
    // differenced against one — that is how a restarted source reads as a
    // clean run.
    if (stat.state !== "ok" || typeof stat.value !== "number") continue;
    const previous = counterWatch.seen.get(stat.id);
    counterWatch.seen.set(stat.id, stat.value);
    if (previous === undefined || previous === stat.value) continue;
    await notice(logPath, "external_counter_moved", {
      level: "warn",
      detail: { stat: stat.id, label: stat.label, from: previous, to: stat.value },
    });
  }
  return stats;
}

/**
 * Stop the running benchmark, if any.
 *
 * Sends SIGINT — NOT SIGTERM — to the harness's process group. The harness
 * (run_cumulative.py) treats SIGINT as a KeyboardInterrupt, which runs its
 * unconditional teardown: the DockerCell context-manager removes the cell, the
 * egress sidecar and the session-db volume, and the process reaper sweeps any
 * remainder. SIGTERM, by contrast, terminates the process WITHOUT that teardown
 * and leaks containers/volumes (the exact residue a later run trips on).
 *
 * Belt-and-suspenders: after the interrupt, a broad docker sweep removes any
 * bench cell / egress sidecar / session-db volume the reaper missed, so a reset
 * always lands on a clean slate even when the run was wedged.
 */
export async function stopRun() {
  // ── WHOSE HARNESS IS IT ─────────────────────────────────────────────────
  //
  // `launcher` is the handle for a run THIS PROCESS spawned, and it is
  // in-memory only. Two ordinary situations leave it null over a live cell:
  //
  //   · the operator launched from the CLI — the documented path in
  //     USER-BENCHMARKING-GUIDE, on which the control plane never held a pid;
  //   · the control plane was restarted mid-run — the harness is `detached`
  //     with its stdio on a file, so it survives us, but its handle does not.
  //
  // The old code skipped the interrupt entirely in both cases and fell through
  // to the docker sweep below. That is strictly worse than the SIGTERM this
  // function's own doc-comment refuses to send: it tears the cell, the egress
  // sidecar and the session-db volume out from under a harness that is still
  // running, so the teardown the SIGINT exists to trigger never happens AND
  // the process is left alive writing into a bench that no longer has one.
  // A stop must find the harness by asking the kernel, not by remembering it.
  // The SAME read answers both questions: which tree this stop is about, and
  // which log the run's notices hang off. Reading it twice would be two answers
  // to "which run is this".
  const stopState = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
  const runDir = stopState.run_dir;
  const logPath = stopState.log_path;
  const targets = [];
  const launcher = getLauncher();
  if (launcher && pidAlive(launcher.pid)) {
    targets.push({ pid: launcher.pid, pgid: launcher.pid, own: true });
  } else {
    const procs = await findHarnessProcs({ runDir });
    // `null` is a FAILED SCAN, not an empty machine. Signalling nothing and
    // sweeping docker anyway is the failure described above, so a stop that
    // cannot see the process list does not get to claim the process is gone —
    // it just has nothing to signal, and says as much in the log.
    if (procs === null) {
      // A FAILED SCAN IS NOT AN EMPTY MACHINE, and this is the one place that
      // distinction was stated to nobody but a terminal nobody reads.
      console.error("[stop] ps scan failed; no harness could be interrupted");
      await notice(logPath, "stop_scan_failed", {
        level: "error",
        detail: { run_dir: runDir ?? null, signalled: 0 },
      });
    } else {
      for (const p of procs.bound.length ? procs.bound : procs.other) {
        targets.push({ pid: p.pid, pgid: p.pgid, own: false });
      }
    }
  }

  for (const t of targets) {
    // THE GROUP ONLY WHEN THE HARNESS LEADS IT. A detached spawn is its own
    // group leader, so `kill(-pgid)` reaches the harness and the Python
    // children it fanned out. A CLI-launched harness sits in the operator's
    // SHELL group, and interrupting that group would interrupt their terminal
    // and every sibling in it. When we do not own the group, signal the one
    // process; the harness installs the KeyboardInterrupt handler itself, so
    // its own teardown still runs.
    const groupIsOurs = t.own || (Number.isInteger(t.pgid) && t.pgid === t.pid);
    try {
      process.kill(groupIsOurs ? -t.pgid : t.pid, "SIGINT");
    } catch {
      try {
        process.kill(t.pid, "SIGINT");
      } catch {
        /* already gone */
      }
    }
  }

  // Wait for every target to actually exit before sweeping docker — the sweep
  // is only safe once the teardown it backstops has had its chance to run.
  for (let i = 0; i < 40 && targets.some((t) => pidAlive(t.pid)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // WHAT THE STOP ACTUALLY DID, recorded before the handle is dropped. A stop
  // that signalled nothing and a stop that signalled three processes are
  // different events, and a stop whose targets are STILL ALIVE after twenty
  // seconds is a third — the docker sweep below then runs against a harness
  // that never died, which is the case most worth being able to look up
  // afterwards. A bare "stop requested" would have said none of it.
  const survivors = targets.filter((t) => pidAlive(t.pid)).length;
  await notice(logPath, "stop_signalled", {
    level: survivors > 0 ? "error" : "info",
    detail: {
      signalled: targets.length,
      own_launcher: targets.some((t) => t.own),
      still_alive: survivors,
    },
  });

  setLauncher(null);

  // ── THE MIRROR DIES WITH THE CELL ────────────────────────────────────────
  //
  // The TUI mirror is an `opencode attach` client the CONTROL PLANE spawns, so
  // nothing in the harness's own teardown owns it. Left alone it survives the
  // stop: the serve it attached to is gone, but the client keeps its pty, keeps
  // repainting its last screen, and keeps animating opencode's own spinner.
  //
  // `/api/tui` then reports `running: true, status: "live"` — because `running`
  // is `Boolean(this.child)`, a fact about the MIRROR, not about the session —
  // and the board draws a live terminal with a moving progress bar over a cell
  // that was stopped minutes ago. That is the board asserting motion in a
  // stopped cell, which is the one thing this surface must never do.
  //
  // Killed here rather than left for the poller to notice, because there is no
  // poller: the mirror only re-evaluates when read, and a closed drawer never
  // reads it.
  try {
    tui.shutdown();
  } catch (err) {
    // Never let mirror teardown block the cell teardown below — but a mirror
    // that refused to die leaves a phantom `opencode attach` child and a board
    // still drawing `live` over a stopped cell, so the failure is stated.
    console.error(`[stop] tui mirror teardown failed (stop proceeds): ${err?.message ?? err}`);
  }

  const run = (args) =>
    new Promise((resolve) => {
      execFile("docker", args, { timeout: 30000 }, (_err, stdout) => resolve(stdout ?? ""));
    });
  const cells = await run(["ps", "-aq", "--filter", "name=bench-cell-"]);
  // Must track harness/egress.py:egress_container_name. A stale prefix here does
  // not fail loudly — it silently leaves the sidecar running after a stop, and
  // the next cell then contends with a live egress container from the last one.
  const sidecars = await run(["ps", "-aq", "--filter", "name=okp-egress-"]);
  const ids = [cells, sidecars]
    .map((out) => String(out).trim())
    .flatMap((s) => (s ? s.split(/\s+/) : []))
    .filter(Boolean);
  if (ids.length) await run(["rm", "-f", ...ids]);
  const vols = await run(["volume", "ls", "-q", "--filter", "name=bench-cell-"]);
  const volIds = String(vols)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (volIds.length) await run(["volume", "rm", "-f", ...volIds]);
}
