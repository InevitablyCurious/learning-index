// EVENT PROXY — subscribes to the worker's `opencode serve` GET /event and
// re-publishes a mapped, bounded view to the board. Proxied rather than read by
// the browser: retention is capped here (and reported), the serve's restarts are
// absorbed with backoff and reported as state, and the harness's observation
// channel has one predictable reader.
//
// Read-only against the serve: it never posts, aborts or summarises. A control
// plane that could inject a turn could corrupt the measurement it displays.

import { EVENT_MAP, EVENT_IGNORED, PART_KIND, EVENT_TEXT_MAX, EVENT_RING_MAX } from "./contract.mjs";

/**
 * Grading rows (`user` prompts, `harness` activity) are pinned in the ring,
 * never evicted: the filter chips count the whole ring, and these low-volume
 * rows arrive early, so plain eviction would drop them first.
 */
export const GRADING_KINDS = new Set(["user", "harness"]);

/** Truncate payload text and report whether it was cut. Never silently. */
function clipText(s) {
  const t = String(s ?? "");
  if (!t) return { text: null, truncated: false };
  if (t.length <= EVENT_TEXT_MAX) return { text: t, truncated: false };
  return { text: t.slice(0, EVENT_TEXT_MAX), truncated: true };
}

/**
 * Map one upstream event to the board shape; null for an unmapped type (the
 * caller counts those).
 */
export function mapEvent(raw) {
  const type = typeof raw?.type === "string" ? raw.type : null;
  if (!type) return null;
  if (EVENT_IGNORED.has(type)) return null;
  const envelopeKind = EVENT_MAP[type];
  if (!envelopeKind) return null;

  const p = raw.properties ?? {};
  const base = {
    id: typeof raw.id === "string" ? raw.id : null,
    kind: envelopeKind,
    type,
    at: null,
    session_id: typeof p.sessionID === "string" ? p.sessionID : null,
    tool: null,
    file: null,
    name: null,
    detail: null,
    text: null,
    truncated: false,
  };

  switch (type) {
    // The Part's own type (tool, reasoning, step…) decides the kind.
    case "message.part.updated":
      return fromPart(base, p.part, p.time);

    case "file.edited":
      base.name = "edit";
      base.file = typeof p.file === "string" ? p.file : null;
      base.detail = base.file;
      return base;

    case "session.error":
      base.kind = "error";
      base.name = "error";
      Object.assign(base, clipText(errorText(p.error)));
      base.detail = base.text;
      return base;

    case "session.idle":
      base.name = "idle";
      base.detail = "session went idle";
      return base;

    case "session.compacted":
      base.name = "compacted";
      base.detail = "context compacted";
      return base;

    // Only when it actually carries a status.
    case "session.status": {
      const s = typeof p.status === "string" ? p.status : null;
      if (!s) return null;
      base.name = "status";
      Object.assign(base, clipText(s));
      base.detail = base.text;
      return base;
    }

    default:
      return null;
  }
}

/**
 * A `message.part.updated` → a feed row by Part type. null for `text` (it
 * belongs to the transcript) and for unknown types (counted as unmapped).
 */
function fromPart(base, part, time) {
  if (!part || typeof part !== "object") return null;
  const pt = typeof part.type === "string" ? part.type : null;
  const kind = pt ? PART_KIND[pt] : null;
  if (!kind) return null;

  base.kind = kind;
  base.type = `${base.type}:${pt}`;
  base.id = typeof part.id === "string" ? part.id : base.id;
  base.session_id = typeof part.sessionID === "string" ? part.sessionID : base.session_id;
  base.at = partTime(part, time);

  switch (pt) {
    case "tool": {
      base.tool = typeof part.tool === "string" ? part.tool : null;
      base.name = base.tool ?? "tool";
      const st = part.state ?? {};
      const status = typeof st.status === "string" ? st.status : null;

      // A failed tool call is an error row.
      if (status === "error") {
        base.kind = "error";
        Object.assign(base, clipText(errorText(st.error) ?? "tool failed"));
        base.detail = base.text;
        return base;
      }

      // Tool input is summarised, never dumped (it can hold a whole file).
      const summary = summariseInput(st.input);
      Object.assign(base, clipText(summary));
      base.detail = [status, base.text].filter(Boolean).join(" · ") || status;
      return base;
    }

    case "reasoning": {
      // Completed reasoning parts are often empty; duration is the signal.
      const ms = spanMs(part.time);
      base.name = "thinking";
      base.detail = ms == null ? "reasoning" : `reasoning ${Math.round(ms / 1000)}s`;
      return base;
    }

    case "patch": {
      const files = Array.isArray(part.files) ? part.files : [];
      base.name = "patch";
      base.file = files[0] ?? null;
      base.detail = files.length
        ? (files.length === 1 ? files[0] : `${files.length} files · ${files[0]}`)
        : "patch";
      return base;
    }

    case "step-start":
      base.name = "step";
      base.detail = "step started";
      return base;

    case "step-finish": {
      const t = part.tokens ?? {};
      const bits = [];
      if (typeof part.reason === "string") bits.push(part.reason);
      if (Number.isFinite(t.input)) bits.push(`in ${t.input}`);
      if (Number.isFinite(t.output)) bits.push(`out ${t.output}`);
      if (Number.isFinite(t.reasoning)) bits.push(`think ${t.reasoning}`);
      base.name = "step";
      base.detail = bits.join(" · ") || "step finished";
      return base;
    }

    default:
      return null;
  }
}

