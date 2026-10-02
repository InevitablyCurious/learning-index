#!/usr/bin/env node
// BENCH CONTROL PLANE — SERVER
//
//   node server.mjs                 # http://127.0.0.1:8718
//   node server.mjs --port 8081
//
// Zero dependencies. The only process that reads run files or changes anything:
// it assembles the board (routes/board.mjs), starts and stops runs, and runs
// tools. The dashboard container only serves the page and relays to it.
//
// Safety properties:
//  - Binds 127.0.0.1 and has no --host flag; the dashboard is what may face a LAN.
//  - No shell: every process is spawned from an argv array.
//  - One run at a time, refused with a reason, never queued.
//  - Only bench-eligible models (interactive proxy slots are refused).
//  - Every refusal carries its reason.
//  - The event proxy only GETs /event; it never drives the session.
//
// This file is the entrypoint: the dispatch table, the 404/500 and the listen.
// State lives in state.mjs, helpers in lib/, handlers in routes/*.mjs.

import { createServer } from "node:http";
import { existsSync } from "node:fs";

import { refuse } from "./contract.mjs";
import { sendJson } from "./lib/http.mjs";
import { args, BENCH_ROOT, PYTHON, initState } from "./state.mjs";
import { routes as metaRoutes } from "./routes/meta.mjs";
import { routes as rosterRoutes } from "./routes/roster.mjs";
import { routes as snapshotRoutes } from "./routes/snapshots.mjs";
import { routes as runRoutes } from "./routes/run.mjs";
import { routes as treeRoutes } from "./routes/tree.mjs";
import { routes as toolRoutes } from "./routes/tools.mjs";
import { routes as challengeRoutes } from "./routes/challenges.mjs";
import { routes as eventRoutes } from "./routes/events.mjs";
import { routes as wallRoutes } from "./routes/wall.mjs";
import { routes as boardRoutes, startBoardLoops } from "./routes/board.mjs";
import { routes as screenshotRoutes } from "./routes/screenshot.mjs";

// Import-time side effects (event subscription, persist timer, shutdown
// handlers), in their original order.
initState();

// ── THE DISPATCH TABLE ── keyed "METHOD /path", exact match.
const routes = {};
for (const r of [
  ...metaRoutes,
  ...rosterRoutes,
  ...snapshotRoutes,
  ...runRoutes,
  ...treeRoutes,
  ...toolRoutes,
...challengeRoutes,
  ...eventRoutes,
  ...wallRoutes,
  ...screenshotRoutes,
  ...boardRoutes,
]) {
  routes[`${r.method} ${r.path}`] = r.handle;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  // No CORS headers, on purpose: browsers reach this only through the
  // dashboard's same-origin relay, and wildcard CORS would let any page on this
  // machine drive it. OPTIONS falls through to the 404.

  try {
    const h = routes[req.method + " " + path];
    // `return await` so a handler rejection lands in this catch and becomes the
    // 500, not an unhandled rejection.
    if (h) return await h(req, res, url);

    sendJson(res, 404, refuse("upstream_unwired", `no route ${req.method} ${path}`));
  } catch (err) {
    // Never swallow. The reason reaches the operator verbatim.
    sendJson(res, 500, refuse("launcher_failed", String(err?.message ?? err)));
  }
});

// 127.0.0.1 only; there is no flag to change this.
server.listen(args.port, "127.0.0.1", () => {
  startBoardLoops();
  console.log(`bench control plane → http://127.0.0.1:${args.port}`);
  console.log(`  bench root : ${BENCH_ROOT}`);
  console.log(`  python     : ${PYTHON}${existsSync(PYTHON) ? "" : "  (MISSING)"}`);
  console.log(`  proxy      : ${args.proxyUrl}`);
  console.log(`  runtime    : ${args.runtimeUrl}`);
  console.log(`  events     : per running cell, on each cell's own serve port`);
});
