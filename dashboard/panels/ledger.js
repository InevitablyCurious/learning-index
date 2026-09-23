// PANEL: BASELINES — one row per OFF batch, its cells and its ON runs inside.
//
// A floor is a BATCH of OFF cells (control/batch.mjs): the median problem
// count over the scored cells, their spread, and the one cell the operator
// picks — shown with its distance from the median. The row says that much;
// expanding it lists every cell of the batch (void ones included) with its own
// numbers and repair trajectory, and the ON runs measured against the floor.
// A run is a delta against one specific floor, so it is drawn inside that
// floor's row. A model with no batch has no row ([+ BASELINE] is where that
// absence belongs).
//
// Every gate ([+ run] allowed or not) comes from control/models-ledger.mjs as
// {allowed, reason} and is rendered, never re-derived. A disabled control states
// why beside the row. Efficiency and correctness stay two side-by-side readouts,
// never combined into one score.

import { esc, nul, tok, dur } from "../board.js";
// The DATA FEED card (panels/live.js) shows the cell the strip points at; a row
// whose cell is on show is marked.
import { feedSelection } from "./live.js";
// RESET and RESTORE flank [+ BASELINE]: undo · add · clear.
import { renderResetButton } from "./treereset.js";
import { renderRestoreButton } from "./restore.js";

/** Which baseline row is open (view state, off the payload). One at a time. */
let expandedBaseline = null;

/** Whether the superseded group is open (view state). Folded by default. */
let supersededOpen = false;
export function toggleSuperseded() {
  supersededOpen = !supersededOpen;
}

/**
 * A batch voided by its fingerprint: the code moved past it (superseded), its
 * cells ran on different inputs (mixed), or they recorded nothing to bind it
 * to (unfingerprinted). Kept and readable, never a floor — so it sits in its
 * own folded group below the batches that can be.
 */
const isSuperseded = (b) => b.state === "void" && typeof b.void_kind === "string";

/** Is the DATA FEED card pointed at this row? Marks the row, never gates it. */
function feedSelected(b) {
  const sel = feedSelection();
  return sel != null && sel.run_dir === b.run_dir && sel.sequence_index === b.sequence_index;
}

export function toggleBaselineRow(id) {
  expandedBaseline = expandedBaseline === id ? null : id;
}

export function renderLedger(board) {
  maybeRefreshStats();
  const ledger = board.models_ledger ?? null;
  const rows = ledger?.baseline_rows ?? null;

  // A row whose baseline left the index must not stay open invisibly.
  if (expandedBaseline && rows && !rows.some((b) => b.id === expandedBaseline)) {
    expandedBaseline = null;
  }

  // The stat strip leads (fixed height, stays on screen); the growing
  // baselines table follows.
  return `
    <section class="ledger bl">
      ${stripBlock()}
      ${head(ledger, board)}
      ${ledger ? body(board, ledger, rows) : unwired()}
      ${nesting()}
    </section>`;
}

/**
 * The head: what the card is, the counts, and the one [+ BASELINE] control.
 * Starting a run is on each floor's own row, not here.
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

/** Void is counted separately, never folded into complete. */
function countWords(c) {
  const bits = [`${c.complete} complete`];
  if (c.running) bits.push(`${c.running} running`);
  if (c.void) bits.push(`${c.void} void`);
  if (c.exhausted) bits.push(`${c.exhausted} context exhausted`);
  return bits.join(" · ");
}

/** The serial rule, stated once for the whole bench. */
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
  const live = rows.filter((b) => !isSuperseded(b));
  const folded = rows.filter(isSuperseded);
  return `
    ${cols()}
    ${live.map((b) => baselineRow(board, ledger, b)).join("")}
    ${live.length ? "" : `<div class="ledger-empty"><div class="note">${esc("No batch can be a floor right now — every batch below was measured on something other than the current code. Start a new baseline.")}</div></div>`}
    ${folded.length ? supersededGroup(board, ledger, folded) : ""}`;
}

/** The folded group of batches that can never be a floor, each saying why. */
function supersededGroup(board, ledger, rows) {
  const n = rows.length;
  return `
    <div class="blsup${supersededOpen ? " open" : ""}">
      <div class="blsup-head" data-superseded-toggle="1" role="button" tabindex="0" aria-expanded="${supersededOpen ? "true" : "false"}">
        <span class="blcaret">${supersededOpen ? "▾" : "▸"}</span>
        <span>${esc(`SUPERSEDED — ${n} batch${n === 1 ? "" : "es"}`)}</span>
        <span class="note">${esc("measured on something other than the current code · kept for reading, never a floor")}</span>
      </div>
      ${supersededOpen ? rows.map((b) => baselineRow(board, ledger, b)).join("") : ""}
    </div>`;
}

