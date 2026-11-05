// BENCH CONTROL PLANE — DEV-MODE ROUTE. Each entry is { method, path,
// handle(req, res, url) }; paths are wire contract. The flag is READ through
// /api/capabilities (never duplicated here); this module only flips it.

import { writeDevMode } from "../devmode.mjs";
import { BENCH_ROOT } from "../state.mjs";
import { sendJson, readBody } from "../lib/http.mjs";

export const routes = [
  {
    // ── POST /api/devmode ── refuses when the environment pins the mode.
    method: "POST",
    path: "/api/devmode",
    async handle(req, res, url) {
      const body = JSON.parse((await readBody(req)) || "{}");
      const out = await writeDevMode({ benchRoot: BENCH_ROOT, enabled: body?.enabled });
      sendJson(res, out.ok ? 200 : 400, out);
      return;
    },
  },
];
