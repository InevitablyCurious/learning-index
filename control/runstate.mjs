// ─────────────────────────────────────────────────────────────────────────────
// RUN STATE — is a cell in flight, and may another be started?
//
// The control plane owns exactly one mutable fact: the launcher process it
// spawned. Everything else about a run is READ from the same artifacts the
// dashboard reads, so the two surfaces can never disagree about whether
// something is running.
//
// LIVENESS IS DERIVED FROM THE FILESYSTEM, NOT FROM A PARSED TIMESTAMP.
// See contract.mjs STALL_THRESHOLD_S for the measured defect this avoids
// (a constant phantom 7.1h silence caused by naive local timestamps read in a
// UTC container).
//
// PROCESS LIVENESS IS CHECKED WITH SIGNAL 0, NOT BY TRUSTING A PID FILE.
// A pid recorded at launch says nothing about whether the process still exists;
// `kill(pid, 0)` asks the kernel. A stale pid that happens to be reused by an
// unrelated process is the reason `state` ALSO requires a fresh log write —
// two independent signals, both of which must agree before a run is reported
// as running.
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { STALL_THRESHOLD_S } from "./contract.mjs";
// The live tree. Launch logs are written inside it so that retiring a tree
// retires its debris in the same act — see newestLog below.
import { activeTreeRoot } from "./tree.mjs";
// THE ONE LIVE-STREAM PATH RESOLVER. LIVE-STREAM.md names this function by
// name and requires every reader to resolve through it rather than build the
// path — both dashboard readers once constructed a campaign-level path that
// never exists and reported "no live.jsonl yet" for the entire life of every
// run. Importing the designated resolver is the contract; a second copy here
// would be that defect waiting to happen again. It imports only node builtins.
import { liveStreamPath } from "../dashboard/sources/_runtime.mjs";

