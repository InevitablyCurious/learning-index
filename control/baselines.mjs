// ─────────────────────────────────────────────────────────────────────────────
// BASELINES — the floor, derived once, stored, and exported from here
//
// THE ONE OWNER. Every "does model X have a floor, and which cell is it" answer
// on this machine comes from this file. It was previously computed inside
// models-ledger.mjs and existed nowhere else: unstored, recomputed on every
// poll, and reachable only by importing the ledger module. A floor is not a
// detail of one panel — it is the reference every Δ on the board is measured
// against, and the gate on [+ baseline] and [+ run] — so it gets an owner,
// a file on disk, and an endpoint.
//
// ── THE RULE THIS FILE ENFORCES ─────────────────────────────────────────────
//
// ONE FLOOR PER MODEL, and exactly one. A model with a valid floor cannot start
// another baseline (re-baselining is a declared act — archive the run — not a
// button). A model WITHOUT one can always start a baseline: a floor is measured
// against nothing, so no other model's floor or run has any bearing on
// it. That second half was broken for as long as the subject rule was applied to
// OFF cells; see models-ledger.mjs.
//
// ── VOID IS NOT COMPLETE ────────────────────────────────────────────────────
//
// A void-instrument cell ran to completion and produced numbers that measure the
// harness rather than the model (RUNBOOK 5.10). It is treated as NO baseline —
// [+ baseline] re-enables and the reason is stated — because it looks like
// success from every angle except the one that counts.
//
// ── STORED, AND WHY THAT IS NOT A CACHE ─────────────────────────────────────
//
// `<runsRoot>/baselines.json` is written whenever the derived index CHANGES. It
// is a published record, never an input: every read re-derives from the run
// directories, and the file is the export other readers consume — the dashboard
// mounts runs/ read-only, and an operator can `cat` it. Nothing here ever reads
// it back to answer a question, so a stale or hand-edited file cannot change a
// gate. If the write fails the index is still correct and still served; the
// failure is reported in `stored`, not thrown, because losing the export must
// never cost the answer.
// ─────────────────────────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
// CAMPAIGN DISCOVERY. The tree nests campaigns, so "which directories are
// campaigns" is one rule in one place rather than a readdir in each reader.
import { listLiveCampaignDirs } from "./tree.mjs";

/**
 * A SHORT, STABLE, QUOTABLE BASELINE ID — `base-8d1e`, matching the design.
 *
 * Derived from the two facts that identify a floor forever (which run directory,
 * which cell inside it) rather than from a counter, for the same reason
 * A counter would need a shared mutable
 * cursor, and an id an operator quotes in a report must not change when the
 * service restarts or when a second baseline is measured before it.
 *
 * IT IS DERIVED, NOT STORED. Nothing writes it, so it cannot drift from the
 * cell it names — re-deriving it from the same directory and index always
 * returns the same four characters.
 */
export function baselineId(runDir, sequenceIndex) {
  const h = createHash("sha256").update(`${runDir}::${sequenceIndex}`).digest("hex");
  return `base-${h.slice(0, 4)}`;
}

/**
 * WHICH MODEL IS THIS CELL MEASURING, AND WAS IT LOCAL OR CLOUD.
 *
 * THE TWO SUBSTRATES NAME THEMSELVES DIFFERENTLY, and reading them with one rule
 * silently mislabels one of them:
 *
 *   local   roster slug `local-llm-proxy/qwen3.6-35b-a3b-bench`
 *           provider_pin `qwen3.6-35b-a3b-bench`            ← the bench alias
 *   cloud   roster slug `orcarouter/anthropic/claude-opus-5`
 *           provider_pin `orcarouter`                       ← the ROUTER
 *
 * `provider_pin` is built by `_provider_pin_from_model` in run_cumulative.py,
 * which returns the second segment for a `local-llm-proxy/…` slug and the FIRST
 * for anything else. On a cloud slug that first segment is the router, so the
 * previous rule here — prefer provider_pin, else the last path segment —
 * resolved every cloud cell in the bench to the single identity "orcarouter",
 * folding four vendors' floors into one row and attributing all of them to a
 * model that does not exist.
 *
 * So the SEGMENT COUNT decides, because it is the thing that actually differs: a
 * three-segment slug is `{router}/{provider}/{model}` and its identity is the
 * last two segments — exactly the `{provider}/{model}` key the harness validates
 * against and the key the cloud catalogue is keyed by, so the id resolves in
 * both directions without a second mapping.
 */
