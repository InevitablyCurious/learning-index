// BENCH CONTROL PLANE — EVENT / FEED / STATS ROUTES. Each entry is { method,
// path, handle(req, res, url) }; paths are wire contract with the board.

import { EVENT_RENDER_CAP } from "../contract.mjs";
import { readAgentEvents } from "../agent-events.mjs";
import { EventRing, mergeGrading } from "../events.mjs";
import { readGateActivity } from "../gate-events.mjs";
import { readFeedback, feedbackRows } from "../feedback.mjs";
import { readBackendFeed } from "../backend-feed.mjs";
import { collectStats, readStatsBaseline } from "../runstats.mjs";
import { readRunState, logPathForRunDir } from "../runstate.mjs";
import {
  ring,
  BENCH_ROOT,
  RUNS_ROOT,
  getRingRunDir,
  setRingRunDir,
} from "../state.mjs";
import { sendJson } from "../lib/http.mjs";
import { activeRunDir, watchExternalCounters } from "../lib/lifecycle.mjs";
import { interleaveByArrival } from "../lib/events.mjs";

export const routes = [
  {
    // ── GET /api/events ── the mapped event ring, oldest first (a transcript).
    // `cursor` lets the board fetch only what is new.
    method: "GET",
    path: "/api/events",
    async handle(req, res, url) {
      const requestedRunDir = url.searchParams.get("run_dir");
      if (requestedRunDir) {
        // ?run_dir= reads a past run's persisted transcript (same row shape as the
        // live ring); without it, the live path.
        const since = Number(url.searchParams.get("since") ?? 0) || 0;
        const limitRaw = Number(url.searchParams.get("limit"));
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : null;
        const seqRaw = Number(url.searchParams.get("sequence_index"));
        const sequenceIndex = Number.isInteger(seqRaw) && seqRaw >= 0 ? seqRaw : null;
        // Parsed here: the live branch's binding is declared later (a TDZ throw).
        const kindsRaw = url.searchParams.get("kinds");
        const kinds = kindsRaw ? kindsRaw.split(",").filter(Boolean) : null;
        // The historical read is assembled like the live one: the agent transcript
        // plus the verbatim prompts (worktree.user-events.jsonl), in one EventRing.
        const persisted = await readAgentEvents({ runsRoot: RUNS_ROOT, runDir: requestedRunDir, since: 0, limit: null, sequenceIndex });

        // The prompts, scoped to the cell by sequence_index (absent or
        // unresolvable reads empty, never the newest cell). A read failure
        // degrades to the agent rows alone.
        let promptRows = [];
        try {
          const fb = await readFeedback({ runsRoot: RUNS_ROOT, runDir: requestedRunDir, sequenceIndex, limit: 0 });
          if (fb.ok) promptRows = feedbackRows(fb.messages, { runDir: fb.run_dir, cell: fb.cell });
        } catch {
          promptRows = [];
        }

        // Prompts are slotted into the transcript in arrival order (interleaveByArrival),
        // not appended at the bottom and not time-sorted (many agent rows have no time).
        const histRing = new EventRing(Number.MAX_SAFE_INTEGER);
        // Agent rows are appended (a streaming part legitimately repeats its id);
        // prompt rows are admitted once by identity. Same as the live path.
        const promptIds = new Set(promptRows.map((r) => r.id));
        for (const r of interleaveByArrival(persisted.rows, promptRows)) {
          if (promptIds.has(r.id)) histRing.admit(r);
          else histRing.append(r);
        }

        // Unbounded: a concluded record is finite and complete (the live ring caps
        // at 2000 because it is a window).
        const snapshot = histRing.snapshot({ since, limit: limit ?? Number.MAX_SAFE_INTEGER, kinds });

        // Count the prompt rows too (snapshot.counts covers only the agent kinds).
        const counts = { ...snapshot.counts };
        for (const r of histRing.items) {
          if (r.kind === "harness" || r.kind === "user") counts[r.kind] = (counts[r.kind] ?? 0) + 1;
        }

        sendJson(res, 200, {
          ok: true,
          // Not a socket claim: a complete record is neither live nor stale.
          // `source` and `run_dir` say what it is.
          connected: false,
          reason: "persisted",
          order: "oldest_first",
          events: snapshot.events,
          total: snapshot.total,
          mapped: snapshot.total,
          unmapped: 0,
          returned: snapshot.returned,
          retained: snapshot.retained,
          capped: false,
          windowed: false,
          hidden_by_filter: snapshot.hidden_by_filter ?? 0,
          max: 0,
          cursor: snapshot.cursor,
          counts,
          grading: null,
          run_dir: requestedRunDir,
          sequence_index: sequenceIndex,
          source: "agent-events.jsonl + worktree.user-events.jsonl",
          attached: persisted.attached,
          prompts: promptRows.length,
        });
        return;
      }
      const raw = Number(url.searchParams.get("limit") ?? EVENT_RENDER_CAP);
      const limit = Math.min(EVENT_RENDER_CAP, raw || EVENT_RENDER_CAP);
      const since = Number(url.searchParams.get("since") ?? 0) || 0;
      const kindsRaw = url.searchParams.get("kinds");
      const kinds = kindsRaw ? kindsRaw.split(",").filter(Boolean) : null;
      // The ring is scoped to one run: if the active run changed, reset it before
      // admitting anything. cell_in_flight comes from the same owner as the launch
      // buttons.
      const liveRunState = await readRunState({ runsRoot: RUNS_ROOT });
      const currentRunDir = await activeRunDir();
      if (currentRunDir !== getRingRunDir()) {
        ring.reset();
        setRingRunDir(currentRunDir);
      }
      // The snapshot is taken after out-of-ring rows are admitted, so they appear in
      // this response.

      // A grading-log read failure never takes the agent feed down.
      let gate = { rows: [], status: null };
      try {
        gate = await readGateActivity(RUNS_ROOT);
      } catch (err) {
        gate = { rows: [], status: null, error: String(err?.message ?? err) };
      }

      // The scraped harness rows (gate-attempt/phase/timeout) are not admitted: the
      // event feed is what the model did and was told. The same events, with
      // timestamps, are in live.jsonl and the backend feed. gate.status still drives
      // the grading indicator.

      // The prompts the harness sent the model, as `user` rows (the fiction under
      // test) — only while a cell is actually in flight. On an idle bench the newest
      // run is a concluded one, and its prompts must not read as the live session; a
      // finished run is reached by selecting it.
      const cellInFlight = liveRunState.can_start !== true;
      let feedback = { rows: [], error: null };
      if (cellInFlight) {
        try {
          const fb = await readFeedback({ runsRoot: RUNS_ROOT, runDir: currentRunDir, limit });
          feedback = { rows: fb.ok ? feedbackRows(fb.messages, { runDir: fb.run_dir, cell: fb.cell }) : [], error: null };
        } catch (err) {
          // Additive: a read failure degrades to the agent stream alone.
          feedback = { rows: [], error: String(err?.message ?? err) };
        }
      }

      // Out-of-ring rows are admitted once, by identity, so each gets a stable seq
      // from the ring's own counter (numbering them per request re-appended the same
      // row every poll). Admitted before the snapshot.
      for (const r of feedback.rows) ring.admit(r);
      const snapshot = ring.snapshot({ since, limit, kinds });

      // On a fresh connect, deliver grading rows that aged out of the delta tail,
      // so the chips' counts are filterable.
      if (since === 0) snapshot.events = mergeGrading(snapshot.events, ring.items);

      // Counts include user/harness rows, tallied from the ring the chips filter.
      const counts = { ...snapshot.counts };
      for (const r of ring.items) {
        if (r.kind === "harness" || r.kind === "user") {
          counts[r.kind] = (counts[r.kind] ?? 0) + 1;
        }
      }

      sendJson(res, 200, {
        ...snapshot,
        counts,
        // Whether there is a live cell at all: disconnected-and-crashed vs
        // idle-between-runs want different words.
        cell_in_flight: cellInFlight,
        // The live grading verdict: open phase, silence, alarm.
        grading: gate.status,
      });
      return;
    },
  },

  {
    // ── GET /api/feedback ── the graded text the model was told, verbatim.
    //   ?run_dir=         default the active run
    //   ?sequence_index=  the cell selector; absent (or resolving nowhere)
    //                     reads empty, never the newest cell
    //   ?limit=           default 50, newest last   ?text=0  index only
    method: "GET",
    path: "/api/feedback",
    async handle(req, res, url) {
      const limitRaw = Number(url.searchParams.get("limit"));
      const seqRaw = Number(url.searchParams.get("sequence_index"));
      const sequenceIndex = Number.isInteger(seqRaw) && seqRaw >= 0 ? seqRaw : null;
      const result = await readFeedback({
        runsRoot: RUNS_ROOT,
        runDir: url.searchParams.get("run_dir") ?? (await activeRunDir()),
        sequenceIndex,
        limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50,
        includeText: url.searchParams.get("text") !== "0",
      });
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    },
  },

  {
    // ── GET /api/backend-feed ── what the machinery is doing: the cell's stream
    // plus the run's notice stream, run-scoped like every other read.
    method: "GET",
    path: "/api/backend-feed",
    async handle(req, res, url) {
      const runState = await readRunState({ runsRoot: RUNS_ROOT });
      const requestedRunDir = url.searchParams.get("run_dir");
      // A requested past run uses that run's launch log for its notices.
      const logPath = requestedRunDir
        ? await logPathForRunDir(RUNS_ROOT, requestedRunDir)
        : runState.log_path;
      const seqRaw = Number(url.searchParams.get("sequence_index"));
      const sequenceIndex = Number.isInteger(seqRaw) && seqRaw >= 0 ? seqRaw : null;
      sendJson(
        res,
        200,
        await readBackendFeed({
          runsRoot: RUNS_ROOT,
          runDir: requestedRunDir ?? (await activeRunDir()),
          logPath,
          sequenceIndex,
          // A ?run_dir= read is a finished cell: complete, no tail window or row cap.
          complete: Boolean(requestedRunDir),
        }),
      );
      return;
    },
  },

  {
    // ── GET /api/stats ── bench and custom readouts (control/runstats.mjs). delta
    // stats are scoped to the zero snapshotted when this run was queued; with no
    // zero they read unavailable, never a lifetime total.
    method: "GET",
    path: "/api/stats",
    async handle(req, res, url) {
      const runState = await readRunState({ runsRoot: RUNS_ROOT });
      const baselines = await readStatsBaseline({ logPath: runState.log_path });
      // Run-scoped: the run in view comes from activeRunDir, like /api/wall.
      sendJson(
        res,
        200,
        await watchExternalCounters(
          runState.log_path,
          await collectStats({
            baselines,
            runDir: await activeRunDir(),
            runsRoot: RUNS_ROOT,
            benchRoot: BENCH_ROOT,
          }),
        ),
      );
      return;
    },
  },
];
