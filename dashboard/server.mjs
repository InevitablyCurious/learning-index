#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// BENCH DASHBOARD — SERVER
//
//   node server.mjs                 # http://127.0.0.1:8717
//   node server.mjs --port 8080 --runs ../runs
//
// ZERO DEPENDENCIES. Node stdlib only. No build step, no npm install.
//
// SAFETY PROPERTIES (deliberate, do not weaken):
//   - READ-ONLY FILESYSTEM. Nothing here opens a file for write and the bench
//     mount stays `:ro`. The board does carry writes, but it never performs
//     them: it RELAYS them same-origin to the loopback control plane, which
//     alone writes. The relay (lib/control-relay.mjs) is an exact-allowlist +
//     origin-check gate, and EVERY request additionally passes the peer policy
//     (lib/net-policy.mjs), so a public peer gets nothing even if the bind is
//     wide.
//   - Binds 127.0.0.1 on the host; in the container, docker-compose decides
//     which addresses are published (see docker-compose.lan.yml).
//     An invalid switch value refuses startup rather than guessing, and a
//     --host that contradicts the switch is refused out loud, never silently
//     honoured.
//   - Every source module runs isolated with a 2s timeout; a module that throws
//     or hangs is reported `unwired` and the board renders without it.
//   - Log reads are tail-bounded (256KB), so a multi-hour run costs the same as
//     a fresh one.
//   - Poll results are cached; concurrent requests share one in-flight refresh.
//   - Serves the fixed static allowlist, four dashboard-owned GET APIs and the
//     relay's exact route table — no filesystem path traversal is possible:
//     the static file map is a fixed allowlist, and the relay builds its
//     upstream target only from a pathname that matched its own exact set.
// ─────────────────────────────────────────────────────────────────────────────

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { guardPeer } from "./lib/net-policy.mjs";
import { createControlRelay } from "./lib/control-relay.mjs";

