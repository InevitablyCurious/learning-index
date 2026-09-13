// ─────────────────────────────────────────────────────────────────────────────
// PANEL: DATA FEED — the running cell, or a concluded one, in the same surface
//
// ── ONE FEED SURFACE, TWO SOURCES ───────────────────────────────────────────
//
// This card was LIVE RUN and read one source: the cell in flight. It now reads
// EITHER that or a concluded baseline's frozen record, chosen from the BASELINES
// card, and it is the same card either way — same tabs, same filter chips, same
// row renderers, same scroll.
//
// A SECOND SURFACE WAS BUILT FIRST AND WAS THE WRONG ANSWER. The concluded-run
// feeds originally rendered as their own stacked sections inside the baseline
// drawer, reusing this file's row renderers. Same rows, but a reader arriving at
// them had no kind chips, no source/severity facets, no tabs and no jump pill —
// so the surface for reading four thousand rows was the one WITHOUT the tools
// for reading four thousand rows. Reusing a renderer is not reusing a surface.
//
// THE SELECTION IS EXCLUSIVE WITH A LIVE CELL, and the exclusion is enforced
// where the selection is offered (panels/ledger.js): while a cell is in flight
// this card belongs to it, and a historical selection cannot be made. A run
// starting under an open historical selection clears it — the live cell outranks
// a record, and a card silently showing yesterday while today is running is the
// exact defect this whole board exists to prevent.
//
// Two columns: the PHASE SPINE and the EVENT FEED.
//
// ── THE SPINE IS 5 PHASES, NOT 6 ────────────────────────────────────────────
// A cell is BUILD (`initial`) → 4 GRADEs (`verdict-pass-1` … `verdict-pass-4`),
// one per check+fix attempt (max_attempts = 5). The six work orders are
// SUB-TICKS INSIDE PHASE 1 and are rendered only there. Showing "6 phases"
// (an earlier misreading) makes a cell in phase 2 look 1/6 done when it is
// 2/5 done.
//
// ── FEED BEHAVIOURS ARE PRESERVED VERBATIM ──────────────────────────────────
// These were built and verified against a live 45s capture and are NOT
// re-derived here — they are carried over intact, and every one of them exists
// because its absence was a real observed defect:
//   · oldest-first, constant 34px row height
//   · per-kind filter chips with live counts, all ON by default
//   · render cap 400, trimmed from the TOP with scroll compensation
//   · sticky-bottom with BOTTOM_EPS=24 tolerance (exact equality drops the
//     operator out of follow mode on fractional scroll heights)
//   · "N new ↓" pill when detached — announces without stealing the viewport
//   · append past a seq watermark, never innerHTML rebuild (a rebuild resets
//     scrollTop every poll and makes "new" undetectable)
//   · one-shot flash on background + inset left rule ONLY — never height,
//     margin or transform, which would reflow the list under the eye
//   · prefers-reduced-motion → static rule, no animation
//
// PROVISIONAL COUNTERS. A running cell's totals are marked provisional and
// suffixed ›. Presenting a mid-flight total as final is the same lie as
// presenting a partial delta as a result.
// ─────────────────────────────────────────────────────────────────────────────

import { esc, nul, tok, dur } from "../board.js";
import { odo } from "./tick.js";
import {
  createFacet,
  toggleFacet,
  clearFacet,
  facetAccepts,
  facetActive,
  facetState,
  facetSignature,
  facetPicked,
} from "./facet.js";

// `user` is the verbatim text the harness hands the model AS A USER TURN — the
// task chunk, the pass verdict, the failure feedback (WO-FEEDBACK-1). It is the
// single most consequential input the benchmarked model receives, and judging
// whether it reads like a person wrote it is the whole point of the surface, so
// it gets its own chip rather than being folded in with harness plumbing.
//
// `harness` is the GRADING narrative itself — the phase starts, gate outcomes
// and attempt boundaries the harness publishes on its own PROGRESS channel
// (control/gate-events.mjs, kind:"harness"). The control plane has emitted
// these rows since WO-GRADE-VIS-1, but this panel never declared the kind: it
// was absent from KIND_MARK, from `filters` and from the chip row, so the rows
// fell through to the `·` fallback mark, could not be filtered, and read as
// low-value plumbing.
//
// That is backwards. Between attempts the AGENT IS IDLE BY DESIGN while the
// harness grades, so every agent-sourced kind correctly goes silent and this is
// the ONLY kind still speaking — it is precisely the window in which an
// operator has no other signal, and the one that distinguishes "grading" from
// "wedged". It is declared last so it reads as the outermost frame around the
// agent's activity rather than as one more agent event.
// THE KINDS THIS FEED CAN CARRY, and therefore the chips it draws.
//
// `harness` LEFT (2026-09-07). The four row types it named — gate attempt/phase
// start, phase end, timeout — are what the HARNESS did, which is the backend
// feed; they were also scraped from `PROGRESS step=…` log lines that carry no
// timestamp, so they rendered with a blank time column and could not be ordered.
// The same events are in the cell's `live.jsonl` WITH times. A chip whose count
// is structurally always 0 reads as "this never happens", so the chip went with
// the rows rather than being left to say nothing.
export const EVENT_KINDS = ["tool", "file", "thinking", "error", "lifecycle", "user"];
const KIND_MARK = { tool: "$", file: "~", thinking: "·", error: "!", lifecycle: "◦", user: ">", harness: "▣" };

export const EVENT_RENDER_CAP = 400;
export const BOTTOM_EPS = 24;

/**
 * Filter state lives here, client-side, and survives the board's re-render.
 *
 * PICK WHAT YOU WANT TO SEE. This was seven booleans that all began `true`,
 * where a click REMOVED a kind — so "show me just the errors" cost six clicks
 * to exclude everything else and six more to undo. The work scaled with what
 * you did NOT want. See panels/facet.js for the model that replaced it: nothing
 * selected shows everything, one click shows one kind, several show their
 * union.
 */
const kindFacet = createFacet(EVENT_KINDS);

export function toggleKind(k) {
  toggleFacet(kindFacet, k);
}

export function clearKinds() {
  clearFacet(kindFacet);
}

/**
 * THIS CARD IS NOW THE EVENT FEED, FULL WIDTH.
 *
 * It used to be a 340px spine column beside the feed. Both of the things that
 * column held — the phase spine and the provisional counters — moved to the
 * gate wall, where they sit side by side under the gates those phases produce
 * and at the cost those counters report. Leaving the empty column behind would
 * have been 340px of card holding a heading, which is the defect this whole
 * rearrangement set out to remove rather than relocate.
 */
