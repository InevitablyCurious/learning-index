// ── STATS — the board's one numbers surface ──────────────────────────────────
//
// WHAT THIS IS. Every number the ledger footer draws comes from here, through
// ONE route (`GET /api/stats`). The board fetches once and renders; it derives
// nothing of its own. A second derivation board-side is how two copies of the
// same number come to disagree.
//
// ── TWO POPULATIONS, ONE SHAPE, NEVER MERGED ────────────────────────────────
//
//   BENCH  — native to the benchmark. True for anyone who clones this repo and
//            runs a campaign: derived from the bench's own artefacts and
//            nothing else.
//
//   CUSTOM — pluggable. True only on a machine that also runs the contributor's
//            own surroundings. The relay loop-guard counter is the founding
//            case: it comes from the Local LLM Proxy, a repo the bench does not
//            ship, does not depend on and cannot assume. A stranger has no
//            relay, so a relay stat on their board would be a permanently blank
//            slot advertising something their clone cannot do. That founding
//            case is retired — replaced by the BENCH-side `error_totals`
//            providers; the CUSTOM seam itself remains for genuinely external
//            counters.
//
// The bench declares NONE of the custom ones and does not know they exist. An
// external manifest names them and `OKP_BENCH_STATS_MANIFEST` points at it —
// the same seam shape as `OKP_BENCH_TOOLS_MANIFEST` in tools.mjs, for the same
// reason. Unset, which is what a fresh clone gets, contributes nothing.
//
// The two arrive as two ARRAYS under two keys. Same entry shape either side, so
// the board renders one slot renderer for both — but they are never
// concatenated here and must never be concatenated there. The separation IS the
// contract: a custom number is not a benchmark result.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readWall } from "./wall.mjs";

/**
 * The scorecard artifact's filename beside the run's other artifacts, mirroring
 * `bench/cumulative/run_artifacts.py::default_scorecard_path`. Sibling of the
 * mutable manifest, so retiring a run tree retires it in the same act.
 */
const SCORECARD_NAME = "manifest.scorecard.json";

/** How long a provider may take before it is reported as unavailable. */
const PROVIDER_TIMEOUT_MS = 2500;

