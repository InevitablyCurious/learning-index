// PANEL: TUI MIRROR — the third tab of the transfer-curve card.
//
// The running cell's terminal (a 40×130 grid from control/tui.mjs), drawn by
// xterm.js at a font size solved so 130 columns fill the card (fitTui).
// Strictly read-only: nothing here can write to the PTY.
// Non-live states are not errors: starting (first paint ~10s), failed (verbatim
// reason), silent (attached, no output — nothing drawn moving), exited (last
// frame held and labelled). DETACH & CLOSE kills the mirror for good (the cell
// keeps running) and says so.

import { esc, nul, tuiRunId } from "../board.js";
import { renderStartupFeed, startupFeed } from "./startup.js";

/** Must match control/tui.mjs (drift-guarded). */
export const TUI_ROWS = 40;
export const TUI_COLS = 130;
// No pixel metrics here: the terminal measures its own font (fitTui).

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
 * The body of the TUI MIRROR tab. Selecting the tab is also what subscribes
 * to terminal frames (?tui=1 in board.js).
 */
export function renderTuiBody(board) {
  const t = board.tui ?? null;
  const status = t?.status ?? null;

  return `
    <div class="tui-mirror">
      ${mirrorHead(board, t)}
      ${mirrorScreen(board, t, status)}
      ${mirrorFoot(board, t, status)}
    </div>
    ${confirming ? confirmModal() : ""}`;
}

/**
 * The startup feed yields once a real frame has painted (never on a timer),
 * and comes back on failed/exited. frame_withheld does not count as painted;
 * silent counts as live.
 */
function terminalHasPainted(t, status) {
  return Boolean(t?.frame) && (status === "live" || status === "silent");
}

// ── THE TAB HEAD ── identity, the cell selector, the read-only claim, and
// DETACH & CLOSE.

function mirrorHead(board, t) {
  return `
    <div class="tui-head">
      <span class="tui-brand">▌TUI MIRROR</span>
      <span class="note">${esc(`${TUI_COLS} cols × ${TUI_ROWS} rows`)}${identLabel(t)}</span>
      ${runSelector(board)}
      <span class="tui-stat">${statusWord(t, t?.status ?? null)}</span>
      <span class="tag">READ-ONLY MIRROR — NO INPUT</span>
      <span class="spacer"></span>
      <button class="btn sm destroy" data-tui-detach="1">DETACH &amp; CLOSE</button>
    </div>`;
}

/** WHOSE terminal is on screen: the cell's run_id, and its pty session. */
function identLabel(t) {
  const run = t?.run_id ? ` · run ${String(t.run_id).slice(0, 8)}` : "";
  const pty = t?.session_id ? ` · pty ${String(t.session_id).slice(0, 8)}` : "";
  return esc(`${run}${pty}`);
}

/**
 * The operator's cell selector: WHICH live cell's terminal this mirror
 * follows. A minimal <select> keyed on run_id; the server pushes only the
 * selected cell's frames to this client (the subscription in board.js carries
 * the key), so the render stays the single board.tui — no per-run_id map here.
 * Entries with no run_id (an external launch, contract.mjs RunStateEntry) are
 * not addressable by key and are skipped. The `cprov` class is the board's one
 * styled <select>; presentation is a candidate for Walter's UX review.
 */
function runSelector(board) {
  const runs = (board?.control?.run?.runs ?? []).filter((r) => r?.run_id);
  const selected = tuiRunId() ?? "";
  return `
    <select class="cprov" data-tui-run="1" aria-label="which cell to mirror">
      <option value=""${selected === "" ? " selected" : ""}>cell — default (newest)</option>
      ${runs
        .map(
          (r) =>
            `<option value="${esc(r.run_id)}"${r.run_id === selected ? " selected" : ""}>${esc(runLabel(r))}</option>`,
        )
        .join("")}
    </select>`;
}