export function renderLive(board) {
  const r = board.run ?? {};
  // A RUN STARTING TAKES THE CARD BACK. The live cell outranks a record: a card
  // silently showing yesterday's transcript while today's cell is burning hours
  // is the exact failure this board exists to prevent, and it is the failure an
  // operator is LEAST likely to catch, because a frozen feed and a quiet live
  // one look identical. Read from the same flag the selector gates on
  // (control/models-ledger.mjs `run_in_flight`) so the two cannot disagree about
  // whether a cell is in flight.
  // ── A RUN *STARTING* TAKES THE CARD BACK — the EDGE, not the state ───────
  //
  // This read `if (hist && run_in_flight) hist = null` on every render, which
  // made a historical selection impossible to hold WHILE a cell ran: click an
  // old baseline mid-run and the next 2s render wiped it. That is the same
  // "fleeting and inconsistent" failure the toggling [feed] button caused,
  // wearing different clothes.
  //
  // The operator asked for the row to work "whether it's old or running now", so
  // an old record stays selected during a live run and BACK TO LIVE returns. Only
  // the TRANSITION into a run reclaims the card, because that is the moment
  // something new is worth watching.
  const nowLive = board?.models_ledger?.run_in_flight === true;
  if (hist && nowLive && wasLive === false) hist = null;
  wasLive = nowLive;
  // ── NOTHING LIVE? THEN SHOW THE LAST THING THAT RAN ──────────────────────
  //
  // With no cell in flight this card had nothing to draw and said so, pointing
  // at the [feed] control on the BASELINES row. That is a correct sentence and a
  // dead end: the bench's resting state is "one concluded run and nothing
  // happening", so the default view was an empty box explaining where the data
  // it could have shown lives.
  //
  // The record opens by itself instead. Still explicitly marked CONCLUDED, still
  // switchable from any other row, still dropped the moment a run starts — the
  // selection is exactly the one [feed] would have made, made without requiring
  // the operator to ask for the only thing there is to see.
  maybeAutoSelect(board);
  // THE SAME BASE THE LEDGER'S STATS STRIP USES. This read `board.base`, which
  // no board object has — so the fetch returned immediately, `backend.rows`
  // stayed empty, and the tab showed "no backend records yet" for the whole of
  // a run that was publishing records the API served correctly the whole time.
  maybeRefreshBackend(board?.control?.base_url);

  return `
    <section class="panel live">
      <div class="phead">
        <span class="ttl">DATA FEED</span>
        <span class="sub">${hist ? histLabel() : cellLabel(r)}</span>
        <span class="spacer"></span>
        ${hist ? `<button class="btn sm" data-feed-live="1">← BACK TO LIVE</button>` : ""}
      </div>
      <div class="live-feed">
        ${tab === "backend" ? backendHead() : feedHead(board)}
        <div class="feed-copy"><button class="chip fexport" data-feed-copy="1">COPY RAW ${tab === "backend" ? "BACKEND" : "EVENTS"} (JSONL)</button><span class="note" id="feed-copy-note"></span></div>
        <div class="evbox" id="sc-events" data-preserve="1"${tab === "backend" ? ' hidden' : ""}></div>
        <div class="evbox" id="sc-backend" data-preserve="1"${tab === "backend" ? "" : ' hidden'}></div>
      </div>
    </section>`;
}

/**
 * WHICH CELL IS ON SCREEN — and only when one actually is.
 *
 * `board.run` describes the newest cell on disk whether or not it is running, so
 * a finished run left this printing `qwen3-…-0000 · OFF` under a card labelled
 * live. Paired with the live feed serving that same finished run's prompts, the
 * card presented a concluded run as the live session — and read, correctly, as a
 * historical feed that had lost its rows.
 */
function cellLabel(r) {
  if (r?.state && r.state !== "running") return nul("no cell running");
  if (!r?.arm && !r?.cell_label) return nul("no run observed");
  const seq = r.cell_label ? esc(r.cell_label) : "cell";
  const arm = r.arm ? esc(r.arm.toUpperCase()) : nul("arm unobserved");
  return `${seq} · ${arm}`;
}

/**
 * WHICH RECORD IS ON SCREEN, and that it is a record.
 *
 * "CONCLUDED" is stated on the card rather than left to the operator to infer
 * from a quiet feed. A frozen transcript and a live cell that has gone silent
 * look identical in the rows, and that is precisely the confusion this card
 * would otherwise introduce by being able to show both.
 */
function histLabel() {
  const sel = hist.sel;
  const who = sel.label ? esc(sel.label) : esc(`${sel.run_dir} · cell ${sel.sequence_index}`);
  return `${who} · <span class="feed-frozen">CONCLUDED — READ ONCE</span>`;
}

// ── THE PHASE SPINE — 1 BUILD + (max_attempts − 1) GRADEs ─────────────────
//
// RENDERED BY THE GATE WALL, alongside the provisional counters. The two halves
// answer the same question from opposite ends — the spine says which phase the
// cell is IN, the counters say what it has SPENT getting there — so they share
// one block, split down the middle, under the gates those phases produce.
// Exported for panels/wall.js; see the note on `provisional` below.

// Mirrors dashboard/contract.mjs PHASES_PER_CELL and config.py max_attempts.
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

  return `<div class="spine">${PHASES.map((p) => {
    const state =
      active === null ? "pending" : p.n < active ? "done" : p.n === active ? (stopped ? "done" : "running") : "pending";
    return phaseRow(p, state, r, board, verdicts.get(p.n), stated);
  }).join("")}</div>`;
}