export function identifyCell(slot, manifest) {
  const slug = str(slot?.model) ?? str(manifest?.model) ?? null;
  const parts = slug ? slug.split("/").filter(Boolean) : [];

  if (parts.length >= 3) {
    const [router, provider, ...rest] = parts;
    return {
      id: `${provider}/${rest.join("/")}`,
      kind: "cloud",
      provider,
      router,
      slug,
    };
  }

  // LOCAL. `provider_pin` is authoritative here and is preferred: it is the bare
  // bench alias, which is what the proxy roster's ids are, so the join with
  // bench_models matches rather than nearly matching.
  const pin = str(slot?.provider_pin);
  const id = pin ?? (parts.length ? parts[parts.length - 1] : null);
  return {
    id,
    kind: "local",
    // The relay, named from the slug when it carries one. Not invented when it
    // does not: an unprefixed slug tells us nothing about what served it.
    provider: parts.length >= 2 ? parts[0] : null,
    router: null,
    slug,
  };
}

/**
 * Is this run directory ARCHIVED?
 *
 * The RUNBOOK's archive convention is `mv runs/cumulative runs/cumulative.<why>-<date>`,
 * so any suffix after the base name marks a run the operator deliberately set
 * aside — a dead cell, a void instrument, a superseded campaign.
 *
 * ARCHIVED RUNS MUST NEVER SUPPLY A BASELINE. They were retired precisely
 * because their measurements are not to be built on, and the archive reason is
 * frequently in the directory name itself ("void-truncation", "harness-error").
 * Counting them silently resurrects a floor the operator already rejected, and
 * because the numbers look ordinary nothing downstream can detect it.
 */
export function isArchivedRun(name) {
  return String(name ?? "").includes(".");
}

/** Mirrors the dashboard's own contract. A cell is the unit of measurement. */
const OFF_ARM = "off";

/**
 * A CELL IS FIVE PHASES: 1 build, 4 grades (= max_attempts 5). Mirrors the
 * dashboard contract's PHASES_PER_CELL — the same number, stated in both tiers
 * because they do not share an import, and a cell that reported "2 of 6" on
 * one surface and "2 of 5" on the other would make an operator distrust both.
 */
const PHASES_PER_CELL = 5;

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function readJsonlOrEmpty(path) {
  try {
    const text = await fs.readFile(path, "utf8");
    const out = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // A partially-written final line is normal while a cell is running.
        // Skipping it is correct; failing the whole read would blank the board
        // every time the harness is mid-write.
      }
    }
    return out;
  } catch {
    return [];
  }
}

const int = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The gate tally an attempt record carries, or null.
 *
 * NULL WHEN THERE IS NO TOTAL, and that is the whole point of the function. A
 * record with failures and no `total` cannot be rendered as a ratio, and
 * inventing the denominator from the failures present would produce "5/5" for a
 * cell that failed five of seventy-one — a number that is not merely imprecise
 * but inverted in meaning.
 */
function gateTotals(r) {
  const g = r?.gate_totals;
  if (!g || typeof g !== "object") return null;
  const total = int(g.total);
  if (!total) return null;
  const passed = int(g.pass);
  const failed = int(g.fail);
  return {
    passed,
    failed,
    error: int(g.error),
    not_run: int(g.not_run),
    total,
  };
}

/**
 * Every OFF cell on disk, folded per model.
 *
 * Reads the SCHEDULE for identity and the status stream for measurement, which
 * is the same split the dashboard's stack-ledger uses: a cell that was
 * scheduled but never produced a status record is still a real cell, and
 * dropping it would make a crashed run look like it never happened.
 */
export async function collectOffCells(runsRoot) {
  return (await collectCells(runsRoot)).filter((c) => c.arm === OFF_ARM);
}

/**
 * EVERY cell on disk, both arms.
 *
 * `collectOffCells` was this function with the ON cells dropped on the floor
 * mid-loop. They are kept now because the ledger has to answer a second
 * question — what did the ON cells measured against a floor actually measure —
 * and the answer is read from the same manifests, folded the same way, by the
 * same rules for void instruments and gate tallies. Reading them twice, in two
 * files, with two definitions of "void", is how a cell becomes a floor in one
 * place and an excluded artifact in another.
 */
