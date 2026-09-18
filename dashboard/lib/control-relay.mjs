// ─────────────────────────────────────────────────────────────────────────────
// CONTROL RELAY — forwards the board's /api/* requests to the control plane.
//
// The browser only ever talks to the dashboard that served it; this module
// passes each request on to the control plane over this machine's loopback.
// The target is always controlUrl + the request path, so it cannot be pointed
// anywhere else, and the control plane 404s any route it does not have.
//
//   - Only GET and POST pass.
//   - Every POST must be same-origin (lib/net-policy.mjs): a write from any
//     other site, or from an opaque "null" origin, is refused before its body
//     is read. Non-browser clients send no Origin and pass.
//   - Replies pass through verbatim. The live stream (text/event-stream) is
//     piped as it arrives; everything else is buffered.
//   - Request bodies (router keys among them) are never logged.
// ─────────────────────────────────────────────────────────────────────────────

import { isSameOrigin } from "./net-policy.mjs";

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
 * Build the relay. `controlUrl` is the control plane's base URL. Returns
 * `async relay(req, res, url)`; it never throws — every failure becomes an
 * honest 4xx/5xx in the board's {ok:false, code, reason} shape.
 */
export function createControlRelay({
  controlUrl,
  fetchImpl = fetch,
  readBody = defaultReadBody,
}) {
  return async function relay(req, res, url) {
    if (req.method !== "GET" && req.method !== "POST") {
      res.writeHead(405, JSON_OUT).end(
        JSON.stringify({ ok: false, code: "method_not_allowed", reason: `${req.method} is not relayed` }),
      );
      return;
    }

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

    let body;
    if (req.method === "POST") {
      try {
        body = await readBody(req);
      } catch (err) {
        res.writeHead(413, JSON_OUT).end(
          JSON.stringify({ ok: false, code: "body_too_large", reason: String(err?.message ?? err) }),
        );
        return;
      }
    }

    // Only content-type and accept cross the hop; origin, cookie and host are
    // this dashboard's own signals and mean nothing upstream.
    const headers = {};
    if (req.headers?.["content-type"] != null) headers["content-type"] = req.headers["content-type"];
    if (req.headers?.accept != null) headers.accept = req.headers.accept;

    // NO TIMEOUT. The control plane decides how long an act takes (starting a
    // run runs preflight first); a relay that gives up early reports a failure
    // for a write that succeeded. The request ends when the browser leaves.
    const abort = new AbortController();
    req.on?.("close", () => abort.abort());

    try {
      const upstream = await fetchImpl(controlUrl + url.pathname + url.search, {
        method: req.method,
        headers,
        ...(req.method === "POST" ? { body } : {}),
        signal: abort.signal,
      });
      const type = upstream.headers.get("content-type") ?? "application/octet-stream";

      if (type.startsWith("text/event-stream") && upstream.body) {
        res.writeHead(upstream.status, {
          "content-type": type,
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        });
        try {
          for await (const chunk of upstream.body) res.write(chunk);
        } catch {
          // client left or control plane restarted; EventSource reconnects
        }
        res.end();
        return;
      }

      const text = await upstream.text();
      res.writeHead(upstream.status, { "content-type": type, "cache-control": "no-store" }).end(text);
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(502, JSON_OUT).end(JSON.stringify({ ok: false, reason: String(err?.message ?? err) }));
    }
  };
}
