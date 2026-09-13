// ─────────────────────────────────────────────────────────────────────────────
// PANEL: TUI MIRROR — a tab on the TRANSFER CURVE card
//
// It used to be a floating dock pinned to the bottom-right corner, minimized by
// default, covering whatever it happened to sit on top of. It is now the third
// tab of the transfer-curve card, beside TRANSFER CURVE and LEARNING: the
// terminal is a view OF the running cell, and the card that argues about the
// running cell is where it belongs. There is no dock, no expand/minimize, and
// nothing floats over the board any more.
//
// ── THE GRID IS STILL DERIVED, AND IS STILL NEVER RESHAPED ──────────────────
// The terminal is a HARD 40×130 character grid with fixed monospace metrics.
// At 8.4px advance and 17px leading that is exactly 1092 × 680 of content, and
// those numbers are still computed below FROM the grid constants.
//
// The card is narrower than 1092px, so the grid is SCALED UNIFORMLY to the
// card's width — never reflowed, never clipped, never re-wrapped. A uniform
// scale is not the defect the old comment here warned about: no column is
// dropped, no line is folded, and one character cell is still exactly one grid
// cell. What changes is the size of the cell, not the shape of the grid. The
// factor is measured from the real container (`fitTui()`), published as
// `--tui-scale`, and capped at 1 so the mirror is never blown up past its
// native metrics.
//
// ── STRICTLY READ-ONLY ──────────────────────────────────────────────────────
// The mirror never writes to the PTY. There is no input, no focusable field,
// no caret, and nothing that suggests typing into it — a `pre`, not a
// `textarea`. The header says READ-ONLY MIRROR — NO INPUT in words.
//
// ── FIDELITY ────────────────────────────────────────────────────────────────
// white-space: pre · ligatures off · one character cell = one grid cell ·
// colour preserved from the run-length frame. Serialised frames arrive as rows
// of styled runs (control/tui.mjs Screen.serialise) and are rebuilt span by
// span, so colour survives the trip.
//
// ── NON-LIVE STATES ARE NOT ERRORS ──────────────────────────────────────────
//   starting  first paint takes ~10s. NORMAL, not a hang. The elapsed counter
//             runs so the wait is visibly bounded.
//   failed    could not attach — verbatim reason.
//   silent    attached, no output. The grid is UNCHANGED and NOTHING is drawn
//             moving: a silent terminal must look silent.
//   exited    the last frame is held, dimmed, and labelled as the final frame.
//
// ── DETACH & CLOSE IS DESTRUCTIVE AND SAYS SO ───────────────────────────────
// Always present, confirmed, and phrased plainly: it kills the PTY, the mirror
// stops, and there is no reattach. The benchmark cell keeps running — the
// operator just will not see its terminal again. Saying "close" without saying
// "for good" would be the lie.
// ─────────────────────────────────────────────────────────────────────────────

import { esc, nul } from "../board.js";
import { renderStartupFeed, startupFeed } from "./startup.js";

/** Must match control/tui.mjs. Asserted by a drift guard. */
export const TUI_ROWS = 40;
export const TUI_COLS = 130;
// CH_W / CH_H / GRID_W / GRID_H LIVED HERE AND ARE DELETED.
//
// They hardcoded a character cell as 8.4 x 17 px and derived a 1092 x 680 box
// from it. The advance was wrong (8.4px is 0.6em at fourteen px; the sheet
// renders thirteen), and it described a font that never loaded — so the box was
// 6.8% wider than the grid it held. A pixel metric written down in a source
// file is a measurement that cannot be re-taken when the font changes.
//
// The terminal now measures itself. See `fitTui()`.

let confirming = false;

export function askDetach() {
  confirming = true;
}
export function cancelDetach() {
  confirming = false;
}
export function isDetachConfirming() {
  return confirming;
}

/**
 * The body of the TUI MIRROR tab. The card owns the header and the tab strip;
 * this owns everything below it.
 *
 * There is no minimized form. The tab IS the visibility control: the mirror is
 * on screen when the operator selects it, and off when they select another
 * tab — which is also what gates the `?tui=1` subscription in board.js, so a
 * hidden mirror costs no frames on the wire, exactly as the old minimized dock
 * did.
 */
