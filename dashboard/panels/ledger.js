// ─────────────────────────────────────────────────────────────────────────────
// PANEL: BASELINES — every completed OFF measurement, its ON runs nested inside
//
// ── WHAT REPLACED WHAT, AND WHY ─────────────────────────────────────────────
//
// This was a THREE-level card: baseline → memory PROFILE → runs. The middle
// level is gone (2026-09-07). A profile froze a producer-model allowlist so a
// cross-model memory transfer could be declared, and this benchmark does not
// run that experiment: it measures the INFORMATION DELTA of ONE model against
// its OWN floor, the same model in both arms, repeated until the results stop
// improving. Under that measurement the profile's subject axis was degenerate —
// a profile only ever appeared beneath its own subject's baseline — and its
// roster axis was inert, because no recall path has ever filtered by producing
// model. The card is now baseline → runs, which is the shape of the experiment.
//
// THE NESTING IS STILL THE ARGUMENT. A run has no meaning apart from the floor
// it is measured against: its entire content is a Δ, and a Δ is a subtraction
// from one specific floor. Rendering runs as top-level objects invites the one
// mistake this board exists to prevent — reading a run's result against a floor
// that is not the one it was measured against. Under this shape that comparison
// is not merely discouraged, it is unspellable: the floor is the row the run is
// physically inside.
//
// A MODEL WITH NO FLOOR HAS NO ROW. That is the point, not an omission. Starting
// a baseline is what [+ BASELINE] is for, which is where an absence belongs — a
// card of measurements should not be padded with placeholder rows for
// measurements nobody has taken.
//
// ── THE RECORD OPENS WITH THE ROW ───────────────────────────────────────────
//
// Expanding a baseline reads its FROZEN FEEDS off disk — the agent EVENT FEED
// and the BACKEND FEED exactly as the LIVE RUN card drew them while the cell was
// running. That read used to hang off the profile drawer, so with no profile
// frozen there was no way to reach it at all: the feeds were persisted, served,
// and unreachable. They belong to the measurement, so they hang off the
// measurement.
//
// ── THE RULES THIS SURFACE EXPRESSES, none of them decided here ─────────────
//   1. an ON run cannot start until its model's baseline is complete and non-void
//   2. an ON run is always the SAME MODEL as the floor it is measured against
//   3. runs are SERIAL — one cell in flight blocks EVERY launch on EVERY row
//
// EVERY GATE IS COMPUTED SERVER-SIDE (`control/models-ledger.mjs`) and arrives
// as `{allowed, reason}`. This panel renders that verdict and never re-derives
// it. A button whose enabled state disagreed with the refusal the server would
// actually apply is worse than no button: it teaches the operator that the UI
// lies, and the lesson generalises to every other control on the board.
//
// A DISABLED CONTROL ALWAYS STATES WHY, beside the row rather than in a tooltip
// nobody on a stream can hover.
//
// ── THE TWO-AXIS FOOTER STAYS ───────────────────────────────────────────────
//
// Efficiency and correctness sit in two boxes, SIDE BY SIDE, at the SAME type
// size. There is no third box combining them, no arrow, no score. A single
// "improvement" number would be the most natural thing to put here and would
// silently let a faster-and-worse cell read as a win. The design specimen for
// this card does not show it — it shows one card out of a board — and it is kept
// because it is a hard rule of the board, not a feature of the old shape.
// ─────────────────────────────────────────────────────────────────────────────

import { esc, nul, tok } from "../board.js";
// SELECTING A FLOOR POINTS THE DATA FEED CARD AT ITS FROZEN RECORD. This panel
// owns the choice; that card owns the reading — see panels/live.js. A second
// feed surface was built here first and removed: it reused the row renderers
// and none of the tools (tabs, kind chips, source/severity facets, the jump
// pill), so the place you went to read four thousand rows was the one without
// the means to read them.
import { historicalSelection } from "./live.js";
// RESET sits beside [+ BASELINE] because that header is where an operator goes
// to change what the bench holds — one control adds, the other clears.
import { renderResetButton } from "./treereset.js";
// RESTORE sits on the other side of [+ BASELINE] from RESET: the row reads
// undo · add · clear, left to right.
import { renderRestoreButton } from "./restore.js";

/**
 * WHICH BASELINE ROW IS OPEN. Module-local: it is view state, not measurement,
 * so it never belongs on the board payload where a poll would overwrite it.
 *
 * ONE AT A TIME. Opening a second row closes the first — a row holds its runs
 * AND both of its frozen feeds, and two open at once pushes the two-axis footer
 * off the bottom of the screen.
 */
