// SOURCE: learning — behind the LEARNING panel: the model's own in-session
// account of what it learned (the plugin's mark-keyed master), the gate ×
// attempt matrix, and the harness's learning ledger.
//
//   predicate-outcomes.jsonl  run-level, pass AND fail per (gate, attempt)
//   gate-roster.json          the gate universe (rows)
//   learning-ledger.json      harness-produced at cell end: window labels,
//                             claim distribution — never derived here
//   data/cells/<ts>-<label>/insession/<sid>/master.json + changed-lines.json
//                             the plugin capture, exported at teardown
//
// The matrix denominator is the roster or null. The master's session_goal is a
// placeholder; the goal comes from the manifest. A master that shrinks between
// polls is reported as a capture anomaly. OFF cells have no persisted capture
// and read unwired; nothing is synthesised.

import { int, str } from "../contract.mjs";
import {
  readTail,
  parseJsonl,
  readJson,
  listDir,
  statOrNull,
  activeRun,
  liveStreamPath,
} from "./_runtime.mjs";
import { join } from "node:path";

export const id = "learning";
export const fields = ["learning"];
export function describe() {
  return "in-session extraction master + gate×attempt matrix + learning ledger";
}

/** 1 build + 4 repair rounds (max_attempts 5). */
export const PHASES_PER_CELL = 5;

/** The four capture states, in the panel's words. */
export const CAPTURE_STATES = ["unwired", "unobserved", "captured", "anomaly"];

// Cross-poll mark count for anomaly detection, per session id.
let lastMarks = null;

