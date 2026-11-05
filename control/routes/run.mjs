// BENCH CONTROL PLANE — RUN ROUTES. Each entry is { method, path,
// handle(req, res, url) }; paths are wire contract with the board.

import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  confirmationToken,
  restatement,
  refuse,
} from "../contract.mjs";
import { readRoster } from "../roster.mjs";
import { readRunState, confirmAlive, cellSessionId, cellServeUrl, readTail } from "../runstate.mjs";
import { readHold } from "../hold.mjs";
// Where a cell's measurement lands (one campaign per model), and the atomic
// cursor that hands N concurrent cells distinct sequence indices.
import { allocateSequenceIndex, campaignTargetFor } from "../campaign.mjs";
import { baselinePathFor, captureStatsBaseline } from "../runstats.mjs";
import { notice, noticesPathFor } from "../notices.mjs";
// The benchmark tree (see tree.mjs).
import { ensureTree } from "../tree.mjs";
// The tool registry: preflight failures resolve to the button that fixes them.
import { attachRemedies, describeBuiltinTools } from "../tools.mjs";
// The N-slot run ledger: every cell this service spawns holds a slot, written
// through to the durable cell registry, so N concurrent cells are tracked at
// once and survive a control-plane restart (the launcher singleton is gone).
import { inFlightModels, newRunId, recordCellEnded, registerRun } from "../run-ledger.mjs";
import {
  args,
  BENCH_ROOT,
  RUNS_ROOT,
  PYTHON,
  RUN_SCRIPT,
  tui,
} from "../state.mjs";
import { sendJson, readBody } from "../lib/http.mjs";
import { validateStart } from "../lib/validate.mjs";
import { substrateRefreshInFlight } from "../tooljobs.mjs";
import { stopAll } from "../lib/lifecycle.mjs";

// The stop confirmation token, shared by preview and commit. Bound to EVERY
// run in flight: a cell starting or ending, or a new pid/log, re-mints it, so a
// confirmation never stops a set of cells the operator did not see.
function stopToken(state) {
  const runs = (state.runs ?? [])
    .map((r) => `${r.pid ?? "external"}:${r.log_name ?? ""}:${r.started_at ?? ""}`)
    .sort();
  return createHash("sha256").update(`stop:${runs.join("|")}`).digest("hex").slice(0, 12);
}

/** "<run_dir>::<sequence_index>" → its parts, or null when it is not one. */
function parseCellKey(raw) {
  if (typeof raw !== "string") return null;
  const at = raw.lastIndexOf("::");
  if (at <= 0) return null;
  const runDir = raw.slice(0, at);
  const sequenceIndex = Number(raw.slice(at + 2));
  if (!Number.isInteger(sequenceIndex) || sequenceIndex < 0) return null;
  return { key: raw, runDir, sequenceIndex };
}