export async function collectCells(runsRoot) {
  const cells = [];

  // CAMPAIGNS ARE NESTED NOW, and this scan was one level deep. Under the tree
  // a campaign home sits at <tree>/<substrate>/<router>/<provider>/<model>, so a
  // readdir of the runs root returns tree ids and nothing else — every floor
  // would read as empty and every model would look un-floored. `listLive…`
  // walks to the campaign and skips retired trees, which is what makes a reset
  // read as a clean bench here without deleting a thing.
  let entries = [];
  try {
    entries = await listLiveCampaignDirs(runsRoot);
  } catch {
    return cells;
  }

  for (const ent of entries) {
    // Archived runs are excluded entirely — see isArchivedRun().
    if (isArchivedRun(ent.name)) continue;
    const dir = ent.dir;
    const manifest = await readJsonOrNull(join(dir, "manifest.json"));
    if (!manifest) continue;

    const schedule = Array.isArray(manifest.schedule) ? manifest.schedule : [];
    if (!schedule.length) continue;

    const status = await readJsonlOrEmpty(join(dir, "manifest.status.jsonl"));

    // Fold the status stream by sequence_index — one cell may have many
    // attempt records, and the LAST one carries the cell's outcome.
    const folded = new Map();
    for (const r of status) {
      if (r.type !== undefined && r.type !== "attempt") continue;
      const seq = int(r.sequence_index) ?? 0;
      const p = r.progress ?? {};
      const prev = folded.get(seq) ?? {};
      // ── PHASES, COUNTED FROM ATTEMPTS THAT ACTUALLY HAPPENED ────────────
      //
      // A cell is five phases: one build and four grades, and each writes an
      // attempt record. Counting DISTINCT attempt numbers is what makes "1 of
      // 5" a measurement rather than a guess — a cell that is mid-build has one
      // record and genuinely has completed no grade. Deriving it from elapsed
      // time or from the verdict's presence would both invent progress the
      // stream does not show.
      const attempts = new Set(prev.attempts ?? []);
      const attemptNo = int(r.attempt);
      if (attemptNo !== null) attempts.add(attemptNo);
      folded.set(seq, {
        attempts,
        verdict: str(r.verdict) ?? prev.verdict ?? null,
        turns: int(p.turns) ?? prev.turns ?? null,
        tokens: int(p.total_tokens) ?? int(p.tokens) ?? prev.tokens ?? null,
        wall_seconds: int(p.wall_seconds) ?? prev.wall_seconds ?? null,
        // ── BUILD CHUNKS: THE FIRST NON-EMPTY, NEVER THE LAST ─────────────
        //
        // A THIRD FOLD RULE, and it is neither of the two below it. Truncation
        // counters are SUMMED; `gate_totals` is OVERWRITTEN by the last
        // attempt. Build chunks are neither — they exist ONLY on attempt 1.
        // Attempts 2+ are single-prompt feedback drives that run no chunks at
        // all and therefore carry an empty list.
        //
        // Overwriting (the `gate_totals` rule) would therefore BLANK the strip
        // the instant attempt 2 lands, and the operator would watch the build
        // record vanish from a cell that is still being graded — indis-
        // tinguishable from "this cell never ran a build". Hence: keep the
        // first non-empty and never let a later empty displace it.
        build_chunks: (Array.isArray(p.build_chunks) && p.build_chunks.length)
          ? p.build_chunks
          : (prev.build_chunks ?? null),
        // ── GATES: THE LAST ATTEMPT'S, NOT THE UNION ──────────────────────
        //
        // `gate_totals` is written per ATTEMPT ({pass, fail, error, not_run,
        // total}), and a cell's correctness is the state it ENDED in. Folding
        // by overwrite is therefore correct where the truncation counters just
        // above are summed: a gate that failed on attempt 1 and passed on
        // attempt 3 is a passing gate, while a truncation on any attempt taints
        // the whole cell for good.
        //
        // A REAL DENOMINATOR EXISTS AND IS USED. The board's older gate surface
        // counts "distinct gates ever observed failing" because the harness's
        // gate REPORT publishes failures only — but the status stream carries
        // `gate_totals.total` (71 on the live campaign), which is the suite
        // size. Where it is present the ratio is the true one; where it is
        // absent this stays null rather than falling back to a universe of
        // observed failures, because two different denominators rendered in one
        // column is the exact ambiguity that makes a ratio unreadable.
        gates: gateTotals(r) ?? prev.gates ?? null,
        terminal_reason: str(r.terminal_reason) ?? prev.terminal_reason ?? null,
        // ── SEEDED MARKER: STICKY, NEVER OVERWRITTEN BACK TO NULL ───────────
        //
        // TOP-LEVEL on the attempt record — a sibling of `progress`, the same
        // field-path trap as the truncation counters below. The producer
        // (WO-SNAP-04) may write it on every attempt or only the first; a later
        // record that omits it must NOT un-seed the cell, because un-seeding
        // would let a cell that never ran a build back into the scorable floor
        // set. Same direction as the summed truncations: once tainted, always
        // tainted.
        seeded_from_snapshot: str(r.seeded_from_snapshot) ?? prev.seeded_from_snapshot ?? null,
        // Summed across attempts, not overwritten: a truncation in ANY attempt
        // taints the cell, and the last attempt reporting none does not undo it.
        //
        // BOTH FIELDS LIVE ON THE RECORD, NOT ON `progress`. The harness writes
        // them at the top level of each status line (verified against a real
        // manifest.status.jsonl: `truncated_turns` and `length_truncations` are
        // siblings of `progress`, absent from `progress` itself). Reading
        // `p.truncated_turns` therefore always resolved to `undefined`, which
        // `int()` folds to `null` and `?? 0` folds to zero — the sum could never
        // become positive no matter how many turns truncated, so the void-
        // instrument check below (`truncated_turns > 0`) was dead: a cell with
        // `terminal_reason: "attempt_ceiling_reached"` and 35 truncated turns
        // (harness scorer verdict: void, provider_truncation) still folded here
        // as `scorable: true`. The two void definitions this file's own header
        // comment says must never disagree, disagreed.
        truncated_turns: (prev.truncated_turns ?? 0) + (int(r.truncated_turns) ?? 0),
        // The unrecovered-anomaly subset — every anomalous turn the harness
        // did NOT recover — and the one the void check reads. Same top-level
        // placement and the same summed-across-attempts rule as the two beside
        // it: an unrecovered instrument failure in ANY attempt taints the cell.
        unrecovered_anomaly_turns:
          (prev.unrecovered_anomaly_turns ?? 0) + (int(r.unrecovered_anomaly_turns) ?? 0),
        length_truncations: (prev.length_truncations ?? 0) + (int(r.length_truncations) ?? 0),
        // A cell is only GREEN if it actually passed. Anything else leaves the
        // truncation signals decisive.
        full_green: str(r.verdict) === "PASS" || prev.full_green === true,
      });
    }

    for (let i = 0; i < schedule.length; i += 1) {
      const slot = schedule[i] ?? {};

      // THE FIELD IS `memory_mode`. The harness writes `memory_mode: "off"`,
      // not `mode` or `arm` — verified against a real manifest. Reading the
      // wrong key does not throw, it silently yields ZERO OFF cells, which
      // presents as "no baseline has ever been run" and would re-enable
      // [+baseline] on a model that already has a valid floor.
      const arm = str(slot.memory_mode) ?? str(slot.mode) ?? str(slot.arm);

      const seq = int(slot.sequence_index) ?? i;
      const meas = folded.get(seq) ?? null;

      // THE TWO SUBSTRATES NAME THEMSELVES DIFFERENTLY — see identifyCell().
      // A local cell resolves to its bare bench alias (which is what the proxy
      // roster's ids are); a cloud cell resolves to its `{provider}/{model}`
      // key (which is what the OrcaRouter provider block is keyed by). Both
      // join with the surface that owns them, and neither is guessed at.
      const who = identifyCell(slot, manifest);
      const model = who.id;

      // ── VOID INSTRUMENT — RUNBOOK 5.10, mirrored from stack-ledger.mjs:420 ──
      //
      // A non-green terminal attempt carrying a provider-side truncation signal
      // is an INSTRUMENT failure, never a capability result. The rule is copied
      // from the dashboard's own reader deliberately: two different definitions
      // of "void" would let a cell be the floor here and be excluded there.
      //
      // `harness_error` is included because the harness itself declared the run
      // unusable. `attempt_ceiling_reached` is NOT void — a model that fails
      // every attempt is a real capability result, and calling it an instrument
      // fault would silently discard the bench's most important finding.
      //
      // ── `unrecovered_anomaly_turns`, NOT `truncated_turns` (2026-09-05) ───
      //
      // Same correction as `harness/cumulative/run_artifacts.py` and
      // `control/board/sources/stack-ledger.mjs`. `truncated_turns` is
      // `len(turn_anomalies)` — EVERY anomaly, loop-guard aborts included — and
      // reading it here voided a cell that had completed five graded attempts
      // at 39/53 because the harness had caught a looping model and recovered
      // it (run 1788599410; all three "truncations" were
      // `terminal: guard_abort` with `finish_reason: "tool-calls"` and
      // `truncations_seen: 0`).
      //
      // Jerry's ruling: nudging on a loop is model behaviour, not a void
      // classifier. The fold reads the producer-stated
      // `unrecovered_anomaly_turns` — non-recoverable anomalies only. An
      // anomaly the harness RECOVERED (`guard_abort`, `provider_unavailable`,
      // `stream_finalize_timeout`) never voids, and the three independent
      // implementations of this rule read one fact instead of subtracting
      // three times and drifting.
      const voidInstrument = Boolean(
        meas
        && !meas.full_green
        && (meas.terminal_reason === "transport_incomplete"
          || meas.terminal_reason === "harness_error"
          || (meas.length_truncations ?? 0) > 0
          || (meas.unrecovered_anomaly_turns ?? 0) > 0),
      );

      cells.push({
        // The id an operator quotes. Derived from the two facts below it, so it
        // names this exact cell forever and is never written anywhere.
        id: baselineId(ent.relative, seq),
        run_dir: ent.relative,
        sequence_index: seq,
        model,
        // LOCAL or CLOUD, and who served it. The design's KIND and
        // MODEL · PROVIDER columns, resolved from the manifest rather than from
        // a naming convention the board would have to re-guess.
        kind: who.kind,
        provider: who.provider,
        router: who.router,
        model_slug: who.slug,
        arm,
        state: meas ? "complete" : "not_started",
        void_instrument: voidInstrument,
        // The snapshot id this cell was seeded from, or null (WO-SNAP-03). A
        // seeded cell skips the build, so its turn/token totals sit on a
        // different scale than a measured floor — `baselineFor` excludes it
        // from the scorable set and refuses with its own reason.
        seeded_from_snapshot: meas?.seeded_from_snapshot ?? null,
        // Bounded at the cell's five phases: a run configured above the ceiling
        // could produce more attempt records than there are phases, and "6 of
        // 5" is not a progress report, it is a rendering bug wearing one.
        phases: { done: meas ? Math.min(meas.attempts.size, PHASES_PER_CELL) : 0, total: PHASES_PER_CELL },
        verdict: meas?.verdict ?? null,
        turns: meas?.turns ?? null,
        tokens: meas?.tokens ?? null,
        wall_seconds: meas?.wall_seconds ?? null,
        gates: meas?.gates ?? null,
        // WO-CHUNKVIS-1. Null means "no data" and MUST render as such — never
        // as "every chunk incomplete". A board newer than its backend would
        // otherwise cry wolf on every historical cell.
        build_chunks: meas?.build_chunks ?? null,
        terminal_reason: meas?.terminal_reason ?? null,
        // CONTEXT EXHAUSTED (harness/context_budget.py): the session ran out of
        // room and the harness stopped the cell there. A RESULT, not an
        // instrument fault — the last graded round is the cell's measurement.
        context_exhausted: meas?.terminal_reason === "context_exhausted",
        created_at: str(manifest.created_at),
      });
    }
  }

  return cells;
}