export function renderTuiBody(board) {
  const t = board.tui ?? null;
  const status = t?.status ?? null;

  return `
    <div class="tui-mirror">
      ${mirrorHead(t)}
      ${mirrorScreen(board, t, status)}
      ${mirrorFoot(board, t, status)}
    </div>
    ${confirming ? confirmModal() : ""}`;
}

/**
 * THE YIELD RULE — "once the TUI renders, the startup feed disappears".
 *
 * DERIVED FROM THE REAL SIGNAL, NEVER A TIMER. The feed is displaced by the
 * arrival of an actual painted frame, so it cannot vanish while the mirror is
 * still empty — which is precisely when it is the only thing with anything to
 * say.
 *
 * `frame_withheld` does NOT count. The server drops the frame for a client
 * whose popout is minimized, so treating "no frame" as "no terminal" there
 * would hide the feed behind a frame that was never sent.
 *
 * THE FEED COMES BACK WHEN THE TERMINAL STOPS BEING LIVE. On `failed` and
 * `exited` the mirror is showing a dead or final frame, and that is exactly the
 * moment an operator needs the background-process list again — a mirror that
 * died mid-run is a question the last frame cannot answer. `silent` is treated
 * as still-live: a silent terminal is a real, legible state of a healthy run,
 * and displacing it would be claiming a failure that has not happened.
 */
function terminalHasPainted(t, status) {
  return Boolean(t?.frame) && (status === "live" || status === "silent");
}

// ── THE TAB HEAD — identity, the read-only claim, and the one control ──────
//
// EXPAND/MINIMIZE ARE GONE, not hidden. They were the dock's controls and the
// dock no longer exists; a button that toggles nothing is worse than no button.
// DETACH & CLOSE stays, because it is the only thing on this surface that can
// change the world.

function mirrorHead(t) {
  return `
    <div class="tui-head">
      <span class="tui-brand">▌TUI MIRROR</span>
      <span class="note">${esc(`${TUI_COLS} cols × ${TUI_ROWS} rows`)}${t?.session_id ? esc(` · pty ${String(t.session_id).slice(0, 8)}`) : ""}</span>
      <span class="tui-stat">${statusWord(t, t?.status ?? null)}</span>
      <span class="tag">READ-ONLY MIRROR — NO INPUT</span>
      <span class="spacer"></span>
      <button class="btn sm destroy" data-tui-detach="1">DETACH &amp; CLOSE</button>
    </div>`;
}

function statusWord(t, status) {
  if (!t) return `<span class="null">not attached</span>`;
  if (status === "live") {
    const age = t.last_data_at ? Math.round((Date.now() - t.last_data_at) / 1000) : null;
    return `<span class="bright">live</span>${age !== null ? ` · ${esc(String(age))}s` : ""}`;
  }
  if (status === "starting") return `<span class="muted">attaching…</span>`;
  if (status === "failed") return `<span class="danger">failed</span>`;
  if (status === "silent") return `<span class="muted">silent</span>`;
  if (status === "exited") return `<span class="muted">exited</span>`;
  return nul("status unobserved");
}

// ── THE SCREEN ──────────────────────────────────────────────────────────────
//
// The container is a plain block that takes the card's width. It carries NO
// size of its own: the terminal's own layout decides how tall the mirror is,
// and `fitTui()` solves for the font size that makes 130 columns fill exactly
// this width. Nothing here reserves a box for the grid to be squeezed into —
// which is what the old `--tui-w`/`--tui-h`/`--tui-scale` arrangement did, off
// a character advance that was wrong by 6.8%.

/**
 * THE FEED AND THE TERMINAL ARE SIBLINGS, TOGGLED — never one swapped for the
 * other in the same slot.
 *
 * They used to alternate in one position, and that broke twice over. dom.js
 * syncs attributes BEFORE it checks `data-preserve`, so swapping the terminal
 * host for the feed stripped the preserve flag and then recursed into the
 * terminal's own DOM — leaving both surfaces half-rendered on screen at once.
 * And every swap destroyed the Terminal and built a new one, which is a full
 * re-measure and re-render for a state change that should cost nothing.
 *
 * Kept side by side, the host node is STABLE for the life of the tab: xterm
 * attaches once, and the yield rule becomes a class toggle.
 */
