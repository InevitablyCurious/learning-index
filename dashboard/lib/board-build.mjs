// ─────────────────────────────────────────────────────────────────────────────
// BOARD ASSEMBLY — source registry, ordered merge, poll cache.
//
// Extracted from server.mjs (WO LI-13). The safety properties documented in
// server.mjs's header apply verbatim here: every source module runs isolated
// with a 2s timeout, a module that throws or hangs is reported `unwired`, and
// poll results are cached with concurrent requests sharing one in-flight
// refresh. This module is import-safe (top level is declarations only).
// ─────────────────────────────────────────────────────────────────────────────

import { emptyBoard } from "../contract.mjs";
import { runSource, mergePatch } from "../sources/_runtime.mjs";
import { reconcileRunLiveness } from "../run-liveness.mjs";

// ── source registry ──────────────────────────────────────────────────────────

// Specifiers are relative to THIS file (dashboard/lib/), because `loadModules`
// hands them to a dynamic import() from here — so the dashboard's sources/
// directory is one level up.
const MODULE_FILES = {
  "run-manifest": "../sources/run-manifest.mjs",
  "status-stream": "../sources/status-stream.mjs",
  "run-log": "../sources/run-log.mjs",
  "stack-ledger": "../sources/stack-ledger.mjs",
  "funnel-cells": "../sources/funnel-cells.mjs",
  "plugin-log": "../sources/plugin-log.mjs",
  "opencode-serve": "../sources/opencode-serve.mjs",
  "control-plane": "../sources/control-plane.mjs",
  "gate-suite": "../sources/gate-suite.mjs",
  learning: "../sources/learning.mjs",
  "live-stream": "../sources/live-stream.mjs",
  "results-ledger": "../sources/results-ledger.mjs",
  "hub-db": "../sources/hub-db.mjs",
};

/**
 * Load enabled modules. A module that fails to IMPORT is reported as unwired
 * rather than crashing the server — this is what makes the source directory
 * genuinely pluggable: a broken drop-in degrades to a null panel.
 */
export async function loadModules(cfg) {
  const mods = [];
  const broken = [];
  for (const [name, enabled] of Object.entries(cfg.sources)) {
    if (!enabled) continue;
    const file = MODULE_FILES[name];
    if (!file) {
      broken.push({ id: name, reason: "unknown source id" });
      continue;
    }
    try {
      mods.push(await import(file));
    } catch (err) {
      broken.push({ id: name, reason: `import failed: ${String(err?.message ?? err).slice(0, 160)}` });
    }
  }
  return { mods, broken };
}

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
  "run-manifest",
  "status-stream",
  "funnel-cells",
  "plugin-log",
  "hub-db",
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

async function buildBoard(cfg, mods, broken) {
  const board = emptyBoard();
  const ctx = { benchRoot: cfg.benchRoot, runsRoot: cfg.runsRoot, config: cfg };

  const ordered = [...mods].sort(
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

  board.sources = [
    ...results.map((r) => ({
      id: r.id,
      ok: r.ok,
      fields: r.fields,
      reason: r.reason,
      provenance: r.provenance,
      ms: r.ms,
    })),
    ...broken.map((b) => ({ id: b.id, ok: false, fields: [], reason: b.reason, provenance: null, ms: 0 })),
  ];

  board.generated_at = Date.now();
  return board;
}

// ── poll cache ───────────────────────────────────────────────────────────────

let cached = null;
let cachedAt = 0;
let inFlight = null;

export async function getBoard(cfg, mods, broken) {
  const age = Date.now() - cachedAt;
  if (cached && age < cfg.pollMs) return cached;
  if (inFlight) return inFlight; // share one refresh across concurrent clients
  inFlight = buildBoard(cfg, mods, broken)
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