let expandedBaseline = null;

/** Is the DATA FEED card pointed at this row? Marks the row, never gates it. */
function feedSelected(b) {
  const sel = historicalSelection();
  return sel != null && sel.run_dir === b.run_dir && sel.sequence_index === b.sequence_index;
}

export function toggleBaselineRow(id) {
  expandedBaseline = expandedBaseline === id ? null : id;
}

export function expandedBaselineId() {
  return expandedBaseline;
}

export function renderLedger(board) {
  maybeRefreshStats(board?.control?.base_url);
  const ledger = board.models_ledger ?? null;
  const rows = ledger?.baseline_rows ?? null;

  // A row whose baseline left the index must not stay open invisibly — the
  // state is reconciled against what is actually being drawn.
  if (expandedBaseline && rows && !rows.some((b) => b.id === expandedBaseline)) {
    expandedBaseline = null;
  }

  // ── THE STAT STRIP LEADS; THE BASELINES FOLLOW ──────────────────────────
  // The strip used to be the card's footer. It is now the card's HEAD, and the
  // baselines table sits under it — the two blocks are in the reverse of the
  // order they were drawn in. The strip is a fixed-geometry readout that never
  // grows, so it stays on screen; the baselines list grows without bound, and
  // a readout parked underneath it moves further out of reach with every
  // baseline added. `stats()` is still the same block with the same rows.
  return `
    <section class="ledger bl">
      ${stripBlock()}
      ${head(ledger, board)}
      ${ledger ? body(board, ledger, rows) : unwired()}
      ${nesting()}
    </section>`;
}

/**
 * THE HEAD — what the card is, how much of it there is, and the one control.
 *
 * ONE BUTTON, NOT ONE PER ROW. [+ baseline] used to sit on every model row,
 * which put a control on a card whose job is to be read for every model the
 * bench could theoretically measure. Starting a floor is one act from one place
 * — see panels/create.js. The count beside it ("5 complete · 1 running") is what
 * the per-row view made slow to answer.
 *
 * STARTING A RUN IS NOT HERE, and that is deliberate: an ON run is measured
 * against ONE specific floor, so it starts from that floor's own row where the
 * operator can see what it will be subtracted from.
 */
function head(ledger, board) {
  const c = ledger?.counts ?? null;
  return `
    <div class="ledger-head">
      <span class="ttl">BASELINES</span>
      <span class="sub">every completed OFF measurement · local and cloud · every ON run is measured against one of these</span>
      ${c ? `<span class="blcount">${esc(countWords(c))}</span>` : ""}
      ${serialChip(ledger)}
      ${renderRestoreButton(board)}
      <button class="btn sm primary blnew" data-create-open="1">+ BASELINE</button>
      ${renderResetButton(board)}
    </div>`;
}

/**
 * VOID IS COUNTED SEPARATELY OR NOT AT ALL — never folded into "complete".
 *
 * A void-instrument baseline ran to completion and produced numbers that measure
 * the harness. Counting it as complete would inflate the bench's apparent
 * progress with a floor nothing may be measured against; omitting it silently
 * would make a baseline the operator remembers running disappear from the tally.
 */
function countWords(c) {
  const bits = [`${c.complete} complete`];
  if (c.running) bits.push(`${c.running} running`);
  if (c.void) bits.push(`${c.void} void`);
  return bits.join(" · ");
}

/**
 * THE SERIAL RULE, STATED ONCE AT THE TOP.
 *
 * It is a property of the BENCH, not of any baseline, and a reader scanning rows
 * should not have to infer it from every row carrying the same refusal.
 */
function serialChip(ledger) {
  if (!ledger) return "";
  if (!ledger.run_in_flight) return `<span class="tag">IDLE — NO CELL IN FLIGHT</span>`;
  return `<span class="tag bad" title="${esc(ledger.serial_note ?? "")}">CELL IN FLIGHT — ALL LAUNCHES BLOCKED</span>`;
}

function unwired() {
  return `
    <div class="ledger-empty">
      <div class="bright">${esc("The baseline index is unavailable.")}</div>
      <div class="note">${esc(
        "GET /api/models-ledger did not answer. Without it the launch gates cannot be evaluated, and this panel will not draw controls whose enabled state it cannot verify.",
      )}</div>
    </div>`;
}

