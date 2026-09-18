// ─────────────────────────────────────────────────────────────────────────────
// CONTROL RELAY — SAME-ORIGIN CONTROL-PLANE PROXY FOR THE BOARD
// (WO-RV02.)
//
// Once the dashboard can be reached from the LAN, the browser board can no
// longer talk to the loopback control plane (:8718) directly — a page served
// from 192.168.x.x posting to 127.0.0.1 is cross-origin and mixed-trust. So
// the board posts to its OWN origin, and this module forwards the request to
// the control plane over the loopback socket, buffering the reply.
//
// Three hard edges, in order:
//
//   1. ALLOWLIST — an exact "METHOD /path" Set (see CONTROL_ROUTES). The
//      target URL is built ONLY from a pathname that matched the set, so the
//      relay can never become an open proxy or arbitrary-target forwarder.
//   2. ORIGIN/CSRF — every POST must pass isSameOrigin (lib/net-policy.mjs):
//      a browser write from any other origin, or from an opaque "null"
//      origin, is refused 403 before the body is even read. Non-browser
//      clients (curl on a trusted peer) send no Origin and pass.
//   3. HONEST ERRORS — status and content-type from the control plane are
//      forwarded verbatim (same convention as sources/history-proxy.mjs);
//      only an unreachable control plane composes a 502 of our own. A route
//      the relay doesn't know is a 404 naming the key, never a silent drop.
//
// CREDENTIAL HYGIENE: credential bodies (e.g. POST /api/routers/key) pass
// through the relay buffered in memory but are NEVER logged — no console.log
// of a body or of any header value anywhere in this module. The control plane
// already returns only an 8-hex fingerprint for a stored key, so nothing
// secret lands in the response either.
// ─────────────────────────────────────────────────────────────────────────────

import { isSameOrigin } from "./net-policy.mjs";

/**
 * The exact "METHOD /path" keys this relay will proxy. Mirrors the control
 * plane's route table (control/routes/*.mjs) MINUS GET /api/health — the
 * dashboard serves its OWN /api/health and the board never calls the control
 * plane's.
 *
 * This is an EXACT set consulted with .has() — never a prefix match — so an
 * unknown path, an extra segment ("/api/run/start/extra") or a known path
 * with the wrong method ("PUT /api/run/start") all 404, and the relay can
 * never become an open proxy or arbitrary-target forwarder. Any addition to
 * the control plane's routes requires a deliberate sync here (and vice
 * versa): a route that exists there but not here is simply unwired on the
 * board, which is the safe direction to drift.
 */
export const CONTROL_ROUTES = new Set([
  // ── GET (26) ──────────────────────────────────────────────────────────
  "GET /api/capabilities",
  "GET /api/roster",
  "GET /api/models-ledger",
  "GET /api/baselines",
  "GET /api/cloud",
  "GET /api/routers",
  "GET /api/devmode",
  "GET /api/snapshots",
  "GET /api/run",
  "GET /api/preflight",
  "GET /api/tui",
  "GET /api/hold",
  "GET /api/tree",
  "GET /api/backups",
  "GET /api/history",
  "GET /api/history/checkpoints",
  "GET /api/history/diff",
  "GET /api/history/transcript",
  "GET /api/play",
  "GET /api/tools",
  "GET /api/challenges",
  "GET /api/events",
  "GET /api/feedback",
  "GET /api/backend-feed",
  "GET /api/stats",
  "GET /api/wall",
  // ── POST (19) ─────────────────────────────────────────────────────────
  "POST /api/routers/key",
  "POST /api/devmode",
  "POST /api/snapshots/arm",
  "POST /api/run/preview",
  "POST /api/run/start",
  "POST /api/run/resume",
  "POST /api/run/stop/preview",
  "POST /api/run/stop",
  "POST /api/tui/detach",
  "POST /api/hold/release",
  "POST /api/tree/reset/preview",
  "POST /api/tree/reset",
  "POST /api/backups/restore/preview",
  "POST /api/backups/restore",
  "POST /api/history/delete/preview",
  "POST /api/history/delete",
  "POST /api/play/start",
  "POST /api/play/stop",
  "POST /api/tools/run",
]);