export async function read(ctx) {
  const run = await activeRun(ctx.runsRoot);
  if (!run?.dir) {
    return { ok: false, reason: "no active run directory — nothing to learn from yet" };
  }

  // ── THE MATRIX ── roster (rows) × outcomes (pass and fail).
  const rosterPath = join(run.dir, "gate-roster.json");
  const roster = await readJson(rosterPath);
  const outcomesPath = join(run.dir, "predicate-outcomes.jsonl");
  const outcomes = parseJsonl(await readTail(outcomesPath));

  // During the run, gate.result records from the live stream fill the matrix
  // (predicate-outcomes.jsonl is written only when the campaign exits). The
  // post-mortem file stays authoritative and overwrites per (gate, attempt).
  const livePath = await liveStreamPath(run.dir);
  const liveRecs = livePath ? parseJsonl(await readTail(livePath)) : [];
  const liveOutcomes = [];
  let liveSession = null;
  let liveArm = null;
  let liveCellSeq = null;
  for (const r of liveRecs) {
    if (!r || typeof r !== "object") continue;
    const sid = str(r.session_id);
    if (sid) liveSession = sid;
    if (int(r.cell_seq) !== null) liveCellSeq = int(r.cell_seq);
    const kind = str(r.kind);
    if (kind === "cell.start") {
      liveArm = str(r.arm) ?? liveArm;
      continue;
    }
    if (kind !== "gate.result") continue;
    const gid = str(r.id);
    const a = int(r.attempt);
    const status = str(r.status);
    if (!gid || a === null) continue;
    if (status !== "pass" && status !== "fail") continue;
    liveOutcomes.push({ gate_id: gid, attempt: a, predicate_outcome: status, session_id: sid });
  }

  const mergedOutcomes = [...liveOutcomes, ...outcomes];
  const matrix = mergedOutcomes.length || roster ? buildMatrix(roster, mergedOutcomes) : null;

  // ── SESSION ── from the newest predicate outcome, or cell.start while running.
  const newest = outcomes[outcomes.length - 1] ?? null;
  const sessionId = str(newest?.session_id) ?? liveSession ?? null;
  const manifest = await readJson(join(run.dir, "manifest.json"));
  const cell = {
    memory_mode: str(newest?.memory_mode) ?? liveArm ?? null,
    sequence_index: int(newest?.sequence_index) ?? liveCellSeq ?? null,
    // The model is a manifest fact.
    model: str(manifest?.roster?.[0]?.model) ?? null,
    org_id: str(newest?.org_id) ?? str(manifest?.org_id) ?? null,
    // The goal is the manifest task (the master's goal is a placeholder).
    task: str(manifest?.task) ?? null,
  };
  const attemptCurrent =
    mergedOutcomes.reduce((m, o) => Math.max(m, int(o.attempt) ?? 0), 0) || null;

  // ── IN-SESSION CAPTURES ── under data/cells/.
  const sessions = await collectSessions(join(ctx.benchRoot, "data", "cells"));

  // ── THE ACTIVE SESSION'S MASTER + EDIT LOG ──
  let master = null;
  let changedLines = null;
  let captureState = "unobserved";
  const active = sessionId ? sessions.find((s) => s.session_id === sessionId) : null;
  if (active?.arm === "on" && active?.masterPath) {
    const m = await readJson(active.masterPath);
    if (m && typeof m === "object") {
      const { valid, errors } = validateMaster(m);
      master = {
        path: active.masterPath,
        mtime_ms: active.mtime_ms,
        bytes: active.bytes,
        schema_version: str(m.schema_version),
        session_goal: m.session_goal ?? null,
        merge: m.merge ?? null,
        trajectories: Array.isArray(m.trajectories) ? m.trajectories : [],
        valid,
        validation_errors: errors,
      };
      // A mark count that shrank since the last poll is a capture defect, reported.
      const marks = Array.isArray(m.merge?.marks_seen) ? m.merge.marks_seen.length : 0;
      if (lastMarks && lastMarks.sessionId === sessionId && marks < lastMarks.marks) {
        captureState = "anomaly";
      } else {
        captureState = "captured";
      }
      lastMarks = { sessionId, marks };
    }
    const cl = await readJson(active.changedLinesPath);
    if (Array.isArray(cl)) {
      changedLines = {
        path: active.changedLinesPath,
        mtime_ms: active.changedLinesMtime ?? null,
        count: cl.length,
        files: [...new Set(cl.map((r) => str(r?.file)).filter(Boolean))],
      };
    }
  } else if (active && active.arm === "off") {
    // The OFF-cell gap: the capture never reached the host.
    captureState = "unwired";
  }

  // ── THE LEARNING LEDGER ── harness-produced; absent = unobserved.
  const ledger = await findLedger(run.dir);

  return {
    ok: true,
    provenance: {
      path: run.dir,
      mtime: run.mtime ?? null,
      run: run.name,
      sessions: sessions.length,
      live_stream: livePath,
      outcome_rows: { live: liveOutcomes.length, post_mortem: outcomes.length },
    },
    patch: {
      learning: {
        run: run.name,
        cell,
        session_id: sessionId,
        attempt: { current: attemptCurrent, max: PHASES_PER_CELL },
        phase_count: PHASES_PER_CELL,
        matrix,
        ledger,
        master,
        changed_lines: changedLines,
        capture_state: captureState,
        sessions,
      },
    },
  };
}

// ── MATRIX ──

/**
 * Join the roster (rows) with per-attempt outcomes; null when neither exists.
 * Without a roster the rows come from the outcomes (grouped by phase, titled by
 * id) and the denominator is null.
 */
