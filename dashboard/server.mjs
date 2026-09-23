#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// BENCH DASHBOARD — SERVER
//
//   node server.mjs                 # http://127.0.0.1:8717
//
// ZERO DEPENDENCIES. Node stdlib only.
//
// It serves the board's files and relays every /api/* request to the control
// plane on this machine's loopback, which reads the run files, assembles the
// board and performs every write. This process reads no run data at all.
//
//   - Every request passes the peer check (lib/net-policy.mjs): public
//     addresses get nothing, even if the port is published wide.
//   - Writes must be same-origin (lib/control-relay.mjs).
//   - Static files come from a fixed list, so no path can reach anything else.
// ─────────────────────────────────────────────────────────────────────────────

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { guardPeer } from "./lib/net-policy.mjs";
import { createControlRelay } from "./lib/control-relay.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// In the container OKP_DASH_HOST=0.0.0.0 (the published port decides exposure);
// on the host the default is loopback.
const HOST = process.env.OKP_DASH_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OKP_DASH_PORT ?? 8717);
const CONTROL_URL = process.env.OKP_DASH_CONTROL_URL ?? "http://127.0.0.1:8718";

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
  "/panels/batch.js": { file: "panels/batch.js", type: "text/javascript; charset=utf-8" },
  "/panels/create.js": { file: "panels/create.js", type: "text/javascript; charset=utf-8" },
  "/panels/facet.js": { file: "panels/facet.js", type: "text/javascript; charset=utf-8" },
  "/panels/live.js": { file: "panels/live.js", type: "text/javascript; charset=utf-8" },
  "/panels/live/state.js": { file: "panels/live/state.js", type: "text/javascript; charset=utf-8" },
  "/panels/live/phases.js": { file: "panels/live/phases.js", type: "text/javascript; charset=utf-8" },
  "/panels/live/history.js": { file: "panels/live/history.js", type: "text/javascript; charset=utf-8" },
  "/panels/live/backend.js": { file: "panels/live/backend.js", type: "text/javascript; charset=utf-8" },
  "/panels/hold.js": { file: "panels/hold.js", type: "text/javascript; charset=utf-8" },
  "/panels/cells.js": { file: "panels/cells.js", type: "text/javascript; charset=utf-8" },
  "/panels/tui.js": { file: "panels/tui.js", type: "text/javascript; charset=utf-8" },
  "/panels/wall.js": { file: "panels/wall.js", type: "text/javascript; charset=utf-8" },
  "/panels/recall.js": { file: "panels/recall.js", type: "text/javascript; charset=utf-8" },
  "/panels/rail.js": { file: "panels/rail.js", type: "text/javascript; charset=utf-8" },
  "/panels/runstart.js": { file: "panels/runstart.js", type: "text/javascript; charset=utf-8" },
  "/panels/startup.js": { file: "panels/startup.js", type: "text/javascript; charset=utf-8" },
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

const relay = createControlRelay({ controlUrl: CONTROL_URL });

// What this board is running, file by file, read once at start. Preflight
// compares it with dashboard/ on disk to tell when the board needs a refresh.
const STARTED_AT = new Date().toISOString();
const FILES = Object.fromEntries(
  [
    "server.mjs",
    ...readdirSync(join(HERE, "lib")).filter((f) => f.endsWith(".mjs")).map((f) => `lib/${f}`),
    ...new Set(Object.values(STATIC).map((e) => e.file)),
  ].map((f) => [f, createHash("sha256").update(readFileSync(join(HERE, f))).digest("hex")]),
);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  const peer = guardPeer(req.socket?.remoteAddress);
  if (!peer.ok) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, code: "untrusted_peer", reason: peer.reason }));
    return;
  }

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

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, started_at: STARTED_AT, files: FILES }));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    await relay(req, res, url);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
});

server.listen(PORT, HOST, () => {
  console.log(`bench dashboard → http://${HOST}:${PORT}  (control plane: ${CONTROL_URL})`);
});
