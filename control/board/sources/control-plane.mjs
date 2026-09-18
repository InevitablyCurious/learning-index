// SOURCE: control-plane — the roster, run state, event feed, hold, TUI
// status, model ledger and tree, read from the control plane's own routes.
// Read-only (GETs only). If the control plane doesn't answer, this reports
// unwired: the board loses its controls and every measurement panel still
// renders.

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
 * The event cursor, kept for the life of this process so every poll after the
 * first asks only for new rows (?since=), not the whole ring. The rows are still
 * kept in a bounded window here, so /api/board is always a complete snapshot.
 */
let eventCursor = 0;
let eventWindow = [];

/** Same as control/contract.mjs EVENT_RENDER_CAP. */
const EVENT_WINDOW_CAP = 400;

// Pin grading rows (user/harness) so their chips stay filterable; the cap
// applies to the five agent kinds. board.js has an identical copy for the
// browser window.
export function capWindow(rows, cap) {
  const pinned = [];
  const rest = [];
  for (const r of rows) (r.kind === "user" || r.kind === "harness" ? pinned : rest).push(r);
  if (rest.length <= cap) return rows;
  const kept = rest.slice(rest.length - cap);
  return [...pinned, ...kept].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/**
 * Did the ring restart? Its seq only grows within one control-plane process, so
 * a cursor below what we have already seen means a restart (replaying from the
 * stale cursor would skip every re-admitted row).
 */
export function ringRestarted(data, cursor) {
  return typeof data?.cursor === "number" && cursor > 0 && data.cursor < cursor;
}

export async function read(ctx) {
  const base = ctx.config?.controlUrl ?? "http://127.0.0.1:8718";

  // Capabilities first: if that fails, nothing else is worth asking.
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

  // The rest are independent; each failure is recorded, none aborts.
  const [roster, run, events, hold, tui, mledger, tree] = await Promise.all([
    get(`${base}/api/roster`, 2500),
    get(`${base}/api/run`),
    // A delta, not a full refetch.
    get(`${base}/api/events?limit=${EVENT_WINDOW_CAP}&since=${eventCursor}`, 2500),
    get(`${base}/api/hold`),
    get(`${base}/api/tui`, 2500),
    // Every launch gate already resolved server-side; passed through untouched.
    get(`${base}/api/models-ledger`, 2500),
    // Which tree is live, so the board can name it.
    get(`${base}/api/tree`, 2500),
  ]);

  const notes = [];
  if (!roster.ok) notes.push(`roster unwired — ${roster.reason}`);
  if (!run.ok) notes.push(`run state unwired — ${run.reason}`);
  if (!events.ok) notes.push(`event feed unwired — ${events.reason}`);
  if (!hold.ok) notes.push(`hold unwired — ${hold.reason}`);
  if (!tui.ok) notes.push(`tui unwired — ${tui.reason}`);
  if (!mledger.ok) notes.push(`model ledger unwired — ${mledger.reason}`);

  // Merge the delta into the bounded window (trimmed from the front, like the
  // feed). A failed read keeps the last rows; connected:false says they're frozen.
  let eventsPayload = null;
  if (events.ok) {
    let data = events.data ?? {};
    // After a restart, refetch from 0 in the same poll. If that fails too, the
    // cursor stays at 0 so the next poll retries.
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
    // The service's cursor is authoritative — except after a restart whose refetch
    // came back empty, where it must not jump past the re-admitted rows.
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
      // null when unavailable: the panel then draws no controls (fail closed).
      models_ledger: mledger.ok && mledger.data?.ok === true ? mledger.data : null,
      // null on a control plane without trees: show nothing rather than guess.
      tree: tree.ok && tree.data?.ok === true ? tree.data : null,
    },
  };
}
