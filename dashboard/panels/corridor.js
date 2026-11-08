// PANEL: THE CORRIDOR — one agent run drawn as a race track.
//
// The pivot the gate wall states in prose, the corridor states in geometry: a
// run is measured in WALL TIME, not attempts. Length is seconds, the ribbon is
// token density, the ticks are turns and the dotted hatch is a stall.
//
// This is the PRODUCT port of the validated gate-wall-v3/v2 mock — its visual
// and interaction design, not its scaffolding. There is no replay engine, no
// scene tabs, no synthesized scene and no /api stub here: the card consumes the
// real board through panels/corridor-data.js.
//
// ENCODING LAW (inherited from the mock, not re-invented):
//   · an ABSENT value means NOT OBSERVED — never zero. A phase with no wall time
//     is a dashed band; a numeral that was not measured is an em dash. Price and
//     cost are TRI-STATE: `N/A` (never applicable — a local model has no price by
//     construction), `—` (not observed) and a figure. The two absences are
//     different claims and never share a glyph.
//   · the track is a SYMBOL language, not a colour one. Build is blue,
//     troubleshooting is red, compaction is a green rule; failure is a diagonal
//     hatch + FAIL tag, held is a gate shape, a stall is a dotted hatch. Yellow
//     appears on nothing but the category-selection outline.
//   · every numeral is measured, or it is an em dash.
//   · the run is stated WHOLE on the default view: five token classes, wall time,
//     context peak, compactions, grades, outcome, price and cost. Nothing about a
//     run is hidden behind a legend click.
//   · the lane set is CURATED, never silently cut: the board adapter hides the
//     oldest runs behind a cap and reports how many. The corridor states the count
//     and offers the toggle that draws them.

import { corridorRunsFromBoard, observed, tokenBarFromProgress } from "./corridor-data.js";
import { esc } from "../board.js";

// The corridor's seven stations, verbatim from the mock (PHASE_STATIONS). Fixed
// labels the empty track draws before any run exists to name them.
const PHASE_STATIONS = [
  "Backend 1 — engine",
  "Backend 2 — AI",
  "Backend 3 — server",
  "Layer 1 — board and controls",
  "Layer 2 — pieces",
  "Layer 3 — gameplay",
  "Wire and verify",
];

const NOT_OBSERVED = "not observed";
// Every numeral printed is measured or an em dash. NEVER a zero: a category that
// was never observed must not claim it was empty.
const DASH = "—";
const CATEGORY_KEYS = ["build", "trouble", "compact"];
const CATEGORIES = [
  { key: "build", label: "Build — blue" },
  { key: "trouble", label: "Troubleshooting — red" },
  { key: "compact", label: "Compaction — green" },
];
const TICK_BUDGET = 120; // ticks per band before they collapse into density bands
const STALL_MIN_TURNS = 18; // a long build is only a stall if it was also slow
const STALL_RATE_FACTOR = 2; // ...and its seconds-per-turn is this far off the run's median

// The five token classes the harness measures, in the order every readout lists
// them. Cache reads and writes are tokens the run MOVED — the ribbon reads
// density, not spend, so all five count there.
const TOKEN_KEYS = [
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
];

// Every fact a v2 bucket can carry. A bucket with none of them observed is not a
// band at all — drawing it would be drawing an absence as a section.
const BUCKET_FACTS = ["turns", ...TOKEN_KEYS, "wall_seconds", "compactions", "context_peak"];

// ── module state ─────────────────────────────────────────────────────────────
// Selection persists across board.js re-renders. `selected` is the LANE index
// (null = none, which is what hides the legend in a multi-run card); `category`
// is the legend's filter. Separate axes on purpose: a lane pick is a comparison,
// a category pick is a question about one kind of section across that lane.
// `showAll` lifts the adapter's recency cap: the corridor draws the recent lane
// set by default and states how many runs it is not drawing.
let selected = null;
let category = null;
let showAll = false;

// `observed` from the data adapter is the one definition of "a real number":
// absent, null and garbage are not observed; a real 0 is.
const has = observed;

// ── formatting ───────────────────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, "0");

