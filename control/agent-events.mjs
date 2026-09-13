import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cellSessionId } from "./runstate.mjs";

// The per-run agent-event transcript. Append-only, one BoardEvent JSON object
// per line, discoverable from run_dir alone (deterministic path, no walking).
export const AGENT_EVENTS_FILENAME = "agent-events.jsonl";

export function agentEventsPath(runsRoot, runDir) {
  return join(runsRoot, runDir, AGENT_EVENTS_FILENAME);
}

// Append rows (already-mapped BoardEvent objects incl. seq) as one JSON line each.
export async function appendAgentEvents(path, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  const lines = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await appendFile(path, lines, "utf8");
}

// Read a past run's persisted agent events. Tolerant of a torn/half-written last
// line (a crash mid-append is expected). Returns rows in file (arrival) order.
export async function readAgentEvents({ runsRoot, runDir, since = 0, limit = null, sequenceIndex = null }) {
  let sid = null;
  if (sequenceIndex != null) {
    sid = await cellSessionId(runsRoot, runDir, sequenceIndex);
    if (sid == null) return { ok: true, rows: [], total: 0, returned: 0, cursor: 0, attached: false, path: null };
  }
  const path = agentEventsPath(runsRoot, runDir);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { ok: true, rows: [], total: 0, returned: 0, cursor: 0, attached: false, path };
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object") rows.push(v);
    } catch {
      // torn tail line — expected, skipped
    }
  }
  const cellRows = sequenceIndex != null ? rows.filter((r) => r.session_id === sid) : rows;
  const sinceNum = Number(since) || 0;
  const filtered = sinceNum > 0 ? cellRows.filter((r) => typeof r.seq === "number" && r.seq > sinceNum) : cellRows;
  const total = filtered.length;
  const capped = limit !== null && Number.isFinite(Number(limit)) && Number(limit) > 0
    ? filtered.slice(total > Number(limit) ? total - Number(limit) : 0)
    : filtered;
  const cursor = filtered.length ? (typeof filtered[filtered.length - 1].seq === "number" ? filtered[filtered.length - 1].seq : total) : 0;
  return { ok: true, rows: capped, total, returned: capped.length, cursor, attached: true, path, counts: tallyKinds(capped) };
}

/**
 * HOW MANY OF EACH KIND ARE IN THE ROWS BEING SERVED.
 *
 * The persisted branch used to answer the live shape with every count ZEROED,
 * which is not "no data" — it is a wrong number beside a populated list. The
 * board draws its event-kind filter chips from these counts, so a concluded run
 * rendered `tool 0 · file 0 · error 0` over four thousand rows, and an operator
 * filtering for errors had no way to see there were any.
 *
 * COUNTED OVER WHAT IS RETURNED, not over the whole file: the chips label the
 * list beneath them, and a count of rows the caller did not get is a count of
 * something the reader cannot look at.
 */
function tallyKinds(rows) {
  const counts = { tool: 0, file: 0, thinking: 0, error: 0, lifecycle: 0, harness: 0, user: 0 };
  for (const r of rows) {
    if (Object.prototype.hasOwnProperty.call(counts, r?.kind)) counts[r.kind] += 1;
  }
  return counts;
}

// Buffered sink the server injects into the ring: every pushed agent event is
// enqueued and flushed (appended to the active run's agent-events.jsonl) on a
// timer. `getRunDir` is an async () => activeRunDir()-style resolver supplied by
// the caller; rows are held (not dropped, not mis-filed) until a run is known.
const PENDING_MAX = 2000; // mirrors EVENT_RING_MAX; bounds memory if no run is active
export function createAgentEventSink({ runsRoot, getRunDir }) {
  let pending = [];
  let flushing = false;
  return {
    enqueue(row) {
      pending.push(row);
      if (pending.length > PENDING_MAX) pending.splice(0, pending.length - PENDING_MAX);
    },
    async flush() {
      if (flushing) return;
      if (!pending.length) return;
      flushing = true;
      try {
        let runDir = null;
        try { runDir = await getRunDir(); } catch { runDir = null; }
        if (!runDir) return; // no active run yet — hold, do not drop or mis-file
        const rows = pending;
        pending = [];
        try {
          await appendAgentEvents(agentEventsPath(runsRoot, runDir), rows);
        } catch {
          // restore on failure so the rows are not silently lost; retried next flush
          pending = rows.concat(pending);
        }
      } finally {
        flushing = false;
      }
    },
    drop() { pending = []; },
  };
}
