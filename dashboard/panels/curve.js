// ─────────────────────────────────────────────────────────────────────────────
// PANEL: TRANSFER CURVE
//
// THE HEADLINE. It replaces the old hero, and it answers the only question the
// board exists to answer: does memory make this model cheaper — and where does
// it stop?
//
// FIVE STATES, each a designed answer rather than a degraded version of the
// last (see `stackState()` in sources/stack-ledger.mjs). The state is DECIDED
// UPSTREAM by that module and consumed here; this panel never re-derives it,
// because two definitions of "is this a regression" is exactly the drift the
// board exists to expose.
//
// THE LINE RULE. A line is drawn ONLY at n≥2 ON runs. At n=1 the point is drawn
// alone: a segment from the baseline to a single ON run draws a TREND, and one
// run cannot support a trend. This is the difference between plotting data and
// implying a finding.
//
// CORRECTNESS RIDES EVERY POINT. Each point carries its gate ratio ABOVE it.
// That is what makes a faster-and-worse cell legible as faster-and-worse: the
// turn count falls while the gate ratio also falls, both visible at the same
// point, neither folded into the other. A hollow point with a danger stroke
// marks a cell that costs more than the floor.
//
// CORPUS SIZE USED TO RIDE BELOW EACH POINT AND NO LONGER DOES. Its producer
// was deleted in the recall-only pivot (2026-08-14); the reader survived and
// every point read "corpus unknown" for the life of every run. A label that can
// only ever say "unknown" is not honest absence — it is a dimension the board
// claims to measure and does not. Stripped until a real corpus level exists.
// See `sources/stack-ledger.mjs` ruling 2.
//
// NO TREND LINE THROUGH THE BASELINE. n=1 by design; the floor is a dashed
// reference line labelled at the line itself, never a series.
// ─────────────────────────────────────────────────────────────────────────────

import { esc, nul, tok, dur } from "../board.js";
import { renderLearningBody } from "./learning.js";
import { renderTuiBody } from "./tui.js";

/** Geometry, lifted from the design source's own renderer. */
const PAD_X0 = 92;
const PAD_X1 = 26;
const Y_TOP = 58;
const Y_BOT_INSET = 58;

const METRICS = {
  turns: { key: "turns", label: "TURNS — LOWER IS BETTER", fmt: (v) => String(v), unit: "" },
  // STACKED, not a line. A token total is a SUM OF CATEGORIES whose mix is
  // the finding: on a cached provider cache read is ~99% of it, so a single
  // plotted height hides the one thing worth seeing. See `bars()`.
  tokens: { key: "tokens", label: "TOKENS — LOWER IS BETTER", fmt: (v) => tok(v) ?? "—", unit: "", stacked: true },
  time: { key: "wall_seconds", label: "WALL TIME — LOWER IS BETTER", fmt: (v) => dur(v) ?? "—", unit: "" },
};

/** Which metric the curve is showing. Client-side only — never refetches. */
let metric = "turns";
export function setCurveMetric(m) {
  if (METRICS[m]) metric = m;
}
export function curveMetric() {
  return metric;
}

/**
 * THE TOP-LEVEL TAB — three views of one running cell, one card, one header.
 *
 *   TRANSFER CURVE  the WHAT — where it stopped, across runs.
 *   LEARNING        the WHY  — how the model learned, inside one session.
 *   TUI MIRROR      the RAW  — the terminal the cell is actually printing.
 *
 * The mirror joined them here because it was a floating dock covering the
 * board, and because it is a view of the same subject the other two argue
 * about. Curve is still the default.
 *
 * THIS SELECTION IS ALSO A SUBSCRIPTION. board.js reads `curveTab()` to decide
 * whether to ask the server for terminal frames (`?tui=1`), so a tab that is
 * not on screen costs nothing on the wire — the property the old minimized
 * dock had, kept.
 */
const TABS = new Set(["curve", "learning", "tui"]);
let tab = "curve";
export function setCurveTab(t) {
  if (TABS.has(t)) tab = t;
}
export function curveTab() {
  return tab;
}

