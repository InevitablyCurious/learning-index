// HARNESS EVENTS — grading progress from the harness's own PROGRESS lines in
// the run log. While grading runs the agent is idle and its feed quiet; this
// tells grading apart from a wedge. Only gate.status (the grading indicator) is
// used by the event feed now; the rows live in the backend feed. Read-only.

import { join } from "node:path";

import { GATE_STALL_THRESHOLD_S } from "./contract.mjs";
import { cellDirForRun, newestLog, readTail } from "./runstate.mjs";
import { activeTreeRoot } from "./tree.mjs";
import { listDir, statOrNull } from "./lib/fs.mjs";

/** Parse `k=v` pairs out of a PROGRESS line. */
function parseKV(line) {
  const out = {};
  const re = /(\w+)=([^\s]+)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[2];
  return out;
}

/**
 * Grading events from run-log text, in order, as BoardEvent rows. Every
 * PROGRESS line is logged twice, so the line minus its timestamp is the dedupe key.
 */
export function parseGateEvents(text) {
  const rows = [];
  const seen = new Set();

  for (const raw of String(text ?? "").split("\n")) {
    if (!raw.includes("step=gate-")) continue;
    const kv = parseKV(raw);
    const step = kv.step;
    if (!step || !step.startsWith("gate-")) continue;

    // Excluding the timestamp collapses the duplicate pair.
    const idx = raw.indexOf("PROGRESS");
    const key = idx >= 0 ? raw.slice(idx).trim() : raw.trim();
    if (seen.has(key)) continue;
    seen.add(key);

    // The dedupe key is also the row's id, so a row rebuilt every poll is admitted
    // once (EventRing.admit).
    const row = rowFor(step, kv);
    if (row) row.id = `harness:${key}`;
    rows.push(row);
  }
  return rows.filter(Boolean);
}

function rowFor(step, kv) {
  const base = {
    id: null,
    kind: "harness",
    type: `harness:${step}`,
    at: null,
    session_id: null,
    tool: null,
    file: null,
    name: null,
    detail: null,
    text: null,
    truncated: false,
    phase: kv.phase ?? null,
  };

  switch (step) {
    case "gate-attempt-start":
      base.name = "grading";
      base.detail = `attempt ${kv.attempt ?? "?"} — grading started`;
      return base;

    case "gate-phase-start":
      base.name = `gate:${kv.phase ?? "?"}`;
      base.detail = `${kv.phase ?? "?"} running`;
      return base;

    case "gate-phase-end": {
      // A failing gate phase is a normal outcome, never an error.
      base.name = `gate:${kv.phase ?? "?"}`;
      const problems = kv.problems && kv.problems !== "unknown" ? ` · ${kv.problems} problems` : "";
      base.detail = `${kv.phase ?? "?"} ${kv.status ?? "done"}${problems}`;
      return base;
    }

    case "gate-timeout":
      // The one real error here: the gate was killed and the attempt never graded.
      base.kind = "error";
      base.name = "gate timeout";
      base.detail = `gate killed after ${kv.wall_s ?? "?"}s (limit ${kv.limit_s ?? "?"}s) — attempt not graded`;
      base.text = base.detail;
      return base;

    default:
      return null;
  }
}

/**
 * Grading status from the ordered rows: `active` while a phase has started and
 * not ended. Elapsed comes from the gate log's mtime, never a parsed timestamp.
 */
