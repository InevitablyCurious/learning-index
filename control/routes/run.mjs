// BENCH CONTROL PLANE — RUN ROUTES. Each entry is { method, path,
// handle(req, res, url) }; paths are wire contract with the board.

import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  RESUME_UNSUPPORTED,
  confirmationToken,
  restatement,
  refuse,
} from "../contract.mjs";
import { readRoster } from "../roster.mjs";
import { readRunState, confirmAlive, cellSessionId, cellServeUrl, readTail } from "../runstate.mjs";
import { readHold, releaseHold } from "../hold.mjs";
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
import { beginChain, endChain, readChain } from "../continuous.mjs";

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

      const { model, arm, org, context, kind, cloud, compact, requireTodos, graderWorkerTarget, snapshotId, challenge, continuous } = check;
      sendJson(res, 200, {
        ok: true,
        token: confirmationToken({ model, arm, org, context, kind, compact, snapshotId, continuous }),
        restatement: restatement({ model, arm, org, context, kind, cloud, compact, continuous }),
        continuous: continuous === true,
        // The resolved compaction answer, so the frame shows what the token was
        // minted for.
        compact: compact === true,
        requireTodos: requireTodos === true,
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

      const { model, arm, org, context, kind, cloud, compact, requireTodos, graderWorkerTarget, snapshotId, challenge, continuous } = check;

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
      // harness has no default). The seed is a main-parser flag; validateStart already
      // refused unseedable cases, and the harness re-checks (a snapshot can vanish
      // between preview and start).
      if (snapshotId) argv.push("--seed-snapshot", snapshotId);

      // The subcommand's position in the shared argv: each cell's
      // --sequence-index (also a main-parser flag) is spliced in just before
      // it, so the N per-cell argv arrays differ in exactly one flag.
      const subcommandAt = argv.length;
      argv.push("run", "--mode", arm, compact ? "--compact" : "--no-compact");
      if (requireTodos) argv.push("--require-todos");
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

      // ── PRE-FLIGHT THE WHOLE BATCH ── N distinct indices and N open logs,
      // ALL before the first spawn. Any cell that cannot be prepared refuses
      // the whole batch and what was prepared is cleaned up: a half-launched
      // batch is worse than a refused one.
      const batch = [];
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
            detail: { model: model ?? null, arm: arm ?? null, context: context ?? null },
          });
        }
      } catch (err) {
        // Nothing was spawned: prepared-but-unused logs are ghosts the run
        // state would read as live-by-default, so the batch leaves no trace.
        await Promise.all(batch.map(async (cell) => {
          await cell.fh.close().catch(() => {});
          for (const f of [cell.log_path, noticesPathFor(cell.log_path), baselinePathFor(cell.log_path)]) {
            await unlink(f).catch(() => {});
          }
        }));
        sendJson(res, 500, refuse(
          "launcher_failed",
          `batch of ${concurrency} refused: cell ${batch.length + 1} could not be prepared — ${err?.message ?? err}`,
          { requested: concurrency, prepared: batch.length },
        ));
        return;
      }

      // ── LAUNCH THE BATCH ── per cell: splice its index into the shared
      // argv, spawn detached, and take the ledger slot at spawn. The env base
      // is shared; only BENCH_NOTICES is per cell.
      const env = { ...process.env };
      // Context goes through the environment; null = registry default.
      if (context !== null) env.BENCH_WORKER_NUM_CTX = String(context);
      // Read by the harness at import; unset = its own default.
      if (challenge?.dir) env.BENCH_TASK_DIR = challenge.dir;

      for (const cell of batch) {
        const cellArgv = [
          ...argv.slice(0, subcommandAt),
          "--sequence-index", String(cell.sequence_index),
          // EVERY cell of the batch plans the same N slots. Without this the
          // schedule holds one session per model, the allocator hands out
          // 0..N-1, and every cell after the first dies seconds in on
          // "sequence_index 2 out of range". Sent on the OFF arm only: an ON
          // cell is a single measurement against the floor.
          ...(arm === "on" ? [] : ["--off-replicates", String(concurrency)]),
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
          context,
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

      // Continuous mode: this launch is the chain's first run (control/continuous.mjs
      // starts every later one). Not recorded = it will not chain, and says so.
      let chain = null;
      if (continuous) {
        try {
          chain = await beginChain({
            benchRoot: BENCH_ROOT,
            payload,
            link: {
              run_id: runs[0].run_id,
              run_dir: target.run_dir,
              sequence_index: runs[0].sequence_index,
              log_path: runs[0].log_path,
              seeded_from: snapshotId ?? null,
              started_at: Date.now(),
            },
          });
        } catch (err) {
          sendJson(res, 500, refuse(
            "continuous_not_recorded",
            `the run started (pid ${runs[0].pid ?? "?"}), but continuous mode could not be recorded, ` +
              `so it will not chain — ${err?.message ?? err}`,
            { runs, tree_error },
          ));
          return;
        }
      }

      sendJson(res, 200, {
        ok: true,
        runs,
        ...(chain ? { continuous: chain } : {}),
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
    // ── POST /api/run/resume ── always refuses, with its reason (see
    // RESUME_UNSUPPORTED).
    method: "POST",
    path: "/api/run/resume",
    async handle(req, res, url) {
      sendJson(res, 501, refuse("resume_unsupported", RESUME_UNSUPPORTED.reason, {
        alternative: RESUME_UNSUPPORTED.alternative,
      }));
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
      // Stopping the run stops continuous mode too, before the run's end can
      // start the next one. Recorded with the operator as the reason.
      const chainWasActive = (await readChain({ benchRoot: BENCH_ROOT }))?.active === true;
      if (chainWasActive) {
        await endChain({ benchRoot: BENCH_ROOT, code: "operator_stop", reason: "the operator stopped the run" });
      }
      const done = await stopAll();
      const after = await readRunState({ runsRoot: RUNS_ROOT });
      sendJson(res, 200, {
        ok: true,
        stopped: true,
        // Only when this stop ended a running chain.
        ...(chainWasActive ? { continuous_ended: true } : {}),
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
      sendJson(res, 200, {
        ...tui.pollFor(cell.key, sessionId, serveUrl),
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
      sendJson(res, 200, await readHold({ runsRoot: RUNS_ROOT }));
      return;
    },
  },

  {
    // ── POST /api/hold/release ── idempotent.
    method: "POST",
    path: "/api/hold/release",
    async handle(req, res, url) {
      const result = await releaseHold({ runsRoot: RUNS_ROOT });
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    },
  },
];

/** The challenge this campaign started on (from the run manifest), or null. */
async function pinnedChallengeFor(manifestArg) {
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