export function renderCurve(board) {
  const s = board.stack ?? {};
  const state = s.state ?? "no_baseline";
  const M = METRICS[metric];

  return `
    <section class="panel curve">
      <div class="phead">
        <span class="ttl">TRANSFER CURVE</span>
        <span class="seg" data-seg="curvetab">
          ${tabBtn("curve", "TRANSFER CURVE")}
          ${tabBtn("learning", "LEARNING")}
          ${tabBtn("tui", "TUI MIRROR")}
        </span>
        <span class="sub">${esc(subhead(board))}</span>
      </div>
      ${body_for(board, s, state, M)}
    </section>`;
}

function tabBtn(id, label) {
  return `<button class="${tab === id ? "on" : ""}" data-curve-tab="${id}">${label}</button>`;
}

/**
 * WHICH BODY. Kept as one switch rather than nested ternaries, because there
 * are three of them now and a reader should be able to see all three.
 */
function body_for(board, s, state, M) {
  if (tab === "learning") return renderLearningBody(board);
  if (tab === "tui") return renderTuiBody(board);
  return curveBody(s, state, M);
}

/**
 * THE SUBHEAD.
 *
 * The curve tab used to carry "cross-run degradation point · the stack
 * headline", and the header carried an ARM A · MEMORY ON / ARM B · CONTROL
 * legend beside it. Both are DELETED. The curve's axes and its verdict foot
 * already say what the plot is, the arms are named in words on every learning
 * cell-info row and in the plot's own labels, and a three-tab header has no
 * room to restate either. An empty string keeps the flex spacer that separates
 * the tab strip from the right edge.
 */
function subhead(board) {
  if (tab === "learning") {
    return "intra-cell mechanism · one session, five phases at one task · two timescales, never conflated";
  }
  if (tab === "tui") return "the cell's terminal, mirrored read-only · 130 × 40, scaled to this card";
  return "";
}

/** The curve tab's body: the metric switch, the plot, and the verdict foot. */
function curveBody(s, state, M) {
  return `
    <div class="curve-metric">
      <span class="seg" data-seg="metric">
        ${segBtn("turns", "TURNS")}
        ${segBtn("tokens", "TOKENS")}
        ${segBtn("time", "TIME")}
      </span>
    </div>
    ${body(s, state, M)}
    ${footer(s, state, M)}`;
}

function segBtn(id, label) {
  return `<button class="${metric === id ? "on" : ""}" data-metric="${id}">${label}</button>`;
}