export function gradingStatus(rows, { logMtimeMs = null, now = Date.now() } = {}) {
  let phase = null;
  let active = false;
  let attempt = null;
  let timedOut = false;

  // Per-phase results (conformance/backend/frontend status and problem count)
  // as each phase ends, so the board shows what grading has found so far. Phase
  // problem counts are not gates and are never drawn as squares; provisional.
  const phases = [];

  for (const r of rows) {
    if (r.type === "harness:gate-attempt-start") {
      attempt = r.detail?.match(/attempt (\S+)/)?.[1] ?? attempt;
      phase = null;
      active = true;
      // A new attempt re-grades from scratch.
      phases.length = 0;
    } else if (r.type === "harness:gate-phase-start") {
      phase = r.phase;
      active = true;
      if (r.phase && !phases.some((p) => p.phase === r.phase)) {
        phases.push({ phase: r.phase, status: null, problems: null, running: true });
      }
    } else if (r.type === "harness:gate-phase-end") {
      phase = r.phase;
      active = false;
      // `detail` is "<phase> <status> · <n> problems" (rowFor).
      const st = r.detail?.match(/^\S+\s+(\S+)/)?.[1] ?? null;
      const probs = r.detail?.match(/·\s*(\d+)\s+problems/)?.[1] ?? null;
      const existing = phases.find((p) => p.phase === r.phase);
      const done = {
        phase: r.phase,
        status: st,
        problems: probs === null ? null : Number(probs),
        running: false,
      };
      if (existing) Object.assign(existing, done);
      else phases.push(done);
    } else if (r.type === "harness:gate-timeout") {
      timedOut = true;
      active = false;
      const open = phases.find((p) => p.running);
      if (open) {
        open.running = false;
        open.status = "timeout";
      }
    }
  }

  const elapsed =
    active && logMtimeMs ? Math.max(0, Math.round((now - logMtimeMs) / 1000)) : null;

  return {
    grading: active,
    phase,
    attempt,
    timed_out: timedOut,
    // Seconds since the gate log was written while a phase is open.
    silent_s: elapsed,
    stall_threshold_s: GATE_STALL_THRESHOLD_S,
    // A boolean verdict; the panel decides presentation.
    stalled: elapsed !== null && elapsed >= GATE_STALL_THRESHOLD_S,
    // Provisional: the authoritative gate list lands at attempt end.
    phases,
  };
}

/**
 * The launch log of exactly one cell, or null. The control plane names each
 * cell's launch log `<arm>-cell-<stamp>-s<NNNN>.log` (routes/run.mjs), so the
 * sequence index in the file name IS the cell identity; the scan covers the
 * same bases as runstate's candidate scan (active tree, then runs root). The
 * cell must also exist under the requested run_dir (cellDirForRun) — a request
 * for a cell that is not there yields nothing, never another cell's log.
 */
async function cellLaunchLog(runsRoot, runDir, sequenceIndex) {
  const cell = await cellDirForRun(runsRoot, runDir, sequenceIndex);
  if (!cell) return null;
  const suffix = `-s${String(sequenceIndex).padStart(4, "0")}.log`;
  let treeRoot = null;
  try {
    treeRoot = await activeTreeRoot(runsRoot);
  } catch {
    treeRoot = null;
  }
  for (const base of treeRoot ? [treeRoot, runsRoot] : [runsRoot]) {
    for (const ent of await listDir(base)) {
      if (!ent.isFile() || !ent.name.endsWith(suffix)) continue;
      if (!/^(off|on)-cell-|^cell-/.test(ent.name)) continue;
      const path = join(base, ent.name);
      const st = await statOrNull(path);
      if (st?.isFile()) {
        return { path, mtime: st.mtimeMs, size: st.size, name: ent.name, run_dir: runDir };
      }
    }
  }
  return null;
}

/**
 * Grading events and status, tail-bounded. With `{ runDir, sequenceIndex }`
 * the read is pinned to exactly that cell's launch log — empty when the cell
 * or its log is absent, never another cell's. Without a selector it reads the
 * newest live cell's log, as before.
 */
export async function readGateActivity(runsRoot, opts = {}) {
  const { runDir = null, sequenceIndex = null } = opts ?? {};
  const log =
    runDir && sequenceIndex != null
      ? await cellLaunchLog(runsRoot, runDir, sequenceIndex)
      : await newestLog(runsRoot);
  if (!log) return { rows: [], status: null, log: null };

  const text = await readTail(log.path);
  const rows = parseGateEvents(text);
  const status = gradingStatus(rows, { logMtimeMs: log.mtime });
  return { rows, status, log };
}