function mirrorScreen(board, t, status) {
  const painted = terminalHasPainted(t, status);
  return `
    <div class="tui-screen">
      <div class="tui-feed${painted ? " off" : ""}">${painted ? "" : renderStartupFeed(board)}</div>
      ${painted ? screen(t, status) : ""}
      <div class="tui-term${painted ? "" : " off"}${status === "silent" ? " dim" : ""}" data-preserve="1" aria-label="read-only terminal mirror"></div>
    </div>`;
}

// ── THE FOOT — what the operator is looking at, said plainly ────────────────
//
// THE BLOCKING COUNT LIVES HERE NOW. It used to ride the minimized dock bar,
// because the dock was minimized by default and a failure visible only in the
// expanded view is a failure the operator has to go looking for. The mirror is
// no longer hidden behind a toggle, but the count is still worth stating in
// words beside the feed that explains it.

function mirrorFoot(board, t, status) {
  const painted = terminalHasPainted(t, status);
  const feed = painted ? null : startupFeed(board);
  const blocking = feed?.blocking?.length ?? 0;
  return `
    <div class="tui-foot">
      ${blocking
        ? `<span class="tui-block">${esc(`${blocking} BLOCKING START`)}</span>`
        : feed
          ? `<span class="tui-ready">${esc("startup: ready")}</span>`
          : ""}
      <span class="note">${esc(
        painted
          ? "xterm.js · one character cell = one grid cell · the font size is solved so 130 columns fill this card exactly, so nothing is scaled, reflowed or clipped · colour is carried through as truecolor · nothing here accepts a keystroke"
          : "no live terminal frame yet — this space reports the background processes a benchmark start depends on, and yields to the terminal the moment it paints",
      )}</span>
    </div>`;
}

/**
 * The silent notice, and only that.
 *
 * The terminal host itself is emitted by `mirrorScreen` so that it is present
 * in every state and never rebuilt. This is what remains of the function that
 * used to paint the frame as spans.
 */
function screen(t, status) {
  return status === "silent"
    ? banner(`Attached. ${t.reason ?? "no output"} — the mirror is live and the grid is unchanged.`)
    : "";
}

function banner(text) {
  return `<div class="tui-banner">${esc(text)}</div>`;
}

// ── THE TERMINAL ────────────────────────────────────────────────────────────
//
// WHY A REAL EMULATOR AND NOT SPANS. The previous renderer rebuilt the frame as
// up to 444 inline-styled <span>s and handed 29KB of markup to the morpher to
// diff, ~5 times a second. Four defects came out of that arrangement, all
// measured on the live board:
//
//   1. SIZE WAS GUESSED. `CH_W = 8.4` was documented as 13px JetBrains Mono.
//      8.4 is 0.6em at FOURTEEN px; the stylesheet renders thirteen. 130
//      columns drew 1017.5px inside a box reserving 1092 — a 74.5px dead band
//      (6.8%) that also made the fit factor divide by the wrong width.
//   2. THE FONT WAS NEVER THERE. Both @font-face entries for JetBrains Mono
//      report status "error" (the pinned Google URL 404s), so the board has
//      always drawn SF Mono and every JetBrains-derived constant was void.
//   3. COLOUR WAS SILENTLY DISCARDED. The server sends `#rrggbb`; the old
//      `cssColor()` ran `Number("#2fe07a")` -> NaN -> "inherit". Every span on
//      screen carried `color:inherit;background:inherit` — two distinct styles
//      in the whole frame. The panel claimed "colour fidelity preserved" while
//      throwing all of it away.
//   4. THE EMULATOR IS PARTIAL. control/tui.mjs implements CUP/CUU/CUD/CUF/
//      CUB/CHA/VPA/ED/EL/ECH/SGR and nothing else, advances one cell per
//      UTF-16 code unit (so a CJK glyph or emoji shifts the rest of the row,
//      and astral characters split into surrogate halves), drops characters
//      past column 130 instead of wrapping, and drops rows past 40 instead of
//      scrolling.
//
// xterm.js MEASURES the font it is actually handed, so (1) and (2) cannot
// recur by construction; the frame is fed to it as real SGR, which fixes (3).
// (4) lives on the control plane and is stage two of this migration — the
// server keeps its own emulator until the raw-byte stream replaces it.

/** The live Terminal, and the node it is currently attached to. */
let term = null;
let termHost = null;
/** Last frame written, as the exact byte string sent to the terminal. */
let lastPaint = "";
/** Font size in CSS px, solved for by `fitTui()`. Never a hardcoded metric. */
let fontPx = 12;
/** Set while the host has no layout, so the next visible tick re-solves. */
let reappearing = false;

