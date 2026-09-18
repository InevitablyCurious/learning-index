// ─────────────────────────────────────────────────────────────────────────────
// LIVE PANEL — PHASE SPINE + PROVISIONAL COUNTERS
//
// The phase spine (1 BUILD + 4 GRADEs) and the provisional token counters. Both
// are rendered BY THE GATE WALL (panels/wall.js imports `spine` and
// `provisional` through the live.js entry's re-export), not by the DATA FEED
// card itself — the two halves answer the same question from opposite ends, so
// they share one block on the wall, under the gates those phases produce and at
// the cost those counters report.
//
// PURE: nothing here reads the panel's mutable state, so this module imports
// only the board's format helpers and the odometer. Split from panels/live.js
// (LI-14) with no behaviour change.
// ─────────────────────────────────────────────────────────────────────────────

import { esc, nul, tok, dur } from "../../board.js";
import { odo } from "../tick.js";

// ── THE PHASE SPINE — 1 BUILD + (max_attempts − 1) GRADEs ─────────────────
//
// RENDERED BY THE GATE WALL, alongside the provisional counters. The two halves
// answer the same question from opposite ends — the spine says which phase the
// cell is IN, the counters say what it has SPENT getting there — so they share
// one block, split down the middle, under the gates those phases produce.
// Exported for panels/wall.js; see the note on `provisional` below.

// Mirrors control/board/contract.mjs PHASES_PER_CELL and config.py max_attempts.
const PHASES_PER_CELL = 5;

const PHASES = [
  { n: 1, name: "BUILD", label: "initial" },
  ...Array.from({ length: PHASES_PER_CELL - 1 }, (_, i) => ({
    n: i + 2,
    name: "GRADE",
    label: `verdict-pass-${i + 1}`,
  })),
];

/**
 * Map the harness phase string onto 1..PHASES_PER_CELL. The harness emits
 * `initial`, `initial-chunk-N`, `feedback-N`, `verdict-pass-N` (each possibly
 * with a `-zero-tool-resume-M` suffix). Attempt N's verdict/feedback maps to
 * phase N+1: feedback-1 → 2, …, feedback-4 → 5.
 */
export function phaseIndex(phase) {
  const p = String(phase ?? "").toLowerCase();
  if (!p) return null;
  if (p.startsWith("initial")) return 1;
  const m = p.match(/^(?:feedback|verdict-pass)-(\d+)/);
  if (!m) return null;
  const idx = Number(m[1]) + 1;
  return idx >= 1 && idx <= PHASES_PER_CELL ? idx : null;
}

