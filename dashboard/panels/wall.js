// PANEL: GATE WALL — every gate as a fixed square, beside the transfer curve.
//
// It decides nothing: control/wall.mjs assigns each gate a state and this file
// maps it to a class. Untested is a dashed empty square, never a weaker pass.
// Slots follow the write-once roster order and never reflow. The total is the
// real enumerated count, or null (rendered as a reason, never 0).

import { esc, clip } from "../board.js";
import { provisional, spine } from "./live.js";

/**
 * Server facts → visual class; the only place this mapping exists.
 *   green      passed on the first attempt and never broke
 *   recovered  passing now, but not from the start (red rim, digit = attempt)
 *   red        failing in the last completed run
 *   unobserved no result yet
 *   instrument no result because the runner's worker died (amber, stated cause)
 * `state` stays the sole verdict. `instrument` is not a verdict and moves no
 * ratio. A missing trajectory degrades to plain green, never to recovered.
 */
export function gateVisual(g) {
  switch (g.state) {
    case "passing":
      return g.ever_failed === true || (g.first_pass_attempt ?? 1) > 1 ? "recovered" : "green";
    case "failing":
      return "red";
    default:
      // A cause is only ever stated by the server (not_run_cause), never inferred.
      return g.unmeasured_cause ? "instrument" : "unobserved";
  }
}

// ── THE GATE CARD ── hover to read, click to pin, click again or escape to
// let go. Everything on it is served by control/gate-detail.mjs.

const card = { hover: null, pinned: null, anchor: null, fit: null };

/** Pointer or focus reached a square. Returns true when the card must redraw. */
export function setGateHover(id, rect) {
  if (card.hover === id) return false;
  card.hover = id;
  if (id && !card.pinned && rect) { card.anchor = rect; card.fit = null; }
  return !card.pinned || !id;
}

/** A square was clicked: pin it, or unpin it if it already was. */
export function toggleGatePin(id, rect) {
  card.pinned = card.pinned === id ? null : id;
  if (card.pinned && rect) { card.anchor = rect; card.fit = null; }
  return true;
}

/** Escape: true when there was a pinned card to close. */
export function clearGatePin() {
  if (!card.pinned) return false;
  card.pinned = null;
  return true;
}

function statusLine(g) {
  const rounds = g.detail?.rounds ?? [];
  const failedRounds = rounds.filter((r) => r.status === "fail").map((r) => r.attempt);
  if (g.state === "untested") return { cls: "dim", text: "NOT YET TESTED" };
  if (g.unmeasured_cause) return { cls: "amber", text: "NOT MEASURED — the runner died, not the code" };
  if (g.state === "passing") {
    if (!g.ever_failed) return { cls: "ok", text: "PASSED — round 1" };
    const span = failedRounds.length ? `after failing round${failedRounds.length > 1 ? "s" : ""} ${failedRounds.join(", ")}` : "";
    return { cls: "ok", text: `FIXED — round ${g.first_pass_attempt ?? "?"}${span ? `, ${span}` : ""}` };
  }
  const everPassed = rounds.some((r) => r.status === "pass");
  if (everPassed) return { cls: "bad", text: "FAILING — it passed earlier and broke again" };
  return { cls: "bad", text: rounds.length > 1 ? "FAILED — never fixed" : "FAILED" };
}

