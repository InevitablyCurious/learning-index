// ─────────────────────────────────────────────────────────────────────────────
// BENCH CONTROL PLANE — THE BOARD
//
// The control plane is the only process that reads run files. It assembles
// the whole board (board/lib/board-build.mjs) and pushes it to browsers over
// server-sent events; the dashboard container only serves the page and relays.
//
//   GET /api/board   the assembled board, once
//   GET /api/stream  the push channel: the full board on connect, then patches
//
// `?since=` carries the client's event cursor so a reconnect resumes without a
// gap. `?tui=1` asks for full terminal frames, which are withheld otherwise.
// `?run_id=` keys the TUI mirror to one specific cell (the control-plane
// ledger uuid); absent/empty mirrors the default newest cell.
// ─────────────────────────────────────────────────────────────────────────────

import { args, BENCH_ROOT, RUNS_ROOT } from "../state.mjs";
import { sendJson } from "../lib/http.mjs";
import { streamClients } from "../board/lib/state.mjs";
import { getBoard } from "../board/lib/board-build.mjs";
import { boardWithoutEvents, tick } from "../board/lib/broadcast.mjs";
import { TUI_STREAM_MS, tuiForClient, tuiTick } from "../board/lib/tui.mjs";

const cfg = {
  benchRoot: BENCH_ROOT,
  runsRoot: RUNS_ROOT,
  pollMs: 2000,
  controlUrl: `http://127.0.0.1:${args.port}`,
  opencodeServeUrl: args.serveUrl,
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
      res.okpWantsTui = url.searchParams.get("tui") === "1";
      // Which cell this client mirrors; the TUI fast path (board/lib/tui.mjs)
      // fetches and pushes that cell's frames to it — and only to it.
      res.okpTuiRunId = url.searchParams.get("run_id") ?? null;

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
        full.tui = tuiForClient(full.tui, res.okpWantsTui);
        res.write(`event: board\ndata: ${JSON.stringify(full)}\n\n`);
        res.write(`event: events\ndata: ${JSON.stringify({ events: rows, cursor: board.events?.cursor ?? null })}\n\n`);
      } catch (err) {
        res.write(`event: error\ndata: ${JSON.stringify({ reason: String(err?.message ?? err) })}\n\n`);
      }
    },
  },
];
