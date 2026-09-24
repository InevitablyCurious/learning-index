// BOARD ASSEMBLY — the source list, ordered merge and poll cache. Each source
// runs isolated with a timeout; one that throws or hangs is reported unwired and
// the board renders without it. Results are cached for cfg.pollMs; concurrent
// requests share one refresh.

import { emptyBoard } from "../contract.mjs";
import { runSource, mergePatch } from "../sources/_runtime.mjs";
import { reconcileRunLiveness } from "../run-liveness.mjs";

// ── source registry ──────────────────────────────────────────────────────────

import * as runManifest from "../sources/run-manifest.mjs";
import * as statusStream from "../sources/status-stream.mjs";
import * as runLog from "../sources/run-log.mjs";
import * as stackLedger from "../sources/stack-ledger.mjs";
import * as funnelCells from "../sources/funnel-cells.mjs";
import * as pluginLog from "../sources/plugin-log.mjs";
import * as opencodeServe from "../sources/opencode-serve.mjs";
import * as controlPlane from "../sources/control-plane.mjs";
import * as gateSuite from "../sources/gate-suite.mjs";
import * as learning from "../sources/learning.mjs";
import * as liveStream from "../sources/live-stream.mjs";
import * as toolJobs from "../sources/tool-jobs.mjs";
import * as cells from "../sources/cells.mjs";
import * as runs from "../sources/runs.mjs";

// Every source is always on: each one reports its own absence ("unwired",
// with a reason) instead of being switched off by configuration.
//
// Board-wide sources: one read for the whole board.
const MODS = [
  runManifest, statusStream, stackLedger, funnelCells, pluginLog,
  controlPlane, toolJobs, cells, runs,
];

// ── PER-CELL SOURCES ── everything that describes ONE cell. Each exports
// readCell(ctx) and is run once per cell of the strip, with ctx.cell = that
// strip entry, into board.by_cell["<run_dir>::<seq>"]. None of them may pick a
// cell on its own: with N concurrent cells "the newest" changes with every
// write, and the board showed whichever cell wrote last under the strip's
// selection. Merge order as ORDER: the status stream, then the log pulse, then
// the live stream, then the serve API (freshest).
const CELL_MODS = [statusStream, learning, runLog, liveStream, opencodeServe, gateSuite];

/** The address a cell is keyed by everywhere: `<run_dir>::<sequence_index>`. */
export function cellKey(cell) {
  return `${cell.run_dir}::${cell.sequence_index}`;
}

// ── board assembly ───────────────────────────────────────────────────────────

/**
 * Merge order: later sources win on conflict, and null never overwrites (see
 * mergePatch).
 *   run-manifest   provenance floor
 *   status-stream  authoritative for gates, arm, verdict
 *   run-log        live pulse between attempt records
 *   live-stream    fresher than anything written at cell end
 *   opencode-serve last: freshest tokens and liveness
 */
const ORDER = [
  "control-plane",
  "run-manifest",
  "status-stream",
  "funnel-cells",
  "plugin-log",
  "learning",
  "run-log",
  "live-stream",
  "opencode-serve",
  // Owns `tool_jobs` alone; in-memory, so it is never the slow source.
  "tool-jobs",
  // Owns `cells` alone — the per-cell strip. Listed rather than left out:
  // indexOf returns -1 for an unlisted source, which sorts it FIRST, so an
  // omission here is an accidental merge position rather than a no-op.
  "cells",
  // Owns `runs` alone — the per-run cards (current tree + archived backups).
  // Listed for the same reason as cells: an unlisted source sorts FIRST.
  "runs",
  // Owns `suite` alone (split from control-plane so a slow suite can't hold the
  // TUI); position not load-bearing.
  "gate-suite",
];

async function buildBoard(cfg) {
  const board = emptyBoard();
  const ctx = { benchRoot: cfg.benchRoot, runsRoot: cfg.runsRoot, config: cfg };

  const ordered = [...MODS].sort(
    (a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id),
  );

  // Reads run in parallel (latency = the slowest source, not the sum); the merge
  // stays sequential in ORDER.
  const results = await Promise.all(ordered.map((mod) => runSource(mod, ctx)));
  for (const r of results) {
    if (r.ok) mergePatch(board, r.patch);
  }

  board.by_cell = await buildCellViews(board.cells?.list ?? [], ctx);

  board.sources = results.map((r) => ({
    id: r.id,
    ok: r.ok,
    fields: r.fields,
    reason: r.reason,
    provenance: r.provenance,
    ms: r.ms,
  }));

  board.generated_at = Date.now();
  return board;
}

/**
 * One view per cell: the per-cell sources' patches merged in ORDER, the cell's
 * liveness reconciled against the control plane's verdict for THAT cell (its
 * strip entry), and each source's own ok/reason so an absence is stated.
 * Exported: GET /api/run-view builds ONE cell's view through this same path —
 * a current strip cell and an archived run are viewed by the identical
 * assembly, never a second one.
 */
export async function buildCellViews(list, ctx) {
  const ordered = [...CELL_MODS].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const views = {};
  await Promise.all(
    list
      .filter((c) => typeof c?.run_dir === "string" && c.run_dir && Number.isInteger(c.sequence_index))
      .map(async (cell) => {
        const cctx = { ...ctx, cell };
        const results = await Promise.all(ordered.map((mod) => runSource(mod, cctx, mod.readCell)));
        const view = {};
        for (const r of results) {
          if (r.ok) mergePatch(view, r.patch);
        }
        // The strip entry IS the control plane's verdict for this cell.
        if (view.run) view.run = reconcileRunLiveness({ control: { run: cell }, run: view.run }).run;
        view.sources = results.map((r) => ({ id: r.id, ok: r.ok, reason: r.reason, ms: r.ms }));
        views[cellKey(cell)] = view;
      }),
  );
  return views;
}

// ── poll cache ───────────────────────────────────────────────────────────────

let cached = null;
let cachedAt = 0;
let inFlight = null;

export async function getBoard(cfg) {
  const age = Date.now() - cachedAt;
  if (cached && age < cfg.pollMs) return cached;
  if (inFlight) return inFlight; // share one refresh across concurrent clients
  inFlight = buildBoard(cfg)
    .then((b) => {
      cached = b;
      cachedAt = Date.now();
      return b;
    })
    .catch((err) => {
      // Even total assembly failure must render something honest.
      const b = emptyBoard();
      b.sources = [{ id: "server", ok: false, fields: [], reason: String(err?.message ?? err), provenance: null, ms: 0 }];
      return b;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