function body(s, state, M) {
  if (state === "no_baseline") {
    return frame(
      "no baseline · no axis · nothing measured",
      "There is no OFF run in this campaign. The stack cannot start.",
      "A curve with no floor would be a claim with no evidence.",
    );
  }

  if (state === "baseline_pending") {
    // NOT A FAILURE. The floor exists and has not reported a measurement yet —
    // either scheduled and not started, or running with its first attempt still
    // open. Rendered as the designed "not measured yet" state, never as the
    // void-instrument state: claiming an instrument failure about a healthy
    // running cell is the exact defect this state was split out to fix.
    const b = s.baseline ?? {};
    const running = b.state === "running";
    return frame(
      running ? "baseline is running · no measurement yet" : "baseline scheduled · not started",
      running
        ? "The OFF cell is in flight. Turns are not final until the cell closes."
        : "The OFF cell is scheduled and has produced no attempt record yet.",
      "A provisional total is not a floor. The curve draws nothing until the baseline closes — that is the wait, not a fault.",
    );
  }

  if (state === "baseline_void") {
    // A floor exists, TERMINATED, and the harness itself refuses to score it.
    // Drawing a curve against it would measure every ON run against a
    // transport failure.
    const b = s.baseline ?? {};
    return frame(
      "baseline is void-instrument · no valid floor",
      `The OFF cell ended ${esc(b.terminal_reason ?? "with a truncation signal")} — an instrument failure, not a capability result.`,
      "RUNBOOK 5.10: it is not scored, so no delta on this board would be valid. Re-run the baseline.",
      true,
    );
  }

  if (state === "baseline_seeded") {
    // The newest OFF cell was SEEDED from a build snapshot — a dev-mode run.
    // It is not a floor, and the reason is nothing like the void one: nothing
    // failed. It skipped the build, so its turns, tokens and wall time sit on
    // a scale no unseeded cell shares, and a delta against it would measure
    // the absence of a build rather than the presence of memory.
    const b = s.baseline ?? {};
    return frame(
      "baseline was seeded from a snapshot · not a floor",
      `The newest OFF cell started from build snapshot ${esc(String(b.seeded_from_snapshot ?? "?"))} instead of building the scaffold, so it never paid the build cost every other cell on this curve did.`,
      "Nothing failed — a seeded cell is a development run by design and is never scorable. Run an unseeded OFF baseline to establish a floor.",
      true,
    );
  }

  const pts = plottable(s);
  // THE BAR PATH DOES ITS OWN FILTERING. `plottable` gates on the legacy scalar
  // `row.tokens`; a stacked bar is drawable from the category breakdown alone,
  // so gating it on the scalar would silently drop a cell that has everything
  // the chart needs. `bars` keeps only the void-instrument exclusion (RUNBOOK
  // 5.10) and then drops whatever sums to nothing.
  if (M.stacked) return bars(s, (s.runs ?? []).filter((r) => !r.void_instrument), M);
  return svg(s, pts, M, state);
}

function plottable(s) {
  return (s.runs ?? []).filter((r) => !r.void_instrument && val(r, metric) !== null);
}

function val(row, m) {
  const v = m === "turns" ? row.turns : m === "tokens" ? row.tokens : row.wall_seconds;
  return Number.isFinite(v) ? v : null;
}

function frame(headline, line, note, bad = false) {
  return `
    <div class="curve-frame ${bad ? "bad" : ""}">
      <div class="curve-frame-head">${esc(headline)}</div>
      <div class="curve-frame-line">${esc(line)}</div>
      <div class="curve-frame-note">${esc(note)}</div>
    </div>`;
}

// ── STACKED BARS — THE TOKENS METRIC ────────────────────────────────────────
//
// A line chart plots ONE height per cell. For tokens that height is a sum of
// five categories whose PROPORTIONS are the actual finding, and the dominant
// one is invisible in a total: on a caching provider cache read is ~99% of
// every token processed. A memory system that injects into the prompt can bust
// the prefix cache on every operation — the token COUNT barely moves while the
// price per token multiplies. On a line that is a flat, reassuring graph. As a
// stack it is a segment changing shape, which is the whole point.
//
// ONE BAR PER SESSION, baseline included. The OFF floor is a bar here rather
// than the dashed reference line the other metrics use, because the comparison
// being made is compositional: ON versus OFF, segment against segment. It stays
// visually marked as the floor (`is-base`), and n=1 is still stated.
//
// STACK ORDER IS BY SIZE, LARGEST AT THE BOTTOM, and it is computed ONCE from
// the totals across every bar rather than per bar. Ordering each bar by its own
// magnitudes would reshuffle the colours between neighbours and destroy the
// only thing a stack is good for — reading one band straight across.
//
// LEGACY BARS ARE DRAWN, NOT DROPPED. Cells recorded before cache capture have
// no cache or reasoning fields. Their bar shows what was measured, carries a
// hatch and a `pre-cache` label, and is NOT silently plotted as though its
// smaller total were a saving. Absence is null everywhere, never 0 — 0 would
// read as "no cache reads happened", and the truth is that nobody looked.
//
// HOVER IS CSS-ONLY, deliberately. The board rebuilds this panel every 2s, so
// any JS-held hover state would flicker and drop. `:hover` is recomputed from
// the cursor, so it survives the rebuild. Each segment also carries a <title>
// for the native tooltip and for screen readers.
//
// `cls` IS SPELLED OUT rather than built as `cb-${key}`. A concatenated class
// name leaves only the literal prefix `cb-` in the source, which is what the
// style-coverage guard reads — it would chase a class that never exists while
// the six that DO exist go unchecked. Whole names here keep that guard useful.
const SEG_DEFS = [
  { key: "cache_read", label: "cache read", cls: "cb-cache_read" },
  { key: "input", label: "input", cls: "cb-input" },
  { key: "reasoning", label: "reasoning", cls: "cb-reasoning" },
  { key: "output", label: "output", cls: "cb-output" },
  { key: "outres", label: "output + reasoning", cls: "cb-outres" },
  { key: "cache_write", label: "cache write", cls: "cb-cache_write" },
];
const segDef = (key) => SEG_DEFS.find((d) => d.key === key);

