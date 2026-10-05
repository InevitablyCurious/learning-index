#!/usr/bin/env node
/*
 * bench egress sidecar — stdlib-only HTTP reverse proxy.
 *
 * Baked into the worker image at /opt/okp/egress-sidecar.js and run in a
 * dedicated sidecar container attached to BOTH the --internal worker network
 * (bench-internal) and the routable bench network. The worker has zero
 * internet route; it reaches the model, and the memory system's server when the
 * run has one, ONLY through this proxy.
 *
 * Port -> upstream map (MUST match harness/egress.py exactly):
 *   4545 -> http://host.docker.internal:4545   (local model relay)
 *   8443 -> https://api.orcarouter.ai:443      (cloud model API; TLS ends here)
 *   4560 -> $BENCH_MEMORY_UPSTREAM              (the memory system's server; only
 *            when BENCH_MEMORY_UPSTREAM is set — memory-ON runs)
 *   4096 -> http://<cell container name>:4096  (ingress forward, WO-25; only
 *            when OKP_INGRESS_CELL_HOST is set — see UPSTREAMS mutation below)
 *
 * Forwards method + path + headers (Host rewritten to the upstream host, SNI
 * set for the https upstream), streams request bodies upstream, and pipes
 * responses back (status + headers + body) so chunked/SSE streaming works.
 * Upstream failure -> 502 with a short body. Stdlib only: node:http/node:https
 * here, node:fs in ./loop-kill-scanner.cjs — response bytes are OBSERVED for
 * relay loop-kill signatures (best-effort marker file); the response pipe
 * stays byte-transparent.
 */
"use strict";

const http = require("node:http");
const https = require("node:https");
const { createLoopKillScanner, writeLoopKillMarker, writeCompactPhaseRepair } =
  require("./loop-kill-scanner.cjs");

// Loop-kill marker output dir (empty = disabled); read once at startup.
const MARKER_DIR = process.env.OKP_LOOP_KILL_MARKER_DIR || "";

// Compaction-phase sentinel file (null = disabled / non-compact run); read
// once at startup. Set by the harness per cell (ENV-VARS.md) — on a loop kill
// the sidecar writes `repair` here so the compaction arm sees it before the
// session idles.
const COMPACT_PHASE_FILE = process.env.BENCH_COMPACT_PHASE_FILE || null;

// `scan: true` marks a MODEL-WIRE port: only these have their responses
// observed for relay loop-kill signatures.
//
// WHY THE FLAG EXISTS (2026-09-08, run 1788883142). The scanner used to run on
// every port. The other ports do not carry model output — they carry OUR OWN
// traffic, and the ingress forward (4096) replays opencode's PERSISTED session
// messages to the harness. Once a real loop kill is recorded in the session, it
// is in that message list forever, so every harness poll re-matched the
// signature and forged a fresh marker. One real loop kill produced 62 forged
// ones, each aborting a healthy turn ~4s in, until the run blew the
// per-benchmark error cap. A signature is only evidence of a loop kill when it
// arrives on the wire the model answers on.
const UPSTREAMS = {
  4545: { proto: "http", host: "host.docker.internal", port: 4545, scan: true },
  8443: { proto: "https", host: "api.orcarouter.ai", port: 443, scan: true },
};

// Memory route (port 4560 -> the memory system's server): contract in
// harness/egress.py. BENCH_MEMORY_UPSTREAM is the server's origin as the sidecar
// sees it (scheme://host:port), e.g. http://host.docker.internal:8000. Set for
// memory-ON runs only; unset, the port does not exist. No `scan`: it carries the
// memory plugin's traffic, not model output.
const MEMORY_PORT = 4560;
const MEMORY_UPSTREAM = (process.env.BENCH_MEMORY_UPSTREAM || "").trim();
if (MEMORY_UPSTREAM) {
  const url = new URL(MEMORY_UPSTREAM);
  const secure = url.protocol === "https:";
  UPSTREAMS[MEMORY_PORT] = {
    proto: secure ? "https" : "http",
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 443 : 80,
  };
}