async function statOrNull(path) {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

async function listDir(path) {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * AGE OF THE NEWEST HEARTBEAT in this run's live stream, in ms — or `null`
 * when the stream holds none.
 *
 * `null` and "old" are different facts and the caller must keep them apart:
 * no heartbeat means the harness never claimed to be alive (a pre-heartbeat
 * harness, or a stream it could not write), while an old one means it claimed
 * and then stopped. Only the second is a stall.
 *
 * Reads the TAIL, not the file: `live.jsonl` is append-only and carries every
 * gate result and backend `ext` record for the cell, so it grows without
 * bound. 64KB reaches far past the 15s beat cadence. A first line sliced
 * mid-record fails to parse and is skipped, which is why the scan tolerates
 * junk rather than trusting the split.
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
    // NEWEST BY TIMESTAMP, not by position. The stream is append-only so the
    // two agree today; keying on the value means they cannot disagree later.
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
const HARNESS_SCRIPT = /run_cumulative\.py|run_backgammon\.py/;

/**
 * IS THE CLI-LAUNCHED RUN ACTUALLY ALIVE? Ask the kernel, never the mtime.
 *
 * The control plane records a pid only for runs IT spawned. Launching from the
 * CLI is the documented path (USER-BENCHMARKING-GUIDE), and on that path
 * `launcher` is null — so `alive` was hardcoded `false` and the state reduced
 * to ONE signal, log recency, in direct contradiction of the two-signal
 * contract stated at the top of this file. That failed in BOTH directions:
 *
 *   - A killed run kept reading `running` for the full STALL_THRESHOLD_S,
 *     so reset/restore refused for 15 minutes over a process that was gone.
 *   - Worse, a LIVE run that merely went quiet past the threshold read
 *     `failed`, so `can_start` flipped true and reset was OFFERED while a real
 *     cell was mid-flight — the exact loss treeResetGate exists to prevent.
 *     Quiet-but-alive is not hypothetical here: unbounded nudging means a
 *     wedged relay never self-terminates (RUNBOOK §3), provider backoff waits
 *     up to 120s, and a single tool call has been observed running 10 minutes.
 *
 * Returns `true` / `false`, or `null` when the scan itself failed — an
 * inconclusive answer is NOT death, and the caller falls back to log recency
 * rather than inventing a verdict from a failed `ps`.
 *
 * The final `anyHarness` clause is deliberately conservative: a bench harness
 * running that this function cannot bind to THIS run still means a cell is
 * somewhere in flight, and the campaign is serial. Blocking a reset one cycle
 * too long costs a wait; allowing one costs the measurement.
 */
/**
 * EVERY BENCH HARNESS PROCESS ON THIS MACHINE, with the process group each one
 * leads or belongs to. ONE SCANNER, two callers: the liveness probe below and
 * `stopRun` in server.mjs. They were two separate reads of `ps` for one
 * release and that is exactly how a stop comes to disagree with the state that
 * authorised it.
 *
 * `pgid` is carried because it decides how a stop may signal. A harness this
 * control plane spawned is `detached: true`, so it LEADS its group
 * (`pgid === pid`) and the whole group can be interrupted together — which is
 * what reaches the harness's Python children. A CLI-launched harness sits in
 * the OPERATOR'S shell group, where `kill(-pgid)` would interrupt the shell
 * and its siblings. The caller must check, and does.
 *
 * Returns `null` when the scan itself failed — an inconclusive answer is not
 * an empty list, and the callers treat the two differently.
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
    // ONLY A HARNESS PROCESS COUNTS. An earlier draft accepted ANY process
    // whose argv merely mentioned the run directory, which made an operator's
    // `tail -f`, a grep, an editor — or the shell of an agent inspecting the
    // tree — read as a live cell, and the refusal would then name a run that
    // is not running. The log NAME is not matched for the same reason and one
    // more: the harness never carries it on argv (the log is a shell
    // redirect), so matching it could only ever find a bystander.
    if (!HARNESS_SCRIPT.test(cmd)) continue;
    // Bound to THIS run: the harness carries its manifest path on argv, and
    // that path contains the run directory.
    (runDir && cmd.includes(runDir) ? bound : other).push({ pid, pgid, cmd });
  }
  return { bound, other };
}

async function externalRunAlive({ runDir }) {
  const procs = await findHarnessProcs({ runDir });
  // The scan failed. Inconclusive is NOT death — the caller falls back to log
  // recency rather than inventing a verdict from an answer we do not have.
  if (procs === null) return null;
  // A harness bound to THIS run is the direct answer. Otherwise the final
  // clause is deliberately conservative: a bench harness running that this
  // function cannot bind to this run still means a cell is somewhere in
  // flight, and the campaign is serial. Blocking a reset one cycle too long
  // costs a wait; allowing one costs the measurement.
  return procs.bound.length > 0 || procs.other.length > 0;
}

/**
 * The run directory a cell log writes into, read from the log's own text.
 *
 * The harness prints absolute artifact paths on its PROGRESS lines
 * (`step=worktree-git-init path=<runsRoot>/<run_dir>/memoryOFF/...`), so the log
 * states which run it belongs to. Returns null when the log has not yet named
 * one — a just-created log is not an orphan, it is early.
 *
 * ── THE RUN DIR IS A PATH, NOT A NAME ───────────────────────────────────────
 *
 * It was one segment while campaigns were flat under `runs/`. Under the tree a
 * campaign home is `<tree>/<substrate>/<router>/<provider>/<model>`, and a regex
 * that stops at the first slash captures the TREE ID — which is a directory that
 * exists for every retired tree, so a dead log would resolve as live and the
 * wipe boundary below would never trip. The capture therefore runs up to the
 * cell container, which is the one segment whose name is fixed by the harness.
 */
export function runDirOf(text) {
  const s = String(text ?? "");
  // 1. ANCHORED ON THE CELL CONTAINER — the precise answer. The harness prints
  //    `<run_dir>/memoryOFF/cell-NNNN/worktree`, and the container is the one
  //    segment whose name the harness fixes, so this resolves the campaign home
  //    exactly however deep it sits.
  //
  // ── THE CAPTURE MUST NOT CROSS WHITESPACE (measured defect, 2026-09-05) ──
  //
  // This was `(.+?)`, and `.` matches a space. A run directory is a path and
  // can never contain one, so the class was always wrong — it simply had
  // nothing to bite on until a log line carried TWO `/runs/` paths.
  //
  // Seeding produced the first one:
  //
  //   src=…/runs/snapshots/<id>/tree dst=…/runs/<tree>/local/…/memoryOFF/…
  //
  // Starting at the FIRST `/runs/`, the lazy `.+?` grew across the space and
  // the `dst=` to reach `/memoryOFF/`, capturing
  // `snapshots/<id>/tree dst=/Users/…/<model>` as the run directory. No such
  // directory exists, so `newestLog` rejected the candidate and returned null —
  // and the control plane reported `state:"idle"` with a live harness running,
  // which the board drew as "SOMETHING FAILED · the process probe no longer
  // sees the harness" over a cell that was grading normally.
  //
  // `[^\s]` confines the capture to one path, so the match fails on the
  // snapshot path and advances to the run path that actually has the container
  // under it. The other two branches were already whitespace-free by
  // construction.
  const anchored = /\/runs\/([^\s]+?)\/(?:sessions|memoryON|memoryOFF|memoryUNKNOWN)\//.exec(s);
  if (anchored) return anchored[1];

  // 2. TREE-SHAPED — a path inside the tree that never reaches a container.
  //    `<tree>/<substrate>/<router>/<provider>/<model>` is a fixed five, so the
  //    campaign home is recoverable by shape alone.
  const tree = /\/runs\/(\d{9,11}\/[^/]+\/[^/]+\/[^/]+\/[^/]+)\//.exec(s);
  if (tree) return tree[1];

  // 3. LEGACY FLAT — one segment under the runs root. Kept EXACTLY as it was:
  //    every pre-tree log resolves the way it always did, and the orphan check
  //    that depends on it keeps working rather than degrading to "early, so
  //    live" — which would quietly re-open the wiped-bench-reports-a-run defect
  //    this function exists to close.
  const flat = /\/runs\/([A-Za-z0-9._-]+)\//.exec(s);
  return flat ? flat[1] : null;
}

/**
 * The newest LIVE cell launch log under the runs root.
 *
 * ORPHAN LOGS ARE SKIPPED. Cell logs are written to the runs ROOT while the run
 * state they describe lives in `runs/<run_dir>/`. Archiving or wiping a run
 * (`mv runs/cumulative runs/cumulative.<why>-<date>`, RUNBOOK §2) moves the run
 * directory and leaves the log behind, so the log outlives its own data.
 *
 * Measured 2026-08-13: after a wipe, `runs/off-cell-20260813T051334.log`
 * remained at the root. Every reader here resolved it as the live run, so
 * `/api/wall` served `suite.total:null` (the run dir was gone) alongside
 * `grading.active:true phase:frontend stalled:true` parsed out of that dead log
 * — a wiped bench reporting a run in progress. The gate wall could not return
 * to its ARMED state because the phantom never cleared.
 *
 * A log whose run directory no longer exists therefore describes a run that no
 * longer exists, and is not a candidate. This is the wipe boundary enforced at
 * the reader: no cleanup step has to be remembered for the board to read clean.
 */
export async function newestLog(runsRoot) {
  const candidates = [];

  // ── WHERE LAUNCH LOGS LIVE ────────────────────────────────────────────────
  //
  // Inside the LIVE TREE, and at the runs root for benches that predate it. The
  // tree placement is what finally makes the wipe boundary automatic: a reset
  // retires the tree the log sits in, so the log stops being scanned at all
  // rather than being scanned and then rejected. The root is still read so a
  // pre-tree log is not orphaned by this change alone.
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
    const runDir = runDirOf(await readTail(cand.path));
    // Not yet named: a fresh log that has not printed an artifact path. Live by
    // default — refusing it would blind the board to a run that just started.
    if (runDir === null) return cand;
    const st = await statOrNull(join(runsRoot, runDir));
    if (st?.isDirectory()) return { ...cand, run_dir: runDir };
  }
  return null;
}

/**
 * The launch-log path for a PAST run, resolved from its run_dir.
 *
 * Mirrors `newestLog`'s scan (same bases, same name filter, same tail-read
 * resolution) but MATCHES by run_dir instead of returning the newest candidate
 * — the backend-feed fix: a board viewing a finished run needs THAT run's log,
 * not whatever is live now. `null` when runDir is falsy or no log names it.
 */
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

/**
 * Read the tail of a file, bounded. A multi-hour log must cost the same as a
 * fresh one — the same rule the dashboard sources follow.
 */
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

/**
 * Read the HEAD of a file, bounded — the mirror of `readTail`. A cell's
 * `live.jsonl` opens with its `cell.start` record (harness/live_stream.py), so
 * resolving a session id reads the first bytes, never the whole append-only
 * stream. "" on any error, same contract as `readTail`.
 */
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
 * Resolve a CELL's directory from (run_dir, sequence_index).
 *
 * `sequence_index` is campaign-global, so `cell-<seq:04d>` exists under exactly
 * ONE arm directory (`memoryON` / `memoryOFF` / `memoryUNKNOWN`) per campaign —
 * the scan reports whichever arm actually holds it rather than being told.
 *
 * Returns `{ cellDir, arm, cellName }` where `cellDir` is the RUNS-ROOT-RELATIVE
 * path (`<run_dir>/<arm>/<cell>`), matching how `run_dir` itself is carried
 * everywhere else in this file — callers join it onto their own runsRoot.
 * `null` when runDir/sequenceIndex are absent or no arm holds the cell.
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
 * The session id a cell was driven under — the join key for agent events and
 * backend-feed pinning. Read from the cell's own `cell.start` record (the
 * first line of its `live.jsonl`, written before any work), never from a
 * launch log that may describe a different cell.
 *
 * `null` when the cell directory does not resolve, the stream is unreadable,
 * or no `cell.start` record carries a string `session_id`.
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
 * STARTUP LIVENESS CONFIRMATION — did the process we just spawned survive?
 *
 * `spawn` returns a valid pid the instant the child exists, but the harness
 * can die seconds later — a usage error, an import error, or the chunk-plan
 * drift guard (WO-49: ~11s after spawn, once preflight finishes). Returning
 * `ok:true` over a process that is already dead is a lie the operator cannot
 * see: the dashboard keys its run pulse on PROGRESS lines, so a crash-only log
 * renders as "no run observed". This polls signal-0 liveness for a bounded
 * window and, if the child dies inside it, hands back the log tail so the
 * refusal can carry the traceback verbatim.
 *
 * BOUNDED, NOT EXHAUSTIVE. A crash AFTER the window still surfaces through
 * `readRunState`'s two-signal `failed` state on the next poll. This window only
 * makes the START response honest about the startup-crash class.
 *
 * `isAlive` / `sleep` / `readTailImpl` are injectable so the deadline math is
 * testable without spawning a real harness or binding a port.
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

