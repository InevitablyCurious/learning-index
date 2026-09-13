// ── BACKEND FEED — what the MACHINERY is doing, merged from every process ────
//
// ── THE GAP ─────────────────────────────────────────────────────────────────
//
// The EVENT FEED shows the AGENT, proxied from the worker's `opencode serve`
// stream. Nothing showed the SYSTEM. And between attempts the agent is idle by
// design, so the one feed on screen correctly goes silent in exactly the window
// where an operator has no other signal — the window in which a cell can spend
// forty minutes grading, or wedge, and look identical either way.
//
// ── WHY NOT TAIL THE LOG ────────────────────────────────────────────────────
//
// `gate-events.mjs` — the closest thing to this that exists — reads the
// harness's stdout and recovers events with a regex, deduping because every
// PROGRESS line is emitted twice. Every fact it reconstructs that way is one a
// producer could simply have stated. This reads RECORDS, written by the
// processes themselves, and parses nothing out of prose.
//
// ── TWO FILES, ONE ORDERED VIEW ─────────────────────────────────────────────
//
//   the cell's `live.jsonl`     cell-scoped: the harness's phases and gates, the
//                               gate runner's notices, and any backend `ext`
//   `<log>.notices.jsonl`       run-scoped: the control plane and the campaign
//                               layer, whose facts outlive any one cell
//
// They are separate because their facts have different LIFETIMES (a cell's
// stream dies with the cell's tree), and merged here because an operator asking
// "what is happening" does not care which process holds the pen. Ordered by
// `ts`, which every record on both streams carries in the same units.
//
// ── BOUNDED, AND SAYING SO ──────────────────────────────────────────────────
//
// Both files grow without limit — `live.jsonl` carries every gate result of
// every attempt. This reads the TAIL of each, never the file, and reports what
// it could not see (`windowed`) rather than presenting a slice as the whole.
// That is `events.mjs`'s rule: the cap is reported, never applied silently.
//
// ── READ-ONLY, AND NEVER THE REASON A RUN FAILS ─────────────────────────────
//
// It opens two files for reading. A missing, unreadable or half-written stream
// yields fewer rows and a stated reason — never an exception, and never a
// failed request.

import { readFile, open, stat } from "node:fs/promises";
import { join } from "node:path";

import { liveStreamPath } from "../dashboard/sources/_runtime.mjs";
import { noticesPathFor } from "./notices.mjs";
import { cellDirForRun } from "./runstate.mjs";

/**
 * How much of each stream's tail to read.
 *
 * Sized for the busy case: `live.jsonl` carries one `gate.result` per gate per
 * attempt — 53 gates × 5 attempts on the reference task — and a notice is a
 * short record. 256KB reaches well past a full cell's notices while staying a
 * cheap read on every poll.
 */
export const FEED_TAIL_BYTES = 256 * 1024;

/** Rows returned at most, newest kept. */
export const FEED_MAX_ROWS = 600;

/**
 * Records that describe the RUN's shape rather than a process's activity.
 *
 * `heartbeat` is the loud one: it fires every 15 seconds for the life of a
 * cell, so on a three-hour cell it is 720 rows that all say the same thing. It
 * is the liveness signal and the chrome already renders it; repeating it here
 * would bury every record that carries information under one that does not.
 */
const NOT_ACTIVITY = new Set(["heartbeat"]);

/**
 * Read the tail of one stream and parse what is whole.
 *
 * A FIRST LINE SLICED MID-RECORD IS EXPECTED, not exceptional — the tail starts
 * at a byte offset, not a line boundary. It fails to parse and is skipped,
 * which is why this tolerates junk rather than trusting the split.
 */
