// BENCH CONTROL PLANE — RUN ROUTES. Each entry is { method, path,
// handle(req, res, url) }; paths are wire contract with the board.

import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  RESUME_UNSUPPORTED,
  confirmationToken,
  restatement,
  refuse,
} from "../contract.mjs";
import { readRoster } from "../roster.mjs";
import { readRunState, confirmAlive, findHarnessProcs } from "../runstate.mjs";
import { readHold, releaseHold } from "../hold.mjs";
// Where a cell's measurement lands (one campaign per model).
import { campaignTargetFor } from "../campaign.mjs";
import { captureStatsBaseline } from "../runstats.mjs";
import { notice, noticesPathFor } from "../notices.mjs";
// The benchmark tree (see tree.mjs).
import { ensureTree } from "../tree.mjs";
// The tool registry: preflight failures resolve to the button that fixes them.
import { attachRemedies, describeBuiltinTools } from "../tools.mjs";
import {
  args,
  BENCH_ROOT,
  RUNS_ROOT,
  PYTHON,
  RUN_SCRIPT,
  tui,
  getLauncher,
  setLauncher,
} from "../state.mjs";
import { sendJson, readBody } from "../lib/http.mjs";
import { validateStart } from "../lib/validate.mjs";
import { substrateRefreshInFlight } from "../tooljobs.mjs";
import { stopRun } from "../lib/lifecycle.mjs";

// The stop confirmation token, shared by preview and commit. Bound to the run
// in flight: a new pid, log or start re-mints it and a stale confirmation fails.
function stopToken(state) {
  return createHash("sha256")
    .update(`stop:${state.pid ?? "external"}:${state.log_name ?? ""}:${state.started_at ?? ""}`)
    .digest("hex")
    .slice(0, 12);
}