/** Seconds → `41:00` under an hour, `1:02:03` above it. */
function dur(sec) {
  if (!has(sec)) return NOT_OBSERVED;
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(r)}` : `${m}:${pad2(r)}`;
}

/** Token counts → `586K` / `1.2M`. */
function tok(n) {
  if (!has(n)) return NOT_OBSERVED;
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(Math.round(n));
}

/** Percent width/left from a ratio, clamped. */
function pctOf(part, whole) {
  if (!has(part) || !has(whole) || whole <= 0) return null;
  return Math.min(100, Math.max(0, (part / whole) * 100));
}

const tokCell = (n) => (has(n) ? tok(n) : DASH);
const durCell = (s) => (has(s) ? dur(s) : DASH);
const pctStyle = (v) => (has(v) ? ` style="width:${v.toFixed(2)}%"` : "");
const leftStyle = (v) => (has(v) ? ` style="left:${v.toFixed(2)}%"` : "");

/**
 * A money figure, never rounded into a lie. A real fraction below a cent keeps
 * four places instead of collapsing to `0.00` — a measured cost must not print
 * as an absence.
 */
function money(n) {
  if (!has(n)) return DASH;
  if (n === 0) return "0.00";
  return Math.abs(n) < 0.01 ? n.toFixed(4) : n.toFixed(2);
}

/**
 * Price / cost_usd, TRI-STATE: `not_applicable` is N/A (a local model has no
 * price by construction), `not_observed` is an em dash, a value prints with its
 * currency mark. A bare `0` is only ever a measured zero.
 */
function moneyCell(tri) {
  if (!tri || typeof tri !== "object") return DASH;
  if (tri.state === "not_applicable") return "N/A";
  if (tri.state === "value") return `$${money(tri.value)}`;
  return DASH;
}

// ── geometry: run → positions on one time axis ───────────────────────────────

/** True when a bucket observed at least one fact — otherwise it is not a band. */
function bandObserved(band) {
  if (!band) return false;
  return BUCKET_FACTS.some((k) => has(band[k])) || !!band.grades;
}

/** The tokens a band moved: all five classes, cache reads and writes included. */
function bandTokens(band) {
  if (!band) return null;
  const parts = TOKEN_KEYS.filter((k) => has(band[k]));
  if (!parts.length) return null;
  return parts.reduce((n, k) => n + band[k], 0);
}

/**
 * Every band of one run, in order, with its offset on the run's measured axis.
 * `phase` is the phase's POSITION in `run.phases` — the v2 contract is
 * array-ordered and carries no index. A bucket with nothing observed is not a
 * band (an absence is not a section); a band with no observed wall time still
 * gets an entry — at zero width, so the renderer can say "not observed" instead
 * of silently skipping a step.
 */
function runBands(run) {
  const out = [];
  let t = 0;
  (run?.phases ?? []).forEach((phase, i) => {
    for (const kind of ["build", "ts"]) {
      const band = kind === "build" ? phase.build : phase.troubleshooting;
      if (!bandObserved(band)) continue;
      const wall = has(band.wall_seconds) ? band.wall_seconds : null;
      out.push({ phase: i, name: phase.name, layer: phase.layer, kind, band, start: t, wall });
      if (wall) t += wall;
    }
  });
  return out;
}

/** The run's own time axis: measured seconds when observed, else the band sum. */
function runSpan(run) {
  if (has(run?.total?.measured_seconds)) return run.total.measured_seconds;
  return runBands(run).reduce((n, b) => n + (b.wall ?? 0), 0);
}

/**
 * The shared track axis: the longest lane that is actually DRAWN to scale — a
 * lane with observed phases AND a measured total. A lane rendered as the
 * full-width "not observed" band has no position on this axis and must not
 * shrink the lanes that do.
 */
function trackSpan(runs) {
  const axes = (Array.isArray(runs) ? runs : [])
    .filter((r) => Array.isArray(r?.phases) && r.phases.length > 0 && has(r?.total?.measured_seconds))
    .map((r) => r.total.measured_seconds);
  return axes.length ? Math.max(...axes) : 0;
}

/**
 * Per-phase spans (build + troubleshooting together) on the run's axis. `start`
 * advances only across observed seconds — an untimed phase never borrows width
 * from its neighbours. Phases are identified by their POSITION: the array order
 * the harness wrote is the phase order the track draws.
 */
function phaseSpans(run) {
  const spans = new Map();
  (run?.phases ?? []).forEach((phase, i) => {
    spans.set(i, {
      index: i,
      name: phase.name,
      start: null,
      wall: 0,
      turns: null,
      graded: bandObserved(phase.troubleshooting),
    });
  });
  let t = 0;
  for (const b of runBands(run)) {
    const span = spans.get(b.phase);
    if (!span) continue;
    if (span.start === null) span.start = t;
    span.wall += b.wall ?? 0;
    if (has(b.band?.turns)) span.turns = (span.turns ?? 0) + b.band.turns;
    t += b.wall ?? 0;
  }
  for (const span of spans.values()) if (span.start === null) span.start = 0;
  return [...spans.values()];
}

function median(nums) {
  const sorted = [...nums].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * THE STALL DETECTOR. Long alone is not a stall: a stall is a build band that is
 * long AND far slower per turn than the rest of its own run — the shape that
 * says "the wall held and nothing came back".
 */
function isStall(run, rec) {
  if (!rec || rec.kind !== "build") return false;
  const band = rec.band;
  if (!has(band.turns) || band.turns < STALL_MIN_TURNS) return false;
  if (!has(band.wall_seconds) || band.wall_seconds <= 0) return false;
  const rates = runBands(run)
    .filter((b) => has(b.band.turns) && b.band.turns > 0 && has(b.wall) && b.wall > 0)
    .map((b) => b.wall / b.band.turns);
  const base = median(rates);
  if (!has(base) || base <= 0) return false;
  return band.wall_seconds / band.turns >= base * STALL_RATE_FACTOR;
}

/** Turns collapse into density bands once a band would paint more than 120. */
function tickRuns(turns) {
  if (!has(turns) || turns <= 0) return [];
  const step = Math.max(1, Math.ceil(turns / TICK_BUDGET));
  const out = [];
  for (let i = 0; i < turns; i += step) {
    out.push({ count: Math.min(step, turns - i), agg: step > 1 });
  }
  return out;
}

// ── lane caption ─────────────────────────────────────────────────────────────
// Model + status word. The status is a data attribute, never a colour guess. The
// selected lane is MARKED in the caption too — `▸` survives a greyscale
// screenshot, so selection is never colour alone.
function laneLabel(run, isSelected) {
  const model = run?.model ?? NOT_OBSERVED;
  const status = run?.status ?? NOT_OBSERVED;
  return `<span class="corr-lane-label">${isSelected ? "▸ " : ""}${esc(model)} <b>${esc(status)}</b></span>`;
}

// ── bands and segments ───────────────────────────────────────────────────────
// A segment is ONE PHASE. Its width is that phase's measured seconds. Inside it
// the split is horizontal: build on the LEFT, troubleshooting on the RIGHT, each
// width proportional to its own measured seconds within the phase's span.

function bandLookup(run) {
  const map = new Map();
  for (const b of runBands(run)) map.set(`${b.phase}:${b.kind}`, b);
  return map;
}

/** Widest band in the run — the ribbon normalises token density against it. */
function peakBandTokens(run) {
  let peak = null;
  for (const b of runBands(run)) {
    const n = bandTokens(b.band);
    if (has(n) && (peak === null || n > peak)) peak = n;
  }
  return peak;
}

/** Turns as ticks; above 120 a band collapses into density groups. */
function ticksHtml(band) {
  const groups = tickRuns(band?.turns);
  if (!groups.length) return `<span class="corr-ticks"></span>`;
  const ticks = groups
    .map((g) => `<span class="corr-tick${g.agg ? " agg" : ""}" data-turns="${g.count}"></span>`)
    .join("");
  return `<span class="corr-ticks">${ticks}</span>`;
}

/** The stall readout states the numbers it actually observed — no gate tally. */
function stallHtml(band) {
  return (
    `<span class="corr-stall">` +
    `<span class="corr-stall-readout">` +
    `${esc(String(band.turns))} turns, ${esc(dur(band.wall_seconds))}` +
    `</span></span>`
  );
}

/**
 * The phase's own horizontal split, in percent of the phase. Seconds only — a
 * band that was never timed cannot claim a share of the span.
 */
function bandSplit(build, ts) {
  const bw = has(build?.wall) && build.wall > 0 ? build.wall : 0;
  const tw = has(ts?.wall) && ts.wall > 0 ? ts.wall : 0;
  const total = bw + tw;
  if (total <= 0) return { build: 100, ts: 0 };
  return { build: (bw / total) * 100, ts: (tw / total) * 100 };
}

function bandHtml(run, rec, peak, widthPct) {
  if (!rec) return "";
  const tokens = bandTokens(rec.band);
  const ribbon = pctOf(tokens, peak);
  const stall = isStall(run, rec) ? stallHtml(rec.band) : "";
  const kind = rec.kind === "build" ? "corr-build" : "corr-ts";
  const unobserved = has(rec.band.wall_seconds) ? "" : ` data-observed="false"`;
  // The section's own numbers, on the section: tokens moved · wall time.
  const num =
    `<span class="corr-bandnum" title="tokens moved · wall time">` +
    `${esc(tokCell(tokens))} · ${esc(durCell(rec.band.wall_seconds))}</span>`;
  return (
    `<span class="corr-band ${kind}"${unobserved}${pctStyle(widthPct)}>` +
    ticksHtml(rec.band) +
    `<span class="corr-ribbon"${pctStyle(ribbon)}></span>` +
    stall +
    num +
    `</span>`
  );
}

/**
 * One segment per phase: build left, troubleshooting right, split by seconds.
 * The phase NAMES ITSELF in visible text — a `title` attribute is not a label —
 * and carries its own turns numeral, so a band is readable without a hover and
 * without the category chips.
 */
function segHtml(run, span, axis, bands, peak) {
  const width = pctOf(span.wall, axis);
  const build = bands.get(`${span.index}:build`);
  const ts = bands.get(`${span.index}:ts`);
  const split = bandSplit(build, ts);
  const name = span.name ?? NOT_OBSERVED;
  const turns = has(span.turns) ? String(span.turns) : DASH;
  const label =
    `<span class="corr-seglabel">` +
    `<span class="corr-segname">${esc(name)}</span>` +
    `<span class="corr-segturns" data-turns="${esc(turns)}" title="turns in this phase">↻ ${esc(turns)}</span>` +
    `</span>`;
  const bandsHtml =
    bandHtml(run, build, peak, split.build) +
    (ts ? bandHtml(run, ts, peak, split.ts) : "");
  return (
    `<span class="corr-seg" data-phase="${span.index}"` +
    ` data-graded="${span.graded ? "true" : "false"}"${pctStyle(width)}` +
    ` title="${esc(name)}">` +
    label +
    bandsHtml +
    `</span>`
  );
}

// ── compaction rules ─────────────────────────────────────────────────────────
// A compaction is DRAWN, never counted into a block: one green rule per event,
// a hair taller than the bar it crosses. Positions are drawn ONLY when the data
// carries them — the count alone never invents a line (it is stated in the run
// totals and in the cumulative panel). `data-note` records that basis.

function compactionsHtml(run, axis) {
  const positions = run?.compaction?.positions;
  if (!Array.isArray(positions) || !positions.length) return "";
  if (!has(axis) || axis <= 0) return "";
  const rules = [];
  for (const pos of positions) {
    // v2 states each position as `{measured_offset_s, …}`; a bare number is
    // accepted too, and anything else draws nothing — never a synthesized rule.
    const at = pctOf(typeof pos === "number" ? pos : pos?.measured_offset_s, axis);
    if (has(at)) rules.push(`<span class="corr-compact"${leftStyle(at)}></span>`);
  }
  if (!rules.length) return "";
  return (
    `<span class="corr-compacts" data-note="positions observed"` +
    ` title="compaction positions as observed — never synthesized">` +
    rules.join("") +
    `</span>`
  );
}

// ── legend, cumulative panel, section stats ─────────────────────────────────

/** The band kind a legend category selects. */
const kindOf = (cat) => (cat === "trouble" ? "ts" : "build");

/** Sum of one band key across `recs`, or null when NOT ONE of them observed it. */
function sumObserved(recs, key) {
  let total = null;
  for (const r of recs) {
    const v = r.band[key];
    if (has(v)) total = (total ?? 0) + v;
  }
  return total;
}

/** The legend items. `active` is the selected category (null = nothing selected). */
function legendBlock(active) {
  const items = CATEGORIES.map(
    (c) =>
      `<button class="corr-legend-item${c.key === active ? " is-on" : ""}"` +
      ` data-cat="${c.key}" aria-pressed="${c.key === active ? "true" : "false"}">` +
      `<span class="corr-legend-swatch"></span>${esc(c.label)}</button>`,
  ).join("");
  return (
    `<div class="corr-legend" role="group" aria-label="filter by">` +
    `<span class="corr-legend-title">filter by</span>${items}` +
    `</div>`
  );
}

/**
 * THE LANE-SET TOGGLE. The adapter curates the lane set (active runs, then the
 * newest) and reports `truncated` — how many runs it is NOT drawing. A hidden
 * lane is stated, never silently omitted: the toggle names the count and, once
 * every run is drawn, offers the way back to the recent set.
 */
function toggleHtml({ truncated, total, drawn, all }) {
  if (!all && !(truncated > 0)) return "";
  const label = all ? "show recent only" : `+${truncated} historical`;
  return (
    `<button class="corr-toggle${all ? " is-on" : ""}" data-show-all="${all ? "false" : "true"}"` +
    ` aria-pressed="${all ? "true" : "false"}"` +
    ` title="showing ${drawn} of ${total} runs — ${
      all ? "click to keep only the recent lanes" : "click to draw every run, archived included"
    }">${esc(label)}</button>`
  );
}