function gateCard(gates) {
  const id = card.pinned ?? card.hover;
  const g = id ? gates.find((x) => x.id === id) : null;
  if (!g) return "";
  const d = g.detail ?? {};
  const desc = d.description;
  const status = statusLine(g);
  const rounds = (d.rounds ?? [])
    .map((r) => {
      const mark = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "·";
      const cls = r.status === "pass" ? "ok" : r.status === "fail" ? "bad" : "dim";
      return `<span class="gc-round ${cls}">${esc(String(r.attempt))} ${mark}</span>`;
    })
    .join("");
  const failure = d.last_failure
    ? `<div class="gc-sec"><span class="gc-h">LAST FAILURE · round ${esc(String(d.last_failure.attempt))}</span>
         <p class="gc-tech">${esc(d.last_failure.message || "the grader's report gave no message")}</p>
         ${d.last_failure.location ? `<p class="gc-where">${esc(d.last_failure.location)}</p>` : ""}</div>`
    : "";
  const told = d.told && (g.ever_failed || g.state === "failing")
    ? `<div class="gc-sec"><span class="gc-h">WHAT THE MODEL WAS TOLD</span>
         ${d.told.first ? `<p><span class="gc-k">first time</span> ${esc(d.told.first)}</p>` : ""}
         ${d.told.repeat ? `<p><span class="gc-k">again</span> ${esc(d.told.repeat)}</p>` : ""}</div>`
    : "";
  // Placement is measured, not guessed: fitGateCard (run after every paint)
  // stores the first placement where the whole card fits. The card never scrolls.
  const fit = card.fit && card.fit.id === g.id ? card.fit : null;
  const place = fit
    ? `left:${fit.left}px;top:${fit.top}px;width:${fit.width}px`
    : "left:0;top:0;width:420px;visibility:hidden";
  return `
    <div class="gcard${card.pinned ? " pinned" : ""}${fit?.compact ? " compact" : ""}" role="dialog" aria-label="${esc(desc?.name ?? g.title ?? g.id)}" style="${place}">
      <div class="gc-head">
        <span class="gc-name">${esc(desc?.name ?? g.title ?? g.id)}</span>
        <span class="gc-status ${status.cls}">${esc(status.text)}</span>
      </div>
      ${desc
        ? `<div class="gc-sec"><span class="gc-h">WHAT IT CHECKS</span><p>${esc(desc.what)}</p></div>
           <div class="gc-sec"><span class="gc-h">HOW IT'S TESTED</span><p>${esc(desc.how)}</p></div>`
        : `<div class="gc-sec"><p class="gc-tech">No description for this check yet — add one to the challenge's checks.json.</p></div>`}
      ${failure}
      ${told}
      ${rounds ? `<div class="gc-sec gc-rounds"><span class="gc-h">ROUNDS</span>${rounds}</div>` : ""}
      <div class="gc-foot"><span class="gc-id">${esc(g.id)}</span><span>${card.pinned ? "click the square or press esc to close" : "click to pin"}</span></div>
    </div>`;
}

const FIT_WIDTHS = [420, 520, 640, 760, 900, 1100];
const EDGE = 8;
const GAP = 6;

/** A placement where a card of this size fits entirely, or null. */
function placeFor(w, h, a, vw, vh) {
  const clampLeft = (x) => Math.max(EDGE, Math.min(Math.round(x), vw - w - EDGE));
  const clampTop = (y) => Math.max(EDGE, Math.min(Math.round(y), vh - h - EDGE));
  if (w > vw - 2 * EDGE || h > vh - 2 * EDGE) return null;
  if (a.bottom + GAP + h <= vh - EDGE) return { left: clampLeft(a.left), top: Math.round(a.bottom + GAP) };
  if (a.top - GAP - h >= EDGE) return { left: clampLeft(a.left), top: Math.round(a.top - GAP - h) };
  if (a.right + GAP + w <= vw - EDGE) return { left: Math.round(a.right + GAP), top: clampTop(a.top) };
  if (a.left - GAP - w >= EDGE) return { left: Math.round(a.left - GAP - w), top: clampTop(a.top) };
  return { left: clampLeft(a.left), top: clampTop(a.top) }; // over the wall, still whole
}

/**
 * Measure the drawn card and store where it fits whole. Returns true when the
 * placement changed and the board must draw again.
 */
export function fitGateCard(el, view = globalThis) {
  const id = card.pinned ?? card.hover;
  if (!el || !id) return false;
  const vw = view.innerWidth;
  const vh = view.innerHeight;
  const a = card.anchor ?? { left: EDGE, right: EDGE, top: EDGE, bottom: EDGE };
  const saved = { cssText: el.style.cssText, className: el.className };
  let chosen = null;
  for (const compact of [false, true]) {
    el.classList.toggle("compact", compact);
    for (const width of FIT_WIDTHS) {
      const w = Math.min(width, vw - 2 * EDGE);
      el.style.cssText = `left:0;top:0;width:${w}px;visibility:hidden`;
      const h = el.getBoundingClientRect().height;
      const spot = placeFor(w, h, a, vw, vh);
      if (spot) { chosen = { id, width: w, compact, ...spot }; break; }
      if (w < width) break; // already as wide as the window allows
    }
    if (chosen) break;
  }
  // Nothing fits: top-left at full width.
  chosen ??= { id, width: vw - 2 * EDGE, compact: true, left: EDGE, top: EDGE };
  el.style.cssText = saved.cssText;
  el.className = saved.className;
  const prev = card.fit;
  const same = prev && ["id", "width", "compact", "left", "top"].every((k) => prev[k] === chosen[k]);
  if (same) return false;
  card.fit = chosen;
  return true;
}

/** The window changed size or scrolled: re-read the square, measure again. */
export function refitGateCard(doc = globalThis.document) {
  const id = card.pinned ?? card.hover;
  if (!id) return false;
  const cell = doc?.querySelector?.(`[data-gate-id="${CSS.escape(id)}"]`);
  if (cell) card.anchor = cell.getBoundingClientRect();
  card.fit = null;
  return true;
}

export function renderWall(board) {
  // An archived run whose view is still loading, or could not be fetched.
  if (board.run_view) return runViewWall(board.run_view);
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
      ${gates.length ? gateCard(gates) : ""}
      ${gates.length ? legend(suite) : ""}
      ${runBlock(board)}
    </section>`;
}

