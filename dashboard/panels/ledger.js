// PANEL: BASELINES — every completed OFF measurement, its ON runs nested inside.
//
// A run is a delta against one specific floor, so it is drawn inside that
// floor's row: reading it against a different floor is not possible. A model
// with no floor has no row ([+ BASELINE] is where that absence belongs).
// Expanding a row opens its frozen event and backend feeds.
//
// Every gate ([+ run] allowed or not) comes from control/models-ledger.mjs as
// {allowed, reason} and is rendered, never re-derived. A disabled control states
// why beside the row. Efficiency and correctness stay two side-by-side readouts,
// never combined into one score.

import { esc, nul, tok } from "../board.js";
// Selecting a floor points the DATA FEED card (panels/live.js) at its record.
import { historicalSelection } from "./live.js";
// RESET and RESTORE flank [+ BASELINE]: undo · add · clear.
import { renderResetButton } from "./treereset.js";
import { renderRestoreButton } from "./restore.js";

/** Which baseline row is open (view state, off the payload). One at a time. */
let expandedBaseline = null;

/** Is the DATA FEED card pointed at this row? Marks the row, never gates it. */
function feedSelected(b) {
  const sel = historicalSelection();
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
  return `
    ${cols()}
    ${rows.map((b) => baselineRow(board, ledger, b)).join("")}`;
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

/** Eight columns shared by header and rows; the last (the button) is unlabelled. */
function cols() {
  return `
    <div class="blcols">
      <span></span><span>BASELINE</span><span>KIND</span><span>MODEL · PROVIDER</span>
      <span>TURNS</span><span>GATES</span><span>RUNS</span><span></span>
    </div>`;
}

// ── ONE BASELINE ──

/** The whole row expands. A row with no runs still opens onto its own record. */
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
        <span class="blstate ${esc(b.state)}${b.context_exhausted ? " ctx" : ""}">${esc(stateWord(b, n))}</span>
        <span class="blact">${feedMark(ledger, b)}${runBtn(b)}</span>
      </div>
      ${voidNote(b)}
      ${exhaustedNote(b)}
      ${b.can_run?.allowed === false && b.can_run?.reason ? `<div class="blwhy"><span class="null">${esc(b.can_run.reason)}</span></div>` : ""}
      ${batchPick(b)}
      ${open ? drawer(board, ledger, b) : ""}
    </div>`;
}

/**
 * The operator's batch control. An unselected batch (reason
 * "awaiting_selection") and a fingerprint-voided one (reason "batch_void") are
 * the two rows that need a floor decision: [batch] opens the record into the
 * slot below. The slot is data-preserve — doOpenBatch (board-actions.js)
 * injects the batch into it, and patch() must not wipe it on the next refresh.
 */
function batchPick(b) {
  if (b.reason !== "awaiting_selection" && b.reason !== "batch_void") return "";
  const dir = esc(String(b.run_dir ?? ""));
  return `
    <div class="blwhy"><button class="cbatch-btn" data-batch-open="${dir}">batch</button></div>
    <div class="cbatch" data-preserve data-batch-slot="${dir}"></div>`;
}

/** The right-hand readout. A running baseline says RUNNING and nothing else. */
function stateWord(b, n) {
  // Elapsed ("RUNNING · 22m"), not "ago": the cell is running now.
  if (b.state === "running") return `RUNNING${b.campaign_started_at ? ` · ${elapsed(b.campaign_started_at)}` : ""}`;
  if (b.state === "void") return "VOID — NOT A FLOOR";
  // Context exhausted takes the state column on a floor too.
  if (b.context_exhausted) return "CONTEXT EXHAUSTED";
  if (!n) return "NO RUNS";
  return `${n} RUN${n === 1 ? "" : "S"}`;
}

/** The void reason, printed on the row: its numbers measure the harness. */
function voidNote(b) {
  if (b.state !== "void" || !b.reason) return "";
  return `<div class="blwhy"><span class="null">${esc(b.reason)}</span></div>`;
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

/** GATES: a real ratio when the suite total was recorded, and never a fake one. */
function gatesCell(g) {
  if (!g) return nul("not graded");
  if (!g.total) return nul("no suite total");
  const passed = g.passed ?? (g.total - (g.failed ?? 0));
  return `<span class="${g.failed ? "danger" : ""}">${esc(`${passed}/${g.total}`)}</span>`;
}

/**
 * A shortened model id for the identity column (13 characters fit the 210px
 * column after `base-XXXX · `). The full id is the next column and the title.
 */
function shortModel(id) {
  const s = String(id ?? "");
  const bare = s.includes("/") ? s.split("/").pop() : s;
  return bare.length <= 13 ? bare : `${bare.slice(0, 12)}…`;
}

// ── INSIDE A BASELINE: the runs (the deltas), then the floor's own frozen record.

function drawer(board, ledger, b) {
  return `
    <div class="blacc">
      ${runs(b)}
    </div>`;
}

/**
 * The row's feed mark: a readout, never a control. Clicking the row selects it;
 * BACK TO LIVE on the card is the one way back.
 */
function feedMark(ledger, b) {
  const sel = historicalSelection();
  const showing =
    sel != null && sel.run_dir === b.run_dir && sel.sequence_index === b.sequence_index;
  if (showing) return `<span class="blfeed on">FEED</span>`;

  // A running cell's feed is the live one.
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