export function buildMatrix(roster, outcomes) {
  const rosterGates = Array.isArray(roster?.gates) ? roster.gates : null;
  const list = Array.isArray(outcomes) ? outcomes : [];

  // outcome index: gate_id -> {attempt -> "pass"|"fail"}
  const byGate = new Map();
  for (const o of list) {
    const gid = str(o?.gate_id);
    if (!gid) continue;
    const a = int(o?.attempt);
    const out = o?.predicate_outcome === "pass" ? "pass" : o?.predicate_outcome === "fail" ? "fail" : null;
    if (a === null || out === null) continue;
    if (!byGate.has(gid)) byGate.set(gid, new Map());
    byGate.get(gid).set(a, out);
  }

  const phases = ["conformance", "backend", "frontend"];
  const byPhase = { conformance: 0, backend: 0, frontend: 0 };

  const gates = [];
  if (rosterGates) {
    for (const g of rosterGates) {
      const gid = str(g.id);
      const phase = phases.includes(str(g.phase)) ? str(g.phase) : "backend";
      byPhase[phase] += 1;
      const perAttempt = byGate.get(gid) ?? new Map();
      gates.push({
        id: gid,
        phase,
        title: str(g.title) ?? gid,
        outcomes: attemptsOutcomes(perAttempt),
      });
    }
  } else {
    // No roster: rows from the outcomes alone, grouped by gate_phase.
    for (const [gid, perAttempt] of byGate) {
      const phase = "conformance";
      byPhase[phase] += 1;
      gates.push({ id: gid, phase, title: gid, outcomes: attemptsOutcomes(perAttempt) });
    }
  }

  let tested = 0;
  let passing = 0;
  for (const g of gates) {
    for (const o of g.outcomes) {
      if (o === null) continue;
      tested += 1;
      if (o === "pass") passing += 1;
    }
  }
  // "passing at the newest attempt" — how the headline reads while a cell runs.
  const newestAttempt = Math.max(0, ...gates.flatMap((g) => g.outcomes.map((o, i) => (o !== null ? i + 1 : 0))));
  let passingAtNewest = 0;
  for (const g of gates) if (g.outcomes[newestAttempt - 1] === "pass") passingAtNewest += 1;

  return {
    total: rosterGates ? (roster?.total ?? gates.length) : null,
    complete: roster?.enumeration?.complete !== false,
    by_phase: byPhase,
    phases,
    attempts: PHASES_PER_CELL,
    gates,
    counts: {
      outcomes_read: tested,
      passing_total: passing,
      passing_at_newest: passingAtNewest,
      newest_attempt: newestAttempt || null,
    },
  };
}

function attemptsOutcomes(perAttempt) {
  const out = [];
  for (let a = 1; a <= PHASES_PER_CELL; a++) out.push(perAttempt.get(a) ?? null);
  return out;
}

// ── IN-SESSION CAPTURE READ ──

/**
 * Read teardown-exported cell folders under data/cells/ for
 * insession/<sid>/ captures; newest first, capped at 20.
 */
export async function collectSessions(cellsDir) {
  const found = [];
  for (const ent of await listDir(cellsDir)) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    // Skipped so a stray tree can never make a 2s read unbounded.
    if (ent.name === "node_modules" || ent.name === "session-db") continue;
    const arm = armFromLabel(ent.name);
    const insessionDir = join(cellsDir, ent.name, "insession");
    for (const s of await listDir(insessionDir)) {
      if (!s.isDirectory() || s.name.startsWith(".")) continue;
      found.push(await describeSession(s.name, join(insessionDir, s.name), arm));
    }
  }
  found.sort((a, b) => (b.mtime_ms ?? 0) - (a.mtime_ms ?? 0));
  return found.slice(0, 20);
}

/**
 * The arm from `<unix_ts>-<run_label>`: on/off as whole tokens after the first
 * hyphen (`cumulative-0000-off-…` → off, `session-0731` → null).
 */
export function armFromLabel(cellDirName) {
  const name = String(cellDirName ?? "");
  const first = name.indexOf("-");
  const label = first === -1 ? name : name.slice(first + 1);
  const tokens = label.split(/[-_]/);
  if (tokens.includes("off")) return "off";
  if (tokens.includes("on")) return "on";
  return null;
}