/** The chrome row above the track: legend, lane-set toggle, compaction note. */
function filtersHtml({ legendOn, active, truncated, total, drawn, all }) {
  return (
    `<div class="corr-filters">` +
    (legendOn ? legendBlock(active) : "") +
    toggleHtml({ truncated, total, drawn, all }) +
    `<span class="corr-provenance">compaction counted — positions drawn only when observed</span>` +
    `</div>`
  );
}

/**
 * The cumulative panel, in the side rail's slot. Build/troubleshooting get the
 * full fact vocabulary — five token classes, wall, turns and context peak;
 * compaction is COUNT ONLY.
 *
 * HONEST DEGRADATION: when no phase bucket was observed there is no per-category
 * sum, so the panel states the run's REAL whole-run totals from `total` and says
 * so — it never prints zeros for an absence.
 */
function cumHtml(run, cat) {
  const model = run?.model ?? NOT_OBSERVED;
  if (cat === "compact") {
    const count = run?.compaction?.count;
    const positioned = Array.isArray(run?.compaction?.positions) && run.compaction.positions.length > 0;
    return (
      `<aside class="corr-cum">` +
      `<span class="corr-cum-head">compaction · ${esc(model)}</span>` +
      `<span class="corr-cum-row" data-k="cmp">` +
      `<b class="corr-cum-num">${esc(has(count) ? String(count) : DASH)}</b>` +
      `<span class="corr-cum-label">compactions</span></span>` +
      `<span class="corr-cum-note">${
        positioned ? "count and positions observed" : "count only — positions not observed"
      }</span>` +
      `</aside>`
    );
  }
  const kind = kindOf(cat);
  const recs = runBands(run).filter((r) => r.kind === kind);
  const total = run?.total ?? {};
  const bucketed = recs.length > 0;
  const val = (key) => (bucketed ? sumObserved(recs, key) : has(total[key]) ? total[key] : null);
  const wall = bucketed ? sumObserved(recs, "wall_seconds") : total.measured_seconds;
  const turns = bucketed ? sumObserved(recs, "turns") : total.turns;
  const rows = [
    ["in", "↑", tokCell(val("input_tokens")), "input tokens"],
    ["out", "↓", tokCell(val("output_tokens")), "output tokens"],
    ["reason", "◆", tokCell(val("reasoning_tokens")), "reasoning tokens"],
    ["cache", "⚡", tokCell(val("cache_read_tokens")), "cache-read tokens"],
    ["cachewrite", "✎", tokCell(val("cache_write_tokens")), "cache-write tokens"],
    ["peak", "◧", tokCell(val("context_peak")), "context peak"],
    ["wall", "⏱", durCell(wall), "wall time"],
    ["turns", "↻", has(turns) ? String(turns) : DASH, "turns"],
  ]
    .map(
      ([k, sym, value, label]) =>
        `<span class="corr-cum-row" data-k="${k}">` +
        `<b class="corr-cum-num">${sym} ${esc(value)}</b>` +
        `<span class="corr-cum-label">${esc(label)}</span></span>`,
    )
    .join("");
  const count = bucketed
    ? `${recs.length} ${recs.length === 1 ? "section" : "sections"}`
    : "sections not observed";
  const note = bucketed ? "" : `<span class="corr-cum-note">whole-run total — per-phase not observed</span>`;
  return (
    `<aside class="corr-cum">` +
    `<span class="corr-cum-head">${esc(cat === "trouble" ? "troubleshooting" : "build")} · ${esc(model)}</span>` +
    rows +
    `<span class="corr-cum-count">${esc(count)}</span>` +
    note +
    `</aside>`
  );
}

