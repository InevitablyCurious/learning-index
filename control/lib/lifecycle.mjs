// CONTROL PLANE — RUN LIFECYCLE: the default run folder for run-scoped reads,
// the watch on services that announce nothing, and the stop path. Stop is
// PER RUN: the run ledger (../run-ledger.mjs) holds every launch this control
// plane spawned, and a stop always targets ONE identified run — by run id, or
// the single live run when exactly one is live and no id was given. The
// mutable counterWatch lives in ../state.mjs behind accessors (ESM import
// bindings are read-only).

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";

import { readRunState, readTail, pidAlive, findHarnessProcs } from "../runstate.mjs";
import { notice } from "../notices.mjs";
import { getRun, unregisterRun } from "../run-ledger.mjs";
import {
  RUNS_ROOT,
  tui,
  getCounterWatch,
  setCounterWatch,
} from "../state.mjs";

/**
 * The run folder a run-scoped read defaults to, resolved from the newest live
 * launch log (readRunState's top-level mirror), never from a name pattern.
 * null when there is no live cell log: the reader then reports unwired rather
 * than inventing a folder.
 */
export async function activeRunDir() {
  try {
    const run = await readRunState({ runsRoot: RUNS_ROOT });
    return run?.run_dir ?? null;
  } catch {
    return null;
  }
}