// Ingress forward (host :4096 -> cell :4096): contract in harness/egress.py.
// OKP_INGRESS_CELL_HOST is the cell's container name, resolved by Docker embedded DNS at request time.
const INGRESS_CELL_HOST = process.env.OKP_INGRESS_CELL_HOST;
const INGRESS_PORT = parseInt(process.env.OKP_INGRESS_PORT || "4096", 10);
// No `scan`: this port carries the harness's own opencode-serve API reads.
if (INGRESS_CELL_HOST) {
  UPSTREAMS[INGRESS_PORT] = { proto: "http", host: INGRESS_CELL_HOST, port: INGRESS_PORT };
}

// RFC 7230 hop-by-hop headers: never forwarded across a proxy hop. Node
// re-frames transfer encoding on each hop, so stripping these is required
// for correct chunked/SSE pass-through.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function filterHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function badGateway(clientRes, err) {
  if (clientRes.headersSent) {
    clientRes.destroy();
    return;
  }
  const reason = err && err.code ? err.code : err && err.message ? err.message : "unreachable";
  const body = `egress upstream error: ${reason}\n`;
  clientRes.writeHead(502, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  clientRes.end(body);
}

function forward(up, clientReq, clientRes) {
  const headers = filterHeaders(clientReq.headers);
  headers.host = up.host; // rewrite Host to the upstream host

  // Loop-kill observation: one scanner per request, at most one marker per
  // response, and ONLY on a model-wire port (see UPSTREAMS `scan`).
  const sessionId = clientReq.headers["x-session-id"] || null;
  const scanner = up.scan
    ? createLoopKillScanner({
        onMatch: (sig) => {
          // Sentinel FIRST: onMatch runs synchronously inside the proxyRes
          // "data" listener, before pipe() forwards the signature-bearing
          // chunk — so the repair write completes while the response is
          // still in flight, never after the session idles.
          writeCompactPhaseRepair({ phaseFile: COMPACT_PHASE_FILE });
          writeLoopKillMarker({
            markerDir: MARKER_DIR, sessionId, signature: sig, now: () => Date.now(),
          });
        },
      })
    : null;

  const options = {
    protocol: `${up.proto}:`,
    hostname: up.host,
    port: up.port,
    method: clientReq.method,
    path: clientReq.url, // forward path + query exactly as received
    headers,
    agent: false, // fresh socket per request: no stale-pool failure class
  };
  if (up.proto === "https") options.servername = up.host; // explicit SNI

  const lib = up.proto === "https" ? https : http;
  const proxyReq = lib.request(options);
  proxyReq.setTimeout(0); // long model streams: no socket timeout

  proxyReq.on("response", (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode, filterHeaders(proxyRes.headers));
    clientRes.flushHeaders(); // start streaming immediately (SSE)
    proxyRes.on("error", () => clientRes.destroy()); // truncated upstream
    // observe only (model wire only) — the pipe stays byte-transparent
    if (scanner) proxyRes.on("data", (chunk) => scanner.feed(chunk));
    proxyRes.pipe(clientRes);
  });
  proxyReq.on("error", (err) => badGateway(clientRes, err));

  clientReq.on("error", () => proxyReq.destroy());
  clientReq.on("aborted", () => proxyReq.destroy());
  clientRes.on("close", () => {
    if (!clientRes.writableEnded) proxyReq.destroy(); // client went away
  });

  clientReq.pipe(proxyReq);
}

function listen(port, up) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => forward(up, req, res));
    server.timeout = 0;        // no inactivity kill on long streams
    server.requestTimeout = 0; // no cap on slow request receipt
    server.keepAliveTimeout = 65000;
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve(server));
  });
}

async function main() {
  await Promise.all(
    Object.entries(UPSTREAMS).map(([port, up]) => listen(Number(port), up)),
  );
  const map = Object.entries(UPSTREAMS)
    .map(([port, up]) => `${port}->${up.proto}://${up.host}:${up.port}${up.scan ? " (scan)" : ""}`)
    .join(" ");
  console.log(`egress-sidecar listening on 0.0.0.0: ${map}`);
}

// Run only when executed directly (the image's CMD). `require`d — by
// egress-sidecar.test.mjs — the module just exports its pieces so the routing
// and the scan gate can be driven against stub upstreams on ephemeral ports.
if (require.main === module) {
  main().catch((err) => {
    console.error(`egress-sidecar fatal: ${(err && err.stack) || err}`);
    process.exit(1);
  });
}

module.exports = { UPSTREAMS, forward, listen, main };
