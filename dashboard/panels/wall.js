// ─────────────────────────────────────────────────────────────────────────────
// PANEL: GATE WALL — the correctness axis
//
// Every gate in the suite as a fixed square in a dense grid, sitting beside the
// TRANSFER CURVE at 50/50. That adjacency IS the hard rule made structural:
// correctness and efficiency are the same size, side by side, and neither is
// folded into the other.
//
// ── THIS IS A DUMB COMPONENT. IT DECIDES NOTHING. ────────────────────────────
//
// Two colours and an absence:
//
//   green   the gate passed in the last completed test run
//   red     the gate failed in the last completed test run
//   empty   no completed test run has a result for this gate
//
// `control/wall.mjs` assigns every gate exactly one of passing/failing/untested.
// This file maps that word to a class and does nothing else. There is no phase,
// no attempt axis, no live signal, no motion, and no second derivation of any
// state — two surfaces disagreeing about a square is the class of bug this
// panel was rebuilt to remove.
//
// EMPTY IS NOT A WEAKER PASS. An untested gate is drawn as a dashed outline
// with no fill, because "not measured" and "measured and passed" are different
// facts and the difference is the entire honesty of this board.
//
// SLOTS NEVER REFLOW. Roster order is the slot order, and the roster is
// write-once, so change reads as change-over-time rather than as relayout. The
// grid is the one surface a skeptic can check line-by-line against the cell's
// own gate_results.
//
// THE DENOMINATOR IS THE TRUE ENUMERATED COUNT, or it is null. The design
// comp's 114 does not exist on disk; publishing it would be the exact
// dishonesty this board exists to prevent. `suite.total: null` means UNKNOWABLE
// and renders as a stated reason, never as 0.
// ─────────────────────────────────────────────────────────────────────────────

import { esc, clip } from "../board.js";
import { provisional, spine } from "./live.js";

/**
 * Columns, chosen so the wall keeps its SHAPE as the suite grows.
 *
 * Design §9.3 said a FIXED 12 columns at every suite size, and that was right
 * while the suite was 53. Conformance is now enumerated as 65 individual gates
 * (2026-09-05) and the suite is 118 — at 12 columns that is ten rows of squares
 * instead of five, and the card doubled in height for no reason a reader
 * benefits from.
 *
 * The cells are `aspect-ratio: 1`, so with a fixed width the column count sets
 * BOTH the cell size and the row count: height is `(N/C) x (W/C)`, i.e. it
 * falls with the square of C. Solving for a roughly 2.5:1 block gives
 * `C ~ sqrt(2.5N)`, which reproduces **12 for a 53-gate suite** — the old look,
 * preserved exactly — and gives 17 for 118, holding the wall at ~234px where it
 * was ~237px before.
 *
 * Bounded at both ends: below 8 columns the wall stops reading as a block, and
 * above 28 the squares are too small to tell four states apart.
 */
export function wallColumns(total) {
  if (!Number.isFinite(total) || total <= 0) return 12;
  return Math.max(8, Math.min(28, Math.round(Math.sqrt(total * 2.5))));
}

/**
 * Server facts → visual class. Total, pure, and the ONLY place the mapping
 * exists.
 *
 * FOUR VISUALS FROM THREE PUBLISHED FACTS — `state`, `first_pass_attempt`,
 * `ever_failed` — and no others. This file still decides nothing: it does not
 * read attempts, does not fold history, and cannot disagree with the server
 * about whether a gate passes. `state` remains the sole verdict; the trajectory
 * only splits the PASSING square into "green first try" and "green eventually".
 *
 *   green      passed on the first attempt and never broke
 *   recovered  passing now, but not from the start — red rim, green core
 *   red        failing in the last completed test run — carries an ✕
 *   unobserved no result yet; dashed and empty, NOT a weaker pass
 *   instrument no result, and the RUNNER SAID WHY — the worker carrying this
 *              gate died before it reported. Amber, and marked.
 *
 * WHY `instrument` IS NOT THE AMBER THAT WAS DELIBERATELY REMOVED. Commit
 * 03a2650 stripped an in-flight amber, and control/wall.mjs still forbids a live
 * signal — correctly. What that commit killed was a PROVISIONAL state describing
 * the GRADER's situation: a square that changed while nothing about the gate
 * changed. This is the opposite. It is terminal, folded from completed attempts
 * on disk, and it describes THE GATE — that its absence of a verdict has a
 * stated cause. It cannot flicker, because it can only appear once a run has
 * finished recording that a worker died.
 *
 * IT IS STILL NOT A VERDICT. An instrument-faulted gate has not passed and has
 * not failed; it sits with `unobserved` in the untested tally and moves no
 * ratio. The colour says "the instrument broke here", never "this gate is bad" —
 * and four such squares rendering exactly like four gates nobody had reached is
 * what let a killed worker pass for an ordinary early-run wall.
 *
 * WHY THE SPLIT EARNS ITS COMPLEXITY. A suite where every gate went green on
 * attempt 1 and one where half needed two rounds of repair produce the SAME
 * wall under a two-colour scheme, and they are not the same result — the number
 * of attempts to green is a headline measurement of this bench, and it was
 * visible only as a per-attempt scalar, never per gate.
 *
 * A MISSING TRAJECTORY DEGRADES TO PLAIN GREEN, never to `recovered`. Runs
 * recorded before these fields existed publish neither, and an absent fact must
 * not be rendered as an adverse one.
 */
