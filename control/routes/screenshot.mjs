// ─────────────────────────────────────────────────────────────────────────────
// BENCH CONTROL PLANE — SCREENSHOT SERVING
//
//   GET /api/screenshot?run_dir=…&sequence_index=…&attempt=…
//
// The grader captures <cellDir>/attempt-<N>-board.png once per graded attempt
// (a non-gating post-verdict side effect). This route is the serving layer:
// it streams the stored PNG as image/png.
//
// No filename or path ever comes off the wire. The wire inputs are run_dir
// (gated by the wall's containment validator), sequence_index (int >= 0) and
// attempt (int 1..10); the cell directory is resolved server-side
// (runstate.cellDirForRun) and the filename is constructed here. A missing
// capture is a clean 404 — never a fallback to another attempt, which would
// show a board that is not the one asked for.
// ─────────────────────────────────────────────────────────────────────────────

import { createReadStream } from "node:fs";
import { join } from "node:path";

import { RUNS_ROOT } from "../state.mjs";
import { sendJson } from "../lib/http.mjs";
import { statOrNull } from "../lib/fs.mjs";
import { resolveRunDir } from "../wall.mjs";
import { cellDirForRun } from "../runstate.mjs";

// The harness clamps max_attempts to this ceiling
// (harness/adapters/challenge/constants.py: DEFAULT_ATTEMPT_HARD_CEILING = 10),
// so any valid attempt is 1..10.
const MAX_ATTEMPTS_HARD_CEILING = 10;

export const routes = [
  {
    method: "GET",
    path: "/api/screenshot",
    async handle(req, res, url) {
      const runDirRaw = url.searchParams.get("run_dir");
      const seqRaw = url.searchParams.get("sequence_index");
      const attemptRaw = url.searchParams.get("attempt");

      if (typeof runDirRaw !== "string" || !runDirRaw.trim()) {
        sendJson(res, 400, { ok: false, reason: "run_dir is required (a path relative to the runs root)" });
        return;
      }
      // The wall's containment validator: nested paths allowed, `..`,
      // backslashes, absolute paths and escapes refused. The empty-string
      // default inside it is unreachable — empty was refused above.
      const target = resolveRunDir(RUNS_ROOT, runDirRaw);
      if (!target) {
        sendJson(res, 400, {
          ok: false,
          reason: `run_dir must be a directory path under the runs root; got ${JSON.stringify(runDirRaw)}`,
        });
        return;
      }
      if (!/^\d+$/.test(seqRaw ?? "")) {
        sendJson(res, 400, { ok: false, reason: "sequence_index is required (an integer >= 0)" });
        return;
      }
      if (!/^\d+$/.test(attemptRaw ?? "")) {
        sendJson(res, 400, {
          ok: false,
          reason: `attempt is required (an integer 1..${MAX_ATTEMPTS_HARD_CEILING})`,
        });
        return;
      }
      const attempt = Number(attemptRaw);
      if (attempt < 1 || attempt > MAX_ATTEMPTS_HARD_CEILING) {
        sendJson(res, 400, {
          ok: false,
          reason: `attempt must be between 1 and ${MAX_ATTEMPTS_HARD_CEILING}; got ${attempt}`,
        });
        return;
      }

      // cellDirForRun does NO containment itself — run_dir already passed
      // resolveRunDir above, which is the whole point. cellDir is
      // runs-root-relative; null when no arm holds the cell.
      const resolved = await cellDirForRun(RUNS_ROOT, target.name, Number(seqRaw));
      if (!resolved) {
        sendJson(res, 404, {
          ok: false,
          reason: `no cell ${Number(seqRaw)} in run ${target.name}`,
        });
        return;
      }

      const absPath = join(RUNS_ROOT, resolved.cellDir, "attempt-" + attempt + "-board.png");
      const st = await statOrNull(absPath);
      if (!st?.isFile()) {
        sendJson(res, 404, {
          ok: false,
          reason: `no screenshot for attempt ${attempt} (a missing capture is normal — the board may not have settled)`,
        });
        return;
      }

      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      createReadStream(absPath).pipe(res);
    },
  },
];