/**
 * The baseline for ONE model: the newest OFF cell that is complete, not void,
 * and not seeded from a snapshot.
 *
 * Returns the gate AND its reason. A refusal without a reason is what makes an
 * operator click a dead button repeatedly, so every false here carries the
 * sentence explaining it.
 */
export function baselineFor(model, offCells) {
  const mine = offCells.filter((c) => c.model === model);
  // Out of room with NOTHING graded (it stopped during the build) is not a
  // floor: there is no measurement to subtract a run from.
  const exhaustedUngraded = (c) => c.context_exhausted === true && !c.gates;
  const scorable = mine.filter(
    (c) => c.state === "complete" && !c.void_instrument && !c.seeded_from_snapshot && !exhaustedUngraded(c),
  );
  const exhausted = mine.filter(
    (c) => c.state === "complete" && !c.void_instrument && !c.seeded_from_snapshot && exhaustedUngraded(c),
  );
  const seeded = mine.filter((c) => c.state === "complete" && Boolean(c.seeded_from_snapshot));
  const voids = mine.filter((c) => c.state === "complete" && c.void_instrument);
  const running = mine.filter((c) => c.state !== "complete");

  if (scorable.length) {
    // Newest wins: a re-baseline is a sanctioned, declared act, and the most
    // recent valid floor is the one subsequent cells are measured against.
    const b = scorable[scorable.length - 1];
    return {
      exists: true,
      scorable: true,
      id: b.id,
      run_dir: b.run_dir,
      sequence_index: b.sequence_index,
      measured_before: b.created_at,
      kind: b.kind,
      provider: b.provider,
      model_slug: b.model_slug,
      turns: b.turns,
      tokens: b.tokens,
      wall_seconds: b.wall_seconds,
      gates: b.gates,
      verdict: b.verdict,
      context_exhausted: b.context_exhausted === true,
      // A second valid OFF cell is not an error, but it IS a fact the operator
      // should see: only one of them is the floor.
      candidates: scorable.length,
      reason: null,
    };
  }

  // SEEDED CHECKED BEFORE VOID: a cell that is both is refused as seeded — the
  // seeded disqualification is the more fundamental one (the cell never ran a
  // build at all), and a seeded cell has its own reason sentence.
  if (seeded.length) {
    const s = seeded[seeded.length - 1];
    return {
      exists: false,
      scorable: false,
      seeded: true,
      // NO `voided` AND NO `pending` FLAG, deliberately: `baselineList`'s state
      // word then computes "none" and drops the row — a seeded cell never
      // appears on the BASELINES card, and so never reaches `baseline_rows`.
      id: s.id,
      run_dir: s.run_dir,
      sequence_index: s.sequence_index,
      kind: s.kind,
      provider: s.provider,
      model_slug: s.model_slug,
      candidates: 0,
      reason:
        `seeded from snapshot \`${s.seeded_from_snapshot}\` — a seeded cell skips the build `
        + "and sits on a different turn/token scale than the floor a Δ is measured against.",
    };
  }

  if (voids.length) {
    const v = voids[voids.length - 1];
    return {
      exists: false,
      scorable: false,
      voided: true,
      // A VOID FLOOR STILL HAS AN IDENTITY. It is not a floor, but it is a real
      // cell that ran and an operator has to be able to find it on disk to
      // archive it — which is the documented way out of this state.
      id: v.id,
      run_dir: v.run_dir,
      sequence_index: v.sequence_index,
      kind: v.kind,
      provider: v.provider,
      model_slug: v.model_slug,
      candidates: 0,
      reason:
        `the last OFF cell for ${model} is void-instrument (${voids[voids.length - 1].terminal_reason ?? "instrument fault"}) — ` +
        "it produced numbers, but they measure the harness rather than the model, so every Δ " +
        "computed against them would be invalid. Run a new baseline.",
    };
  }

  if (exhausted.length) {
    const x = exhausted[exhausted.length - 1];
    return {
      exists: false,
      scorable: false,
      exhausted: true,
      id: x.id,
      run_dir: x.run_dir,
      sequence_index: x.sequence_index,
      kind: x.kind,
      provider: x.provider,
      model_slug: x.model_slug,
      candidates: 0,
      reason:
        `the last OFF cell for ${model} ran out of context during the build and was stopped before `
        + "anything was graded — there is no measurement to compare a run against. Run a new baseline.",
    };
  }

  if (running.length) {
    const r = running[running.length - 1];
    return {
      exists: false,
      scorable: false,
      pending: true,
      // THE PENDING ROW IS A ROW, NOT AN ABSENCE. The design shows a running
      // baseline holding its place on the card with its state named and its
      // measurements marked pending — so it needs an id and a kind exactly like
      // a closed one. Without them a cell that has been running for twenty
      // minutes is indistinguishable from a model nobody has started.
      id: r.id,
      run_dir: r.run_dir,
      sequence_index: r.sequence_index,
      kind: r.kind,
      provider: r.provider,
      model_slug: r.model_slug,
      // The manifest's creation time. It is the START OF THE CAMPAIGN
      // DIRECTORY, not of this attempt, and it is labelled as such wherever it
      // is rendered — a cell resumed into an old manifest would otherwise read
      // as having run for days.
      campaign_started_at: r.created_at,
      candidates: 0,
      reason: `an OFF cell for ${model} is scheduled or in flight but has not produced a measurement yet`,
    };
  }

  return {
    exists: false,
    scorable: false,
    candidates: 0,
    reason: `no OFF cell has ever been run for ${model} — the floor every Δ is measured against does not exist yet`,
  };
}