export function gateVisual(g) {
  switch (g.state) {
    case "passing":
      return g.ever_failed === true || (g.first_pass_attempt ?? 1) > 1 ? "recovered" : "green";
    case "failing":
      return "red";
    default:
      // A CAUSE IS ONLY EVER STATED, never inferred. The server marks this from
      // the runner's own `not_run_cause`; a gate that is merely unreached
      // carries null and stays `unobserved`. Deriving it here — from a missing
      // duration, say — would invent the distinction rather than report it.
      return g.unmeasured_cause ? "instrument" : "unobserved";
  }
}

export function renderWall(board) {
  const suite = board.suite ?? null;
  const gates = overlayLive(suite?.gates ?? [], board.live ?? null);

  return `
    <section class="panel wall">
      <div class="phead">
        <span class="ttl">GATE WALL</span>
        ${headline(suite, gates)}
        ${attemptTag(suite, board.live ?? null)}
        ${runTag(suite)}
      </div>
      ${gates.length ? grid(gates) : empty(suite)}
      ${gates.length ? legend(suite) : ""}
      ${runBlock(board)}
    </section>`;
}

/**
 * THE RUNNING CELL, SPLIT DOWN THE MIDDLE.
 *
 * Left, what it has SPENT — turns, tokens, wall time, and the token breakdown.
 * Right, where it HAS GOT TO — the phase spine, and the work order inside the
 * build phase.
 *
 * ── WHY THEY ARE HERE AND NOT ON THE LIVE CARD ─────────────────────────────
 * The two cards in the axes row are stretched to a common height, so the
 * shorter one carries dead space. Measured across the three curve tabs the gate
 * wall was carrying 13px, 533px and 137px of it. Side by side these two blocks
 * are about half the height they were stacked, which is what lets both fit
 * without the wall becoming the tall card and simply handing the gap back.
 *
 * ── AND WHY IT IS NOT MERELY SPACE-FILLING ─────────────────────────────────
 * The gates above are produced BY the phases on the right, AT the cost on the
 * left. One card now answers all three questions about the cell in flight —
 * is it correct, how far has it got, what has it cost — instead of splitting
 * them across a card boundary that meant nothing.
 *
 * The columns collapse to one on a narrow board: two half-width columns of
 * numbers are worse than one full-width column, and the token rows are a label
 * against a right-aligned figure that has nowhere to go when squeezed.
 */
function runBlock(board) {
  const r = board.run ?? {};
  return `
    <div class="wall-run">
      <div class="wr-col">${provisional(r, r.state === "running")}</div>
      <div class="wr-col">${spine(r, board)}</div>
    </div>`;
}

/**
 * Tally the three gate states over the gates actually rendered.
 *
 * Returns null for an empty array so the caller falls back to the server fold
 * rather than publishing `0/N` off a grid that drew nothing — an empty wall
 * means "no outcomes", never "everything failed".
 */
function tallyStates(gates) {
  if (!Array.isArray(gates) || !gates.length) return null;
  let passing = 0;
  let failing = 0;
  let untested = 0;
  for (const g of gates) {
    if (g.state === "passing") passing += 1;
    else if (g.state === "failing") failing += 1;
    else untested += 1;
  }
  return { passing, failing, untested };
}