/** Chunk number out of `initial-chunk-4`. Meaningful in phase 1 ONLY. */
export function chunkOf(phase) {
  const m = String(phase ?? "").match(/chunk-(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * WHERE THE CELL IS — the harness's own word for it, not a parsed one.
 *
 * TWO SOURCES, AND THEY ARE NOT EQUAL.
 *
 *   `board.live.phase`  the producer's `phase.start` record. Authoritative.
 *   `board.run.phase`   recovered BY REGEX from PROGRESS lines in the launch
 *                       log (sources/run-log.mjs). A fallback, and only that.
 *
 * The parsed one is emitted by the build/serve loop, so it stops moving the
 * moment the build ends: with grading under way and 36 of 53 gates already
 * passing, it still read `initial-chunk-6` and this spine said BUILD · RUNNING.
 * The harness had written `phase.start feedback-1` six milliseconds after
 * `attempt.end` and no consumer read it.
 *
 * The fallback is KEPT rather than deleted, because `live.jsonl` is written from
 * cell start and a run begun before it existed has none — and because the tail
 * window can scroll past every `phase.start` on a long cell. A board that went
 * blank in those cases would have traded a lagging phase for no phase.
 */
function activePhase(r, board) {
  const stated = board?.live?.phase ?? null;
  if (stated) {
    const idx = phaseIndex(stated);
    if (idx !== null) return { idx, stated: true };
  }
  const idx = phaseIndex(r.phase);
  return { idx, stated: false };
}

export function spine(r, board) {
  const { idx: active, stated } = activePhase(r, board);
  const stopped = r.state === "complete" || r.state === "aborted";

  if (active === null && !stopped) {
    return `<div class="spine"><div class="null">${esc("no phase observed — nothing has reported yet")}</div></div>`;
  }

  // ATTEMPT VERDICTS COME FROM `attempt.end`, which is the producer saying an
  // attempt CLOSED and how it went. A phase the harness has finished must never
  // read as running, whatever the parsed phase says.
  const verdicts = new Map();
  for (const a of board?.live?.attempts ?? []) {
    if (Number.isFinite(a?.attempt)) verdicts.set(a.attempt, a);
  }

  const ended = board?.live?.ended ?? null;
  return `<div class="spine">${PHASES.map((p) => {
    let state =
      active === null ? "pending" : p.n < active ? "done" : p.n === active ? (stopped ? "done" : "running") : "pending";
    // A PHASE THE CELL NEVER FINISHED IS NOT DONE. When the cell has stopped,
    // a phase with no closed attempt was cut off (the one it was in) or never
    // reached (every one after it) — saying DONE there claims a grade that
    // never ran.
    if (stopped && !verdicts.has(p.n)) state = p.n <= (active ?? 0) ? "stopped" : "notrun";
    return phaseRow(p, state, r, board, verdicts.get(p.n), stated, ended);
  }).join("")}</div>`;
}

const END_WORD = { context_exhausted: "CONTEXT EXHAUSTED" };

function phaseRow(p, state, r, board, verdict, stated, ended) {
  const title = p.n === 1 ? `${p.n} — ${p.name}` : `${p.n} — ${p.name} · ${p.label}`;
  const word =
    state === "running" ? "RUNNING"
      : state === "done" ? "DONE"
        : state === "stopped" ? "STOPPED"
          : state === "notrun" ? "NOT RUN"
            : "PENDING";

  // Chunks are internal to phase 1 and are drawn ONLY while it is the phase.
  const ticks =
    p.n === 1 && state !== "pending" ? chunkTicks(r, board, state) : "";

  // THE VERDICT OF A CLOSED ATTEMPT, from `attempt.end`.
  //
  // ── "failed" AGAIN — the two numbers now count the same thing ────────────
  //
  // This briefly read "N findings". It had to: the wall counted failing GATES
  // while this row counted `attempt.end.failed` = `len(failed_gates)`, and the
  // gate runner's list mixed suite gates with individual conformance
  // sub-problems. Measured across all five attempts of run 1788599410 the two
  // ran a constant +10 apart — the 11 conformance problems collapsing into the
  // single `CONF` gate — and both were labelled "failed", which read as a
  // contradiction.
  //
  // Conformance is now enumerated as 65 real gates (`pregate.spec.ts`), so one
  // finding IS one gate and the two counts agree. The word goes back to what it
  // means. The producer's number is still what is shown — the board does not
  // publish a second opinion about a closed attempt.
  const outcome =
    verdict && state === "done"
      ? `<span class="ph-verdict ${verdict.verdict === "PASS" ? "good" : "bad"}"${
          Number.isFinite(verdict.failed)
            ? ` title="${esc(
                `${verdict.failed} gates failing at the close of attempt ${verdict.attempt}, `
                + "as the gate runner recorded it.",
              )}"`
            : ""
        }>${esc(
          `${verdict.verdict ?? "?"}${Number.isFinite(verdict.failed) ? ` · ${verdict.failed} failed` : ""}`,
        )}</span>${churn(verdict)}${stageChip(verdict)}`
      : state === "stopped"
        ? `<span class="ph-verdict bad" title="${esc(`the cell stopped (${ended?.terminal_reason ?? "reason not recorded"}) before this phase was graded`)}">${esc(
          `NOT GRADED${ended?.terminal_reason ? ` — ${END_WORD[ended.terminal_reason] ?? ended.terminal_reason}` : ""}`,
        )}</span>`
        : "";

  return `
    <div class="ph ${state}"${state === "running" && !stated ? ` title="phase recovered from the launch log — the harness's own phase.start record was not readable"` : ""}>
      <div class="ph-top"><span>${esc(title)}</span>${outcome ? `<span class="ph-out">${outcome}</span>` : ""}<span class="ph-state">${word}</span></div>
      ${ticks}
    </div>`;
}

/**
 * PLAYER ORDER: the stage this round reached — the model was told only that
 * stage's problems. The count past it were graded and not told.
 */
function stageChip(v) {
  if (!Number.isFinite(v.stage)) return "";
  const past = Number.isFinite(v.withheld) && v.withheld ? ` · ${v.withheld} held back` : "";
  return `<span class="ph-stage" title="${esc(
    `the model was told only the problems of stage ${v.stage} (${v.stage_name ?? ""}); `
    + `${v.withheld ?? 0} failing checks in later stages were graded but not told`,
  )}">${esc(`stage ${v.stage}${v.stage_name ? ` · ${v.stage_name}` : ""}${past}`)}</span>`;
}