function phaseRow(p, state, r, board, verdict, stated) {
  const title = p.n === 1 ? `${p.n} — ${p.name}` : `${p.n} — ${p.name} · ${p.label}`;
  const word = state === "running" ? "RUNNING" : state === "done" ? "DONE" : "PENDING";

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
        )}</span>`
      : "";

  return `
    <div class="ph ${state}"${state === "running" && !stated ? ` title="phase recovered from the launch log — the harness's own phase.start record was not readable"` : ""}>
      <div class="ph-top"><span>${esc(title)}</span>${outcome}<span class="ph-state">${word}</span></div>
      ${ticks}
    </div>`;
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

// ── EVENT FEED ──────────────────────────────────────────────────────────────

function feedHead(board) {
  const ev = eventFeed(board);
  const counts = ev?.counts ?? {};
  const chips = EVENT_KINDS.map((k) => {
    const n = counts[k] ?? 0;
    // THE ERROR HUE OUTRANKS THE FILTER STATE, unchanged: a non-zero error count
    // is the one thing an operator must not be able to overlook, so it keeps the
    // danger treatment whatever this chip's selection state is.
    return `<button class="chip fchip ${facetState(kindFacet, k)} ${k === "error" && n > 0 ? "err" : ""}" data-kind="${k}">${KIND_MARK[k]} ${k} ${n}</button>`;
  }).join("");

  // A FILTER MUST ANNOUNCE ITSELF AND BE ESCAPABLE IN ONE ACTION. Without this
  // a narrowed feed is indistinguishable from a quiet one, and the way out is to
  // remember which chips you pressed.
  const clear = facetActive(kindFacet)
    ? `<button class="chip fclear" data-clearkinds="1">CLEAR</button>`
    : "";

  return `
    <div class="feed-head">
      ${feedTabs()}
      ${chips}
      ${clear}
      <span class="spacer"></span>
      <span class="note">${esc(feedNote(ev))}</span>
      <button class="pill" id="evjump" style="display:none"></button>
    </div>`;
}

/**
 * `capped` and `windowed` are DIFFERENT facts and are never collapsed:
 * windowed means "more exist, ask for them"; capped means events were DROPPED
 * and are gone. Only the second is data loss.
 */
function feedNote(ev) {
  if (!ev) return hist ? "reading the record…" : "oldest first · cap 400 · sticky bottom";
  const bits = [];
  // A HISTORICAL READ IS NOT CAPPED AND IS NOT A RING. "cap 400" describes the
  // live path's server-side window (EVENT_RENDER_CAP), which the persisted read
  // does not apply — it answers with the cell's whole transcript. Printing the
  // live sentence over it claimed a cap of 400 above 4,312 rows, which is a
  // false statement about the data on screen and exactly the class of claim this
  // feed exists to avoid making.
  if (hist) {
    bits.push(`${ev.returned ?? (ev.events ?? []).length} events · complete record`);
    if (ev.unmapped) bits.push(`${ev.unmapped} unmapped`);
    bits.push("oldest first · read once");
    return bits.join(" · ");
  }
  // AN IDLE FEED HAS NO WINDOW TO DESCRIBE. "cap 400" over an empty box on a
  // bench that is not running anything states a limit that is doing nothing.
  if (ev.cell_in_flight === false && !(ev.events ?? []).length) return "nothing running";
  if (ev.capped) bits.push(`ring full — oldest dropped (${ev.total} seen)`);
  else if (ev.returned < ev.retained) bits.push(`showing ${ev.returned} of ${ev.retained}`);
  // A high unmapped count is CORRECT, not a defect: message.part.delta is ~99%
  // of traffic (one frame per token) and is deliberately dropped.
  if (ev.unmapped) bits.push(`${ev.unmapped} unmapped`);
  bits.push("oldest first · cap 400");
  return bits.join(" · ");
}

// The feed is painted OUT OF BAND, after the board's innerHTML swap, because it
// is append-only and stateful. See paintFeed() below.

let renderedSeq = -1;
let renderedSig = null;
let unread = 0;

// Click-to-expand state: at most ONE row is open (its seq, null when none) and
// the current unfiltered event window, kept for the seq→event lookup on click.
// Module-private. The expansion is painted by live.js itself — the feed box is
// data-preserve, so dom.js never patches its children, and a board-wide
// render() would reset the append-only watermark.
let expandedSeq = null;
let feedEvents = [];

/**
 * WHAT WOULD MAKE THE PAINTED LIST WRONG TO APPEND TO.
 *
 * `paintFeed` is append-only past a seq watermark — a rebuild every poll would
 * reset scrollTop and make "new" undetectable — so it needs one value that
 * changes whenever the rows on screen stop being a prefix of the rows it is
 * about to draw.
 *
 * THE SOURCE IS PART OF IT. Without the source key, switching from one frozen
 * record to another can silently APPEND the second onto the first: both are
 * numbered from their own session, so if the incoming record's seqs happen to
 * run above what is already painted, neither the wrapped check (a FORWARD gap)
 * nor the rebased check (seqs going BACKWARD) fires, and the card shows two runs
 * spliced into one list with nothing on screen saying so.
 */
function sigOf(ev) {
  return JSON.stringify([
    facetSignature(kindFacet),
    ev?.connected ?? null,
    ev?.reason ?? null,
    hist ? histKey(hist.sel) : "live",
  ]);
}

export function paintFeed(board) {
  const box = document.getElementById("sc-events");
  if (!box) return;
  ensureExpandBound();
  const ev = eventFeed(board);
  feedEvents = ev ? (ev.events ?? []) : [];
  const sig = sigOf(ev);

  if (!ev) {
    box.innerHTML = padNote("control plane not enabled — the event feed is opt-in and currently off.");
    renderedSeq = -1; renderedSig = sig;
    return;
  }
  // ── A DEAD STREAM IS A FACT ABOUT THE UPSTREAM, NOT ABOUT THE ROWS ──────
  //
  // This used to RETURN here, replacing whatever the feed held with a notice.
  // On an idle bench that is exactly wrong: the agent stream is unreachable
  // because no cell is running, but the prompts are rebuilt from files and
  // admitted anyway — so the `user` chip counted 10 rows and the box beneath it
  // said "disconnected" and drew none of them. A chip that counts rows the box
  // refuses to render is the surface contradicting itself.
  //
  // The disconnection is still stated, as a BANNER ABOVE the rows. It is
  // rendered by the same fall-through below, so there is one path that draws
  // rows and one place that decides whether a warning rides above them.
  // ── AN IDLE BENCH IS NOT A FAULT ────────────────────────────────────────
  //
  // `connected:false` is equally true when a run has crashed and when nothing is
  // running at all, and those want opposite words on screen: one is a failure to
  // chase, the other is the normal resting state of a bench between runs. The
  // server says which (`cell_in_flight`), so the card stops reporting "event
  // feed disconnected: fetch failed" over a bench that is simply waiting.
  const idle = ev.cell_in_flight === false;
  const disconnected = !ev.connected && !idle;
  // MARKED, because `stale` below treats any `.null` in the box as "this is
  // showing a note, rebuild". The banner is a permanent fixture while the stream
  // is down, so an unmarked one would force a full innerHTML rebuild on every
  // 2s poll — resetting scrollTop and destroying the append watermark that makes
  // "new" detectable.
  const banner = disconnected
    ? `<div class="null pad danger feed-banner">${esc(`event feed disconnected — ${ev.reason ?? "no reason given"}. Counts above are frozen at the last event and may be stale.`)}</div>`
    : "";

  const rows = (ev.events ?? []).filter((e) => facetAccepts(kindFacet, e.kind));
  if (!rows.length) {
    box.innerHTML = banner + padNote(
      // NAME THE FILTER THAT EMPTIED IT. "Hidden by the active filters" left the
      // operator to work out which ones, on the surface where a narrowed feed and
      // a silent one look the same.
      ev.retained && facetActive(kindFacet)
        ? `no ${facetPicked(kindFacet).join(" or ")} events among the ${ev.retained} retained — press CLEAR to see the rest.`
        : ev.retained
          ? "every retained event is hidden by the active filters."
          : idle
            // THE STATE THE OPERATOR IS ACTUALLY IN, and what to do about it.
            // This card printed "disconnected — fetch failed" here over an idle
            // bench, which reads as a broken feed rather than an empty one — and
            // it named the last CONCLUDED cell in its own subtitle while doing
            // so, so it looked precisely like a historical read returning
            // nothing. It is not: that record is reachable, by selecting it.
            ? "no cell is running, and this bench holds no concluded record to open. Start a baseline from BASELINES."
            : disconnected
              // NOT "connected, no events yet" — that sentence over a dead
              // stream claims a connection the banner above has just denied.
              ? "no events were retained before the stream dropped."
              : "connected, no events yet — nothing has happened in the session.",
    );
    renderedSeq = -1; renderedSig = sig;
    return;
  }

  // Measure BEFORE touching the DOM — scrollHeight changes on append.
  const atBottom = isAtBottom(box);
  const wrapped = rows[0].seq > renderedSeq + 1 && renderedSeq !== -1;
  // THE RING RE-BASED. seq is monotonic within one control-plane process, so the
  // window's highest seq can only fall BELOW what this feed already rendered
  // when the process restarted and re-admitted rows at low seq values. That is
  // the inverse of `wrapped` (a FORWARD gap): the rows on screen belong to a
  // dead ring and must be replaced, not appended to.
  const rebased = renderedSeq !== -1 && rows.length > 0 && (rows[rows.length - 1].seq ?? -1) < renderedSeq;
  // `.null:not(.feed-banner)` — an empty-state note means the box holds no rows
  // and must be rebuilt now that there are some. The disconnection banner is not
  // that: it sits ABOVE real rows and stays put, so counting it here would
  // rebuild on every poll for as long as the stream is down.
  const stale = sig !== renderedSig || wrapped || rebased || box.querySelector(".null:not(.feed-banner)");

  if (stale) {
    box.innerHTML = banner + rows.map((e) => evRow(e, false)).join("");
    renderedSeq = rows[rows.length - 1].seq ?? -1;
    renderedSig = sig;
    box.scrollTop = box.scrollHeight;
    return;
  }

  const fresh = rows.filter((e) => (e.seq ?? -1) > renderedSeq);
  if (!fresh.length) return;

  const prevTop = box.scrollTop;
  box.insertAdjacentHTML("beforeend", fresh.map((e) => evRow(e, true)).join(""));
  renderedSeq = fresh[fresh.length - 1].seq ?? renderedSeq;

  // Trim from the TOP to the cap, compensating scroll by the exact height
  // removed — otherwise the list jumps every time the cap is hit.
  const over = box.children.length - EVENT_RENDER_CAP;
  let trimmed = 0;
  if (over > 0) {
    for (let i = 0; i < over; i += 1) {
      const first = box.firstElementChild;
      if (!first) break;
      trimmed += first.getBoundingClientRect().height;
      first.remove();
    }
  }

  if (atBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop - trimmed;

  markUnread(fresh.length, atBottom);
}

function isAtBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_EPS;
}

function markUnread(n, atBottom) {
  unread = atBottom ? 0 : unread + n;
  const pill = document.getElementById("evjump");
  if (!pill) return;
  if (unread > 0) {
    pill.textContent = `${unread} new ↓`;
    pill.style.display = "";
  } else {
    pill.style.display = "none";
  }
}

export function jumpToLive() {
  const box = document.getElementById("sc-events");
  if (!box) return;
  unread = 0;
  box.scrollTop = box.scrollHeight;
  const pill = document.getElementById("evjump");
  if (pill) pill.style.display = "none";
}

// The expanded body of a row: the captured text, honestly labelled. Full text
// flows to the feed by default, so "verbatim" is the normal claim — still made
// ONLY when nothing was cut. The truncated branch is the rare safety-guard case
// (a pathological >64KB payload): it says so, names the surviving length, and
// points at /api/feedback where the full text lives. Pure; exported for tests.
export function evBody(e) {
  const hasText = typeof e.text === "string" && e.text.length > 0;
  const label = hasText
    ? (e.truncated
        ? `<span class="evlbl">truncated — showing first ${e.text.length} chars · full text via /api/feedback</span>`
        : `<span class="evlbl">verbatim — exactly what the model was sent</span>`)
    : `<span class="evlbl">no captured text for this event</span>`;
  const body = hasText ? `<pre class="evtext">${esc(e.text)}</pre>` : "";
  return `<div class="evbody">${label}${body}</div>`;
}

// The compact one-line row, unchanged; `open` (default: the module state) adds
// the `open` class and appends evBody() after the four spans. BOTH paintFeed
// paths (append and stale-rebuild) render through here, so a rebuild
// reproduces the expansion instead of silently collapsing it.
export function evRow(e, isNew, open) {
  const expanded = open === undefined ? e.seq === expandedSeq : open;
  const t = e.at ? new Date(e.at).toLocaleTimeString("en-GB", { hour12: false }) : "";
  return `
    <div class="evrow ${esc(e.kind)}${isNew ? " fresh" : ""}${expanded ? " open" : ""}" data-seq="${esc(String(e.seq ?? ""))}" role="button" tabindex="0" aria-expanded="${expanded}">
      <span class="evt">${esc(t)}</span>
      <span class="evmark">${KIND_MARK[e.kind] ?? "·"}</span>
      <span class="evname">${esc(e.name ?? "")}</span>
      <span class="evdetail ${e.kind === "file" ? "evpath" : ""}">${esc(e.detail ?? "")}</span>
      ${expanded ? evBody(e) : ""}
    </div>`;
}

// Click-to-expand, DELEGATED on the feed box and bound lazily ONCE — the box
// survives every rebuild, per-row listeners would not, and re-binding on each
// append would stack listeners. Only the affected rows are repainted in place
// via outerHTML; the append-only watermark, scrollTop and every other row are
// untouched, so expand/collapse never disturbs scroll. No animation: the feed
// contract forbids height/margin/transform motion (see index.html).
let expandBound = false;
function rerenderRow(seq) {
  const node = document.querySelector(`#sc-events .evrow[data-seq="${seq}"]`);
  const e = feedEvents.find((r) => r.seq === seq);
  if (node && e) node.outerHTML = evRow(e, false);
}
function ensureExpandBound() {
  if (expandBound) return;
  const box = document.getElementById("sc-events");
  if (!box) return;
  expandBound = true;
  box.addEventListener("click", (evt) => {
    const row = evt.target && evt.target.closest ? evt.target.closest(".evrow") : null;
    if (!row) return;
    const seq = Number(row.dataset.seq);
    if (!Number.isFinite(seq)) return;
    const prev = expandedSeq;
    expandedSeq = prev === seq ? null : seq;
    if (prev !== null && prev !== seq) rerenderRow(prev);
    rerenderRow(seq);
  });
}