/**
 * THE HEADLINE — a ratio only when both halves are real.
 *
 * `passing / total` is stated ONLY when the suite size is known. With no roster
 * the total is UNKNOWABLE, not zero, and printing "40/0" or silently
 * substituting the observed count would fabricate the denominator this whole
 * rebuild existed to make honest.
 */
function headline(suite, gates) {
  if (!suite) return `<span class="tag">GATE SUITE UNAVAILABLE</span>`;

  const total = suite.suite?.total ?? null;
  if (total === null) return `<span class="tag">SUITE SIZE UNKNOWN — NOT ZERO</span>`;

  // ── COUNT THE SQUARES THIS HEADLINE IS STANDING OVER ──────────────────────
  //
  // `suite.totals` is folded from manifest.status.jsonl, which is appended once
  // per COMPLETED cell. `overlayLive` already moves the GRID on each verdict
  // pass, so reading the fold here made the headline contradict the grid
  // directly beneath it: 65 green and 6 red squares under the words
  // `0/71 passing · 71 not yet tested`, measured on a live run.
  //
  // A headline that disagrees with its own grid is worse than either being
  // wrong alone — the viewer cannot tell which half to believe. So the counts
  // come from the SAME array the grid draws. This is not a second derivation:
  // control/wall.mjs computes `totals` as a straight tally by state over these
  // very gates, so with no live records the two are identical by construction,
  // and with them the headline simply stops lagging.
  const drawn = tallyStates(gates);
  const passing = drawn ? drawn.passing : (suite.totals?.passing ?? null);
  if (passing === null) return `<span class="tag">NO GATE OUTCOMES YET</span>`;

  const failing = drawn ? drawn.failing : (suite.totals?.failing ?? 0);
  const untested = drawn ? drawn.untested : (suite.totals?.untested ?? 0);

  // A SUITE WITH NO RUN BEHIND IT SAYS SO, IN THE HEADLINE.
  //
  // `suite_source:"enumerated"` means the server found no run at the directory
  // it read and enumerated the live harness suite instead — a true denominator
  // with nothing measured against it. That renders as `0/N passing`, which is
  // indistinguishable from a run that genuinely passed nothing, and it is how a
  // stale run-directory default went unnoticed for three days: the wall showed
  // `0/71 passing` while the run on disk had recorded 16 passing and 2 failing.
  //
  // The server already publishes which it is. This states it rather than
  // deriving it — the panel still decides nothing.
  const norun = suite.suite_source === "enumerated" ? `<span class="tag">NO RUN — SUITE ENUMERATED</span>` : "";

  // A RATIO READS AS A RESULT, SO SAY WHEN IT IS NOT ONE.
  //
  // `gradable:false` means a gate runner aborted and left gates unmeasured for
  // harness reasons — the pass count is a lower bound on an unknown, not a
  // score, and must not be compared against a completed run. The squares
  // already draw those gates as untested; without this the HEADLINE still reads
  // like a verdict. `16/71 passing` on a cell that actually scores 69/71 is the
  // exact reading this prevents.
  const ungradable =
    suite.gradable === false ? `<span class="tag bad">NOT A SCORE — RUNNER ABORTED</span>` : "";

  // A partial enumeration is still a true count of what was enumerated — it is
  // labelled rather than hidden, because the ratio's denominator moved.
  const partial = suite.suite?.complete === false ? `<span class="tag">PARTIAL ENUMERATION</span>` : "";

  return `
    <span class="sub"><span class="bright">${passing}</span>/${total} passing</span>
    ${failing > 0 ? `<span class="tag bad">${failing} FAILING</span>` : ""}
    ${untested > 0 ? `<span class="sub">${untested} not yet tested</span>` : ""}
    ${norun}
    ${ungradable}
    ${partial}`;
}

/**
 * THE EMPTY WALL.
 *
 * Reached when the suite surface carries no gates at all. The reason matters
 * more than the emptiness: "no roster" and "roster present, no outcomes yet"
 * are different facts, and the control plane already names each one in
 * `unwired_reasons`. Rendering them is the point — an unexplained empty grid is
 * what made this panel look broken for the whole grading window.
 */