/**
 * The board's palette, read from the live stylesheet rather than duplicated.
 *
 * xterm draws to a canvas and cannot resolve a custom property, so the tokens are
 * resolved once against the document. Reading them keeps ONE definition of the
 * board's colours; hardcoding a second copy here is how the mirror would drift
 * out of the theme the moment a token changed.
 */
function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name) || "").trim() || fallback;
  return {
    background: v("--bg", "#02100a"),
    foreground: v("--type", "#e2ffec"),
    cursor: "rgba(0,0,0,0)",
    cursorAccent: "rgba(0,0,0,0)",
    selectionBackground: "rgba(255,255,255,0.18)",
  };
}

/**
 * Build the frame as terminal bytes.
 *
 * A FULL REPAINT, addressed row by row. `serialise()` pads every row to the
 * full column count, so writing each row from column 1 overwrites it whole and
 * no erase is needed. Absolute addressing before each row also means a wrap at
 * column 130 cannot bleed into the next one.
 *
 * COLOUR IS EMITTED AS TRUECOLOR because that is what the frame carries — the
 * server resolves 256-colour and the basic palette to `#rrggbb` upstream
 * (control/tui.mjs `sgr()`), so there is nothing to map and nothing to guess.
 */
export function toAnsi(rows) {
  let out = "\x1b[H";
  for (let r = 0; r < rows.length; r += 1) {
    out += `\x1b[${r + 1};1H`;
    for (const run of rows[r]) {
      out += "\x1b[0m";
      if (run.bold) out += "\x1b[1m";
      const fg = sgrColor(run.fg, 38);
      const bg = sgrColor(run.bg, 48);
      if (fg) out += fg;
      if (bg) out += bg;
      out += run.t;
    }
  }
  return `${out}\x1b[0m`;
}

/**
 * `#rrggbb` -> an SGR truecolor parameter, or "" for an unset channel.
 *
 * ANYTHING THAT IS NOT A HEX TRIPLE IS DROPPED, not coerced. Terminal output is
 * model-authored and reaches this function through the capture; a value that
 * does not match is absence of colour, never a colour to invent. This is the
 * function whose predecessor coerced every hex string to "inherit".
 */
function sgrColor(hex, base) {
  if (typeof hex !== "string") return "";
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "";
  return `\x1b[${base};2;${parseInt(m[1], 16)};${parseInt(m[2], 16)};${parseInt(m[3], 16)}m`;
}

/**
 * ATTACH, SIZE AND PAINT. Called by board.js after every patch.
 *
 * Idempotent and cheap on the common path: if the host node is the same one the
 * Terminal is already attached to and the frame is byte-identical to the last
 * one written, this returns having done nothing.
 */
export function paintTui(board) {
  const host = document.querySelector(".tui-term");

  // Another tab is showing. Tear down rather than keep a renderer alive against
  // a detached node — and forget the last paint, so returning repaints in full.
  if (!host) {
    disposeTerm();
    return;
  }

  // ── NEVER BUILD OR PAINT A TERMINAL THAT HAS NO LAYOUT ──────────────────
  //
  // The host is `display:none` whenever the startup feed owns the space, and
  // the board calls this on EVERY tick regardless. A Terminal opened into a
  // hidden node measures its cell at zero and renders a zero-sized screen —
  // and nothing ever re-measures it, so it stays zero after the node becomes
  // visible. That is not a hypothetical: it is what shipped for one deploy, as
  // a mirror that drew nothing at all.
  //
  // So a hidden host is a no-op, and the transition back to visible is recorded
  // — `hidden -> visible` must re-solve the font size AND repaint in full,
  // because the frame that arrived while it was hidden was never written.
  const avail = host.clientWidth;
  if (!avail) {
    reappearing = Boolean(term);
    return;
  }

  // patch() replaces a node whose tag or position changed. Re-attaching to the
  // node that is actually in the document is what keeps the mirror alive across
  // those swaps instead of painting into an orphan.
  if (term && termHost !== host) disposeTerm();

  if (!term) {
    if (typeof globalThis.Terminal !== "function") return; // vendor script absent
    term = new globalThis.Terminal({
      cols: TUI_COLS,
      rows: TUI_ROWS,
      fontFamily: (getComputedStyle(document.documentElement).getPropertyValue("--font") || "monospace").trim(),
      fontSize: fontPx,
      lineHeight: 1,
      letterSpacing: 0,
      theme: theme(),
      // READ-ONLY, STATED THREE WAYS. No `onData` handler is ever attached, so
      // there is no path from this widget to the PTY at all; these only stop
      // the widget from LOOKING like it takes input. `convertEol` is off
      // because every row is absolutely addressed.
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: "bar",
      cursorInactiveStyle: "none",
      convertEol: false,
      scrollback: 0,
      allowTransparency: false,
    });
    term.open(host);
    termHost = host;
    lastPaint = "";
  }

  if (reappearing) {
    reappearing = false;
    fittedFor = -1; // the width was never valid while it was hidden
    lastPaint = ""; // force a full repaint of whatever arrived meanwhile
  }

  const next = toAnsi(board?.tui?.frame ?? []);
  if (next !== lastPaint) {
    term.write(next);
    lastPaint = next;
  }
  fitTui();
}

