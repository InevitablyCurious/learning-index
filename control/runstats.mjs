// STATS — every number in the ledger's stat strip, through GET /api/stats. The
// board derives none of them.
//
// Two populations, same entry shape, never merged:
//   BENCH  — native: derived from the bench's own artifacts, true for anyone
//            who clones the repo.
//   CUSTOM — pluggable: named by an external manifest ($BENCH_STATS_MANIFEST),
//            true only where the contributor's services run. Unset = none.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { readWall } from "./wall.mjs";

/** The scorecard's filename (mirrors run_artifacts.py default_scorecard_path). */
const SCORECARD_NAME = "manifest.scorecard.json";

/** How long a provider may take before it is reported as unavailable. */
const PROVIDER_TIMEOUT_MS = 2500;

/**
 * Entry shape: { id, label, state, value }, state one of ok, unavailable (the
 * source could not be read) or absent (does not apply to this run). A provider
 * never throws and never returns a made-up zero.
 *
 * mode "delta": the source counts for its own process lifetime, so the control
 * plane snapshots it when a run is queued (captureStatsBaseline) and reports
 * now − snapshot. With no snapshot, or a counter that went backwards (the source
 * restarted), the reading is unavailable, never raw or zero.
 */

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`provider timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ── THE BENCH SIDE ──

/**
 * Benchmark-native providers. They answer the one question no other card owns:
 * did this run produce usable measurement at all? Gate counts, tokens, turns,
 * cost and verdicts belong to other cards and are deliberately not repeated
 * here. All seven slots are claimed.
 */
function benchProviders() {
  return [
    {
      id: "scored",
      label: "SCORED",
      /**
       * Cells that produced a convergence point, read from the scorecard Python
       * published (the scored/void split lives there, not re-derived here).
       */
      async read(ctx) {
        // No run in view: absent, not unavailable.
        if (!ctx?.runDir) return { state: "absent", value: null };
        const card = await readScorecard(ctx);
        // No scorecard yet (normal before the first cell completes): not zero.
        if (!card) return { state: "unavailable", value: null };
        const n = card.scored_sessions;
        return Number.isFinite(n) ? { state: "ok", value: n } : { state: "unavailable", value: null };
      },
    },
    {
      id: "voided",
      label: "VOIDED",
      /** Cells voided as instrument failures. Zero is the healthy reading. */
      async read(ctx) {
        // No run in view: absent.
        if (!ctx?.runDir) return { state: "absent", value: null };
        const card = await readScorecard(ctx);
        // No scorecard yet: not zero.
        if (!card) return { state: "unavailable", value: null };
        const list = card.void_instrument;
        return Array.isArray(list) ? { state: "ok", value: list.length } : { state: "unavailable", value: null };
      },
    },
    {
      id: "unmeasured",
      label: "UNMEASURED",
      /**
       * Gates the runner reached and produced no verdict for, summed over the
       * batch's cells — each read from control/wall.mjs for its own cell, so
       * the strip and every cell's wall agree.
       */
      async read(ctx) {
        if (!ctx?.runDir) return { state: "absent", value: null };
        const seqs = await cellIndexes(runPath(ctx));
        if (!seqs.length) return { state: "unavailable", value: null };
        let total = 0;
        for (const sequenceIndex of seqs) {
          const wall = await readWall({
            runsRoot: ctx.runsRoot,
            runDir: ctx.runDir,
            sequenceIndex,
            benchRoot: ctx.benchRoot ?? null,
          });
          if (!wall?.ok || !Number.isFinite(wall.unmeasured)) return { state: "unavailable", value: null };
          total += wall.unmeasured;
        }
        return { state: "ok", value: total };
      },
    },
    {
      id: "loop_errors",
      label: "LOOP ERRORS",
      /**
       * Turns the loop guard killed, counted live from the stream (turnErrors), so
       * the slot works during a run and after one that never wrote a scorecard.
       */
      async read(ctx) {
        return turnErrorSlot(ctx, "loop");
      },
    },
    {
      id: "stream_errors",
      label: "STREAM ERRORS",
      /** Turns the stream failed on (every anomaly except loop and stall). */
      async read(ctx) {
        return turnErrorSlot(ctx, "stream");
      },
    },
    {
      id: "stalled_errors",
      label: "STALLED ERRORS",
      /** Turns the harness's stall watchdog ended (a command that stopped progressing). */
      async read(ctx) {
        return turnErrorSlot(ctx, "stalled");
      },
    },
    {
      id: "cutoffs",
      label: "CUT-OFFS",
      /**
       * Turns the harness cut off at the context cap, counted live from the
       * cells' streams (cutoffCounts), and how many were nudged into a retry.
       * Stream-only by design: no live stream reads unavailable ("—"), never 0.
       */
      async read(ctx) {
        const dir = runPath(ctx);
        if (!dir) return { state: "absent", value: null };
        const counts = await cutoffCounts(dir);
        // No live stream: unavailable, never a fabricated zero.
        if (!counts) return { state: "unavailable", value: null };
        if (counts.total === 0) return { state: "ok", value: "0" };
        return { state: "ok", value: `${counts.total} · ${counts.nudged} nudged` };
      },
    },
  ];
}

/**
 * Turn errors counted from the cells' live.jsonl notices
 * (turn_truncated_retried, recovery_budget_exhausted), split by
 * detail.terminal: guard_abort (loop), turn_stalled (stall), anything else (the
 * stream failed). null when the run has no stream; the caller falls back to the
 * scorecard.
 */
export async function turnErrors(runDir) {
  const counts = { loop: 0, stream: 0, stalled: 0 };
  let streams = 0;
  let arms = [];
  try {
    arms = await readdir(runDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const arm of arms) {
    if (!arm.isDirectory() || !/^memory/i.test(arm.name)) continue;
    let cells = [];
    try {
      cells = await readdir(join(runDir, arm.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const cell of cells) {
      if (!cell.isDirectory() || !/^cell-/i.test(cell.name)) continue;
      let raw;
      try {
        raw = await readFile(join(runDir, arm.name, cell.name, "live.jsonl"), "utf8");
      } catch {
        continue;
      }
      streams += 1;
      for (const line of raw.split("\n")) {
        if (!line.includes('"notice"')) continue;
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        if (r?.kind !== "notice") continue;
        if (r.event !== "turn_truncated_retried" && r.event !== "recovery_budget_exhausted") continue;
        const terminal = String(r.detail?.terminal ?? "");
        if (terminal === "guard_abort") counts.loop += 1;
        else if (terminal === "turn_stalled") counts.stalled += 1;
        else counts.stream += 1;
      }
    }
  }
  return streams ? counts : null;
}

/**
 * Length cut-offs counted from the cells' live.jsonl notices: the harness
 * emits `length_cutoff` when a turn hits the context cap, and `detail.nudged`
 * says whether the retry nudge fired. The same walk and the same
 * null-on-zero-streams convention as turnErrors — a run with no live stream
 * has no reading, never a zero.
 */
async function cutoffCounts(runDir) {
  let total = 0;
  let nudged = 0;
  let streams = 0;
  let arms = [];
  try {
    arms = await readdir(runDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const arm of arms) {
    if (!arm.isDirectory() || !/^memory/i.test(arm.name)) continue;
    let cells = [];
    try {
      cells = await readdir(join(runDir, arm.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const cell of cells) {
      if (!cell.isDirectory() || !/^cell-/i.test(cell.name)) continue;
      let raw;
      try {
        raw = await readFile(join(runDir, arm.name, cell.name, "live.jsonl"), "utf8");
      } catch {
        continue;
      }
      streams += 1;
      for (const line of raw.split("\n")) {
        if (!line.includes('"notice"')) continue;
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        if (r?.kind !== "notice") continue;
        if (r.event !== "length_cutoff") continue;
        total += 1;
        if (r.detail?.nudged === true) nudged += 1;
      }
    }
  }
  return streams ? { total, nudged, streams } : null;
}

/** The sequence indexes of the run's cell directories (memory<ARM>/cell-NNNN). */
async function cellIndexes(runDir) {
  const out = [];
  let arms = [];
  try {
    arms = await readdir(runDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const arm of arms) {
    if (!arm.isDirectory() || !/^memory/i.test(arm.name)) continue;
    let cells = [];
    try {
      cells = await readdir(join(runDir, arm.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const cell of cells) {
      const m = /^cell-(\d+)$/i.exec(cell.name);
      if (cell.isDirectory() && m) out.push(Number(m[1]));
    }
  }
  return out.sort((a, b) => a - b);
}

const SCORECARD_ERROR_FIELD = {
  loop: "guard_aborted_turns",
  stream: "instrument_anomaly_turns",
  stalled: "stalled_turns",
};

/**
 * The run in view as a full path (providers are given it relative to the
 * runs root).
 */
export function runPath(ctx) {
  if (!ctx?.runDir) return null;
  return isAbsolute(ctx.runDir) || !ctx.runsRoot ? ctx.runDir : join(ctx.runsRoot, ctx.runDir);
}

async function turnErrorSlot(ctx, kind) {
  if (!ctx?.runDir) return { state: "absent", value: null };
  const live = await turnErrors(runPath(ctx));
  if (live) return { state: "ok", value: live[kind] };
  const card = await readScorecard(ctx);
  const n = card?.error_totals?.[SCORECARD_ERROR_FIELD[kind]];
  return Number.isFinite(n) ? { state: "ok", value: n } : { state: "unavailable", value: null };
}

/**
 * The run's scorecard, read fresh every call (republished after every cell);
 * null reads unavailable, never zero.
 */
async function readScorecard(ctx) {
  if (!ctx?.runDir) return null;
  try {
    const parsed = JSON.parse(await readFile(join(runPath(ctx), SCORECARD_NAME), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// ── THE CUSTOM SIDE ──

/**
 * Externally contributed providers. Unset env, unreadable file or bad JSON all
 * yield an empty list. Manifest: { "stats": [ { id, label, url, pick } ] } —
 * `url` is fetched as JSON and `pick` is a dotted path into it. No code runs
 * inside the control plane.
 */
async function customProviders() {
  const path = manifestPath();
  if (!path) return [];
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed?.stats) ? parsed.stats : [];
  return entries
    .filter((e) => e && typeof e.id === "string" && typeof e.url === "string")
    .map((e) => ({
      id: e.id,
      label: typeof e.label === "string" ? e.label : e.id,
      delta: e.mode === "delta",
      /** The source's own reading, before any run-scoping. */
      async readRaw() {
        const res = await fetch(e.url, { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
        if (!res.ok) return undefined;
        return pick(await res.json(), e.pick);
      },
      async read({ baselines = {} } = {}) {
        const value = await this.readRaw();
        if (value === undefined || value === null) return { state: "unavailable", value: null };
        if (e.mode !== "delta") return { state: "ok", value };
        return scopeToRun(value, baselines[e.id]);
      },
    }));
}

/** Walk a dotted path into a parsed JSON body. */
export function pick(body, path) {
  return String(path ?? "")
    .split(".")
    .filter(Boolean)
    .reduce((acc, k) => (acc == null ? acc : acc[k]), body);
}

/** A lifetime reading → this run's reading; either failure mode is unavailable. */
export function scopeToRun(now, baseline) {
  if (typeof now !== "number" || !Number.isFinite(now)) return { state: "ok", value: now };
  if (typeof baseline !== "number" || !Number.isFinite(baseline)) {
    return { state: "unavailable", value: null };
  }
  if (now < baseline) return { state: "unavailable", value: null };
  return { state: "ok", value: now - baseline };
}

function manifestPath() {
  return String(process.env.BENCH_STATS_MANIFEST ?? "").trim();
}

// ── COLLECTION ───────────────────────────────────────────────────────────────

async function runAll(providers, ctx) {
  return Promise.all(
    providers.map(async (p) => {
      try {
        const r = await withTimeout(p.read(ctx), PROVIDER_TIMEOUT_MS);
        return { id: p.id, label: p.label, state: "absent", value: null, ...r };
      } catch {
        return { id: p.id, label: p.label, state: "unavailable", value: null };
      }
    }),
  );
}

/**
 * The whole surface. `custom_manifest_attached` tells a clone with no
 * surroundings from a manifest that contributed nothing.
 */
export async function collectStats({ baselines = {}, runDir = null, runsRoot = null, benchRoot = null } = {}) {
  // The run in view travels to every provider, so none resolves it on its own.
  const ctx = { baselines, runDir, runsRoot, benchRoot };
  const [bench, custom] = await Promise.all([
    runAll(benchProviders(), ctx),
    runAll(await customProviders(), ctx),
  ]);
  return { bench, custom, custom_manifest_attached: Boolean(manifestPath()) };
}

// ── THE BASELINE ── a run's zero for every monotonic source, stored beside the
// run's log as <log>.stats-baseline.json: retiring the tree retires it, and it
// is scoped to exactly the run the board names.

const BASELINE_SUFFIX = ".stats-baseline.json";

export function baselinePathFor(logPath) {
  return `${logPath}${BASELINE_SUFFIX}`;
}

/**
 * Snapshot every monotonic source at queue time, before the harness spawns.
 * Never throws or blocks a launch; an unreachable source just has no zero.
 */
export async function captureStatsBaseline({ logPath }) {
  let providers;
  try {
    providers = (await customProviders()).filter((p) => p.delta);
  } catch {
    return {};
  }
  if (providers.length === 0) return {};

  const captured = {};
  await Promise.all(
    providers.map(async (p) => {
      try {
        const v = await withTimeout(p.readRaw(), PROVIDER_TIMEOUT_MS);
        if (typeof v === "number" && Number.isFinite(v)) captured[p.id] = v;
      } catch {
      }
    }),
  );

  try {
    await writeFile(
      baselinePathFor(logPath),
      `${JSON.stringify({ captured_at: new Date().toISOString(), baselines: captured }, null, 2)}\n`,
      "utf8",
    );
  } catch {
  }
  return captured;
}

/** This run's zero, or `{}` when nothing recorded one. */
export async function readStatsBaseline({ logPath }) {
  if (!logPath) return {};
  try {
    const parsed = JSON.parse(await readFile(baselinePathFor(logPath), "utf8"));
    const b = parsed?.baselines;
    return b && typeof b === "object" ? b : {};
  } catch {
    return {};
  }
}