/**
 * The wall of an archived run that has no view on this page (board.run_view,
 * from cellView): loading, or the reason the fetch failed. Stated as what it
 * is — not the "suite unavailable" absence, which blames the control plane,
 * and nothing of another run's.
 */
function runViewWall(rv) {
  const failed = rv.state === "failed";
  return `
    <section class="panel wall">
      <div class="phead">
        <span class="ttl">GATE WALL</span>
        <span class="tag">${failed ? "RUN VIEW NOT LOADED" : "LOADING RUN VIEW"}</span>
      </div>
      <div class="wall-empty">${failed
        ? `
        <div class="bright">${esc(`could not load this run's view — ${rv.reason}`)}</div>
        <div class="note">${esc("Click the card off and on again to fetch it again.")}</div>`
        : `
        <div class="note">loading this run's view…</div>`}
      </div>
    </section>`;
}

/**
 * The running cell: left, what it has spent (turns, tokens, time); right, where
 * it has got to (phase spine, build work order). One column on a narrow board.
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
 * Tally the gate states over the drawn gates; null for an empty array, so an
 * empty wall never reads as "everything failed".
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

/** The headline: a ratio only when the total is known. */
function headline(suite, gates) {
  if (!suite) return `<span class="tag">GATE SUITE UNAVAILABLE</span>`;

  const total = suite.suite?.total ?? null;
  if (total === null) return `<span class="tag">SUITE SIZE UNKNOWN — NOT ZERO</span>`;

  // Counted from the same gates the grid draws, so the headline never
  // contradicts the squares beneath it (the folded totals lag live results).
  const drawn = tallyStates(gates);
  const passing = drawn ? drawn.passing : (suite.totals?.passing ?? null);
  if (passing === null) return `<span class="tag">NO GATE OUTCOMES YET</span>`;

  const failing = drawn ? drawn.failing : (suite.totals?.failing ?? 0);
  const untested = drawn ? drawn.untested : (suite.totals?.untested ?? 0);

  // No run behind the suite (enumerated only): say so, or 0/N reads as a result.
  const norun = suite.suite_source === "enumerated" ? `<span class="tag">NO RUN — SUITE ENUMERATED</span>` : "";

  // gradable:false — a runner aborted, so the pass count is a lower bound, not a
  // score.
  const ungradable =
    suite.gradable === false ? `<span class="tag bad">NOT A SCORE — RUNNER ABORTED</span>` : "";

  // A partial enumeration is labelled: the denominator moved.
  const partial = suite.suite?.complete === false ? `<span class="tag">PARTIAL ENUMERATION</span>` : "";

  return `
    <span class="sub"><span class="bright">${passing}</span>/${total} passing</span>
    ${failing > 0 ? `<span class="tag bad">${failing} FAILING</span>` : ""}
    ${untested > 0 ? `<span class="sub">${untested} not yet tested</span>` : ""}
    ${norun}
    ${ungradable}
    ${partial}`;
}

/** The empty wall, with the control plane's reason (no roster vs no outcomes). */
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
 * Fill the wall in during the run from the live stream's gate.result records
 * (the runner's own rows, the same fact that reaches manifest.status.jsonl
 * later). A later attempt supersedes an earlier one; gates the stream never
 * named keep the folded state, so this only adds knowledge.
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
      // Trajectory facts (earliest passing attempt, ever failed) come folded from
      // the source; the panel derives nothing.
      ever_failed: g.ever_failed === true || r.ever_failed === true,
      first_pass_attempt: Number.isFinite(g.first_pass_attempt)
        ? g.first_pass_attempt
        : Number.isFinite(r.first_pass_attempt)
          ? r.first_pass_attempt
          : null,
    };
  });
}

/** The grid: fixed-size squares, as many per row as the card holds. */
function grid(gates) {
  const cells = gates
    .map((g) => {
      const st = gateVisual(g);
      const label = `${g.id} ${g.req ?? ""} ${g.title ?? ""}`.trim();
      const when =
        st === "recovered" && Number.isFinite(g.first_pass_attempt)
          ? ` (first passed on attempt ${g.first_pass_attempt})`
          : "";
      // Marks in the square: a digit on recovered (how many attempts), the gate's
      // own label on red (the same string the card heading uses, always visible),
      // nothing on first-try green.
      const mark =
        st === "recovered" && Number.isFinite(g.first_pass_attempt)
          ? esc(String(g.first_pass_attempt))
          : st === "red"
            ? esc(g.gate_token ?? g.id)
            : // AN INSTRUMENT FAULT IS MARKED, NOT JUST TINTED. Colour alone
              // fails an operator who cannot separate amber from red at a
              // glance, and this is the one square whose whole point is that it
              // is NOT a failure. "!" reads as "something went wrong HERE" —
              // deliberately unlike the identifier that says WHICH gate failed.
              st === "instrument"
              ? "!"
              : "";
      // The card replaces the tooltip; the short label stays for screen readers.
      const pinned = card.pinned === g.id ? " pinned" : "";
      return `<span class="gcell ${esc(st)}${pinned}" data-gate-id="${esc(g.id)}" tabindex="0" aria-label="${esc(`${label} — ${VISUAL_WORD[st]}${when}`)}">${mark}</span>`;
    })
    .join("");
  // Fixed small squares that wrap to the card's width (see .gwall).
  return `<div class="gwall">${cells}</div>`;
}

/** The tooltip gloss, kept beside the colours so the two cannot drift apart. */
const VISUAL_WORD = {
  green: "passing — green on the first attempt",
  recovered: "passing — but not on the first attempt",
  red: "failing",
  unobserved: "not yet tested",
  // Names the cause, then denies the verdict.
  instrument: "not measured — the runner's worker died before this gate reported; this is NOT a failure",
};

/** The legend shows every state, always, even at zero. */
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
 * Which attempt these squares came from, and whether it has closed — as the
 * producer said it: attempt.end closes an attempt (live.attempts), cell.end
 * ends the cell (live.ended). Only an attempt with neither is being graded.
 * The fold's attempt (manifest.status.jsonl) lands when a cell completes, so
 * the live account is the only one during a run and for a cell that ended early.
 */
export function attemptTag(suite, live) {
  const attempt = suite?.attempt ?? null;
  if (attempt !== null) return `<span class="tag">ATTEMPT ${esc(String(attempt))}</span>`;
  if (!Number.isFinite(live?.attempt)) return "";
  const n = esc(String(live.attempt));
  if ((live.attempts ?? []).some((a) => a.attempt === live.attempt)) return `<span class="tag">ATTEMPT ${n}</span>`;
  if (live.ended) {
    const why = live.ended.terminal_reason ? `CELL ${live.ended.terminal_reason}` : "CELL ENDED";
    return `<span class="tag warn">ATTEMPT ${n} · NEVER CLOSED — ${esc(why.toUpperCase())}</span>`;
  }
  return `<span class="tag warn">ATTEMPT ${n} · IN FLIGHT</span>`;
}

/** Why this attempt is not a measurement, in the harness's own sentence. */
function gradabilityNote(suite) {
  const reason = suite?.ungradable_reason ?? null;
  const aborted = Array.isArray(suite?.aborted_runners) ? suite.aborted_runners : [];
  if (reason) return reason;
  return aborted.length
    ? `${aborted.join(", ")} aborted, so gates below were left unmeasured by the harness`
    : "a gate runner aborted, so the pass count is a lower bound rather than a score";
}

/**
 * Which run these squares came from, as a header chip. Shows the path's tail
 * (the part that differs between runs); the full path is the title.
 */
function runTag(suite) {
  const dir = suite?.run_dir ?? null;
  if (!dir) return `<span class="tag warn">RUN UNSTATED</span>`;
  // The enumerated case already has its own, stronger tag.
  if (suite?.suite_source === "enumerated") return "";
  const segs = String(dir).split("/").filter(Boolean);
  const shown = segs.length > 2 ? `…/${segs.slice(-2).join("/")}` : `runs/${dir}`;
  return `<span class="tag dim" title="${esc(`runs/${dir} · graded against that run's own pinned roster`)}">${esc(clip(shown, 34))}</span>`;
}