/**
 * Split one row into drawable segments.
 *
 * `output_and_reasoning` is the persisted `work_output_tokens`, which has
 * always had reasoning folded into it. When the reasoning share is recorded we
 * subtract to recover generation-only and draw both; when it is not, we draw
 * ONE segment honestly labelled `output + reasoning` rather than guessing a
 * split.
 */
function segsOf(row) {
  const b = row?.tokens_breakdown ?? {};
  const has = (v) => v !== null && v !== undefined && Number.isFinite(v);
  const preCache = !has(b.cache_read);
  const segs = [];
  const push = (key, v) => {
    if (has(v) && v > 0) segs.push({ key, label: segDef(key).label, v });
  };

  push("input", b.input);
  if (!preCache) {
    push("cache_read", b.cache_read);
    push("cache_write", b.cache_write);
  }
  if (has(b.reasoning)) {
    push("output", (b.output_and_reasoning ?? 0) - b.reasoning);
    push("reasoning", b.reasoning);
  } else {
    push("outres", b.output_and_reasoning);
  }
  return { segs, preCache, total: segs.reduce((a, x) => a + x.v, 0) };
}

/**
 * TWO BANDS, TWO SCALES, NEITHER DISTORTED.
 *
 * A true-proportion stack of these five categories is, on a caching provider,
 * one solid block: cache read is ~99%, so input/output/reasoning render at
 * 0.3px — invisible, and too small to put a cursor on. The obvious fixes are
 * both lies. A minimum segment height draws a 0.18% band as 1.1% and
 * overstates it six-fold; a log axis breaks the one promise a stack makes,
 * that the parts visibly sum to the whole. This board does not draw either.
 *
 * So it draws the truth twice at two honest scales:
 *
 *   TOP BAND — all five categories, true proportion. Answers "what did this
 *   cell cost". Correctly reads as one dominant block, because that is what a
 *   cached agentic cell IS.
 *
 *   BOTTOM BAND — the same cells with cache read REMOVED, rescaled to their own
 *   maximum. Answers "what did the model actually do". Nothing is distorted:
 *   each band is internally proportional and each is labelled with its own
 *   scale, so no reader can mistake one for the other.
 *
 * Reading the two together is the cache-invalidation test the operator asked
 * for. Memory injection that busts the prompt prefix moves tokens out of cache
 * read and into input: the top band barely changes shape while the bottom band's
 * input segment grows sharply. Neither band alone shows that; the pair does.
 */
