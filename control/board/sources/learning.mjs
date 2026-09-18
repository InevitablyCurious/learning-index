// ─────────────────────────────────────────────────────────────────────────────
// SOURCE: learning
//
// The in-session extraction capture — the model's OWN account of what it learned
// this cell, merged by the vendored plugin into a mark-keyed master
// (`reassembler-master/3.0`), plus the per-attempt gate matrix and the
// harness-produced learning ledger. This is the surface behind the LEARNING
// panel (panels/learning.js): MATRIX (gate × attempt), CLAIMS (trajectories +
// knowledge + evidence + code-derived edit ranges), LIVE (capture bookkeeping +
// session history).
//
// ── WHAT IS READ, AND FROM WHERE ────────────────────────────────────────────
//
//   predicate-outcomes.jsonl        run-level, appended per (gate, attempt).
//                                   The MATRIX's only source: pass AND fail, so
//                                   a gate that passed is drawn, unlike the
//                                   status stream which carries failures only.
//   gate-roster.json                run-level, write-once. The gate universe
//                                   (id, phase, title) the matrix rows come from.
//   learning-ledger.json            cell-level, produced by the harness at cell
//                                   end. Window labels + claim distribution +
//                                   mark→window attribution. NEVER derived here.
//   data/cells/<unix_ts>-<run_label>/insession/<sid>/master.json +
//   changed-lines.json                  the plugin's in-session capture,
//                                   exported host-side at teardown by
//                                   backgammon.py (`_export_cell_telemetry`).
//                                   ON cells export from the worktree state
//                                   dir; OFF cells from the blind mount outside
//                                   the worktree — an absent OFF export is
//                                   stated, never patched with a synthesis.
//
// ── THE HONESTY RULES THIS MODULE CARRIES ────────────────────────────────────
//
//   1. THE MATRIX DENOMINATOR IS THE ENUMERATED ROSTER, or it is null. The
//      roster is written once at run start; a run predating it has none, and
//      that renders as a stated reason, never a fabricated count.
//   2. WINDOW LABELS COME FROM learning-ledger.json, never computed here. Two
//      definitions of "which window did this claim appear in" is exactly the
//      drift the board exists to expose. Absent ledger = unobserved.
//   3. session_goal.text in the master is a MOCKED placeholder (the plugin does
//      not capture the real goal yet). The panel renders the goal from the task
//      manifest, never from the master.
//   4. The master is append-only in effect (first-seen-wins, evidence extends).
//      A shrink across polls is a capture anomaly; it is reported in
//      capture_state, never smoothed.
//
// OFF-CELL CAPTURE GAP: the OFF worktree is deliberately unbound for arm
// comparability (backgammon.py removes .okp at cell start), so the plugin
// routes state to a blind mount outside the worktree; the teardown export
// copies that tree into data/cells/ when present. OFF rows read `unwired`
// with that reason. No OFF master is ever synthesised.
// ─────────────────────────────────────────────────────────────────────────────

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

/** Phases per cell: 1 build + 4 repair/troubleshooting rounds (max_attempts 5). */
export const PHASES_PER_CELL = 5;

/**
 * The four capture states, in the words the panel renders them. Every state is
 * carried; the panel shows all four and the CURRENT one is what varies.
 */
export const CAPTURE_STATES = ["unwired", "unobserved", "captured", "anomaly"];

// Cross-poll state for ANOMALY detection: the master is append-only in effect,
// so a mark count that shrank across polls is a capture defect. Keyed by
// session id, reset on session rotation.
let lastMarks = null;

