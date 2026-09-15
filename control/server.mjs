#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// BENCH CONTROL PLANE — SERVER
//
//   node server.mjs                 # http://127.0.0.1:8718
//   node server.mjs --port 8081
//
// ZERO DEPENDENCIES. Node stdlib only. No build step, no npm install.
//
// ── THIS IS THE ONLY PART OF THE BOARD THAT CAN CHANGE THE WORLD ─────────────
//
// The dashboard on :8717 is read-only by construction and MUST STAY THAT WAY:
// GET-only, bench repo mounted `:ro`, no docker socket, uid 1000. Those are
// kernel-enforced properties that make "the dashboard corrupted a run"
// impossible rather than unlikely.
//
// Starting runs cannot live there without destroying that. It lives here
// instead: a separate process, a separate port, a separate trust level, and a
// deliberately small surface.
//
// ── SAFETY PROPERTIES (deliberate, do not weaken) ────────────────────────────
//
//   - BINDS 127.0.0.1 AND HAS NO --host FLAG. The read-only dashboard may be
//     exposed on a LAN as a deliberate act; a control plane may not. There is
//     no code path that binds anything else.
//
//   - NO SHELL, EVER. Every process is spawned with an argv array and
//     `shell:false`. Operator-supplied values (model alias, org id) are argv
//     entries, never shell words, so command injection is impossible by
//     construction rather than by escaping.
//
//   - ONE RUN AT A TIME. Enforced server-side and refused with a stated
//     reason, never queued. The campaign is strictly serial (one resident local
//     model, one slot); a queue would let the UI imply a capability the
//     instrument does not have.
//
//   - THE MODEL MUST BE BENCH-ELIGIBLE. The proxy serves Walter's interactive
//     daily-driver aliases on the same endpoint as bench aliases. Starting a
//     benchmark against an interactive slot would contend with live use and
//     produce an indefensible measurement, so it is refused.
//
//   - EVERY REFUSAL CARRIES ITS REASON, VERBATIM, for a human on a stream.
//
//   - THE EVENT PROXY IS READ-ONLY AGAINST THE SERVE. GET /event only. It never
//     posts a prompt, aborts, or summarises — driving the session belongs to
//     the harness alone. A control plane that can inject a turn can corrupt the
//     measurement it displays.
//
// ── SHAPE (LI-14) ────────────────────────────────────────────────────────────
//
// This file is the HTTP entrypoint and nothing else: CORS, the dispatch table,
// the 404, the catch-all 500 and the listen. The shared singletons live in
// state.mjs, the non-route helpers in lib/, and every route handler in
// routes/*.mjs — one module per surface, each exporting { method, path,
// handle } entries. The route paths are wire contract: the board calls them
// byte-identically, so a path literal changes only with the board beside it.
// ─────────────────────────────────────────────────────────────────────────────

import { createServer } from "node:http";
import { existsSync } from "node:fs";

import { refuse } from "./contract.mjs";
import { sendJson } from "./lib/http.mjs";
// SHARED STATE AND THE NON-ROUTE HELPERS (LI-14 phase 1). state.mjs owns the
// singletons and the import-time side effects (initState).
import { args, BENCH_ROOT, PYTHON, initState } from "./state.mjs";
// THE ROUTES (LI-14 phase 2). Handler bodies live in these modules exactly as
// they lived here before; this file only keys them and dispatches.
import { routes as metaRoutes } from "./routes/meta.mjs";
import { routes as rosterRoutes } from "./routes/roster.mjs";
import { routes as snapshotRoutes } from "./routes/snapshots.mjs";
import { routes as runRoutes } from "./routes/run.mjs";
import { routes as treeRoutes } from "./routes/tree.mjs";
import { routes as toolRoutes } from "./routes/tools.mjs";
import { routes as eventRoutes } from "./routes/events.mjs";
import { routes as wallRoutes } from "./routes/wall.mjs";

// initState() runs the import-time side effects — the event subscription, the
// persist timer and the shutdown handlers — in the exact order they ran at the
// top of this file before the split.
initState();

// ── THE DISPATCH TABLE ───────────────────────────────────────────────────────
// Built once at startup, keyed by "METHOD /path". Exact-match lookup over
// unique keys replaces the old if-chain with no behaviour change: the first
// match was always the only match. No routing framework — a plain object and
// node:http, zero dependencies.
const routes = {};
for (const r of [
  ...metaRoutes,
  ...rosterRoutes,
  ...snapshotRoutes,
  ...runRoutes,
  ...treeRoutes,
  ...toolRoutes,
  ...eventRoutes,
  ...wallRoutes,
]) {
  routes[`${r.method} ${r.path}`] = r.handle;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  // CORS for the dashboard origin only. The board runs on :8717 and this
  // service on :8718, so a browser treats them as cross-origin.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  try {
    const h = routes[req.method + " " + path];
    // `return await`, never a bare `return h(...)`: a handler rejection must
    // land in THIS catch and become the 500 below. Returning the promise
    // unawaited would adopt it after the try block has exited, and the
    // rejection would escape as an unhandledRejection instead of a refusal.
    // `url` travels along so the handler bodies stay byte-verbatim: it is the
    // same URL already parsed for the dispatch key, never a second parse.
    if (h) return await h(req, res, url);

    sendJson(res, 404, refuse("upstream_unwired", `no route ${req.method} ${path}`));
  } catch (err) {
    // Never swallow. The reason reaches the operator verbatim.
    sendJson(res, 500, refuse("launcher_failed", String(err?.message ?? err)));
  }
});

// 127.0.0.1 ONLY. There is deliberately no flag to change this.
server.listen(args.port, "127.0.0.1", () => {
  console.log(`bench control plane → http://127.0.0.1:${args.port}`);
  console.log(`  bench root : ${BENCH_ROOT}`);
  console.log(`  python     : ${PYTHON}${existsSync(PYTHON) ? "" : "  (MISSING)"}`);
  console.log(`  proxy      : ${args.proxyUrl}`);
  console.log(`  runtime    : ${args.runtimeUrl}`);
  console.log(`  serve      : ${args.serveUrl}  (event stream)`);
});