/** No baselines at all: the fresh-install state, stated as the next action. */
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

/** Eight columns shared by header and rows; the last (the buttons) is unlabelled. */
function cols() {
  return `
    <div class="blcols">
      <span></span><span>MODEL · PROVIDER</span><span>KIND</span><span>CELLS</span>
      <span>MEDIAN (SPREAD)</span><span>FLOOR</span><span>ON RUNS</span><span></span>
    </div>`;
}

// ── ONE BASELINE ──

/** The whole row expands. A row with no runs still opens onto its batch. */
function baselineRow(board, ledger, b) {
  const open = expandedBaseline === b.id;
  const n = b.run_count ?? 0;

  return `
    <div class="blwrap${open ? " open" : ""}${b.state === "running" ? " running" : ""}">
      <div class="blrow${open ? " open" : ""}${feedSelected(b) ? " feeding" : ""}" data-baseline-expand="${esc(b.id)}" role="button" tabindex="0" aria-expanded="${open ? "true" : "false"}"
           title="${esc(`${b.id} · ${b.run_dir ?? "?"}`)}">
        <span class="blcaret">${open ? "▾" : "▸"}</span>
        <span class="blmodel" title="${esc(b.model_slug ?? b.model ?? "")}"><span class="blid">${esc(b.model ?? "unknown model")}</span>${b.provider ? `<span class="note">${esc(` · ${b.provider}`)}</span>` : ""}</span>
        <span class="blkind ${esc(b.kind ?? "local")}">${esc(b.kind_label ?? "LOCAL")}</span>
        <span>${cellsWord(b.batch)}</span>
        <span>${medianWord(b.batch)}</span>
        <span class="blstate ${esc(b.state)}${b.context_exhausted ? " ctx" : ""}">${stateWord(b)}</span>
        <span>${n ? esc(String(n)) : nul("none")}</span>
        <span class="blact">${feedMark(ledger, b)}${runBtn(b)}</span>
      </div>
      ${voidNote(b)}
      ${exhaustedNote(b)}
      ${b.can_run?.allowed === false && b.can_run?.reason && b.reason !== "batch_void" ? `<div class="blwhy"><span class="null">${esc(b.can_run.reason)}</span></div>` : ""}
      ${open ? drawer(board, ledger, b) : ""}
    </div>`;
}

/** CELLS: how many, and how many scored and void — voids counted, never hidden. */
function cellsWord(batch) {
  const list = batch?.cells ?? [];
  if (!list.length) return nul("—");
  const live = list.filter((c) => c.state !== "complete" && c.scored === null).length;
  const bits = [`${list.length}`];
  if (batch.scored_count) bits.push(`${batch.scored_count} scored`);
  if (batch.void_count) bits.push(`<span class="danger">${esc(String(batch.void_count))} void</span>`);
  if (live && !batch.scored_count && !batch.void_count) bits.push(`${live} running`);
  return bits.join(" · ");
}

/** MEDIAN (SPREAD): problems at attempt 1, over the scored cells. */
function medianWord(batch) {
  if (!batch || batch.median === null) return nul("no median yet");
  const spread = batch.spread ? ` <span class="note">(${esc(`${batch.spread.min}–${batch.spread.max}`)})</span>` : "";
  return `${esc(String(batch.median))}${spread}`;
}

/** A signed percentage, "+4.3%" / "−8.7%" / "±0%". */
function pct(p) {
  if (p === null || p === undefined) return "";
  return `${p > 0 ? "+" : p < 0 ? "−" : "±"}${Math.abs(p)}%`;
}

/** FLOOR: the picked cell and its distance from the median, or why there is none. */
function stateWord(b) {
  // Elapsed ("RUNNING · 22m"), not "ago": the batch is running now.
  if (b.state === "running") return `RUNNING${b.campaign_started_at ? ` · ${esc(elapsed(b.campaign_started_at))}` : ""}`;
  if (b.state === "void") {
    if (b.void_kind === "superseded") return `SUPERSEDED — ${esc(b.void_input ?? "an input")} changed`;
    if (b.void_kind === "mixed") return `MIXED — ${esc(b.void_input ?? "inputs")} differ`;
    if (b.void_kind === "unfingerprinted") return "UNFINGERPRINTED";
    return "VOID — NOT A FLOOR";
  }
  // Out of context room takes the column on a floor too (exhaustedNote says
  // what its numbers mean).
  if (b.state === "exhausted" || b.context_exhausted) return "CONTEXT EXHAUSTED";
  if (b.state === "awaiting") return "AWAITING PICK";
  const pick = b.batch?.pick ?? null;
  if (!pick) return "FLOOR";
  const seq = `s${String(pick.sequence_index).padStart(4, "0")}`;
  return `${esc(seq)} · ${esc(String(pick.problems))} <span class="note">${esc(`${pct(pick.pct_from_median)} vs median`)}</span>`;
}

