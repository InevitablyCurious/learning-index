// ─────────────────────────────────────────────────────────────────────────────
// BENCH CONTROL PLANE — EVENT / FEED / STATS ROUTES (LI-14 phase 2)
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

import { EVENT_RENDER_CAP } from "../contract.mjs";
import { readAgentEvents } from "../agent-events.mjs";
import { EventRing, mergeGrading } from "../events.mjs";
import { readGateActivity } from "../gate-events.mjs";
import { readFeedback, feedbackRows } from "../feedback.mjs";
import { readBackendFeed } from "../backend-feed.mjs";
import { collectStats, readStatsBaseline } from "../runstats.mjs";
import { readRunState, logPathForRunDir, cellDirForRun } from "../runstate.mjs";
import {
  ring,
  BENCH_ROOT,
  RUNS_ROOT,
  getLauncher,
  getRingRunDir,
  setRingRunDir,
} from "../state.mjs";
import { sendJson } from "../lib/http.mjs";
import { activeRunDir, watchExternalCounters } from "../lib/lifecycle.mjs";
import { interleaveByArrival } from "../lib/events.mjs";

export const routes = [
  {
    // ── GET /api/events ──────────────────────────────────────────────────
    // Polled snapshot of the mapped ring, OLDEST-FIRST (it is a transcript,
    // not a ticker). `cursor` lets the board fetch only what is new without
    // holding a second SSE connection open.
    //
    // HARNESS GRADING ROWS ARE MERGED IN HERE (WO-GRADE-VIS-1). They come from
    // a different source than every other row — the harness's own PROGRESS
    // lines in the run log, not the worker's SSE stream — because during
    // grading the worker is idle BY DESIGN and its stream says nothing. Without
    // them the feed goes silent for the length of a grade (measured at 32
    // minutes on 2026-08-12) and a working run is indistinguishable from a
    // wedged one.
    //
    // They are APPENDED rather than interleaved by timestamp: grading happens
    // between agent turns, so appending preserves true chronology, and the
    // harness's naive local timestamps cannot be compared against the worker's
    // epoch times without reintroducing the timezone defect documented at
    // contract.mjs STALL_THRESHOLD_S.
    method: "GET",
    path: "/api/events",
    async handle(req, res, url) {
      const requestedRunDir = url.searchParams.get("run_dir");
      if (requestedRunDir) {
        // Persisted read for a past/selected run — agent events from disk, in the
        // SAME BoardEvent row shape the live ring serves (so the feed renderer is
        // reusable unchanged). Passing ?run_dir= always reads the persisted
        // transcript (never the live ring); omitting it keeps the live path.
        const since = Number(url.searchParams.get("since") ?? 0) || 0;
        const limitRaw = Number(url.searchParams.get("limit"));
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : null;
        const seqRaw = Number(url.searchParams.get("sequence_index"));
        const sequenceIndex = Number.isInteger(seqRaw) && seqRaw >= 0 ? seqRaw : null;
        // Parsed HERE rather than read from the live branch's own binding below:
        // that one is declared after this block, so reaching it from inside the
        // branch is a temporal-dead-zone throw, not a fallthrough. The board
        // filters client-side today, so this is normally null.
        const kindsRaw = url.searchParams.get("kinds");
        const kinds = kindsRaw ? kindsRaw.split(",").filter(Boolean) : null;
        // ── THE HISTORICAL READ IS THE SAME ASSEMBLY AS THE LIVE ONE ──────
        //
        // The live feed is not one source. It is the model's own stream PLUS
        // the verbatim prompts the harness handed it, rebuilt from
        // `worktree.user-events.jsonl` and admitted into the ring on every poll
        // (see the live branch below). This branch read only the agent
        // transcript, so a concluded run reported `user: 0` and showed every
        // tool the model called and NOTHING it was called on — the prompts sat
        // on disk, unread, while the card claimed the feed was complete.
        //
        // So it is rebuilt HERE THE SAME WAY: one EventRing, both sources
        // admitted, one snapshot. Same class, same serialization, same shape —
        // the two paths cannot drift into showing different things, because
        // below the sources they are one path.
        const persisted = await readAgentEvents({ runsRoot: RUNS_ROOT, runDir: requestedRunDir, since: 0, limit: null, sequenceIndex });

        // THE PROMPTS. Cell-scoped when a sequence_index was given, so a
        // multi-cell campaign does not fold another cell's prompts into this
        // one. A read failure degrades to the agent rows alone rather than
        // taking the whole feed down — additive instrumentation, same rule the
        // live branch applies.
        let promptRows = [];
        try {
          const cellName = sequenceIndex != null
            ? (await cellDirForRun(RUNS_ROOT, requestedRunDir, sequenceIndex))?.cellName ?? null
            : null;
          const fb = await readFeedback({ runsRoot: RUNS_ROOT, runDir: requestedRunDir, cell: cellName, limit: 0 });
          if (fb.ok) promptRows = feedbackRows(fb.messages, { runDir: fb.run_dir, cell: fb.cell });
        } catch {
          promptRows = [];
        }

        // ── ORDER IS RECONSTRUCTED BY TIME, NOT BY ADMISSION ─────────────────
        //
        // On a LIVE run these rows interleave correctly for free: each is
        // admitted at the moment it first appears in the files, so the ring's
        // own counter puts it in place. A rebuild has no such moment — admitting
        // every agent row and then every prompt would file all ten prompts at
        // the BOTTOM of a four-thousand-row transcript, which is not the feed
        // the operator watched. Both families carry `at`, so the merge sorts on
        // it and the ring numbers them in that order.
        const histRing = new EventRing(Number.MAX_SAFE_INTEGER);
        // TWO ADMISSION RULES, MATCHED TO HOW EACH SOURCE ARRIVES. Agent rows
        // are APPENDED — many legitimately share an id (a streaming part emits
        // `message.part.updated` repeatedly as it grows), and deduping them
        // collapsed a 4,312-row transcript to 2,116. Prompt rows are ADMITTED,
        // because that family is rebuilt from files and dedupes on identity.
        // This is exactly what the live path does; only the entry points differ.
        const promptIds = new Set(promptRows.map((r) => r.id));
        for (const r of interleaveByArrival(persisted.rows, promptRows)) {
          if (promptIds.has(r.id)) histRing.admit(r);
          else histRing.append(r);
        }

        // UNBOUNDED, DELIBERATELY. The live ring caps at EVENT_RING_MAX (2000)
        // because it is a window onto something still happening. A concluded
        // record is finite and complete, and trimming it here would silently
        // drop 2,312 rows of a 4,312-row run while the header went on reporting
        // the total.
        const snapshot = histRing.snapshot({ since, limit: limit ?? Number.MAX_SAFE_INTEGER, kinds });

        // Same tally the live branch performs: `snapshot.counts` initialises
        // only the five agent kinds, so the prompt rows are counted on top or
        // their filter chip reads 0 over rows it can actually select.
        const counts = { ...snapshot.counts };
        for (const r of histRing.items) {
          if (r.kind === "harness" || r.kind === "user") counts[r.kind] = (counts[r.kind] ?? 0) + 1;
        }

        sendJson(res, 200, {
          ok: true,
          // NOT a socket claim. This branch reads files; `connected` is what the
          // board reads to decide whether the counts on screen are live or
          // frozen, and a complete record is neither stale nor disconnected.
          // `source` and `run_dir` say what it actually is.
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
      // THE RING IS SCOPED TO ONE RUN. Resolve the active run dir fresh on every
      // request; if it changed since the last poll, reset the ring BEFORE
      // admitting anything so the previous run's rows — pinned and never
      // evicted — are not served against this one. User/harness rows are rebuilt
      // from files and re-admitted in this same request, so a reset loses
      // nothing the files still hold.
      // WHETHER A CELL IS ACTUALLY RUNNING — the same fact /api/models-ledger
      // gates its launch buttons on (`can_start !== true`), read from the same
      // owner so the feed and the buttons cannot disagree about it.
      const liveRunState = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
      const currentRunDir = await activeRunDir();
      if (currentRunDir !== getRingRunDir()) {
        ring.reset();
        setRingRunDir(currentRunDir);
      }
      // THE SNAPSHOT IS TAKEN BELOW, AFTER the out-of-ring rows are admitted —
      // otherwise a row admitted on this request would not appear until the
      // next poll, and `cursor` would advance past it in the meantime.

      // Never let a log-read failure take the agent feed down: grading rows are
      // additive instrumentation, and the feed must degrade to exactly its
      // previous behaviour if they are unavailable.
      let gate = { rows: [], status: null };
      try {
        gate = await readGateActivity(RUNS_ROOT);
      } catch (err) {
        gate = { rows: [], status: null, error: String(err?.message ?? err) };
      }

      // ── THE SCRAPED HARNESS ROWS NO LONGER ENTER THIS FEED ───────────────
      //
      // `gate.rows` is still read — `gate.status` drives the grading indicator
      // below — but the ROWS are not admitted any more (2026-09-07 ruling).
      //
      // The EVENT FEED is what the MODEL did and what the model was TOLD. The
      // four row types this reader produces (gate-attempt-start,
      // gate-phase-start, gate-phase-end, gate-timeout) are none of those: they
      // are what the HARNESS did to it, which is the BACKEND FEED.
      //
      // They were also broken here in a way that could not be fixed in place.
      // They are scraped from `PROGRESS step=…` log lines, which carry NO
      // TIMESTAMP, so every one of them rendered with a blank time column and
      // could not be ordered against anything. The identical events are already
      // in the cell's `live.jsonl` — `phase.start`, `gate.result`, `attempt.end`
      // — WITH times, which is what the backend feed reads. So this is the
      // removal of a timestamp-less duplicate, not the loss of a signal.

      // GRADED TEXT ROWS ARE MERGED IN TOO (WO-FEEDBACK-1). The harness renders
      // gate results into prose and hands it to the model AS A USER TURN. That
      // message is the single most consequential input the model receives and
      // it appeared nowhere in this feed — the worker's SSE stream shows only
      // what the model did with it, never what it was given.
      //
      // They carry `kind:"user"` deliberately: on this board they ARE user
      // turns, which is exactly the fiction under test. Labelling them
      // "harness" would quietly answer the question the operator opened the
      // feed to judge.
      //
      // ── ONLY WHILE A CELL IS ACTUALLY IN FLIGHT ──────────────────────────
      //
      // `activeRunDir()` resolves the NEWEST run directory on disk, running or
      // not. So on an idle bench this read reached into the last CONCLUDED run
      // and served its prompts as live rows — and the live card then reported
      // `tool 0 · file 0 · thinking 0 · error 0 · lifecycle 0 · user 10` under a
      // subtitle naming that finished cell.
      //
      // That is a misattribution, not a cosmetic one: the card claimed a
      // concluded run's prompts were the live session, so it read exactly like a
      // BROKEN HISTORICAL FEED — ten rows of a four-thousand-row run, with every
      // agent count at zero. An operator reasonably concluded the persisted
      // transcript was empty when it was 1.7MB on disk and served correctly by
      // the ?run_dir= path all along.
      //
      // A finished run's record is reachable — by SELECTING it, which is what
      // the DATA FEED card's baseline selector is for. The live feed's job is
      // the live cell, and when there is no live cell its honest answer is
      // nothing.
      const cellInFlight = liveRunState.can_start !== true;
      let feedback = { rows: [], error: null };
      if (cellInFlight) {
        try {
          const fb = await readFeedback({ runsRoot: RUNS_ROOT, runDir: currentRunDir, limit });
          feedback = { rows: fb.ok ? feedbackRows(fb.messages, { runDir: fb.run_dir, cell: fb.cell }) : [], error: null };
        } catch (err) {
          // Additive instrumentation: a read failure must degrade the feed to its
          // previous behaviour, never take the agent stream down with it.
          feedback = { rows: [], error: String(err?.message ?? err) };
        }
      }

      // ── ADMIT THE OUT-OF-RING ROWS ONCE, THEN LET THE RING DO EVERYTHING ───
      //
      // THE ORIGINAL DEFECT: gate rows and feedback rows are built OUTSIDE
      // EventRing, so they never passed through `push()` — the only thing that
      // assigns `seq`. They reached the client with `seq: undefined`, and the
      // renderer appends incrementally with
      //   rows.filter((e) => (e.seq ?? -1) > renderedSeq)     [live.js]
      // so every one of them scored -1 and NOTHING WAS EVER APPENDED.
      //
      // THE DEFECT THAT FIX INTRODUCED, AND THIS ONE CLOSES: numbering them at
      // request time from `snapshot.cursor` made the seq a function of a MOVING
      // base. These rows are rebuilt from files on every poll, so the same row
      // was re-sequenced every time, cleared the append gate again, and was
      // appended again. Measured on a live run: one `task chunk (attempt 1)`
      // came back as seq 706, then 713, then higher, and the operator saw it
      // repeated down the whole feed.
      //
      // Admitting each row ONCE, by identity, fixes both at the source: the row
      // takes a seq from the ring's own counter (so it cannot collide with a
      // real upstream seq), and `since` / `cursor` / `capped` need no special
      // case here at all. See EventRing.admit().
      //
      // Admission happens BEFORE the snapshot is taken, so a newly-admitted row
      // appears in this very response rather than one poll later.
      for (const r of feedback.rows) ring.admit(r);
      const snapshot = ring.snapshot({ since, limit, kinds });

      // Deliver grading rows that have aged out of the delta tail on a FRESH
      // connect (`since === 0`): the user/harness chips count the whole ring, so
      // the rows those chips count must actually be filterable on the board.
      // Grading rows are low-volume and admitted-once; the client pins them
      // against its own window trim after this first delivery.
      if (since === 0) snapshot.events = mergeGrading(snapshot.events, ring.items);

      // Counts must reflect what the operator can filter on, including the
      // grading rows — a chip whose count is always 0 reads as "never happens".
      // `snapshot.counts` initialises only the five agent kinds and skips any
      // others, so `harness` and `user` are still tallied here; they are counted
      // from the RING (not from the freshly-read files) so the number describes
      // the same population the filter chips actually select from.
      const counts = { ...snapshot.counts };
      for (const r of ring.items) {
        if (r.kind === "harness" || r.kind === "user") {
          counts[r.kind] = (counts[r.kind] ?? 0) + 1;
        }
      }

      sendJson(res, 200, {
        ...snapshot,
        counts,
        // WHETHER THERE IS A LIVE CELL AT ALL. `connected:false` alone cannot
        // answer this: the stream is equally unreachable when a run has crashed
        // and when the bench is simply idle, and those want opposite words on
        // screen — one is a fault, the other is the normal resting state. The
        // card reads this to tell them apart.
        cell_in_flight: cellInFlight,
        // The live grading verdict: which phase is open, how long it has been
        // silent, and whether that exceeds the alarm threshold.
        grading: gate.status,
      });
      return;
    },
  },

  {
    // ── GET /api/feedback ────────────────────────────────────────────────
    // The graded text, VERBATIM — exactly what the model was told a user sent.
    //
    // This is the surface for judging the fiction: the harness renders gate
    // results into prose and delivers it as a user turn, and until this existed
    // nobody could read those bytes. It does not summarise or re-render; a
    // surface that prettified the text would answer a different question than
    // the one an operator is asking when they open it.
    //
    //   ?run_dir=<name>   default: the ACTIVE run (see `activeRunDir`)
    //   ?cell=<name>      default: the most recently written cell
    //   ?limit=<n>        default 50, newest-last
    //   ?text=0           omit bodies (index only)
    method: "GET",
    path: "/api/feedback",
    async handle(req, res, url) {
      const limitRaw = Number(url.searchParams.get("limit"));
      const result = await readFeedback({
        runsRoot: RUNS_ROOT,
        runDir: url.searchParams.get("run_dir") ?? (await activeRunDir()),
        cell: url.searchParams.get("cell"),
        limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50,
        includeText: url.searchParams.get("text") !== "0",
      });
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    },
  },

  {
    // ── GET /api/backend-feed ────────────────────────────────────────────
    // WHAT THE MACHINERY IS DOING, merged from every process that writes a
    // record: the cell's own stream and the run-scoped notice stream. The
    // EVENT FEED beside it shows the AGENT, and goes correctly silent between
    // attempts — which is exactly when this one has the most to say.
    //
    // Run-scoped like every other read here, resolved by `activeRunDir` and
    // `readRunState` so it can never disagree with the board about which run is
    // on screen.
    method: "GET",
    path: "/api/backend-feed",
    async handle(req, res, url) {
      const runState = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
      const requestedRunDir = url.searchParams.get("run_dir");
      // When a specific (possibly past) run is requested, resolve THAT run's
      // launch log so the notices half comes from the same run, not the active
      // one. No ?run_dir= → active run (existing behavior).
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
          // A ?run_dir= READ IS A REVIEW OF A FINISHED CELL, so it is complete.
          // The tail window and the row cap exist for the live path, where the
          // stream grows without bound and the recent end is what matters; on a
          // concluded cell they hide the START of the run — the build phases,
          // the cell's own opening — which is what a reviewer opened it for.
          complete: Boolean(requestedRunDir),
        }),
      );
      return;
    },
  },

  {
    // ── GET /api/stats ───────────────────────────────────────────────────
    // THE ONE NUMBERS SURFACE the ledger footer draws from: `bench` (native to
    // the benchmark, true for any clone) and `custom` (contributed through
    // BENCH_STATS_MANIFEST, readings off services the CONTRIBUTOR runs and
    // the bench does not ship). Two arrays, one entry shape, never merged —
    // see control/runstats.mjs for why the boundary is drawn there and not on
    // the board.
    //
    // MONOTONIC SOURCES ARE SCOPED TO THE RUN HERE. A `"mode": "delta"` stat is
    // reported against the zero snapshotted when THIS run was queued, resolved
    // from the same `readRunState` the rest of the board keys on — so the
    // number in the footer belongs to the run named above it. Absent a
    // baseline the stat reads `unavailable`; it never falls back to the
    // source's lifetime total, which is the bug this replaced.
    method: "GET",
    path: "/api/stats",
    async handle(req, res, url) {
      const runState = await readRunState({ runsRoot: RUNS_ROOT, launcher: getLauncher() });
      const baselines = await readStatsBaseline({ logPath: runState.log_path });
      // THE NATIVE READOUTS ARE RUN-SCOPED, so the run in view travels with the
      // request. Resolved by `activeRunDir` — the same resolver `/api/wall`
      // uses — rather than by a directory name this route would have to keep in
      // step with the campaign layout.
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
