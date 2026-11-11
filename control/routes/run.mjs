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
// Where a cell's measurement lands (one campaign per model), resolved before
// launch and echoed back. The index it reports is the manifest's own
// current_index — a claim, never a counter this process keeps.
import { campaignTargetFor } from "../campaign.mjs";
import { resolveDevMode } from "../devmode.mjs";
import { baselinePathFor, captureStatsBaseline } from "../runstats.mjs";
import { notice, noticesPathFor } from "../notices.mjs";
// The benchmark tree (see tree.mjs).
import { ensureTree } from "../tree.mjs";
// The tool registry: preflight failures resolve to the button that fixes them.
import { attachRemedies, describeBuiltinTools } from "../tools.mjs";
// The run ledger: every cell this service spawns holds a slot, written through
// to the durable cell registry, so the cells in flight — one per model, since a
// model is serial — are tracked at once and survive a control-plane restart
// (the launcher singleton is gone).
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
      // The pause after each grade is a property of the SERVER's dev mode, not
      // a per-run flag: it is read here (and used by start) so a preview never
      // promises a run shape the start would not produce.
      const devPause = (await resolveDevMode({ benchRoot: BENCH_ROOT })).enabled === true;
      const check = await validateStart(
        payload,
        roster,
        { ...run, can_start: true, blocked_reason: null },
        { requireConfirm: false, runsRoot: RUNS_ROOT, allowRefresh: true, devPause },
      );
      if (check.ok === false) {
        sendJson(res, 400, check);
        return;
      }

      const { model, arm, org, kind, cloud, compact, requireTodos, graderWorkerTarget, challenge, resume } = check;
      sendJson(res, 200, {
        ok: true,
        token: confirmationToken({ model, arm, org, kind, compact, devPause, resume }),
        restatement: restatement({ model, arm, org, kind, cloud, compact, devPause, resume }),
        resume: resume ? { checkpoint: resume.rel, phase: resume.phase } : null,
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
    // ONE request launches ONE cell. The harness owns the sequence: it is
    // spawned with `run --mode <arm>` and appends the next cell to its campaign
    // itself, so a click is exactly one cell and a control-plane restart cannot
    // re-issue an index (there is no cursor here to reseed). The one exception
    // is the model's own serial rule (run-ledger.mjs): a second request for a
    // model already in flight is refused, never queued.
    method: "POST",
    path: "/api/run/start",
    async handle(req, res, url) {
      const payload = JSON.parse((await readBody(req)) || "{}");

      const roster = await readRoster({ proxyUrl: args.proxyUrl, runtimeUrl: args.runtimeUrl });

      if (!roster.proxy_ok) {
        sendJson(res, 503, refuse("upstream_unwired", roster.reason ?? "model proxy unreachable"));
        return;
      }

      const run = await readRunState({ runsRoot: RUNS_ROOT });

      // The pause after each grade is the SERVER's dev mode, never a request
      // field: dev mode is on for operator review, off for an unattended
      // measurement. Bound into the token below so preview and start agree.
      const devPause = (await resolveDevMode({ benchRoot: BENCH_ROOT })).enabled === true;

      const check = await validateStart(payload, roster, run, { runsRoot: RUNS_ROOT, devPause });
      if (!check.ok) {
        sendJson(res, 409, check);
        return;
      }

      const { model, arm, org, kind, cloud, compact, requireTodos, graderWorkerTarget, challenge, resume } = check;

      // Argv array, no shell. Main-parser flags precede the subcommand
      // (argparse exits 2 otherwise). Cloud: --cloud --provider <vendor>
      // --model <model half>, which the harness composes into
      // {router}/{provider}/{model}.
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
      // harness has no default). The harness APPENDS the cell itself, so there
      // is no --sequence-index and no plan size on this argv: one click, one
      // append, and the harness's own ordinal is the cell's address.
      argv.push("run", "--mode", arm, compact ? "--compact" : "--no-compact");
      if (requireTodos) argv.push("--require-todos");
      // Pause after each grade is the dev-mode capability (devmode.mjs): the
      // harness flag is the only pause mechanism, and the server decides it.
      if (devPause) argv.push("--pause-after-grade");
      // Dev loop step 6: validated (dev mode only, a real check-point under the
      // runs root, a known phase) and bound into the token above.
      if (resume) {
        argv.push("--resume-checkpoint", resume.checkpoint, "--resume-phase", String(resume.phase));
      }
      if (graderWorkerTarget != null) {
        argv.push("--grader-worker-target", String(graderWorkerTarget));
      }

      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "");
      // The logs go inside the tree, so retiring the tree retires the logs.
      const logDir = tree ? join(RUNS_ROOT, tree) : RUNS_ROOT;
      // The cell's position, as its campaign manifest records it immediately
      // before spawn (campaignTargetFor). The harness owns the append, so this
      // is a CLAIM, not an address the harness is handed: the ledger and the log
      // name carry it, and every reader resolves a cell by requiring its own
      // directory (cellDirForRun) — a stale claim resolves nothing, never
      // another cell.
      const sequenceIndex = target.sequence_index;
      // The name keeps runstate.mjs's scan pattern (/^(off|on)-cell-|^cell-/)
      // and gate-events.mjs's -s<NNNN>.log suffix.
      const logPath = join(
        logDir,
        `${arm}-cell-${stamp}-s${String(sequenceIndex).padStart(4, "0")}.log`,
      );

      // ── PREPARE THE ONE CELL ── the log is opened and the notices/stat
      // baseline are written BEFORE the spawn, so a launch that dies at startup
      // still leaves a record that it was attempted; a launch that never
      // happens leaves no ghost log behind.
      const runId = newRunId();
      let fh;
      try {
        fh = await open(logPath, "a");
        // This run's zero for monotonic stat sources, taken before the harness
        // exists (see captureStatsBaseline). Never blocks a launch.
        await captureStatsBaseline({ logPath });
        await notice(logPath, "run_queued", {
          detail: { model: model ?? null, arm: arm ?? null },
        });
      } catch (err) {
        await fh?.close().catch(() => {});
        await discardCellFiles(logPath);
        sendJson(res, 500, refuse(
          "launcher_failed",
          `the cell could not be prepared — ${err?.message ?? err}`,
          { log_path: logPath },
        ));
        return;
      }

      // ── LAUNCH THE CELL ── spawn detached and take the ledger slot at spawn.
      const env = { ...process.env };
      // Read by the harness at import; unset = its own default.
      if (challenge?.dir) env.BENCH_TASK_DIR = challenge.dir;
      // The harness writes run-scoped notices to the same file; `source` says
      // who spoke. A CLI launch runs identically without it.
      env.BENCH_NOTICES = noticesPathFor(logPath);

      let child;
      try {
        child = spawn(PYTHON, argv, {
          cwd: BENCH_ROOT,
          env,
          // stdin from /dev/null is mandatory: touching stdin would suspend the process.
          stdio: ["ignore", fh.fd, fh.fd],
          detached: true,
          shell: false,
        });
      } catch (err) {
        await fh.close().catch(() => {});
        await discardCellFiles(logPath);
        sendJson(res, 500, refuse(
          "launcher_failed",
          `spawn failed: ${err?.message ?? err}`,
          { log_path: logPath },
        ));
        return;
      }
      // The durable end-record: the cell is detached and can outlive this
      // request, so its exit is captured HERE — code/signal plus a log tail
      // — and merged into its launch record. A cell that ends is recorded as
      // ended with a reason, never erased. The handler must never throw.
      child.on("exit", (code, signal) => {
        try {
          const reason = signal ? `signal ${signal}` : `exit ${code ?? "?"}`;
          void readTail(logPath, 8192)
            .catch(() => "")
            .then((tail) => {
              try {
                recordCellEnded(runId, target.run_dir, {
                  reason,
                  code,
                  signal,
                  log_tail: tail || null,
                });
              } catch (err2) {
                console.error(`[run] exit record failed for ${runId}: ${err2?.message ?? err2}`);
              }
            });
        } catch (err2) {
          console.error(`[run] exit handler failed for ${runId}: ${err2?.message ?? err2}`);
        }
      });
      child.unref();
      await fh.close().catch(() => {});
      const pid = child.pid ?? null;

      // The ledger slot at spawn: the cell is tracked from the moment its
      // harness exists — through the startup window below — and the slot is
      // written through to the durable cell registry, so a control-plane
      // restart loses no pid. A cell that does not survive the window is
      // recorded ended there; the ledger never vouches for a dead cell.
      registerRun({
        run_id: runId,
        sequence_index: sequenceIndex,
        model,
        arm,
        kind,
        org,
        manifest_arg: target.manifest_arg ?? null,
        pid,
        started_at: Date.now(),
        log_path: logPath,
        run_dir: target.run_dir,
        finished: false,
        terminal_status: null,
        terminal_ok: null,
        ended: null,
      });

      // Startup liveness: the harness can die seconds after spawn (usage error,
      // import error, drift guard). Confirm it survived before claiming the cell
      // started; a cell that did not is recorded ended — durably, with the
      // reason — and refused with its log tail.
      const liveness = await confirmAlive(pid, { logPath });
      if (!liveness.ok) {
        recordCellEnded(runId, target.run_dir, {
          reason: "startup failed",
          code: null,
          signal: null,
          log_tail: liveness.log_tail ?? null,
        });
        sendJson(res, 500, refuse(
          "launch_crashed",
          `harness exited ${liveness.elapsed_ms}ms after launch (see log tail)`,
          { pid, log_path: logPath, tree_error, log_tail: liveness.log_tail ?? null },
        ));
        return;
      }

      // null tree_error is healthy; non-null means this run is filed outside
      // the tree. The dashboard's start consumer reads pid/log_path off it.
      sendJson(res, 200, { ok: true, pid, log_path: logPath, tree_error });
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
 * A prepared cell that never launches leaves no trace: its log, the notices
 * file beside it and its stat baseline are ghosts the run state could read as
 * live. Unlink all three, ignoring what is not there.
 */
async function discardCellFiles(logPath) {
  for (const f of [logPath, noticesPathFor(logPath), baselinePathFor(logPath)]) {
    await unlink(f).catch(() => {});
  }
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
