// BENCH CONTROL PLANE — ROSTER / LEDGER / BASELINE / ROUTER ROUTES. Each entry
// is { method, path, handle(req, res, url) }; paths are wire contract.

import { join } from "node:path";

import { readRoster } from "../roster.mjs";
import { readModelsLedger } from "../models-ledger.mjs";
// The floor's one owner (baselines.mjs), and the batch record it reads:
// readBatchForRunDir verifies the fingerprint on every read (a stale batch
// comes back void, naming the changed input); selectRun/writeBatch persist
// the operator's pick.
import { readBaselines, readBatchForRunDir } from "../baselines.mjs";
import { selectRun, writeBatch } from "../batch.mjs";
// Cloud catalogue and key report (see cloud.mjs: no credential crosses the wire).
import { readCloud } from "../cloud.mjs";
import { readRouters, writeRouterKey } from "../routers.mjs";
// The N-slot run ledger: the Set of models with a live run (the per-model gate).
import { inFlightModels } from "../run-ledger.mjs";
import { args, BENCH_ROOT, RUNS_ROOT } from "../state.mjs";
import { sendJson, readBody } from "../lib/http.mjs";

export const routes = [
  {
    // ── GET /api/roster ──────────────────────────────────────────────────
    method: "GET",
    path: "/api/roster",
    async handle(req, res, url) {
      sendJson(res, 200, await readRoster({
        proxyUrl: args.proxyUrl,
        runtimeUrl: args.runtimeUrl,
      }));
      return;
    },
  },

  {
    // ── GET /api/models-ledger ── rows with every launch gate resolved (the same
    // place /api/run/start's refusals come from).
    method: "GET",
    path: "/api/models-ledger",
    async handle(req, res, url) {
      const roster = await readRoster({ proxyUrl: args.proxyUrl, runtimeUrl: args.runtimeUrl });
      const ledger = await readModelsLedger({
        runsRoot: RUNS_ROOT,
        benchModels: roster.ok ? (roster.bench_models ?? []) : [],
        // The per-model gate: the Set of models with a live run in the N-slot ledger.
        inFlightModels: inFlightModels(),
        // Passed in, so the ledger stays a pure assembly (testable on fixtures).
        cloud: await readCloud({ benchRoot: BENCH_ROOT }),
      });
      // No roster: say so (not the same as "no models exist").
      if (!roster.ok) {
        sendJson(res, 200, {
          ...ledger,
          models: [],
          unwired: ["roster"],
          unwired_reason: roster.reason ?? "model proxy unreachable",
        });
        return;
      }
      sendJson(res, 200, ledger);
      return;
    },
  },

  {
    // ── GET /api/baselines ── the floors alone, from baselines.mjs, also written
    // to runs/baselines.json. For scripts, reports and curl.
    method: "GET",
    path: "/api/baselines",
    async handle(req, res, url) {
      const roster = await readRoster({ proxyUrl: args.proxyUrl, runtimeUrl: args.runtimeUrl });
      const out = await readBaselines({
        runsRoot: RUNS_ROOT,
        models: roster.ok ? (roster.bench_models ?? []) : [],
      });
      // An unreadable roster is stated, not an empty index.
      sendJson(res, 200, {
        ...out,
        roster_ok: roster.ok,
        roster_reason: roster.ok ? null : roster.reason,
      });
      return;
    },
  },

  {
    // ── GET /api/batch ── one campaign's batch record: runs[], scored/void
    // counts, median, selection, fingerprint, and the void status + changed
    // input name. run_dir is runs-root-RELATIVE (the cells' convention). The
    // fingerprint is verified on every read: a batch whose inputs changed
    // comes back void — and is persisted void — never quietly serving stale
    // numbers.
    method: "GET",
    path: "/api/batch",
    async handle(req, res, url) {
      const runDir = url.searchParams.get("run_dir");
      if (!runDir) {
        sendJson(res, 400, { ok: false, error: "run_dir required" });
        return;
      }
      const out = await readBatchForRunDir({ runsRoot: RUNS_ROOT, runDir });
      if (!out.ok) {
        sendJson(res, 404, { ok: false, error: "no batch" });
        return;
      }
      sendJson(res, 200, { ok: true, batch: out.batch });
      return;
    },
  },

  {
    // ── POST /api/batch/select ── the operator's floor pick:
    // { run_dir, sequence_index }. The selection is stored with its signed
    // deviation from the batch median (+ = worse, − = better). A void batch
    // is refused 409 — a selection never rides on stale numbers; an absent
    // or unscored sequence_index is 400 with selectRun's own message.
    method: "POST",
    path: "/api/batch/select",
    async handle(req, res, url) {
      const body = JSON.parse((await readBody(req)) || "{}");
      const runDir = typeof body?.run_dir === "string" && body.run_dir.trim()
        ? body.run_dir.trim()
        : null;
      if (!runDir) {
        sendJson(res, 400, { ok: false, error: "run_dir required" });
        return;
      }
      const out = await readBatchForRunDir({ runsRoot: RUNS_ROOT, runDir });
      if (!out.ok) {
        sendJson(res, 404, { ok: false, error: "no batch" });
        return;
      }
      const { batch } = out;
      if (batch.void === true) {
        sendJson(res, 409, { ok: false, error: `batch is void (${batch.void_kind}): ${batch.void_reason}` });
        return;
      }
      try {
        selectRun(batch, body?.sequence_index);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err?.message ?? err) });
        return;
      }
      await writeBatch(join(RUNS_ROOT, runDir), batch);
      sendJson(res, 200, { ok: true, batch });
      return;
    },
  },

  {
    // ── GET /api/cloud ── catalogue, router, spend ceiling, and whether a key
    // resolves ({present, source, fingerprint}, never the key). Setting a key is
    // POST /api/routers/key.
    method: "GET",
    path: "/api/cloud",
    async handle(req, res, url) {
      sendJson(res, 200, await readCloud({ benchRoot: BENCH_ROOT }));
      return;
    },
  },

  {
    // ── GET /api/routers ── every supported router and whether its key resolves
    // (never the key). OrcaRouter is the pinned default; routers are data rows.
    method: "GET",
    path: "/api/routers",
    async handle(req, res, url) {
      sendJson(res, 200, await readRouters({ benchRoot: BENCH_ROOT }));
      return;
    },
  },

  {
    // ── POST /api/routers/key ── set a router credential from the board, so the
    // operator never has to leave for a terminal. POST only (never a query string),
    // loopback only, the field is a password input that is never prefilled; the key
    // is written 0600 to a gitignored file and only a fingerprint ever comes back.
    method: "POST",
    path: "/api/routers/key",
    async handle(req, res, url) {
      const body = JSON.parse((await readBody(req)) || "{}");
      const out = await writeRouterKey({
        benchRoot: BENCH_ROOT,
        routerId: body?.router,
        key: body?.key,
      });
      sendJson(res, out.ok ? 200 : 400, out);
      return;
    },
  },
];
