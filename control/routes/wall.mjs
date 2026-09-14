// ─────────────────────────────────────────────────────────────────────────────
// BENCH CONTROL PLANE — GATE WALL ROUTE (LI-14 phase 2)
//
// Handler bodies moved here BYTE-VERBATIM from server.mjs; the route paths are
// wire contract — the board calls them byte-identically — and must not change.
// Shared state comes from ../state.mjs and the non-route helpers from ../lib/:
// imported, never redefined.
//
// Each entry is { method, path, handle(req, res, url) }. server.mjs builds its
// dispatch table from these at startup and hands each handler the URL it
// already parsed for the dispatch key, so the bodies stay verbatim.
// ─────────────────────────────────────────────────────────────────────────────

import { readWall } from "../wall.mjs";
import { BENCH_ROOT, RUNS_ROOT } from "../state.mjs";
import { sendJson } from "../lib/http.mjs";
import { activeRunDir } from "../lib/lifecycle.mjs";

export const routes = [
  {
    // ── GET /api/wall ────────────────────────────────────────────────────
    // The GATE WALL's single source: the gate roster folded with the per-gate
    // outcomes of the last completed test run. The board must not stitch the
    // two artifacts together — a second implementation of this fold would
    // disagree with the first, and every disagreement shows up as a wrong
    // colour on a square.
    //
    // The server decides `state`; the board decides colour. Nothing here emits
    // colours, CSS, or presentation. NO LIVE SIGNAL AND NO PHASE: a square
    // carries a recorded verdict or it carries none.
    //
    // Never 500s on a missing roster: that is a real state (the run predates
    // the artifact), reported as ok:true + unwired + a reason.
    method: "GET",
    path: "/api/wall",
    async handle(req, res, url) {
      // An explicit ?run_dir= always wins — that is how an operator inspects an
      // archived run. With none, the ACTIVE run is the answer, resolved from the
      // cell log rather than from a directory name this file would have to keep
      // in step with the campaign layout. See `activeRunDir`.
      const wall = await readWall({
        runsRoot: RUNS_ROOT,
        runDir: url.searchParams.get("run_dir") ?? (await activeRunDir()),
        benchRoot: BENCH_ROOT,
      });
      sendJson(res, wall.ok ? 200 : 400, wall);
      return;
    },
  },
];