async function describeSession(sessionId, sessionDir, arm) {
  const masterPath = join(sessionDir, "master.json");
  const changedLinesPath = join(sessionDir, "changed-lines.json");
  const masterStat = await statOrNull(masterPath);
  const clStat = await statOrNull(changedLinesPath);

  let marksSeen = null;
  let totalMarks = null;
  let trajectories = null;
  let claims = 0;
  let pos = 0;
  let neg = 0;
  if (masterStat?.isFile()) {
    const m = await readJson(masterPath);
    if (m && typeof m === "object") {
      marksSeen = Array.isArray(m.merge?.marks_seen) ? m.merge.marks_seen.length : null;
      totalMarks = int(m.merge?.total_marks);
      trajectories = Array.isArray(m.trajectories) ? m.trajectories.length : null;
      for (const t of Array.isArray(m.trajectories) ? m.trajectories : []) {
        for (const k of Array.isArray(t.knowledge) ? t.knowledge : []) {
          claims += 1;
          if (k.polarity === "positive") pos += 1;
          else if (k.polarity === "negative") neg += 1;
        }
      }
    }
  }

  return {
    session_id: sessionId,
    arm,
    mtime_ms: masterStat?.mtimeMs ?? null,
    bytes: masterStat?.size ?? null,
    marks_seen: marksSeen,
    total_marks: totalMarks,
    trajectories,
    claims,
    pos,
    neg,
    masterPath,
    changedLinesPath,
    changedLinesMtime: clStat?.mtimeMs ?? null,
  };
}

// ── LEARNING LEDGER ──

async function findLedger(runDir) {
  async function walk(dir, depth) {
    if (depth > 8) return null;
    for (const ent of await listDir(dir)) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      if (ent.name === "node_modules" || ent.name === "session-db") continue;
      const child = join(dir, ent.name);
      const p = join(child, "learning-ledger.json");
      const st = await statOrNull(p);
      if (st?.isFile()) {
        const l = await readJson(p);
        return l && typeof l === "object" ? { path: p, mtime_ms: st.mtimeMs, ...l } : null;
      }
      const deeper = await walk(child, depth + 1);
      if (deeper) return deeper;
    }
    return null;
  }
  return walk(runDir, 0);
}

// ── MASTER VALIDATION ── the plugin's own three checks.

/**
 * Duplicate trajectory slugs, unresolved parent labels, parent cycles —
 * carried so a disagreement with the plugin's log shows.
 */
export function normalizeLabel(label) {
  return String(label ?? "").toLowerCase().trim().replace(/\s+/g, "_").replace(/[^\w]/g, "");
}

export function validateMaster(master) {
  const errors = [];
  if (!master || typeof master !== "object" || !master.session_goal) {
    errors.push("master missing 'session_goal'");
    return { valid: errors.length === 0, errors };
  }
  const trajectories = Array.isArray(master.trajectories) ? master.trajectories : [];
  const bySlug = new Map();
  for (const t of trajectories) {
    const slug = normalizeLabel(t.traj_label);
    if (bySlug.has(slug)) errors.push(`duplicate trajectory slug: '${slug}'`);
    bySlug.set(slug, t);
  }
  for (const t of trajectories) {
    const parent = t.parent_traj_label;
    if (parent === null || parent === undefined) continue;
    const parentSlug = normalizeLabel(parent);
    if (parentSlug !== "traj0" && !bySlug.has(parentSlug)) {
      errors.push(`unresolved parent_traj_label: '${parent}'`);
    }
  }
  for (const t of trajectories) {
    const visited = new Set();
    let cursor = t;
    while (cursor !== undefined) {
      const slug = normalizeLabel(cursor.traj_label);
      if (visited.has(slug)) {
        errors.push(`parent chain cycle at: '${slug}'`);
        break;
      }
      visited.add(slug);
      const parent = cursor.parent_traj_label;
      if (parent === null || parent === undefined) break;
      const parentSlug = normalizeLabel(parent);
      if (parentSlug === "traj0") break;
      cursor = bySlug.get(parentSlug);
    }
  }
  return { valid: errors.length === 0, errors };
}