/**
 * One stat chip per highlighted section, in phase order, UNDER the track:
 * `P<n> build|ts` + the full fact vocabulary for that section.
 */
function statsRowHtml(run, cat) {
  const recs = runBands(run).filter((r) => r.kind === kindOf(cat));
  if (!recs.length) return "";
  const fact = (k, sym, value) =>
    `<b class="corr-fact" data-k="${k}">${sym} ${esc(value)}</b>`;
  const chips = recs
    .map(
      (r) =>
        `<span class="corr-stat">` +
        // Phases are array-ordered: the reader's P1 is position 0.
        `<span class="corr-stat-id">P${esc(String(r.phase + 1))} ${esc(cat === "trouble" ? "ts" : "build")}</span>` +
        `<span class="corr-stat-row">` +
        fact("in", "↑", tokCell(r.band.input_tokens)) +
        fact("out", "↓", tokCell(r.band.output_tokens)) +
        fact("reason", "◆", tokCell(r.band.reasoning_tokens)) +
        fact("cache", "⚡", tokCell(r.band.cache_read_tokens)) +
        fact("cachewrite", "✎", tokCell(r.band.cache_write_tokens)) +
        fact("peak", "◧", tokCell(r.band.context_peak)) +
        fact("wall", "⏱", durCell(r.band.wall_seconds)) +
        fact("turns", "↻", has(r.band.turns) ? String(r.band.turns) : DASH) +
        `</span></span>`,
    )
    .join("");
  return `<div class="corr-stats">${chips}</div>`;
}

