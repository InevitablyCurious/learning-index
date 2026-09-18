// BENCH CONTROL PLANE — GATE WALL ROUTE. Each entry is { method, path,
// handle(req, res, url) }; paths are wire contract.

import { readWall } from "../wall.mjs";
import { BENCH_ROOT, RUNS_ROOT } from "../state.mjs";
import { sendJson } from "../lib/http.mjs";
import { activeRunDir } from "../lib/lifecycle.mjs";

export const routes = [
  {
    // ── GET /api/wall ── the wall's only source: roster × last completed test
    // run, folded once here (control/wall.mjs). The server decides state, the board
    // colour. No live signal, no phase. A missing roster is ok:true + unwired + a
    // reason, never a 500.
    method: "GET",
    path: "/api/wall",
    async handle(req, res, url) {
      // ?run_dir= wins (inspecting an archived run); otherwise the active run from
      // the cell log (activeRunDir).
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