/**
 * Event time from the part or the envelope; null rather than a made-up
 * received-at time.
 */
function partTime(part, envelopeTime) {
  const t = part?.time;
  if (t && typeof t === "object") {
    if (Number.isFinite(t.end)) return t.end;
    if (Number.isFinite(t.start)) return t.start;
  }
  if (Number.isFinite(envelopeTime)) return envelopeTime;
  return null;
}

function spanMs(t) {
  if (!t || typeof t !== "object") return null;
  if (!Number.isFinite(t.start)) return null;
  if (!Number.isFinite(t.end)) return null;
  return t.end - t.start;
}

/** Pull a human string out of the several error shapes upstream emits. */
function errorText(err) {
  if (!err) return null;
  if (typeof err === "string") return err;
  return (
    err?.data?.message ??
    err?.message ??
    err?.name ??
    null
  );
}

/**
 * Summarise a tool input: a `write` input is a whole file (noise, and a
 * disclosure risk on a public stream).
 */
function summariseInput(input) {
  if (!input || typeof input !== "object") return null;
  for (const key of ["filePath", "file_path", "path", "pattern", "command", "query"]) {
    const v = input[key];
    if (typeof v === "string" && v) return v;
  }
  const keys = Object.keys(input);
  return keys.length ? `${keys.length} arg${keys.length === 1 ? "" : "s"}` : null;
}

/**
 * A bounded ring of mapped events plus connection state. `total` and
 * `unmapped` are exposed so the board can say "showing last N of M".
 */
export class EventRing {
  constructor(max = EVENT_RING_MAX) {
    this.max = max;
    this.items = [];
    this.total = 0;
    this.unmapped = 0;
    this.seq = 0;
    this.connected = false;
    this.reason = null;
    this.connected_at = null;
    this.last_event_at = null;
    this.sink = null;
  }

  /** Evict oldest-first, but never a grading row. */
  _trim() {
    let excess = this.items.length - this.max;
    if (excess <= 0) return;
    const kept = [];
    for (const e of this.items) {
      if (excess > 0 && !GRADING_KINDS.has(e.kind)) excess -= 1;
      else kept.push(e);
    }
    this.items = kept;
  }

  /**
   * Clear rows and the dedup set when the active run changes, keeping `seq`
   * monotonic so an old client cursor never moves backwards. Grading rows come
   * back from files on the next poll.
   */
  reset() {
    this.items = [];
    this.admitted = new Set();
  }

  push(raw) {
    this.total += 1;
    const ev = mapEvent(raw);
    if (!ev) {
      this.unmapped += 1;
      return null;
    }
    this.seq += 1;
    // seq counts mapped events only; `capped` is judged against it (unmapped
    // frames are not data loss).
    ev.seq = this.seq;
    this.last_event_at = Date.now();
    this.items.push(ev);
    this._trim();
    this.sink?.enqueue(ev);
    return ev;
  }

  /**
   * Append an already-mapped agent row without dedup: a persisted transcript's
   * streaming parts legitimately repeat an id (deduping collapsed 4,312 rows to
   * 2,116). Only the file-rebuilt families (admit) dedupe.
   */
  append(ev) {
    if (!ev || typeof ev !== "object") return null;
    this.seq += 1;
    const row = { ...ev, seq: this.seq };
    this.last_event_at = Date.now();
    this.items.push(row);
    this._trim();
    return row;
  }

