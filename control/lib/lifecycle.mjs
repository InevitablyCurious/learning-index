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
import { getRun, recordCellEnded } from "../run-ledger.mjs";
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
 * Which harness processes a stop signals — each EXACTLY ONCE.
 *
 * With N concurrent cells of one campaign every harness carries the same
 * manifest path, so a run_dir-scoped scan finds all N. Stopping cell by cell
 * signalled each harness N times, and a second SIGINT can interrupt the
 * teardown the first one started. So the plan is made once, over every live
 * run: a ledger pid that is alive is used as is; otherwise one scan per run
 * dir. A harness that names no run dir is signalled only when it is the sole
 * live run (the conservative rule readRunState counts it alive by).
 * Dependencies are injectable for tests.
 */
export async function planStop(runs, {
  ledger = getRun,
  alive = pidAlive,
  scan = findHarnessProcs,
} = {}) {
  const targets = new Map();
  const scanned = new Set();
  let scanFailed = false;
  for (const r of runs) {
    const pid = (r.run_id ? ledger(r.run_id)?.pid : null) ?? r.pid ?? null;
    if (pid !== null && alive(pid)) {
      // A control-plane spawn is detached: the harness leads its own group.
      targets.set(pid, { pid, pgid: pid, own: true });
      continue;
    }
    const key = r.run_dir ?? "";
    if (scanned.has(key)) continue;
    scanned.add(key);
    const procs = await scan({ runDir: r.run_dir });
    if (procs === null) { scanFailed = true; continue; }
    for (const p of procs.bound) if (!targets.has(p.pid)) targets.set(p.pid, { pid: p.pid, pgid: p.pgid, own: false });
    if (!r.run_dir && runs.length === 1) {
      for (const p of procs.other) if (!targets.has(p.pid)) targets.set(p.pid, { pid: p.pid, pgid: p.pgid, own: false });
    }
  }
  return { targets: [...targets.values()], scanFailed };
}

/**
 * Stop EVERY live run — a single cell or a whole concurrent batch. SIGINT,
 * not SIGTERM: each harness then runs its own teardown (cell, egress sidecar,
 * session-db volume); SIGTERM skips it and leaks containers. A docker sweep
 * afterwards removes anything a teardown missed — scoped to each run's own
 * log-derived names, never to a bare prefix: an unanchored `name=bench-cell-`
 * sweep force-removes other runs' live cells (the historical flake class
 * harness/process_reaper.py documents). No live run is a quiet no-op (the
 * reset path calls this unconditionally). Returns what it did.
 */
export async function stopAll() {
  const state = await readRunState({ runsRoot: RUNS_ROOT });
  const runs = state.runs ?? [];
  if (!runs.length) return { runs: 0, signalled: 0, still_alive: 0 };

  const { targets, scanFailed } = await planStop(runs);
  if (scanFailed) console.error("[stop] ps scan failed for at least one run; those harnesses were not interrupted");

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
  for (let i = 0; i < 60 && targets.some((t) => pidAlive(t.pid)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const survivors = targets.filter((t) => pidAlive(t.pid)).length;

  // The TUI mirror is the control plane's own `opencode attach` child, so no
  // harness teardown owns it; left alive it keeps animating a stopped cell's
  // terminal as live.
  try {
    tui.shutdown();
  } catch (err) {
    console.error(`[stop] tui mirror teardown failed (stop proceeds): ${err?.message ?? err}`);
  }

  for (const r of runs) {
    // Record what the stop did, on each run's own log.
    await notice(r.log_path, scanFailed && !targets.length ? "stop_scan_failed" : "stop_signalled", {
      level: survivors > 0 || scanFailed ? "error" : "info",
      detail: { run_id: r.run_id ?? null, runs: runs.length, signalled: targets.length, still_alive: survivors },
    });
    // Record the stop on the run's durable launch record — a stopped cell is
    // ended with a reason, never erased. A survivor stays visible through
    // readRunState's run_dir-scoped process scan.
    if (r.run_id) recordCellEnded(r.run_id, r.run_dir, { reason: "stopped by operator", code: null, signal: "SIGINT", log_tail: null });
    await sweepDocker(r.log_path);
  }
  return { runs: runs.length, signalled: targets.length, still_alive: survivors };
}

/** Remove what a teardown missed, scoped to ONE run's own log-derived names. */
async function sweepDocker(log_path) {
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