function body(board, ledger, rows) {
  if (!rows || !rows.length) return empty(ledger);
  return `
    ${cols()}
    ${rows.map((b) => baselineRow(board, ledger, b)).join("")}`;
}

/**
 * NO BASELINES AT ALL — the cold-install state, and the one that must not read
 * as a failure.
 *
 * It states the next action rather than the absence, because on a fresh bench
 * the absence is correct and the operator's question is "what do I do", not
 * "what went wrong".
 */
function empty(ledger) {
  const startable = (ledger.startable ?? []).filter((m) => m.can_baseline?.allowed);
  return `
    <div class="ledger-empty">
      <div class="bright">${esc("No baseline has been measured yet.")}</div>
      <div class="note">${esc(
        "A baseline is one OFF cell — the floor every Δ on this board is subtracted from. Nothing can be "
        + "run or compared until one exists.",
      )}</div>
      <div class="note">${
        startable.length
          ? esc(`${startable.length} model${startable.length === 1 ? " is" : "s are"} ready to baseline — press + BASELINE.`)
          : esc("No model can start one right now; open + BASELINE to see what each is waiting on.")
      }</div>
    </div>`;
}

/**
 * EIGHT COLUMNS, shared by the header and every baseline row so they cannot
 * drift. The last is the launch control and carries no label — a header over a
 * button names the button, which the button already does.
 */
function cols() {
  return `
    <div class="blcols">
      <span></span><span>BASELINE</span><span>KIND</span><span>MODEL · PROVIDER</span>
      <span>TURNS</span><span>GATES</span><span>RUNS</span><span></span>
    </div>`;
}

// ── ONE BASELINE ────────────────────────────────────────────────────────────

/**
 * The whole row is the expand affordance, so the click target is the size of the
 * row rather than a caret an operator has to aim at.
 *
 * A ROW WITH NO RUNS STILL EXPANDS. It opens onto its own frozen record — the
 * event and backend feeds of the OFF cell that made it — which is the whole
 * reason a floor with nothing measured against it is still worth opening.
 */
function baselineRow(board, ledger, b) {
  const open = expandedBaseline === b.id;
  const n = b.run_count ?? 0;

  return `
    <div class="blwrap${open ? " open" : ""}${b.state === "running" ? " running" : ""}">
      <div class="blrow${open ? " open" : ""}${feedSelected(b) ? " feeding" : ""}" data-baseline-expand="${esc(b.id)}" role="button" tabindex="0" aria-expanded="${open ? "true" : "false"}">
        <span class="blcaret">${open ? "▾" : "▸"}</span>
        <span class="blid" title="${esc(`${b.run_dir ?? "?"} seq ${b.sequence_index ?? "?"}`)}">${esc(b.id)} · ${esc(shortModel(b.model))}</span>
        <span class="blkind ${esc(b.kind ?? "local")}">${esc(b.kind_label ?? "LOCAL")}</span>
        <span class="blmodel" title="${esc(b.model_slug ?? b.model ?? "")}">${esc(b.model ?? "unknown model")}${b.provider ? esc(` · ${b.provider}`) : ""}</span>
        <span>${b.turns === null || b.turns === undefined ? nul("— pending") : esc(String(b.turns))}</span>
        <span>${gatesCell(b.gates)}</span>
        <span class="blstate ${esc(b.state)}">${esc(stateWord(b, n))}</span>
        <span class="blact">${feedMark(ledger, b)}${runBtn(b)}</span>
      </div>
      ${voidNote(b)}
      ${b.can_run?.allowed === false && b.can_run?.reason ? `<div class="blwhy"><span class="null">${esc(b.can_run.reason)}</span></div>` : ""}
      ${open ? drawer(board, ledger, b) : ""}
    </div>`;
}

/**
 * The right-hand readout: what this row IS, in the vocabulary of runs.
 *
 * A RUNNING BASELINE SAYS SO AND SAYS NOTHING ELSE. Its run count is not zero —
 * it is not yet a question, because a floor with no total cannot have anything
 * measured against it. Printing "NO RUNS" on it would state a fact about a
 * measurement nobody has been allowed to take yet.
 */
