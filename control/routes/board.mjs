// ─────────────────────────────────────────────────────────────────────────────
// BENCH CONTROL PLANE — THE BOARD
//
// The control plane is the only process that reads run files. It assembles
// the whole board (board/lib/board-build.mjs) and pushes it to browsers over
// server-sent events; the dashboard container only serves the page and relays.
//
//   GET /api/board     the assembled board, once
//   GET /api/stream    the push channel: the full board on connect, then patches
//   GET /api/run-view  ONE run's per-cell view — the click target behind a
//                      board.runs card, and the only way to view an ARCHIVED
//                      run (the strip's by_cell covers the current batch only)
//
// `?since=` carries the client's event cursor so a reconnect resumes without a
// gap. `?tui=1` asks for full terminal frames, which are withheld otherwise.
// `?cell=` keys the TUI mirror to one cell by its address (`<run_dir>::<seq>`,
// the same address every per-cell read uses); absent mirrors nothing.
// ─────────────────────────────────────────────────────────────────────────────

import { args, BENCH_ROOT, RUNS_ROOT } from "../state.mjs";
import { sendJson } from "../lib/http.mjs";
import { statOrNull } from "../lib/fs.mjs";
import { resolveRunDir } from "../wall.mjs";
import { streamClients } from "../board/lib/state.mjs";
import { getBoard, buildCellViews, cellKey } from "../board/lib/board-build.mjs";
import { boardWithoutEvents, tick } from "../board/lib/broadcast.mjs";
import { TUI_STREAM_MS, tuiTick } from "../board/lib/tui.mjs";

const cfg = {
  benchRoot: BENCH_ROOT,
  runsRoot: RUNS_ROOT,
  pollMs: 2000,
  controlUrl: `http://127.0.0.1:${args.port}`,
};

/** Start the board's push loops. Called once from server.mjs after listen. */
export function startBoardLoops() {
  setInterval(() => void tick(cfg), cfg.pollMs).unref?.();
  setInterval(() => void tuiTick(cfg), TUI_STREAM_MS).unref?.();
}

export const routes = [
  {
    method: "GET",
    path: "/api/board",
    async handle(req, res) {
      sendJson(res, 200, await getBoard(cfg));
    },
  },
  {
    // ── GET /api/run-view ── one run's per-cell view, built by the SAME
    // assembly the board's by_cell uses (buildCellViews): the six per-cell
    // sources merged in ORDER, each stating its own ok/reason. This is what
    // makes an ARCHIVED run viewable — its run_dir ("backups/<stamp>/<old>/…")
    // resolves under the runs root like any other, and every per-cell source
    // reads by (run_dir, sequence_index). The cell carries log_path: null —
    // an archived run's launch log is not part of the view, and run-log
    // degrades gracefully on a null path (its absence is stated, never
    // guessed). Refusals: 400 on a missing/invalid parameter or a run_dir
    // that escapes the runs root; 404 when no run exists at that path.
    method: "GET",
    path: "/api/run-view",
    async handle(req, res, url) {
      const runDirRaw = url.searchParams.get("run_dir");
      const seqRaw = url.searchParams.get("sequence_index");
      if (typeof runDirRaw !== "string" || !runDirRaw.trim()) {
        sendJson(res, 400, { ok: false, reason: "run_dir is required (a path relative to the runs root)" });
        return;
      }
      if (!/^\d+$/.test(seqRaw ?? "")) {
        sendJson(res, 400, { ok: false, reason: "sequence_index is required (an integer >= 0)" });
        return;
      }
      // The wall's containment validator: nested paths allowed, `..`,
      // backslashes, absolute paths and escapes refused. The empty-string
      // default inside it is unreachable — empty was refused above.
      const target = resolveRunDir(RUNS_ROOT, runDirRaw);
      if (!target) {
        sendJson(res, 400, {
          ok: false,
          reason: `run_dir must be a directory path under the runs root; got ${JSON.stringify(runDirRaw)}`,
        });
        return;
      }
      const st = await statOrNull(target.path);
      if (!st?.isDirectory()) {
        sendJson(res, 404, { ok: false, reason: `no such run: ${target.name}` });
        return;
      }

      const cell = { run_dir: target.name, sequence_index: Number(seqRaw), log_path: null };
      // The same ctx getBoard builds (board-build.mjs): benchRoot, runsRoot
      // and the config the per-cell sources read controlUrl from.
      const ctx = { benchRoot: cfg.benchRoot, runsRoot: cfg.runsRoot, config: cfg };
      const views = await buildCellViews([cell], ctx);
      const view = views[cellKey(cell)];
      if (!view) {
        sendJson(res, 404, {
          ok: false,
          reason: `no view could be built for ${cell.run_dir}::${cell.sequence_index}`,
        });
        return;
      }
      sendJson(res, 200, { ok: true, view });
    },
  },
  {
    method: "GET",
    path: "/api/stream",
    async handle(req, res, url) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      // Reconnect after 2s rather than EventSource's 3s default.
      res.write("retry: 2000\n\n");

      streamClients.add(res);
      const drop = () => streamClients.delete(res);
      req.on("close", drop);
      req.on("error", drop);
      res.on("error", drop);
      // Not ready for TUI frames until the board frame below is written: the
      // client replaces its whole board on that frame, so a full terminal frame
      // pushed first would be erased and the row splices after it dropped.
      res.okpBoardSent = false;
      res.okpWantsTui = url.searchParams.get("tui") === "1";
      // Which cell this client mirrors; the TUI fast path (board/lib/tui.mjs)
      // fetches and pushes that cell's frames to it — and only to it.
      res.okpTuiCell = url.searchParams.get("cell") || null;

      try {
        const board = await getBoard(cfg);
        const requested = Number(url.searchParams.get("since") ?? 0) || 0;
        // A cursor AHEAD of the ring is stale from before a restart (the ring
        // re-based at 0): replay from scratch, or the reconnect delivers nothing.
        const ringCursor = board.events?.cursor ?? null;
        const since = typeof ringCursor === "number" && requested > ringCursor ? 0 : requested;
        const rows = (board.events?.events ?? []).filter((e) => (e.seq ?? -1) > since);
        res.okpCursor = rows.length ? (rows[rows.length - 1].seq ?? since) : since;
        const full = boardWithoutEvents(board);
        res.write(`event: board\ndata: ${JSON.stringify(full)}\n\n`);
        res.okpBoardSent = true;
        res.write(`event: events\ndata: ${JSON.stringify({ events: rows, cursor: board.events?.cursor ?? null })}\n\n`);
      } catch (err) {
        res.write(`event: error\ndata: ${JSON.stringify({ reason: String(err?.message ?? err) })}\n\n`);
      }
    },
  },
];