  /**
   * Admit an already-mapped row once, by id. Grading rows and prompts are rebuilt
   * from files every poll; admitting them once gives each a stable seq from the
   * ring's own counter (numbering them per request re-appended the same row every
   * poll). A row with no id is refused. Returns the row, or null.
   */
  admit(ev) {
    if (!ev || typeof ev.id !== "string" || ev.id.length === 0) return null;
    if (this.admitted === undefined) this.admitted = new Set();
    if (this.admitted.has(ev.id)) return null;
    this.admitted.add(ev.id);

    this.seq += 1;
    const row = { ...ev, seq: this.seq };
    this.last_event_at = Date.now();
    this.items.push(row);
    this._trim();
    return row;
  }

  /**
   * A window of the ring, oldest first (a transcript reads top to bottom), plus
   * counters. `counts` covers the whole ring, not the returned slice, so a filter
   * never hides its own count.
   */
  snapshot({ limit = 100, kinds = null, since = 0 } = {}) {
    const counts = { tool: 0, file: 0, thinking: 0, error: 0, lifecycle: 0 };
    for (const e of this.items) {
      if (counts[e.kind] !== undefined) counts[e.kind] += 1;
    }

    let rows = this.items;
    if (kinds && kinds.length) rows = rows.filter((e) => kinds.includes(e.kind));
    if (since > 0) rows = rows.filter((e) => e.seq > since);

    // The most recent `limit`, in chronological order.
    const returned = rows.slice(-limit);
    const filtered = kinds && kinds.length;

    return {
      connected: this.connected,
      reason: this.reason,
      connected_at: this.connected_at,
      last_event_at: this.last_event_at,
      order: "oldest_first",
      // How long since anything arrived.
      idle_s: this.last_event_at
        ? Math.round((Date.now() - this.last_event_at) / 1000)
        : null,
      events: returned,
      counts,
      returned: returned.length,
      retained: this.items.length,
      // `total` = every frame; `mapped` = renderable ones.
      total: this.total,
      mapped: this.seq,
      unmapped: this.unmapped,
      // `capped`: the ring dropped mapped events (real loss). `windowed`: this
      // response returned fewer than the ring holds (paging). Stated differently.
      capped: this.seq > this.items.length,
      windowed: rows.length > returned.length,
      hidden_by_filter: filtered ? this.items.length - rows.length : 0,
      max: this.max,
      cursor: this.seq,
    };
  }
}

/**
 * Merge pinned grading rows a delivery window left behind back into a
 * snapshot, so a fresh connect delivers the rows the chips count. Sorted by seq.
 * Pure.
 */
export function mergeGrading(events, items) {
  const have = new Set(events.map((e) => e.id));
  const pinned = items.filter((r) => GRADING_KINDS.has(r.kind) && !have.has(r.id));
  if (!pinned.length) return events;
  return [...pinned, ...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/**
 * Subscribe to an SSE endpoint and feed a ring: reconnects forever with
 * bounded backoff, recording every state change. Returns stop(); never throws.
 */
export function subscribe(url, ring, { minBackoffMs = 1000, maxBackoffMs = 15000 } = {}) {
  let stopped = false;
  let controller = null;
  let backoff = minBackoffMs;

  const connect = async () => {
    if (stopped) return;
    controller = new AbortController();
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      ring.connected = true;
      ring.reason = null;
      ring.connected_at = Date.now();
      backoff = minBackoffMs; // a successful connect resets the backoff

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // Parse complete frames only; a partial tail waits in the buffer.
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              ring.push(JSON.parse(payload));
            } catch {
              // A malformed frame is skipped, never fatal.
            }
          }
        }
      }
      throw new Error("stream ended");
    } catch (err) {
      if (stopped) return;
      ring.connected = false;
      ring.reason = `event feed disconnected: ${String(err?.message ?? err)}`;
    } finally {
      try {
        controller?.abort();
      } catch {
        /* already aborted */
      }
    }

    if (stopped) return;
    const wait = backoff;
    backoff = Math.min(maxBackoffMs, Math.round(backoff * 1.7));
    setTimeout(connect, wait);
  };

  connect();

  return () => {
    stopped = true;
    try {
      controller?.abort();
    } catch {
      /* fine */
    }
  };
}
