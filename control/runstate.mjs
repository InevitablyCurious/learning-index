// RUN STATE — which cells are in flight, and may another be started?
//
// Enumeration has exactly two sources: the durable launch records
// (cell-registry.mjs, cached by run-ledger.mjs) and a live process scan
// (findHarnessProcs) — never launch-log files. A recorded cell counts as
// running only when its pid is a live harness process (the pid-reuse guard);
// a record whose pid is absent from a successful scan is ended durably with a
// reason, so every ended cell is listed, never silently dropped. Liveness is
// the PER-CELL heartbeat of the cell's own live.jsonl.

import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { STALL_THRESHOLD_S } from "./contract.mjs";
import { activeTreeRoot } from "./tree.mjs";
import { statOrNull, listDir } from "./lib/fs.mjs";
import { liveRuns, evictRun } from "./run-ledger.mjs";
import { endRecord, listRecords } from "./cell-registry.mjs";

/**
 * Age in ms of the newest heartbeat in the live stream AT ONE EXACT PATH, or
 * null when there is none. null (never claimed alive) and old (claimed, then
 * stopped) are different facts; only the second is a stall. Reads the tail:
 * the stream grows without bound, and a record cut mid-line is skipped.
 */
export async function heartbeatAgeAtPath(path, now = Date.now()) {
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

/**
 * Age in ms of the newest heartbeat of ONE CELL — the cell's own live.jsonl,
 * resolved from (run_dir, sequence_index) through cellDirForRun. null when the
 * cell's directory cannot be resolved or the cell never beat.
 */
export async function cellHeartbeatAge({ runsRoot, runDir, sequenceIndex, now = Date.now() }) {
  const cell = await cellDirForRun(runsRoot, runDir, sequenceIndex);
  if (!cell) return null;
  return heartbeatAgeAtPath(join(runsRoot, cell.cellDir, "live.jsonl"), now);
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

/** Bench harness entrypoints — the filter that makes a process a harness. */
const HARNESS_SCRIPT = /run_cumulative\.py/;

/**
 * The cell address a harness carries on its command line:
 * { run_dir, sequence_index, arm, model }, each null when absent.
 * run_dir comes from the --manifest path, which campaign.mjs builds as
 * <runsRoot>/<run_dir>/manifest.json — so the run_dir is what sits between
 * the runs root and the manifest name.
 */
export function parseHarnessArgv(cmd) {
  const s = String(cmd ?? "");
  let run_dir = null;
  const manifest = /--manifest\s+(\S+)/.exec(s);
  if (manifest) {
    const m = /\/runs\/(.+)\/manifest\.json$/.exec(manifest[1]);
    if (m) run_dir = m[1];
  }
  const seq = /--sequence-index\s+(\d+)/.exec(s);
  const arm = /--mode\s+(on|off)/.exec(s);
  const model = /--model\s+(\S+)/.exec(s);
  return {
    run_dir,
    sequence_index: seq ? Number(seq[1]) : null,
    arm: arm ? arm[1] : null,
    model: model ? model[1] : null,
  };
}

/**
 * Every bench harness process on this machine, with its process group and
 * the cell address parsed from its argv. One scanner shared by the run-state
 * enumeration and stopRun. A harness this control plane spawned leads its own
 * group and can be signalled as a group; a CLI-launched one sits in the
 * operator's shell group, so callers must check before kill(-pgid).
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
    const addr = parseHarnessArgv(cmd);
    // Bound to this run: the harness carries its manifest path on argv.
    (runDir && cmd.includes(runDir) ? bound : other).push({
      pid,
      pgid,
      cmd,
      run_dir: addr.run_dir,
      sequence_index: addr.sequence_index,
      arm: addr.arm,
      model: addr.model,
    });
  }
  return { bound, other };
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
 * Every cell launch log candidate, newest first. Launch logs live in the live
 * tree (so a reset retires them) and, for pre-tree benches, at the runs root;
 * the tree root is a strict subdirectory of the runs root, so the two bases
 * never yield the same file. Serves the log-diagnostic readers (newestLog);
 * run-state enumeration never reads logs — it comes from the durable records
 * plus the process scan.
 */
async function cellLogCandidates(runsRoot) {
  const candidates = [];

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

  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates;
}

/**
 * The newest live cell launch log. A log whose run directory no longer exists
 * describes a wiped run and is skipped, so a wiped bench never reads as running.
 */
export async function newestLog(runsRoot) {
  for (const cand of await cellLogCandidates(runsRoot)) {
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
 * The cell.start record at the head of the cell's own live.jsonl (never from a
 * launch log that may describe another cell). null when unresolvable. Shared
 * head-anchored read: the harness publishes session_id, serve_host_port, and
 * serve_url on this one record, and the tail-readers miss it on real runs.
 */
async function cellStartRecord(runsRoot, runDir, sequenceIndex) {
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
    return rec;
  }
  return null;
}

/**
 * The session id a cell ran under, from its own cell.start record (never from a
 * launch log that may describe another cell). null when unresolvable.
 */
export async function cellSessionId(runsRoot, runDir, sequenceIndex) {
  const rec = await cellStartRecord(runsRoot, runDir, sequenceIndex);
  return typeof rec?.session_id === "string" ? rec.session_id : null;
}

/**
 * The cell's own serve_url — each concurrent cell gets its own free serve
 * port, published on the cell.start record at the head of its live.jsonl.
 * null when the record or field is absent.
 */
export async function cellServeUrl(runsRoot, runDir, sequenceIndex) {
  const rec = await cellStartRecord(runsRoot, runDir, sequenceIndex);
  return typeof rec?.serve_url === "string" ? rec.serve_url : null;
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
 * Assemble the run state: EVERY live run, newest first, plus EVERY ended cell
 * with its reason.
 *
 * Enumeration has exactly two sources: the durable launch records and one
 * live process scan — never launch-log files. `launchers` is the run ledger's
 * live set (run-ledger.mjs): the cells this control plane spawned. A harness
 * process whose pid matches no record is an external (CLI) launch: still a
 * real run, never reported as idle. A recorded cell is live when its pid is
 * a live harness process — the pid-reuse guard; liveness (live/stalled/
 * unknown) comes from the PER-CELL heartbeat of the cell's own live.jsonl.
 *
 * The return carries `runs[]` (live), `ended[]` (every durable record with
 * finished === true, each carrying its ending) and `live_count`, plus the
 * legacy single-run keys mirrored from the NEWEST live run (the idle shape
 * when none is live) — the only backward-compat surface.
 *
 * Side effect: the REAL ledger is reconciled against the scan — a record
 * whose pid is absent from a SUCCESSFUL scan ended without an observed exit
 * and is ended durably ("exit not observed"), then evicted from the cache.
 * A failed scan is indeterminate and ends nothing. The injected `launchers`
 * param is never reconciled.
 */
export async function readRunState({ runsRoot, launchers = liveRuns(), scan = findHarnessProcs, heartbeatProbe = cellHeartbeatAge }) {
  // ── (i) One process scan for the whole pass ── no runDir filter, so every
  // harness on the machine lands in `other` and one scan serves both the
  // reconcile and the orphan enumeration. null (the scan failed) stays null:
  // inconclusive is not an empty list.
  const scanResult = await scan();
  const harnesses = scanResult ? [...scanResult.bound, ...scanResult.other] : null;
  const harnessByPid = new Map((harnesses ?? []).map((h) => [h.pid, h]));

  // ── (ii) Reconcile the REAL ledger against the scan ── a record whose pid
  // is absent from a successful scan ended without an observed exit (dead, or
  // the pid was reused by a non-harness). Its end is a durable FACT added to
  // its record — never a deletion — and the cache slot is evicted so the
  // model's launch gate clears. Only the real ledger is reconciled
  // (`launchers` may be a test fixture), and only as best effort:
  // bookkeeping never breaks the read for a read-only caller.
  const endedRunIds = new Set();
  try {
    for (const rec of liveRuns()) {
      // The pid-reuse guard: a recorded pid that IS a live harness is live.
      if (rec.pid != null && harnessByPid.has(rec.pid)) continue;
      if (harnesses === null) {
        // The scan failed: the pidAlive(rec.pid) fallback is indeterminate at
        // best — a bare pid check cannot attribute an ending — so the record
        // stays live and is never ended here.
        continue;
      }
      endRecord(runsRoot, rec.run_dir, rec.run_id, {
        at: Date.now(),
        code: null,
        signal: null,
        reason: "exit not observed",
        log_tail: null,
      });
      evictRun(rec.run_id);
      endedRunIds.add(rec.run_id);
    }
  } catch {
    // The snapshot below is already whole; a failed reconcile only delays an
    // unobserved exit to the next poll.
  }

  // ── (iii) Enumerate the LIVE runs ──
  const runs = [];
  const recordedPids = new Set(launchers.map((r) => r.pid).filter((p) => p != null));

  for (const rec of launchers) {
    // Ended by the reconcile this pass: no longer live.
    if (endedRunIds.has(rec.run_id)) continue;
    const liveByScan = rec.pid != null && harnessByPid.has(rec.pid);
    // Scan failed → live-by-default (indeterminate never ends a run); else a
    // fixture record whose pid at least exists stays live. A dead/reused pid
    // from an injected fixture just drops out — only the REAL ledger is
    // reconciled, so nothing is ended here.
    if (!liveByScan && harnesses !== null && !pidAlive(rec.pid)) continue;

    // Liveness comes from one source: the heartbeat the harness writes into
    // the cell's OWN live.jsonl every 15s — per cell, never per run_dir (a
    // run_dir-wide read cannot attribute a beat to one of N concurrent
    // cells). Log mtime and event-feed proxies were tried and were wrong (a
    // phase can run 86 turns between log lines).
    const heartbeatAgeMs = await heartbeatProbe({
      runsRoot,
      runDir: rec.run_dir,
      sequenceIndex: rec.sequence_index,
    });
    const heartbeatAgeS = heartbeatAgeMs === null ? null : Math.round(heartbeatAgeMs / 1000);
    // live: a beat inside the threshold. stalled: beats stopped (60 missed
    // beats). unknown: no heartbeat at all — never called stalled.
    const liveness =
      heartbeatAgeS === null ? "unknown" : heartbeatAgeS >= STALL_THRESHOLD_S ? "stalled" : "live";
    // The process exists (or the scan failed): silence is a stall, not a
    // death, and still blocks.
    const state = liveness === "stalled" ? "stalled" : "running";
    const logStat = rec.log_path ? await statOrNull(rec.log_path) : null;

    runs.push({
      run_id: rec.run_id,
      // WHICH CELL OF THE BATCH. With N concurrent cells of one model and arm,
      // every other field on this record is identical across them — same
      // model, same arm, same run_dir. The sequence index is the only thing
      // that tells an operator (or a selector) which cell they are looking at.
      sequence_index: rec.sequence_index,
      state,
      running: true,
      // Per-run, never a global gate: this run is in flight, so it cannot be
      // started again; whether ANOTHER cell may start is the caller's policy.
      can_start: false,
      blocked_reason: `this cell is ${state} (${rec.run_dir}) — already in flight`,
      run_dir: rec.run_dir,
      log_path: rec.log_path,
      log_name: rec.log_path ? basename(rec.log_path) : null,
      pid: rec.pid,
      model: rec.model,
      arm: rec.arm,
      // The cell's own cell.start record is the authoritative session id
      // (with N cells in flight a launch log can describe another cell).
      session_id: await cellSessionId(runsRoot, rec.run_dir, rec.sequence_index),
      started_at: rec.started_at,
      // Informational only, never liveness.
      log_silent_s:
        logStat?.isFile() ? Math.max(0, Math.round((Date.now() - logStat.mtimeMs) / 1000)) : null,
      liveness,
      heartbeat_age_s: heartbeatAgeS,
      // A live run carries no terminal status.
      terminal_status: null,
      terminal_ok: null,
      // A run this service started (a ledger record).
      launched_by: "control-plane",
    });
  }

  // A harness whose pid matches no record is an external (CLI) launch: still
  // a real run, addressed from its own argv, never reported as idle.
  for (const h of harnesses ?? []) {
    if (recordedPids.has(h.pid)) continue;
    const addressed = h.run_dir && h.sequence_index != null;
    let liveness = "unknown";
    let heartbeatAgeS = null;
    let sessionId = null;
    if (addressed) {
      const ms = await heartbeatProbe({
        runsRoot,
        runDir: h.run_dir,
        sequenceIndex: h.sequence_index,
      });
      heartbeatAgeS = ms === null ? null : Math.round(ms / 1000);
      liveness =
        heartbeatAgeS === null ? "unknown" : heartbeatAgeS >= STALL_THRESHOLD_S ? "stalled" : "live";
      sessionId = await cellSessionId(runsRoot, h.run_dir, h.sequence_index);
    }
    runs.push({
      run_id: null,
      sequence_index: h.sequence_index ?? null,
      state: "running",
      running: true,
      can_start: false,
      blocked_reason: "this cell is running — already in flight",
      run_dir: h.run_dir ?? null,
      log_path: null,
      log_name: null,
      pid: h.pid,
      model: h.model ?? null,
      arm: h.arm ?? null,
      session_id: sessionId,
      started_at: null,
      log_silent_s: null,
      liveness,
      heartbeat_age_s: heartbeatAgeS,
      terminal_status: null,
      terminal_ok: null,
      launched_by: "external",
    });
  }

  // Newest first, nulls last; Array#sort is stable, so equal started_at keeps
  // enumeration order.
  runs.sort((a, b) => {
    if (a.started_at === null && b.started_at === null) return 0;
    if (a.started_at === null) return 1;
    if (b.started_at === null) return -1;
    return b.started_at - a.started_at;
  });

  // ── (iv) EVERY ended cell, with its reason ── the durable records are the
  // source; an ended cell is listed, never silently dropped. Newest ending
  // first (a record ended before this shape existed falls back to started_at).
  const endedAt = (rec) => rec?.ended?.at ?? rec?.started_at ?? 0;
  const ended = listRecords(runsRoot)
    .filter((rec) => rec?.finished === true)
    .sort((a, b) => endedAt(b) - endedAt(a))
    .map((rec) => ({
      run_id: rec.run_id ?? null,
      sequence_index: rec.sequence_index ?? null,
      model: rec.model ?? null,
      arm: rec.arm ?? null,
      run_dir: rec.run_dir ?? null,
      pid: rec.pid ?? null,
      started_at: rec.started_at ?? null,
      log_path: rec.log_path ?? null,
      state: "ended",
      running: false,
      can_start: true,
      blocked_reason: null,
      liveness: "ended",
      heartbeat_age_s: null,
      terminal_status: rec.terminal_status ?? null,
      terminal_ok: rec.terminal_ok ?? null,
      launched_by: "control-plane",
      ended: rec.ended ?? null,
    }));

  // ── (v) The legacy single-run surface mirrors the newest live run (runs is
  // newest-first, so runs[0]); when nothing is live it is the idle shape.
  const newest = runs[0] ?? null;
  return {
    runs,
    ended,
    live_count: runs.length,
    state: newest?.state ?? "idle",
    // Stop, still_running and the tools' refuse-while-running guard all read this.
    running: newest?.running ?? false,
    run_dir: newest?.run_dir ?? null,
    log_path: newest?.log_path ?? null,
    log_name: newest?.log_name ?? null,
    pid: newest?.pid ?? null,
    model: newest?.model ?? null,
    arm: newest?.arm ?? null,
    session_id: newest?.session_id ?? null,
    started_at: newest?.started_at ?? null,
    log_silent_s: newest?.log_silent_s ?? null,
    liveness: newest?.liveness ?? "unknown",
    heartbeat_age_s: newest?.heartbeat_age_s ?? null,
    terminal_status: newest?.terminal_status ?? null,
    terminal_ok: newest?.terminal_ok ?? null,
    can_start: newest?.can_start ?? true,
    blocked_reason: newest?.blocked_reason ?? null,
    launched_by: newest?.launched_by ?? null,
  };
}
