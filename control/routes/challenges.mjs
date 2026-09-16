// GET /api/challenges — what the run sequence can be pointed at.
//
// The board's challenge step renders this list verbatim, including the ones it
// cannot offer: a challenge with no frozen fingerprint or no gate suite appears
// with its reason rather than vanishing.

import { listChallenges } from "../challenges.mjs";
import { BENCH_ROOT } from "../state.mjs";
import { sendJson } from "../lib/http.mjs";

export const routes = [
  {
    method: "GET",
    path: "/api/challenges",
    async handle(_req, res) {
      const challenges = await listChallenges(BENCH_ROOT);
      sendJson(res, 200, {
        ok: true,
        challenges,
        ready_count: challenges.filter((c) => c.ready).length,
      });
    },
  },
];