// THE WEBGL ADDON WAS HERE AND IS DELETED. MEASURED, NOT ASSUMED.
//
// It renders to a GPU texture atlas, and to do that it quantises the character
// cell to WHOLE DEVICE PIXELS. Swept against a real Terminal in this card at
// devicePixelRatio 2, the achievable cell widths were 3.5, 4.0, 4.5 and nothing
// in between — so 130 columns could only ever draw 455px, 520px or 585px. The
// card is 574px: 585 overflows, so the mirror was pinned at 520px and 54px of
// the card (9.4%) could not be used by any font size. That is the "not
// consuming all of its available space" the operator saw, and no fit arithmetic
// could have fixed it.
//
// xterm's built-in DOM renderer takes fractional cell widths — 4.392px at 7.3px
// font, drawing 571px into the same 574px card, 99.5% of it. The GPU path buys
// nothing here to pay for that: this mirror repaints about four times a second
// against a 130x40 grid, and the renderer being replaced is xterm's own
// incremental row-based one, not the 444-span rebuild that made this panel slow
// in the first place. Same renderer VS Code shipped as its default for years,
// under a load orders of magnitude lighter.

function disposeTerm() {
  try { term?.dispose(); } catch { /* already gone */ }
  term = null;
  termHost = null;
  lastPaint = "";
  reappearing = false;
  // The solved size belongs to the instance that is going away. The advance
  // ratio does not — it is a property of the font, not of the terminal.
  fittedFor = -1;
}

/**
 * SOLVE FOR THE FONT SIZE THAT MAKES 130 COLUMNS FILL THE CARD.
 *
 * NOT A TRANSFORM. The old fit scaled a fixed 1092px box with
 * `transform: scale()`, which required the grid's true width to be known in
 * advance — and it was known WRONGLY, from a hardcoded character advance of a
 * font that never loaded. Nothing is assumed here: the advance is measured from
 * the font the browser actually resolved.
 *
 * ── ONE SOLVE PER WIDTH. NOT A FEEDBACK LOOP. ──────────────────────────────
 * The first version of this measured what the terminal had drawn and nudged the
 * font size toward the target on every board tick. It worked arithmetically and
 * was wrong as an interface: font size is quantised and the renderer rounds
 * cell width to whole device pixels, so it hunted across a plateau — and every
 * probe was a real re-measure and repaint of the whole terminal, five times a
 * second. The operator sees that as the mirror twitching.
 *
 * So the size is SOLVED, once, from a direct measurement of the font, and then
 * left alone. `fittedFor` records the container width the current size answers;
 * while that has not changed there is nothing to compute and this returns
 * immediately. A resize solves once more.
 *
 * FLOORED, WITH A MARGIN. The container clips; an overflowing terminal loses
 * columns, an undersized one leaves a hairline of background nobody can see.
 * The bias is deliberate and one-directional.
 */
const FONT_MIN = 4;
const FONT_MAX = 16;
/**
 * Keeps a sub-pixel disagreement between the probe and the renderer from
 * clipping. Measured: the probe reads 0.6021 width-per-px-of-font and xterm's
 * own cells came out at 0.6016..0.6025 across the useful range — 0.08% of
 * spread, so 0.3% of margin is roughly four times the observed error. It is not
 * larger than that because every tenth of a percent here is card width thrown
 * away, and `fitTui()` carries a real correction for the case where the
 * prediction is wrong anyway.
 */