function bars(s, pts, M) {
  const base = s.baseline ?? null;
  const rows = [];
  if (base) rows.push({ row: base, isBase: true });
  pts.forEach((p) => rows.push({ row: p, isBase: false }));

  const built = rows.map((r) => ({ ...r, ...segsOf(r.row) })).filter((r) => r.total > 0);
  if (!built.length) {
    return frame(
      "no token breakdown yet",
      "No cell has recorded a token measurement for this stack.",
      "Bars appear as soon as a cell completes.",
    );
  }

  // ONE order for every bar, by total size across the whole chart. Ordering
  // each bar by its own magnitudes would reshuffle the colours between
  // neighbours and destroy the only thing a stack is good for — reading one
  // band straight across.
  const weight = new Map();
  for (const b of built) for (const g of b.segs) weight.set(g.key, (weight.get(g.key) ?? 0) + g.v);
  const order = SEG_DEFS.map((d) => d.key).filter((k) => weight.has(k));
  order.sort((a, z) => weight.get(z) - weight.get(a));

  const W = 860;
  const H = 470;
  const x0 = 92;
  const x1 = W - 26;
  const slot = (x1 - x0) / built.length;
  const bw = Math.min(78, slot * 0.62);
  const bits = [];

  bits.push(`<text x="2" y="14" class="c-axis">${esc(M.label)} — STACKED BY CATEGORY</text>`);

  // Legend in stack order, so the swatch column reads like the bars do.
  bits.push(
    order
      .map((k, i) => {
        const d = segDef(k);
        return `<rect x="${x0 + i * 132}" y="26" width="9" height="9" class="${d.cls} cb-seg"/>
                <text x="${x0 + i * 132 + 14}" y="35" class="c-legend">${esc(d.label)}</text>`;
      })
      .join(""),
  );

  /** Draw one band. `drop` names a category to exclude and rescale without. */
  const band = (yTop, yBot, drop, title) => {
    const of = (b) => b.segs.filter((g) => g.key !== drop);
    const totalOf = (b) => of(b).reduce((a, g) => a + g.v, 0);
    const hi = Math.max(...built.map(totalOf));
    bits.push(`<text x="2" y="${yTop - 12}" class="c-legend">${esc(title)}</text>`);
    bits.push(`<line x1="${x0 - 18}" y1="${yBot + 10}" x2="${x1}" y2="${yBot + 10}" class="c-ax"/>`);
    if (hi <= 0) return;

    built.forEach((b, i) => {
      const cx = x0 + slot * i + slot / 2;
      const bx = cx - bw / 2;
      const segs = of(b);
      const tot = totalOf(b);
      if (tot <= 0) return;
      const full = (tot / hi) * (yBot - yTop);
      let y = yBot;
      for (const key of order) {
        const g = segs.find((x) => x.key === key);
        if (!g) continue;
        const h = (g.v / tot) * full;
        y -= h;
        // Percentages are always OF THE WHOLE CELL, never of the rescaled
        // band — a band-relative percentage would read as a real share of the
        // run and would be wrong by two orders of magnitude.
        const share = (g.v / b.total) * 100;
        const pctTxt = share.toFixed(share < 1 ? 2 : 1);
        bits.push(
          `<rect x="${bx}" y="${y}" width="${bw}" height="${h}" class="${segDef(key).cls} cb-seg">` +
            `<title>${esc(`${g.label}: ${g.v.toLocaleString("en-US")} — ${pctTxt}% of this cell's ${b.total.toLocaleString("en-US")} tokens`)}</title>` +
            `</rect>`,
          `<text x="${bx + bw + 8}" y="${y + h / 2 + 4}" class="cb-hov">${esc(`${g.label} ${g.v.toLocaleString("en-US")} · ${pctTxt}%`)}</text>`,
        );
      }
      bits.push(
        `<text x="${cx}" y="${yBot - full - 10}" text-anchor="middle" class="c-val">${esc(tok(tot) ?? "—")}</text>`,
      );
    });
  };

  band(70, 230, null, "ALL FIVE CATEGORIES · TRUE PROPORTION · WHAT THE CELL COST");
  band(295, 400, "cache_read", "SAME CELLS, CACHE READ REMOVED · OWN SCALE · WHAT THE MODEL GENERATED");

  // Cell labels once, under the lower band.
  built.forEach((b, i) => {
    const cx = x0 + slot * i + slot / 2;
    const r = b.row;
    const arm = r.arm ? String(r.arm).toUpperCase() : "—";
    bits.push(
      `<text x="${cx}" y="${428}" text-anchor="middle" class="c-gate">${esc(b.isBase ? "OFF floor · n=1" : `${arm} · cell ${r.sequence_index ?? i}`)}</text>`,
    );
    if (b.preCache) {
      bits.push(
        `<text x="${cx}" y="444" text-anchor="middle" class="cb-legacy">pre-cache record</text>`,
      );
    }
  });

  if (built.some((b) => b.preCache)) {
    bits.push(
      `<text x="${x1}" y="14" text-anchor="end" class="c-note">BARS MARKED pre-cache PREDATE CACHE CAPTURE — SHORTER IS NOT CHEAPER</text>`,
    );
  }

  return `<svg viewBox="0 0 ${W} ${H}" class="curve-svg" role="img">${bits.join("")}</svg>`;
}