/**
 * Extract the live session id from a launch log. The harness writes it itself
 * (backgammon.py emits `attach_cmd=` and `session_id=` lines), so this reads
 * what the runner already published rather than inventing a second channel.
 */
export function sessionIdFrom(text) {
  const m = /\bsession[_-]?id[=:]\s*(ses_[A-Za-z0-9]+)/i.exec(text ?? "");
  if (m) return m[1];
  const a = /--session\s+(ses_[A-Za-z0-9]+)/.exec(text ?? "");
  return a ? a[1] : null;
}

// ── THE TERMINAL VOCABULARY — mirrored from Python, pinned by a drift test ───
//
// The harness prints its terminal object as the last log line
// (`scripts/run_cumulative.py::_print_json(sequencer.step_until_done())`), and
// the ONLY statuses Python can emit are the sequencer's two TypedDict literals:
// `done` (harness/cumulative/sequencer.py:38) and `halted_on_gate` (:43).
//
// This table used to read `status === "ok" || status === "awaiting_extract"`.
// NEITHER STRING IS EMITTED BY ANY PYTHON FILE IN THE REPO. So every cleanly
// finished cell fell through to `failed` and the board rendered
// `CELL ENDED — NO RESULT · done` over a completion that was entirely clean.
// A pure JS↔Python vocabulary drift with nothing pinning the two sides
// together; `control.test.mjs` now pins them.
//
// TWO FACTS, NOT ONE. `state` says whether the run ENDED; `ok` says whether it
// ended WELL. Splitting them is what lets `halted_on_gate` be reported as the
// real conclusion it is — a walk gate stopped the campaign and the descriptor
// carries the gate, verdict and evidence — without filing it beside a corpse.
// A run that left NO terminal record at all is a different thing again and is
// still `failed`, decided below by the liveness probe rather than here.
//
// AN UNRECOGNISED STATUS IS `ok: null`, NEVER `false`. A record was written, so
// the run ended; we simply cannot vouch for how. Mapping the unknown to
// `failed` is precisely the bug this table replaces, and it would recur for
// every status Python adds. The board draws `null` as unvouched, and the drift
// test fails in CI — which is where a vocabulary disagreement belongs.
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
 * Assemble the run state.
 *
 * `launcher` is the control plane's own record of the process it spawned
 * (null if it did not spawn one — e.g. the operator launched from the CLI,
 * which is still the documented path and must not be misreported as idle).
 */
