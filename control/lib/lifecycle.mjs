// CONTROL PLANE — RUN LIFECYCLE: the default run folder for run-scoped reads,
// the watch on services that announce nothing, and the stop path. The mutable
// launcher/counterWatch live in ../state.mjs behind accessors (ESM import
// bindings are read-only).

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
 * The run folder a run-scoped read defaults to, resolved from the newest live
 * launch log (readRunState), never from a name pattern. null when there is no
 * cell log: the reader then reports unwired rather than inventing a folder.
 */
export async function activeRunDir() {
  try {
    const run = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
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

/**
 * Stop the running benchmark, if any. SIGINT, not SIGTERM: the harness then
 * runs its own teardown (cell, egress sidecar, session-db volume); SIGTERM skips
 * it and leaks containers. A docker sweep afterwards removes anything the
 * teardown missed.
 */
export async function stopRun() {
  // Find the harness by asking the kernel, not by remembering it: `launcher` is
  // null for a CLI launch or after a control-plane restart, and sweeping docker
  // without interrupting the harness first would tear the cell out from under a
  // live process. One run-state read answers which tree and which log.
  const stopState = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
  const runDir = stopState.run_dir;
  const logPath = stopState.log_path;
  const targets = [];
  const launcher = getLauncher();
  if (launcher && pidAlive(launcher.pid)) {
    targets.push({ pid: launcher.pid, pgid: launcher.pid, own: true });
  } else {
    const procs = await findHarnessProcs({ runDir });
    // A failed scan is not an empty machine: nothing to signal, and it says so.
    if (procs === null) {
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
  await notice(logPath, "stop_signalled", {
    level: survivors > 0 ? "error" : "info",
    detail: {
      signalled: targets.length,
      own_launcher: targets.some((t) => t.own),
      still_alive: survivors,
    },
  });

  setLauncher(null);

  // The TUI mirror is the control plane's own `opencode attach` child, so the
  // harness teardown doesn't own it; left alive it keeps animating a stopped
  // cell's terminal as live. Killed here.
  try {
    tui.shutdown();
  } catch (err) {
    // Never blocks the cell teardown, but a mirror that won't die is reported.
    console.error(`[stop] tui mirror teardown failed (stop proceeds): ${err?.message ?? err}`);
  }

  const run = (args) =>
    new Promise((resolve) => {
      execFile("docker", args, { timeout: 30000 }, (_err, stdout) => resolve(stdout ?? ""));
    });
  const cells = await run(["ps", "-aq", "--filter", "name=bench-cell-"]);
  // Must match harness/egress.py egress_container_name, or a sidecar survives
  // the stop silently.
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