export async function read(ctx) {
  const run = await activeRun(ctx.runsRoot);
  if (!run?.dir) {
    return { ok: false, reason: "no active run directory — nothing to learn from yet" };
  }

  // ── THE MATRIX: roster (denominator + rows) × outcomes (pass AND fail) ─────
  const rosterPath = join(run.dir, "gate-roster.json");
  const roster = await readJson(rosterPath);
  const outcomesPath = join(run.dir, "predicate-outcomes.jsonl");
  const outcomes = parseJsonl(await readTail(outcomesPath));

  // ── THE DURING-THE-RUN HALF OF THE MATRIX ─────────────────────────────────
  // `predicate-outcomes.jsonl` is written in run_cumulative.py's `finally`
  // block — AFTER the whole campaign exits. Reading only it meant that for the
  // entire life of a run this panel rendered the roster skeleton with every
  // cell null and the session `unresolved`, which is precisely the defect
  // LIVE-STREAM.md says the live stream exists to close. It was never wired up
  // here. This is that wiring.
  //
  // The post-mortem file stays AUTHORITATIVE: live rows are laid down first and
  // predicate-outcome rows overwrite them per (gate, attempt), so a completed
  // run reads exactly as it did before. Nothing is inferred — a `gate.result`
  // is the runner's own recorded verdict, the same fact the post-mortem row
  // carries, published at the moment it became true.
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

  // ── SESSION RESOLUTION ────────────────────────────────────────────────────
  // The newest predicate-outcome line names the session once the run is over;
  // while it runs, `cell.start` named it before the model took a single turn.
  const newest = outcomes[outcomes.length - 1] ?? null;
  const sessionId = str(newest?.session_id) ?? liveSession ?? null;
  const manifest = await readJson(join(run.dir, "manifest.json"));
  const cell = {
    memory_mode: str(newest?.memory_mode) ?? liveArm ?? null,
    sequence_index: int(newest?.sequence_index) ?? liveCellSeq ?? null,
    // The model is a manifest fact (roster[0]), never an outcome field.
    model: str(manifest?.roster?.[0]?.model) ?? null,
    org_id: str(newest?.org_id) ?? str(manifest?.org_id) ?? null,
    // The real session goal reads from the manifest task — the master's
    // session_goal.text is a MOCKED placeholder and is never the goal.
    task: str(manifest?.task) ?? null,
  };
  const attemptCurrent =
    mergedOutcomes.reduce((m, o) => Math.max(m, int(o.attempt) ?? 0), 0) || null;

  // ── IN-SESSION CAPTURES: teardown-exported cells under data/cells/ ─────────
  const sessions = await collectSessions(join(ctx.benchRoot, "data", "cells"));

  // ── THE ACTIVE SESSION'S MASTER + EDIT LOG ─────────────────────────────────
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
      // ANOMALY DETECTION: the master is append-only in effect (first-seen-wins,
      // evidence only extends), so a mark count that SHRANK since the last poll
      // is a capture defect — reported in words, never silently re-baselined.
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
    // The OFF-cell gap: a capture exists upstream but never reached the host.
    captureState = "unwired";
  }

  // ── THE LEARNING LEDGER (harness-produced; absent = unobserved) ────────────
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

// ── MATRIX ──────────────────────────────────────────────────────────────────

/**
 * Join the write-once roster (rows) with per-attempt outcomes (cells).
 *
 * Returns null when neither exists — a null matrix is a designed state, never
 * an empty grid. The roster provides `id`, `phase`, `title`; the outcomes
 * provide `pass`/`fail` per (gate_id, attempt). When the roster is absent the
 * matrix still builds from outcome gate_ids (grouped by gate_phase), with the
 * title falling back to the id — the denominator is then null, because the
 * true suite size is unknowable without a roster.
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

// ── INSESSION CAPTURE READ (teardown export under data/cells/) ──────────────

/**
 * Read the teardown-exported cell dirs under `data/cells/` (one level) for
 * `insession/<sid>/` captures — backgammon.py `_export_cell_telemetry` copies
 * the tree host-side before container teardown. Each cell dir is named
 * `<unix_ts>-<run_label>` and the label is itself hyphenated, so the arm is
 * derived from the part after the FIRST hyphen. Returns one entry per session
 * found, newest first, capped at 20.
 */
export async function collectSessions(cellsDir) {
  const found = [];
  for (const ent of await listDir(cellsDir)) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    // The export layer holds finished cells only, but the skip is kept so a
    // stray agent-grown tree can never make a 2s-tick read unbounded.
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
 * The arm from a cell dir name `<unix_ts>-<run_label>`. The label is itself
 * hyphenated, so it is the part after the FIRST hyphen only; within it, `on`
 * and `off` match as whole tokens delimited by `-`/`_`/start/end — never as
 * bare substrings, because labels contain other words (e.g.
 * `cumulative-0000-off-orcarouter-...` → "off", legacy `backgammon-on` →
 * "on", `session-0731` → null).
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

// ── LEARNING LEDGER ─────────────────────────────────────────────────────────

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

// ── MASTER VALIDATION (mirrors the plugin's validateMaster — three checks) ──

/**
 * The same three deterministic checks the plugin runs on every capture:
 * duplicate normalized trajectory slugs, unresolved parent labels, parent-chain
 * cycles. Carried so a disagreement between this board and the plugin's own log
 * is surfaced, never smoothed.
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
