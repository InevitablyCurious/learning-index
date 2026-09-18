// BROADCAST + THE PUSH LOOP — what is pushed to /api/stream clients after
// connect (the route is routes/board.mjs). Import-safe.

import { getBoard } from "./board-build.mjs";
import { streamClients } from "./state.mjs";

/** Send a named SSE frame to every client; a dead socket is dropped. */
function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...streamClients]) {
    try {
      if (res.writableEnded) streamClients.delete(res);
      else res.write(frame);
    } catch {
      streamClients.delete(res);
    }
  }
}

/**
 * The board minus the event rows (streamed separately as deltas); the ring's
 * metadata is kept.
 */
export function boardWithoutEvents(board) {
  const { events, ...rest } = board;
  if (!events) return { ...rest, events: null };
  const { events: _rows, ...meta } = events;
  return { ...rest, events: { ...meta, events: [] } };
}

/**
 * Sections split into sub-sections: `control` is ~6.5KB of static capabilities
 * and roster around a clock in `run`, so its children are digested separately.
 * Nothing else is split (each split is a merge rule the client must honour).
 */
const SPLIT_SECTIONS = { control: ["capabilities", "roster", "run", "notes"] };

/** Flatten split sections into `parent.child` keys; leave everything else. */
export function granularSignatures(board) {
  const b = boardWithoutEvents(board);
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === "generated_at") continue;
    if (k === "sources") {
      out[k] = JSON.stringify((v ?? []).map((s) => ({ id: s.id, ok: s.ok, reason: s.reason })));
      continue;
    }
    const split = SPLIT_SECTIONS[k];
    if (split && v && typeof v === "object" && !Array.isArray(v)) {
      // Whatever isn't split out is digested together, so no field is dropped.
      const rest = { ...v };
      for (const child of split) {
        if (child in v) {
          out[`${k}.${child}`] = JSON.stringify(v[child] ?? null);
          delete rest[child];
        }
      }
      out[`${k}.__rest`] = JSON.stringify(rest);
      continue;
    }
    out[k] = JSON.stringify(v ?? null);
  }
  return out;
}

// ── THE PUSH LOOP ── the sources are read once for all clients and only
// changed sections are pushed (a ticking clock costs a few hundred bytes).
let lastSections = null;
let lastHeartbeat = 0;

export async function tick(cfg) {
  if (!streamClients.size) return; // nobody attached: do no work at all
  let board;
  try {
    board = await getBoard(cfg);
  } catch (err) {
    broadcast("error", { reason: String(err?.message ?? err) });
    return;
  }

  const sections = granularSignatures(board);
  if (lastSections === null) {
    // First tick with a client: it already got the full board on connect.
    lastSections = sections;
  } else {
    const patch = {};
    let changed = 0;
    for (const [k, sig] of Object.entries(sections)) {
      if (lastSections[k] !== sig) {
        patch[k] = JSON.parse(sig);
        changed += 1;
      }
    }
    // A section that disappeared is sent (as null).
    for (const k of Object.keys(lastSections)) {
      if (!(k in sections)) {
        patch[k] = null;
        changed += 1;
      }
    }
    lastSections = sections;

    if (changed) {
      // The TUI section belongs to the fast path; this slower copy would overwrite a
      // newer frame.
      delete patch.tui;
      if (!Object.keys(patch).length) return;
      broadcast("patch", patch);
    }
  }

  // Event deltas per client, each at its own cursor.
  const rows = board.events?.events ?? [];
  const cursor = board.events?.cursor ?? null;
  for (const res of [...streamClients]) {
    let since = res.okpCursor ?? 0;
    // A cursor ahead of the ring is stale from a restart: replay from scratch.
    if (typeof cursor === "number" && since > cursor) since = 0;
    const fresh = rows.filter((e) => (e.seq ?? -1) > since);
    if (!fresh.length) continue;
    res.okpCursor = fresh[fresh.length - 1].seq ?? since;
    try {
      res.write(`event: events\ndata: ${JSON.stringify({ events: fresh, cursor })}\n\n`);
    } catch {
      streamClients.delete(res);
    }
  }

  // A heartbeat comment keeps proxies from reaping an idle connection.
  const now = Date.now();
  if (now - lastHeartbeat >= 15000) {
    lastHeartbeat = now;
    for (const res of [...streamClients]) {
      try {
        res.write(`: heartbeat ${now}\n\n`);
      } catch {
        streamClients.delete(res);
      }
    }
  }
}