export const routes = [
  {
    // ── GET /api/run ─────────────────────────────────────────────────────
    method: "GET",
    path: "/api/run",
    async handle(req, res, url) {
      sendJson(res, 200, await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() }));
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
      const run = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
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

      const { model, arm, org, context, kind, cloud, compact, requireTodos, graderWorkerTarget, snapshotId, challenge } = check;
      sendJson(res, 200, {
        ok: true,
        token: confirmationToken({ model, arm, org, context, kind, compact, snapshotId }),
        restatement: restatement({ model, arm, org, context, kind, cloud, compact }),
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
        // The serial rule will block this run; the parameters are still valid.
        blocked_now: run.can_start === true ? null : (run.blocked_reason ?? "a cell is already in flight"),
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
    method: "POST",
    path: "/api/run/start",
    async handle(req, res, url) {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const roster = await readRoster({ proxyUrl: args.proxyUrl, runtimeUrl: args.runtimeUrl });

      if (!roster.proxy_ok) {
        sendJson(res, 503, refuse("upstream_unwired", roster.reason ?? "model proxy unreachable"));
        return;
      }

      const run = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });

      const check = await validateStart(payload, roster, run, { runsRoot: RUNS_ROOT });
      if (!check.ok) {
        sendJson(res, 409, check);
        return;
      }

      const { model, arm, org, context, kind, cloud, compact, requireTodos, graderWorkerTarget, snapshotId, challenge } = check;

      // Argv array, no shell. Main-parser flags precede the subcommand (argparse
      // exits 2 otherwise). Cloud: --cloud --provider <vendor> --model <model half>,
      // which the harness composes into {router}/{provider}/{model}.
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

      argv.push("run", "--mode", arm, compact ? "--compact" : "--no-compact");
      if (requireTodos) argv.push("--require-todos");
      if (graderWorkerTarget != null) {
        argv.push("--grader-worker-target", String(graderWorkerTarget));
      }

      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "");
      // The log goes inside the tree, so retiring the tree retires the log.
      const logDir = tree ? join(RUNS_ROOT, tree) : RUNS_ROOT;
      const logPath = join(logDir, `${arm}-cell-${stamp}.log`);

      // This run's zero for monotonic stat sources, taken before the harness exists
      // (see captureStatsBaseline). Never blocks a launch.
      await captureStatsBaseline({ logPath });

      // Written before the spawn, so a launch that dies at startup still leaves a
      // record that it was attempted.
      await notice(logPath, "run_queued", {
        detail: { model: model ?? null, arm: arm ?? null, context: context ?? null },
      });

      let fh;
      try {
        fh = await open(logPath, "a");
      } catch (err) {
        sendJson(res, 500, refuse("launcher_failed", `cannot open log ${logPath}: ${err?.message ?? err}`));
        return;
      }

      const env = { ...process.env };
      // The harness writes run-scoped notices to the same file; `source` says who
      // spoke. A CLI launch runs identically without it.
      env.BENCH_NOTICES = noticesPathFor(logPath);
      // Context goes through the environment; null = registry default.
      if (context !== null) env.BENCH_WORKER_NUM_CTX = String(context);
      // Read by the harness at import; unset = its own default.
      if (challenge?.dir) env.BENCH_TASK_DIR = challenge.dir;

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
        sendJson(res, 500, refuse("launcher_failed", String(err?.message ?? err)));
        return;
      }

      child.unref();
      await fh.close().catch(() => {});

      // Startup liveness: the harness can die seconds after spawn (usage error,
      // import error, drift guard). Confirm it survived before claiming the run
      // started; if not, the refusal carries the log tail.
      const liveness = await confirmAlive(child.pid, { logPath });
      if (!liveness.ok) {
        sendJson(res, 500, refuse(
          "launch_crashed",
          `harness exited ${liveness.elapsed_ms}ms after launch (see log tail)`,
          { log_path: logPath, pid: child.pid, log_tail: liveness.log_tail },
        ));
        return;
      }

      setLauncher({
        pid: child.pid,
        model,
        arm,
        org,
        context,
        kind,
        started_at: Date.now(),
        log_path: logPath,
      });

      sendJson(res, 200, {
        ok: true,
        pid: child.pid,
        log_path: logPath,
        model,
        arm,
        org,
        context,
        kind,
        cloud: cloud ? { provider: cloud.provider, model: cloud.model, slug: cloud.slug } : null,
        // Where this cell will land, echoed back so a mismatch is visible.
        run_dir: target.run_dir,
        sequence_index: target.sequence_index,
        // null is healthy; non-null means this run is filed outside the tree.
        tree_error,
        restatement: restatement({ model, arm, org, context, kind, cloud }),
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
    // ── POST /api/run/stop/preview ── abort a live cell: preview, then confirm.
    // stopRun sends SIGINT so the harness runs its own teardown (cell, sidecar,
    // volume). An aborted cell has no `progress` and is excluded from the
    // convergence trend, so it can never read as a measurement.
    method: "POST",
    path: "/api/run/stop/preview",
    async handle(req, res, url) {
      const state = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
      if (!state?.running) {
        sendJson(res, 409, refuse("no_run_in_flight", "there is no cell in flight to stop"));
        return;
      }
      const token = stopToken(state);
      // Name the pid that will actually be signalled; stopRun finds a CLI-launched
      // harness too.
      let pidLine = state.pid ? String(state.pid) : null;
      if (pidLine === null) {
        const found = await findHarnessProcs({ runDir: state.run_dir });
        const adopt = found && (found.bound.length ? found.bound : found.other);
        if (adopt && adopt.length) {
          pidLine = `${adopt.map((p) => p.pid).join(", ")} (found by scan — not spawned by this service)`;
        } else if (found === null) {
          pidLine = "unknown — the process scan failed; the stop may find nothing to interrupt";
        } else {
          pidLine = "no harness process found — the stop will only sweep leftover containers";
        }
      }
      sendJson(res, 200, {
        ok: true,
        token,
        restatement:
          `STOP the cell in flight.\n\n` +
          `  model    ${state.model ?? "unobserved"}\n` +
          `  log      ${state.log_name ?? "unknown"}\n` +
          `  pid      ${pidLine}\n` +
          `  started  ${state.started_at ?? "unknown"}\n\n` +
          `The harness is interrupted so it tears its own cell down: the worker\n` +
          `container, the egress sidecar and the session-db volume are removed.\n` +
          `Anything this cell had measured is DISCARDED — a stopped cell writes no\n` +
          `progress, so it is excluded from the convergence trend and can never be\n` +
          `read as a result. Time and spend already incurred are not recoverable.`,
        run: { model: state.model ?? null, pid: state.pid ?? null, log_name: state.log_name ?? null },
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
      const state = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
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
      await stopRun();
      const after = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
      sendJson(res, 200, {
        ok: true,
        stopped: true,
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
    // capture. Polling keeps it alive; it stops when polling stops. The session
    // comes from run state, never from the query string.
    method: "GET",
    path: "/api/tui",
    async handle(req, res, url) {
      const run = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
      sendJson(res, 200, {
        ...tui.poll(run.session_id),
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
