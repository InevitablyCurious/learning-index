// ─────────────────────────────────────────────────────────────────────────────
// BENCH CONTROL PLANE — RUN ROUTES (LI-14 phase 2)
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

import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { open } from "node:fs/promises";
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
// WHERE A CELL'S MEASUREMENT LANDS. One campaign directory per model — see the
// module header. Split out so the rule is testable without binding a port.
import { campaignTargetFor } from "../campaign.mjs";
import { captureStatsBaseline } from "../runstats.mjs";
import { notice, noticesPathFor } from "../notices.mjs";
// THE BENCHMARK TREE. Minting is the control plane's act because the board
// container mounts the repo read-only — see tree.mjs for the layout and for
// why a reset rolls forward instead of unlinking.
import { ensureTree } from "../tree.mjs";
// CUSTOM TOOLS. The harness owns the registry — the board renders what this
// serves rather than keeping its own copy that could claim a tool exists.
// /api/preflight resolves each failure's remedy to an actual button through it.
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
import { stopRun } from "../lib/lifecycle.mjs";

// THE STOP CONFIRMATION TOKEN, minted IDENTICALLY by the preview and the
// commit (it was duplicated byte-for-byte at both sites before LI-14 phase 2
// folded them into one owner). It binds the confirmation to the exact run in
// flight: any change between the two — a new pid, a new log, a new start —
// re-mints it and the stale confirmation is refused.
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
    // ── POST /api/run/preview ────────────────────────────────────────────
    // The restatement the UI must show before START. The SERVER composes it so
    // the words the operator reads are the words the server will act on.
    method: "POST",
    path: "/api/run/preview",
    async handle(req, res, url) {
      const payload = JSON.parse((await readBody(req)) || "{}");
      const roster = await readRoster({ proxyUrl: args.proxyUrl, runtimeUrl: args.runtimeUrl });

      // PREVIEW RUNS THE SAME VALIDATION AS START.
      // It previously minted a token for ANY payload, so an ON cell with no org
      // returned 200 and the UI armed a confirm button for a run the server
      // would then refuse. A preview that can green-light an impossible run is
      // worse than no preview: it moves the refusal to after the operator has
      // committed.
      //
      // The serial gate is deliberately EXCLUDED — `can_start` is a fact about
      // right now, not about these parameters, and an operator must be able to
      // review what they intend to run next while a cell is still in flight.
      const run = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
      // EVERY RULE IS CHECKED AT PREVIEW TOO. A preview that green-lights a cell
      // the start will refuse moves the refusal to after the operator has
      // committed — the same defect the org check was moved here to fix.
      const check = await validateStart(
        payload,
        roster,
        { ...run, can_start: true, blocked_reason: null },
        { requireConfirm: false, runsRoot: RUNS_ROOT },
      );
      if (check.ok === false) {
        sendJson(res, 400, check);
        return;
      }

      const { model, arm, org, context, kind, cloud, compact, requireTodos, graderWorkerTarget, snapshotId } = check;
      sendJson(res, 200, {
        ok: true,
        token: confirmationToken({ model, arm, org, context, kind, compact, snapshotId }),
        restatement: restatement({ model, arm, org, context, kind, cloud, compact }),
        // THE RESOLVED ANSWER, RETURNED. The panel proposes a default; the
        // server decides. Echoing it back is what lets the confirmation frame
        // show the operator the value the token was actually minted for rather
        // than the one the panel guessed.
        compact: compact === true,
        requireTodos: requireTodos === true,
        graderWorkerTarget: graderWorkerTarget ?? null,
        // What the operator is committing to, in machine form beside the prose.
        // The confirmation card states the substrate and — for a cloud cell —
        // the vendor and the per-cell spend ceiling, and it must state the same
        // ones the token was minted for rather than the ones the form still has
        // on screen.
        kind,
        cloud: cloud ? { provider: cloud.provider, model: cloud.model, slug: cloud.slug, name: cloud.name } : null,
        // Stated so the UI can show the operator that the serial rule will
        // block this run, WITHOUT pretending the parameters are invalid.
        blocked_now: run.can_start === true ? null : (run.blocked_reason ?? "a cell is already in flight"),
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

      const { model, arm, org, context, kind, cloud, compact, requireTodos, graderWorkerTarget, snapshotId } = check;

      // ARGV ARRAY, NO SHELL. Main-parser flags MUST precede the subcommand —
      // argparse exits 2 otherwise (verified 2026-08-10). This ordering is the
      // documented RUNBOOK invocation, reproduced exactly.
      //
      // ── THE CLOUD INVOCATION IS THE HARNESS'S OWN, NOT A NEW ONE ──────────
      //
      // `--cloud --provider <vendor> --model <model>` is exactly what
      // `_compose_cloud_slug` in run_cumulative.py consumes: it joins them into
      // `{router}/{provider}/{model}` and refuses anything absent from the
      // OrcaRouter provider block. `--model` therefore carries the MODEL HALF of
      // the key on this path, not the whole key — passing `anthropic/claude-…`
      // to `--model` would compose `orcarouter/anthropic/anthropic/claude-…`
      // and be refused by the harness with a message about a model that is not
      // the one the operator picked.
      const argv = [RUN_SCRIPT];
      if (kind === "cloud") {
        argv.push("--cloud", "--provider", cloud.provider, "--model", cloud.model);
      } else {
        argv.push("--model", model);
      }
      if (org) argv.push("--org", org);
      // A cell writes to ITS MODEL'S campaign, not to whichever campaign the
      // default path happens to hold. Omitted when the default is already this
      // model's, so the live campaign's invocation is unchanged.
      //
      // The target is resolved BEFORE the spawn because it is also what the
      // response echoes back — which directory and which cell inside it this
      // launch is about to write.
      //
      // THE TREE IS ENSURED, NOT ASSUMED. A fresh checkout has no tree, and
      // requiring the operator to press reset before the first run would make
      // reset a precondition rather than a wipe. Non-fatal: a bench that cannot
      // mint one falls back to the legacy flat layout rather than refusing a run.
      let tree = null;
      let tree_error = null;
      try {
        tree = (await ensureTree(RUNS_ROOT)).active;
      } catch (err) {
        // The fallback is deliberate and stays. What was missing is the report:
        // a run filed flat in RUNS_ROOT is outside the tree a reset sweeps, so
        // an operator who is never told keeps a run nothing will ever clean.
        tree = null;
        tree_error = String(err?.message ?? err);
        console.error(`[run] tree could not be ensured; filing this run in the legacy flat layout: ${tree_error}`);
      }
      const target = await campaignTargetFor({ model, kind, cloud }, RUNS_ROOT);
      if (target.manifest_arg) argv.push("--manifest", target.manifest_arg);
      // `run` ACCEPTS EXACTLY --mode, --proxy-base-url, --proxy-token-file.
      // `--until-review` was removed from the harness by ba2947a (2026-08-14)
      // and kept here, so argparse rejected the whole invocation before the
      // harness did anything: the child exited on a usage error, the log held
      // nothing but that error, and the board — which infers "running" from the
      // log's existence — reported BUSY over a process that was already dead.
      // Every board-launched cell failed this way. Flags here must be checked
      // against the run subparser, not against memory.
      // ── COMPACTION IS PASSED EXPLICITLY, ALWAYS ─────────────────────────
      //
      // Both forms are sent, never just `--compact` when it is on. The harness
      // flag has no default of its own precisely so this decision is made in
      // exactly one place; passing nothing would hand it back to a default, and
      // the arm the operator confirmed would stop being the arm guaranteed to
      // run.
      // ── THE SEED, IF ONE IS ARMED ───────────────────────────────────────
      //
      // A MAIN-PARSER FLAG, so it goes before the `run` subcommand with the
      // others — argparse exits 2 otherwise. `snapshotId` is null unless dev
      // mode is on AND a seedable snapshot is armed; `validateStart` has
      // already refused the unseedable cases with a quotable reason, so
      // reaching here means the harness will accept it.
      //
      // The harness re-validates independently and may still refuse. That is
      // deliberate duplication, not redundancy: this check exists to refuse
      // before a container is spawned, and that one is the check that cannot
      // be raced by a snapshot deleted between preview and start.
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
      // ── THE LOG GOES IN THE TREE ──────────────────────────────────────────
      //
      // It used to sit at the runs root, where it OUTLIVED every wipe: a stale
      // `off-cell-*.log` kept resolving as the live run, so a wiped bench
      // reported a run in progress until someone hand-deleted the file
      // (runstate.mjs:75). Inside the tree, retiring the tree retires the log,
      // and no cleanup step has to be remembered.
      const logDir = tree ? join(RUNS_ROOT, tree) : RUNS_ROOT;
      const logPath = join(logDir, `${arm}-cell-${stamp}.log`);

      // ── THE RUN'S ZERO IS TAKEN HERE, BEFORE THE HARNESS EXISTS ─────────
      //
      // Monotonic custom sources (the relay's loop-guard counter is the
      // founding one) count for the life of THEIR process, not of this run.
      // Snapshotting at queue time — ahead of the spawn, so the run cannot
      // contribute to its own zero — is what makes the footer's number this
      // run's number. This IS the reset the operator asks for by starting a
      // run; there is no separate button, because a zero that can be taken at
      // any other moment is a zero that can be taken at the wrong one.
      //
      // Never blocks a launch: see captureStatsBaseline.
      await captureStatsBaseline({ logPath });

      // THE FIRST THING THIS RUN'S NOTICE STREAM SAYS. Written before the spawn
      // so a launch that dies during startup still leaves a record that it was
      // attempted — the case where the operator most needs one and previously
      // got a refusal in an HTTP response and nothing on disk.
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
      // THE HARNESS'S OWN RUN-SCOPED NOTICE CHANNEL — the same file this
      // process writes, because both are run-scoped notices about the same run
      // in the same envelope, and a reader should not have to know which
      // process appended a line to read them in order. `source` says who spoke.
      // A CLI-launched harness has nobody to set this and runs identically
      // without it.
      env.BENCH_NOTICES = noticesPathFor(logPath);
      // Context is passed to the worker through the environment rather than a
      // CLI flag because the harness reads it there; `null` means "registry
      // default" and deliberately sets nothing.
      if (context !== null) env.BENCH_WORKER_NUM_CTX = String(context);

      let child;
      try {
        child = spawn(PYTHON, argv, {
          cwd: BENCH_ROOT,
          env,
          // stdin from /dev/null is MANDATORY, not cosmetic: without it the
          // process is suspended the instant it touches stdin, stranding a
          // half-built manifest and a live container. Same reason the RUNBOOK
          // requires `< /dev/null` on the shell launch.
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

      // ── STARTUP LIVENESS CONFIRMATION ───────────────────────────────────
      // The spawn above returns a valid pid the instant the child exists, but
      // the harness can die seconds later — a usage error, an import error, or
      // the chunk-plan drift guard (WO-49: ~11s after spawn, after preflight).
      // Returning ok:true over a process that is already dead is the exact
      // failure that hid WO-49: the operator was told ok, and the dashboard —
      // which keys its run pulse on PROGRESS lines — rendered "no run
      // observed". Ask the kernel whether the process survived its startup
      // window before claiming the run started; if it died, surface the log
      // tail so the refusal names the real error instead of lying.
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
        // Where this cell will land, echoed back. The operator can check it
        // against the row that appears on the board a tick later, and a
        // mismatch is then visible rather than being a silent misattribution.
        run_dir: target.run_dir,
        sequence_index: target.sequence_index,
        // NULL is the healthy state. Non-null means the tree could not be
        // ensured and this run is filed flat in RUNS_ROOT — outside what a
        // reset sweeps. Stated here so the operator learns it now, not when a
        // reset leaves the run behind.
        tree_error,
        restatement: restatement({ model, arm, org, context, kind, cloud }),
      });
      return;
    },
  },

  {
    // ── POST /api/run/resume ─────────────────────────────────────────────
    // ALWAYS REFUSES. The route exists so the refusal is discoverable and
    // carries its reason, rather than 404-ing as if the feature were forgotten.
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
    // ── POST /api/run/stop/preview ───────────────────────────────────────
    //
    // ABORT A LIVE CELL FROM THE BOARD.
    //
    // Preview then confirm, the same shape as a tree reset, because this is a
    // decision with a cost: the cell's work is discarded and its wall-clock and
    // spend are already spent. The restatement names what is actually running so
    // an operator cannot stop the wrong thing from a stale page.
    //
    // WHAT AN ABORTED CELL IS. `stopRun` sends SIGINT rather than SIGTERM
    // precisely so the harness runs its own teardown — the DockerCell context
    // manager removes the cell, the egress sidecar and the session-db volume,
    // and the reaper sweeps the remainder. A killed run therefore leaves no
    // `progress` on its session record, and a record without `progress` is
    // EXCLUDED from the convergence trend by construction
    // (ConvergencePoint.from_session_record returns None). An abort can never be
    // mistaken for a measurement.
    method: "POST",
    path: "/api/run/stop/preview",
    async handle(req, res, url) {
      const state = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
      if (!state?.running) {
        sendJson(res, 409, refuse("no_run_in_flight", "there is no cell in flight to stop"));
        return;
      }
      const token = stopToken(state);
      // THE PID LINE MUST NOT UNDERSELL THE STOP. `state.pid` is null whenever
      // this process did not spawn the harness — a CLI launch, or a control
      // plane that restarted under a live run. It used to read "started
      // outside this service", which an operator reasonably takes to mean the
      // button will not reach it. It does: stopRun scans for the harness and
      // interrupts it either way (see stopRun, "WHOSE HARNESS IS IT"). Name
      // the pid we would actually signal, so the sentence describes the stop
      // that is about to happen rather than the bookkeeping behind it.
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
        // Reported from a re-read rather than assumed. "We sent a signal" is not
        // the same claim as "nothing is running", and only the second is useful.
        still_running: after?.running === true,
        note: after?.running
          ? "the interrupt was sent but a process is still alive — check the run log"
          : "cell stopped and its containers torn down",
      });
      return;
    },
  },

  {
    // ── GET /api/preflight ───────────────────────────────────────────────
    //
    // THE SAME ANSWER THE CLI GIVES, ON THE BOARD.
    //
    // "Why can't I start" was previously answerable only by running
    // scripts/bench_preflight.py in a terminal — so the board could show a dead
    // control and had nothing to say about it. This runs that same script and
    // returns its checks, rather than re-deriving the rules here: two
    // implementations of "can I start" is exactly how a dashboard ends up
    // disagreeing with the CLI about why a button is dead.
    //
    // The script imports a library that greets on stdout, so the JSON is taken
    // from the LAST line that parses — the payload is printed last and alone.
    method: "GET",
    path: "/api/preflight",
    async handle(req, res, url) {
      const model = url.searchParams.get("model") || "";
      // Ask preflight to prove the worker image wires the benchmark's own
      // compaction plugin (images/worker/self-compact.ts) when this run
      // will actually use it. opencode SWALLOWS plugin load errors, so a
      // stale image is otherwise silent right up until every chunk boundary
      // aborts the cell on no_compaction_evidence.
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
      // ── RESOLVE EACH FAILURE'S REMEDY TO AN ACTUAL BUTTON ──────────────
      //
      // Preflight names the tool that repairs a failure by ID and stops there;
      // this side owns the registry that turns an id into a button. See
      // `attachRemedies` in tools.mjs for why the split is where it is. Only the
      // BUILT-IN tools: preflight names nothing else, so this never contacts the
      // custom-tools service.
      attachRemedies(parsed?.checks, describeBuiltinTools(BENCH_ROOT));

      // Exit 1 is a NO-GO, not a transport failure: the verdict travels in the
      // body and the HTTP status stays 200 so the board renders the reasons.
      sendJson(res, 200, parsed);
      return;
    },
  },

  {
    // ── GET /api/tui ─────────────────────────────────────────────────────
    // A frame of the operator's attached view, reconstructed from a read-only
    // pty capture. This route is the keepalive: the capture starts on the first
    // poll and stops itself when polling stops, so a closed drawer does not
    // leave a client attached to a live benchmark session.
    //
    // The session is resolved from run state rather than taken from the query
    // string — a caller-supplied session id would let the board attach a client
    // to an arbitrary session, and the mirror should only ever show the cell
    // that is actually running.
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
    // ── GET /api/hold ────────────────────────────────────────────────────
    // null means no hold file exists. If the file vanishes while being read,
    // that is the release success path, not an error.
    method: "GET",
    path: "/api/hold",
    async handle(req, res, url) {
      sendJson(res, 200, await readHold({ runsRoot: RUNS_ROOT }));
      return;
    },
  },

  {
    // ── POST /api/hold/release ───────────────────────────────────────────
    // Release means create release.path from hold-ui.json. It is idempotent;
    // posting when nothing is held is harmless and returns ok.
    method: "POST",
    path: "/api/hold/release",
    async handle(req, res, url) {
      const result = await releaseHold({ runsRoot: RUNS_ROOT });
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    },
  },
];
