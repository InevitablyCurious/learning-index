// BENCH CONTROL PLANE — TREE / BACKUP / HISTORY / PLAY ROUTES. Each entry is
// { method, path, handle(req, res, url) }; paths are wire contract with the board.

import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { refuse } from "../contract.mjs";
// The benchmark tree (see tree.mjs).
import {
  readTreePointer,
  listCampaignDirs,
  campaignTreeId,
  resetAll,
} from "../tree.mjs";
// Restore: listing, checking and putting back a backup (backups.mjs).
import { listBackups, restoreBackup } from "../backups.mjs";
import { readDevMode } from "../devmode.mjs";
import { listRunCells, readCheckpointIndex, readDiffText, readTranscriptText } from "../history.mjs";
import { playStatus, startPlay, stopPlay } from "../play.mjs";
import { deleteRun, planRunDelete } from "../rundelete.mjs";
import { readRunState } from "../runstate.mjs";
import { BENCH_ROOT, RUNS_ROOT } from "../state.mjs";
import { sendJson, sendText, readBody } from "../lib/http.mjs";
import { treeResetGate, restoreGate } from "../lib/gates.mjs";
import { stopRun } from "../lib/lifecycle.mjs";

export const routes = [
  {
    // ── GET /api/tree ── the live tree, when it was minted, what it holds, and
    // what it retired (read by the RESET dialog).
    method: "GET",
    path: "/api/tree",
    async handle(req, res, url) {
      let pointer = null;
      let pointerError = null;
      try {
        pointer = await readTreePointer(RUNS_ROOT);
      } catch (err) {
        pointerError = String(err?.message ?? err);
      }
      const campaigns = await listCampaignDirs(RUNS_ROOT);
      const active = pointer?.active ?? null;
      // Campaigns in the live tree vs on disk, reported separately.
      const inTree = active ? campaigns.filter((c) => campaignTreeId(c.relative) === active) : [];
      sendJson(res, 200, {
        ok: true,
        active,
        created_at: pointer?.created_at ?? null,
        history: pointer?.history ?? [],
        pointer_error: pointerError,
        live_campaigns: inTree.map((c) => c.relative),
        total_campaigns_on_disk: campaigns.length,
      });
      return;
    },
  },

  {
    // ── POST /api/tree/reset/preview ── the restatement shown before RESET,
    // composed here, with the same refusals as the commit.
    method: "POST",
    path: "/api/tree/reset/preview",
    async handle(req, res, url) {
      const check = await treeResetGate();
      if (check.ok === false) {
        sendJson(res, 409, check);
        return;
      }
      sendJson(res, 200, {
        ok: true,
        token: check.token,
        restatement: check.restatement,
        moves: check.moves,
        keeps: check.keeps,
      });
      return;
    },
  },

  {
    // ── POST /api/tree/reset ── back up everything and start a new tree (see
    // tree.mjs for what the sweep moves and leaves).
    method: "POST",
    path: "/api/tree/reset",
    async handle(req, res, url) {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const check = await treeResetGate();
      if (check.ok === false) {
        sendJson(res, 409, check);
        return;
      }
      if (payload?.confirm !== check.token) {
        sendJson(
          res,
          400,
          refuse(
            "bad_confirmation",
            "the confirmation did not match the tree on disk — it changed after the " +
              "preview was shown. Review the restatement and confirm again.",
            { expected_token: check.token, restatement: check.restatement },
          ),
        );
        return;
      }
      try {
        // Stop any run first, so its teardown writes into a tree that still resolves.
        await stopRun();
        const done = await resetAll(RUNS_ROOT);

        // Archive the results ledger into the same backup and start a fresh one. The
        // ledger is derived data, so this fails open and reports rather than blocking.
        let ledger_note;
        try {
          const ledgerSrc = join(BENCH_ROOT, "data", "results-ledger.jsonl");
          await rename(ledgerSrc, join(done.backup, "results-ledger.jsonl"));
          await writeFile(ledgerSrc, "", "utf8"); // fresh empty ledger for the next campaign
          ledger_note = "archived into the backup and restarted";
        } catch (err) {
          if (err?.code !== "ENOENT") {
            console.error(`[reset] results-ledger archive failed (reset proceeds): ${err?.message ?? err}`);
          }
          ledger_note = err?.code === "ENOENT" ? "no ledger yet — nothing to archive" : "archive failed — reset proceeded";
        }

        sendJson(res, 200, {
          ok: true,
          active: done.active,
          backup: done.backup,
          backup_id: done.backup_id,
          moved: done.moved,
          kept: done.kept,
          ledger: ledger_note,
          note: `nothing was deleted — ${done.moved.length} item(s) moved to runs/backups/${done.backup_id}/`,
        });
      } catch (err) {
        sendJson(res, 500, refuse("reset_failed", String(err?.message ?? err)));
      }
      return;
    },
  },

  {
    // ── GET /api/backups ── every reset taken, newest first, summarised well
    // enough to choose between (when, which models, how many results, restorable?).
    method: "GET",
    path: "/api/backups",
    async handle(req, res, url) {
      sendJson(res, 200, { ok: true, backups: await listBackups(RUNS_ROOT) });
      return;
    },
  },

  {
    // ── POST /api/backups/restore/preview ── the same refusals as the restore.
    method: "POST",
    path: "/api/backups/restore/preview",
    async handle(req, res, url) {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const check = await restoreGate(payload?.id);
      sendJson(res, check.ok === false ? 409 : 200, check);
      return;
    },
  },

  {
    // ── POST /api/backups/restore ── park the live bench as its own backup, then
    // move the chosen one in. Nothing is overwritten (backups.mjs).
    method: "POST",
    path: "/api/backups/restore",
    async handle(req, res, url) {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const check = await restoreGate(payload?.id);
      if (check.ok === false) {
        sendJson(res, 409, check);
        return;
      }
      if (payload?.confirm !== check.token) {
        sendJson(
          res,
          400,
          refuse(
            "bad_confirmation",
            "the confirmation did not match this backup — it changed after the preview was shown. " +
              "Review the restatement and confirm again.",
            { expected_token: check.token, restatement: check.restatement },
          ),
        );
        return;
      }
      try {
        const done = await restoreBackup(RUNS_ROOT, payload.id);
        sendJson(res, 200, {
          ok: true,
          restored: done.restored,
          parked_as: done.parked_as,
          parked_items: done.parked_items,
          warnings: done.warnings,
          note:
            `restored ${done.restored.length} item(s); the bench that was live is now ` +
            `backup ${done.parked_as} and can be restored the same way`,
        });
      } catch (err) {
        sendJson(res, 500, refuse("restore_failed", String(err?.message ?? err)));
      }
      return;
    },
  },

  {
    // ── GET /api/history ── every cell of every era, newest tree first, with dev
    // mode read once and carried on every entry.
    method: "GET",
    path: "/api/history",
    async handle(req, res, url) {
      const dm = await readDevMode({ benchRoot: BENCH_ROOT });
      const devMode = {
        enabled: dm?.dev_mode?.enabled ?? false,
        source: dm?.dev_mode?.source ?? "default",
        file: dm?.state_file ?? null,
      };
      const runs = await listRunCells(RUNS_ROOT, devMode);
      sendJson(res, 200, { ok: true, runs });
      return;
    },
  },

  {
    // ── GET /api/history/checkpoints ── a cell's checkpoint index and diffs;
    // none recorded degrades to nulls inside ok:true.
    method: "GET",
    path: "/api/history/checkpoints",
    async handle(req, res, url) {
      const r = await readCheckpointIndex(
        RUNS_ROOT,
        url.searchParams.get("run"),
        url.searchParams.get("cell"),
      );
      if (r.ok) sendJson(res, 200, r);
      else sendJson(res, r.status, { ok: false, code: r.code, reason: r.reason });
      return;
    },
  },

  {
    // ── GET /api/history/diff ── one checkpoint diff, raw text.
    method: "GET",
    path: "/api/history/diff",
    async handle(req, res, url) {
      const r = await readDiffText(
        RUNS_ROOT,
        url.searchParams.get("run"),
        url.searchParams.get("cell"),
        url.searchParams.get("path"),
      );
      if (r.ok) sendText(res, 200, r.text, "text/plain; charset=utf-8");
      else sendJson(res, r.status, { ok: false, code: r.code, reason: r.reason });
      return;
    },
  },

  {
    // ── GET /api/history/transcript ── the cell's transcript.md, raw.
    method: "GET",
    path: "/api/history/transcript",
    async handle(req, res, url) {
      const r = await readTranscriptText(
        RUNS_ROOT,
        url.searchParams.get("run"),
        url.searchParams.get("cell"),
      );
      if (r.ok) sendText(res, 200, r.text, "text/markdown; charset=utf-8");
      else sendJson(res, r.status, { ok: false, code: r.code, reason: r.reason });
      return;
    },
  },

  {
    // ── POST /api/history/delete/preview ── what deleting this run would remove,
    // plus the token binding the confirmation to what is on disk. Touches nothing.
    method: "POST",
    path: "/api/history/delete/preview",
    async handle(req, res, url) {
      const body = JSON.parse((await readBody(req)) || "{}");
      const run = await readRunState({ runsRoot: RUNS_ROOT });
      const r = await planRunDelete(RUNS_ROOT, body?.run, body?.cell, {
        runInFlight: run.can_start !== true,
      });
      if (r.ok) sendJson(res, 200, r);
      else sendJson(res, r.status ?? 400, { ok: false, code: r.code, reason: r.reason, ...r });
      return;
    },
  },

  {
    // ── POST /api/history/delete ── permanent (unlike reset, which moves). Needs
    // the preview's token; refuses the live tree, a run in flight, and any archive
    // layout it doesn't recognise.
    method: "POST",
    path: "/api/history/delete",
    async handle(req, res, url) {
      const body = JSON.parse((await readBody(req)) || "{}");
      const run = await readRunState({ runsRoot: RUNS_ROOT });
      const r = await deleteRun(RUNS_ROOT, body?.run, body?.cell, body?.confirm, {
        runInFlight: run.can_start !== true,
      });
      if (r.ok) sendJson(res, 200, r);
      else sendJson(res, r.status ?? 400, { ok: false, code: r.code, reason: r.reason, ...r });
      return;
    },
  },

  {
    // ── GET /api/play ── what is playing, from the server registry (a play server
    // outlives a control-plane restart).
    method: "GET",
    path: "/api/play",
    async handle(req, res, url) {
      sendJson(res, 200, { ok: true, playing: playStatus(BENCH_ROOT) });
      return;
    },
  },

  {
    // ── POST /api/play/start ── boot a built result for a person to play (see
    // play.mjs). Allowed during a run: play uses a free port, never the grader's.
    method: "POST",
    path: "/api/play/start",
    async handle(req, res, url) {
      const body = JSON.parse((await readBody(req)) || "{}");
      const r = await startPlay({
        runsRoot: RUNS_ROOT,
        benchRoot: BENCH_ROOT,
        run: body?.run,
        cell: body?.cell,
      });
      if (r.ok) sendJson(res, 200, r);
      else sendJson(res, r.status ?? 400, { ok: false, code: r.code, reason: r.reason });
      return;
    },
  },

  {
    // ── POST /api/play/stop ── idempotent.
    method: "POST",
    path: "/api/play/stop",
    async handle(req, res, url) {
      sendJson(res, 200, await stopPlay(BENCH_ROOT));
      return;
    },
  },
];
