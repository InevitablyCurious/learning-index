// ─────────────────────────────────────────────────────────────────────────────
// BROADCAST + THE PUSH LOOP — per-section digests, patch assembly, tick.
//
// Extracted from server.mjs (WO LI-13). The wire protocol (SSE) and the
// rationale for it live in server.mjs, which owns the /api/stream route; this
// module owns what is pushed AFTER connect. Import-safe: top level is
// declarations only.
// ─────────────────────────────────────────────────────────────────────────────

import { getBoard } from "./board-build.mjs";
import { streamClients } from "./state.mjs";

/**
 * Broadcast a named SSE frame to every attached client.
 *
 * A client whose socket has gone away is dropped rather than written to — a
 * dead client must never be able to wedge the broadcast loop.
 */
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
 * The board minus the event ring.
 *
 * Events are streamed separately and incrementally, so shipping them inside the
 * board payload too would reintroduce exactly the redundancy this exists to
 * remove. The ring's METADATA (counts, connected, cursor, grading) is kept —
 * it is small, it changes meaningfully, and the feed header renders from it.
 */
export function boardWithoutEvents(board) {
  const { events, ...rest } = board;
  if (!events) return { ...rest, events: null };
  const { events: _rows, ...meta } = events;
  return { ...rest, events: { ...meta, events: [] } };
}

// Pushes are decided by per-section digests — see `granularSignatures` below.

/**
 * Split a section into its own sub-sections when it is large and only a small
 * part of it moves.
 *
 * ── MEASURED, NOT ASSUMED (2026-08-13) ─────────────────────────────────────
 *
 * After sectioning, patches were still 7.4KB every 2s. Of that, `control` was
 * 6,535 bytes — and the only thing that changed between consecutive patches
 * was a clock nested inside `control.run`. The static 6KB of capabilities and
 * roster rode along on every tick.
 *
 * `control` is the one section big enough and heterogeneous enough to be worth
 * splitting: `capabilities` and `roster` are effectively static for the life of
 * a run, while `run` ticks constantly. Splitting it means a ticking clock costs
 * its own ~300 bytes instead of dragging 6KB of unchanged roster with it.
 *
 * Nothing else is split. A section that is small (`run` at 485b) or that
 * changes as a whole gains nothing from finer granularity, and every split adds
 * a merge rule the client has to honour — complexity that must be paid for by a
 * measurement, not by a guess.
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
      // The named children each get their own digest; whatever remains is
      // digested together so no field can be silently dropped from the wire.
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

// ── THE PUSH LOOP ────────────────────────────────────────────────────────────
//
// The server polls the SOURCES on the same cadence the browser used to, but
// it does so ONCE for every attached client and pushes only what changed.
// That is the whole win: the sources are files and a local HTTP service, so
// something must read them on an interval — the defect was never the polling,
// it was that every browser refetched 240KB of mostly-identical payload and
// rebuilt the board from it.
//
// ONLY CHANGED SECTIONS ARE SENT. Per-section digests (see
// granularSignatures) mean a ticking `run.elapsed_s` costs 486 bytes rather
// than re-sending the 12.4KB TUI screen beside it. A quiet run costs one
// heartbeat comment every 15s and nothing else.
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
    // First tick with a client attached: they were already sent a full board
    // on connect, so this only primes the comparison.
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
    // A section that DISAPPEARED is a real change and must reach the client,
    // otherwise a panel keeps rendering state the server no longer has.
    for (const k of Object.keys(lastSections)) {
      if (!(k in sections)) {
        patch[k] = null;
        changed += 1;
      }
    }
    lastSections = sections;

    if (changed) {
      // THE TUI IS OWNED BY THE FAST PATH. It is dropped from the slow
      // patch entirely: the board loop reads a value that is already up to
      // 2s stale by the time it assembles, so letting it through would
      // overwrite a fresh 250ms frame with an older one and make the mirror
      // stutter backwards. One writer per section.
      delete patch.tui;
      if (!Object.keys(patch).length) return;
      broadcast("patch", patch);
    }
  }

  // Per-client event deltas. Each client is at its own cursor, so this is a
  // per-socket write rather than a broadcast.
  const rows = board.events?.events ?? [];
  const cursor = board.events?.cursor ?? null;
  for (const res of [...streamClients]) {
    let since = res.okpCursor ?? 0;
    // Same restart signature as the connect path: a per-client cursor AHEAD
    // of the ring's own high-water mark is stale from before a re-base, so
    // replay the full window from scratch.
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

  // A comment frame keeps intermediaries from reaping an idle connection.
  // It is not data and the client ignores it — but its ABSENCE is how a
  // silent board becomes a dead board behind a proxy.
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
