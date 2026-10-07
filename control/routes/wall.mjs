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
      // the cell log (activeRunDir). ?sequence_index= names the one cell folded;
      // absent, the roster is returned with no outcomes.
      const seqRaw = url.searchParams.get("sequence_index");
      // ?attempt=N: the wall as it stood after attempt N (the board's attempt tabs).
      const attemptRaw = url.searchParams.get("attempt");
      const wall = await readWall({
        runsRoot: RUNS_ROOT,
        runDir: url.searchParams.get("run_dir") ?? (await activeRunDir()),
        sequenceIndex: seqRaw !== null && /^\d+$/.test(seqRaw) ? Number(seqRaw) : null,
        benchRoot: BENCH_ROOT,
        upToAttempt: attemptRaw !== null && /^\d+$/.test(attemptRaw) ? Number(attemptRaw) : null,
      });
      sendJson(res, wall.ok ? 200 : 400, wall);
      return;
    },
  },
];
