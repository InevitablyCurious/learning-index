// BENCH CONTROL PLANE — ARCHIVE ROUTES. Each entry is
// { method, path, handle(req, res, url) }.
//
// POST /api/archive/historical — the manual verb that moves pre-v2 ("legacy")
// runs out of the living runs root into the sibling `runs-archive/`. Dry-run
// with ?dry_run=1: reports what would move, moves nothing. Live runs are read
// from run state so a run in flight can never be re-addressed under a process.

import { archiveHistorical } from "../archive.mjs";
import { readRunState } from "../runstate.mjs";
import { BENCH_ROOT, RUNS_ROOT } from "../state.mjs";
import { sendJson } from "../lib/http.mjs";

export const routes = [
  {
    method: "POST",
    path: "/api/archive/historical",
    async handle(req, res, url) {
      const flag = url.searchParams.get("dry_run");
      const dryRun = flag === "1" || flag === "true";

      const runState = await readRunState({ runsRoot: RUNS_ROOT });
      const liveRunDirs = runState.runs
        .filter((run) => run.running === true && run.run_dir)
        .map((run) => run.run_dir);

      const result = await archiveHistorical({
        runsRoot: RUNS_ROOT,
        benchRoot: BENCH_ROOT,
        dryRun,
        liveRunDirs,
      });

      sendJson(res, 200, {
        ok: true,
        moved: result.moved,
        skipped: result.skipped,
        archive_root: result.archive_root,
      });
    },
  },
];