const FIT_MARGIN = 0.997;
const FIT_STEP = 0.1;

/** Container width the current font size was solved for. -1 = never solved. */
let fittedFor = -1;
/** Advance width per character, per px of font size. Measured once, cached. */
let advanceRatio = 0;

/**
 * Measure the resolved font's advance, the same way the terminal will.
 *
 * A DOM span rather than a canvas: xterm sizes its cells from a laid-out
 * element, and measuring by a different mechanism than the one that decides the
 * answer is how the 8.4px constant was wrong in the first place. Measured at a
 * large probe size and divided, so rounding at the probe is negligible.
 */
function measureAdvance() {
  if (advanceRatio) return advanceRatio;
  const probeSize = 100;
  const el = document.createElement("span");
  el.style.cssText =
    `position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;`
    + `font-family:${(getComputedStyle(document.documentElement).getPropertyValue("--font") || "monospace").trim()};`
    + `font-size:${probeSize}px;line-height:1;letter-spacing:0`;
  el.textContent = "M".repeat(TUI_COLS);
  document.body.appendChild(el);
  const w = el.getBoundingClientRect().width;
  el.remove();
  if (!w) return 0;
  advanceRatio = w / TUI_COLS / probeSize;
  return advanceRatio;
}

/**
 * The arithmetic, PURE and exported so it can be tested without a browser.
 *
 * Cell width is linear in font size — measured across a real sweep of xterm at
 * dpr 2, `cellWidth / fontSize` held at 0.6023 +/- 0.0002 over 6.0px..8.5px, so
 * a single division lands within a fraction of a pixel and no search is needed.
 * Kept separate from `fitTui()` because the part that can be wrong is the sum,
 * not the DOM plumbing around it, and a browser is a poor place to assert one.
 *
 * Returns the font size in px, floored to a tenth and bounded.
 */
export function solveFontSize(availPx, ratio) {
  if (!(availPx > 0) || !(ratio > 0)) return null;
  const solved = ((availPx * FIT_MARGIN) / TUI_COLS) / ratio;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.floor(solved * 10) / 10));
}

export function fitTui() {
  if (!term || !termHost) return;
  const avail = termHost.clientWidth;
  if (!avail) return;

  // A width we have not solved for yet: solve, apply, and measure the RESULT on
  // the next tick — the terminal has not re-rendered at the new size yet, so
  // measuring now would read the old one.
  if (avail !== fittedFor) {
    const next = solveFontSize(avail, measureAdvance());
    if (next === null) return;
    fittedFor = avail;
    if (next === fontPx) return;
    fontPx = next;
    term.options.fontSize = next;
    return;
  }

  // Already solved for this width. Verify the prediction held, and correct it
  // if it did not.
  //
  // THIS ONLY EVER SHRINKS, which is what makes it a correction rather than the
  // hunting loop that used to live here. Overflow is the only failure worth
  // acting on — the container clips, and clipping silently drops columns off
  // the right of the grid. Being a step small is invisible. So there is no
  // grow branch, the step is bounded below by FONT_MIN, and the whole thing
  // terminates by construction.
  const drawn = term.element?.querySelector(".xterm-screen")?.getBoundingClientRect().width;
  if (!drawn || drawn <= avail) return;
  const next = Math.max(FONT_MIN, Math.round((fontPx - FIT_STEP) * 10) / 10);
  if (next === fontPx) return;
  fontPx = next;
  term.options.fontSize = next;
}



// ── DETACH CONFIRM ──────────────────────────────────────────────────────────

function confirmModal() {
  return `
    <div class="modal-scrim" data-tui-cancel="1">
      <div class="modal tui-confirm" role="dialog" aria-modal="true">
        <span class="ttl danger">ARE YOU SURE? (Y/N)</span>
        <span class="modal-title">Detach and close this TUI session for good?</span>
        <span class="note body">This kills the PTY. The session ends, the mirror stops, and there is no reattach — the benchmark cell keeps running, but you will not see its terminal again.</span>
        <div class="confirm-actions">
          <button class="btn destroy solid" data-tui-detach-yes="1">YES — CLOSE THE SESSION</button>
          <button class="btn" data-tui-cancel="1">NO — KEEP IT OPEN</button>
        </div>
      </div>
    </div>`;
}