/**
 * THE RUN'S OWN TOTALS, on the default view. The whole run in one row — turns,
 * all five token classes, wall time, context peak, the compaction count and the
 * grade roll-up — so no category has to be picked to learn what the run cost.
 * The head names the run it belongs to (the focused lane), and every numeral is
 * measured or an em dash. The compaction chip says whether the track could draw
 * positions or only count them.
 */
function totalsHtml(run) {
  const t = run?.total ?? {};
  const cmp = run?.compaction ?? null;
  const positioned = Array.isArray(cmp?.positions) && cmp.positions.length > 0;
  const fact = (k, sym, value) =>
    `<span class="corr-total" data-k="${k}">` +
    `<b class="corr-total-num">${sym} ${esc(value)}</b></span>`;
  const facts =
    fact("turns", "↻", has(t.turns) ? String(t.turns) : DASH) +
    fact("in", "↑", tokCell(t.input_tokens)) +
    fact("out", "↓", tokCell(t.output_tokens)) +
    fact("reason", "◆", tokCell(t.reasoning_tokens)) +
    fact("cache", "⚡", tokCell(t.cache_read_tokens)) +
    fact("cachewrite", "✎", tokCell(t.cache_write_tokens)) +
    fact("wall", "⏱", durCell(t.measured_seconds)) +
    fact("peak", "◧", tokCell(t.context_peak)) +
    `<span class="corr-total" data-k="cmp" data-basis="${positioned ? "positions" : "count"}"` +
    ` title="${positioned ? "counted, and positioned on the track" : "counted — no positions observed, so none are drawn"}">` +
    `<b class="corr-total-num">▮ ${esc(has(cmp?.count) ? String(cmp.count) : DASH)}</b>` +
    `<span class="corr-total-label">compactions</span></span>`;
  return (
    `<div class="corr-totals" aria-label="whole run totals">` +
    `<span class="corr-totals-head">whole run · ${esc(run?.model ?? NOT_OBSERVED)}</span>` +
    facts +
    gradesHtml(t.grades) +
    `</div>`
  );
}