/** The void reason, printed on the row: its numbers measure the harness. */
function voidNote(b) {
  if (b.state !== "void" || !b.reason) return "";
  // A fingerprint-void batch says why in its own sentence (baselines.mjs).
  const text = b.reason === "batch_void" ? b.void_reason : b.reason;
  if (!text) return "";
  return `<div class="blwhy"><span class="null">${esc(text)}</span></div>`;
}

/**
 * Context exhausted, on the row. On a floor the last graded round is the
 * result; otherwise nothing was graded.
 */
function exhaustedNote(b) {
  if (!b.context_exhausted) return "";
  const text = b.state === "exhausted" && b.reason
    ? b.reason
    : "ran out of context and was stopped at the limit — the last graded round is its result.";
  return `<div class="blwhy"><span class="null">${esc(text)}</span></div>`;
}

// ── INSIDE A BASELINE: the batch's cells, then the ON runs against its floor.

function drawer(board, ledger, b) {
  return `
    <div class="blacc">
      ${cellsSection(b)}
      ${runs(b)}
    </div>`;
}

/** The operator's last refused pick, per run_dir, printed where it was made. */
const pickRefusals = new Map();
export function notePickRefusal(runDir, message) {
  if (message) pickRefusals.set(runDir, message);
  else pickRefusals.delete(runDir);
}

/**
 * Every cell of the batch: its attempt-1 problem count (what the median is
 * over), its distance from the median, its failures per attempt (the repair
 * trajectory), and what it cost. A pick button on each scored cell while the
 * batch awaits one; none on a void batch — a floor never rides stale numbers.
 */
function cellsSection(b) {
  const batch = b.batch;
  const list = batch?.cells ?? [];
  if (!list.length) {
    return `<div class="rsec"><span class="kick">CELLS IN THIS BATCH — 0</span><div class="rempty">${esc("no cell of this batch has been found on disk.")}</div></div>`;
  }
  const canPick = b.state === "awaiting";
  const refusal = pickRefusals.get(b.run_dir);
  return `
    <div class="rsec">
      <div class="rsecline">
        <span class="kick">CELLS IN THIS BATCH — ${list.length}</span>
        <span class="spacer"></span>
        <span class="note">${esc("problems = failed gates at attempt 1 · the median is over scored cells · void cells are listed, never counted")}</span>
      </div>
      ${refusal ? `<div class="blwhy"><span class="danger">${esc(refusal)}</span></div>` : ""}
      <div class="bccols">
        <span>CELL</span><span>PROBLEMS</span><span>VS MEDIAN</span><span>FAILURES BY ATTEMPT</span>
        <span>TURNS</span><span>WALL</span><span>TOKENS</span><span>ENDED</span><span></span>
      </div>
      ${list.map((c) => cellRow(b, c, canPick)).join("")}
    </div>`;
}

function cellRow(b, c, canPick) {
  const seq = `s${String(c.sequence_index).padStart(4, "0")}`;
  const isVoid = c.scored === false;
  const vs = c.vs_median === null ? nul("—") : esc(`${c.vs_median > 0 ? "+" : c.vs_median < 0 ? "−" : "±"}${Math.abs(c.vs_median)}`);
  const act = c.picked
    ? `<span class="tag">FLOOR</span>`
    : canPick && c.scored === true
      ? `<button class="btn sm" data-batch-pick="${esc(String(c.sequence_index))}" data-batch-dir="${esc(String(b.run_dir ?? ""))}">pick</button>`
      : "";
  return `
    <div class="bcrow${isVoid ? " bc-void" : ""}${c.picked ? " bc-picked" : ""}">
      <span class="bcseq">${esc(seq)}</span>
      <span>${c.problems === null ? nul("—") : esc(String(c.problems))}</span>
      <span>${vs}</span>
      <span>${c.attempt_failures?.length ? esc(c.attempt_failures.join(" → ")) : nul("not graded")}</span>
      <span>${c.turns === null ? nul("—") : esc(String(c.turns))}</span>
      <span>${c.wall_seconds === null ? nul("—") : esc(dur(c.wall_seconds))}</span>
      <span>${c.tokens === null ? nul("—") : esc(tok(c.tokens))}</span>
      <span class="${isVoid ? "danger" : ""}">${esc(endedWord(c))}</span>
      <span class="bcact">${act}</span>
    </div>`;
}

