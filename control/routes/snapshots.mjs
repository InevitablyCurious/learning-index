// BENCH CONTROL PLANE — SNAPSHOT + DEV-MODE ROUTES. Each entry is { method,
// path, handle(req, res, url) }; paths are wire contract.

import { listSnapshots, readSnapshot, seedableBy, resolveArmed, writeArmed } from "../snapshots.mjs";
import { readDevMode, resolveDevMode, writeDevMode } from "../devmode.mjs";
import { BENCH_ROOT, RUNS_ROOT } from "../state.mjs";
import { sendJson, readBody } from "../lib/http.mjs";

export const routes = [
  {
    // ── GET /api/devmode ── also folded into /api/capabilities; both call
    // resolveDevMode, so they can't disagree.
    method: "GET",
    path: "/api/devmode",
    async handle(req, res, url) {
      sendJson(res, 200, await readDevMode({ benchRoot: BENCH_ROOT }));
      return;
    },
  },

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

  {
    // ── GET /api/snapshots ── every snapshot plus the armed one, in one call.
    // `?model=` applies the same-model rule per row: ineligible snapshots are
    // listed with their reason, never filtered out.
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
    // ── POST /api/snapshots/arm ── gated on dev mode here, from this process (a
    // hidden picker is not a closed door).
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
      // Disarm is always allowed, even if the armed snapshot has since vanished.
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