async function readStreamTail(path, { complete = false } = {}) {
  if (!path) return { rows: [], bytes: 0, ok: false };
  let text;
  let bytes = 0;
  try {
    const buf = await readFile(path);
    bytes = buf.length;
    // COMPLETE FOR A FINISHED CELL. The tail exists because a LIVE stream grows
    // without bound and the recent end is what matters. A concluded cell's file
    // is finite and done, and windowing it hides the beginning of the run — the
    // build phases, the cell's own start — which is exactly what an operator
    // reviewing a finished run opened it to see. Measured: a 310KB live.jsonl
    // against a 256KB window cut the first 1h44m of a 2h19m cell.
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
 * WHICH CHIP A ROW BELONGS TO — derived once, here, for all three row shapes.
 *
 * A merged feed carries three, and they name their origin differently:
 *
 *   `notice`   carries `source` — the process that spoke
 *   `ext`      carries `ns` — a BACKEND's namespace, opaque to the benchmark
 *   core kinds carry neither: `gate.result`, `phase.start` and the rest are the
 *              harness's own record of the run
 *
 * Deriving this in one place is what lets an `ext` lane appear later without
 * reworking the chip row — a backend joins the stream through
 * `BENCH_LIVE_STREAM`, and if it is ever wired into the CELL its records arrive
 * here already carrying a chip.
 *
 * AN EXTERNAL NAMESPACE IS NEVER FLATTENED INTO A NATIVE SOURCE. `okp.plugin`
 * stays `okp.plugin`; folding it into `harness` would put a backend's telemetry
 * under the benchmark's name, which is the attribution rule that keeps the two
 * distinguishable in a merged list.
 */
export function rowSource(rec) {
  if (rec.kind === "notice" && typeof rec.source === "string") return rec.source;
  if (rec.kind === "ext" && typeof rec.ns === "string") return rec.ns;
  return "harness";
}

/**
 * SEVERITY. Only a `notice` states one; every other record is the run
 * proceeding normally and reads as `info`. Inferring severity from a core kind
 * — treating a failing `gate.result` as an error, say — would conflate the
 * CANDIDATE failing (the measurement working) with the INSTRUMENT failing
 * (the measurement lost), which is the distinction this whole surface exists
 * to keep.
 */
export function rowLevel(rec) {
  return rec.kind === "notice" && typeof rec.level === "string" ? rec.level : "info";
}

// ── THE ERROR LOG — COMPLETE, WHERE THE FEED IS WINDOWED ────────────────────
//
// THE PROBLEM WITH READING A TAIL. The feed reads the last 256KB of each stream,
// which is right for activity: an operator watching a run wants what just
// happened, and an unbounded read on every poll is a cost with no reader. But
// the same window silently drops OLD errors — and an error from three hours ago
// is exactly the record someone reviewing a finished run came for. "Older
// records exist beyond the window" is an honest thing to say about activity and
// a useless thing to say about failures.
//
// SO ERRORS ARE NEVER WINDOWED. Every error-level record in the run is kept,
// from the first byte, however long the run has been going.
//
// AND THE COST IS BOUNDED ANYWAY, because these files are APPEND-ONLY. The scan
// remembers how far into each file it has read and, on the next poll, reads only
// what was added. A poll that finds the file unchanged reads nothing at all. A
// file that got SHORTER was replaced (a reset, a new campaign in the same
// location), so the scan starts over rather than trusting an offset into a file
// that no longer exists.
//
// A CHEAP REJECT BEFORE THE PARSE. Most lines on a busy stream are gate results;
// only a `notice` can carry a level, so a substring test skips the parse for
// nearly every line.
const errorScans = new Map();

async function scanErrors(path) {
  if (!path) return [];
  let size;
  try {
    size = (await stat(path)).size;
  } catch {
    // A stream that cannot be read now must not discard what it already told
    // us: the run's earlier errors are still true.
    return errorScans.get(path)?.errors ?? [];
  }

  const prior = errorScans.get(path);
  // SHORTER THAN LAST TIME means a different file wearing the same name.
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
      // Keep what we have and try again next poll.
      return errors;
    }
  }

  errorScans.set(path, { size, errors });
  return errors;
}

/**
 * The merged feed for one run.
 *
 * `run_dir` is resolved by the caller — the same resolution every other
 * run-scoped route uses, so this can never disagree with the board about which
 * run is on screen.
 *
 * `sequenceIndex` is OPTIONAL. Without it the live half resolves to the NEWEST
 * cell's stream, which is right for a run in progress and wrong for a board
 * viewing one particular cell of a finished run. With it, the live half is
 * PINNED to exactly that cell's `live.jsonl` — and a cell that does not resolve
 * degrades to "live not attached", never to a different cell's stream.
 */