function stateWord(b, n) {
  // ELAPSED, NOT "AGO". This column is 128px and "RUNNING · 22m ago" clips to
  // "RUNNING · 22m ag…", which reads as a truncated word rather than a duration.
  // The design's own form is "RUNNING · 22m": the cell is running NOW, so the
  // number is how long it has been going, and "ago" is the wrong preposition for
  // it anyway — it belongs on the run rows, where the event is in the past.
  if (b.state === "running") return `RUNNING${b.campaign_started_at ? ` · ${elapsed(b.campaign_started_at)}` : ""}`;
  if (b.state === "void") return "VOID — NOT A FLOOR";
  if (!n) return "NO RUNS";
  return `${n} RUN${n === 1 ? "" : "S"}`;
}

/**
 * THE VOID EXPLANATION, printed on the row rather than behind the expansion.
 *
 * Void is the state that matters most and looks like success from every angle
 * except the one that counts: the cell ran, it produced turns and gates, and
 * every one of those numbers measures the harness. An operator who does not
 * read this row's reason will read its numbers.
 */
function voidNote(b) {
  if (b.state !== "void" || !b.reason) return "";
  return `<div class="blwhy"><span class="null">${esc(b.reason)}</span></div>`;
}

/** GATES: a real ratio when the suite total was recorded, and never a fake one. */
function gatesCell(g) {
  if (!g) return nul("not graded");
  if (!g.total) return nul("no suite total");
  const passed = g.passed ?? (g.total - (g.failed ?? 0));
  return `<span class="${g.failed ? "danger" : ""}">${esc(`${passed}/${g.total}`)}</span>`;
}

/**
 * A model id, shortened for the identity column only.
 *
 * The FULL id is one column to the right and the full slug is on the title, so
 * nothing is lost — this is the design's `base-8d1e · qwen3c-30b`, where the
 * second half is a hint for scanning rather than the authoritative name.
 *
 * THIRTEEN CHARACTERS, measured rather than guessed: the column is 210px, the
 * face is 12.5px mono (~7.5px/char ≈ 27 characters), and `base-XXXX · ` spends
 * twelve of them. Truncating HERE rather than leaving it to the CSS ellipsis is
 * what keeps the cut at a whole character on every row instead of mid-glyph at
 * a width that shifts with the id.
 */
function shortModel(id) {
  const s = String(id ?? "");
  const bare = s.includes("/") ? s.split("/").pop() : s;
  return bare.length <= 13 ? bare : `${bare.slice(0, 12)}…`;
}

// ── INSIDE A BASELINE: THE RUNS, THEN THE FROZEN RECORD ─────────────────────
//
// TWO BLOCKS, IN THIS ORDER, and the order is the argument. The runs are what
// the operator came for — the Δ curve against this floor. The frozen record
// beneath them is what the floor itself did, kept because a Δ is only readable
// if the thing it was subtracted from can be inspected.

function drawer(board, ledger, b) {
  return `
    <div class="blacc">
      ${runs(b)}
    </div>`;
}

/**
 * THE ROW'S OWN FEED MARK — a readout, NEVER a control.
 *
 * ── WHY THIS IS NOT A BUTTON ANY MORE ───────────────────────────────────────
 *
 * It was `[feed]`, and when the card was already showing that row it became
 * `SHOWING` wired to "return to live". So the control TOGGLED: with the record
 * auto-opened on load, pressing the thing labelled for this row CLOSED it. The
 * operator saw the feed appear, pressed the button that named it, and watched it
 * vanish — "its existence is fleeting and inconsistent", which it was.
 *
 * SELECTING A BASELINE IS CLICKING THE BASELINE. The row is the control (it
 * already was, for its own drawer), so there is one affordance, it is the whole
 * row, and it cannot un-select — clicking a row selects THAT row. Returning to
 * the live cell is one control in one place: BACK TO LIVE, on the card.
 */
function feedMark(ledger, b) {
  const sel = historicalSelection();
  const showing =
    sel != null && sel.run_dir === b.run_dir && sel.sequence_index === b.sequence_index;
  if (showing) return `<span class="blfeed on">FEED</span>`;

  // A RUNNING CELL IS ALSO SELECTABLE — the operator asked for the row to work
  // "whether it's old or running now". Its feed is the LIVE one, so the card is
  // returned to live rather than reading a record that does not exist yet.
  if (ledger?.run_in_flight && b.state === "running") return `<span class="blfeed live">LIVE</span>`;

  const addressable =
    typeof b.run_dir === "string" && b.run_dir.length > 0
    && Number.isInteger(b.sequence_index) && b.sequence_index >= 0;
  if (!addressable) {
    return `<span class="blfeed none" title="${esc("this row carries no cell address, so no record can be resolved for it")}">—</span>`;
  }
  return `<span class="blfeed">feed</span>`;
}