/**
 * EVERY BASELINE THAT EXISTS, one row per model that has run an OFF cell.
 *
 * ONE ROW PER MODEL, NOT PER CELL, and that is the rule this file already
 * enforces everywhere else: a model has ONE floor. A model with three OFF cells
 * has one baseline and two superseded attempts, and drawing three rows would
 * invite an operator to compare a run against the wrong one. `candidates`
 * on the row states how many valid cells were found, so the fact that there were
 * others is not hidden — it is just not offered as a choice.
 *
 * THE STATE IS THE ROW'S HEADLINE, and there are four of them because collapsing
 * any two loses the thing the operator needs to do next:
 *
 *   complete  a real floor. ON runs may be measured against it.
 *   running   an OFF cell is in flight. It holds its place and refuses runs
 *             until it closes — there is no total to compare against yet.
 *   void      it ran, it produced numbers, and the numbers measure the harness.
 *             Looks exactly like `complete` from every angle except the one
 *             that counts, which is why it is never folded into "no baseline".
 *   none      no row renders. A model whose newest complete cell is seeded
 *             from a snapshot lands here — the seeded refusal carries no
 *             voided or pending flag — and is dropped, so a seeded cell never
 *             appears on the card. Kept as a case so a future caller cannot
 *             fall through the switch silently.
 */