// Notices for a service that announces nothing (e.g. an external counter): when
// its reading changes, the control plane writes a notice under its own name,
// `control`, saying what it observed (detail.stat names it) — never in the
// service's voice. Done while polling the custom sources anyway (one reader, no
// extra timer). The first reading of a run is a baseline, not an event; memory
// resets per run.
export async function watchExternalCounters(logPath, stats) {
  if (!logPath) return stats;
  if (getCounterWatch().logPath !== logPath) setCounterWatch({ logPath, seen: new Map() });
  const counterWatch = getCounterWatch();

  for (const stat of stats.custom ?? []) {
    // Only real readings; `unavailable` is never differenced.
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

/** Bounded head read: a run's docker names are logged at startup and per cell. */
async function readHeadBytes(path, bytes) {
  const fh = await fs.open(path, "r").catch(() => null);
  if (!fh) return "";
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.toString("utf8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * The docker names THIS run created, read from its own launch log — never
 * re-derived. Cell containers are `bench-cell-<label>-<run_identity>`, where
 * run_identity is a 12-hex token the harness generates once per run-instance
 * and shares across all of that run's cells; the egress sidecar is
 * `okp-egress-<hash>` of the per-cell run label (harness/egress.py). Both are
 * logged BEFORE the container exists — the runner's isolation PROGRESS lines
 * carry `container=bench-cell-…`, docker_worker's sidecar start carries
 * `name=okp-egress-…` — so a name absent from the log was never created:
 * there is then nothing safe to match, and an unscoped sweep must never guess
 * (the policy harness/process_reaper.py exists by). The head read covers the
 * first cell (the identity is run-wide); the tail covers the current cell
 * (each cell's teardown removes its own sidecar, so only the current one
 * should exist at stop).
 */
async function dockerNamesForRun(logPath) {
  if (!logPath) return { identity: null, sidecars: [] };
  const head = await readHeadBytes(logPath, 256 * 1024);
  const tail = await readTail(logPath, 2 * 1024 * 1024);
  const text = `${head}\n${tail}`;
  let identity = null;
  for (const m of text.matchAll(/\bcontainer=bench-cell-\S+-([0-9a-f]{12})\b/g)) {
    identity = m[1];
    break;
  }
  const sidecars = new Set();
  for (const m of text.matchAll(/\bname=okp-egress-[0-9a-f]{12}\b/g)) {
    sidecars.add(m[0].slice("name=".length));
  }
  return { identity, sidecars: [...sidecars] };
}

/**
 * Stop ONE run. SIGINT, not SIGTERM: the harness then runs its own teardown
 * (cell, egress sidecar, session-db volume); SIGTERM skips it and leaks
 * containers. A docker sweep afterwards removes anything the teardown missed —
 * scoped to THIS run's own log-derived names, never to a bare prefix: an
 * unanchored `name=bench-cell-` sweep force-removes sibling runs' live cells
 * (the historical flake class harness/process_reaper.py documents).
 *
 * The run is identified, never guessed:
 *   stopRun({ runId }) — that ledger run; an unknown id throws.
 *   stopRun()          — the single live run (ledger or external CLI launch);
 *                        THROWS when more than one is live rather than
 *                        silently picking one. No live run is a quiet no-op
 *                        (the reset path calls this unconditionally).
 */
export async function stopRun({ runId = null } = {}) {
  // ── Resolve the one run to stop ─────────────────────────────────────────
  let target;
  if (runId !== null && runId !== undefined) {
    const rec = getRun(runId);
    if (!rec) {
      throw new Error(
        `stopRun: run id '${runId}' is not in the ledger — unknown, or already stopped and unregistered`,
      );
    }
    // A named id never implies singularity: siblings may be live.
    target = { run_id: rec.run_id, pid: rec.pid, run_dir: rec.run_dir, log_path: rec.log_path, sole: false };
  } else {
    // No id: the run state sees EVERY live run — ledger launches and external
    // CLI launches alike (the ledger alone is blind to CLI runs and empty
    // after a control-plane restart). More than one live is a refusal, not a
    // choice: picking one could kill the wrong measurement.
    const state = await readRunState({ runsRoot: RUNS_ROOT });
    if (state.live_count > 1) {
      const live = state.runs.map((r) => r.run_id ?? r.log_name).join(", ");
      throw new Error(
        `stopRun: ${state.live_count} runs are live and no run id was given — refusing to pick one (${live}); pass { runId }`,
      );
    }
    const only = state.runs[0] ?? null;
    // Nothing live, nothing to stop — and with no target run there is nothing
    // a sweep could be scoped to. Not an error: reset calls stop before
    // wiping whether or not a run is in flight.
    if (!only) return;
    target = { run_id: only.run_id, pid: only.pid, run_dir: only.run_dir, log_path: only.log_path, sole: true };
  }
  const { run_id, pid, run_dir, log_path, sole } = target;

  // ── Find THIS run's harness: the ledger pid when alive, else a scan scoped
  // to its run dir. Asking the kernel, not remembering, covers CLI launches
  // and control-plane restarts; the run_dir scope keeps one run's stop from
  // signalling another's harness with N cells in flight.
  const targets = [];
  if (pid !== null && pidAlive(pid)) {
    // A control-plane spawn is detached: the harness leads its own group.
    targets.push({ pid, pgid: pid, own: true });
  } else {
    const procs = await findHarnessProcs({ runDir: run_dir });
    // A failed scan is not an empty machine: nothing to signal, and it says so.
    if (procs === null) {
      console.error("[stop] ps scan failed; no harness could be interrupted");
      await notice(log_path, "stop_scan_failed", {
        level: "error",
        detail: { run_id: run_id ?? null, run_dir: run_dir ?? null, signalled: 0 },
      });
    } else if (procs.bound.length) {
      for (const p of procs.bound) targets.push({ pid: p.pid, pgid: p.pgid, own: false });
    } else if (!run_dir && sole && procs.other.length) {
      // The run has not named its directory yet AND singularity was verified
      // at resolution: any harness is the one live run's — the same
      // conservative rule by which readRunState counted it alive. With a
      // run_dir known, or a named run id (siblings possible), `other` is
      // NEVER signalled: an unattributable process is left alone, not guessed.
      for (const p of procs.other) targets.push({ pid: p.pid, pgid: p.pgid, own: false });
    }
  }

  for (const t of targets) {
    // Signal the group only when the harness leads it (a detached spawn). A
    // CLI-launched harness sits in the operator's shell group, so signal just the
    // process; its own handler still tears down.
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

  // Wait for every target to exit before the docker sweep.
  for (let i = 0; i < 40 && targets.some((t) => pidAlive(t.pid)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Record what the stop did: how many were signalled, and whether any survived.
  const survivors = targets.filter((t) => pidAlive(t.pid)).length;
  await notice(log_path, "stop_signalled", {
    level: survivors > 0 ? "error" : "info",
    detail: {
      run_id: run_id ?? null,
      signalled: targets.length,
      own_pid: targets.some((t) => t.own),
      still_alive: survivors,
    },
  });

  // Drop the ledger slot (the launcher singleton this replaces is gone): a
  // survivor is still visible afterwards — readRunState falls back to the
  // run_dir-scoped process scan, so "still alive" never hides behind the drop.
  if (run_id) unregisterRun(run_id);

  // The TUI mirror is the control plane's own `opencode attach` child, so the
  // harness teardown doesn't own it; left alive it keeps animating a stopped
  // cell's terminal as live. Killed here; the board's next poll restarts it
  // against whatever run is live then.
  try {
    tui.shutdown();
  } catch (err) {
    // Never blocks the cell teardown, but a mirror that won't die is reported.
    console.error(`[stop] tui mirror teardown failed (stop proceeds): ${err?.message ?? err}`);
  }

  // ── Docker sweep, scoped to THIS run's own names ────────────────────────
  const { identity, sidecars } = await dockerNamesForRun(log_path);
  const docker = (argv) =>
    new Promise((resolve) => {
      execFile("docker", argv, { timeout: 30000 }, (_err, stdout) => resolve(stdout ?? ""));
    });
  const listed = async (argv) =>
    String(await docker(argv))
      .trim()
      .split(/\s+/)
      .filter(Boolean);

  if (identity) {
    // The reaper's own anchored idiom (process_reaper.py): the run-wide
    // identity suffix can only match THIS run-instance's cells, never a
    // sibling run's.
    const cells = await listed(["ps", "-aq", "--filter", `name=-${identity}$`]);
    if (cells.length) await docker(["rm", "-f", ...cells]);
    // The session-db volume is `<container>-session-db`
    // (harness/adapters/docker_worker.py); the identity substring scopes it
    // to this run under both substring and regex filter semantics.
    const vols = await listed(["volume", "ls", "-q", "--filter", `name=-${identity}-session-db`]);
    if (vols.length) await docker(["volume", "rm", "-f", ...vols]);
  }
  for (const name of sidecars) {
    // The exact name the harness logged when it started the sidecar — a hash
    // of THIS run's own cell label, so it cannot collide with a sibling's.
    const ids = await listed(["ps", "-aq", "--filter", `name=${name}`]);
    if (ids.length) await docker(["rm", "-f", ...ids]);
  }
  if (!identity && !sidecars.length) {
    // Names are logged before containers exist, so nothing derivable means
    // nothing was created — or the log is unreadable. Either way an unscoped
    // sweep must never guess; say so instead of sweeping silently.
    console.warn(
      "[stop] no docker names derivable from this run's log; swept nothing (an unscoped sweep must never guess)",
    );
  }
}