/** session short + model/arm when present; the run_id short as the fallback. */
function runLabel(r) {
  const parts = [
    r.session_id ? `pty ${String(r.session_id).slice(0, 8)}` : null,
    r.model ?? null,
    r.arm ?? null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : `run ${String(r.run_id).slice(0, 8)}`;
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

// ── THE SCREEN ── a plain block at the card's width; fitTui() sizes the font.

/**
 * The feed and the terminal are siblings toggled by class, never swapped in
 * one slot: the terminal host stays stable, so xterm attaches once.
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

// ── THE FOOT ── what the operator is looking at, and the blocking count.

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

/** The silent notice only; the terminal host is emitted by mirrorScreen. */
function screen(t, status) {
  return status === "silent"
    ? banner(`Attached. ${t.reason ?? "no output"} — the mirror is live and the grid is unchanged.`)
    : "";
}

function banner(text) {
  return `<div class="tui-banner">${esc(text)}</div>`;
}

// ── THE TERMINAL ── xterm.js, fed real SGR. It measures the font it is given
// and keeps colour. control/tui.mjs's own emulator is still partial (no wide
// characters, no wrap or scroll) until a raw-byte stream replaces it.

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
 * The board's palette, read from the stylesheet (xterm draws to a canvas and
 * cannot resolve custom properties). One definition of the colours.
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
 * Build the frame as terminal bytes: a full repaint, each row absolutely
 * addressed (rows arrive padded to full width). Truecolor, as the frame carries.
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

/** `#rrggbb` → an SGR truecolor parameter; anything else is no colour. */
function sgrColor(hex, base) {
  if (typeof hex !== "string") return "";
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "";
  return `\x1b[${base};2;${parseInt(m[1], 16)};${parseInt(m[2], 16)};${parseInt(m[3], 16)}m`;
}

/**
 * Attach, size and paint; called after every patch. A no-op when the host and
 * the frame are unchanged.
 */
export function paintTui(board) {
  const host = document.querySelector(".tui-term");

  // Another tab is showing: tear down and forget the last paint.
  if (!host) {
    disposeTerm();
    return;
  }

  // A hidden host (the startup feed owns the space) is a no-op: a Terminal
  // opened into a hidden node measures zero and never recovers. Coming back to
  // visible re-solves the font size and repaints in full.
  const avail = host.clientWidth;
  if (!avail) {
    reappearing = Boolean(term);
    return;
  }

  // patch() may replace the node; re-attach to the one in the document.
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
      // Read-only: no onData handler exists; these only stop it looking editable.
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

// The DOM renderer, not WebGL: WebGL rounds cells to whole device pixels, which
// left ~9% of the card unusable at every font size.

function disposeTerm() {
  try { term?.dispose(); } catch { /* already gone */ }
  term = null;
  termHost = null;
  lastPaint = "";
  reappearing = false;
  // The solved size belongs to the old instance; the advance ratio to the font.
  fittedFor = -1;
}

/**
 * Solve the font size that makes 130 columns fill the card, once per container
 * width, from a direct measurement of the font. Not a feedback loop (that
 * twitched). Floored with a margin: overflow drops columns, undersize is invisible.
 */
const FONT_MIN = 4;
const FONT_MAX = 16;
/** Margin for probe-vs-renderer error (measured ~0.08%; this is ~4×). */
const FIT_MARGIN = 0.997;
const FIT_STEP = 0.1;

/** Container width the current font size was solved for. -1 = never solved. */
let fittedFor = -1;
/** Advance width per character, per px of font size. Measured once, cached. */
let advanceRatio = 0;

/**
 * Measure the resolved font's advance with a DOM span, as xterm does, at a large
 * probe size.
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
 * Pure and exported for tests: cell width is linear in font size (ratio held at
 * 0.6023 ± 0.0002). Returns px, floored to a tenth and bounded.
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

  // New width: solve and apply; verify on the next tick, after xterm re-renders.
  if (avail !== fittedFor) {
    const next = solveFontSize(avail, measureAdvance());
    if (next === null) return;
    fittedFor = avail;
    if (next === fontPx) return;
    fontPx = next;
    term.options.fontSize = next;
    return;
  }

  // Verify the prediction; only ever shrink (overflow is the only failure that
  // matters), bounded by FONT_MIN, so it terminates.
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
