// BACKEND FEED — what the machinery is doing, read from records the processes
// wrote (never regex-scraped from a log). The event feed shows the agent, which
// is idle between attempts; this is the signal for that window.
//
//   the cell's live.jsonl     cell-scoped: harness phases and gates, gate-runner
//                             notices, backend `ext` records
//   <log>.notices.jsonl       run-scoped: control plane and campaign layer
//
// Merged by `ts`. Live reads are bounded tails and say when they are windowed;
// a missing or half-written stream yields fewer rows and a reason, never an
// exception.

import { readFile, open, stat } from "node:fs/promises";
import { join } from "node:path";

import { noticesPathFor } from "./notices.mjs";
import { cellDirForRun } from "./runstate.mjs";

/** Tail size per stream: well past a busy cell's notices, cheap per poll. */
export const FEED_TAIL_BYTES = 256 * 1024;

/** Rows returned at most, newest kept. */
export const FEED_MAX_ROWS = 600;

/**
 * Records about the run's shape, not activity: heartbeats (every 15s) would
 * bury everything else, and the chrome already shows liveness.
 */
const NOT_ACTIVITY = new Set(["heartbeat"]);

/**
 * Read one stream's tail and parse whole lines (the first line of a tail is
 * usually cut mid-record).
 */
async function readStreamTail(path, { complete = false } = {}) {
  if (!path) return { rows: [], bytes: 0, ok: false };
  let text;
  let bytes = 0;
  try {
    const buf = await readFile(path);
    bytes = buf.length;
    // A finished cell is read whole: its start is what a reviewer came for.
    text = complete
      ? buf.toString("utf8")
      : buf.subarray(Math.max(0, bytes - FEED_TAIL_BYTES)).toString("utf8");
  } catch {
    return { rows: [], bytes: 0, ok: false };
  }

  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec && typeof rec.kind === "string") rows.push(rec);
  }
  return { rows, bytes, ok: true };
}

/**
 * Which chip a row belongs to: a notice's `source`, an ext record's `ns` (a
 * backend's namespace, never folded into a native source), or `harness` for the
 * core kinds.
 */
export function rowSource(rec) {
  if (rec.kind === "notice" && typeof rec.source === "string") return rec.source;
  if (rec.kind === "ext" && typeof rec.ns === "string") return rec.ns;
  return "harness";
}

/**
 * Severity: only notices state one; everything else is info. A failing gate is
 * the candidate failing, not the instrument, and is not an error here.
 */
export function rowLevel(rec) {
  return rec.kind === "notice" && typeof rec.level === "string" ? rec.level : "info";
}

// ── THE ERROR LOG ── errors are never windowed: every error-level record in
// the run is kept, however old. Cheap because the files are append-only: each
// poll reads only what was added (a file that got shorter was replaced, so start
// over), and a substring test skips parsing non-notice lines.
const errorScans = new Map();

/**
 * Cap on the NUMBER of paths cached, not on any path's error list (which stays
 * append-only per the windowing above). One entry accrues per distinct path
 * ever scanned and nothing else removes it, so without a cap this Map grows
 * for the life of the process. Over the cap, the oldest entry (first in
 * insertion order) is evicted; a later re-scan of that path simply starts over
 * from byte 0 and rebuilds the same list.
 */
const MAX_ERROR_SCANS = 256;

async function scanErrors(path) {
  if (!path) return [];
  let size;
  try {
    size = (await stat(path)).size;
  } catch {
    // Unreadable now: keep the errors already found.
    return errorScans.get(path)?.errors ?? [];
  }

  const prior = errorScans.get(path);
  // Shorter than last time: a different file with the same name.
  const from = prior && size >= prior.size ? prior.size : 0;
  const errors = from === 0 ? [] : prior.errors;

  if (size > from) {
    try {
      const fh = await open(path, "r");
      try {
        const buf = Buffer.alloc(size - from);
        await fh.read(buf, 0, buf.length, from);
        for (const line of buf.toString("utf8").split("\n")) {
          if (!line.includes('"level":"error"')) continue;
          let rec;
          try {
            rec = JSON.parse(line);
          } catch {
            continue;
          }
          if (rec?.level === "error") errors.push(rec);
        }
      } finally {
        await fh.close();
      }
    } catch {
      // Keep what we have; retry next poll.
      return errors;
    }
  }

  errorScans.set(path, { size, errors });
  // Bound the cache: evict the oldest path (first key in insertion order).
  // Only the path count is capped — an evicted path's errors are rebuilt from
  // byte 0 on its next scan, never lost from the file itself.
  if (errorScans.size > MAX_ERROR_SCANS) {
    const oldest = errorScans.keys().next().value;
    if (oldest !== undefined) errorScans.delete(oldest);
  }
  return errors;
}