/** Header shape for every relay-composed JSON error body. */
const JSON_OUT = { "content-type": "application/json" };

/**
 * Production body reader: drain the request stream as UTF-8, refusing bodies
 * over `cap` bytes. The cap is checked WHILE accumulating — an oversized or
 * endless stream is aborted at 64KB, not buffered into memory first. Injected
 * in tests; the relay only ever sees the returned string.
 */
export async function defaultReadBody(req, cap = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    size += buf.length;
    if (size > cap) throw new Error("request body exceeds 64KB cap");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Build the relay handler. `controlUrl` is the control-plane base
 * ("http://127.0.0.1:8718") and is required — there is deliberately no
 * default here; the server wiring owns that value.
 *
 * Returns `async relay(req, res, url)` where `url` is the ALREADY-PARSED
 * request URL (server.mjs parses once). Never throws: every failure mode
 * (unwired route, cross-origin write, oversized body, unreachable control
 * plane) becomes an honest 4xx/5xx in the board's {ok:false, code, reason}
 * convention.
 */
export function createControlRelay({
  controlUrl,
  allowlist = CONTROL_ROUTES,
  fetchImpl = fetch,
  readBody = defaultReadBody,
  timeoutMs = 10_000,
}) {
  return async function relay(req, res, url) {
    const key = `${req.method} ${url.pathname}`;

    // 1. ALLOWLIST — exact match or an honest 404 naming the unwired key,
    //    exactly like the control plane's own upstream_unwired refusal.
    if (!allowlist.has(key)) {
      res.writeHead(404, JSON_OUT).end(
        JSON.stringify({
          ok: false,
          code: "upstream_unwired",
          reason: `no relay route ${key}`,
        }),
      );
      return;
    }

    // 2. ORIGIN/CSRF — writes must come from this dashboard's own origin or
    //    from no browser at all. Checked BEFORE the body is read: a refused
    //    cross-origin write never gets its payload buffered.
    if (req.method === "POST" && !isSameOrigin(req.headers?.origin, req.headers?.host)) {
      res.writeHead(403, JSON_OUT).end(
        JSON.stringify({
          ok: false,
          code: "cross_origin_denied",
          reason: "cross-origin write refused (Origin does not match this dashboard)",
        }),
      );
      return;
    }

    // 3. BODY (POST only) — buffered in memory, capped, and NEVER logged.
    let body;
    if (req.method === "POST") {
      try {
        body = await readBody(req);
      } catch (err) {
        res.writeHead(413, JSON_OUT).end(
          JSON.stringify({
            ok: false,
            code: "body_too_large",
            reason: String(err?.message ?? err),
          }),
        );
        return;
      }
    }

    // 4. FORWARD. `url.search` includes its leading "?" when present and is
    //    forwarded verbatim — never parsed or re-encoded. Only content-type
    //    and accept cross the hop: origin/cookie/host/x-forwarded-* are the
    //    dashboard's own trust signals and have no meaning upstream.
    const target = controlUrl + url.pathname + url.search;
    const headers = {};
    if (req.headers?.["content-type"] != null) headers["content-type"] = req.headers["content-type"];
    if (req.headers?.accept != null) headers.accept = req.headers.accept;

    try {
      const upstream = await fetchImpl(target, {
        method: req.method,
        headers,
        ...(req.method === "POST" ? { body } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Status and content-type forwarded verbatim; buffered, like
      // sources/history-proxy.mjs.
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "no-store",
      }).end(await upstream.text());
    } catch (err) {
      // The ONLY reply this module composes about the control plane's
      // absence: an honest 502, no body echo, no header values.
      res.writeHead(502, JSON_OUT).end(
        JSON.stringify({ ok: false, reason: String(err?.message ?? err) }),
      );
    }
  };
}
