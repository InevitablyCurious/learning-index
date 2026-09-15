// ─────────────────────────────────────────────────────────────────────────────
// BENCH CONTROL PLANE — CAPABILITY + HEALTH ROUTES (LI-14 phase 2)
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

// Stamped ONCE at module load: the moment this process parsed the code it is
// running. Read by /api/health so preflight can prove the running control plane
// is not older than control/ on disk. See the note on that field.
//
// It lives beside the health handler that serves it (LI-14 phase 2). This
// module is parsed during server startup — the same moment the stamp was taken
// when it sat in server.mjs — so the freshness comparison is unchanged: the
// process start against the newest mtime under control/, which rglob() walks
// into this directory.
const PROCESS_STARTED_AT = new Date().toISOString();

export const routes = [
  {
    // ── GET /api/capabilities ────────────────────────────────────────────
    // What this service can actually DO. The board asks before rendering a
    // control, so it never shows a button for an absent capability.
    method: "GET",
    path: "/api/capabilities",
    async handle(req, res, url) {
      sendJson(res, 200, {
        contract_version: CONTROL_CONTRACT_VERSION,
        start_run: true,
        // Permanently false — the harness has no mid-cell checkpoint.
        resume_run: false,
        resume: RESUME_UNSUPPORTED,
        events: true,
        select_context: true,
        // The GATE WALL surface. Advertised so the board can tell "this control
        // plane predates /api/wall" from "the wall has nothing to show".
        wall: true,
        wall_contract_version: WALL_CONTRACT_VERSION,
        // The verbatim graded text the model was handed as user turns.
        feedback: true,
        feedback_contract_version: FEEDBACK_CONTRACT_VERSION,
        // CLOUD BASELINES. Advertised as a capability of this SERVICE, which is
        // a different question from whether a cloud cell can start right now —
        // that needs a key, and the answer lives in /api/cloud beside the
        // catalogue it applies to. A board that read one for the other would
        // either hide a working feature or offer an unauthenticated launch.
        cloud_baselines: true,
        // ── DEV MODE, FOLDED IN SO THE BOARD LEARNS IT ON EVERY POLL ──────
        //
        // The topbar has to mark dev mode whether or not the settings drawer
        // was ever opened, and capabilities is the call the board already makes
        // first on every poll. Its failure is also the board's "control plane
        // unreachable" signal, which is what makes the marker TRI-STATE for
        // free: on, off, or unknown — never a silent off for a service that
        // simply did not answer.
        //
        // Resolved by the SAME function /api/devmode serves, so the two can
        // never disagree.
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
    // ── GET /api/health ──────────────────────────────────────────────────
    method: "GET",
    path: "/api/health",
    async handle(req, res, url) {
      sendJson(res, 200, {
        ok: true,
        contract_version: CONTROL_CONTRACT_VERSION,
        bench_root: BENCH_ROOT,
        runs_root: RUNS_ROOT,
        // ── WHEN THIS PROCESS LOADED ITS CODE ────────────────────────────────
        //
        // The control plane is a LONG-LIVED HOST PROCESS and `make control-start`
        // is a deliberate no-op when :8718 is already listening, so an edit to
        // control/ sits inert until someone restarts it by hand. That is exactly
        // how the 2026-09-02 compaction launch ran without --compact: the source
        // had the flag, the running process did not, and nothing said so.
        //
        // REPORTED, NOT INFERRED. Preflight compares this against the newest
        // mtime under control/ — the same discipline the worker-image check
        // uses. A process cannot be asked what version of a file it parsed, but
        // it CAN say when it started, and a start that predates the source is
        // proof enough that the source is not what is running.
        started_at: PROCESS_STARTED_AT,
        event_feed: { connected: ring.connected, reason: ring.reason, total: ring.total },
      });
      return;
    },
  },
];