function baselineList(offCells) {
  const byModel = new Map();
  for (const c of offCells) {
    if (!c.model) continue;
    if (!byModel.has(c.model)) byModel.set(c.model, []);
    byModel.get(c.model).push(c);
  }

  const rows = [];
  for (const [model, cells] of byModel) {
    const b = baselineFor(model, cells);
    const state = b.scorable
      ? "complete"
      : b.voided
        ? "void"
        : b.exhausted
          ? "exhausted"
          : b.pending
            ? "running"
            : "none";
    if (state === "none") continue;

    // Identity comes from the RESOLVED baseline where there is one, and from
    // the newest cell otherwise — a running or void row still has to name the
    // substrate it ran on, and `baselineFor` carries that through for all three.
    const newest = cells[cells.length - 1];

    rows.push({
      id: b.id ?? baselineId(newest.run_dir, newest.sequence_index),
      model,
      kind: b.kind ?? newest.kind,
      provider: b.provider ?? newest.provider,
      model_slug: b.model_slug ?? newest.model_slug,
      state,
      scorable: b.scorable === true,
      run_dir: b.run_dir ?? newest.run_dir,
      sequence_index: b.sequence_index ?? newest.sequence_index,
      measured_before: b.measured_before ?? null,
      campaign_started_at: b.campaign_started_at ?? newest.created_at ?? null,
      turns: b.turns ?? null,
      tokens: b.tokens ?? null,
      wall_seconds: b.wall_seconds ?? null,
      gates: b.gates ?? null,
      verdict: b.verdict ?? null,
      // Stopped at the context limit — on a floor (graded) or on a row that
      // is not one (state "exhausted", nothing graded).
      context_exhausted: b.context_exhausted === true || state === "exhausted",
      // How many OFF cells for this model were found at all, and how many of
      // them were valid. The second number is the one that decides the state;
      // the first is what an operator checks when they expected a floor and
      // there is none.
      cells_seen: cells.length,
      candidates: b.candidates ?? 0,
      reason: b.reason ?? null,
    });
  }

  // NEWEST FIRST, by the cell that defines the row. A card whose top row is the
  // floor most recently measured matches what an operator just did.
  rows.sort((a, b) =>
    String(b.measured_before ?? b.campaign_started_at ?? "").localeCompare(
      String(a.measured_before ?? a.campaign_started_at ?? ""),
    ),
  );
  return rows;
}