/** How a cell ended, in words. A void cell says why it was not counted. */
function endedWord(c) {
  // Unfinished first: a batch record assembled mid-run lists every cell still
  // going as unscored, and that is not a verdict.
  if (c.state === "started" || c.state === "not_started") return c.state === "started" ? "running" : "not started";
  if (c.scored === false) return `void · ${c.void_reason ?? "unscored"}`;
  if (c.context_exhausted) return "context exhausted";
  if (String(c.verdict ?? "").toUpperCase() === "PASS") return "green";
  if (c.terminal_reason === "attempt_ceiling_reached") return "attempt cap, not green";
  return c.terminal_reason ?? c.verdict ?? "ended";
}

/**
 * The row's feed mark: a readout, never a control. FEED when the DATA FEED card
 * is showing this row's cell (the cell strip chose it), LIVE while it runs.
 */
function feedMark(ledger, b) {
  const sel = feedSelection();
  const showing =
    sel != null && sel.run_dir === b.run_dir && sel.sequence_index === b.sequence_index;
  if (showing) return `<span class="blfeed on">FEED</span>`;
  if (ledger?.run_in_flight && b.state === "running") return `<span class="blfeed live">LIVE</span>`;
  return "";
}

/**
 * [+ run], carrying the model and substrate off its own row. Disabled with its
 * reason shown in full below the row when not allowed.
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
 * The ON runs against this floor, newest first, read off its campaign
 * (models-ledger.mjs onRunsFor).
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
  if (c.context_exhausted) bits.push("CONTEXT EXHAUSTED");
  if (c.verdict) bits.push(c.verdict);
  return `${esc(bits.join(" · "))}${buildStrip(c)}`;
}

// ── THE BUILD STRIP ── which of the build chunks landed. Display only. null
// (older cells, unchunked builds) draws nothing, never six failures.
const CHUNK_GLYPH = { complete: "✓", died: "✗", not_reached: "–" };

export function buildStrip(c) {
  const chunks = Array.isArray(c.build_chunks) ? c.build_chunks : null;
  if (!chunks || !chunks.length) return "";

  const cells = chunks.map((k) => {
    const state = String(k.state ?? "not_reached");
    const glyph = CHUNK_GLYPH[state] ?? "–";
    // The reason rides on the chunk that died, not on the ones it prevented.
    const why = state === "died" && k.reason ? ` ${esc(String(k.reason))}` : "";
    return `<span class="bc ${esc(state)}">${esc(String(k.chunk ?? "?"))}&nbsp;${esc(glyph)}${why}</span>`;
  }).join("");

  // A chunk that ran clean while its file still holds scaffold stubs: shown as a
  // discrepancy, not an error.
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
 * Δ against the floor this row is inside, computed server-side. `better`
 * arrives as a word, because fewer turns (a minus) is an improvement.
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

/** Elapsed in words ("11m ago"). */
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

/** The footer's two sentences: the nesting is a claim, stated on the card. */
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

// ── THE STATS STRIP ── readouts only (a label and a number). Two rows, never
// merged: BENCHMARK (true for anyone who clones this repo) and CUSTOM (true only
// where the contributor's services run). Both from GET /api/stats, derived nothing
// here (see control/runstats.mjs). Fixed slots: an unclaimed slot reads
// PLACEHOLDER; an unreachable source reads "—", never zero.

/** Positions per row. Padding is layout, so it is decided here, not in the API. */
const SLOTS = 6;

let stats = { bench: [], custom: [], custom_manifest_attached: false, loaded: false };
let statsAt = 0;
let statsInFlight = false;
const STATS_MIN_INTERVAL_MS = 5000;

/**
 * Fire-and-forget, throttled; read on the next render so the ledger never
 * waits on a slow service.
 */
function maybeRefreshStats() {
  if (statsInFlight) return;
  const now = Date.now();
  if (stats.loaded && now - statsAt < STATS_MIN_INTERVAL_MS) return;
  statsInFlight = true;
  fetch(`/api/stats`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((body) => {
      stats = { ...body, loaded: true };
    })
    .catch(() => {
      // The control plane failed: every slot reads unreachable.
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

/** The two stat rows, as the card's leading block (.ledger-lead). */
function stripBlock() {
  return `
    <div class="ledger-lead">
      ${strip("BENCHMARK", stats.bench ?? [])}
      ${strip("CUSTOM", stats.custom ?? [])}
    </div>`;
}
