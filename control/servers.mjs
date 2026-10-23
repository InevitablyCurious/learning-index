// STARTED-SERVER REGISTRY — cleanup by ownership, not by port.
//
// The bench records every server it starts and cleanup stops only what it
// recorded. A port sweep of 8002 killed strangers (whatever held the port) and
// missed any server on another port (play). Ownership is checked per kind,
// because a server is not one shape:
//
//   host process  the record carries the absolute entrypoint it was spawned
//                 with, and is acted on only if the live process's command line
//                 still contains it — otherwise the pid was recycled and the
//                 record is pruned, the process left alone. Killed by signal.
//   play          the candidate runs inside the grader image (play_container),
//                 so the record carries a STRING session identity and the
//                 container name. Owned iff `docker inspect` says it is still
//                 running. Stopped through the module, never signalled.
//
// One file per server under runs/servers/<pid>.json, so writers never race.
// Stale records are normal and pruned by readers.
// Used by play (control/play.mjs).

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PYTHON } from "./state.mjs";

/** The play registry kind — the one that is a container, not a host pid. */
const PLAY_KIND = "play";

const execFileAsync = promisify(execFile);

/**
 * The exec function. Swappable so tests can answer for docker and the play CLI
 * without either being installed; production never replaces it.
 */
let exec = execFileAsync;

/** Replace the exec runner (tests only; `null` restores the real one). */
export function setExecRunner(fn) {
  exec = fn ?? execFileAsync;
}

/** The repo root (this module is control/servers.mjs). */
const BENCH_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The registry folder, resolved from this module's location so the gate
 * harness and the control plane always agree.
 */
export function serversDir(benchRoot = BENCH_ROOT) {
  return path.join(benchRoot, "runs", "servers");
}

function recordPath(pid, benchRoot) {
  // The pid is a filename (and for play it is a session identity carrying
  // slashes), so it is encoded to exactly one path component. Numeric pids
  // encode to themselves, so existing records keep their names.
  return path.join(serversDir(benchRoot), `${encodeURIComponent(String(pid))}.json`);
}

/**
 * Record a started server right after start, before waiting for health, so one
 * that dies during startup is still reapable. Never throws; returns the record
 * path or null.
 *
 * A host process is keyed by its pid. A play server is a container and has no
 * host pid to key on: it is keyed by its session identity string, and carries
 * the container name ownership is checked against.
 */
export function registerServer(rec, benchRoot = BENCH_ROOT) {
  const kind = String(rec?.kind ?? "unknown");
  let pid;
  if (kind === PLAY_KIND) {
    pid = rec?.pid;
    if (typeof pid !== "string" || pid.trim().length === 0) return null;
  } else {
    pid = Number(rec?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
  }
  const entrypoint = String(rec?.entrypoint ?? "");
  if (!entrypoint) return null;

  const row = {
    pid,
    entrypoint,
    container: kind === PLAY_KIND ? String(rec?.container ?? "") || null : null,
    port: Number(rec?.port) || null,
    kind,
    label: rec?.label == null ? null : String(rec.label),
    ready: rec?.ready === true,
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
    fs.rmSync(recordPath(pid, benchRoot), { force: true });
  } catch {
    // Gone or unreadable: nothing to drop.
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
      if (!row) continue;
      // A play record is keyed by its session identity string; everything else
      // by a host pid.
      const keyed =
        row.kind === PLAY_KIND
          ? typeof row.pid === "string" && row.pid.length > 0
          : Number.isInteger(row.pid);
      if (keyed) rows.push(row);
    } catch {
      // A corrupt record is not a server.
    }
  }
  return rows;
}