/** The stored export. One file, rewritten only when the answer changes. */
export const BASELINES_FILE = "baselines.json";
const BASELINES_CONTRACT_VERSION = 1;

/**
 * THE INDEX — every bench model's floor, resolved together.
 *
 * `models` is the roster to resolve. A model with no OFF cell still gets an
 * entry carrying `exists: false` and the reason, because "this model has no
 * floor yet" is an answer the UI needs to render a gate; omitting it would make
 * an unmeasured model indistinguishable from one that is not on the bench.
 */
async function buildBaselineIndex({ runsRoot, models }) {
  const offCells = await collectOffCells(runsRoot);
  const ids = (models ?? []).map((m) => (typeof m === "string" ? m : str(m?.id))).filter(Boolean);

  const out = {};
  for (const id of ids) out[id] = baselineFor(id, offCells);

  const list = baselineList(offCells);

  return {
    contract_version: BASELINES_CONTRACT_VERSION,
    generated_at: new Date().toISOString(),
    runs_root: runsRoot,
    // Counted, not just listed: "how many OFF cells exist at all" is the first
    // thing to check when a floor is missing that the operator believes ran.
    off_cells_seen: offCells.length,
    models: out,
    // ── THE SAME FLOORS, ROOTED THE OTHER WAY UP ─────────────────────────
    //
    // `models` answers "does model X have a floor" — the question every GATE
    // asks, so it stays keyed by model and keyed by the roster. `list` answers
    // "what floors exist" — the question the BASELINES card is, and it is a
    // different set: it is derived from the CELLS rather than from the roster,
    // so a cloud floor (whose model the local proxy has never heard of) and a
    // floor for a model that has since left the roster both appear, while a
    // rostered model that has never run an OFF cell does not.
    //
    // A ROSTERED MODEL WITH NO CELL IS DELIBERATELY ABSENT. The card lists
    // measurements, not intentions; a placeholder row for every model the bench
    // could theoretically run would put six empty rows above the one real floor
    // and read as six failed baselines. Starting a baseline for such a model is
    // the [+ BASELINE] modal, which is where an absence belongs.
    list,
    counts: {
      complete: list.filter((b) => b.state === "complete").length,
      running: list.filter((b) => b.state === "running").length,
      void: list.filter((b) => b.state === "void").length,
      exhausted: list.filter((b) => b.state === "exhausted").length,
    },
    note:
      "one floor per model. A model with no scorable floor may always start a baseline; a model "
      + "with one may not — re-baselining is a declared act (archive the run), not a button. "
      + "Void-instrument cells are not floors.",
  };
}