// ── THE PRODUCERS PUT THEIR FACTS AT THE TOP LEVEL ──────────────────────────
//
// Every structural record in `live.jsonl` carries what it is about beside its
// kind, not nested under a `detail` object: a `phase.start` has `phase`, an
// `attempt.end` has `verdict` and `failed`, a `cell.end` has `terminal_reason`.
// The row renderer reads ONE field (`detail`), so without this every one of them
// rendered as a bare kind name with an empty line beside it — a birds-eye view
// of a run that could not say which phase started or how an attempt ended.
//
// LIFTING IS PASS-THROUGH, NOT DERIVATION. Named keys are copied verbatim; a
// null or absent one is OMITTED rather than rendered, because absence is a state
// and a `0` invented for it is a measurement that was never taken.
const LIFTED_FIELDS = {
  "gate.result": ["id", "status", "phase", "duration_ms"],
  "run.start": ["task"],
  "cell.start": ["arm", "model", "session_id"],
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
  // A record whose named fields are all absent falls back to whatever it did
  // carry, so a producer that changes shape degrades to "shows something" rather
  // than to a blank row.
  return Object.keys(detail).length ? detail : (rec?.detail ?? rec?.data ?? null);
}

/**
 * One record → one row. ONE mapping, used by both the feed and the error log,
 * so the two can never describe the same record differently.
 */
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

export async function readBackendFeed({ runsRoot, runDir, logPath, sequenceIndex = null, complete = false }) {
  let livePath = null;
  if (runDir) {
    if (sequenceIndex != null) {
      // PINNED: exactly this cell's stream, or nothing. cellDirForRun returns
      // null when no arm holds the cell, and null degrades to "live not
      // attached" downstream — never to a different cell's records.
      const cell = await cellDirForRun(runsRoot, runDir, sequenceIndex);
      livePath = cell ? join(runsRoot, cell.cellDir, "live.jsonl") : null;
    } else {
      livePath = await liveStreamPath(join(runsRoot, runDir)).catch(() => null);
    }
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
    // OLDEST FIRST, matching the event feed beside it. A reader should not have
    // to reverse their reading direction to move between two feeds on one card.
    .sort((a, b) => a.ts - b.ts);

  // TRIM FROM THE TOP, keeping the newest — and say that it happened. A slice
  // presented as the whole is the defect the ring buffer's `total` vs
  // `returned` reporting exists to prevent.
  const total = merged.length;
  // THE ROW CAP IS A LIVE-FEED DEVICE TOO, and it is lifted for the same reason
  // the byte window is: a finished cell has a finite record set and the operator
  // came for all of it.
  const rows = !complete && total > FEED_MAX_ROWS ? merged.slice(total - FEED_MAX_ROWS) : merged;

  // THE COMPLETE ERROR LOG, oldest first, across both streams. Shaped exactly
  // like a feed row so one renderer draws either and a reader learns one shape.
  const errors = [...liveErrors, ...noticeErrors]
    .map(toRow)
    .sort((a, b) => a.ts - b.ts);

  return {
    ok: true,
    rows,
    total,
    returned: rows.length,
    // NEVER WINDOWED, unlike `rows`. An operator reviewing a finished run needs
    // the error from three hours ago, which is precisely what the tail drops.
    errors,
    errors_total: errors.length,
    // WHICH STREAMS ANSWERED. A feed missing the control plane's half and a
    // quiet control plane are different facts; without this they render the
    // same, which is the failure mode every surface here is built against.
    sources: {
      live: { attached: live.ok, path: livePath ? true : false },
      notices: { attached: notices.ok, path: noticePath ? true : false },
    },
    // Whether either stream was longer than the window read.
    // FALSE when the whole file was read, whatever its size — `windowed` means
    // "records exist that this response could not see", which is never true of
    // a complete read.
    windowed: !complete && (live.bytes > FEED_TAIL_BYTES || notices.bytes > FEED_TAIL_BYTES),
    complete: Boolean(complete),
  };
}
