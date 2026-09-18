// ─────────────────────────────────────────────────────────────────────────────
// BOARD ASSEMBLY — source registry, ordered merge, poll cache.
//
// Every source runs isolated with a 2s timeout; one that throws or hangs is
// reported `unwired` and the board renders without it. Results are cached for
// cfg.pollMs and concurrent requests share one in-flight refresh.
// ─────────────────────────────────────────────────────────────────────────────

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
import * as resultsLedger from "../sources/results-ledger.mjs";

// Every source is always on: each one reports its own absence ("unwired",
// with a reason) instead of being switched off by configuration.
const MODS = [
  runManifest, statusStream, runLog, stackLedger, funnelCells, pluginLog,
  opencodeServe, controlPlane, gateSuite, learning, liveStream, resultsLedger,
];

// ── board assembly ───────────────────────────────────────────────────────────

/**
 * MERGE ORDER MATTERS. Later modules win on conflict, and null never
 * overwrites a value (see mergePatch). Ordering rationale:
 *   run-manifest   provenance floor
 *   status-stream  AUTHORITATIVE for gates/arm/verdict (RC-5)
 *   run-log        live pulse, refines phase/turns between attempt records
 *   opencode-serve freshest token counters, last word on liveness
 */
const ORDER = [
  "control-plane",
  "run-manifest",
  "status-stream",
  "funnel-cells",
  "plugin-log",
  "learning",
  "run-log",
  // AFTER the artifact sources and BEFORE opencode-serve: the stream is a
  // fresher account of the same run than anything written at cell end, and
  // opencode-serve stays last as the live token/liveness authority.
  "live-stream",
  // Durable completed-cells ledger (WO-43): owns `results`, conflicts with
  // nothing. BEFORE opencode-serve so the live token/liveness authority
  // stays last, per the merge-order rationale above.
  "results-ledger",
  "opencode-serve",
  // Split out of `control-plane` (2026-09-05) so a gate suite that is slow to
  // enumerate, or absent before the first cell, cannot hold the TUI mirror —
  // they shared a source and therefore shared a fate. Owns `suite` alone and
  // overlaps nothing, so its position here is not load-bearing.
  "gate-suite",
];

async function buildBoard(cfg) {
  const board = emptyBoard();
  const ctx = { benchRoot: cfg.benchRoot, runsRoot: cfg.runsRoot, config: cfg };

  const ordered = [...MODS].sort(
    (a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id),
  );

  // ── SOURCES RUN IN PARALLEL, MERGE IN ORDER ───────────────────────────────
  //
  // This was `for (const mod of ordered) { await runSource(...) }` — every
  // source awaited in series, so the board's latency was the SUM of eleven
  // independent reads (measured 3,171ms: stack-ledger 680 + status-stream 655 +
  // run-manifest 576 + learning 555 + live-stream 536 + control-plane 159 + …).
  // Nothing in that loop needed to be sequential: each source reads its own
  // artifacts and returns a patch. One slow read delayed every OTHER section of
  // the board behind it, which is how a slow read of one thing becomes a board
  // that appears blank.
  //
  // ORDER IS STILL LOAD-BEARING and is preserved exactly. `mergePatch` applies
  // later sources over earlier ones, so the merge stays sequential in `ORDER`
  // — only the READS overlap. Execution order and merge order were conflated;
  // they are now separate, and the board's latency is the slowest source rather
  // than the sum of all of them.
  const results = await Promise.all(ordered.map((mod) => runSource(mod, ctx)));
  for (const r of results) {
    if (r.ok) mergePatch(board, r.patch);
  }

  reconcileRunLiveness(board);

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