function empty(suite) {
  if (!suite) {
    return `
      <div class="wall-empty">
        <div class="bright">The gate suite surface is unavailable.</div>
        <div class="note">${esc("GET /api/wall did not answer, so the suite size is unknown — which is not the same as a suite of zero gates. Start the control plane to restore this panel.")}</div>
      </div>`;
  }

  const reasons = suite.unwired_reasons ?? {};
  const keys = suite.unwired ?? [];
  const why = keys.length
    ? `<div class="gphases">${keys
        .map(
          (k) => `
        <div class="gphase">
          <span class="gp-name">${esc(k)}</span>
          <span class="gp-detail">${esc(reasons[k] ?? "unwired")}</span>
        </div>`,
        )
        .join("")}</div>`
    : "";

  return `
    <div class="wall-empty">
      <div class="bright">No gate outcomes published yet.</div>
      <div class="note">${esc("Per-gate results are written when a test run completes, so this is the normal state early in a cell. Nothing here has been evaluated, which is not the same as everything failing.")}</div>
      ${why}
    </div>`;
}


/**
 * FILL THE WALL IN DURING THE RUN, not once at cell end.
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 * `board.suite` is folded by control/wall.mjs from gate-roster.json ×
 * manifest.status.jsonl. That status file is appended once per COMPLETED cell —
 * all four or five of a cell's attempt records land together — so the wall
 * snapped from wholly unobserved to wholly final and showed nothing across the
 * verdict-passes in between, which is precisely when an operator is watching.
 *
 * ── WHY THIS IS NOT THE THING THAT WAS DELIBERATELY REMOVED ─────────────────
 * Commit 03a2650 ("make the gate wall dumb again") stripped an attempt axis,
 * and the header of control/wall.mjs still forbids a live signal. What that
 * commit correctly killed was a SECOND, DISAGREEING DERIVATION of gate state:
 * in-flight ambers and slate squares describing the GRADER's situation rather
 * than the gate's.
 *
 * This is not that. A `gate.result` record is the gate runner's own published
 * row, emitted at the moment the verdict was recorded and passed through
 * untouched — the identical fact that reaches manifest.status.jsonl later, only
 * sooner. No new state is invented, nothing is provisional, and a square still
 * appears only once it carries a real recorded verdict. The three visual states
 * are unchanged.
 *
 * ── LATER WINS, AND ONLY FOR GATES THE STREAM ACTUALLY NAMED ────────────────
 * A gate re-graded on a later attempt supersedes its earlier verdict — that is
 * a repair becoming visible as it happens. A gate the stream never mentions
 * keeps whatever the folded suite says, so this can only ever ADD knowledge.
 */
function overlayLive(gates, live) {
  const rows = live?.gates;
  if (!Array.isArray(rows) || !rows.length || !gates.length) return gates;

  const byId = new Map();
  for (const r of rows) {
    if (!r || !r.id || (r.status !== "pass" && r.status !== "fail")) continue;
    const prev = byId.get(r.id);
    // Newest attempt wins; ties break on timestamp.
    if (!prev || (r.attempt ?? 0) > (prev.attempt ?? 0) || (r.ts ?? 0) > (prev.ts ?? 0)) byId.set(r.id, r);
  }
  if (!byId.size) return gates;

  return gates.map((g) => {
    const r = byId.get(g.id);
    if (!r) return g;
    const passing = r.status === "pass";
    return {
      ...g,
      state: passing ? "passing" : "failing",
      // BOTH TRAJECTORY FACTS ARE FOLDED BY THE SOURCE, never invented here.
      //
      // This used to read `passing ? r.attempt : null` — the attempt of the
      // NEWEST record. On attempt 2 the runner re-grades everything, so every
      // gate that had passed first try got first_pass_attempt = 2 and rendered
      // as `recovered` with a `2` in it. 65 squares claimed a repair that never
      // happened. The source now carries the earliest passing attempt and
      // whether the gate ever failed; the panel still derives nothing.
      ever_failed: g.ever_failed === true || r.ever_failed === true,
      first_pass_attempt: Number.isFinite(g.first_pass_attempt)
        ? g.first_pass_attempt
        : Number.isFinite(r.first_pass_attempt)
          ? r.first_pass_attempt
          : null,
    };
  });
}