/**
 * What a closed attempt changed against the one before it. Without this a
 * round that fixed two gates and broke two reads "27 failed" like the round
 * before it, and looks as if nothing moved.
 */
function churn(v) {
  if (!Number.isFinite(v.fixed) || !Number.isFinite(v.broke)) return "";
  if (!v.fixed && !v.broke) return `<span class="ph-churn">no change</span>`;
  const bits = [];
  if (v.fixed) bits.push(`<span class="ph-churn good">${esc(`${v.fixed} fixed`)}</span>`);
  if (v.broke) bits.push(`<span class="ph-churn bad">${esc(`${v.broke} broke`)}</span>`);
  return bits.join("");
}

/**
 * The work orders inside phase 1.
 *
 * ── A FINISHED BUILD HAS NO CURRENT CHUNK ──────────────────────────────────
 * `phaseState` is load-bearing and was missing. `r.chunk.current` is the last
 * chunk the build reached and it KEEPS that value after the build ends — so the
 * final tick stayed `now` and went on pulsing through the whole of grading,
 * advertising work that had already finished. Motion on this board means one
 * thing, "this is happening right now", and a tick that pulses after its phase
 * closed breaks that for every other animation on the card.
 *
 * When the phase is done every tick is done: there is no current work order,
 * because there is no current work.
 */
function chunkTicks(r, board, phaseState) {
  const total = r.chunk?.total ?? 6;
  const cur = r.chunk?.current ?? chunkOf(r.phase);
  const finished = phaseState === "done";

  if (!cur) {
    return `<div class="ph-note">${esc(`${total} work orders — none reported yet`)}</div>`;
  }
  const ticks = Array.from({ length: total }, (_, i) => {
    const n = i + 1;
    const cls = finished ? "done" : n < cur ? "done" : n === cur ? "now" : "todo";
    return `<span class="tick ${cls}"></span>`;
  }).join("");
  const note = finished
    ? `all ${total} work orders complete — chunks are internal to phase 1`
    : `work order ${cur} of ${total} — chunks are internal to phase 1`;
  return `
    <div class="ticks">${ticks}</div>
    <div class="ph-note">${esc(note)}</div>`;
}

/**
 * PROVISIONAL COUNTERS — every token category the agent reports, labelled,
 * all five summed into ONE total.
 *
 * ── IT IS RENDERED BY THE GATE WALL, NOT BY THIS CARD ──────────────────────
 * Exported and called from panels/wall.js. The two cards in the axes row are
 * stretched to a common height, so the shorter one carries dead space — and
 * measured across the three curve tabs the gate wall was carrying 13px, 533px
 * and 137px of it. This block is 262px, which is what closes that gap without
 * simply moving it to the other card (the whole spine is 527px and would have
 * made the wall the tall one instead).
 *
 * It also belongs there on the argument. The gate wall answers "is the running
 * cell correct"; these counters answer "at what cost". Correctness and
 * efficiency for one cell, in one card, is the board's own thesis rather than a
 * space-filling accident — and the phase spine stays here, next to the event
 * feed, which is the same temporal story told twice over.
 *
 * ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
 * This block used to render `tokens.input + tokens.output` and label it with
 * nothing at all — a bare "138K" between the turn count and the clock. It
 * dropped `reasoning` and both cache figures on the floor. On the
 * deepseek-v4-flash cell that exposed this, reasoning alone was 239,381
 * against an input+output of 201,768, and cache read was 41.5M. The board was
 * reporting a fraction of the tokens the run actually put through the
 * provider and presenting it as the total.
 *
 * ── WHY CACHE READ IS IN THE TOTAL ─────────────────────────────────────────
 * An earlier revision showed cache read below the rule and dimmed, excluded
 * from the sum, on the reasoning that re-reading an unchanged prefix is not
 * "new work". That was wrong for the question this instrument exists to
 * answer. Operator's ruling, and it is correct:
 *
 *   Cache reads are BILLED. The benchmark asks whether injected memory saves
 *   tokens. Memory injection makes the prompt bigger, and a bigger prompt is
 *   re-read on EVERY turn — so the cost of memory lands in cache read
 *   multiplied by the turn count, which is precisely where it would hide if
 *   this figure sat outside the total. Excluding it lets the memory arm look
 *   cheap while it is the expensive one.
 *
 * At 41.5M against 441K generated, cache read is ~99% of the tokens processed.
 * It is not a footnote to the measurement; on a long agentic cell it IS the
 * measurement. It renders at full weight alongside the others.
 *
 * ── A PARTIAL TOTAL SAYS SO ────────────────────────────────────────────────
 * Only `opencode-serve` observes reasoning and the cache figures, and it is
 * opt-in and network-bound. When it is unwired, `status-stream` still supplies
 * input and output from the run artifacts. The total then sums 2 of 5, is
 * marked `partial`, and names what is missing. It is never silently presented
 * as whole — that silence was the original defect.
 *
 * ZERO IS AN OBSERVATION. `cache write` is 0 on this provider and renders as
 * 0, not as absent. Only a genuinely unobserved category reads "unobserved".
 *
 * ── NOTHING CLIPS ──────────────────────────────────────────────────────────
 * The spine column is a hard 340px track (300px under 1600px). The grid is
 * `1fr auto`: the value takes the width its digits need and the LABEL
 * ellipsises if anything has to give. Verified against a 12-digit value down
 * to 200px. A shortened word is recoverable from context; a truncated figure
 * on a measuring instrument is a wrong reading.
 */