export const routes = [
  {
    // ── GET /api/run ─────────────────────────────────────────────────────
    method: "GET",
    path: "/api/run",
    async handle(req, res, url) {
      sendJson(res, 200, await readRunState({ runsRoot: RUNS_ROOT }));
      return;
    },
  },

  {
    // ── POST /api/run/preview ── the restatement shown before START, composed here.
    method: "POST",
    path: "/api/run/preview",
    async handle(req, res, url) {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const roster = await readRoster({ proxyUrl: args.proxyUrl, runtimeUrl: args.runtimeUrl });

      // Preview runs the same validation as start, so it never arms a run the start
      // would refuse. The serial gate is excluded: the operator may review the next
      // run while a cell is in flight. So is the refresh gate: a refresh in flight
      // blocks the start, never the review (the advisory rides along below).
      const run = await readRunState({ runsRoot: RUNS_ROOT });
      const refresh = substrateRefreshInFlight(BENCH_ROOT);
      const check = await validateStart(
        payload,
        roster,
        { ...run, can_start: true, blocked_reason: null },
        { requireConfirm: false, runsRoot: RUNS_ROOT, allowRefresh: true },
      );
      if (check.ok === false) {
        sendJson(res, 400, check);
        return;
      }

      const { model, arm, org, kind, cloud, compact, requireTodos, graderWorkerTarget, challenge, pauseAfterGrade } = check;
      sendJson(res, 200, {
        ok: true,
        token: confirmationToken({ model, arm, org, kind, compact, pauseAfterGrade }),
        restatement: restatement({ model, arm, org, kind, cloud, compact, pauseAfterGrade }),
        // The resolved compaction answer, so the frame shows what the token was
        // minted for.
        compact: compact === true,
        requireTodos: requireTodos === true,
        pauseAfterGrade: pauseAfterGrade === true,
        challenge: challenge?.id ?? null,
        graderWorkerTarget: graderWorkerTarget ?? null,
        // The machine form of what the operator is committing to (substrate, vendor,
        // spend ceiling), matching the token.
        kind,
        cloud: cloud ? { provider: cloud.provider, model: cloud.model, slug: cloud.slug, name: cloud.name } : null,
        // The per-model serial rule will block this run (the same fact the
        // start gate reads — the run ledger); the parameters are still valid.
        // Another model's cell no longer blocks this one.
        blocked_now: inFlightModels().has(model)
          ? `a cell for ${model} is already in flight — this model is serial`
          : null,
        // A substrate-changing refresh in flight will block the start; the
        // parameters are still valid. Same advisory shape as blocked_now.
        refresh_now: refresh
          ? `'${refresh.tool_name}' is running and changes the substrate — start is refused until it finishes`
          : null,
      });
      return;
    },
  },

  {
    // ── POST /api/run/start ──────────────────────────────────────────────
    // ONE request sequences, launches and tracks N cells: N distinct
    // sequence_index values from the campaign's atomic cursor, N spawned
    // harnesses, N ledger slots. N=1 goes through the same loop — there is no
    // single-cell path. The batch is all-or-nothing up to the first spawn
    // (every index allocated, every log opened, in pre-flight); spawn-phase
    // failures are reported per cell and never as a bare success.
    method: "POST",
    path: "/api/run/start",
    async handle(req, res, url) {
      const payload = JSON.parse((await readBody(req)) || "{}");

      // How many cells this request launches. Absent = 1; anything but a
      // positive integer is a bad request, never a silent fallback.
      const concurrency = payload.concurrency === undefined ? 1 : payload.concurrency;
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        sendJson(res, 400, refuse(
          "bad_concurrency",
          `concurrency must be a positive integer — got ${JSON.stringify(payload.concurrency)}`,
        ));
        return;
      }

      const roster = await readRoster({ proxyUrl: args.proxyUrl, runtimeUrl: args.runtimeUrl });

      if (!roster.proxy_ok) {
        sendJson(res, 503, refuse("upstream_unwired", roster.reason ?? "model proxy unreachable"));
        return;
      }

      const run = await readRunState({ runsRoot: RUNS_ROOT });

      // The pre-flight gates run ONCE for the request, not per cell: the N
      // cells share one validated parameter set (and one confirmation token).
      const check = await validateStart(payload, roster, run, { runsRoot: RUNS_ROOT });
      if (!check.ok) {
        sendJson(res, 409, check);
        return;
      }

      const { model, arm, org, kind, cloud, compact, requireTodos, graderWorkerTarget, challenge, pauseAfterGrade } = check;

      // Argv array, no shell — the SHARED argv, identical for every cell of
      // the batch except the per-cell --sequence-index spliced in below.
      // Main-parser flags precede the subcommand (argparse exits 2 otherwise).
      // Cloud: --cloud --provider <vendor> --model <model half>, which the
      // harness composes into {router}/{provider}/{model}.
      const argv = [RUN_SCRIPT];
      if (kind === "cloud") {
        argv.push("--cloud", "--provider", cloud.provider, "--model", cloud.model);
      } else {
        argv.push("--model", model);
      }
      if (org) argv.push("--org", org);
      // The cell writes to its model's campaign, resolved before spawn (it is echoed
      // back). The tree is ensured on first use; if it cannot be, the run falls back to
      // the legacy flat layout and says so (tree_error).
      let tree = null;
      let tree_error = null;
      try {
        tree = (await ensureTree(RUNS_ROOT)).active;
      } catch (err) {
        // Reported, because a flat run sits outside what a reset sweeps.
        tree = null;
        tree_error = String(err?.message ?? err);
        console.error(`[run] tree could not be ensured; filing this run in the legacy flat layout: ${tree_error}`);
      }
      const target = await campaignTargetFor({ model, kind, cloud }, RUNS_ROOT);

      // The challenge is pinned to the campaign: every cell builds the same one.
      const pinned = await pinnedChallengeFor(target.manifest_arg);
      if (pinned && challenge?.id && pinned !== challenge.id) {
        sendJson(res, 409, refuse(
          "challenge_pinned",
          `this baseline is measured on '${pinned}'. Its first cell built that, so every ` +
            `later cell builds it too — start a new baseline to measure '${challenge.id}'.`,
          { pinned, requested: challenge.id },
        ));
        return;
      }
      if (target.manifest_arg) argv.push("--manifest", target.manifest_arg);
      // `run` accepts only --mode, --proxy-base-url, --proxy-token-file; check new
      // flags against the subparser. Compaction is always passed explicitly (the
      // harness has no default).

      // The subcommand's position in the shared argv: each cell's
      // --sequence-index (also a main-parser flag) is spliced in just before
      // it, so the N per-cell argv arrays differ in exactly one flag.
      const subcommandAt = argv.length;
      argv.push("run", "--mode", arm, compact ? "--compact" : "--no-compact");
      if (requireTodos) argv.push("--require-todos");
      if (pauseAfterGrade) argv.push("--pause-after-grade");
      if (graderWorkerTarget != null) {
        argv.push("--grader-worker-target", String(graderWorkerTarget));
      }

      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "");
      // The logs go inside the tree, so retiring the tree retires the logs.
      const logDir = tree ? join(RUNS_ROOT, tree) : RUNS_ROOT;
      // The cursor to allocate from is the campaign's own manifest. A null
      // manifest_arg is the legacy flat default: the harness spawned with
      // cwd=BENCH_ROOT reads runs/cumulative/manifest.json (its
      // DEFAULT_MANIFEST_PATH, scripts/run_cumulative/paths.py), so the cursor
      // is seeded from THAT file's current_index — allocating against a null
      // path would seed a blind 0 and re-run sessions that already have cells.
      const sequenceManifest =
        target.manifest_arg ?? join(RUNS_ROOT, "cumulative", "manifest.json");

      // ── THE ON ARM'S PLAN BAND ── the harness plans ONE schedule: the OFF
      // baseline, then the ON band STARTING at the OFF slot count
      // (harness/cumulative/ordering.py build_schedule builds the ON order with
      // start_index=len(off_order)). So an ON cell exists only if its index
      // lands inside that band, and the OFF prefix it must sit after is a fact
      // about the campaign's RECORDED schedule — never this batch's own index,
      // which is already past the end of it. The plan is re-derived from that
      // prefix: the same off_replicates the baseline was created with, plus
      // --on-budget to grow the band to cover this index. A non-positive budget
      // plans no ON slot at all and the harness refuses the cell seconds after
      // launch, so it is refused here instead, before anything is spawned.
      let offBand = null;
      if (arm === "on") {
        try {
          offBand = await recordedOffBand(sequenceManifest);
        } catch (err) {
          // Sizing the band from a blind 0 would plan an ON slot outside the
          // recorded schedule; an unreadable manifest is refused, never guessed.
          sendJson(res, 500, refuse(
            "manifest_unreadable",
            `cannot size the ON band: ${sequenceManifest} exists but cannot be read — ${err?.message ?? err}`,
          ));
          return;
        }
        if (offBand === null || offBand.off_slots < 1) {
          sendJson(res, 409, refuse(
            "no_baseline",
            `this campaign has no OFF baseline yet, so a memory-ON cell has nothing to be ` +
              `measured against and no ON band to be planned in — run a baseline on '${model}' first.`,
            { manifest: sequenceManifest },
          ));
          return;
        }
      }

      // ── PRE-FLIGHT THE WHOLE BATCH ── N distinct indices and N open logs,
      // ALL before the first spawn. Any cell that cannot be prepared refuses
      // the whole batch and what was prepared is cleaned up: a half-launched
      // batch is worse than a refused one.
      const batch = [];
      // A batch that never spawned leaves no trace: prepared-but-unused logs are
      // ghosts the run state would read as live-by-default.
      const discardBatch = async () => {
        await Promise.all(batch.map(async (cell) => {
          await cell.fh.close().catch(() => {});
          for (const f of [cell.log_path, noticesPathFor(cell.log_path), baselinePathFor(cell.log_path)]) {
            await unlink(f).catch(() => {});
          }
        }));
      };
      try {
        for (let i = 0; i < concurrency; i += 1) {
          // The cursor is atomic (campaign.mjs): concurrent starts — this
          // loop and any sibling request — get distinct indices.
          const sequenceIndex = await allocateSequenceIndex(sequenceManifest);
          const logPath = join(
            logDir,
            // The name keeps runstate.mjs's scan pattern (/^(off|on)-cell-|^cell-/);
            // the index suffix keeps N logs of one second distinct.
            `${arm}-cell-${stamp}-s${String(sequenceIndex).padStart(4, "0")}.log`,
          );
          const fh = await open(logPath, "a");
          const cell = {
            run_id: newRunId(),
            sequence_index: sequenceIndex,
            log_path: logPath,
            fh,
            pid: null,
            launched: false,
            code: null,
            error: null,
          };
          batch.push(cell);

          // This run's zero for monotonic stat sources, taken before the
          // harness exists (see captureStatsBaseline). Never blocks a launch.
          await captureStatsBaseline({ logPath });
          // Written before the spawn, so a launch that dies at startup still
          // leaves a record that it was attempted.
          await notice(logPath, "run_queued", {
            detail: { model: model ?? null, arm: arm ?? null },
          });
        }
      } catch (err) {
        await discardBatch();
        sendJson(res, 500, refuse(
          "launcher_failed",
          `batch of ${concurrency} refused: cell ${batch.length + 1} could not be prepared — ${err?.message ?? err}`,
          { requested: concurrency, prepared: batch.length },
        ));
        return;
      }

      // N − off_slots + 1: index N sits N − off_slots slots into the ON band, so
      // the band needs that many slots to contain it. Only the ON arm has a band
      // to grow; the OFF arm's plan is unchanged.
      const onBudget =
        arm === "on" ? batch[batch.length - 1].sequence_index - offBand.off_slots + 1 : null;
      if (arm === "on" && onBudget < 1) {
        await discardBatch();
        sendJson(res, 409, refuse(
          "on_band_mismatch",
          `allocated index ${batch[batch.length - 1].sequence_index} sits below this ` +
            `campaign's OFF baseline (${offBand.off_slots} slots), so the ON band would not ` +
            `contain it — the launch counter restarted below the recorded schedule. ` +
            `Archive the campaign or start a fresh baseline.`,
          { off_slot_count: offBand.off_slots, sequence_index: batch[batch.length - 1].sequence_index },
        ));
        return;
      }

      // ── LAUNCH THE BATCH ── per cell: splice its index into the shared
      // argv, spawn detached, and take the ledger slot at spawn. The env base
      // is shared; only BENCH_NOTICES is per cell.
      const env = { ...process.env };
      // Read by the harness at import; unset = its own default.
      if (challenge?.dir) env.BENCH_TASK_DIR = challenge.dir;

      for (const cell of batch) {
        const cellArgv = [
          ...argv.slice(0, subcommandAt),
          "--sequence-index", String(cell.sequence_index),
          // OFF: EVERY cell of the batch plans the SAME slots — the highest
          // index this batch allocated, +1, which is the campaign's accumulated
          // OFF slot count. The harness GROWS the schedule to that length by
          // APPENDING the missing slots (sequencer.py:138-174), so the highest
          // allocated index is in range for every cell; the batch's own N would
          // plan only N slots and every cell past them dies on "sequence_index
          // N out of range".
          //
          // ON: the baseline's own off_replicates (the band starts at the OFF
          // slot count, and a different plan prefix would be schedule drift)
          // PLUS the budget that grows the band to cover this batch's index —
          // the flag the ON arm was missing, which left build_on_order at its
          // default budget of 0 and refused every memory-ON cell.
          ...(arm === "on"
            ? ["--off-replicates", String(offBand.replicates), "--on-budget", String(onBudget)]
            : ["--off-replicates", String(batch[batch.length - 1].sequence_index + 1)]),
          ...argv.slice(subcommandAt),
        ];
        // The harness writes run-scoped notices to the same file; `source` says
        // who spoke. A CLI launch runs identically without it.
        const cellEnv = { ...env, BENCH_NOTICES: noticesPathFor(cell.log_path) };
        let child;
        try {
          child = spawn(PYTHON, cellArgv, {
            cwd: BENCH_ROOT,
            env: cellEnv,
            // stdin from /dev/null is mandatory: touching stdin would suspend the process.
            stdio: ["ignore", cell.fh.fd, cell.fh.fd],
            detached: true,
            shell: false,
          });
        } catch (err) {
          await cell.fh.close().catch(() => {});
          cell.code = "launcher_failed";
          cell.error = `spawn failed: ${err?.message ?? err}`;
          continue;
        }
        // The durable end-record: the cell is detached and can outlive this
        // request, so its exit is captured HERE — code/signal plus a log tail
        // — and merged into its launch record. A cell that ends is recorded as
        // ended with a reason, never erased. The handler must never throw.
        child.on("exit", (code, signal) => {
          try {
            const reason = signal ? `signal ${signal}` : `exit ${code ?? "?"}`;
            void readTail(cell.log_path, 8192)
              .catch(() => "")
              .then((tail) => {
                try {
                  recordCellEnded(cell.run_id, target.run_dir, {
                    reason,
                    code,
                    signal,
                    log_tail: tail || null,
                  });
                } catch (err2) {
                  console.error(`[run] exit record failed for ${cell.run_id}: ${err2?.message ?? err2}`);
                }
              });
          } catch (err2) {
            console.error(`[run] exit handler failed for ${cell.run_id}: ${err2?.message ?? err2}`);
          }
        });
        child.unref();
        await cell.fh.close().catch(() => {});
        cell.pid = child.pid ?? null;

        // The ledger slot at spawn: the batch is tracked from the moment each
        // harness exists — through the parallel startup window below — and the
        // slot is written through to the durable cell registry, so a control-
        // plane restart loses no pid. A cell that does not survive the window
        // is recorded ended there; the ledger never vouches for a dead cell.
        registerRun({
          run_id: cell.run_id,
          sequence_index: cell.sequence_index,
          model,
          arm,
          kind,
          org,
          manifest_arg: target.manifest_arg ?? null,
          pid: cell.pid,
          started_at: Date.now(),
          log_path: cell.log_path,
          run_dir: target.run_dir,
          finished: false,
          terminal_status: null,
          terminal_ok: null,
          ended: null,
        });
        cell.launched = true;
      }

      // Startup liveness, all N in parallel: the harness can die seconds after
      // spawn (usage error, import error, drift guard). Confirm each survived
      // before claiming the cell started; a cell that did not is recorded
      // ended — durably, with the reason — and reported per cell (the log tail
      // rides its own record).
      const spawned = batch.filter((cell) => cell.launched);
      const liveness = await Promise.all(
        spawned.map((cell) => confirmAlive(cell.pid, { logPath: cell.log_path })),
      );
      for (let i = 0; i < spawned.length; i += 1) {
        const cell = spawned[i];
        if (liveness[i].ok) continue;
        recordCellEnded(cell.run_id, target.run_dir, {
          reason: "startup failed",
          code: null,
          signal: null,
          log_tail: liveness[i].log_tail ?? null,
        });
        cell.launched = false;
        cell.code = "launch_crashed";
        cell.error = `harness exited ${liveness[i].elapsed_ms}ms after launch (see log tail)`;
      }

      // ── THE RESPONSE ── one record per cell. A partial batch is never a
      // bare success: the top-level refusal names the shortfall and runs[]
      // carries the per-cell truth.
      const runs = batch.map((cell) => ({
        run_id: cell.run_id,
        sequence_index: cell.sequence_index,
        model,
        arm,
        pid: cell.pid,
        log_path: cell.log_path,
        launched: cell.launched,
        ...(cell.error ? { error: cell.error } : {}),
      }));
      const failed = batch.filter((cell) => !cell.launched);
      if (failed.length) {
        sendJson(res, 500, refuse(
          failed[0].code,
          `${runs.length - failed.length} of ${runs.length} cells launched — ` +
            failed.map((cell) => `sequence_index ${cell.sequence_index}: ${cell.error}`).join("; "),
          { runs, tree_error },
        ));
        return;
      }

      sendJson(res, 200, {
        ok: true,
        runs,
        // null is healthy; non-null means these runs are filed outside the tree.
        tree_error,
        // The N=1 mirror: the dashboard's single-start consumer
        // (panels/create.js) reads pid/log_path off this response.
        ...(runs.length === 1 ? { pid: runs[0].pid, log_path: runs[0].log_path } : {}),
      });
      return;
    },
  },

  {
    // ── POST /api/run/stop/preview ── abort every live cell: preview, then
    // confirm. stopAll sends each harness one SIGINT so it runs its own
    // teardown (cell, sidecar, volume). An aborted cell has no `progress` and is excluded from the
    // convergence trend, so it can never read as a measurement.
    method: "POST",
    path: "/api/run/stop/preview",
    async handle(req, res, url) {
      const state = await readRunState({ runsRoot: RUNS_ROOT });
      if (!state?.running) {
        sendJson(res, 409, refuse("no_run_in_flight", "there is no cell in flight to stop"));
        return;
      }
      const token = stopToken(state);
      const runs = state.runs ?? [];
      const n = runs.length;
      const lines = runs
        .map((r) => {
          const seq = Number.isInteger(r.sequence_index) ? `s${String(r.sequence_index).padStart(4, "0")}` : "cell";
          return `  ${seq}  ${r.model ?? "model unobserved"}  ${r.log_name ?? "log unknown"}`;
        })
        .join("\n");
      sendJson(res, 200, {
        ok: true,
        token,
        restatement:
          `STOP ${n === 1 ? "the cell" : `all ${n} cells`} in flight.\n\n` +
          `${lines}\n\n` +
          `Each harness is interrupted once so it tears its own cell down: the worker\n` +
          `container, the egress sidecar and the session-db volume are removed.\n` +
          `Anything these cells had measured is DISCARDED — a stopped cell writes no\n` +
          `progress, so it is excluded from the convergence trend and can never be\n` +
          `read as a result. Time and spend already incurred are not recoverable.`,
        runs: runs.map((r) => ({ sequence_index: r.sequence_index ?? null, model: r.model ?? null, log_name: r.log_name ?? null })),
      });
      return;
    },
  },

  {
    // ── POST /api/run/stop ───────────────────────────────────────────────
    method: "POST",
    path: "/api/run/stop",
    async handle(req, res, url) {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const state = await readRunState({ runsRoot: RUNS_ROOT });
      if (!state?.running) {
        sendJson(res, 409, refuse("no_run_in_flight", "there is no cell in flight to stop"));
        return;
      }
      const token = stopToken(state);
      if (payload?.confirm !== token) {
        sendJson(
          res,
          400,
          refuse(
            "bad_confirmation",
            "the confirmation did not match the run in flight — it changed after the " +
              "preview was shown. Review the restatement and confirm again.",
            { expected_token: token },
          ),
        );
        return;
      }
      const done = await stopAll();
      const after = await readRunState({ runsRoot: RUNS_ROOT });
      sendJson(res, 200, {
        ok: true,
        stopped: true,
        runs: done.runs,
        signalled: done.signalled,
        // From a re-read: "signal sent" is not "nothing is running".
        still_running: after?.running === true,
        note: after?.running
          ? "the interrupt was sent but a process is still alive — check the run log"
          : "cell stopped and its containers torn down",
      });
      return;
    },
  },

  {
    // ── GET /api/preflight ── runs scripts/bench_preflight.py and returns its
    // checks, so the board and the CLI give the same answer. The JSON is the last
    // line that parses (a library greets on stdout).
    method: "GET",
    path: "/api/preflight",
    async handle(req, res, url) {
      const model = url.searchParams.get("model") || "";
      // compact=1: prove the worker image wires self-compaction (opencode swallows
      // plugin load errors, so a stale image fails silently).
      const compact = url.searchParams.get("compact") === "1";
      const argv = [join(BENCH_ROOT, "scripts", "bench_preflight.py"), "--json"];
      if (model) argv.push("--model", model);
      if (compact) argv.push("--compact");
      const cloudProvider = url.searchParams.get("provider");
      if (cloudProvider) argv.push("--cloud", "--provider", cloudProvider);

      const out = await new Promise((done) => {
        execFile(PYTHON, argv, { cwd: BENCH_ROOT, timeout: 120000 }, (err, stdout, stderr) =>
          done({ err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
        );
      });

      let parsed = null;
      for (const line of out.stdout.split("\n").map((l) => l.trim()).reverse()) {
        if (!line.startsWith("{")) continue;
        try { parsed = JSON.parse(line); break; } catch { /* keep looking */ }
      }
      if (!parsed) {
        sendJson(res, 502, refuse(
          "preflight_unreadable",
          "preflight produced no readable verdict — its own output is included so the " +
            "failing layer is visible rather than guessed at",
          { stdout_tail: out.stdout.slice(-1500), stderr_tail: out.stderr.slice(-1500) },
        ));
        return;
      }
      // Resolve each failure's remedy id to a built-in tool button (tools.mjs).
      attachRemedies(parsed?.checks, describeBuiltinTools(BENCH_ROOT));

      // Exit 1 is a NO-GO, not a transport failure: status stays 200.
      sendJson(res, 200, parsed);
      return;
    },
  },

  {
    // ── GET /api/tui ── a frame of the attached view, from a read-only pty
    // capture. Polling keeps it alive; it stops when polling stops. `?cell=`
    // is the cell's address, `<run_dir>::<sequence_index>` — the key every
    // per-cell read uses, and one that survives a control-plane restart (the
    // ledger's run_id does not). Its session id and its own serve URL come from
    // its cell.start record. There is no default cell: none given is a 400.
    method: "GET",
    path: "/api/tui",
    async handle(req, res, url) {
      const cell = parseCellKey(url.searchParams.get("cell"));
      if (!cell) {
        sendJson(res, 400, { error: "cell required: <run_dir>::<sequence_index>" });
        return;
      }
      const sessionId = await cellSessionId(RUNS_ROOT, cell.runDir, cell.sequenceIndex);
      const serveUrl = await cellServeUrl(RUNS_ROOT, cell.runDir, cell.sequenceIndex);
      const running = (await liveRunDirs()).includes(cell.runDir);
      sendJson(res, 200, {
        ...(running ? tui.pollFor(cell.key, sessionId, serveUrl) : tui.notRunning(cell.key, sessionId)),
        // Stated on the surface: this is a second client, not a screen-share.
        note: "second attach client — same session, independent scroll position",
      });
      return;
    },
  },

  {
    method: "POST",
    path: "/api/tui/detach",
    async handle(req, res, url) {
      tui.shutdown();
      sendJson(res, 200, { ok: true, reason: "tui mirror detached and closed" });
      return;
    },
  },

  {
    // ── GET /api/hold ── null when no hold file exists; a file vanishing mid-read
    // is the release succeeding.
    method: "GET",
    path: "/api/hold",
    async handle(req, res, url) {
      sendJson(res, 200, await readHold({ runsRoot: RUNS_ROOT, runDirs: await liveRunDirs() }));
      return;
    },
  },
];

/** The run directories (relative to RUNS_ROOT) of the runs in flight — the only runs a hold can belong to. */
async function liveRunDirs() {
  const state = await readRunState({ runsRoot: RUNS_ROOT });
  return (state.runs ?? []).filter((r) => r.running && r.run_dir).map((r) => r.run_dir);
}

/**
 * The campaign's recorded OFF band, which is where the ON band starts: the
 * harness plans the ON order from start_index=len(off_order)
 * (harness/cumulative/ordering.py build_schedule). Returns
 * `{ off_slots, replicates }`, or null when there is no manifest yet — a fresh
 * campaign holds no baseline, and the caller refuses an ON cell on it.
 *
 * `replicates` is what the baseline was planned with: build_off_order emits
 * `replicates` slots PER roster entry, so the recorded OFF count is
 * roster × replicates. It must divide exactly; a prefix that does not is not an
 * OFF baseline this launcher knows how to extend, and is refused rather than
 * planned from a guess. A manifest that exists but cannot be read throws.
 */
async function recordedOffBand(manifestArg) {
  let raw;
  try {
    raw = await readFile(manifestArg, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  const manifest = JSON.parse(raw);
  const schedule = Array.isArray(manifest?.schedule) ? manifest.schedule : [];
  const offSlots = schedule.filter((s) => s?.memory_mode === "off").length;
  if (offSlots < 1) return { off_slots: 0, replicates: null };

  // The roster the schedule planned for. A manifest from which it is missing
  // cannot be re-derived; the OFF count alone is the single-model case.
  const rosterSize = Array.isArray(manifest?.roster) && manifest.roster.length
    ? manifest.roster.length
    : 1;
  if (offSlots % rosterSize !== 0) {
    throw new Error(
      `${offSlots} recorded OFF slots do not divide into ${rosterSize} roster entries`,
    );
  }
  return { off_slots: offSlots, replicates: offSlots / rosterSize };
}

/** The challenge this campaign started on (from the run manifest), or null. */async function pinnedChallengeFor(manifestArg) {
  if (!manifestArg) return null;
  try {
    const dir = manifestArg.slice(0, manifestArg.lastIndexOf("/"));
    const raw = await readFile(join(dir, "manifest.run-manifest.json"), "utf8");
    const declared = String(JSON.parse(raw)?.challenge ?? "").trim();
    return declared || null;
  } catch {
    return null;
  }
}
