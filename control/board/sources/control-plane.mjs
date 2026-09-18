// ─────────────────────────────────────────────────────────────────────────────
// SOURCE: control-plane  [OPT-IN — network]
//
// Consumes the host-side control plane (default http://127.0.0.1:8718), which
// owns the three surfaces the read-only board cannot own itself: the model
// roster, run control, and the live event feed.
//
// ── WHY THIS IS A SOURCE MODULE AND NOT A SERVER CHANGE ──────────────────────
//
// The dashboard performs no writes by construction: it opens no file for
// write, the bench repo is mounted `:ro`, no docker socket, uid 1000. Those
// are kernel-enforced properties, and they are what make "the dashboard
// corrupted a run" impossible rather than merely unlikely. Adding write
// routes here would trade that for convenience.
//
// So the board READS the control plane exactly like any other source. Writes
// travel a separate road: the browser posts SAME-ORIGIN to the dashboard,
// which relays to the loopback control plane (lib/control-relay.mjs) under an
// exact allowlist, a peer policy and an origin check. This module itself
// never posts, never spawns a process, and keeps every safety property it had
// before this feature existed.
//
// If the control plane is not running, this module reports `unwired` with a
// reason and the board loses its control affordances while every measurement
// panel renders exactly as before. That degradation is the designed behaviour,
// not a failure path.
//
// READ-ONLY: this module GETs and nothing else. The browser's writes are
// forwarded by the dashboard's relay (server.mjs + lib/control-relay.mjs),
// never by this source.
// ─────────────────────────────────────────────────────────────────────────────

export const id = "control-plane";
export const fields = ["control", "events", "hold", "tui", "models_ledger", "tree"];
export function describe() {
  return "host-side control plane — roster, run control, event feed";
}

