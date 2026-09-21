// BENCH CONTROL PLANE — CUSTOM TOOL ROUTES. Each entry is { method, path,
// handle(req, res, url) }; paths are wire contract.

import { refuse } from "../contract.mjs";
// The tool registry lives in tools.mjs; the board renders what this serves.
import { describeTools } from "../tools.mjs";
import { startToolJob } from "../tooljobs.mjs";
import { readRunState } from "../runstate.mjs";
import { BENCH_ROOT, RUNS_ROOT, getLauncher } from "../state.mjs";
import { sendJson, readBody } from "../lib/http.mjs";

export const routes = [
  {
    // ── GET /api/tools ── the registry with each tool's status resolved; a
    // blocked tool carries its reason.
    method: "GET",
    path: "/api/tools",
    async handle(req, res, url) {
      sendJson(res, 200, { ok: true, tools: await describeTools(BENCH_ROOT) });
      return;
    },
  },

  {
    // ── POST /api/tools/run ── START one tool as a tracked job and answer
    // immediately: progress and the verdict ride the board frame (tool_jobs),
    // not this connection, so a dropped tab loses nothing. Refusals before any
    // job exists (run in flight, unknown tool, blocked, missing argument) are
    // unchanged and synchronous.
    method: "POST",
    path: "/api/tools/run",
    async handle(req, res, url) {
      const payload = JSON.parse((await readBody(req)) || "{}");

      // A tool that changes the substrate is refused while a cell is in flight (the
      // measurement would change mid-run); the refusal names the run and the remedy.
      const sensitive = (await describeTools(BENCH_ROOT)).find(
        (t) => t.id === payload?.id && t.refuse_while_running,
      );
      if (sensitive) {
        const state = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
        if (state?.running) {
          sendJson(res, 409, refuse(
            "run_in_flight",
            `'${sensitive.name}' changes the substrate a running cell is being measured on, ` +
              `so it is refused while one is live. Stop the cell first — the run control has a ` +
              `STOP CELL button.`,
            { model: state.model ?? null, log_name: state.log_name ?? null, pid: state.pid ?? null },
          ));
          return;
        }
      }

      const out = await startToolJob(BENCH_ROOT, payload?.id, payload?.args ?? {});
      sendJson(res, out.ok ? 200 : 400, out);
      return;
    },
  },
];