/**
 * The dense grid. FIXED 12 columns at every suite size (design §9.3) — the
 * count is a constant, not a function of the gate count, so the wall reads as
 * the same object from cell to cell and slot N is slot N forever.
 */
function grid(gates) {
  const cells = gates
    .map((g) => {
      const st = gateVisual(g);
      const label = `${g.id} ${g.req ?? ""} ${g.title ?? ""}`.trim();
      const when =
        st === "recovered" && Number.isFinite(g.first_pass_attempt)
          ? ` (first passed on attempt ${g.first_pass_attempt})`
          : "";
      // THE ATTEMPT NUMBER IS IN THE SQUARE, not only on hover.
      //
      // The rim says "this needed repair"; the digit says HOW MUCH repair, and
      // with a ceiling of 10 that is the difference between a gate that wobbled
      // once and one that took nine rounds. Attempts-to-green is a headline
      // measurement of this bench, so on the surface that shows every gate at
      // once it should not be reachable only by hovering 71 squares one at a
      // time.
      //
      // A DIGIT ONLY ON `recovered`. A green-first-try square would read "1" on
      // every cell, which is noise: the ABSENCE of a rim already says attempt 1.
      // An unobserved square has no result to mark.
      //
      // A FAILING SQUARE CARRIES AN "X", as a character rather than a drawing.
      // It is set in the same font as the digit (see .gcell.red in index.html),
      // so the two marks match in size and weight instead of one being a
      // hand-drawn approximation that could sit off-centre.
      //
      // Neither mark DECIDES anything — `state` is still the sole verdict, and
      // the digit is `first_pass_attempt` rendered verbatim. The panel derives
      // nothing.
      const mark =
        st === "recovered" && Number.isFinite(g.first_pass_attempt)
          ? esc(String(g.first_pass_attempt))
          : st === "red"
            ? "X"
            : // AN INSTRUMENT FAULT IS MARKED, NOT JUST TINTED. Colour alone
              // fails an operator who cannot separate amber from red at a
              // glance, and this is the one square whose whole point is that it
              // is NOT a failure. "!" reads as "something went wrong HERE" —
              // deliberately unlike the "X" that means "this gate did not pass".
              st === "instrument"
              ? "!"
              : "";
      return `<span class="gcell ${esc(st)}" title="${esc(`${label} — ${VISUAL_WORD[st]}${when}`)}">${mark}</span>`;
    })
    .join("");
  // `--wall-cols` is published so the CSS can size every band as a fraction of
  // the ACTUAL cell rather than as a `cqw` fraction that silently assumed 12
  // columns. See `.gwall` in index.html.
  const cols = wallColumns(gates.length);
  return `<div class="gwall" style="--wall-cols:${cols};grid-template-columns:repeat(${cols},1fr)">${cells}</div>`;
}

/** The tooltip gloss, kept beside the colours so the two cannot drift apart. */
const VISUAL_WORD = {
  green: "passing — green on the first attempt",
  recovered: "passing — but not on the first attempt",
  red: "failing",
  unobserved: "not yet tested",
  // NAMES THE CAUSE AND DENIES THE VERDICT, in that order. An operator reading
  // this tooltip is looking at an amber square among reds and greens and needs
  // to know immediately that it is not a result.
  instrument: "not measured — the runner's worker died before this gate reported; this is NOT a failure",
};

/**
 * THE LEGEND — every state, always, even at zero.
 *
 * This is a KEY, not a status readout: a legend that hides a state until it
 * occurs teaches the operator that it does not exist, so its first appearance is
 * unreadable exactly when it matters. That argument is strongest for
 * `instrument`, which is rare by design and is the one square an operator has
 * never seen before the day it matters.
 */
function legend(suite) {
  return `
    <div class="wall-legend">
      <span><span class="gcell green sm"></span> passed first attempt</span>
      <span><span class="gcell recovered sm"></span> passed on a later attempt</span>
      <span><span class="gcell red sm"></span> failing</span>
      <span><span class="gcell unobserved sm"></span> not yet tested</span>
      <span><span class="gcell instrument sm"></span> not measured — instrument fault</span>
      ${suite?.gradable === false ? `<span class="note">${esc(gradabilityNote(suite))}</span>` : ""}
    </div>`;
}

