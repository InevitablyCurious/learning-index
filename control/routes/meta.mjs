// BENCH CONTROL PLANE — CAPABILITY + HEALTH ROUTES. Each entry is { method,
// path, handle(req, res, url) }; paths are wire contract.

import { existsSync } from "node:fs";

import {
  CONTROL_CONTRACT_VERSION,
  RESUME_UNSUPPORTED,
  STALL_THRESHOLD_S,
} from "../contract.mjs";
import { WALL_CONTRACT_VERSION } from "../wall.mjs";
import { FEEDBACK_CONTRACT_VERSION } from "../feedback.mjs";
import { resolveDevMode } from "../devmode.mjs";
import { BENCH_ROOT, RUNS_ROOT, PYTHON, RUN_SCRIPT, ring } from "../state.mjs";
import { sendJson } from "../lib/http.mjs";

// When this process loaded its code, stamped once at startup; preflight
// compares it with the newest file under control/ to catch a stale control plane.
const PROCESS_STARTED_AT = new Date().toISOString();

export const routes = [
  {
    // ── GET /api/capabilities ── what this service can do, asked before the board
    // draws a control.
    method: "GET",
    path: "/api/capabilities",
    async handle(req, res, url) {
      sendJson(res, 200, {
        contract_version: CONTROL_CONTRACT_VERSION,
        start_run: true,
        // Always false: the harness has no mid-cell checkpoint.
        resume_run: false,
        resume: RESUME_UNSUPPORTED,
        events: true,
        select_context: true,
        // Tells "no /api/wall on this control plane" from "nothing to show".
        wall: true,
        wall_contract_version: WALL_CONTRACT_VERSION,
        // The verbatim graded text the model was sent.
        feedback: true,
        feedback_contract_version: FEEDBACK_CONTRACT_VERSION,
        // The service supports cloud baselines; whether one can start now (a key) is
        // /api/cloud's answer.
        cloud_baselines: true,
        // Dev mode, folded in so the top bar learns it on every poll: on, off, or
        // unknown when this call fails. Same function /api/devmode serves.
        dev_mode: await resolveDevMode({ benchRoot: BENCH_ROOT }),
        stall_threshold_s: STALL_THRESHOLD_S,
        bench_root: BENCH_ROOT,
        python_present: existsSync(PYTHON),
        run_script_present: existsSync(RUN_SCRIPT),
      });
      return;
    },
  },

  {
    // ── GET /api/health ──
    method: "GET",
    path: "/api/health",
    async handle(req, res, url) {
      sendJson(res, 200, {
        ok: true,
        contract_version: CONTROL_CONTRACT_VERSION,
        bench_root: BENCH_ROOT,
        runs_root: RUNS_ROOT,
        // When this process loaded its code (see PROCESS_STARTED_AT): an edit to
        // control/ does nothing until the process restarts, so preflight checks this.
        started_at: PROCESS_STARTED_AT,
        event_feed: { connected: ring.connected, reason: ring.reason, total: ring.total },
      });
      return;
    },
  },
];
