// GRADED TEXT — what the model was actually told, verbatim. The harness turns
// gate results into prose and hands it to the model as if a user typed it; this
// reads that text from the cell's sidecar file, byte for byte (the point is to
// judge whether it reads like a person wrote it). Read-only.

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { resolveRunDir } from "./wall.mjs";
import { cellDirForRun } from "./runstate.mjs";
import { statOrNull, listDir } from "./lib/fs.mjs";

/** The contract version the board can assert against. */
export const FEEDBACK_CONTRACT_VERSION = 1;

/** Bounded read (a chunk prompt ran 33KB). */
const DEFAULT_BYTES = 2 * 1024 * 1024;

/**
 * One sidecar file → records. A truncated first line or unparseable line is
 * skipped, never fatal.
 */
export async function readSidecar(path, { bytes = DEFAULT_BYTES } = {}) {
  const st = await statOrNull(path);
  if (!st?.isFile()) return null;

  let text;
  const fh = await fs.open(path, "r").catch(() => null);
  if (!fh) return null;
  try {
    const start = Math.max(0, st.size - bytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }

  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let record;
    try {
      record = JSON.parse(t);
    } catch {
      continue;
    }
    if (typeof record?.text !== "string") continue;
    out.push(record);
  }
  return out;
}

/**
 * A record → the served shape. A missing `kind` defaults to feedback and says
 * so (kind_inferred).
 */
export function normalizeMessage(record, index) {
  const kind = typeof record.kind === "string" && record.kind ? record.kind : null;
  const text = String(record.text ?? "");
  return {
    seq: index,
    kind: kind ?? "feedback",
    kind_inferred: kind === null,
    attempt: Number.isFinite(Number(record.attempt)) ? Number(record.attempt) : null,
    at: Number.isFinite(Number(record.timestamp)) ? Number(record.timestamp) : null,
    chars: Number.isFinite(Number(record.chars)) ? Number(record.chars) : text.length,
    text_fp: typeof record.text_fp === "string" ? record.text_fp : null,
    // Verbatim: never trimmed or re-wrapped.
    text,
  };
}

/**
 * Every cell session folder under a run that has a sidecar, newest first
 * (listing order only — selection is by sequence_index, never by recency).
 */
const CELL_CONTAINERS = ["memoryOFF", "memoryON", "memoryUNKNOWN", "sessions"];

async function sessionDirs(runPath) {
  const rows = [];
  // Both layouts: memory{OFF,ON}/ in the tree, sessions/ in older campaigns.
  for (const container of CELL_CONTAINERS) {
    const base = join(runPath, container);
    for (const ent of await listDir(base)) {
      if (!ent.isDirectory()) continue;
      const sidecar = join(base, ent.name, "worktree.user-events.jsonl");
      const st = await statOrNull(sidecar);
      if (!st?.isFile()) continue;
      // The bare cell name is unique across arms (sequence_index spans the
      // schedule), so the cellName resolved from (run_dir, sequence_index)
      // picks exactly one row.
      rows.push({ cell: ent.name, path: sidecar, mtime: st.mtimeMs });
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows;
}

/**
 * Assemble GET /api/feedback. Never 500, never fabricate: no sidecar yet is
 * ok:true, empty, with unwired:["user-events"] and a reason. The cell is
 * selected by (run_dir, sequence_index) — the canonical identity — and an
 * absent or unresolvable index reads EMPTY, never the newest cell: silently
 * serving another cell's prompts would forge "the live session".
 */
export async function readFeedback({ runsRoot, runDir, sequenceIndex = null, limit = 50, includeText = true }) {
  const target = resolveRunDir(runsRoot, runDir);
  if (!target) {
    return {
      ok: false,
      code: "bad_run_dir",
      reason: `run_dir must be a single directory name under the runs root; got ${JSON.stringify(String(runDir ?? ""))}`,
    };
  }

  const dirs = await sessionDirs(target.path);
  if (dirs.length === 0) {
    return {
      ok: true,
      contract_version: FEEDBACK_CONTRACT_VERSION,
      run_dir: target.name,
      cell: null,
      cells: [],
      messages: [],
      counts: { chunk: 0, pass_verdict: 0, feedback: 0 },
      unwired: ["user-events"],
      unwired_reasons: {
        "user-events":
          `no worktree.user-events.jsonl under runs/${target.name}/{memoryOFF,memoryON} — the sidecar is created ` +
          "when the first prompt is sent to the model, so this is the normal state before a cell starts",
      },
    };
  }

  const resolved =
    sequenceIndex != null ? await cellDirForRun(runsRoot, target.name, sequenceIndex) : null;
  const chosen = resolved ? dirs.find((d) => d.cell === resolved.cellName) ?? null : null;
  if (!chosen) {
    // EMPTY, plus what exists: the caller asked for one cell or none, and
    // "none" is the answer — never a substitute nobody selected.
    return {
      ok: true,
      contract_version: FEEDBACK_CONTRACT_VERSION,
      run_dir: target.name,
      cell: null,
      cells: dirs.map((d) => d.cell),
      messages: [],
      counts: { chunk: 0, pass_verdict: 0, feedback: 0 },
      unwired: [],
      unwired_reasons: {},
    };
  }

  const records = (await readSidecar(chosen.path)) ?? [];
  const all = records.map(normalizeMessage);

  const counts = { chunk: 0, pass_verdict: 0, feedback: 0 };
  for (const m of all) {
    if (counts[m.kind] === undefined) counts[m.kind] = 0;
    counts[m.kind] += 1;
  }

  // Newest last, like the event feed.
  const bounded = Number.isFinite(limit) && limit > 0 ? all.slice(-limit) : all;
  const messages = includeText ? bounded : bounded.map(({ text, ...rest }) => rest);

  return {
    ok: true,
    contract_version: FEEDBACK_CONTRACT_VERSION,
    run_dir: target.name,
    cell: chosen.cell,
    cells: dirs.map((d) => d.cell),
    total: all.length,
    returned: messages.length,
    // Tells "text omitted from this response" from "no text was sent".
    text_included: includeText,
    messages,
    counts,
    unwired: [],
    unwired_reasons: {},
  };
}

/**
 * The same messages as feed rows (BoardEvent shape), kind "user" — on the
 * board these are user turns, the fiction under test.
 */
export function feedbackRows(messages, { textCap = 64 * 1024, runDir = "", cell = "" } = {}) {
  return messages.map((m) => {
    const truncated = m.text.length > textCap;
    return {
      id: `user-event:${runDir}:${cell}:${m.seq}`,
      kind: "user",
      type: `user:${m.kind}`,
      at: m.at,
      session_id: null,
      tool: null,
      file: null,
      name:
        m.kind === "chunk"
          ? `task chunk (attempt ${m.attempt ?? "?"})`
          : m.kind === "pass_verdict"
            ? `verdict: passing (attempt ${m.attempt ?? "?"})`
            : `verdict: still failing (attempt ${m.attempt ?? "?"})`,
      detail: `${m.chars} chars · fp ${m.text_fp ?? "none"}`,
      // Full text; the cap only guards pathological payloads and is flagged if hit.
      text: truncated ? m.text.slice(0, textCap) : m.text,
      truncated,
      phase: null,
    };
  });
}