/**
 * THE ENTRY SHAPE — the whole contract, both sides:
 *
 *   { id, label, state, value }
 *
 * `state` is one of:
 *   · "ok"          — `value` is a real reading
 *   · "unavailable" — the source could not be reached; `value` is null
 *   · "absent"      — this stat does not apply to this run; `value` is null
 *
 * A provider NEVER throws and NEVER returns a fabricated zero. "Unavailable"
 * and "zero" are different facts and the board draws them differently: a relay
 * that is down must not read as a run with no loop-guard fires.
 *
 * There is no `unit` and no `detail`. The footer is a readout strip — label and
 * number — and prose there was what this surface replaced.
 *
 * ── MONOTONIC SOURCES AND THE `delta` MODE ──────────────────────────────────
 *
 * Some sources count for the life of THEIR process, not for the life of a run.
 * The relay's loop-guard counter is the founding case and says so in its own
 * source: "Monotonic since process start; never reset by any request… A
 * consumer that wants 'did the guard fire during MY run' reads this endpoint
 * once at the start of the run and once at the end, and subtracts."
 *
 * Nothing implemented that subtraction, so the board drew a 13-hour lifetime
 * total next to a 40-minute run and the operator read it as this run's number.
 * A cumulative counter on a per-run board misreads every run after the first.
 *
 * `"mode": "delta"` in the manifest says the source is monotonic. The control
 * plane snapshots it when a run is QUEUED (see captureStatsBaseline) and this
 * module reports `now - snapshot`. The subtraction lives here, in the thing
 * that knows what a run is, and NOT in the source — the relay stays stateless
 * about runs, which is its own stated invariant and not ours to break.
 *
 * TWO WAYS A DELTA HAS NO ANSWER, AND BOTH SAY SO:
 *
 *   · No baseline for this run — a run this control plane never queued (a CLI
 *     launch), or one that predates the feature. Reporting the raw lifetime
 *     number here is precisely the bug; reporting zero invents a clean run.
 *     It reads `unavailable`.
 *   · The counter went BACKWARDS (`now < baseline`) — the source process
 *     restarted and its count began again, so the snapshot describes a
 *     generation that no longer exists. Also `unavailable`. Clamping to zero
 *     would silently show a fresh relay as a clean run.
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

// ── THE BENCH SIDE ───────────────────────────────────────────────────────────

/**
 * Benchmark-native providers.
 *
 * ── WHICH NUMBERS BELONG HERE, AND WHY ONLY THESE ───────────────────────────
 *
 * This returned `[]` for as long as the question "which numbers belong in the
 * footer" was open. It is now settled by one rule: EVERY OTHER CARD ALREADY
 * OWNS A QUESTION. The GATE WALL owns correctness, the TRANSFER CURVE owns
 * efficiency (every field of ConvergencePoint — tokens, turns, cycles, cost,
 * wall time, attempts-to-green), chrome owns liveness, the ledger rows own
 * verdicts.
 *
 * Nothing owned: **did this run produce usable measurement at all?** That is
 * this strip's job, and these three answer it. A cell ran three hours, passed
 * five verdict passes, published 265 gate verdicts and contributed ZERO data
 * points — and from the board it was indistinguishable from a cell still
 * working, because `void_instrument` appeared in a scorecard nobody rendered.
 *
 * DELIBERATELY NOT HERE: gate pass/fail counts (the wall headline), tokens,
 * cost, turns, cycles, attempts-to-green (the curve), liveness (chrome),
 * verdicts (ledger rows). A number computed in two places is two numbers that
 * can disagree, and this module exists to stop that.
 *
 * ERROR COUNTS NOW LIVE HERE: the harness publishes per-run error totals into
 * the scorecard's `error_totals` (guard_aborted_turns, instrument_anomaly_turns,
 * stalled_turns), and the three error providers below read them as the honest
 * per-benchmark error totals — replacing the relay's shared loop-guard
 * counter, which counted fires across ALL relay traffic and is retired.
 *
 * ALL SIX SLOTS CLAIMED. The strip held its geometry before its numbers were
 * chosen; six providers now fill all six slots.
 */
