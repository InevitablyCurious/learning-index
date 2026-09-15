// ─────────────────────────────────────────────────────────────────────────────
// BENCH CONTROL PLANE — CUSTOM TOOL ROUTES (LI-14 phase 2)
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

import { refuse } from "../contract.mjs";
// CUSTOM TOOLS. The harness owns the registry — the board renders what this
// serves rather than keeping its own copy that could claim a tool exists.
import { describeTools, invokeTool } from "../tools.mjs";
import { readRunState } from "../runstate.mjs";
import { BENCH_ROOT, RUNS_ROOT, getLauncher } from "../state.mjs";
import { sendJson, readBody } from "../lib/http.mjs";

export const routes = [
  {
    // ── GET /api/tools ───────────────────────────────────────────────────
    //
    // The registry, with each tool's status RESOLVED against its preconditions.
    // A tool whose reference MCP is unbuilt or whose identity is missing comes
    // back "blocked" WITH the reason, so the drawer can state it instead of
    // rendering a control that would fail on click.
    method: "GET",
    path: "/api/tools",
    async handle(req, res, url) {
      sendJson(res, 200, { ok: true, tools: await describeTools(BENCH_ROOT) });
      return;
    },
  },

  {
    // ── POST /api/tools/run ──────────────────────────────────────────────
    //
    // Invoke one tool. Every failure path is loud: unknown id, unknown handler,
    // missing argument, failed precondition, non-zero exit. The tool's own words
    // are forwarded rather than rewritten, so the operator can see WHICH layer
    // refused — the CLI, the hub, or this service.
    //
    // NOT GATED ON A CONFIRMATION TOKEN, deliberately: this is a single explicit
    // click on a named tool, not a parameterised run that spends hours or money.
    // The click is the act.
    method: "POST",
    path: "/api/tools/run",
    async handle(req, res, url) {
      const payload = JSON.parse((await readBody(req)) || "{}");

      // A TOOL THAT CHANGES THE SUBSTRATE IS REFUSED WHILE A CELL IS IN FLIGHT.
      // Re-commissioning the MCP or rebuilding the worker image underneath a
      // running cell changes what is being measured mid-measurement, and the
      // result would look valid. The refusal names the run and the remedy —
      // stopping a cell is a button on the same board.
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

      const out = await invokeTool(BENCH_ROOT, payload?.id, payload?.args ?? {});
      sendJson(res, out.ok ? 200 : 400, out);
      return;
    },
  },
];