/**
 * THE GRADE ROLL-UP. `count` boundaries were graded and the LAST grade states
 * passed/total — with the failed count alongside it. Absent grades are an em
 * dash, never a zero: `0 grades` would claim every boundary was judged clean.
 */
function gradesHtml(grades) {
  if (!grades || !has(grades.count)) {
    return `<span class="corr-grades" data-observed="false">grades ${DASH}</span>`;
  }
  const last = grades.last ?? {};
  const passed = has(last.passed) ? String(last.passed) : DASH;
  const graded = has(last.total) ? String(last.total) : DASH;
  const failed = has(last.failed) ? String(last.failed) : DASH;
  return (
    `<span class="corr-grades" data-observed="true" data-count="${esc(String(grades.count))}"` +
    ` data-passed="${esc(passed)}" data-total="${esc(graded)}" data-failed="${esc(failed)}"` +
    ` title="graded boundaries · last grade passed/total">` +
    `${esc(String(grades.count))} grades · ${esc(passed)}/${esc(graded)} last · ${esc(failed)} failed` +
    `</span>`
  );
}

/**
 * THE PER-LANE VERDICT LINE. Every lane states, in visible text: its outcome
 * (and the harness's terminal reason), how long it was held, and its price and
 * cost as TRI-STATE readings. `N/A` (never applicable) and `—` (not observed)
 * are distinct on purpose — a local run has no price by construction, a cloud
 * run simply was not quoted.
 */
function laneDetailHtml(run) {
  const raw = run?.outcome;
  const seen = raw !== null && raw !== undefined;
  const outcome = seen ? String(raw).replace(/_/g, " ") : NOT_OBSERVED;
  const reason = run?.outcome_detail ? ` · ${String(run.outcome_detail).replace(/_/g, " ")}` : "";
  const held = isHeld(run)
    ? ` · held ${has(run?.paused_seconds) ? dur(run.paused_seconds) : DASH}`
    : "";
  return (
    `<span class="corr-lanedetail">` +
    `<span class="corr-outcome" data-observed="${seen}">${esc(outcome)}${esc(reason)}${esc(held)}</span>` +
    `<span class="corr-money" data-k="price" title="model price">price ${esc(moneyCell(run?.price))}</span>` +
    `<span class="corr-money" data-k="cost" title="run cost">cost ${esc(moneyCell(run?.cost_usd))}</span>` +
    `</span>`
  );
}

// ── the hold gate, the failed cap and the running stub ───────────────────────
// Held time has no width: measured time excludes it, so the barrier sits where
// measured time stops.

function isHeld(run) {
  return run?.status === "held" || (has(run?.paused_seconds) && run.paused_seconds > 0);
}

/** How many boundaries produced a verdict: an observed troubleshooting bucket IS a grade. */
function gateTally(run) {
  const phases = run?.phases ?? [];
  const passed = phases.filter((p) => bandObserved(p.troubleshooting)).length;
  return { passed, total: phases.length };
}

/** THE GATE. A held run is signalled by a SHAPE, not by amber. */
function gateHtml(leftPct) {
  return (
    `<span class="corr-gate"${leftStyle(leftPct)}>` +
    `<span class="corr-gate-bar"></span>` +
    `<span class="corr-gate-pause">‖</span>` +
    `<span class="corr-gate-bar"></span>` +
    `</span>`
  );
}

/**
 * The hold card. It lives in its OWN row ABOVE the track — never over a lane —
 * its right edge pinned to the barrier's x by inline `margin-right`.
 */
function holdcardHtml(run, anchorPct) {
  // A verdict is a finding; "not observed" is an absence, and the two must not
  // wear the same type. The span states which case it is for the stylesheet.
  const raw = run?.outcome;
  const seen = raw !== null && raw !== undefined;
  const outcome = seen ? raw : NOT_OBSERVED;
  const detail = run?.outcome_detail
    ? ` · ${String(run.outcome_detail).replace(/_/g, " ")}`
    : "";
  const { passed, total } = gateTally(run);
  const anchor = has(anchorPct)
    ? ` style="margin-right:${(100 - Math.min(100, Math.max(0, anchorPct))).toFixed(2)}%"`
    : "";
  return (
    `<span class="corr-holdcard"${anchor}>` +
    `<b>dev barrier held</b>` +
    `<span data-observed="${seen}">${esc(String(outcome).replace(/_/g, " "))}${esc(detail)}</span>` +
    `<span>${esc(`${passed} of ${total} gates passed`)}</span>` +
    `</span>`
  );
}

