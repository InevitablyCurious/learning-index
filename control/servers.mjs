// ─────────────────────────────────────────────────────────────────────────────
// SPAWNED-SERVER REGISTRY — ownership-based cleanup for game servers.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// Until now the PORT was the registry. Every game server the bench started
// bound 8002, so "sweep 8002" was provably complete cleanup: there was nowhere
// else a bench server could be. `freePort()` in the gate harness did exactly
// that — `lsof` the port, SIGKILL every pid it found.
//
// That has two defects, and the second only became reachable when the board
// gained a "view result" button:
//
//   1. IT KILLS STRANGERS. A port carries no ownership. Whatever holds 8002 —
//      the operator's editor, an unrelated dev server — is killed without a
//      word. Killing an unknown process to get a port is salvaging by a worse
//      method, which the no-silent-fallback rule forbids outright.
//
//   2. IT STOPS BEING COMPLETE THE MOMENT A SECOND SERVER EXISTS. Playing a
//      built artifact means a second server, and two servers cannot share a
//      one-port confinement. Whichever port the second one takes, a sweep of
//      8002 cannot see it. The invariant does not survive the feature.
//
// So the port stops being the registry and this becomes it: the bench writes
// down what it started, and cleanup kills what it wrote down. That is complete
// across every port AND non-destructive, which no port sweep can be.
//
// ── OWNERSHIP, NOT LIVENESS ─────────────────────────────────────────────────
//
// A pid alone proves nothing: pids recycle, and a record naming pid 4321 may
// find a live process that is somebody else's. Every record therefore carries
// the absolute ENTRYPOINT path it was spawned with, and a record is only acted
// on when the live process's command line still contains that path. A live pid
// that fails the match is a RECYCLED pid: the record is pruned and the process
// is left alone. Liveness is not identity — the same rule the bench already
// applies to MCP identity at its own seams.
//
// ── WHERE IT LIVES ──────────────────────────────────────────────────────────
//
// One file per process under `runs/servers/<pid>.json`, not one shared file.
// Two spawners (the gate harness and the control plane) write concurrently and
// a shared file would need a lock; a file per pid cannot race with itself.
// Stale records are expected and are never an error — a hard-killed process
// does not get to clean up after itself, and pruning is the reader's job.
//
// Node builtins only: this is imported by the gate harness, which runs
// standalone with its own package.json and must not gain a dependency on it.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** `bench/` — this module lives at `control/servers.mjs`. */
const BENCH_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The registry directory. Resolved from THIS module's own location so the gate
 * harness and the control plane cannot disagree about where it is — the two
 * import the same file from different trees and a caller-supplied root would be
 * two chances to point at two directories.
 */
export function serversDir(benchRoot = BENCH_ROOT) {
  return path.join(benchRoot, "runs", "servers");
}

function recordPath(pid, benchRoot) {
  return path.join(serversDir(benchRoot), `${pid}.json`);
}

/**
 * Record a spawned server. Called with the pid in hand, immediately after
 * spawn and BEFORE the caller waits for health — a server that dies during
 * startup still has to be reapable, and a record written only on success would
 * miss exactly the processes most likely to be left behind.
 *
 * Never throws: a registry that cannot be written must not take a run down
 * with it. It returns the record path, or null when the write failed.
 */
export function registerServer(rec, benchRoot = BENCH_ROOT) {
  const pid = Number(rec?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const entrypoint = String(rec?.entrypoint ?? "");
  if (!entrypoint) return null;

  const row = {
    pid,
    entrypoint,
    port: Number(rec?.port) || null,
    kind: String(rec?.kind ?? "unknown"),
    label: rec?.label == null ? null : String(rec.label),
    cwd: rec?.cwd == null ? null : String(rec.cwd),
    started_at: new Date().toISOString(),
  };

  try {
    fs.mkdirSync(serversDir(benchRoot), { recursive: true });
    fs.writeFileSync(recordPath(pid, benchRoot), JSON.stringify(row, null, 2));
    return recordPath(pid, benchRoot);
  } catch {
    return null;
  }
}

/** Drop a record. Never throws — an already-absent record is the goal state. */
export function deregisterServer(pid, benchRoot = BENCH_ROOT) {
  try {
    fs.rmSync(recordPath(Number(pid), benchRoot), { force: true });
  } catch {
    // The record is gone or unreadable; either way there is nothing to drop.
  }
}

/** Every record on disk. An unreadable or malformed file is skipped, not fatal. */
export function listServers(benchRoot = BENCH_ROOT) {
  let names;
  try {
    names = fs.readdirSync(serversDir(benchRoot));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const row = JSON.parse(
        fs.readFileSync(path.join(serversDir(benchRoot), name), "utf-8"),
      );
      if (row && Number.isInteger(row.pid)) rows.push(row);
    } catch {
      // A half-written or corrupt record is not a server; skip it.
    }
  }
  return rows;
}