export async function readRunState({ runsRoot, launcher, aliveProbe = externalRunAlive, heartbeatProbe = heartbeatAge }) {
  const log = await newestLog(runsRoot);

  if (!log) {
    return {
      state: "idle",
      // Both return paths publish `running` or the field is worse than absent:
      // present on one branch and undefined on the other is a shape that reads
      // correctly right up until the branch that matters.
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

  // TWO INDEPENDENT SIGNALS. A run is only "running" when the process exists
  // AND the log is being written. Either alone is not enough: a pid can be
  // stale/reused, and a log can stop being written by a process that is wedged
  // but alive (the known unbounded-nudge failure mode).
  // `true` / `false` from a real process check on BOTH launch paths; `null`
  // only when the scan itself failed (see externalRunAlive).
  const alive = launcher
    ? pidAlive(launcher.pid)
    : await aliveProbe({ runDir: log.run_dir });
  const arm = /^on-cell-/.test(log.name) ? "on" : /^off-cell-/.test(log.name) ? "off" : null;

  // ── IS THIS CELL ALIVE — ONE SOURCE, PUBLISHED BY THE HARNESS ───────────
  //
  // The harness heartbeats into its cell's `live.jsonl` every 15s for as long
  // as the cell runs (harness/live_stream.py, LIVE-STREAM.md). That record is the
  // ONLY liveness signal this function consults.
  //
  // WHAT THIS REPLACED, AND WHY IT KEPT BREAKING. Liveness used to be inferred
  // from the harness LOG'S MTIME — but the harness writes PROGRESS at phase
  // BOUNDARIES, and one build phase has been observed running 86 model turns
  // between two of them. So the header printed `CELL STALLED — SILENT 21:49`
  // over a cell that was mid-turn with its own event ticker scrolling beside
  // it. The first repair added the serve event feed as a second signal and
  // took the minimum; that narrowed the window without closing it, because a
  // feed that disconnects, or simply produces no MAPPED event for a while,
  // falls back to the very log-mtime signal already known to be wrong.
  //
  // Both were PROXIES. Four surfaces had each invented their own, and every one
  // of them answers a different question from the one being asked. The fix is
  // not a better proxy: it is the harness — the only component that knows
  // whether it is mid-drive, mid-grade or stuck — stating the fact, and every
  // reader consuming that one statement.
  //
  // THE PATH IS RESOLVED, NEVER CONSTRUCTED, and `liveStreamPath` is the one
  // resolver the contract designates. Both dashboard readers once built the
  // campaign-level path by hand and reported "no live.jsonl yet" for the whole
  // life of every run; a second copy of that logic here is how that returns.
  const heartbeatAgeMs = await heartbeatProbe({ runsRoot, runDir: log.run_dir });
  const heartbeatAgeS = heartbeatAgeMs === null ? null : Math.round(heartbeatAgeMs / 1000);
  //   · "live"    — a beat inside the threshold.
  //   · "stalled" — beats stopped. 15s cadence vs a 900s threshold is 60
  //                 missed beats; a slow disk cannot reach it.
  //   · "unknown" — NO heartbeat in the stream at all: a cell from a harness
  //                 that predates this record, or one whose stream could not
  //                 be written. It has not reported anything, and asserting a
  //                 wedge from silence is the whole defect above. Absence is
  //                 its own state, exactly as `unavailable` is on the stats
  //                 surface — so an unknown cell is never called stalled.
  const liveness =
    heartbeatAgeS === null ? "unknown" : heartbeatAgeS >= STALL_THRESHOLD_S ? "stalled" : "live";

  let state;
  const terminalClass = classifyTerminal(terminal);
  if (terminalClass) {
    state = terminalClass.state;
  } else if (alive === false) {
    // No terminal record and NO PROCESS. This is an ABANDONED run — reported
    // distinctly from `complete`, because a cell that died without writing a
    // terminal status was never measured. Log recency is irrelevant here: a
    // run killed one second ago is just as dead as one killed an hour ago, and
    // waiting out STALL_THRESHOLD_S to admit it blocks reset over a corpse.
    state = "failed";
  } else if (alive === true) {
    // The process exists. Silence past the threshold is a STALL, not a death —
    // and a stalled run still blocks, because something is still holding the
    // tree. This is the half the OR got wrong in the other direction.
    state = liveness === "stalled" ? "stalled" : "running";
  } else {
    // Inconclusive: `ps` failed. The heartbeat still answers whether WORK is
    // happening, and a cell that is beating is not dead whatever `ps` could
    // not tell us. Only a stopped heartbeat plus an unanswerable process scan
    // is reported as failure.
    state = liveness === "stalled" ? "failed" : "running";
  }

  const running = state === "running" || state === "starting" || state === "stalled";

  return {
    state,
    // ── THE BOOLEAN FOUR CALLERS ALREADY ASSUMED WAS HERE ──────────────────
    //
    // It was computed on the line above and then never published, so every
    // `state.running` in server.mjs read `undefined`. Silent, and falsy in the
    // dangerous direction in all four places:
    //
    //   · /api/run/stop/preview  refused every stop — "there is no cell in
    //     flight to stop", said about a live cell. STOP has never worked.
    //   · /api/run/stop          same refusal on the commit leg.
    //   · still_running          reported false unconditionally, so a stop that
    //     left a process alive would still report "cell stopped".
    //   · the refuse_while_running guard on tools NEVER FIRED, so
    //     worker-image-rebuild and bench-mcp-restart could rebuild the
    //     substrate underneath a cell that was being measured on it.
    //
    // Published here rather than fixed at each call site: four copies of the
    // same predicate is how they drift, and `state` (a five-value string) is
    // the thing readers keep getting wrong.
    running,
    // THE RUN DIRECTORY THIS CELL WRITES INTO, propagated from the log's own
    // text (`newestLog` already resolves it, and rejects the log outright when
    // the directory is gone). It was published as a hardcoded null, so every
    // reader that asked the control plane "which run is this?" was told
    // "none" — and the surfaces that key off a run directory silently fell
    // back to the legacy default. That default stopped being correct when
    // campaigns became per-model (`campaign.mjs:campaignDirName`), at which
    // point the gate wall began reading `runs/cumulative`, a directory that no
    // longer exists, and served a fully enumerated suite with zero outcomes.
    run_dir: log.run_dir ?? null,
    log_path: log.path,
    log_name: log.name,
    pid: launcher?.pid ?? null,
    model: launcher?.model ?? null,
    arm: launcher?.arm ?? arm,
    session_id: sessionIdFrom(text),
    started_at: launcher?.started_at ?? null,
    log_silent_s: silent,
    // THE LIVENESS FACT AND ITS AGE, so a reader never has to guess which
    // signal produced the verdict. `log_silent_s` stays published because the
    // age of the log is a real fact worth seeing — but it is NO LONGER a
    // liveness signal, and nothing may treat it as one again.
    liveness,
    heartbeat_age_s: heartbeatAgeS,
    terminal_status: terminal?.status ?? null,
    // WHETHER THE ENDING WAS A GOOD ONE, stated here rather than derived from
    // the status string board-side. The board had its own copy of the
    // vocabulary (`chrome.js`: `t === "ok" || t === "complete"`) — a second
    // mirror of a Python literal, drifted in the same way and for the same
    // reason. `true` clean · `false` ended adversely · `null` ended, unvouched.
    terminal_ok: terminalClass ? terminalClass.ok : null,
    can_start: !running,
    blocked_reason: running
      ? `a cell is ${state} (${log.name}) — the campaign is strictly serial, ` +
        "one cell at a time (RUNBOOK: OFF-concurrency = 1)"
      : null,
    // Distinguishes a run this service started from one launched at the CLI.
    // Both are real; conflating them would let the UI claim ownership of a run
    // it cannot actually stop.
    launched_by: launcher ? "control-plane" : "external",
  };
}