function svg(s, pts, M, state) {
  const W = 860;
  const H = 300;
  const base = val(s.baseline ?? {}, metric);
  const x0 = PAD_X0;
  const x1 = W - PAD_X1;
  const yBot = H - Y_BOT_INSET;

  const vals = pts.map((p) => val(p, metric)).concat(base !== null ? [base] : []);
  if (!vals.length) {
    return frame("nothing plottable yet", "The floor exists but no ON run has produced a measurement.", "Arm an ON run to start the curve.");
  }

  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = (hi - lo) * 0.35 || 6;
  lo -= pad;
  hi += pad;

  const Y = (v) => yBot - ((v - lo) / (hi - lo)) * (yBot - Y_TOP);
  const X = (i) => (pts.length <= 1 ? (x0 + x1) / 2 : x0 + (i * (x1 - x0)) / (pts.length - 1));

  const bits = [];

  bits.push(`<text x="2" y="14" class="c-axis">${esc(M.label)}</text>`);
  if (base !== null) {
    bits.push(
      `<text x="2" y="32" class="c-legend">─ ─ OFF baseline · n=1 · ${esc(M.fmt(base))}</text>`,
    );
  }
  bits.push(`<line x1="${x0 - 18}" y1="${yBot + 10}" x2="${x1}" y2="${yBot + 10}" class="c-ax"/>`);

  // THE FLOOR. Dashed, labelled AT THE LINE — n=1 is stated where it is read,
  // not in a footnote a viewer has to hunt for.
  if (base !== null) {
    const by = Y(base);
    bits.push(`<line x1="${x0 - 18}" y1="${by}" x2="${x1}" y2="${by}" class="c-base"/>`);
    bits.push(`<text x="2" y="${by + 4}" class="c-base-lbl">OFF ${esc(M.fmt(base))}</text>`);
  }

  // THE LINE — n≥2 only. See the header.
  if (pts.length >= 2) {
    const d = pts
      .map((p, i) => `${i ? "L" : "M"}${X(i)} ${Y(val(p, metric))}`)
      .join(" ");
    bits.push(`<path d="${d}" class="c-path"/>`);
  }

  pts.forEach((p, i) => {
    const cx = X(i);
    const cy = Y(val(p, metric));
    // A cell that costs MORE than the floor is hollow with a danger stroke —
    // drawn at full weight, same size, same line. The finding is not hidden.
    const worse = base !== null && val(p, metric) >= base;
    const g = p.gates ?? {};
    const gateTxt =
      g.failed === null || g.failed === undefined
        ? "gates not measured"
        : g.total
          ? `${g.total - g.failed}/${g.total} obs`
          : `${g.failed} failed`;
    // Gate ratio worsening is its OWN signal, independent of cost.
    const gateBad = g.failed !== null && g.failed !== undefined && g.failed > 0;
    const delta =
      base === null ? "" : deltaLabel(val(p, metric) - base, metric);

    bits.push(
      `<circle cx="${cx}" cy="${cy}" r="5.5" class="c-pt ${worse ? "worse" : ""}"/>`,
      `<text x="${cx}" y="${cy - 30}" text-anchor="middle" class="c-val">${esc(M.fmt(val(p, metric)))}</text>`,
      `<text x="${cx}" y="${cy - 15}" text-anchor="middle" class="c-delta ${worse ? "bad" : ""}">${esc(delta)}</text>`,
      `<text x="${cx}" y="${yBot + 28}" text-anchor="middle" class="c-gate ${gateBad ? "bad" : ""}">${esc(gateTxt)}</text>`,
    );
  });

  if (state === "regression") {
    bits.push(
      `<text x="${x1}" y="14" text-anchor="end" class="c-annot">CROSSES THE FLOOR AT RUN ${pts.length}</text>`,
    );
  }
  if (state === "n1_on") {
    bits.push(
      `<text x="${x1}" y="14" text-anchor="end" class="c-note">n=1 — NO LINE DRAWN</text>`,
    );
  }

  return `<div class="curve-svg"><svg viewBox="0 0 ${W} ${H}" width="100%">${bits.join("")}</svg></div>`;
}