import { streamClients } from "./lib/state.mjs";
import { loadModules, getBoard } from "./lib/board-build.mjs";
import { boardWithoutEvents, tick } from "./lib/broadcast.mjs";
import { TUI_STREAM_MS, tuiForClient, tuiTick } from "./lib/tui.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  // HOST DEFAULT, and why it is env-derived:
  // On the host, binding 127.0.0.1 is the safe default — the board is not
  // exposed to the network unless someone decides it should be.
  // INSIDE A CONTAINER that default is wrong in a way that looks like a bug:
  // a process bound to the container's loopback is unreachable from a
  // published port, so `-p 8717:8717` would silently serve nothing. The
  // container image sets OKP_DASH_HOST=0.0.0.0 explicitly, which is safe
  // there precisely because the container's network namespace IS the boundary
  // and publishing is still opt-in at `docker run`.
  const out = {
    port: 8717,
    host: process.env.OKP_DASH_HOST ?? "127.0.0.1",
    runs: null,
    config: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") { out.port = Number(argv[++i]); out.portExplicit = true; }
    else if (a === "--host") out.host = String(argv[++i]);
    else if (a === "--runs") out.runs = String(argv[++i]);
    else if (a === "--config") out.config = String(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
bench dashboard

  node server.mjs [options]

  --port <n>        default 8717
  --host <addr>     default 127.0.0.1 (pass 0.0.0.0 to expose deliberately)
  --runs <dir>      runs root (default: ../runs relative to this file)
  --config <file>   default: ./dashboard.config.json
`);
  process.exit(0);
}

// ── config ───────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  benchRoot: resolve(HERE, ".."),
  runsRoot: null, // derived from benchRoot when null
  pollMs: 2000,
  opencodeServeUrl: "http://127.0.0.1:8719",
  // The host-side control plane. Opt-in like every other network source: the
  // board must come up with nothing else running.
  //
  // ONE URL. `controlUrl` is how THIS PROCESS reaches the loopback control
  // plane — it is the RELAY's upstream (lib/control-relay.mjs). There is no
  // separate "public" URL anymore: the browser posts SAME-ORIGIN to the
  // dashboard, which relays, so the browser never needs to know where the
  // control plane lives.
  controlUrl: "http://127.0.0.1:8718",
    sources: {
      "run-manifest": true,
      "status-stream": true,
      "run-log": true,
      "stack-ledger": true,
    "funnel-cells": true,
    "plugin-log": true,
    "opencode-serve": true,
    // The during-the-run event stream (LIVE-STREAM.md). On by default: a plain
    // file read off the read-only
    // bench mount, no network and no service dependency. Its absence on a run
    // that predates the stream is a designed state, not a failure — the source
    // reports unwired and the panels fall back to the end-of-cell artifacts.
    "live-stream": true,
    // The durable completed-runs ledger (WO-43): an append-only JSONL at
    // <bench_root>/data/results-ledger.jsonl, one line per completed scored
    // cell, archived by RESET alongside the tree. Absent/empty is a designed
    // state (nothing has completed since the last reset), not a failure.
    "results-ledger": true,
    "control-plane": false, // needs the control service — opt in explicitly
    // Reads the same control service and is enabled with it — the compose file
    // sets both. Kept a separate switch so a board can carry the mirror and the
    // run state without the gate suite, which is exactly the split it exists for.
    "gate-suite": false,
    learning: true,
    "hub-db": false, // needs a reachable postgres — opt in explicitly
  },
  hubDb: {
    enabled: false,
    host: "okp-postgres",
    port: 5432,
    user: "okp",
    database: "okp_hub",
  },
};

/**
 * Env overrides. These exist so the CONTAINER can be reconfigured without a
 * rebuild and without baking a config file into the image — `docker run -e …`
 * or a compose `environment:` block is the whole interface.
 *
 * Precedence: env > config file > defaults.
 */
function applyEnv(cfg) {
  const env = process.env;
  if (env.OKP_DASH_BENCH_ROOT) cfg.benchRoot = env.OKP_DASH_BENCH_ROOT;
  if (env.OKP_DASH_RUNS_ROOT) cfg.runsRoot = env.OKP_DASH_RUNS_ROOT;
  if (env.OKP_DASH_PORT) cfg.port = Number(env.OKP_DASH_PORT);
  if (env.OKP_DASH_POLL_MS) cfg.pollMs = Number(env.OKP_DASH_POLL_MS);
  if (env.OKP_DASH_OPENCODE_URL) cfg.opencodeServeUrl = env.OKP_DASH_OPENCODE_URL;
  if (env.OKP_DASH_CONTROL_URL) cfg.controlUrl = env.OKP_DASH_CONTROL_URL;

  // Per-source toggles: OKP_DASH_SOURCE_HUB_DB=1, ..._OPENCODE_SERVE=0, etc.
  for (const name of Object.keys(cfg.sources)) {
    const key = `OKP_DASH_SOURCE_${name.replace(/-/g, "_").toUpperCase()}`;
    if (env[key] !== undefined) cfg.sources[name] = /^(1|true|on|yes)$/i.test(env[key]);
  }

  if (env.OKP_DASH_HUBDB === "1") cfg.hubDb.enabled = true;
  if (env.OKP_HUB_DB_HOST) cfg.hubDb.host = env.OKP_HUB_DB_HOST;
  if (env.OKP_HUB_DB_PORT) cfg.hubDb.port = Number(env.OKP_HUB_DB_PORT);
  if (env.OKP_HUB_DB_USER) cfg.hubDb.user = env.OKP_HUB_DB_USER;
  if (env.OKP_HUB_DB_NAME) cfg.hubDb.database = env.OKP_HUB_DB_NAME;
  // Password is read from the environment at query time and is never stored in
  // config, never logged, and never returned by /api/health.
  if (cfg.hubDb.enabled) cfg.sources["hub-db"] = true;
  return cfg;
}

async function loadConfig() {
  const path = args.config ? resolve(args.config) : join(HERE, "dashboard.config.json");
  let user = {};
  try {
    user = JSON.parse(await readFile(path, "utf8"));
  } catch {
    // absent config is the normal out-of-the-box case
  }
  const cfg = applyEnv({
    ...DEFAULT_CONFIG,
    ...user,
    sources: { ...DEFAULT_CONFIG.sources, ...(user.sources ?? {}) },
    hubDb: { ...DEFAULT_CONFIG.hubDb, ...(user.hubDb ?? {}) },
  });
  cfg.benchRoot = resolve(cfg.benchRoot);
  cfg.runsRoot = resolve(args.runs ?? cfg.runsRoot ?? join(cfg.benchRoot, "runs"));
  return cfg;
}

// ── the live stream ──────────────────────────────────────────────────────────
//
// ── WHY SERVER-SENT EVENTS AND NOT A WEBSOCKET ──────────────────────────────
//
// The ask was "React consumed by events emitted by a web socket". The push
// semantics are what matter and are delivered here; the wire protocol is SSE,
// deliberately, for three reasons that are properties of THIS server:
//
//   1. NODE HAS NO STDLIB WEBSOCKET SERVER. `globalThis.WebSocket` is a CLIENT
//      only. Serving RFC6455 means either a dependency (`ws`) or hand-rolling
//      frame masking, continuation frames, ping/pong and close handshakes. Both
//      break "no dependencies, no build step" — the stated invariant this image
//      is built on (README, Dockerfile: there is no package.json by design).
//   2. A WEBSOCKET IS BIDIRECTIONAL, AND THIS SERVER PERFORMS NO WRITES BY
//      CONSTRUCTION. It opens no file for write, the bench mount is `:ro`, and
//      the only write path it carries is the same-origin control relay — an
//      exact allowlist of requests forwarded to the loopback control plane,
//      which alone performs them, behind the peer policy and an origin check.
//      Opening a duplex channel would add a SECOND, ungated write path beside
//      that relay, in a process whose safety argument is that every write it
//      carries is allowlisted and gated. SSE is a GET that never closes — the
//      push semantics arrive without touching that argument.
//   3. IT IS ALREADY THE HOUSE IDIOM. The control plane consumes the worker's
//      `opencode serve` over SSE (control/events.mjs), and control/sse-probe.mjs
//      is a live socket test for exactly this framing. One streaming protocol in
//      the tree, not two.
//
// EventSource additionally gives automatic reconnection with backoff, which a
// hand-rolled WebSocket client would have to reimplement — and reconnection is
// the single most important behaviour for a board that must survive a control
// plane restart mid-run without going dark.
//
// ── WHAT IS PUSHED ──────────────────────────────────────────────────────────
//
// `board`  the full payload, MINUS the event ring. Sent on connect and whenever
//          the assembled board changes.
// `events` ONLY rows newer than the client's cursor.
//
// This is the fix for the measured defect: /api/board was 240KB every 2s and
// 82% of it was 400 event rows that had not changed. Measured against the live
// control plane: `?limit=400` = 199KB, `?since=<cursor>` = 493 bytes.
// The client registry itself is a SINGLETON in lib/state.mjs — the connect
// handler below, the push loop (lib/broadcast.mjs) and the TUI fast path
// (lib/tui.mjs) all share that one Set. Never declare a second one.

// ── http ─────────────────────────────────────────────────────────────────────

// Fixed allowlist — there is no dynamic path resolution anywhere in this
// server, so directory traversal is impossible by construction rather than by
// sanitising user input.
const STATIC = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/board.js": { file: "board.js", type: "text/javascript; charset=utf-8" },
  "/board-actions.js": { file: "board-actions.js", type: "text/javascript; charset=utf-8" },
  "/overlay.js": { file: "overlay.js", type: "text/javascript; charset=utf-8" },
  "/dom.js": { file: "dom.js", type: "text/javascript; charset=utf-8" },
  "/panels/chrome.js": { file: "panels/chrome.js", type: "text/javascript; charset=utf-8" },
  "/panels/routers.js": { file: "panels/routers.js", type: "text/javascript; charset=utf-8" },
  "/panels/curve.js": { file: "panels/curve.js", type: "text/javascript; charset=utf-8" },
  "/panels/ledger.js": { file: "panels/ledger.js", type: "text/javascript; charset=utf-8" },
  "/panels/create.js": { file: "panels/create.js", type: "text/javascript; charset=utf-8" },
  "/panels/facet.js": { file: "panels/facet.js", type: "text/javascript; charset=utf-8" },
  "/panels/live.js": { file: "panels/live.js", type: "text/javascript; charset=utf-8" },
  "/panels/live/state.js": { file: "panels/live/state.js", type: "text/javascript; charset=utf-8" },
  "/panels/live/phases.js": { file: "panels/live/phases.js", type: "text/javascript; charset=utf-8" },
  "/panels/live/history.js": { file: "panels/live/history.js", type: "text/javascript; charset=utf-8" },
  "/panels/live/backend.js": { file: "panels/live/backend.js", type: "text/javascript; charset=utf-8" },
  "/panels/hold.js": { file: "panels/hold.js", type: "text/javascript; charset=utf-8" },
  "/panels/tui.js": { file: "panels/tui.js", type: "text/javascript; charset=utf-8" },
  "/panels/wall.js": { file: "panels/wall.js", type: "text/javascript; charset=utf-8" },
  "/panels/recall.js": { file: "panels/recall.js", type: "text/javascript; charset=utf-8" },
  "/panels/rail.js": { file: "panels/rail.js", type: "text/javascript; charset=utf-8" },
  "/panels/runstart.js": { file: "panels/runstart.js", type: "text/javascript; charset=utf-8" },
  "/panels/startup.js": { file: "panels/startup.js", type: "text/javascript; charset=utf-8" },
  "/panels/popout.js": { file: "panels/popout.js", type: "text/javascript; charset=utf-8" },
  "/panels/results.js": { file: "panels/results.js", type: "text/javascript; charset=utf-8" },
  "/panels/learning.js": { file: "panels/learning.js", type: "text/javascript; charset=utf-8" },
  "/panels/treereset.js": { file: "panels/treereset.js", type: "text/javascript; charset=utf-8" },
  "/panels/restore.js": { file: "panels/restore.js", type: "text/javascript; charset=utf-8" },
  "/panels/tools.js": { file: "panels/tools.js", type: "text/javascript; charset=utf-8" },
  "/panels/devmode.js": { file: "panels/devmode.js", type: "text/javascript; charset=utf-8" },
  "/panels/challenge.js": { file: "panels/challenge.js", type: "text/javascript; charset=utf-8" },
  "/panels/switches.js": { file: "panels/switches.js", type: "text/javascript; charset=utf-8" },
  "/panels/tick.js": { file: "panels/tick.js", type: "text/javascript; charset=utf-8" },
  "/panels/snapshot.js": { file: "panels/snapshot.js", type: "text/javascript; charset=utf-8" },

  // ── VENDORED, NOT INSTALLED ───────────────────────────────────────────────
  // xterm.js 6.0.0 (MIT, zero runtime dependencies), checked in as the PREBUILT
  // UMD bundle the package ships. Its WebGL addon was vendored alongside and
  // then removed: it quantises the character cell to whole device pixels, which
  // left 9.4% of the card unusable at any font size.
  // "No dependencies, no build step, no npm install" is intact: nothing
  // resolves these at runtime, nothing compiles them, and there is still no
  // package.json. They are static assets on the allowlist like index.html.
  //
  // WHY A REAL TERMINAL AND NOT MORE SPANS. The mirror used to paint 444
  // <span>s per frame and re-diff 29KB of markup ~5x/second, and it sized
  // itself from a hardcoded 8.4px character advance that was a 14px
  // measurement applied to a 13px font — 130 columns drew 1017px inside a box
  // reserving 1092. xterm.js measures the font it is actually given. See
  // panels/tui.js.
  "/vendor/xterm.js": { file: "vendor/xterm.js", type: "text/javascript; charset=utf-8" },
  "/vendor/xterm.css": { file: "vendor/xterm.css", type: "text/css; charset=utf-8" },
  "/vendor/LICENSE-xterm.txt": { file: "vendor/LICENSE-xterm.txt", type: "text/plain; charset=utf-8" },
  "/history": { file: "history.html", type: "text/html; charset=utf-8" },
  "/history.js": { file: "history.js", type: "text/javascript; charset=utf-8" },
  "/vendor/diff2html/diff2html.min.js": { file: "vendor/diff2html/diff2html.min.js", type: "text/javascript; charset=utf-8" },
  "/vendor/diff2html/diff2html.min.css": { file: "vendor/diff2html/diff2html.min.css", type: "text/css; charset=utf-8" },
};

const main = async () => {
  const cfg = await loadConfig();

  const relay = createControlRelay({ controlUrl: cfg.controlUrl });

  const { mods, broken } = await loadModules(cfg);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    // ── PEER POLICY ────────────────────────────────────────────────────────
    // Reject public/internet peers (loopback/private/link-local trusted).
    // Applied to EVERY request, not just the relay, so an accidentally
    // internet-exposed board serves nothing to a public peer. (In Docker the
    // peer is the gateway, a private address, so this is best-effort there —
    // the compose publish bind is the real boundary.)
    const peer = guardPeer(req.socket?.remoteAddress);
    if (!peer.ok) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: "untrusted_peer", reason: peer.reason }));
      return;
    }

    // ── STATIC FILES (GET only) ────────────────────────────────────────────
    const entry = STATIC[url.pathname];
    if (entry) {
      if (req.method !== "GET") { res.writeHead(405, { "content-type": "text/plain" }).end("read-only"); return; }
      try {
        const body = await readFile(join(HERE, entry.file));
        res.writeHead(200, { "content-type": entry.type, "cache-control": "no-store" });
        res.end(body);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      }
      return;
    }

    // ── DASHBOARD-OWNED API ROUTES (GET) ───────────────────────────────────
    // These take precedence over the relay.
    if (req.method === "GET") {
      if (url.pathname === "/api/board") {
        try {
          const board = await getBoard(cfg, mods, broken);
          const body = JSON.stringify(board);
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "content-length": Buffer.byteLength(body),
          });
          res.end(body);
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(err?.message ?? err) }));
        }
        return;
      }

      // ── GET /api/stream ──────────────────────────────────────────────────
      // The push channel. A GET that never ends, so the read-only property of
      // this server is preserved exactly (see the SSE rationale above).
      //
      // The client sends its event cursor as `?since=`. On connect it receives
      // the full board and every event newer than that cursor, so a reconnect
      // after a dropped connection resumes without a gap and without refetching
      // the whole ring.
      if (url.pathname === "/api/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          // Defeats proxy buffering, which otherwise holds frames until a buffer
          // fills and makes a live stream look dead.
          "x-accel-buffering": "no",
        });
        // Tell EventSource to back off to 2s on reconnect rather than its
        // 3s default — this is a local socket, and a run in flight should not
        // wait longer than the old poll interval to recover.
        res.write("retry: 2000\n\n");

        streamClients.add(res);
        const drop = () => streamClients.delete(res);
        req.on("close", drop);
        req.on("error", drop);
        res.on("error", drop);

        // Does this client's TUI popout want full terminal frames? The frame is
        // the largest section on the board and is withheld unless asked for.
        res.okpWantsTui = url.searchParams.get("tui") === "1";

        try {
          const board = await getBoard(cfg, mods, broken);
          const requested = Number(url.searchParams.get("since") ?? 0) || 0;
          // A client reconnecting with a cursor AHEAD of the ring has a stale
          // watermark from before a control-plane restart (the ring re-based its
          // seq counter at 0). Replay from scratch — otherwise every re-admitted
          // row (low seq) is filtered out and the reconnect delivers nothing.
          const ringCursor = board.events?.cursor ?? null;
          const since = typeof ringCursor === "number" && requested > ringCursor ? 0 : requested;
          const rows = (board.events?.events ?? []).filter((e) => (e.seq ?? -1) > since);
          // The cursor this client has been brought up to. The push loop sends
          // each client only what is newer than ITS OWN cursor, so a client that
          // connected mid-run is never replayed rows it already has, and a
          // reconnecting client is never skipped past a gap.
          res.okpCursor = rows.length ? (rows[rows.length - 1].seq ?? since) : since;
          const full = boardWithoutEvents(board);
          full.tui = tuiForClient(full.tui, res.okpWantsTui);
          res.write(`event: board\ndata: ${JSON.stringify(full)}\n\n`);
          res.write(`event: events\ndata: ${JSON.stringify({ events: rows, cursor: board.events?.cursor ?? null })}\n\n`);
        } catch (err) {
          // Never swallow: the client is told why its first frame is missing.
          res.write(`event: error\ndata: ${JSON.stringify({ reason: String(err?.message ?? err) })}\n\n`);
        }
        return;
      }

      if (url.pathname === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            benchRoot: cfg.benchRoot,
            runsRoot: cfg.runsRoot,
            sources: mods.map((m) => m.id),
            disabled: Object.entries(cfg.sources).filter(([, v]) => !v).map(([k]) => k),
          }),
        );
        return;
      }
    }

    // ── CONTROL RELAY ──────────────────────────────────────────────────────
    // Every other /api/* path, GET and POST, allowlisted. The relay
    // (lib/control-relay.mjs) 404s unknown routes, 403s cross-origin POSTs
    // and forwards body/status/content-type verbatim to cfg.controlUrl. It
    // never throws; this catch is the belt to its braces.
    if (url.pathname.startsWith("/api/")) {
      try { await relay(req, res, url); } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: String(err?.message ?? err) }));
      }
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });

  // ── THE PUSH LOOP ────────────────────────────────────────────────────────
  // The board-cadence poll + per-section patch push lives in lib/broadcast.mjs,
  // beside the digest logic it decides pushes by; this is only the wiring.
  const loop = setInterval(() => void tick(cfg, mods, broken), cfg.pollMs);
  // Never hold the process open for the sake of the timer.
  loop.unref?.();

  // ── THE TUI FAST PATH ────────────────────────────────────────────────────
  // A dedicated short-interval poll straight to the control plane, pushing
  // frames to subscribed clients only. The loop lives in lib/tui.mjs; see
  // TUI_STREAM_MS there for why the mirror cannot ride the board's cadence.
  const tuiLoop = setInterval(() => void tuiTick(cfg), TUI_STREAM_MS);
  tuiLoop.unref?.();

  // Precedence: explicit CLI flag > env/config > default. An earlier revision
  // had `cfg.port ?? args.port`, which let an env var silently win over a flag
  // the operator typed — the opposite of what a flag means.
  const port = args.portExplicit ? args.port : (cfg.port ?? args.port);
  server.listen(port, args.host, () => {
    const port = server.address().port;
    console.log(`bench dashboard → http://${args.host}:${port}`);
    console.log(`  bench root : ${cfg.benchRoot}`);
    console.log(`  runs root  : ${cfg.runsRoot}`);
    console.log(`  sources    : ${mods.map((m) => m.id).join(", ") || "(none)"}`);
    console.log(`  stream     : GET /api/stream (SSE, push)`);
    if (broken.length) console.log(`  unwired    : ${broken.map((b) => b.id).join(", ")}`);
  });
};

main();
