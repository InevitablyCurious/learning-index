// BENCH BOARD — RENDERER. Dependency-free vanilla JS (no CDN: the board must
// work offline).
//
// Render rules:
//  - null is a designed state; unobserved, unwired and zero stay distinct.
//  - Correctness and efficiency are two axes, never blended into one number.
//  - A stopped cell never implies motion.
//  - No information only on hover.

// The board is PUSHED over SSE (see connect()). There is no poll interval.

// ── formatting ───────────────────────────────────────────────────────────────

/** The single null renderer. Everything null-ish flows through here. */
export function nul(kind = "unobserved") {
  return `<span class="null">${kind}</span>`;
}

export function pct(x, digits = 0) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  return `${(x * 100).toFixed(digits)}%`;
}

export function dur(s) {
  if (s === null || s === undefined || !Number.isFinite(s)) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

export function tok(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** Escape everything that reaches the DOM. Error strings are model output. */
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/** Truncate a content id for display. Never render a full cid on stream. */
export function shortCid(cid) {
  const s = String(cid ?? "");
  if (s.length <= 18) return s;
  return `${s.slice(0, 10)}…${s.slice(-4)}`;
}

export function clip(s, n) {
  const t = String(s ?? "");
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

// ── state ────────────────────────────────────────────────────────────────────

// LIVE BINDING, exported for board-actions.js: reassigned ONLY here, by the
// stream handlers below; the action module reads it and never writes it.
export let board = null;
let lastError = null;
let consecutiveErrors = 0;

// ── THE LIVE STREAM ── pushed over SSE (EventSource reconnects by itself). The
// last good board always stays up; a dropped stream marks the top bar stale.

/** High-water mark of events this client has rendered. Resumes a reconnect. */
let eventCursor = 0;
/** The accumulated event window, mirrored from the pushed deltas. */
let eventRows = [];
const EVENT_WINDOW_CAP = 400;

// Pin grading rows (user/harness) so their chips stay filterable; the cap
// applies to the five agent kinds. Same predicate as the server-side window in
// control/board/sources/control-plane.mjs (the browser cannot import it).
function capWindow(rows, cap) {
  const pinned = [];
  const rest = [];
  for (const r of rows) (r.kind === "user" || r.kind === "harness" ? pinned : rest).push(r);
  if (rest.length <= cap) return rows;
  const kept = rest.slice(rest.length - cap);
  return [...pinned, ...kept].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

let stream = null;

// ── TUI MIRROR CELL ── which cell's terminal the mirror follows: the cell
// the strip points at (panels/cells.js activeCell), by its address
// `<run_dir>::<sequence_index>` — the key every per-cell read uses. It was the
// control-plane ledger run_id, which exists only in that process's memory: an
// ended cell, a CLI launch, or any cell after a control-plane restart had
// none, and a missing key fell back to "the newest cell" — another cell's
// terminal under this one's name. No cell, no mirror.
let selectedTuiCell = null;

/** The cell address this client's TUI subscription is keyed on, or null. */
export function tuiCell() {
  return selectedTuiCell;
}

/** A cell's address, or null when it has none. */
export function cellKey(c) {
  if (!c || typeof c.run_dir !== "string" || !c.run_dir) return null;
  if (!Number.isInteger(c.sequence_index) || c.sequence_index < 0) return null;
  return `${c.run_dir}::${c.sequence_index}`;
}

/**
 * Point the mirror at one cell (null = none). A change resubscribes, so the
 * server regroups this client under the new cell, and drops the terminal on
 * screen — it belongs to the cell being left.
 */
export function setTuiCell(key) {
  const next = key || null;
  if (next === selectedTuiCell) return;
  selectedTuiCell = next;
  if (board) board.tui = null;
  resubscribe();
}

/**
 * The subscription URL, pure and exported for tests. `tui=1` (the TUI MIRROR
 * tab is selected) opts into full terminal frames; otherwise only the mirror's
 * status is sent. `cell` keys the mirror to one cell; absent = none.
 */
export function streamUrl(cursor, wantsTui, cell) {
  const tui = wantsTui ? "&tui=1" : "";
  const key = cell ? `&cell=${encodeURIComponent(cell)}` : "";
  return `/api/stream?since=${cursor}${tui}${key}`;
}

/**
 * Reconnect the stream when the subscription changes (the TUI tab opening or
 * closing, or the mirrored cell changing). The cursor is kept, so no event is
 * replayed or skipped.
 */
export function resubscribe() {
  if (stream) {
    stream.close();
    stream = null;
  }
  connect();
}

function connect() {
  // Guarded like the boot block below: this module is also a library that panel
  // tests import under Node, where setTuiCell still runs.
  if (typeof EventSource === "undefined") return;
  // Resume from the cursor; the subscription carries the TUI tab and the cell.
  stream = new EventSource(streamUrl(eventCursor, curveTab() === "tui", selectedTuiCell));

  stream.addEventListener("board", (msg) => {
    try {
      const next = JSON.parse(msg.data);
      // Event rows live on the client; the server strips them from board frames.
      board = next;
      board.events = board.events ? { ...board.events, events: eventRows } : null;
      lastError = null;
      consecutiveErrors = 0;
      render();
    } catch (err) {
      console.error("board frame failed to parse:", err);
    }
  });

  // ── PATCH ── only the sections that changed. Merged by key, wholesale within a
  // key (each section comes from one source). null means the section is gone.
  stream.addEventListener("patch", (msg) => {
    if (!board) return; // no baseline to patch onto; the board frame comes first
    try {
      const patch = JSON.parse(msg.data);
      for (const [k, v] of Object.entries(patch)) {
        // Dotted keys are split sections (see granularSignatures); `parent.__rest`
        // carries whatever was not split out.
        if (k.includes(".")) {
          // Split at the FIRST dot only: a by_cell child is a cell address.
          const dot = k.indexOf(".");
          const parent = k.slice(0, dot);
          const child = k.slice(dot + 1);
          if (!board[parent] || typeof board[parent] !== "object") board[parent] = {};
          if (child === "__rest") {
            board[parent] = { ...board[parent], ...(v ?? {}) };
          } else if (v === null && parent === "by_cell") {
            delete board[parent][child]; // the cell left the strip
          } else {
            board[parent][child] = v;
          }
          continue;
        }
        if (k === "events") {
          // Ring metadata may change; the rows are the client's own window.
          board.events = v ? { ...v, events: eventRows } : null;
          continue;
        }
        if (k === "tui_rows") {
          // Row splice: only changed terminal rows arrive. With no frame to splice into,
          // the splice is dropped; the server sends a full frame next. A splice for
          // any cell but the selected one is late traffic from a switch: dropped.
          if (v?.cell !== selectedTuiCell) continue;
          if (!board.tui?.frame) continue;
          const frame = board.tui.frame.slice();
          for (const [i, row] of v.rows ?? []) frame[i] = row;
          board.tui = { ...board.tui, ...(v.meta ?? {}), frame };
          continue;
        }
        if (k === "tui") {
          if (v && v.cell !== undefined && v.cell !== selectedTuiCell) continue;
          board.tui = v;
          continue;
        }
        board[k] = v;
      }
      lastError = null;
      consecutiveErrors = 0;
      render();
    } catch (err) {
      console.error("patch frame failed to parse:", err);
    }
  });

  stream.addEventListener("events", (msg) => {
    try {
      const { events: fresh = [], cursor } = JSON.parse(msg.data);
      if (!fresh.length) return;
      // The ring re-based (control plane restarted): discard the window and rebuild
      // from the replayed delta rather than splicing two rings together.
      const rebased = typeof cursor === "number" && eventCursor > 0 && cursor < eventCursor;
      if (rebased) eventRows = [];
      eventRows = [...eventRows, ...fresh];
      eventRows = capWindow(eventRows, EVENT_WINDOW_CAP);
      eventCursor = fresh[fresh.length - 1].seq ?? (rebased ? 0 : eventCursor);
      if (typeof cursor === "number" && cursor > eventCursor) eventCursor = cursor;
      if (board) {
        board.events = board.events ? { ...board.events, events: eventRows } : null;
        // The feed paints itself out of band; an event frame needs no full render.
        try { paintFeed(board); } catch (err) { console.error("feed paint failed:", err); }
        try { paintBackend(); } catch (err) { console.error("backend feed paint failed:", err); }
      }
    } catch (err) {
      console.error("events frame failed to parse:", err);
    }
  });

  stream.addEventListener("error", (msg) => {
    // A server `error` frame (with a reason) vs EventSource's own transport error.
    if (msg?.data) {
      try {
        lastError = JSON.parse(msg.data).reason ?? "server reported an error";
      } catch {
        lastError = "server reported an error";
      }
    } else {
      lastError = "stream disconnected — reconnecting";
    }
    consecutiveErrors += 1;
    // EventSource reconnects on its own; the board keeps its last good state.
    render();
  });

  stream.addEventListener("open", () => {
    consecutiveErrors = 0;
    lastError = null;
  });
}

// ── render ───────────────────────────────────────────────────────────────────

import { renderTopbar, renderProvenance } from "./panels/chrome.js";
import { openReset, closeReset, isResetOpen } from "./panels/treereset.js";
import { setRouterDraft } from "./panels/routers.js";
import { isDevModeOn } from "./panels/devmode.js";
import {
  debounced,
  graderWorkerTarget,
  requireTodosOn,
  setGraderWorkerTarget,
  setRequireTodos,
} from "./panels/switches.js";
import {
  openTools,
  closeTools,
  isToolsOpen,
  toggleToolDetail,
  setToolArg,
  observeToolJobs,
} from "./panels/tools.js";
import {
  openRestore,
  closeRestore,
  clearSelection,
  isRestoreOpen,
} from "./panels/restore.js";
import { renderCurve, setCurveMetric, setCurveTab, curveTab } from "./panels/curve.js";
import { clearGatePin, fitGateCard, refitGateCard, renderWall, setGateHover, toggleGatePin } from "./panels/wall.js";
import { renderLedger, toggleBaselineRow, toggleSuperseded } from "./panels/ledger.js";
import {
  renderLive,
  paintFeed,
  paintBackend,
  toggleKind,
  clearKinds,
  setFeedTab,
  toggleBackendSource,
  toggleBackendLevel,
  clearBackendFilters,
  jumpToLive,
  feedExportText,
  feedExportLabel,
} from "./panels/live.js";
import { renderHold } from "./panels/hold.js";
import { renderCells, setSelectedCell, selectedCell, observeCellStrip, activeCell } from "./panels/cells.js";
import { renderRail } from "./panels/rail.js";
import { renderRecall } from "./panels/recall.js";
import {
  openCreate,
  closeCreate,
  isCreateOpen,
  createStep,
  createSelection,
  createForward,
  createBack,
  createModel,
  setCreateChallenge,
  setCreateKind,
  setCreateModel,
  toggleCreateCompact,
  toggleCreateConcurrency,
  setCreateConcurrencyN,
  openCellConfirm,
  setCreateQuery,
  setCreateProvider,
  setCreatePending,
  setCreateRefusal,
} from "./panels/create.js";
import { disarmStop } from "./panels/runstart.js";
import {
  askDetach, cancelDetach, isDetachConfirming, paintTui, fitTui,
} from "./panels/tui.js";
import { paintTicks, snapTicks } from "./panels/tick.js";
import { armSnapshot } from "./panels/snapshot.js";
import { setLearningView } from "./panels/learning.js";
import { renderOverlay } from "./overlay.js";
import { patch } from "./dom.js";
// Network acts live in board-actions.js; state and render stay here.
import {
  doPreviewStop,
  doCommitStop,
  doLoadRouters,
  doSaveRouterKey,
  doToggleDevMode,
  doLaunchBaseline,
  doLoadTools,
  doRunTool,
  releaseHold,
  detachTui,
  doLoadBackups,
  doArmRestore,
  doCommitRestore,
  doArmReset,
  doCommitReset,
  doPickBatch,
} from "./board-actions.js";

function render() {
  const root = document.getElementById("root");

  if (!board) {
    patch(root, `
      <div class="topbar"><span class="pulse pulse-stopped"></span>
        <span class="spacer"></span>
        <span class="chip dimchip">connecting to feed…</span></div>
      <div style="display:flex;align-items:center;justify-content:center;padding:80px 0">
        <div style="text-align:center">
          <div class="kick" style="margin-bottom:10px">no board yet</div>
          <div class="null">${esc(lastError ?? "waiting for /api/board")}</div>
        </div>
      </div>`);
    return;
  }

  // The mirror follows the cell the strip points at, selected or default.
  setTuiCell(cellKey(activeCell(board)));
  // Every panel below draws the strip's cell: the board with that cell's view
  // laid over it. The board itself carries no cell's state.
  const view = cellView(board);

  // Panel order is the board's argument: hold (a blocked run) first; the curve
  // and the gate wall side by side; the batches (their cells, their floor and
  // its ON runs); the live cell; recall; the honesty rail; provenance.
  // patch() morphs the tree in place, so scroll, focus and selection survive.
  patch(root, `
    <div class="shell">
      ${renderTopbar(view, { stale: consecutiveErrors > 0, lastError })}
      ${renderHold(view)}
      ${renderCells(view)}
      <div class="axes-row">
        ${renderCurve(view)}
        ${renderWall(view)}
      </div>
      ${renderLedger(view)}
      ${renderLive(view)}
      ${renderRecall(view)}
      ${renderRail(view)}
      ${renderProvenance(view)}
    </div>
  `);
  // The gate card is drawn invisible, measured, then placed where it fits whole.
  if (fitGateCard(document.querySelector(".gcard"))) render();

  // After the swap: the feed and overlay paint separately. Each is wrapped so a
  // throw costs that surface, never the board, and is printed.
  try { paintFeed(view); } catch (err) { console.error("feed paint failed:", err); }
  try { paintBackend(); } catch (err) { console.error("backend feed paint failed:", err); }
  try { renderOverlay(view); } catch (err) { console.error("overlay failed:", err); }
  // Tool jobs (the drawer's refresh buttons): the elapsed ticker, and the page
  // reload a successful board refresh asks for. Schedules only, never paints.
  try { observeCellStrip(); } catch (err) { console.error("cell strip observe failed:", err); }
  try { observeToolJobs(view); } catch (err) { console.error("tool-job observe failed:", err); }
  // The TUI mirror is painted by xterm.js into a data-preserve node (like the
  // feed) and sized so 130 columns fill the card.
  try { paintTui(view); } catch (err) { console.error("tui paint failed:", err); }
  // Counters animate to the value already in the markup; a throw costs motion only.
  try { paintTicks(root); } catch (err) { console.error("tick paint failed:", err); }
}

/**
 * The board as ONE CELL sees it: board-wide sections as they are, and the
 * strip's active cell's own view (board.by_cell[address] — run, live, suite,
 * learning, honesty) laid over them; `run` merges, so the board-wide model
 * and org stay. No active cell, or a cell with no view yet: those sections are
 * absent and every panel says so — never another cell's. Pure; exported for
 * tests.
 */
export function cellView(b) {
  const key = cellKey(activeCell(b));
  const own = key ? b?.by_cell?.[key] ?? null : null;
  const view = { ...b };
  for (const k of ["live", "suite", "learning"]) view[k] = own?.[k] ?? null;
  view.run = { ...(b?.run ?? {}), ...(own?.run ?? {}) };
  // The cell's transport honesty over the board-wide memory telemetry (the
  // ON-only funnel and plugin-log sources, which are not per-cell yet).
  view.honesty = { ...(b?.honesty ?? {}), ...(own?.honesty ?? {}) };
  view.cell_sources = own?.sources ?? null;
  return view;
}

/** Exported for board-actions.js — every handler repaints through this. */
export { render };

// ── interaction ── one delegated listener on `document`; elements carry
// data-* hooks, because patch() may replace nodes. Bound by the boot guard, not at
// import, so panels (and their tests) can import this module under Node.
function bindInteraction() {
  document.addEventListener("click", onClick);
  // The gate card follows the pointer and keyboard focus over the wall.
  document.addEventListener("mouseover", onGateHover);
  document.addEventListener("focusin", onGateHover);
  window.addEventListener("resize", () => { if (refitGateCard()) render(); });
  window.addEventListener("scroll", () => { if (refitGateCard()) render(); }, { passive: true });
  // Resizing changes the font size that fits 130 columns; refit while dragging.
  window.addEventListener("resize", () => { try { fitTui(); } catch { /* the board never dies for the mirror */ } });
  // Back from a background tab: put counters back on their published values.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    try { snapTicks(); } catch { /* motion is never worth a thrown board */ }
  });
  // Run-form inputs. `change` covers the selects; `input` covers typing the org.
  document.addEventListener("change", onRunSel);
  document.addEventListener("input", onRunSel);
  document.addEventListener("keydown", onKeydown);
}

/**
 * ONE ARCHIVED RUN'S PER-CELL VIEW. by_cell is built server-side for the
 * CURRENT batch only; an archived run's view exists on the board when, and
 * only when, this fetch has landed. It is cached on the client (a full board
 * frame replaces it; re-clicking re-fetches), selected on success, and on
 * failure printed and NOT selected — the board never shows a view it could
 * not fetch. Same-origin like every board read: the dashboard relays /api/*
 * to the control plane, the only process that reads run files.
 */
async function fetchRunView(card, key) {
  const url =
    `/api/run-view?run_dir=${encodeURIComponent(card.run_dir)}` +
    `&sequence_index=${encodeURIComponent(card.sequence_index)}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || data?.ok !== true || !data.view) {
      console.error("run-view fetch failed:", data?.reason ?? `HTTP ${res.status}`);
      return;
    }
    if (!board.by_cell || typeof board.by_cell !== "object") board.by_cell = {};
    board.by_cell[key] = data.view;
    setSelectedCell(key);
    render();
  } catch (err) {
    console.error("run-view fetch failed:", err);
  }
}

function onClick(e) {
  const t = e.target.closest("[data-metric],[data-gate-id],[data-curve-tab],[data-learn-view],[data-kind],[data-clearkinds],[data-feedtab],[data-bsource],[data-blevel],[data-bclear],#evjump,[data-tui-detach],[data-tui-detach-yes],[data-tui-cancel],[data-hold-release],[data-create-open],[data-create-cancel],[data-create-scrim],[data-create-next],[data-create-back],[data-create-kind],[data-create-challenge],[data-create-model],[data-create-compact],[data-create-concurrency],[data-create-baseline-continue],[data-create-accept],[data-baseline-expand],[data-superseded-toggle],[data-run-baseline],[data-batch-pick],[data-feed-copy],[data-reset-open],[data-reset-confirm],[data-reset-cancel],[data-reset-scrim],[data-restore-open],[data-restore-pick],[data-restore-confirm],[data-restore-back],[data-restore-cancel],[data-restore-scrim],[data-preflight-fix],[data-tools-open],[data-tools-close],[data-tools-scrim],[data-tool-detail],[data-tool-run],[data-router-save],[data-stop-open],[data-stop-confirm],[data-stop-cancel],[data-devmode-set],[data-requiretodos-set],[data-gradertarget-set],[data-seed-pick],[data-cell-pick]");
  if (!t) return;

  if (t.dataset.gateId) {
    if (toggleGatePin(t.dataset.gateId, t.getBoundingClientRect())) render();
    return;
  }

  if (t.dataset.metric) { setCurveMetric(t.dataset.metric); render(); return; }
  // Selecting or leaving TUI MIRROR changes the subscription; other tabs don't.
  if (t.dataset.curveTab) {
    const wasTui = curveTab() === "tui";
    setCurveTab(t.dataset.curveTab);
    if (wasTui !== (curveTab() === "tui")) resubscribe();
    render();
    return;
  }
  if (t.dataset.learnView) { setLearningView(t.dataset.learnView); render(); return; }
  if (t.dataset.feedtab) { setFeedTab(t.dataset.feedtab); render(); return; }
  if (t.dataset.bsource) { toggleBackendSource(t.dataset.bsource); render(); return; }
  if (t.dataset.blevel) { toggleBackendLevel(t.dataset.blevel); render(); return; }
  if (t.dataset.bclear) { clearBackendFilters(); render(); return; }
  if (t.dataset.clearkinds) { clearKinds(); render(); return; }
  if (t.dataset.kind) { toggleKind(t.dataset.kind); render(); return; }
  if (t.id === "evjump") { jumpToLive(); return; }
  // The terminal frame is withheld unless asked for, so this reconnects with tui=1.
  if (t.hasAttribute("data-tui-detach")) { askDetach(); render(); return; }
  if (t.hasAttribute("data-tui-detach-yes")) { void detachTui(); return; }
  if (t.hasAttribute("data-tui-cancel")) { cancelDetach(); render(); return; }
  if (t.hasAttribute("data-hold-release")) { void releaseHold(); return; }

  // ── [+ BASELINE] ── pure selection held in panels/create.js; only launch
  // reaches the network.
  if (t.hasAttribute("data-create-open")) { openCreate(); render(); return; }
  // The scrim closes the flow only when the scrim itself was clicked.
  if (
    t.hasAttribute("data-create-cancel")
    || (t.hasAttribute("data-create-scrim") && e.target === t)
  ) { closeCreate(); render(); return; }
  // Dev mode (the server's answer) decides whether the seed step is in the sequence.
  if (t.hasAttribute("data-create-next")) { createForward(isDevModeOn(board)); render(); return; }
  if (t.hasAttribute("data-create-back")) { createBack(isDevModeOn(board)); render(); return; }

  // Arm or disarm a snapshot; the empty value (build from scratch) disarms.
  if (t.hasAttribute("data-seed-pick")) {
    const id = t.getAttribute("data-seed-pick") || null;
    armSnapshot(id, createModel());
    render();
    return;
  }
  if (t.dataset.createChallenge) {
    setCreateChallenge(t.dataset.createChallenge);
    render();
    return;
  }

  if (t.dataset.createKind) { setCreateKind(t.dataset.createKind); render(); return; }
  if (t.dataset.createModel) { setCreateModel(t.dataset.createModel); render(); return; }
  // Flip away from what is currently shown.
  if (t.dataset.createCompact) { toggleCreateCompact(t.dataset.createCompact === "on"); render(); return; }
  if (t.dataset.createConcurrency) { toggleCreateConcurrency(); render(); return; }
  if (t.hasAttribute("data-create-baseline-continue")) {
    // Runs preflight, preview and start; results land on BASELINE · 4.
    void doLaunchBaseline();
    return;
  }

  // ── PREFLIGHT REFUSED → THE TOOL THAT FIXES IT ── the create dialog closes
  // first (it would render over the drawer); nothing in it is left to decide.
  if (t.dataset.preflightFix) {
    closeCreate();
    openTools({ focus: t.dataset.preflightFix, reason: t.dataset.preflightFixWhy || null });
    render();
    void doLoadTools();
    void doLoadRouters();
    return;
  }

  if (t.hasAttribute("data-tools-open")) {
    if (isToolsOpen()) { closeTools(render); render(); return; }
    // Opening loads the registry immediately.
    openTools();
    render();
    // Load both registries; the drawer shows tools and router keys.
    void doLoadTools();
    void doLoadRouters();
    return;
  }
  if (t.hasAttribute("data-tools-close") || (t.hasAttribute("data-tools-scrim") && e.target === t)) {
    closeTools(render);
    render();
    return;
  }
  if (t.dataset.toolDetail) { toggleToolDetail(t.dataset.toolDetail); render(); return; }
  if (t.dataset.toolRun) {
    // A tool has side effects: a double-click would be two runs.
    if (debounced(`tool:${t.dataset.toolRun}`)) return;
    void doRunTool(t.dataset.toolRun);
    return;
  }

  if (t.dataset.routerSave) { void doSaveRouterKey(t.dataset.routerSave); return; }

  // REQUIRE TODOS — a preference for this browser, sent with the next launch.

  // Debounced: a switch is a thing people double-tap.

  // MACHINE SHARE — how much of the grading machine to use. Changes how long
  // grading takes, never what it reports. Sent with the next launch.
  if (t.dataset.gradertargetSet) {
    if (debounced("gradertarget")) return;
    setGraderWorkerTarget(Number(t.dataset.gradertargetSet));
    render();
    return;
  }

  if (t.dataset.requiretodosSet) {

    if (debounced("requiretodos")) return;

    setRequireTodos(t.dataset.requiretodosSet === "on");

    render();

    return;

  }


  if (t.dataset.devmodeSet) {


    // Debounced like the switches above.





    if (debounced("devmode")) return; void doToggleDevMode(t.dataset.devmodeSet); return; }

  // ── STOP ── preview, then confirm.
  if (t.hasAttribute("data-stop-open")) { void doPreviewStop(); return; }
  if (t.hasAttribute("data-stop-cancel")) { disarmStop(); render(); return; }
  if (t.hasAttribute("data-stop-confirm")) { void doCommitStop(); return; }

  // ── RESTORE ── opening loads the list immediately.
  if (t.hasAttribute("data-restore-open")) { openRestore(); render(); void doLoadBackups(); return; }
  if (t.dataset.restorePick) { void doArmRestore(t.dataset.restorePick); return; }
  if (t.hasAttribute("data-restore-confirm")) { void doCommitRestore(); return; }
  if (t.hasAttribute("data-restore-back")) { clearSelection(); render(); return; }
  if (t.hasAttribute("data-restore-cancel") || (t.hasAttribute("data-restore-scrim") && e.target === t)) {
    closeRestore();
    render();
    return;
  }

  if (t.hasAttribute("data-reset-open")) { openReset(); render(); void doArmReset(); return; }
  if (t.hasAttribute("data-reset-confirm")) { void doCommitReset(); return; }
  if (t.hasAttribute("data-reset-cancel") || (t.hasAttribute("data-reset-scrim") && e.target === t)) {
    closeReset();
    render();
    return;
  }

  if (t.dataset.runBaseline) {
    // [+ run] is the ON arm: model and substrate come off the baseline row, and it
    // enters the same confirm frame as a baseline, so its compaction setting is
    // visible. The org is never guessed.
    openCellConfirm({
      model: t.dataset.runModel,
      kind: t.dataset.runKind,
      arm: "on",
    });
    render();
    return;
  }
  // ── BATCH ── the operator's floor pick, on a cell row inside the BASELINES
  // drawer: [pick] stores one scored cell with its signed deviation from the
  // median. The run_dir rides on the button as a companion attribute, like
  // model/kind ride on [+ run].
  if (t.dataset.batchPick) { void doPickBatch(t.dataset.batchDir, Number(t.dataset.batchPick)); return; }
  // ── RUN STRIP ── which run the board is about, selected by its cell address
  // (`<run_dir>::<seq>`), so an ARCHIVED run selects like any other. Local view
  // state plus one read: it starts nothing and picks no floor (that is
  // [data-batch-pick] above). An archived run's per-cell view is not on the
  // board until this click fetches it; a current cell is already in by_cell.
  // Clicking the selected card again clears back to "follow the live cell", so
  // the strip is never a state the operator is stuck in. A void run selects
  // like any other — it is where they find out why it died.
  if (t.dataset.cellPick !== undefined) {
    const key = t.dataset.cellPick;
    if (selectedCell() === key) {
      setSelectedCell(null);
      render();
      return;
    }
    const card = (board?.runs?.list ?? []).find((c) => cellKey(c) === key);
    // The card left the board between render and click: nothing to select.
    if (!card) return;
    if (card.archived && !board?.by_cell?.[key]) {
      void fetchRunView(card, key);
      return;
    }
    setSelectedCell(key);
    // The mirror follows on render (setTuiCell from activeCell): one click,
    // one subject.
    render();
    return;
  }
  // ── BASELINES CARD ── checked after the buttons inside rows, so [+ run] never
  // also toggles its row. A row expands; which cell the page shows is the cell
  // strip's job alone.
  if (t.dataset.supersededToggle) { toggleSuperseded(); render(); return; }
  if (t.dataset.baselineExpand) {
    toggleBaselineRow(t.dataset.baselineExpand);
    render();
    return;
  }
  // ── COPY RAW EVENTS ── success and failure are written into the card; the
  // clipboard gives no feedback of its own.
  if (t.hasAttribute("data-feed-copy")) {
    const note = document.getElementById("feed-copy-note");
    const say = (msg) => { if (note) note.textContent = msg; };
    try {
      const text = feedExportText(board);
      if (!text) { say("nothing to copy — the feed is empty."); return; }
      navigator.clipboard.writeText(text)
        .then(() => say(`copied — ${feedExportLabel(board)}`))
        .catch((err) => say(`copy refused by the browser — ${String(err?.message ?? err)}`));
    } catch (err) {
      say(`copy failed — ${String(err?.message ?? err)}`);
    }
    return;
  }
}

function onRunSel(e) {
  // Inputs re-render on every keystroke; patch() keeps the node, so half-typed
  // values and the caret survive.
  const ta = e.target.closest("[data-tool-arg]");
  if (ta) { setToolArg(ta.dataset.toolArg, ta.dataset.argName, e.target.value); return; }
  // Same for a half-typed API key.
  const ri = e.target.closest("[data-router-input]");
  if (ri) { setRouterDraft(ri.dataset.routerInput, e.target.value); return; }
  // The TUI cell selector is a change, never a keystroke: resubscribe at once.
  if (e.target.closest("[data-create-query]")) { setCreateQuery(e.target.value); render(); return; }
  if (e.target.closest("[data-create-provider]")) { setCreateProvider(e.target.value); render(); }
  if (e.target.closest("[data-create-concurrency-n]")) { setCreateConcurrencyN(e.target.value); render(); return; }
}

function onGateHover(e) {
  const cell = e.target?.closest?.("[data-gate-id]");
  const overCard = e.target?.closest?.(".gcard");
  if (overCard) return;
  const redraw = cell
    ? setGateHover(cell.dataset.gateId, cell.getBoundingClientRect())
    : setGateHover(null, null);
  if (redraw) render();
}

function onKeydown(e) {
  if (e.key !== "Escape") return;
  // A pinned gate card is the smallest thing on screen that escape can close.
  if (clearGatePin()) { render(); return; }
  // Escape closes what is on top: this order mirrors the overlay's paint order.
  if (isResetOpen()) { closeReset(); render(); return; }
  if (isRestoreOpen()) { closeRestore(); render(); return; }
  // Escape closes the whole flow; back is the on-frame control.
  if (isCreateOpen()) { closeCreate(); render(); return; }
  if (isDetachConfirming()) { cancelDetach(); render(); return; }
  // The drawer is the bottom of the stack.
  if (isToolsOpen()) { closeTools(render); render(); }
}

/**
 * Can the board act right now? Every control request is same-origin: the
 * dashboard relays it to the control plane on this machine's loopback. So the
 * only question is whether the dashboard's last read of the control plane
 * succeeded — `board.control` is rebuilt every tick and is null when it failed.
 * One answer, used by every control path, so no two buttons disagree.
 */
export function controlReachability(b) {
  if (b?.control) return { ok: true, code: null, reason: null };
  const src = (b?.sources ?? []).find((x) => x.id === "control-plane");
  return {
    ok: false,
    code: "control_plane_unreachable",
    reason: src?.reason ?? "the control plane is not running, or the dashboard was started without it.",
  };
}

// First paint, then the stream, so the board is never blank while it connects.
// Guarded on document/EventSource because this module is also a library that
// panel tests import under Node.
if (typeof document !== "undefined" && typeof EventSource !== "undefined") {
  bindInteraction();
  render();
  connect();
}