function deltaLabel(d, m) {
  if (!Number.isFinite(d)) return "";
  const sign = d > 0 ? "+" : "−";
  const a = Math.abs(d);
  if (m === "tokens") return `${sign}${tok(a) ?? a}`;
  if (m === "time") return `${sign}${dur(a) ?? a}`;
  return `${sign}${a}`;
}

function footer(s, state, M) {
  const base = val(s.baseline ?? {}, metric);
  if (state === "baseline_seeded") {
    // The newest OFF cell was SEEDED from a build snapshot — a dev-mode run.
    // It is not a floor, and the reason is nothing like the void one: nothing
    // failed. It skipped the build, so its turns, tokens and wall time sit on
    // a scale no unseeded cell shares, and a delta against it would measure
    // the absence of a build rather than the presence of memory.
    const b = s.baseline ?? {};
    return frame(
      "baseline was seeded from a snapshot · not a floor",
      `The newest OFF cell started from build snapshot ${esc(String(b.seeded_from_snapshot ?? "?"))} instead of building the scaffold, so it never paid the build cost every other cell on this curve did.`,
      "Nothing failed — a seeded cell is a development run by design and is never scorable. Run an unseeded OFF baseline to establish a floor.",
      true,
    );
  }

  const pts = plottable(s);
  const newest = pts.length ? pts[pts.length - 1] : null;

  let verdict;
  if (state === "no_baseline") verdict = "arm an OFF run — it is the only cell that can be first";
  else if (state === "baseline_pending")
    verdict =
      s.baseline?.state === "running"
        ? "baseline running — the floor is not measured until the cell closes"
        : "baseline scheduled — no measurement yet";
  else if (state === "baseline_void") verdict = "no valid floor — re-run the baseline before any ON run";
  else if (state === "baseline_seeded")
    verdict = "newest OFF cell was seeded — a development run, never a floor";
  else if (state === "baseline_only") verdict = "floor established · no ON run yet";
  else if (state === "n1_on") verdict = "one ON run — a single delta, stated as a single delta";
  // THE VERDICT COUNTS ON RUNS, NOT MEMORIES. It used to end "at N memories",
  // falling back to "at an unknown corpus size" — and that fallback was the only
  // branch that ever ran once the corpus producer was deleted. How many ON runs
  // are plotted is a fact this panel actually holds; a corpus level is not.
  else if (state === "regression" && newest && base !== null)
    verdict = `transfer stopped — ${deltaLabel(val(newest, metric) - base, metric)} by ON run ${pts.length}`;
  else if (newest && base !== null)
    verdict = `transfer holding — ${deltaLabel(val(newest, metric) - base, metric)} at ON run ${pts.length}`;
  else verdict = "";

  const bad = state === "regression" || state === "baseline_void";

  return `
    <div class="curve-foot">
      <span>─── OFF baseline, n=1${base !== null ? `, ${esc(M.fmt(base))}` : ""}</span>
      <span class="bright">● ON run · gates above</span>
      <span class="${bad ? "danger" : "bright"}">${esc(verdict)}</span>
      <button class="btn sm" data-curve-tab="learning">WHY IT STOPPED → LEARNING</button>
    </div>`;
}