/** One bounded GET. Never throws; a failure becomes a null section. */
async function get(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

/**
 * THE EVENT CURSOR.
 *
 * Module-level, and deliberately so: the ring is append-only and monotonic, so
 * "what have I already seen" is a property of this PROCESS, not of any one
 * request. Keeping it here lets every read after the first ask for a delta.
 *
 * ── THE DEFECT THIS FIXES (measured 2026-08-13) ─────────────────────────────
 * This module fetched `?limit=400` on every poll, every 2 seconds, forever.
 * Measured against the live control plane:
 *
 *     ?limit=400          199,271 bytes
 *     ?since=<cursor>         493 bytes
 *
 * 82% of the 240KB /api/board payload was event rows the client already had.
 * The `since` parameter has existed in the control plane the whole time
 * (control/server.mjs:692) and was never passed.
 *
 * WHY THE ROWS ARE STILL RETAINED HERE: /api/board must remain a COMPLETE
 * snapshot — it is the documented read-only surface, and a client that GETs it
 * cold has no cursor to resume from. So the delta is merged into a bounded
 * local window and the full window is published. The saving is on the wire
 * between this process and the control plane, and — via /api/stream — between
 * this process and the browser.
 */
let eventCursor = 0;
let eventWindow = [];

/** Mirrors control/contract.mjs EVENT_RENDER_CAP. The feed renders at most this. */
const EVENT_WINDOW_CAP = 400;

// Pin grading rows (user/harness): their chips count the whole ring, so they
// must survive the window cap to stay filterable. The cap applies only to the
// five agent kinds (tool/file/thinking/error/lifecycle).
//
// board.js inlines an identical copy for the browser window — it cannot import
// this server-side module. The predicate must stay identical in both layers.
export function capWindow(rows, cap) {
  const pinned = [];
  const rest = [];
  for (const r of rows) (r.kind === "user" || r.kind === "harness" ? pinned : rest).push(r);
  if (rest.length <= cap) return rows;
  const kept = rest.slice(rest.length - cap);
  return [...pinned, ...kept].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/**
 * Did the ring restart underneath us?
 *
 * `cursor` is the ring's monotonic mapped-event counter (`this.seq`). It only
 * grows within one control-plane process; a process restart recreates the ring
 * at seq 0. A cursor BELOW what this process has already seen is the reliable
 * restart signature — replaying from the stale cursor would silently skip every
 * re-admitted row. (The previous `total < window length` test compared two
 * unrelated quantities and missed restarts whenever the new ring's raw-frame
 * total outgrew the local window inside one poll gap.)
 */
export function ringRestarted(data, cursor) {
  return typeof data?.cursor === "number" && cursor > 0 && data.cursor < cursor;
}

export async function read(ctx) {
  const base = ctx.config?.controlUrl ?? "http://127.0.0.1:8718";

  // Capabilities first: it is the cheapest call and its failure is the whole
  // answer — if the control plane is down, nothing else is worth asking.
  const caps = await get(`${base}/api/capabilities`);
  if (!caps.ok) {
    return {
      ok: false,
      reason:
        `control plane unreachable at ${base} (${caps.reason}) — ` +
        "start it with `node control/server.mjs`. The board stays fully " +
        "functional; only the control surfaces are unavailable.",
    };
  }

  // The remaining calls are independent: any one may be unwired without
  // invalidating the others, so each failure is recorded rather than aborting.
  const [roster, run, events, hold, tui, mledger, tree] = await Promise.all([
    get(`${base}/api/roster`, 2500),
    get(`${base}/api/run`),
    // DELTA, not a full refetch. See the eventCursor note above.
    get(`${base}/api/events?limit=${EVENT_WINDOW_CAP}&since=${eventCursor}`, 2500),
    get(`${base}/api/hold`),
    get(`${base}/api/tui`, 2500),
    // THE MODEL LEDGER. One row per bench-eligible model with every launch gate
    // already resolved server-side. Passed through untouched: the board must
    // never re-derive a gate, or a button's enabled state could disagree with
    // the refusal /api/run/start would actually apply.
    get(`${base}/api/models-ledger`, 2500),
    // THE BENCHMARK TREE. Which timestamped tree the harness is writing into,
    // and what it holds. Fetched so the top bar can NAME the tree an operator is
    // looking at — a board that shows measurements without saying which tree
    // they came from is exactly what makes a stale board indistinguishable from
    // a live one after a reset.
    get(`${base}/api/tree`, 2500),
  ]);

  const notes = [];
  if (!roster.ok) notes.push(`roster unwired — ${roster.reason}`);
  if (!run.ok) notes.push(`run state unwired — ${run.reason}`);
  if (!events.ok) notes.push(`event feed unwired — ${events.reason}`);
  if (!hold.ok) notes.push(`hold unwired — ${hold.reason}`);
  if (!tui.ok) notes.push(`tui unwired — ${tui.reason}`);
  if (!mledger.ok) notes.push(`model ledger unwired — ${mledger.reason}`);

  // ── MERGE THE DELTA INTO THE BOUNDED WINDOW ────────────────────────────
  //
  // The response now carries only rows newer than `eventCursor`, so they are
  // APPENDED. The window is trimmed from the FRONT to the cap, which matches
  // the feed's own oldest-first / cap-400 / trim-from-the-top contract
  // (panels/live.js).
  //
  // A FAILED READ MUST NOT EMPTY THE FEED. When the control plane blinks, the
  // last known rows stay on screen and `connected:false` is what tells the
  // operator the counts are frozen — blanking the list would destroy history
  // that is still true.
  let eventsPayload = null;
  if (events.ok) {
    let data = events.data ?? {};
    // A ring restart re-based the seq counter, so this poll fetched with a
    // stale cursor and saw nothing. Reset and refetch from scratch IN THE SAME
    // POLL so the feed does not blank for a tick — and so the cursor is not
    // promoted past the rows the stale fetch never read. If the refetch fails
    // (the control plane is still coming up), leave the cursor at 0 so the next
    // poll retries `since=0` instead of advancing past the re-admitted rows.
    const restarted = ringRestarted(data, eventCursor);
    if (restarted) {
      eventCursor = 0;
      eventWindow = [];
      const retry = await get(`${base}/api/events?limit=${EVENT_WINDOW_CAP}&since=0`, 2500);
      if (retry.ok) data = retry.data ?? {};
    }
    const fresh = Array.isArray(data.events) ? data.events : [];
    if (fresh.length) {
      eventWindow = capWindow([...eventWindow, ...fresh], EVENT_WINDOW_CAP);
      eventCursor = fresh[fresh.length - 1].seq ?? eventCursor;
    }
    // `cursor` from the service is the authoritative high-water mark; prefer it
    // so a filtered response cannot stall the cursor behind the ring. Skipped
    // when a restart was detected but the refetch came back empty: the stale low
    // cursor must not leapfrog the rows the re-admission just minted.
    if (!(restarted && !fresh.length) && typeof data.cursor === "number" && data.cursor > eventCursor) {
      eventCursor = data.cursor;
    }
    eventsPayload = { ...data, events: eventWindow, returned: eventWindow.length };
  }

  return {
    ok: true,
    provenance: { path: base, mtime: Date.now(), bytes: null },
    patch: {
      control: {
        contract_version: caps.data?.contract_version ?? null,
        capabilities: caps.data ?? null,
        roster: roster.ok ? roster.data : null,
        run: run.ok ? run.data : null,
        notes,
      },
      events: eventsPayload,
      hold: hold.ok ? hold.data : null,
      tui: tui.ok ? tui.data : null,
      // Null when the endpoint is absent or failed. The panel then states that
      // the gates cannot be evaluated rather than drawing ungated buttons —
      // an unverifiable gate must fail closed, not open.
      models_ledger: mledger.ok && mledger.data?.ok === true ? mledger.data : null,
      // Null on a control plane that predates the tree — the top bar then shows
      // nothing rather than claiming a tree that may not exist.
      tree: tree.ok && tree.data?.ok === true ? tree.data : null,
    },
  };
}