/**
 * The live command line for `pid`, or null when the pid is not running.
 *
 * `ps -p <pid> -o command=` is the portable-enough answer on darwin and Linux.
 * A non-zero exit means no such process, which is the same answer as "dead".
 */
export async function processCommand(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    const line = String(stdout ?? "").trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

/**
 * Classify one record against the live process table.
 *
 *   dead      the pid is not running — prune the record, kill nothing
 *   recycled  the pid is running but is NOT the process we recorded — prune
 *             the record, kill nothing. This is the case that makes the
 *             registry safe to act on.
 *   ours      the pid is running and its command line still names the
 *             entrypoint we spawned — safe to kill
 */
export async function classifyServer(rec) {
  const command = await processCommand(rec?.pid);
  if (command == null) return { state: "dead", command: null };
  if (rec?.entrypoint && command.includes(rec.entrypoint)) {
    return { state: "ours", command };
  }
  return { state: "recycled", command };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killPid(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 15; i++) {
    await sleep(100);
    if ((await processCommand(pid)) == null) return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone between the check and the signal.
  }
}

/**
 * Kill every server this bench started and left behind, and prune the records.
 *
 * `kind` narrows it (`"gate"`, `"play"`); omitted, it reaps everything. Returns
 * a report rather than a count, because "reaped 3" and "pruned 3 recycled pids"
 * are different facts and a caller that cannot tell them apart cannot explain
 * itself to the operator.
 */
export async function reapServers(opts = {}, benchRoot = BENCH_ROOT) {
  const wanted = opts.kind == null ? null : String(opts.kind);
  const report = { killed: [], pruned: [], left: [] };

  for (const rec of listServers(benchRoot)) {
    if (wanted != null && rec.kind !== wanted) {
      report.left.push(rec);
      continue;
    }
    const { state } = await classifyServer(rec);
    if (state === "ours") {
      await killPid(rec.pid);
      deregisterServer(rec.pid, benchRoot);
      report.killed.push(rec);
    } else {
      // dead OR recycled — the record is worthless either way and the live
      // process, if any, belongs to somebody else.
      deregisterServer(rec.pid, benchRoot);
      report.pruned.push({ ...rec, state });
    }
  }
  return report;
}

/**
 * Who is listening on `port` right now — `[{pid, command}]`, newest answer from
 * the OS rather than from the registry. Empty when nothing holds it, and empty
 * when `lsof` is unavailable (absence of evidence is reported as absence, and
 * the caller's next act is to try the bind and let it fail honestly).
 */
export async function portHolders(port) {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("lsof", [
      "-nP",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-t",
    ]));
  } catch {
    return [];
  }
  const pids = String(stdout)
    .split(/\s+/)
    .map((raw) => Number(raw.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);

  const holders = [];
  for (const pid of [...new Set(pids)]) {
    holders.push({ pid, command: (await processCommand(pid)) ?? "<unknown>" });
  }
  return holders;
}

/**
 * Reap our own servers, then REFUSE if the port is still held.
 *
 * This replaces the old `freePort()` kill. The difference is the whole point of
 * this module: a process the bench started is cleaned up, and a process it did
 * not start is reported by pid and command line and left running. The operator
 * decides what happens to their own processes — the bench does not get to guess
 * that whatever holds a port is disposable.
 */
export async function reapAndRequirePort(port, opts = {}, benchRoot = BENCH_ROOT) {
  await reapServers(opts, benchRoot);

  const holders = await portHolders(port);
  if (holders.length === 0) return;

  const who = holders.map((h) => `pid ${h.pid} (${h.command})`).join(", ");
  throw new Error(
    `port ${port} is held by a process the bench did not start: ${who}. ` +
      "Stop it and re-run. The bench cleans up servers it started (runs/servers/) " +
      "and will not kill a process it does not own.",
  );
}