/**
 * [+ run] — and it carries THE MODEL AND THE SUBSTRATE off the row it sits on.
 *
 * The substrate travels because it decides whether the cell is billed and how
 * the server resolves the identity, and there is no second surface to correct it
 * from. The model is the baseline's own: an ON run is always the same model as
 * the floor it is measured against, so reading it off any other row would be
 * the one mistake this card is shaped to prevent.
 *
 * A gated control renders as a live button ONLY when it is allowed. When it is
 * not, it renders disabled carrying `title`, and the reason is ALSO printed in
 * full below the row — a disabled control with no visible explanation is the
 * single most common way a UI wastes an operator\'s time.
 */
function runBtn(b) {
  const gate = b.can_run;
  if (gate?.allowed !== true) {
    return `<button class="btn sm" disabled title="${esc(gate?.reason ?? "not available")}">+ run</button>`;
  }
  return `<button class="btn sm primary"
    data-run-baseline="${esc(b.id)}"
    data-run-model="${esc(b.model ?? "")}"
    data-run-kind="${esc(b.kind ?? "local")}">+ run</button>`;
}

/**
 * THE ON RUNS MEASURED AGAINST THIS FLOOR, newest first.
 *
 * Every column here is the CELL\'s. The runs are read off the campaign this
 * floor belongs to (control/models-ledger.mjs `onRunsFor`), so a run cannot be
 * present without a cell behind it — the "launched but unattributable" state
 * the profile store produced does not exist any more, because nothing has to be
 * recorded at launch for a cell to be found afterwards.
 */
function runs(b) {
  const list = b.runs ?? [];
  const best = b.best ?? null;

  if (!list.length) {
    return `
      <div class="rsec">
        <span class="kick">RUNS AGAINST THIS FLOOR — 0</span>
        <div class="rempty">${esc(
          b.state === "complete"
            ? "no ON cell has been measured against this baseline yet. + run starts one — the same model, "
              + "with the knowledge captured from this floor injected."
            : "nothing can be measured against this baseline until it closes as a valid floor.",
        )}</div>
      </div>`;
  }

  return `
    <div class="rsec">
      <div class="rsecline">
        <span class="kick">RUNS AGAINST THIS FLOOR — ${list.length}</span>
        ${best ? `<span class="pbest ${best.better ? "bright" : "danger"}" title="${esc(best.note ?? "")}">${esc(`BEST ${sign(best.turns)}${Math.abs(best.turns)} TURNS`)}</span>` : ""}
        <span class="spacer"></span>
        <span class="note">${esc("newest first · every ON cell in this floor\'s own campaign")}</span>
      </div>
      <div class="rcols">
        <span></span><span>RUN</span><span>WHEN</span><span>DETAIL</span><span>TURNS</span><span>Δ VS BASELINE</span>
      </div>
      ${list.map((r) => runRow(r, b)).join("")}
    </div>`;
}
function runRow(r, b) {
  const c = r.cell ?? null;
  return `
    <div class="rrow">
      <span></span>
      <span class="rseq">${esc(`run ${String(r.seq).padStart(2, "0")}`)}</span>
      <span>${r.started_at ? esc(since(r.started_at)) : nul("time unobserved")}</span>
      <span class="rdetail">${detail(c)}</span>
      <span>${c && c.turns !== null ? esc(String(c.turns)) : nul("—")}</span>
      <span class="delta">${deltaCell(r, b)}</span>
    </div>`;
}

/** The design's "3 of 3 · 90/114 gates". */
function detail(c) {
  if (!c) return nul("no measurement");
  const bits = [];
  const ph = c.phases ?? {};
  bits.push(c.state === "complete" ? `${ph.done ?? 0} of ${ph.total ?? 5}` : `phase ${ph.done ?? 0} of ${ph.total ?? 5} · running`);
  if (c.gates?.total) bits.push(`${c.gates.passed ?? c.gates.total - (c.gates.failed ?? 0)}/${c.gates.total} gates`);
  if (c.void_instrument) bits.push("VOID INSTRUMENT");
  if (c.verdict) bits.push(c.verdict);
  return `${esc(bits.join(" · "))}${buildStrip(c)}`;
}

