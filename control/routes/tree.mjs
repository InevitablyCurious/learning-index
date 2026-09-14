// ─────────────────────────────────────────────────────────────────────────────
// BENCH CONTROL PLANE — TREE / BACKUP / HISTORY / PLAY ROUTES (LI-14 phase 2)
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

import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { refuse } from "../contract.mjs";
// THE BENCHMARK TREE. Minting is the control plane's act because the board
// container mounts the repo read-only — see tree.mjs for the layout and for
// why a reset rolls forward instead of unlinking.
import {
  readTreePointer,
  listCampaignDirs,
  campaignTreeId,
  resetAll,
} from "../tree.mjs";
// RESTORE. Listing, checking and putting a backup back — kept out of tree.mjs so
// the layout rules and the recovery rules can be read (and tested) apart.
import { listBackups, restoreBackup } from "../backups.mjs";
import { readDevMode } from "../devmode.mjs";
import { listRunCells, readCheckpointIndex, readDiffText, readTranscriptText } from "../history.mjs";
import { playStatus, startPlay, stopPlay } from "../play.mjs";
import { deleteRun, planRunDelete } from "../rundelete.mjs";
import { readRunState } from "../runstate.mjs";
import { BENCH_ROOT, RUNS_ROOT, getLauncher } from "../state.mjs";
import { sendJson, sendText, readBody } from "../lib/http.mjs";
import { treeResetGate, restoreGate } from "../lib/gates.mjs";
import { stopRun } from "../lib/lifecycle.mjs";

export const routes = [
  {
    // ── GET /api/tree ────────────────────────────────────────────────────
    //
    // Which benchmark tree is live, when it was minted, what is in it, and what
    // it retired. The board's RESET control reads this to state — before the
    // operator commits — exactly what is about to become inert.
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
      // Reported SEPARATELY rather than summed: "what a reset retires" and
      // "what is on disk" are different numbers, and a single count would let
      // an operator read legacy campaigns as part of the live tree.
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
    // ── POST /api/tree/reset/preview ─────────────────────────────────────
    //
    // The restatement the UI must show before RESET fires, composed SERVER-SIDE
    // for the same reason run preview is: the words the operator reads have to
    // be the words the server will act on.
    //
    // PREVIEW RUNS THE SAME REFUSAL AS THE COMMIT. A preview that green-lights a
    // reset the commit would refuse moves the refusal to after the operator has
    // committed — the defect already fixed once on the run path.
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
    // ── POST /api/tree/reset ─────────────────────────────────────────────
    //
    // Back EVERYTHING up and start a brand new tree. Results, baselines and
    // run logs all move to runs/backups/<ts>/ — see tree.mjs for
    // why the sweep is an allow list and what it deliberately leaves running.
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
        // Stop any in-flight run BEFORE retiring the tree, so the harness's
        // teardown writes its final artifacts into a tree that still resolves,
        // and the backup captures them instead of stranding them mid-write.
        await stopRun();
        const done = await resetAll(RUNS_ROOT);

        // ARCHIVE THE RESULTS LEDGER into the same backup, then start a fresh
        // one. The ledger is derived data — the tree is authoritative — so a
        // ledger problem must never block a reset: this whole block fails OPEN,
        // and a failed archive is reported in the response, not thrown.
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
    // ── GET /api/backups ─────────────────────────────────────────────────
    //
    // Every reset the bench has ever taken, newest first, each summarised well
    // enough to choose between them WITHOUT opening a folder: when it was taken,
    // which models it holds, how many results it carries, and whether it would
    // pass the restore check.
    method: "GET",
    path: "/api/backups",
    async handle(req, res, url) {
      sendJson(res, 200, { ok: true, backups: await listBackups(RUNS_ROOT) });
      return;
    },
  },

  {
    // ── POST /api/backups/restore/preview ────────────────────────────────
    //
    // Runs the SAME refusals the restore will run, so a preview can never
    // green-light a restore the commit would reject.
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
    // ── POST /api/backups/restore ────────────────────────────────────────
    //
    // Parks the live bench into its own backup, then moves the chosen one in.
    // No step overwrites anything — see backups.mjs.
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
    // ── GET /api/history ─────────────────────────────────────────────────
    // Every cell of every era, most-recent tree first. Dev mode is measured
    // once here (the same readDevMode the /api/devmode branch serves) and
    // broadcast onto every entry by history.mjs — one producer, carried.
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
    // ── GET /api/history/checkpoints ─────────────────────────────────────
    // The cell's checkpoint index + diffs. A run without checkpoint history
    // degrades to nulls inside ok:true — absence is a state, not a failure.
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
    // ── GET /api/history/diff ────────────────────────────────────────────
    // One checkpoint diff as raw text — a diff is read, not parsed, so it is
    // served verbatim rather than wrapped in JSON.
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
    // ── GET /api/history/transcript ──────────────────────────────────────
    // The cell's transcript.md as raw markdown, verbatim.
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
    // ── POST /api/history/delete/preview ─────────────────────────────────
    //
    // What deleting this run would remove, in plain words, plus the token that
    // binds the confirmation to what is actually on disk. Nothing is touched.
    method: "POST",
    path: "/api/history/delete/preview",
    async handle(req, res, url) {
      const body = JSON.parse((await readBody(req)) || "{}");
      const run = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
      const r = await planRunDelete(RUNS_ROOT, body?.run, body?.cell, {
        runInFlight: run.can_start !== true,
      });
      if (r.ok) sendJson(res, 200, r);
      else sendJson(res, r.status ?? 400, { ok: false, code: r.code, reason: r.reason, ...r });
      return;
    },
  },

  {
    // ── POST /api/history/delete ─────────────────────────────────────────
    //
    // PERMANENT. Unlike /api/tree/reset — which MOVES everything into
    // runs/backups/ and can be undone — this removes bytes. It is gated on the
    // preview's token, refuses the live tree, refuses while a run is in flight,
    // and refuses any archive whose layout it does not recognise rather than
    // deleting on a guess.
    method: "POST",
    path: "/api/history/delete",
    async handle(req, res, url) {
      const body = JSON.parse((await readBody(req)) || "{}");
      const run = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
      const r = await deleteRun(RUNS_ROOT, body?.run, body?.cell, body?.confirm, {
        runInFlight: run.can_start !== true,
      });
      if (r.ok) sendJson(res, 200, r);
      else sendJson(res, r.status ?? 400, { ok: false, code: r.code, reason: r.reason, ...r });
      return;
    },
  },

  {
    // ── GET /api/play ────────────────────────────────────────────────────
    // What is being played right now, or null. Read from the server registry,
    // never from a variable in this process: the control plane restarts and a
    // play server outlives it.
    method: "GET",
    path: "/api/play",
    async handle(req, res, url) {
      sendJson(res, 200, { ok: true, playing: playStatus(BENCH_ROOT) });
      return;
    },
  },

  {
    // ── POST /api/play/start ─────────────────────────────────────────────
    //
    // Boot one built result so a person can play it. This is the operator's
    // own check on what the grading says — see play.mjs for why that matters.
    //
    // It does NOT refuse while a cell is in flight. It used to have to: with a
    // fixed port there was exactly one address and the grader owned it. The
    // artifact now takes its port from the environment, play assigns a free
    // one, and the two no longer want the same thing.
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
    // ── POST /api/play/stop ──────────────────────────────────────────────
    // Idempotent: "nothing was running" is a result, not an error.
    method: "POST",
    path: "/api/play/stop",
    async handle(req, res, url) {
      sendJson(res, 200, await stopPlay(BENCH_ROOT));
      return;
    },
  },
];