/** The failed cap closes a lane that ran out instead of stopping. */
function capHtml(leftPct) {
  return (
    `<span class="corr-cap"${leftStyle(leftPct)}>` +
    `<span class="corr-fail">FAIL</span>${esc("did not complete")}</span>`
  );
}

// ── the live token bar ──────────────────────────────────────────────────────
// A running lane has no post-run cost to draw, so its body is the DURING-THE-RUN
// token axis instead: one segment per turn, width = the turn's share of this
// run's own total (corridor-data.tokenBarFromProgress). It is always the lane's
// full width — the left edge is the run's start, the right edge the tokens spent
// so far. Three states stay distinct: unavailable (no payload / an old run),
// empty (no token spent yet), and a bar. Nothing is zero-filled.

/** A segment's colour class: the two named kinds, everything else neutral. */
function tsegClass(kind) {
  if (kind === "build") return "corr-tseg-build";
  if (kind === "troubleshooting") return "corr-tseg-ts";
  return "";
}

function tokenBarHtml(run) {
  const bar = tokenBarFromProgress(run?.progress);

  if (!bar.available) {
    return (
      `<div class="corr-tokenbar corr-tbar-unavailable" title="no live token stream for this run">` +
      `<span class="corr-tbar-note">live token data unavailable</span>` +
      `</div>`
    );
  }
  if (bar.empty) {
    return (
      `<div class="corr-tokenbar corr-tbar-empty" title="no token spent yet">` +
      `<span class="corr-tbar-note">awaiting first token</span>` +
      `</div>`
    );
  }

  const segments = bar.segments
    .map((s) => {
      const tokens = s.tokens?.total;
      const title = `${s.phase_name ?? "turn"} · ${tok(tokens)} tokens`;
      return `<span class="corr-tseg ${tsegClass(s.phase_kind)}" style="width:${s.widthPct.toFixed(2)}%" title="${esc(title)}"></span>`;
    })
    .join("");

  // The phase/grade boundaries, on the token axis. The 0%/100% edges are where
  // the bar itself begins and ends — a line there would just be the frame.
  const boundaries = bar.boundaries
    .filter((b) => b.offsetPct > 0 && b.offsetPct < 100)
    .map((b) => `<span class="corr-tboundary" style="left:${b.offsetPct.toFixed(2)}%"></span>`)
    .join("");

  // A compaction is an instant on the same axis — a notch, never a segment.
  const compactions = bar.compactions
    .map((c) => `<span class="corr-tnotch" style="left:${c.offsetPct.toFixed(2)}%" title="compaction"></span>`)
    .join("");

  // A hold gate rides the bar's right edge — the tokens stop here because the
  // run is paused. Reuse the corridor's gate glyph; the bar scopes its position.
  const gate = bar.paused ? gateHtml(null) : "";

  return (
    `<div class="corr-tokenbar" title="live tokens spent">` +
    segments +
    boundaries +
    compactions +
    gate +
    `</div>`
  );
}

// ── lanes ────────────────────────────────────────────────────────────────────

/**
 * HONEST-DEGRADATION LANE. Per-phase data is not observed for every real run
 * today, and `total.measured_seconds` is often null. Then there is no axis to
 * place segments on, so the lane is ONE full-width "not observed" band — dashed,
 * no fabricated widths — with the run's real status overlay on top. The run's
 * real tokens/turns stay visible in the cumulative panel.
 *
 * A running lane does NOT take this band: its body is the live token bar, which
 * is its own 100%-width axis (see tokenBarHtml).
 */
function blankBandHtml() {
  return (
    `<div class="corr-band" data-observed="false" style="width:100%"` +
    ` title="not observed"><span class="corr-bandnum">not observed</span></div>`
  );
}

function laneHtml(run, i, axis, isSelected) {
  const status = run?.status ?? "unknown";
  const observedLane =
    Array.isArray(run?.phases) && run.phases.length > 0 && has(run?.total?.measured_seconds);
  const span = runSpan(run);
  const endPct = observedLane ? (pctOf(span, axis) ?? 0) : 100;
  const parts = [];

  if (status === "running") {
    // A live run is measured in tokens-spent-so-far, not in a post-run cost.
    parts.push(tokenBarHtml(run));
  } else if (observedLane) {
    const bands = bandLookup(run);
    const peak = peakBandTokens(run);
    for (const s of phaseSpans(run)) parts.push(segHtml(run, s, axis, bands, peak));
  } else {
    parts.push(blankBandHtml());
  }

  // The token bar carries its own pause gate, so a running lane does not also
  // draw the measured-time barrier.
  if (status !== "running" && isHeld(run)) parts.push(gateHtml(endPct));
  if (status === "failed") parts.push(capHtml(endPct));
  // Compaction rules ride ON the lane, over every band — but only an observed
  // lane has the time axis they are measured against. A running lane's
  // compactions are notches on the token bar instead.
  if (status !== "running" && observedLane) parts.push(compactionsHtml(run, axis));

  const model = run?.model ?? NOT_OBSERVED;
  return (
    `<div class="corr-lane${isSelected ? " is-selected" : ""}" data-lane="${i}"` +
    ` data-status="${esc(status)}" tabindex="0"` +
    ` aria-label="${esc(`${model} ${status}`)}">` +
    laneLabel(run, isSelected) +
    laneDetailHtml(run) +
    parts.join("") +
    `</div>`
  );
}