// ── WO-CHUNKVIS-1: THE BUILD STRIP ──────────────────────────────────────────
//
// Which of the six build chunks actually landed. This is DISPLAY ONLY — the
// harness gates nothing on it, and neither does this panel.
//
// NULL IS NOT ZERO. `build_chunks` is null for every cell measured before this
// shipped, and for any cell that ran no chunked build. Rendering that as six
// incomplete chunks would mark the entire historical campaign as broken, so
// absent data draws NOTHING rather than an alarm.
const CHUNK_GLYPH = { complete: "✓", died: "✗", not_reached: "–" };

export function buildStrip(c) {
  const chunks = Array.isArray(c.build_chunks) ? c.build_chunks : null;
  if (!chunks || !chunks.length) return "";

  const cells = chunks.map((k) => {
    const state = String(k.state ?? "not_reached");
    const glyph = CHUNK_GLYPH[state] ?? "–";
    // The reason rides on the chunk that DIED, not on the ones that never got
    // a turn because of it: "4 ✗ run_timeout · 5 – · 6 –" names the culprit,
    // where "incomplete: 4, 5, 6" makes an operator hunt three chunks for one
    // fault.
    const why = state === "died" && k.reason ? ` ${esc(String(k.reason))}` : "";
    return `<span class="bc ${esc(state)}">${esc(String(k.chunk ?? "?"))}&nbsp;${esc(glyph)}${why}</span>`;
  }).join("");

  // THE OUTCOME AND THE FILE, SIDE BY SIDE. A chunk whose drive ran clean to
  // the end while the file it owns still holds its scaffold stubs did not do
  // the work. Not an error, not a gate: a discrepancy the operator can see
  // instead of one buried in a transcript.
  const lying = chunks.filter(
    (k) => k.state === "complete" && Number(k.stubs_remaining) > 0,
  );
  const warn = lying.length
    ? `<div class="bc-warn">${esc(
        `chunk ran clean but is not built: ${lying
          .map((k) => `chunk ${k.chunk} (${k.stub_file} — ${k.stubs_remaining} stubs left)`)
          .join(", ")}`,
      )}</div>`
    : "";

  return `<div class="bc-strip"><span class="bc-kick">BUILD</span>${cells}</div>${warn}`;
}

/**
 * Δ AGAINST THE BASELINE THIS ROW IS PHYSICALLY INSIDE.
 *
 * Computed on the server against that same floor and rendered here — the panel
 * does not subtract anything. `better` arrives as a word rather than being read
 * off the sign, because fewer turns is an improvement and a leading minus reads
 * as a loss to everyone who has ever seen a financial figure.
 */
function deltaCell(r, b) {
  const d = r.delta ?? null;
  if (!d) return r.cell ? nul("—") : "";
  if (!d.computable) return `<span class="null">${esc(`Δ ${d.reason}`)}</span>`;
  const parts = [`${sign(d.turns)}${Math.abs(d.turns)} turns`];
  if (d.tokens !== null && d.tokens !== undefined) parts.push(`${sign(d.tokens)}${tok(Math.abs(d.tokens))}`);
  return `<span class="${d.better ? "bright" : "danger"}">${esc(parts.join(" · "))}${d.better ? "" : " — worse than baseline"}</span>`;
}

function sign(d) {
  return d > 0 ? "+" : d < 0 ? "−" : "±";
}

/**
 * ELAPSED, IN WORDS, to a resolution that means something.
 *
 * Seconds are noise on a cell that runs for hours, and an exact timestamp is
 * what an operator has to do arithmetic on. "11m ago" is the design's own form
 * and it is the one that answers the question being asked of this column.
 */