export function provisional(r, running) {
  const t = r.tokens ?? {};
  const mark = running ? " <span class='muted'>\u203a</span>" : "";

  // Prompt side first, then generation side. All five are billed and all five
  // are summed.
  const parts = [
    { label: "input", v: numOrNull(t.input) },
    { label: "cache read", v: numOrNull(t.cache_read) },
    { label: "cache write", v: numOrNull(t.cache_write) },
    { label: "output", v: numOrNull(t.output) },
    { label: "reasoning", v: numOrNull(t.reasoning) },
  ];
  const seen = parts.filter((p) => p.v !== null);
  const missing = parts.filter((p) => p.v === null);
  const total = seen.length ? seen.reduce((a, p) => a + p.v, 0) : null;
  const partial = total !== null && missing.length > 0;

  return `
    <div class="prov-tot">
      <span class="kick">${running ? "PROVISIONAL — RUNNING TOTALS, NOT FINAL" : "CELL TOTALS"}</span>
      <div class="big">
        <span>${r.turns === null || r.turns === undefined ? nul("turns unobserved") : `${odo(r.turns, { float: true }) ?? esc(String(r.turns))} turns${mark}`}</span>
        <span class="${partial ? "tkpartial" : ""}">${total === null ? nul("tokens unobserved") : `${odo(total, { fmt: "tok" }) ?? esc(tok(total))}${mark}`}</span>
        <span>${r.elapsed_s === null || r.elapsed_s === undefined ? nul("time unobserved") : `${esc(dur(r.elapsed_s))}${mark}`}</span>
      </div>

      <div class="tkbl">
        <span class="kick tkhead">TOKENS</span>
        ${parts.map((p) => tokRow(p.label, p.v)).join("")}
        ${sumRow(partial ? "total · partial" : "total", total, r.turns, partial)}
        ${cacheHitRow(t)}
      </div>

      ${partial ? `<div class="tknote">${esc(`total sums ${seen.length} of 5 — ${missing.map((m) => m.label).join(", ")} unobserved (agent serve source is off or unreachable)`)}</div>` : ""}
    </div>`;
}