function benchProviders() {
  return [
    {
      id: "scored",
      label: "SCORED",
      /**
       * Cells that produced a convergence point.
       *
       * READ FROM THE AUTHORITY'S OWN ARTIFACT. The scored/void split is decided
       * by `build_scorecard` in Python; this reads what that published. The
       * alternative — folding the run manifest and status stream here — is a
       * SECOND implementation of the VOID-INSTRUMENT rule, and the two are
       * already known to disagree: the mutable manifest holds a complete
       * progress record for a cell the scorecard correctly voids.
       */
      async read(ctx) {
        // NO RUN IN VIEW is `absent`, not `unavailable` — nothing failed to be
        // read, there is simply no run for the stat to describe. The two are
        // different facts and the same distinction the entry shape draws
        // everywhere else.
        if (!ctx?.runDir) return { state: "absent", value: null };
        const card = await readScorecard(ctx);
        // A RUN WITH NO SCORECARD YET. Normal before the first cell completes,
        // and NOT zero: "no cell has finished" is not "no cell scored".
        if (!card) return { state: "unavailable", value: null };
        const n = card.scored_sessions;
        return Number.isFinite(n) ? { state: "ok", value: n } : { state: "unavailable", value: null };
      },
    },
    {
      id: "voided",
      label: "VOIDED",
      /**
       * Cells dropped from the scored set as INSTRUMENT failures — a truncated
       * attempt is never recorded as a capability FAIL.
       *
       * Zero is the healthy reading and is a real answer, not an absent one.
       * This is the number whose absence let a voided cell and a running cell
       * look the same on screen.
       */
      async read(ctx) {
        // NO RUN IN VIEW is `absent`, not `unavailable` — nothing failed to be
        // read, there is simply no run for the stat to describe. The two are
        // different facts and the same distinction the entry shape draws
        // everywhere else.
        if (!ctx?.runDir) return { state: "absent", value: null };
        const card = await readScorecard(ctx);
        // A RUN WITH NO SCORECARD YET. Normal before the first cell completes,
        // and NOT zero: "no cell has finished" is not "no cell scored".
        if (!card) return { state: "unavailable", value: null };
        const list = card.void_instrument;
        return Array.isArray(list) ? { state: "ok", value: list.length } : { state: "unavailable", value: null };
      },
    },
    {
      id: "unmeasured",
      label: "UNMEASURED",
      /**
       * Gates the runner reported reaching and produced no verdict for.
       *
       * NOT "gates with no result" — that is the whole suite for the first
       * minutes of every healthy cell. `control/wall.mjs` draws the distinction
       * and states the count; this reads it rather than re-folding the roster,
       * so the footer and the wall cannot disagree about the same gates.
       */
      async read(ctx) {
        if (!ctx?.runDir) return { state: "absent", value: null };
        const wall = await readWall({
          runsRoot: ctx.runsRoot,
          runDir: ctx.runDir,
          benchRoot: ctx.benchRoot ?? null,
        });
        if (!wall?.ok) return { state: "unavailable", value: null };
        const n = wall.unmeasured;
        return Number.isFinite(n) ? { state: "ok", value: n } : { state: "unavailable", value: null };
      },
    },
    {
      id: "loop_errors",
      label: "LOOP ERRORS",
      /**
       * Turns the run's guard aborted, aggregated by the harness into the
       * scorecard's `error_totals` (same artifact SCORED/VOIDED read). This is
       * the honest per-benchmark replacement for the relay's lifetime loop-guard
       * counter, which counted fires across ALL relay traffic and is retired.
       */
      async read(ctx) {
        if (!ctx?.runDir) return { state: "absent", value: null };
        const card = await readScorecard(ctx);
        if (!card) return { state: "unavailable", value: null };
        const n = card.error_totals?.guard_aborted_turns;
        return Number.isFinite(n) ? { state: "ok", value: n } : { state: "unavailable", value: null };
      },
    },
    {
      id: "stream_errors",
      label: "STREAM ERRORS",
      /**
       * Turns the stream failed on — every anomalous turn EXCEPT the loop
       * guard's, which has its own slot beside this one.
       *
       * Covers the transport_error / stream_died_open / truncated_no_signal /
       * unclassified_finish family, including the narrow finalize-timeout kind
       * this used to read ALONE. That narrowness is why it stayed 0 through a
       * run whose stream died mid-turn (measured 2026-09-11): the common case
       * was not the one kind being counted.
       */
      async read(ctx) {
        if (!ctx?.runDir) return { state: "absent", value: null };
        const card = await readScorecard(ctx);
        if (!card) return { state: "unavailable", value: null };
        // `instrument_anomaly_turns`, not `finalize_timeout_turns`. The latter
        // is one narrow kind — a turn killed while the stream FINALIZED — so a
        // plain transport_error (the stream dying mid-turn, the common case)
        // left this slot reading 0 through a run that had one. Measured
        // 2026-09-11. The broader field already contains the narrow one.
        const n = card.error_totals?.instrument_anomaly_turns;
        return Number.isFinite(n) ? { state: "ok", value: n } : { state: "unavailable", value: null };
      },
    },
    {
      id: "stalled_errors",
      label: "STALLED ERRORS",
      /**
       * Turns the run's stalled turns, from `error_totals`.
       */
      async read(ctx) {
        if (!ctx?.runDir) return { state: "absent", value: null };
        const card = await readScorecard(ctx);
        if (!card) return { state: "unavailable", value: null };
        const n = card.error_totals?.stalled_turns;
        return Number.isFinite(n) ? { state: "ok", value: n } : { state: "unavailable", value: null };
      },
    },
  ];
}

/**
 * The published scorecard for the run in view, or null.
 *
 * NULL IS `unavailable`, NEVER ZERO. Before the first cell completes there is no
 * scorecard, and "no cell has finished" is not "no cell scored" — a fabricated 0
 * beside a healthy run in its first hour would read as a run producing nothing.
 *
 * Read fresh on every call rather than cached: the harness republishes this
 * after every cell, and a cached scorecard is a footer that stops moving mid
 * campaign without saying so.
 */
