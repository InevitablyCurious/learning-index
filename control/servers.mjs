// SPAWNED-SERVER REGISTRY — cleanup by ownership, not by port.
//
// The bench records every game server it starts and cleanup kills only what it
// recorded. A port sweep of 8002 killed strangers (whatever held the port) and
// missed any server on another port (play). Each record carries the absolute
// entrypoint it was spawned with, and is acted on only if the live process's
// command line still contains it — otherwise the pid was recycled and the record
// is pruned, the process left alone.
//
// One file per process under runs/servers/<pid>.json, so writers never race.
// Stale records are normal and pruned by readers.
// Used by play (control/play.mjs).

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  return path.join(serversDir(benchRoot), `${pid}.json`);
}

/**
 * Record a spawned server right after spawn, before waiting for health, so one
 * that dies during startup is still reapable. Never throws; returns the record
 * path or null.
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
      if (row && Number.isInteger(row.pid)) rows.push(row);
    } catch {
      // A corrupt record is not a server.
    }
  }
  return rows;
}

/** The live command line for `pid`, or null when it isn't running. */
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
 * Classify a record against the live process table:
 *   dead      not running — prune, kill nothing
 *   recycled  running but not what we recorded — prune, kill nothing
 *   ours      running, command line names our entrypoint — safe to kill
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
 * Kill every server this bench started and left behind, and prune the
 * records. `kind` narrows it ("gate", "play"). Returns a report: reaped and
 * pruned are different facts.
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

