// ─────────────────────────────────────────────────────────────────────────────
// BENCH CONTROL PLANE — SNAPSHOT + DEV-MODE ROUTES (LI-14 phase 2)
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

import { listSnapshots, readSnapshot, seedableBy, resolveArmed, writeArmed } from "../snapshots.mjs";
import { readDevMode, resolveDevMode, writeDevMode } from "../devmode.mjs";
import { BENCH_ROOT, RUNS_ROOT } from "../state.mjs";
import { sendJson, readBody } from "../lib/http.mjs";

export const routes = [
  {
    // ── GET /api/devmode ─────────────────────────────────────────────────
    //
    // The control plane's own mode. Also folded into /api/capabilities so the
    // board carries it on every poll without a second request — BOTH call
    // `resolveDevMode`, so there is one producer and two exposures rather than
    // two answers that can disagree.
    method: "GET",
    path: "/api/devmode",
    async handle(req, res, url) {
      sendJson(res, 200, await readDevMode({ benchRoot: BENCH_ROOT }));
      return;
    },
  },

  {
    // ── POST /api/devmode ────────────────────────────────────────────────
    //
    // REFUSES when the environment pins the mode. Writing the file anyway would
    // return a success the next read contradicts, and the operator would have to
    // discover it by watching the toggle snap back.
    method: "POST",
    path: "/api/devmode",
    async handle(req, res, url) {
      const body = JSON.parse((await readBody(req)) || "{}");
      const out = await writeDevMode({ benchRoot: BENCH_ROOT, enabled: body?.enabled });
      sendJson(res, out.ok ? 200 : 400, out);
      return;
    },
  },

  {
    // ── GET /api/snapshots ───────────────────────────────────────────────
    //
    // Every captured snapshot, with the armed selection alongside it so the
    // board never has to make two requests to draw one picker and never has to
    // decide which of two answers is current.
    //
    // `?model=` applies the same-model rule (§6) per row rather than filtering
    // the list: a snapshot an operator captured and cannot find teaches them
    // nothing by its absence, so the ineligible ones are listed and REFUSED,
    // each in its own words. Filtering is the board's choice to make, not this
    // endpoint's to impose.
    method: "GET",
    path: "/api/snapshots",
    async handle(req, res, url) {
      const model = url.searchParams.get("model");
      const list = await listSnapshots(RUNS_ROOT);
      const dev = await resolveDevMode({ benchRoot: BENCH_ROOT });
      const armed = await resolveArmed({ benchRoot: BENCH_ROOT });
      const snapshots = list.snapshots.map((row) => {
        const s = model ? seedableBy(row, model) : { ok: row.eligible, reason: row.reason };
        return { ...row, seedable: s.ok, seedable_reason: s.reason, armed: armed.snapshot_id === row.id };
      });
      sendJson(res, 200, { ...list, model: model ?? null, snapshots, armed, dev_mode: dev });
      return;
    },
  },

  {
    // ── POST /api/snapshots/arm ──────────────────────────────────────────
    //
    // GATED ON DEV MODE, HERE. The board hides the picker when dev mode is off,
    // but a hidden control is not a closed door — a stale tab or a curl can
    // still post. The mode is read from this process, never from the payload,
    // for exactly the reason the confirmation-token design already states: the
    // server must not trust the browser's claim about what mode it is in.
    method: "POST",
    path: "/api/snapshots/arm",
    async handle(req, res, url) {
      const body = JSON.parse((await readBody(req)) || "{}");
      const dev = await resolveDevMode({ benchRoot: BENCH_ROOT });
      if (!dev.enabled) {
        sendJson(res, 409, {
          ok: false,
          code: "dev_mode_off",
          reason:
            "seeding a run from a captured build is a development capability and dev mode is off. "
            + "Turn it on in SETTINGS first — a seeded cell is never a scorable floor.",
        });
        return;
      }
      const id = body?.snapshot_id ?? null;
      // DISARM IS ALWAYS ALLOWED and needs no snapshot to exist. Refusing to
      // disarm because the armed id has since been deleted would leave the
      // operator armed to something unreachable with no way to clear it.
      if (id !== null) {
        const row = await readSnapshot(RUNS_ROOT, String(id));
        const check = seedableBy(row, body?.model ?? row?.author_model ?? null);
        if (!check.ok) {
          sendJson(res, 409, { ok: false, code: "not_seedable", reason: check.reason });
          return;
        }
      }
      const out = await writeArmed({ benchRoot: BENCH_ROOT, snapshotId: id === null ? null : String(id) });
      sendJson(res, out.ok ? 200 : 409, out);
      return;
    },
  },
];