async function readScorecard(ctx) {
  if (!ctx?.runDir) return null;
  try {
    const parsed = JSON.parse(await readFile(join(ctx.runDir, SCORECARD_NAME), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// ── THE CUSTOM SIDE ──────────────────────────────────────────────────────────

/**
 * Load externally contributed providers. Unset env, unreadable file, or bad
 * JSON all yield an EMPTY list — never an error and never a partial read. A dev
 * shim that cannot load must not be able to take the board down.
 *
 * Manifest shape:
 *   { "stats": [ { "id": "…", "label": "…", "url": "https://…", "pick": "a.b.c" } ] }
 *
 * `url` is fetched as JSON and `pick` is a dotted path into the response. That
 * is the whole contract: a custom stat is a reading off an HTTP endpoint the
 * contributor already runs. It buys no code execution inside the control plane.
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

/**
 * Turn a lifetime reading into this run's reading. Exported because it is the
 * whole of the delta contract and is worth asserting on directly.
 *
 * Both failure modes report `unavailable` rather than a number — see the entry
 * shape above for why neither may be papered over with a zero.
 */
export function scopeToRun(now, baseline) {
  if (typeof now !== "number" || !Number.isFinite(now)) return { state: "ok", value: now };
  if (typeof baseline !== "number" || !Number.isFinite(baseline)) {
    return { state: "unavailable", value: null };
  }
  if (now < baseline) return { state: "unavailable", value: null };
  return { state: "ok", value: now - baseline };
}

function manifestPath() {
  return String(process.env.OKP_BENCH_STATS_MANIFEST ?? "").trim();
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
 * The whole surface. `custom_manifest_attached` says which of the two empties a
 * bare `custom: []` is: a clone with no surroundings, or an attached manifest
 * that contributed nothing.
 */
export async function collectStats({ baselines = {}, runDir = null, runsRoot = null, benchRoot = null } = {}) {
  // THE RUN IN VIEW travels to every provider. Native readouts are run-scoped
  // facts read off that run's own artifacts; a provider that had to resolve the
  // run itself would be a second answer to "which run is this", and the wall
  // already learned what that costs — a stale default served `0/71 passing` over
  // a run whose artifacts recorded 16 passing and 2 failing.
  const ctx = { baselines, runDir, runsRoot, benchRoot };
  const [bench, custom] = await Promise.all([
    runAll(benchProviders(), ctx),
    runAll(await customProviders(), ctx),
  ]);
  return { bench, custom, custom_manifest_attached: Boolean(manifestPath()) };
}

// ── THE BASELINE — a run's zero for every monotonic source ───────────────────
//
// WHERE IT LIVES, AND WHY THERE. Beside the run's own log, named after it:
// `<log>.stats-baseline.json`. That is the same reasoning that moved the launch
// log into the tree (server.mjs, "THE LOG GOES IN THE TREE") — retiring a tree
// retires its baselines in the same act, and no cleanup step has to be
// remembered. A baseline that outlived its run would be worse than none: it
// would silently scope the NEXT run to the wrong zero.
//
// KEYED BY THE LOG, NOT BY THE TREE. One launch writes one log, and the log is
// what `readRunState` resolves to when the board asks what is running. Keying
// the baseline the same way means the number in the footer is scoped to exactly
// the run named above it — never to the campaign around it, and never to a
// sibling cell that happened to share a tree.

const BASELINE_SUFFIX = ".stats-baseline.json";

export function baselinePathFor(logPath) {
  return `${logPath}${BASELINE_SUFFIX}`;
}

/**
 * SNAPSHOT EVERY MONOTONIC SOURCE — this is the "reset" for the run about to
 * start. Called at QUEUE time, before the harness is spawned, so no fire the
 * run itself produces can land inside its own zero.
 *
 * Never throws and never blocks a launch. A relay that is down at queue time
 * costs the tile for that run (it reads `unavailable`, which is true — nothing
 * knows that run's zero); it must not cost the run.
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
        /* a source that cannot be read has no zero; see the entry shape */
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
    /* an unwritable baseline reads as absent, which is the honest answer */
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