// The merged feed's structural records carry their facts at the top level
// (phase, verdict, failed, terminal_reason …); these are copied into `detail`
// verbatim for the row renderer. Absent fields are omitted, never zeroed.
const LIFTED_FIELDS = {
  "gate.result": ["id", "status", "phase", "duration_ms"],
  "run.start": ["task"],
  "cell.start": ["arm", "model", "session_id", "serve_host_port", "serve_url"],
  "phase.start": ["phase"],
  "attempt.end": ["attempt", "verdict", "conformed", "failed"],
  "cell.end": ["verdict", "terminal_reason"],
};

function liftDetail(rec) {
  const keys = LIFTED_FIELDS[rec?.kind];
  if (!keys) return rec?.detail ?? rec?.data ?? null;
  const detail = {};
  for (const key of keys) {
    if (rec[key] !== null && rec[key] !== undefined) detail[key] = rec[key];
  }
  // Nothing named: fall back to whatever the record carried.
  return Object.keys(detail).length ? detail : (rec?.detail ?? rec?.data ?? null);
}

/** One record → one row, shared by the feed and the error log. */
function toRow(rec) {
  return {
    ts: Number(rec.ts) || 0,
    kind: rec.kind,
    source: rowSource(rec),
    level: rowLevel(rec),
    event: typeof rec.event === "string" ? rec.event : (rec.type ?? null),
    attempt: Number.isFinite(rec.attempt) ? rec.attempt : null,
    detail: liftDetail(rec),
  };
}

/**
 * The merged feed for one run (run_dir resolved by the caller, like every other
 * run-scoped route). The live half is pinned to exactly one cell by
 * `sequenceIndex`; without it there is NO live half — an unkeyed request never
 * falls back to "newest cell by mtime", which with N cells in flight silently
 * shows a stream nobody asked for. The notices half (logPath) is run-scoped
 * and unaffected by the key.
 */
export async function readBackendFeed({ runsRoot, runDir, logPath, sequenceIndex = null, complete = false }) {
  let livePath = null;
  if (runDir && sequenceIndex != null) {
    // Pinned to exactly this cell's stream, or none.
    const cell = await cellDirForRun(runsRoot, runDir, sequenceIndex);
    livePath = cell ? join(runsRoot, cell.cellDir, "live.jsonl") : null;
  }
  const noticePath = logPath ? noticesPathFor(logPath) : null;

  const [live, notices, liveErrors, noticeErrors] = await Promise.all([
    readStreamTail(livePath, { complete }),
    readStreamTail(noticePath, { complete }),
    scanErrors(livePath),
    scanErrors(noticePath),
  ]);

  const merged = [...live.rows, ...notices.rows]
    .filter((rec) => !NOT_ACTIVITY.has(rec.kind))
    .map(toRow)
    // Oldest first, like the event feed.
    .sort((a, b) => a.ts - b.ts);

  // Trim from the top, keeping the newest, and say so.
  const total = merged.length;
  // The row cap applies to the live feed only.
  const rows = !complete && total > FEED_MAX_ROWS ? merged.slice(total - FEED_MAX_ROWS) : merged;

  // The complete error log, oldest first, shaped like feed rows.
  const errors = [...liveErrors, ...noticeErrors]
    .map(toRow)
    .sort((a, b) => a.ts - b.ts);

  return {
    ok: true,
    rows,
    total,
    returned: rows.length,
    // Never windowed.
    errors,
    errors_total: errors.length,
    // Which streams answered: a missing half and a quiet half are different facts.
    sources: {
      live: { attached: live.ok, path: livePath ? true : false },
      notices: { attached: notices.ok, path: noticePath ? true : false },
    },
    // Whether records exist that this response could not see (never true of a
    // complete read).
    windowed: !complete && (live.bytes > FEED_TAIL_BYTES || notices.bytes > FEED_TAIL_BYTES),
    complete: Boolean(complete),
  };
}