/**
 * THE WHOLE RECORD SET, UNFILTERED, ON THE CLIPBOARD.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The board is being read in the "is the benchmark even working" phase, where
 * the red flags have not been named yet. A surface that only ever shows what
 * somebody already decided was interesting cannot answer a question nobody has
 * formulated. So every record is reachable AS DATA — one paste into whatever
 * the operator wants to reason with.
 *
 * UNFILTERED AND UNCONDENSED, DELIBERATELY. The chips and the fold are reading
 * aids; an export that inherited them would quietly ship a subset shaped by a
 * view state the recipient cannot see. What comes out is what the run produced.
 *
 * JSONL because that is what the producers wrote (`live.jsonl`,
 * `agent-events.jsonl`) — round-tripping the board's own render back into an
 * object shape nothing else uses would make the export a third format.
 */
export function feedExportText(board) {
  const rows = tab === "backend"
    ? mergeBackendRows(backendFeed())
    : ((eventFeed(board)?.events) ?? []);
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

/** What the export is OF — stated on the confirmation so a paste is traceable. */
export function feedExportLabel(board) {
  const what = tab === "backend" ? "backend records" : "events";
  const n = tab === "backend"
    ? mergeBackendRows(backendFeed()).length
    : ((eventFeed(board)?.events) ?? []).length;
  const src = hist ? `${hist.sel.label ?? hist.sel.run_dir} · cell ${hist.sel.sequence_index}` : "live cell";
  return `${n} ${what} · ${src}`;
}

export function padNote(text, bad = false) {
  return `<div class="null pad ${bad ? "danger" : ""}">${esc(text)}</div>`;
}


// ── BACKEND FEED — the SYSTEM, beside the agent ─────────────────────────────
//
// The EVENT FEED shows what the model is doing. Between attempts the agent is
// idle BY DESIGN, so that feed correctly falls silent in exactly the window an
// operator has no other signal — a cell can spend forty minutes grading, or
// wedge, and look identical. This tab is what the machinery is doing: the
// harness, the gate runner, the control plane, the campaign layer, and any
// backend that joined the stream.
//
// ONE CARD, TWO TABS, NOT TWO CARDS. They answer the same question — "what is
// happening right now" — from two sides, and an operator switches between them
// constantly. Both boxes stay in the DOM and are toggled with `hidden`, so
// scroll position and append state survive a switch: rebuilding either on every
// tab change would reset the reader to the top of a list they were reading.

let tab = "events";

export function setFeedTab(next) {
  if (next === "events" || next === "backend") tab = next;
}

/**
 * TWO FACETS, TWO AXES — and this is what resolves the collision that would
 * otherwise put two chips called "error" on one card.
 *
 * The EVENT feed filters by KIND, and one of its kinds is `error` — the AGENT
 * erring. This feed filters by SOURCE and, separately, by SEVERITY. So there is
 * no chip named `error` here at all: an operator narrowing to failures picks the
 * ERROR severity, which is a different control in a different row from the
 * agent's error kind. Two numbers with one name, disagreeing side by side on one
 * card, simply never arise.
 *
 * `values` are seeded from the closed native vocabulary and GROW to include any
 * external namespace the feed actually carries — see `backendChips`.
 */
const sourceFacet = createFacet(["harness", "gates", "worker", "sequencer", "control"]);
const levelFacet = createFacet(["info", "warn", "error"]);

export function toggleBackendSource(v) {
  toggleFacet(sourceFacet, v);
}
export function toggleBackendLevel(v) {
  toggleFacet(levelFacet, v);
}
export function clearBackendFilters() {
  clearFacet(sourceFacet);
  clearFacet(levelFacet);
}

// ── THE HISTORICAL SOURCE ───────────────────────────────────────────────────
//
// A concluded baseline's frozen record, read ONCE when it is selected. `null`
// means this card is showing the live cell, which is the default and the state
// a run start returns it to.
//
// The two feeds arrive in the SAME ENVELOPES the live path uses — the persisted
// `/api/events` branch answers the ring's own shape (control/server.mjs) and
// `/api/backend-feed` answers its own — so every renderer, filter and count
// below reads one shape and never asks which source it came from.
let hist = null;

/**
 * Open the newest concluded baseline when there is nothing live and nothing
 * chosen. Fire-and-forget: the board re-renders on its own 2s push, which is the
 * same shape `maybeRefreshBackend` and the ledger's stat strip use — render must
 * draw from what is known rather than block on a fetch.
 *
 * ONCE PER BENCH STATE, NOT ONCE PER RENDER. `autoTried` holds the key it last
 * attempted, so a failed read is not retried on every push, and an operator who
 * deliberately pressed BACK TO LIVE is not overridden a moment later by this.
 */
let autoTried = null;
let autoSuppressed = false;
// Whether a cell was in flight at the LAST render — so the rising edge of a run
// can be told from the run merely continuing. `null` until the first render, so
// a board that loads mid-run does not read as a run that just started.
let wasLive = null;

/** Test seam: forget both what was tried and any operator stand-down. */
export function resetAutoSelect() {
  autoTried = null;
  autoSuppressed = false;
  wasLive = null;
}

function maybeAutoSelect(board) {
  if (hist) return;

  const live = board?.models_ledger?.run_in_flight === true
    // A live cell owns this card even before the ledger notices —
    // `cell_in_flight` comes straight off the feed and moves first.
    || board?.events?.cell_in_flight === true;
  if (live) {
    // A RUN CLEARS THE STAND-DOWN. "I pressed BACK TO LIVE" is a statement about
    // the record on screen at the time, not a permanent preference — so once a
    // cell has actually run, the next concluded one opens by itself again.
    autoSuppressed = false;
    autoTried = null;
    return;
  }
  if (autoSuppressed) return;

  const base = board?.control?.base_url;
  if (!base) return;

  const rows = board?.models_ledger?.baseline_rows ?? [];
  const b = rows.find(
    (row) => row?.state === "complete"
      && typeof row.run_dir === "string" && row.run_dir.length > 0
      && Number.isInteger(row.sequence_index) && row.sequence_index >= 0,
  );
  if (!b) return;

  const key = `${b.run_dir}::${b.sequence_index}`;
  if (autoTried === key) return;
  autoTried = key;
  void selectHistoricalRun(base, {
    run_dir: b.run_dir,
    sequence_index: b.sequence_index,
    label: `${b.id} · ${b.model ?? "unknown model"}`,
  });
}

/** `${run_dir}::${sequence_index}` — the cell coordinates, composed once. */
function histKey(sel) {
  return `${sel?.run_dir}::${sel?.sequence_index}`;
}

/** What the card is showing: the selection, or null for the live cell. */
export function historicalSelection() {
  return hist ? { ...hist.sel } : null;
}

/**
 * Return the card to the live cell.
 *
 * The cached feeds go with it. A frozen record never changes, so re-selecting
 * re-reads it — one HTTP round trip against a paint that would otherwise have to
 * decide whether a cache entry is still the one being asked for.
 */
export function clearHistoricalRun() {
  hist = null;
  // AND THE AUTO-SELECT STANDS DOWN. Without this, pressing BACK TO LIVE would
  // re-open the same record on the very next render — a control that undoes
  // itself, which is worse than one that does nothing. The suppression is
  // lifted when a cell actually runs (see maybeAutoSelect), so the next
  // concluded run opens by itself again.
  autoSuppressed = true;
}

/**
 * SELECT a concluded cell and read its record once. Never throws: a failed read
 * is recorded as data and rendered as the honest note, because the card must
 * draw from what is known rather than block the board on a fetch.
 *
 * Returns true when it actually read — the caller re-renders on true, and a
 * re-selection of what is already shown reports false and does nothing.
 */
export async function selectHistoricalRun(base, sel) {
  if (!base || !sel || typeof sel.run_dir !== "string" || !sel.run_dir) return false;
  if (!Number.isInteger(sel.sequence_index) || sel.sequence_index < 0) return false;
  if (hist && histKey(hist.sel) === histKey(sel)) return false;

  hist = { sel: { ...sel }, loading: true, events: null, backend: null };
  const key = histKey(sel);
  const run = encodeURIComponent(sel.run_dir);
  const seq = sel.sequence_index;
  const [events, backendRes] = await Promise.all([
    histFetch(`${base}/api/events?run_dir=${run}&sequence_index=${seq}`),
    histFetch(`${base}/api/backend-feed?run_dir=${run}&sequence_index=${seq}`),
  ]);
  // The operator may have switched away or gone back to live while this was in
  // flight. Landing a stale read on top of their choice is how a card ends up
  // showing a run nobody asked for.
  if (!hist || histKey(hist.sel) !== key) return false;
  hist = { ...hist, loading: false, events, backend: backendRes };
  return true;
}

/**
 * SELECT a cell whose record CANNOT be read, and say why on the card.
 *
 * Both feed reads go client-direct to the control plane's loopback address, so
 * a board opened from another device on the LAN cannot reach either — and the
 * caller knows that before it spends a round trip finding out. The selection is
 * still made, carrying the refusal, because the operator pressed a control and
 * an unexplained no-op is the defect this whole surface exists to remove.
 */
export function selectHistoricalRunUnreachable(sel, reason) {
  hist = {
    sel: { ...sel },
    loading: false,
    events: { ok: false, reason },
    backend: { ok: false, reason },
  };
}

// Raw fetch, the house pattern for browser panels: no control-plane module
// (that one is server-side). Every failure becomes data, never a throw.
async function histFetch(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

let backend = { rows: [], errors: [], errors_total: 0, total: 0, returned: 0, sources: null, windowed: false, loaded: false };
let backendAt = 0;
let backendInFlight = false;
const BACKEND_MIN_INTERVAL_MS = 2000;

/**
 * Fire-and-forget refresh, throttled, read on the NEXT render — the same shape
 * the ledger's stats strip uses, and for the same reason: the panel must draw
 * from what is already known rather than block the board on a fetch.
 */
function maybeRefreshBackend(base) {
  if (!base || backendInFlight) return;
  const now = Date.now();
  if (backend.loaded && now - backendAt < BACKEND_MIN_INTERVAL_MS) return;
  backendInFlight = true;
  fetch(`${base}/api/backend-feed`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((body) => {
      backend = { ...body, loaded: true, unreachable: false };
    })
    .catch(() => {
      // The CONTROL PLANE failed, not any one producer. Say that, rather than
      // rendering an empty feed that reads as a silent system.
      backend = { rows: [], errors: [], errors_total: 0, total: 0, returned: 0, sources: null, windowed: false, loaded: true, unreachable: true };
    })
    .finally(() => {
      backendInFlight = false;
      backendAt = Date.now();
    });
}

/**
 * Chips for both axes.
 *
 * THE SOURCE ROW GROWS TO FIT WHAT ARRIVED. The five native sources are always
 * drawn — a stranger's board should show the same controls as yours, and a chip
 * that appears only once its process has spoken teaches nothing about what can
 * speak. Any EXTERNAL namespace present in the rows is appended: a backend's
 * telemetry is not a benchmark source and never merges into one, but it must be
 * filterable or the merged list is unreadable.
 */
function backendChips() {
  const all = backendRows();
  const seen = new Set(all.map((r) => r.source));
  for (const s of seen) if (!sourceFacet.values.includes(s)) sourceFacet.values.push(s);

  const counts = {};
  for (const r of all) counts[r.source] = (counts[r.source] ?? 0) + 1;
  const lvl = {};
  for (const r of all) lvl[r.level] = (lvl[r.level] ?? 0) + 1;

  const src = sourceFacet.values
    .map(
      (v) =>
        `<button class="chip fchip ${facetState(sourceFacet, v)}" data-bsource="${esc(v)}">${esc(v)} ${counts[v] ?? 0}</button>`,
    )
    .join("");

  // A NON-ZERO ERROR COUNT KEEPS THE DANGER HUE whatever the filter state — the
  // same rule the event feed's error kind has always had, for the same reason.
  const lev = levelFacet.values
    .map(
      (v) =>
        `<button class="chip fchip ${facetState(levelFacet, v)} ${v === "error" && (lvl[v] ?? 0) > 0 ? "err" : ""}" data-blevel="${v}">${v} ${lvl[v] ?? 0}</button>`,
    )
    .join("");

  const clear =
    facetActive(sourceFacet) || facetActive(levelFacet)
      ? `<button class="chip fclear" data-bclear="1">CLEAR</button>`
      : "";

  return `${src}<span class="fsep"></span>${lev}${clear}`;
}

function backendHead() {
  return `
    <div class="feed-head">
      ${feedTabs()}
      ${backendChips()}
      <span class="spacer"></span>
      <span class="note">${esc(backendNote())}</span>
    </div>`;
}

function feedTabs() {
  return `
    <span class="ftabs">
      <button class="chip ftab ${tab === "events" ? "picked" : "neutral"}" data-feedtab="events">EVENT FEED</button>
      <button class="chip ftab ${tab === "backend" ? "picked" : "neutral"}" data-feedtab="backend">BACKEND FEED</button>
    </span>`;
}

/**
 * WHICH STREAMS ANSWERED, stated rather than implied.
 *
 * A feed missing the control plane's half and a control plane with nothing to
 * say render identically without this — which is the failure this whole surface
 * exists to remove, reappearing inside the surface itself.
 */
function backendNote() {
  const backend = backendFeed();
  if (backend.unreachable) return "control plane unreachable — this feed is not live";
  if (!backend.loaded) return "reading…";
  const s = backend.sources ?? {};
  const missing = [];
  if (s.live && !s.live.attached) missing.push("cell stream");
  if (s.notices && !s.notices.attached) missing.push("run notices");
  // SAY WHICH HALF IS COMPLETE. "Older records exist beyond the window" is an
  // honest thing to say about activity and a frightening thing to leave hanging
  // over failures — the reader has no way to know the errors are all there.
  const errs = backend.errors_total ?? 0;
  const win = backend.windowed
    ? ` · activity windowed, older records lie beyond it — ${errs} error${errs === 1 ? "" : "s"}, complete`
    : "";
  if (missing.length) return `${missing.join(" and ")} not readable${win}`;
  // THE COUNT IS THE MERGED LIST\'S OWN LENGTH. `returned` is the server\'s
  // window figure, taken before errors[] and rows[] are unioned and deduped —
  // so it can name a number the list beneath it does not contain. The number a
  // reader checks against the rows must come from the rows.
  return `${backendRows().length} of ${backend.total} records${win}`;
}

/**
 * RECENT ACTIVITY, PLUS EVERY ERROR.
 *
 * The activity rows are a WINDOW — the last stretch of two append-only streams
 * that grow without bound. That is right for "what is happening" and wrong for
 * "what went wrong": an error from three hours ago is precisely the record
 * someone reviewing a finished run came for, and it is the first thing a tail
 * drops.
 *
 * So the server sends the complete error set separately and they are unioned
 * here. DEDUPED, because an error inside the window arrives on both lists and
 * showing it twice would make one failure look like two.
 */
function backendRows() {
  return mergeBackendRows(backendFeed());
}

/**
 * THE BACKEND ENVELOPE THIS CARD IS SHOWING — the polled live one, or the
 * frozen one read at selection. Resolved in ONE place so no renderer below
 * reads the module variable directly and quietly stays live while the rest of
 * the card went historical.
 */
function backendFeed() {
  if (!hist) return backend;
  if (hist.loading) return { rows: [], errors: [], errors_total: 0, total: 0, returned: 0, sources: null, windowed: false, loaded: false };
  if (hist.backend?.ok !== true) {
    return { rows: [], errors: [], errors_total: 0, total: 0, returned: 0, sources: null, windowed: false, loaded: true, unreachable: true, hist_reason: hist.backend?.reason ?? null };
  }
  return { ...hist.backend.data, loaded: true, unreachable: false };
}

/**
 * THE EVENT ENVELOPE THIS CARD IS SHOWING. Same rule as backendFeed().
 *
 * `connected` is REWRITTEN to true for a loaded historical read, and that is
 * not a lie about a socket — it is what the flag means to every reader below.
 * `paintFeed` treats `connected:false` as "the counts on screen are frozen and
 * may be stale", which is the correct thing to say about a live feed whose
 * stream dropped and the wrong thing to say about a record that is frozen BY
 * DEFINITION and complete. The persisted branch reports `connected:false,
 * reason:"persisted"` because it is honest about the ring; the card translates
 * that into its own vocabulary rather than rendering a concluded run under a
 * disconnection warning.
 */
function eventFeed(board) {
  if (!hist) return board?.events ?? null;
  if (hist.loading) return null;
  if (hist.events?.ok !== true) return { connected: false, reason: hist.events?.reason ?? "the frozen record could not be read", events: [], counts: {}, retained: 0, returned: 0, total: 0 };
  return { ...hist.events.data, connected: true, reason: null };
}

/**
 * UNION errors[] + rows[], dedupe, oldest first. EXPORTED and the only
 * definition: the live card and the BASELINES card's concluded-run drawer read
 * the same feed, and two merges of one record set would be two claims.
 *
 * ── THE KEY IDENTIFIES A RECORD, NOT A TIME BUCKET ──────────────────────────
 *
 * It was `${ts}|${kind}|${source}|${event}` — which is not an identity. A gate
 * suite reports every result in the same second, from the same source, under
 * the same `gate.result` event name, differing ONLY in `detail.id`. Measured on
 * a real run: 600 backend records collapsed to 53, and the header above them
 * went on saying "600 records" — 547 rows dropped, silently, with the count
 * still claiming they were there.
 *
 * `detail` is therefore part of the key. It is the only field that distinguishes
 * one gate result from the next, so a merge that ignores it is not deduplicating
 * duplicates — it is discarding evidence.
 */
export function mergeBackendRows(feed) {
  const seen = new Set();
  const out = [];
  for (const r of [...(feed?.errors ?? []), ...(feed?.rows ?? [])]) {
    const key = `${r.ts}|${r.kind}|${r.source}|${r.event ?? ""}|${JSON.stringify(r.detail ?? null)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  // NUMERIC, and stable within a tie. `ts` is a number by contract
  // (control/backend-feed.mjs toRow), and a whole gate suite shares one
  // millisecond — so equal stamps must keep the order the producer wrote them
  // in rather than being reshuffled by an unstable comparison.
  return out.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
}

export function paintBackend() {
  const box = document.getElementById("sc-backend");
  if (!box) return;
  ensureBackendExpandBound();

  const rows = backendRows().filter(
    (r) => facetAccepts(sourceFacet, r.source) && facetAccepts(levelFacet, r.level),
  );

  if (!rows.length) {
    const feed = backendFeed();
    const dead = feed.unreachable === true;
    box.innerHTML = padNote(
      dead
        ? (feed.hist_reason
            ? `the frozen record could not be read — ${feed.hist_reason}`
            : "control plane unreachable — nothing can be read.")
        : !feed.loaded
          ? "reading…"
          : feed.total > 0
            ? "no records match the picked filters — press CLEAR to see the rest."
            : hist
              ? "this cell wrote no backend records."
              : "no backend records yet. Processes write these as they work; an idle bench has none.",
      dead,
    );
    return;
  }

  // REBUILT, NOT APPENDED — deliberately unlike the event feed. That feed is a
  // token-rate stream where an innerHTML rebuild every poll would reset
  // scrollTop and make "new" undetectable. This one is a 2s poll over at most a
  // few hundred whole records, and its rows can be RE-FILTERED at any moment by
  // a chip, which an append-only watermark cannot express.
  //
  // CONDENSED AFTER FILTERING, NOT BEFORE. The chips select over the RAW record
  // set — an operator narrowing to `gates` or to `error` is asking about
  // records, not about groups — and the fold is applied to whatever survives.
  // Folding first would hide a gate result from its own filter.
  //
  // SCROLL IS PRESERVED ACROSS THE REBUILD. Expanding a row rebuilds this box,
  // and without this the list jumps to the top on every click — which on a
  // 600-row feed means the row you just opened is gone from view.
  const at = box.scrollTop;
  box.innerHTML = condenseBackend(rows)
    .map((g) => {
      const key = groupKeyOf(g);
      return bRow(g.row ?? g.children[0], {
        children: g.children,
        open: expandedBackend === key,
        groupKey: key,
      });
    })
    .join("");
  box.scrollTop = at;
}

/**
 * A group's stable identity across rebuilds — the fold state must survive the
 * 2s poll, and a positional index would move under the operator the moment a
 * new record landed or a chip changed.
 */
function groupKeyOf(g) {
  const r = g.row ?? g.children[0] ?? null;
  return `${r?.ts ?? "?"}|${r?.kind ?? "?"}|${r?.source ?? "?"}|${r?.event ?? ""}`;
}

let expandedBackend = null;
let backendExpandBound = false;

/**
 * CLICK-TO-EXPAND on the backend feed, the same affordance the event feed has.
 * Bound once, delegated, and identical in behaviour: one row open at a time.
 */
function ensureBackendExpandBound() {
  if (backendExpandBound) return;
  const box = document.getElementById("sc-backend");
  if (!box) return;
  backendExpandBound = true;
  box.addEventListener("click", (evt) => {
    const row = evt.target && evt.target.closest ? evt.target.closest(".bkrow") : null;
    if (!row) return;
    const key = row.dataset.bkey;
    if (!key) return;
    expandedBackend = expandedBackend === key ? null : key;
    paintBackend();
  });
}

// ── CONDENSING: A BIRD'S-EYE VIEW, WITH THE DATA ONE CLICK AWAY ─────────────
//
// A 2h19m cell produces ~630 backend records, and 585 of them are `gate.result`
// — one per gate, per attempt, all landing in the same second. Rendered flat,
// the forty-five records that actually describe what the harness DID (phase
// starts, attempt verdicts, truncation warnings, the cell's own start and end)
// are unfindable underneath them, and the 600-row window meant you saw almost
// nothing but the final grading burst.
//
// SO GATE RESULTS FOLD INTO THE ATTEMPT THEY BELONG TO. Nothing is discarded:
// the gates are children of the `attempt.end` that closed them, one click away,
// and every other row keeps its place. `gate_phase_duration` notices stay
// TOP-LEVEL by operator ruling — grading slowness is a thing to watch, not a
// detail to bury.
//
// THE SAME VIEW LIVE AND CONCLUDED. One surface, one behaviour: a gate burst
// scrolling past is not more readable while it happens than afterwards, and a
// card that reorganised itself the moment a run ended would teach the operator
// that what they watched is not what they can review.

/** Records that fold into the attempt that closed them. */
const FOLDS_INTO_ATTEMPT = new Set(["gate.result"]);

/**
 * Group merged backend rows into a birds-eye list, oldest first.
 *
 * Returns `[{ row, children }]` — `children` empty for an ordinary record, and
 * for an `attempt.end` the gate results that preceded it since the last attempt
 * closed. Gate results with no attempt after them (a cell still grading, or one
 * that died mid-attempt) are NOT dropped: they are handed back under a synthetic
 * open group so a run that never closed its last attempt still shows them.
 * Losing rows because the run ended untidily would hide exactly the run worth
 * looking at.
 *
 * PURE. Exported for tests and used by the paint.
 */
export function condenseBackend(rows) {
  const out = [];
  let pending = [];
  for (const r of rows ?? []) {
    if (FOLDS_INTO_ATTEMPT.has(r.kind)) { pending.push(r); continue; }
    if (r.kind === "attempt.end") {
      out.push({ row: r, children: pending });
      pending = [];
      continue;
    }
    out.push({ row: r, children: [] });
  }
  if (pending.length) out.push({ row: null, children: pending, open_group: true });
  return out;
}

/** A one-line summary of a folded gate set: what passed, what did not. */
function gateSummary(children) {
  let pass = 0, fail = 0, other = 0;
  for (const c of children) {
    const st = c?.detail?.status;
    if (st === "pass") pass += 1;
    else if (st === "fail") fail += 1;
    else other += 1;
  }
  const bits = [`${children.length} gates`];
  if (pass) bits.push(`${pass} pass`);
  if (fail) bits.push(`${fail} fail`);
  if (other) bits.push(`${other} other`);
  return bits.join(" · ");
}

/**
 * ONE BACKEND ROW. `children` renders a count and an expand affordance; the
 * children themselves are painted only when the row is open.
 *
 * EVERY ROW EXPANDS, not just the folded ones. The operator does not yet know
 * which fields will turn out to matter — that is the whole reason this feed is
 * being read — so the full record is one click away on every row rather than on
 * the ones somebody guessed would be interesting.
 */
export function bRow(r, opts = {}) {
  const { children = [], open = false, groupKey = null } = opts;
  const t = r?.ts ? new Date(r.ts).toLocaleTimeString("en-GB", { hour12: false }) : "";
  // The event name for a notice; the record's own kind otherwise — a
  // `gate.result` has no event name and inventing one would be prose.
  const label = r?.event ?? r?.kind ?? "";
  const detail =
    r?.detail && typeof r.detail === "object"
      ? Object.entries(r.detail)
          .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
          .join(" ")
      : "";
  const fold = children.length
    ? `<span class="bkfold">${esc(`${open ? "▾" : "▸"} ${gateSummary(children)}`)}</span>`
    : "";
  // SEVERITY TRAVELS AS DATA, NOT AS A COMPOSED CLASS NAME. A class built by
  // interpolation cannot be checked against the stylesheet — the coverage test
  // sees only the literal prefix — so a rule could go missing and the row would
  // render silently with no geometry. As an attribute it is one literal class
  // and a selector that is verifiable on both sides.
  // A WIDER SECOND COLUMN, BECAUSE THIS ONE HOLDS A WORD. The event feed's
  // `.evmark` is 22px — it carries a single glyph (`$`, `~`, `·`). A source name
  // is `harness`, `sequencer`, or a backend's whole namespace, so in that column
  // it overflowed and printed on top of the event name. `bkrow` keeps every other
  // row behaviour and only re-columns the grid.
  return `<div class="evrow bkrow${open ? " open" : ""}" data-level="${esc(r?.level ?? "info")}" data-bkey="${esc(groupKey ?? "")}" role="button" tabindex="0" aria-expanded="${open ? "true" : "false"}">
      <span class="evt">${esc(t)}</span>
      <span class="evmark">${esc(r?.source ?? "")}</span>
      <span class="evname">${esc(label)}</span>
      <span class="evdetail">${esc(detail)}${fold}</span>
      ${open ? bBody(r, children) : ""}
    </div>`;
}

/**
 * THE EXPANDED BODY — the record verbatim, then any folded children.
 *
 * The whole record as JSON, not a curated subset. The operator is looking for
 * red flags nobody has named yet, so a field this renderer decided was
 * uninteresting is exactly the one that would be missing when it mattered.
 */
export function bBody(r, children = []) {
  const rec = r ? `<pre class="evtext">${esc(JSON.stringify(r, null, 2))}</pre>` : "";
  if (!children.length) return `<div class="evbody"><span class="evlbl">the record, verbatim</span>${rec}</div>`;
  const kids = children.map((c) => {
    const st = c?.detail?.status ?? "?";
    const id = c?.detail?.id ?? "(unnamed gate)";
    const ms = c?.detail?.duration_ms;
    return `<div class="bkkid" data-status="${esc(st)}"><span class="bkst">${esc(st)}</span><span class="bkid">${esc(id)}</span><span class="bkms">${ms === undefined ? "" : esc(`${ms}ms`)}</span></div>`;
  }).join("");
  return `<div class="evbody">
      <span class="evlbl">${esc(`the record, verbatim · ${children.length} gates folded into it`)}</span>
      ${rec}
      <div class="bkkids">${kids}</div>
    </div>`;
}