/**
 * THREE EXPLANATORY NOTES USED TO SIT UNDER THE LEGEND AND ARE DELETED —
 * "these are the results of the last completed test run", the denominator
 * sentence, and the `from runs/...` provenance line. Measured at 134px of card
 * between them, which is what this card had to spare and did not have.
 *
 * WHAT WAS EXPLANATION WENT; WHAT WAS A CLAIM STAYED. Two of the three restated
 * things the card already shows: the headline prints `passing / total`, so the
 * denominator sentence said the denominator again in words, and the provenance
 * path is on the board's provenance panel, which exists for exactly that.
 *
 * The third was NOT an explanation. "still in flight — this cell has not
 * closed" is a claim about whether these numbers are final, and losing it would
 * let a running cell read as a finished one — the specific misreading that note
 * was written to stop. So it survives as `attemptTag()`, in the header row,
 * where it costs no vertical space at all.
 */

/**
 * WHICH ATTEMPT THESE SQUARES CAME FROM, AND WHETHER IT HAS CLOSED.
 *
 * A closed attempt is a measurement; an open one is a reading that can still
 * move. The distinction rides the headline rather than a sentence below the
 * grid, because it qualifies the number in the headline.
 */
export function attemptTag(suite, live) {
  const attempt = suite?.attempt ?? null;
  if (attempt !== null) return `<span class="tag">ATTEMPT ${esc(String(attempt))}</span>`;
  if (Number.isFinite(live?.attempt)) {
    return `<span class="tag warn">ATTEMPT ${esc(String(live.attempt))} · IN FLIGHT</span>`;
  }
  return "";
}

/**
 * WHY THIS ATTEMPT IS NOT A MEASUREMENT.
 *
 * The control plane passes the harness's own sentence through; this renders it
 * and names the runners that aborted. Stating the reason is the whole point — an
 * unexplained "not a score" badge is the same dead end as an unexplained empty
 * grid, which is what this panel keeps having to be rescued from.
 */
function gradabilityNote(suite) {
  const reason = suite?.ungradable_reason ?? null;
  const aborted = Array.isArray(suite?.aborted_runners) ? suite.aborted_runners : [];
  if (reason) return reason;
  return aborted.length
    ? `${aborted.join(", ")} aborted, so gates below were left unmeasured by the harness`
    : "a gate runner aborted, so the pass count is a lower bound rather than a score";
}

/**
 * WHICH RUN THESE SQUARES CAME FROM — moved to the header, not deleted.
 *
 * This used to be a wrapped sentence under the legend ("from runs/<dir>, graded
 * against that run's own pinned roster"), and it went because the three notes
 * below the legend cost 134px of a card that had none to spare.
 *
 * THE SENTENCE WENT; THE FACT DID NOT. The objection was to the vertical space,
 * and a chip on the existing header row costs none — while dropping the run
 * directory outright would have reopened the defect this was written for: the
 * panel once rendered a full 71-gate denominator with every square empty,
 * against a STALE run directory, and said nothing about which run it had read.
 * It looked like a catastrophic result and was a wrong path, and it stood for
 * three days. Nothing else on the board names this suite's run — checked, not
 * assumed — so this is the only place the fact exists.
 *
 * THE TAIL IS SHOWN, NOT THE HEAD. A run directory is often a path —
 * `1788592301/local/local-llm-proxy/omlx/qwen3-6-35b-a3b-bench` — whose leading
 * segments are identical across every run on the board and whose last two are
 * the whole distinction. Clipping from the front would print the part that
 * cannot tell two runs apart. The full path is the `title`.
 */
function runTag(suite) {
  const dir = suite?.run_dir ?? null;
  if (!dir) return `<span class="tag warn">RUN UNSTATED</span>`;
  // The enumerated case is already a headline tag of its own and says something
  // stronger than provenance — that no square is a verdict. Not doubled here.
  if (suite?.suite_source === "enumerated") return "";
  const segs = String(dir).split("/").filter(Boolean);
  const shown = segs.length > 2 ? `…/${segs.slice(-2).join("/")}` : `runs/${dir}`;
  return `<span class="tag dim" title="${esc(`runs/${dir} · graded against that run's own pinned roster`)}">${esc(clip(shown, 34))}</span>`;
}