/** The live command line for `pid`, or null when it isn't running. */
export async function processCommand(pid) {
  try {
    const { stdout } = await exec("ps", ["-p", String(pid), "-o", "command="]);
    const line = String(stdout ?? "").trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

/** Is the named container still running? Unaskable counts as not running. */
async function containerRunning(container) {
  try {
    const { stdout } = await exec("docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      String(container),
    ]);
    return String(stdout ?? "").trim() === "true";
  } catch {
    // No docker, no such container: either way it is not ours to claim.
    return false;
  }
}

/**
 * Classify a record against what is actually running.
 *   dead      not running — prune, kill nothing
 *   recycled  running but not what we recorded — prune, kill nothing
 *   ours      running, and it is the thing we recorded — safe to stop
 *
 * A play record is a container, so the question is asked of docker; every other
 * kind is a host process and is asked of the process table.
 */
export async function classifyServer(rec) {
  if (rec?.kind === PLAY_KIND) {
    // No container named, nothing to ask about: there is no such server.
    const container = String(rec?.container ?? "");
    if (!container) return { state: "dead", command: null };
    if (await containerRunning(container)) return { state: "ours", command: container };
    return { state: "dead", command: null };
  }
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

/**
 * SIGTERM, then SIGKILL, then confirmation. Returns true only when the
 * process table no longer lists the pid: an unconfirmed kill must not
 * deregister, because the record is the only handle a later reap has.
 */
async function killPid(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Unsignalable (already gone, or not ours to signal): believe the table.
    return (await processCommand(pid)) == null;
  }
  for (let i = 0; i < 15; i++) {
    await sleep(100);
    if ((await processCommand(pid)) == null) return true;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone between the check and the signal.
  }
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    if ((await processCommand(pid)) == null) return true;
  }
  return false;
}

/**
 * Stop what a record owns. A play container is torn down through
 * harness/play_container.py (its candidate AND its forwarder AND its network),
 * never by signal; everything else is a host pid and gets the signal ladder.
 * Returns true only when the thing is confirmed gone.
 */
async function stopServer(rec, benchRoot) {
  if (rec?.kind !== PLAY_KIND) return killPid(rec?.pid);

  const argv = ["-m", "harness.play_container", "stop", "--name", String(rec.pid)];
  try {
    const { stdout } = await exec(PYTHON, argv, { cwd: benchRoot, timeout: 120_000 });
    const lines = String(stdout ?? "")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const last = lines[lines.length - 1];
    if (!last) return false;
    return JSON.parse(last)?.ok === true;
  } catch {
    // Unreachable module, unparseable line: the record stays the only handle.
    return false;
  }
}

/**
 * Stop every server this bench started and left behind, and prune the records.
 * `kind` narrows it ("gate", "play"); `only` reaps that one server, `except`
 * spares that one. Returns a report: reaped and pruned are different facts. A
 * record is dropped only once what it owns is confirmed gone; one that survives
 * the stop is left for a later reap.
 */
export async function reapServers(opts = {}, benchRoot = BENCH_ROOT) {
  const wanted = opts.kind == null ? null : String(opts.kind);
  const report = { killed: [], pruned: [], left: [] };

  for (const rec of listServers(benchRoot)) {
    if (wanted != null && rec.kind !== wanted) {
      report.left.push(rec);
      continue;
    }
    if (opts.except != null && rec.pid === opts.except) {
      report.left.push(rec);
      continue;
    }
    if (opts.only != null && rec.pid !== opts.only) {
      report.left.push(rec);
      continue;
    }
    const { state } = await classifyServer(rec);
    if (state === "ours") {
      if (await stopServer(rec, benchRoot)) {
        deregisterServer(rec.pid, benchRoot);
        report.killed.push(rec);
      } else {
        // It survived its stop: the record is the only handle on it, so it
        // stays on disk and a later stop can re-reap it.
        report.left.push(rec);
      }
    } else {
      // Dead or recycled: the record is worthless and any live process isn't ours.
      deregisterServer(rec.pid, benchRoot);
      report.pruned.push({ ...rec, state });
    }
  }
  return report;
}

/**
 * Who is listening on `port` now, [{pid, command}] from the OS. Empty when
 * nothing holds it or lsof is unavailable.
 *
 * Not used by play: a candidate binds its port inside its own container, so it
 * cannot hold a host port. Kept for host-side port questions.
 */
export async function portHolders(port) {
  let stdout = "";
  try {
    ({ stdout } = await exec("lsof", [
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

