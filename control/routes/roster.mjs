// ─────────────────────────────────────────────────────────────────────────────
// BENCH CONTROL PLANE — ROSTER / LEDGER / BASELINE ROUTES (LI-14 phase 2)
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

import { readRoster } from "../roster.mjs";
import { readRunState } from "../runstate.mjs";
import { readModelsLedger } from "../models-ledger.mjs";
// THE FLOOR'S ONE OWNER — the same module the ledger's gates read and
// /api/baselines serves, so every refusal about a baseline on this server and
// every button on the board are answering from one derivation.
import { readBaselines } from "../baselines.mjs";
// CLOUD BASELINES. The catalogue is a mirror of the harness's own provider
// block and the key is resolved server-side — see the header of cloud.mjs for
// why no credential ever crosses the wire in either direction.
import { readCloud } from "../cloud.mjs";
import { readRouters, writeRouterKey } from "../routers.mjs";
import { args, BENCH_ROOT, RUNS_ROOT, getLauncher } from "../state.mjs";
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
    // ── GET /api/models-ledger ───────────────────────────────────────────
    // One row per bench-eligible model, one row per measured floor with the ON
    // runs nested inside it, and every launch gate already resolved. The board renders this and decides
    // nothing: a button's enabled state and the refusal /api/run/start would
    // actually apply are computed from the same place, so they cannot drift.
    method: "GET",
    path: "/api/models-ledger",
    async handle(req, res, url) {
      const runState = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
      const roster = await readRoster({ proxyUrl: args.proxyUrl, runtimeUrl: args.runtimeUrl });
      const ledger = await readModelsLedger({
        runsRoot: RUNS_ROOT,
        benchModels: roster.ok ? (roster.bench_models ?? []) : [],
        runInFlight: runState.can_start !== true,
        blockedReason: runState.blocked_reason,
        // THE CLOUD HALF OF THE MODEL UNIVERSE. Passed in rather than read
        // inside the ledger so this route owns every I/O boundary it crosses,
        // and so the ledger stays a pure assembly over what it is handed —
        // which is what makes it testable against a fixture directory.
        cloud: await readCloud({ benchRoot: BENCH_ROOT }),
      });
      // The roster is the model universe; without it there are no rows to
      // draw, and saying so is not the same as saying "no models exist".
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
    // ── GET /api/baselines ───────────────────────────────────────────────
    // THE FLOOR, ON ITS OWN. Every model's baseline, resolved by the single
    // owner (baselines.mjs) and published to runs/baselines.json on the way
    // out. The ledger carries the same index inline, so a board needs no extra
    // call — this endpoint exists for everything that wants the floors WITHOUT
    // the launch gates: a script, a report, a second surface, an operator with
    // curl. One derivation, several readers, no second definition.
    method: "GET",
    path: "/api/baselines",
    async handle(req, res, url) {
      const roster = await readRoster({ proxyUrl: args.proxyUrl, runtimeUrl: args.runtimeUrl });
      const out = await readBaselines({
        runsRoot: RUNS_ROOT,
        models: roster.ok ? (roster.bench_models ?? []) : [],
      });
      // A roster that could not be read is stated rather than silently yielding
      // an empty index — "no models answered" and "no model has a floor" are
      // different facts.
      sendJson(res, 200, {
        ...out,
        roster_ok: roster.ok,
        roster_reason: roster.ok ? null : roster.reason,
      });
      return;
    },
  },

  {
    // ── GET /api/cloud ───────────────────────────────────────────────────
    //
    // The cloud catalogue, the router, the spend ceiling, and WHETHER A KEY
    // RESOLVES — never the key. What comes back about the credential is
    // `{present, source, fingerprint}`: enough to tell an operator that a cloud
    // launch will authenticate and where the key came from, and worth nothing
    // to anyone who reads it off the wire.
    //
    // This route stays GET-only. Setting a credential lives on /api/routers/key
    // below — see the note there for why that route now exists, and what it does
    // about the risks this comment used to cite as reasons not to have one.
    method: "GET",
    path: "/api/cloud",
    async handle(req, res, url) {
      sendJson(res, 200, await readCloud({ benchRoot: BENCH_ROOT }));
      return;
    },
  },

  {
    // ── GET /api/routers ─────────────────────────────────────────────────
    //
    // Every supported router and whether its key resolves — never the key.
    // OrcaRouter is the first and the pinned default; the registry is a row per
    // router so adding one is data, not a dispatcher branch.
    method: "GET",
    path: "/api/routers",
    async handle(req, res, url) {
      sendJson(res, 200, await readRouters({ benchRoot: BENCH_ROOT }));
      return;
    },
  },

  {
    // ── POST /api/routers/key ────────────────────────────────────────────
    //
    // SET A ROUTER CREDENTIAL FROM THE BOARD.
    //
    // An earlier decision recorded here was that no such route should exist,
    // because it "would put a live credential in a browser, in a request body,
    // and in the browser's autofill store". Those risks are real, and they are
    // answered rather than dismissed:
    //
    //   browser        unavoidable if a human types a key into a page, and the
    //                  alternative measured in practice was worse: the board
    //                  rendered a dead button with no reason, and the operator
    //                  had to leave for a terminal to discover why. An operator
    //                  driven to a shell for one capability ends up driving
    //                  everything from there, which is how the board stopped
    //                  being the interface.
    //   request body   POST only, never a query string, so it cannot reach a
    //                  server log, a proxy log, or shell history. The service
    //                  binds 127.0.0.1 with no --host flag: the value does not
    //                  cross a network hop.
    //   autofill       the field is type=password with autocomplete="off" and is
    //                  never populated from the server, so there is nothing for
    //                  the browser to remember or re-offer.
    //
    // And the value is one-way: it goes in, it is written 0600 to a gitignored
    // file, and what comes back is a fingerprint. No route ever returns a key.
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
