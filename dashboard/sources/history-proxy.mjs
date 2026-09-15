// ─────────────────────────────────────────────────────────────────────────────
// HISTORY PROXY — REQUEST-SCOPED, NOT A BOARD SOURCE
//
// Relays the control plane's four /api/history endpoints so the board's
// /history page fetches its data from its OWN origin. This is not an aggregate
// board "source": it has no poll loop, no board section, and it is deliberately
// ABSENT from the MODULE_FILES registry in server.mjs — the request handler
// imports it directly. It lives in sources/ because that is the house location
// for import-safe server-side control-plane-fetch logic (the Dockerfile COPYs
// sources/ wholesale, so the image needs no change).
//
// STATUS AND CONTENT-TYPE ARE FORWARDED VERBATIM. The board has no business
// knowing the shape of the control plane's replies — that knowledge has already
// drifted once (transcript is text/markdown, not JSON). Whatever the control
// plane answers, including its {ok:false, code, reason} error bodies, passes
// through untouched. Only when the control plane cannot be reached at all does
// this module compose a reply of its own: a 502 in the board's honest-error
// convention.
//
// READ-ONLY: GET only, never writes, no top-level side effects.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four control-plane history endpoints, EXACT-match. Unknown
 * /api/history/* subpaths must 404 on the board exactly as they do on the
 * control plane, so this is a Set consulted with .has() — never a prefix
 * match.
 */
export const HISTORY_PROXY_PATHS = new Set([
  "/api/history",
  "/api/history/checkpoints",
  "/api/history/diff",
  "/api/history/transcript",
  // Read-only status of the played build. Starting and stopping one is a POST
  // and does NOT belong here — the board stays GET-only and the browser posts
  // to the control plane itself, exactly as it does to start a run.
  "/api/play",
]);

/**
 * History payloads are on-demand disk reads (transcripts, diffs) and are larger
 * than the TUI fast-path frames, whose 2000ms budget is tuned for a 5Hz
 * liveness loop. 10s is generous for a cold read yet still bounds how long a
 * hung control plane can pin one board request handler.
 */
const PROXY_TIMEOUT_MS = 10_000;

/**
 * One proxied GET. `search` is the raw query string INCLUDING the leading "?"
 * (or "" when empty) and is forwarded verbatim — this module never parses or
 * re-encodes it. Never throws: an unreachable control plane becomes a 502 in
 * the board's honest-error convention.
 */
export async function proxyHistory(pathname, search, controlUrl) {
  const target = (controlUrl ?? "http://127.0.0.1:8718") + pathname + search;
  try {
    // No accept header: diff is text/plain and transcript is text/markdown, so
    // assuming JSON here is exactly the drift this proxy exists to avoid.
    // Node's fetch already sends accept: */* by default.
    const res = await fetch(target, { signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
    const body = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      body,
    };
  } catch (err) {
    return {
      status: 502,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ ok: false, reason: String(err?.message ?? err) }),
    };
  }
}