function since(when) {
  const s = secondsSince(when);
  if (s === null) return "time unobserved";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

/** The same duration, for something still happening. No "ago". */
function elapsed(when) {
  const s = secondsSince(when);
  if (s === null) return "elapsed unobserved";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function secondsSince(when) {
  const t = typeof when === "number" ? when : Date.parse(String(when));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

// ── THE NESTING, ARGUED IN WORDS ────────────────────────────────────────────

/**
 * The design's two footer sentences, kept verbatim in substance.
 *
 * They are on the card rather than in a doc because the nesting is a CLAIM about
 * what these objects are, and a reader who does not know the claim reads the
 * indentation as a filing convention they are free to ignore.
 */
function nesting() {
  return `
    <div class="blnest">
      <span>${esc(
        "Runs sort newest first inside a baseline. A running baseline holds its row with the pending state and nothing can be measured against it until it closes.",
      )}</span>
      <span>${esc(
        "Nesting is the argument: a run has no meaning apart from the floor it is subtracted from, so it is never a top-level object.",
      )}</span>
    </div>`;
}

// ── THE STATS STRIP — the card's leading block, readouts only ───────────────
//
// IT WAS THE FOOTER. It is now the first thing on the card, above the baselines
// table, and the baselines table is second — the two swapped. Nothing about
// what it reads changed; only where it is read.
//
// WHAT THIS SPACE IS FOR. It carried prose explaining the instrument, plus null
// states written as sentences. The instrument is explained in the docs. This is
// a readout strip: a label and a number, nothing else. No units, no captions,
// no explanations of what an absent number would have meant.
//
// TWO ZONES, ONE ROW EACH, NEVER MERGED.
//
//   BENCHMARK — native. True for anyone who clones this repo.
//   CUSTOM    — pluggable. True only where the contributor's own services run.
//
// Both come from ONE route, `GET /api/stats`, in ONE entry shape, and the same
// slot renderer draws either. The board derives nothing: a number computed here
// as well as server-side is two numbers that can disagree. See
// control/runstats.mjs for the boundary and the manifest seam.
//
// FIXED SLOTS. Each row holds SLOTS positions and pads with empty ones, so the
// strip has its final geometry before the numbers that will fill it are chosen.
// A slot nobody has claimed reads PLACEHOLDER; a claimed slot whose source
// could not be reached reads "—", never zero — a relay that is down must not
// read as a run with no loop-guard fires.

/** Positions per row. Padding is layout, so it is decided here, not in the API. */
const SLOTS = 6;

let stats = { bench: [], custom: [], custom_manifest_attached: false, loaded: false };
let statsAt = 0;
let statsInFlight = false;
const STATS_MIN_INTERVAL_MS = 5000;

/**
 * Fire-and-forget refresh, throttled, read on the NEXT render.
 *
 * Render stays synchronous on purpose: the strip must draw from whatever is
 * already known rather than block the whole ledger on a service that may be
 * slow or absent. The board re-renders on its own poll, so a reading taken now
 * appears a beat later.
 */
function maybeRefreshStats(base) {
  if (!base || statsInFlight) return;
  const now = Date.now();
  if (stats.loaded && now - statsAt < STATS_MIN_INTERVAL_MS) return;
  statsInFlight = true;
  fetch(`${base}/api/stats`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((body) => {
      stats = { ...body, loaded: true };
    })
    .catch(() => {
      // The control plane, not the stat's own source, is what failed. Every
      // slot reads unreachable rather than the rows disappearing.
      stats = { bench: [], custom: [], custom_manifest_attached: false, loaded: true, unreachable: true };
    })
    .finally(() => {
      statsInFlight = false;
      statsAt = Date.now();
    });
}

/** One claimed position: its label, and its reading or "—". */
function slot(st) {
  const val =
    st.state === "ok"
      ? `<span class="snum bright">${esc(String(st.value))}</span>`
      : `<span class="snum null">—</span>`;
  return `<span class="slot"><span class="kick">${esc(st.label)}</span>${val}</span>`;
}

/** One unclaimed position. It holds the geometry until a number is chosen. */
function vacant() {
  return `<span class="slot vacant"><span class="kick">PLACEHOLDER</span><span class="snum null">—</span></span>`;
}

function strip(zone, list) {
  const filled = list.slice(0, SLOTS).map(slot);
  while (filled.length < SLOTS) filled.push(vacant());
  return `
    <div class="strip ${zone.toLowerCase()}">
      <span class="kick zone">${esc(zone)}</span>
      <div class="slots">${filled.join(`<span class="sep">|</span>`)}</div>
    </div>`;
}

/**
 * The two stat rows, as the card's leading block.
 *
 * `.ledger-lead` replaces `.ledger-foot`: the class carried the position in its
 * name and the position changed, and a rule called "foot" pinned to the top of
 * a card is how the next reader is misled. The rules themselves are the same
 * treatment inverted — the 2px rule and the --bg ground that make this read as
 * a readout rather than a peer row now sit below the block instead of above it.
 */
function stripBlock() {
  return `
    <div class="ledger-lead">
      ${strip("BENCHMARK", stats.bench ?? [])}
      ${strip("CUSTOM", stats.custom ?? [])}
    </div>`;
}