/**
 * Derive, publish, return.
 *
 * The write is best-effort and its outcome is REPORTED rather than thrown: the
 * index is the product, and a read-only or full disk must not turn a correct
 * answer into an error. Unchanged content is not rewritten, so a 2s poll does
 * not churn the file or its mtime.
 */
export async function readBaselines({ runsRoot, models }) {
  const index = await buildBaselineIndex({ runsRoot, models });
  const stored = await publishBaselines(runsRoot, index);
  return { ok: true, ...index, stored };
}

async function publishBaselines(runsRoot, index) {
  const path = join(runsRoot, BASELINES_FILE);
  // `generated_at` changes on every derivation, so it is excluded from the
  // comparison — including it would rewrite the file every poll and make the
  // mtime meaningless as a "when did the floor last change" signal.
  const { generated_at: _ignored, ...stable } = index;
  const body = `${JSON.stringify(index, null, 2)}\n`;

  // MISSING IS EXPECTED; UNREADABLE IS NOT. A first run and a post-reset tree
  // both have no prior file, and saying so every poll would be noise. Anything
  // else — a truncated write, a corrupt file, valid JSON of the wrong shape —
  // is evidence about this export that the overwrite is about to destroy, so it
  // is named before it goes. Never refuse to overwrite: the index is the
  // product, and an unreadable file must not be able to freeze the floor.
  let overwrote_unreadable = null;
  try {
    const prev = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(prev);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      // Never reaches the catch: this parses cleanly and is simply not an
      // index. Without this branch it is the quietest path of all.
      overwrote_unreadable = `the previous export parsed as ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed}, not a baseline index`;
    } else {
      const { generated_at: _prevGen, ...prevStable } = parsed;
      if (JSON.stringify(prevStable) === JSON.stringify(stable)) {
        return { path, written: false, reason: "unchanged since the last derivation" };
      }
    }
  } catch (err) {
    if (err?.code !== "ENOENT") {
      overwrote_unreadable = `the previous export could not be read back: ${String(err?.message ?? err)}`;
    }
  }

  if (overwrote_unreadable !== null) {
    console.error(`[baselines] overwriting an unreadable export at ${path}: ${overwrote_unreadable}`);
  }

  try {
    await fs.writeFile(path, body, "utf8");
    return { path, written: true, reason: null, overwrote_unreadable };
  } catch (err) {
    return {
      path,
      written: false,
      reason: `could not write the baseline export: ${String(err?.message ?? err)}`,
      overwrote_unreadable,
    };
  }
}
