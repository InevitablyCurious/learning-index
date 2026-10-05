// BENCH CONTROL PLANE — CONTINUOUS MODE ROUTES (control/continuous.mjs holds the
// chain). A chain begins at a run start that carries `continuous: true`; these
// routes read it and end it.

import { endChain, readChain } from "../continuous.mjs";
import { refuse } from "../contract.mjs";
import { BENCH_ROOT } from "../state.mjs";
import { sendJson } from "../lib/http.mjs";

export const routes = [
  {
    // ── GET /api/continuous ── the chain, or null when none was ever started.
    method: "GET",
    path: "/api/continuous",
    async handle(req, res, url) {
      sendJson(res, 200, { ok: true, continuous: await readChain({ benchRoot: BENCH_ROOT }) });
      return;
    },
  },

  {
    // ── POST /api/continuous/stop ── end the chain and leave its run alone: the
    // run in flight finishes and is recorded as usual, and no next run starts.
    // Nothing is discarded, so there is no preview to confirm.
    method: "POST",
    path: "/api/continuous/stop",
    async handle(req, res, url) {
      const chain = await readChain({ benchRoot: BENCH_ROOT });
      if (!chain?.active) {
        sendJson(res, 409, refuse("continuous_not_active", "continuous mode is not running"));
        return;
      }
      const ended = await endChain({
        benchRoot: BENCH_ROOT,
        code: "operator_end",
        reason: `ended from the board during run ${chain.links.length} — that run finishes, and no next run starts`,
      });
      sendJson(res, 200, { ok: true, continuous: ended });
      return;
    },
  },
];