/** The barrier's x for the hold card on a lane (unobserved lanes end at 100%). */
function laneEndPct(run, axis) {
  const observedLane =
    Array.isArray(run?.phases) && run.phases.length > 0 && has(run?.total?.measured_seconds);
  return observedLane ? (pctOf(runSpan(run), axis) ?? 0) : 100;
}

// ── the empty track ──────────────────────────────────────────────────────────
// Seven stations, no lanes. A designed zero, never a failed fetch.

function renderEmpty() {
  const stations = PHASE_STATIONS.map(
    (name, i) =>
      `<span class="corr-station" data-phase="${i + 1}"><b>${i + 1}</b><span>${esc(name)}</span></span>`,
  ).join("");
  return (
    `<div class="corr-empty">` +
    `<span class="corr-empty-note">no run has crossed the wall yet — progress fills as cells run</span>` +
    `<div class="corr-stations">${stations}</div>` +
    `</div>`
  );
}

// ── the render ───────────────────────────────────────────────────────────────

const HEAD =
  `<div class="phead">` +
  `<span class="ttl">PROGRESS</span>` +
  `<span class="sub">measured wall time, not attempts</span>` +
  `</div>`;

function shell(body) {
  return (
    `<section class="panel corridor" aria-label="PROGRESS">` +
    HEAD +
    body +
    `</section>`
  );
}

/**
 * `board view → HTML`. Selection is reconciled to the run set first: with one
 * run the lane is always selected; with several, an out-of-range pick is no
 * pick — so toggling the lane set larger or smaller never leaves a stale index.
 * A category is only meaningful while a lane is selected.
 */
export function renderCorridor(view) {
  const { runs, truncated, total } = corridorRunsFromBoard(view, { showAll });

  if (!runs.length) {
    selected = null;
    category = null;
    return shell(`<div class="corr">${renderEmpty()}</div>`);
  }

  if (runs.length === 1) {
    selected = 0;
  } else if (
    selected !== null &&
    !(Number.isInteger(selected) && selected >= 0 && selected < runs.length)
  ) {
    selected = null;
  }
  if (!CATEGORY_KEYS.includes(category)) category = null;
  if (selected === null) category = null;

  const multi = runs.length > 1;
  const legendOn = !multi || selected !== null;
  const run = runs[selected ?? 0] ?? runs[0];
  const axis = trackSpan(runs);

  const lanes = runs.map((r, i) => laneHtml(r, i, axis, i === selected)).join("");
  const holds = runs.map((r) => (isHeld(r) ? holdcardHtml(r, laneEndPct(r, axis)) : "")).join("");
  const stats =
    category && category !== "compact" && runBands(run).length
      ? statsRowHtml(run, category)
      : "";
  const cum = category ? cumHtml(run, category) : "";

  return shell(
    `<div class="corr${category ? ` cat-${category}` : ""}">` +
      filtersHtml({
        legendOn,
        active: category,
        truncated,
        total,
        drawn: runs.length,
        all: showAll,
      }) +
      holds +
      `<div class="corr-track">${lanes}</div>` +
      totalsHtml(run) +
      stats +
      cum +
      `</div>`,
  );
}

// ── interaction ──────────────────────────────────────────────────────────────
// Called by board.js's delegated click: mutate module selection and answer
// TRUE when the board must re-render.
//   · lane-set toggle → showAll flips; the lane set grows/shrinks and the
//                       selection reconciles on the next render
//   · legend item     → the category filter toggles (one at a time; active clears)
//   · lane            → select it, or deselect it (dropping the category with it);
//                       picking a different lane KEEPS the active category

export function onCorridorInteraction(el) {
  if (!el || typeof el.closest !== "function") return false;

  const toggle = el.closest(".corr-toggle");
  if (toggle) {
    showAll = !showAll;
    return true;
  }

  const legendItem = el.closest(".corr-legend-item");
  if (legendItem) {
    const cat = legendItem.dataset?.cat;
    if (CATEGORY_KEYS.includes(cat)) category = category === cat ? null : cat;
    return true;
  }

  const lane = el.closest(".corr-lane");
  if (lane) {
    const i = Number(lane.dataset?.lane);
    if (Number.isInteger(i) && i >= 0) {
      if (i === selected) {
        selected = null;
        category = null;
      } else {
        selected = i;
      }
    }
    return true;
  }

  return false;
}


