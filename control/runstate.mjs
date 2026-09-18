// RUN STATE — is a cell in flight, and may another be started?
//
// The control plane's only mutable fact is the launcher it spawned; everything
// else is read from the run's own files. A run counts as running only when the
// process exists (signal 0, not a pid file) AND the harness is heartbeating.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { STALL_THRESHOLD_S } from "./contract.mjs";
import { activeTreeRoot } from "./tree.mjs";
// The one live-stream path resolver (LIVE-STREAM.md); never build the path by hand.
import { liveStreamPath } from "./board/sources/_runtime.mjs";
import { statOrNull, listDir } from "./lib/fs.mjs";

/**
 * Age in ms of the newest heartbeat in this run's live stream, or null when
 * there is none. null (never claimed alive) and old (claimed, then stopped) are
 * different facts; only the second is a stall. Reads the tail: the stream grows
 * without bound, and a record cut mid-line is skipped.
 */
export async function heartbeatAge({ runsRoot, runDir, now = Date.now() }) {
  if (!runDir) return null;
  let path;
  try {
    path = await liveStreamPath(join(runsRoot, runDir));
  } catch {
    return null;
  }
  if (!path) return null;

  let newest = null;
  for (const line of (await readTail(path)).split("\n")) {
    // Cheap reject before the parse: most lines in a busy stream are gates and
    // backend telemetry, and parsing all of them on every poll is wasted work.
    if (!line.includes('"heartbeat"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.kind !== "heartbeat") continue;
    const ts = Number(rec.ts);
    // Newest by timestamp, not position.
    if (Number.isFinite(ts) && (newest === null || ts > newest)) newest = ts;
  }
  // A clock skew that puts the beat in the future is not negative age.
  return newest === null ? null : Math.max(0, now - newest);
}

/** True iff a process with this pid currently exists. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but is owned by another user — still alive.
    return err?.code === "EPERM";
  }
}

const execFileAsync = promisify(execFile);

/** Bench harness entrypoints, for the conservative fallback in externalRunAlive. */
const HARNESS_SCRIPT = /run_cumulative\.py/;

/**
 * Every bench harness process on this machine, with its process group. One
 * scanner shared by the liveness probe and stopRun. A harness this control plane
 * spawned leads its own group and can be signalled as a group; a CLI-launched one
 * sits in the operator's shell group, so callers must check before kill(-pgid).
 * null when the scan itself failed — inconclusive is not an empty list.
 */
export async function findHarnessProcs({ runDir } = {}) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("ps", ["-axww", "-o", "pid=,pgid=,command="], {
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch {
    return null;
  }

  const bound = [];
  const other = [];
  for (const line of String(stdout).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    const pgid = Number(m[2]);
    const cmd = m[3];
    // Only a harness process counts: tail, grep or an editor mentioning the run
    // directory is a bystander, not a live cell.
    if (!HARNESS_SCRIPT.test(cmd)) continue;
    // Bound to this run: the harness carries its manifest path on argv.
    (runDir && cmd.includes(runDir) ? bound : other).push({ pid, pgid, cmd });
  }
  return { bound, other };
}

async function externalRunAlive({ runDir }) {
  const procs = await findHarnessProcs({ runDir });
  // The scan failed; the caller falls back to the heartbeat.
  if (procs === null) return null;
  // Conservative: any bench harness still means a cell is in flight (the
  // campaign is serial). A reset blocked one cycle too long costs a wait; one
  // allowed too early costs the measurement.
  return procs.bound.length > 0 || procs.other.length > 0;
}

/**
 * The run directory a cell log writes into, read from the log's own PROGRESS
 * paths. null when the log has not named one yet (early, not orphaned). The run
 * dir is a path (<tree>/<substrate>/<router>/<provider>/<model>), not a name.
 */
export function runDirOf(text) {
  const s = String(text ?? "");
  // 1. Anchored on the cell container, the one segment the harness names.
  //    [^\s]: a log line can carry two /runs/ paths (seeding), and the capture
  //    must not cross from one into the other.
  const anchored = /\/runs\/([^\s]+?)\/(?:sessions|memoryON|memoryOFF|memoryUNKNOWN)\//.exec(s);
  if (anchored) return anchored[1];

  // 2. Tree-shaped: a fixed five segments under the tree.
  const tree = /\/runs\/(\d{9,11}\/[^/]+\/[^/]+\/[^/]+\/[^/]+)\//.exec(s);
  if (tree) return tree[1];

  // 3. Legacy flat layout: one segment under the runs root.
  const flat = /\/runs\/([A-Za-z0-9._-]+)\//.exec(s);
  return flat ? flat[1] : null;
}

/**
 * The newest live cell launch log. A log whose run directory no longer exists
 * describes a wiped run and is skipped, so a wiped bench never reads as running.
 */
export async function newestLog(runsRoot) {
  const candidates = [];

  // Launch logs live in the live tree (so a reset retires them) and, for
  // pre-tree benches, at the runs root.
  let treeRoot = null;
  try {
    treeRoot = await activeTreeRoot(runsRoot);
  } catch {
    treeRoot = null;
  }

  for (const base of treeRoot ? [treeRoot, runsRoot] : [runsRoot]) {
    for (const ent of await listDir(base)) {
      if (!ent.isFile() || !ent.name.endsWith(".log")) continue;
      if (!/^(off|on)-cell-|^cell-/.test(ent.name)) continue;
      const p = join(base, ent.name);
      const st = await statOrNull(p);
      if (st?.isFile()) {
        candidates.push({ path: p, mtime: st.mtimeMs, size: st.size, name: ent.name });
      }
    }
  }

  // Newest first, then take the first whose run directory still exists.
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const cand of candidates) {
    // 256KB: a long log's first artifact path can sit well back from the end.
    const runDir = runDirOf(await readTail(cand.path, 256 * 1024));
    // Not named yet: a run that just started. Live by default.
    if (runDir === null) return cand;
    const st = await statOrNull(join(runsRoot, runDir));
    if (st?.isDirectory()) return { ...cand, run_dir: runDir };
  }
  return null;
}

/** The launch log of a past run, found by its run_dir (same scan as newestLog). */
export async function logPathForRunDir(runsRoot, runDir) {
  if (!runDir) return null;
  let treeRoot = null;
  try { treeRoot = await activeTreeRoot(runsRoot); } catch { treeRoot = null; }
  const bases = treeRoot ? [treeRoot, runsRoot] : [runsRoot];
  for (const base of bases) {
    for (const ent of await listDir(base)) {
      if (!ent.isFile() || !ent.name.endsWith(".log")) continue;
      if (!/^(off|on)-cell-|^cell-/.test(ent.name)) continue;
      const p = join(base, ent.name);
      const st = await statOrNull(p);
      if (!st?.isFile()) continue;
      if (runDirOf(await readTail(p)) === runDir) return p;
    }
  }
  return null;
}

/** Bounded tail read: a multi-hour log costs the same as a fresh one. */
export async function readTail(path, bytes = 64 * 1024) {
  const st = await statOrNull(path);
  if (!st?.isFile()) return "";
  const fh = await fs.open(path, "r").catch(() => null);
  if (!fh) return "";
  try {
    const start = Math.max(0, st.size - bytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Bounded head read. A cell's live.jsonl opens with its cell.start record. */
async function readHead(path, bytes = 64 * 1024) {
  const st = await statOrNull(path);
  if (!st?.isFile()) return "";
  const fh = await fs.open(path, "r").catch(() => null);
  if (!fh) return "";
  try {
    const len = Math.min(st.size, bytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * A cell's directory from (run_dir, sequence_index), relative to the runs root.
 * sequence_index is campaign-global, so exactly one arm directory holds the
 * cell. null when absent.
 */
export async function cellDirForRun(runsRoot, runDir, sequenceIndex) {
  if (!runDir || sequenceIndex == null) return null;
  const cellName = "cell-" + String(sequenceIndex).padStart(4, "0");
  for (const arm of await listDir(join(runsRoot, runDir))) {
    if (!arm.isDirectory() || !/^memory/i.test(arm.name)) continue;
    for (const cell of await listDir(join(runsRoot, runDir, arm.name))) {
      if (!cell.isDirectory() || cell.name !== cellName) continue;
      return { cellDir: join(runDir, arm.name, cell.name), arm: arm.name, cellName };
    }
  }
  return null;
}

/**
 * The session id a cell ran under, from its own cell.start record (never from a
 * launch log that may describe another cell). null when unresolvable.
 */
export async function cellSessionId(runsRoot, runDir, sequenceIndex) {
  const cell = await cellDirForRun(runsRoot, runDir, sequenceIndex);
  if (!cell) return null;
  const head = await readHead(join(runsRoot, cell.cellDir, "live.jsonl"));
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.kind !== "cell.start") continue;
    return typeof rec.session_id === "string" ? rec.session_id : null;
  }
  return null;
}

/**
 * Did the process we just spawned survive startup? A harness can die seconds
 * after spawn (usage error, import error, drift guard); this polls liveness for a
 * bounded window and returns the log tail so the refusal carries the traceback.
 * A later crash surfaces through readRunState as `failed`.
 */
export async function confirmAlive(
  pid,
  { logPath = null, windowMs = 20000, pollMs = 250, isAlive = pidAlive, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), readTailImpl = readTail } = {},
) {
  const started = Date.now();
  const deadline = started + windowMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return { ok: false, elapsed_ms: Date.now() - started, log_tail: await readTailImpl(logPath) };
    }
    await sleep(pollMs);
  }
  return { ok: true, elapsed_ms: Date.now() - started, log_tail: null };
}

/** The live session id, as the harness printed it in its launch log. */
export function sessionIdFrom(text) {
  const m = /\bsession[_-]?id[=:]\s*(ses_[A-Za-z0-9]+)/i.exec(text ?? "");
  if (m) return m[1];
  const a = /--session\s+(ses_[A-Za-z0-9]+)/.exec(text ?? "");
  return a ? a[1] : null;
}

// The harness's terminal statuses (sequencer.py): `done` and `halted_on_gate`.
// Pinned against Python by a drift test. `state` says the run ended; `ok` says
// it ended well. An unrecognised status is ok:null (ended, unvouched), never
// false.
export const TERMINAL_STATUS = {
  done: { state: "complete", ok: true },
  halted_on_gate: { state: "complete", ok: false },
};

/** Classify a terminal status object. Unknown statuses end, but do not vouch. */
export function classifyTerminal(terminal) {
  if (!terminal || typeof terminal.status !== "string") return null;
  return TERMINAL_STATUS[terminal.status] ?? { state: "complete", ok: null };
}

/** The terminal status object the runner writes as its last log line. */
export function terminalFrom(text) {
  for (const raw of String(text ?? "").split("\n").slice(-8)) {
    const t = raw.trim();
    if (!t.startsWith("{") || !t.endsWith("}")) continue;
    try {
      const o = JSON.parse(t);
      if (typeof o?.status === "string") return o;
    } catch {
      /* not a status object */
    }
  }
  return null;
}

/**
 * Assemble the run state. `launcher` is the process this control plane spawned,
 * or null for a CLI launch (still a real run, never reported as idle).
 */
export async function readRunState({ runsRoot, launcher, aliveProbe = externalRunAlive, heartbeatProbe = heartbeatAge }) {
  const log = await newestLog(runsRoot);

  if (!log) {
    return {
      state: "idle",
      // `running` is published on both return paths.
      running: false,
      run_dir: null,
      log_path: null,
      log_name: null,
      pid: null,
      model: null,
      arm: null,
      session_id: null,
      started_at: null,
      log_silent_s: null,
      liveness: "unknown",
      heartbeat_age_s: null,
      terminal_status: null,
      can_start: true,
      blocked_reason: null,
      launched_by: null,
    };
  }

  const text = await readTail(log.path);
  const terminal = terminalFrom(text);
  const silent = Math.max(0, Math.round((Date.now() - log.mtime) / 1000));

  // Process check on both launch paths; null only when the scan itself failed.
  const alive = launcher
    ? pidAlive(launcher.pid)
    : await aliveProbe({ runDir: log.run_dir });
  const arm = /^on-cell-/.test(log.name) ? "on" : /^off-cell-/.test(log.name) ? "off" : null;

  // Liveness comes from one source: the heartbeat the harness writes into the
  // cell's live.jsonl every 15s. Log mtime and event-feed proxies were tried and
  // were wrong (a phase can run 86 turns between log lines).
  const heartbeatAgeMs = await heartbeatProbe({ runsRoot, runDir: log.run_dir });
  const heartbeatAgeS = heartbeatAgeMs === null ? null : Math.round(heartbeatAgeMs / 1000);
  // live: a beat inside the threshold. stalled: beats stopped (60 missed beats).
  // unknown: no heartbeat at all — never called stalled.
  const liveness =
    heartbeatAgeS === null ? "unknown" : heartbeatAgeS >= STALL_THRESHOLD_S ? "stalled" : "live";

  let state;
  const terminalClass = classifyTerminal(terminal);
  if (terminalClass) {
    state = terminalClass.state;
  } else if (alive === false) {
    // No terminal record and no process: abandoned, never measured. Reported at
    // once rather than after the stall threshold, so reset is not blocked by a corpse.
    state = "failed";
  } else if (alive === true) {
    // The process exists: silence is a stall, not a death, and still blocks.
    state = liveness === "stalled" ? "stalled" : "running";
  } else {
    // ps failed: a beating cell is alive; only a stopped heartbeat reads as failed.
    state = liveness === "stalled" ? "failed" : "running";
  }

  const running = state === "running" || state === "starting" || state === "stalled";

  return {
    state,
    // Stop, still_running and the tools' refuse-while-running guard all read this.
    running,
    // The run directory, from the log's own text (see newestLog).
    run_dir: log.run_dir ?? null,
    log_path: log.path,
    log_name: log.name,
    pid: launcher?.pid ?? null,
    model: launcher?.model ?? null,
    arm: launcher?.arm ?? arm,
    session_id: sessionIdFrom(text),
    started_at: launcher?.started_at ?? null,
    log_silent_s: silent,
    // Liveness and its age. log_silent_s is informational only, never liveness.
    liveness,
    heartbeat_age_s: heartbeatAgeS,
    terminal_status: terminal?.status ?? null,
    // Whether the ending was good: true clean, false adverse, null unvouched.
    terminal_ok: terminalClass ? terminalClass.ok : null,
    can_start: !running,
    blocked_reason: running
      ? `a cell is ${state} (${log.name}) — the campaign is strictly serial, ` +
        "one cell at a time (RUNBOOK: OFF-concurrency = 1)"
      : null,
    // A run this service started vs one launched at the CLI (which it cannot own).
    launched_by: launcher ? "control-plane" : "external",
  };
}