/** null-safe passthrough — 0 is a real observation and must not become null. */
function numOrNull(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

/** Exact digits with thousands separators. The headline rounds; a breakdown
 *  that also rounded could not be reconciled against anything. */
function exact(n) {
  return Number(n).toLocaleString("en-US");
}

/**
 * CACHE HIT RATE — the cost signal the token counts alone cannot show.
 *
 *   hit = cache read / (input + cache read + cache write)
 *
 * i.e. of every prompt token the provider processed this cell, what fraction
 * arrived already cached. Output and reasoning are NOT in the denominator:
 * they are generated, never cached, and including them would make the rate
 * drift with verbosity instead of with cache behaviour.
 *
 * ── WHY THIS IS ON THE BOARD ───────────────────────────────────────────────
 * The thing under measurement is a memory system that INJECTS text into the
 * prompt. A cached prompt is matched by PREFIX: change something early in the
 * context and every token after it must be re-sent uncached. So a memory
 * system that writes into the prompt at the wrong moment can invalidate the
 * cache on every operation, and the bill moves from the cached rate to the
 * full input rate across the whole context — a large cost difference that is
 * INVISIBLE in the token total, because the token count barely moves while
 * the price per token multiplies.
 *
 * Read it as: high and steady = the prefix is stable. A drop, or a rate that
 * is structurally lower on the memory arm than the control arm, means memory
 * is busting the cache and the arm is more expensive than its token count
 * suggests.
 *
 * NOT SHOWN rather than shown wrong: the rate needs all three prompt-side
 * categories. If any is unobserved the row says so — a hit rate computed over
 * a partial denominator would read as a real measurement and be a fiction.
 */
function cacheHitRow(t) {
  const input = numOrNull(t.input);
  const read = numOrNull(t.cache_read);
  const write = numOrNull(t.cache_write);
  if (input === null || read === null || write === null) {
    return `
      <div class="tkrow tkrate">
        <span class="tkl">cache hit</span>
        <span class="tkv">${nul("unobserved")}</span>
      </div>`;
  }
  const prompt = input + read + write;
  if (prompt <= 0) {
    return `
      <div class="tkrow tkrate">
        <span class="tkl">cache hit</span>
        <span class="tkl">${esc("no prompt tokens yet")}</span>
      </div>`;
  }
  const hit = (read / prompt) * 100;
  // Two decimals: at 99.xx% the interesting movement is in the hundredths, and
  // rounding to a whole number would paint 99.4% and 99.9% as the same figure
  // while they differ by ~8x in uncached tokens.
  // THE RATE CLIMBS BUT DOES NOT FLOAT A DELTA. "+0.03" of a percentage is not
  // a spend, and floating it beside rows that ARE spends would put two
  // different kinds of number in one visual language.
  return `
    <div class="tkrow tkrate">
      <span class="tkl">cache hit</span>
      <span class="tkv">${odo(hit, { fmt: "pct" }) ?? `${esc(hit.toFixed(2))}%`}</span>
    </div>
    <div class="tkrow tkrate tksubrow">
      <span class="tkl">uncached prompt</span>
      <span class="tkv">${odo(input + write, { float: true }) ?? esc(exact(input + write))}</span>
    </div>`;
}

/**
 * THE BOTTOM ROW — TWO NUMBERS, AND THEY ARE NOT MULTIPLIED.
 *
 * `total` is the sum of the categories listed above it and nothing else.
 * `turns` sits beside it as a second, INDEPENDENT reading — it is not a factor,
 * not a divisor, and no figure on this panel is derived from it.
 *
 * That separation is deliberate and worth stating, because the obvious-looking
 * relationship is false. Context is not constant across a cell: it grows every
 * turn (turn 1 carried ~5K here, turn 298 carried ~292K). So "turns × context"
 * with the FINAL context — the number the TUI shows — overstates a cell by
 * roughly 75%, and with the AVERAGE context it is exactly true only because
 * average context IS total prompt ÷ turns, which computes nothing you did not
 * already have. Either way it silently drops output and reasoning, which are
 * generated tokens billed several times higher than cached ones.
 *
 * So the two numbers are shown, and left alone. The unit word rides on the
 * turn count so a reader can never take it for a token figure — two bare
 * numbers side by side under a heading that says TOKENS is exactly how that
 * misreading happens.
 */
function sumRow(label, total, turns, partial) {
  const turnTxt =
    turns === null || turns === undefined || !Number.isFinite(turns)
      ? nul("turns unobserved")
      : `${odo(turns) ?? esc(exact(turns))} turns`;
  return `
    <div class="tkrow tksum ${partial ? "tkpartial" : ""}">
      <span class="tkl">${esc(label)}</span>
      <span class="tkv">${total === null ? nul("unobserved") : (odo(total, { float: true }) ?? esc(exact(total)))}<span class="tkbar">|</span><span class="tkturns">${turnTxt}</span></span>
    </div>`;
}

function tokRow(label, v, cls = "") {
  // EVERY CATEGORY FLOATS ITS DELTA. Which line moved is the question an
  // operator is actually asking of this table — a run whose cache read climbs
  // while input stays flat is a different run from the reverse, and the two
  // used to look identical because only the digits changed.
  return `
    <div class="tkrow ${cls}">
      <span class="tkl">${esc(label)}</span>
      <span class="tkv">${v === null ? nul("unobserved") : (odo(v, { float: true }) ?? esc(exact(v)))}</span>
    </div>`;
}
