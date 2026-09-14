// ─────────────────────────────────────────────────────────────────────────────
// BENCH BOARD v2 — RENDERER
//
// Dependency-free vanilla JS. React from a CDN would make the board a blank
// page the moment the network hiccups — on a live stream, with the whole stack
// running locally, that is an unacceptable failure mode for zero benefit.
//
// THE QUESTION THE BOARD ANSWERS: does a growing memory corpus make the SAME
// local model finish the SAME build in fewer turns, fewer tokens and less time
// — and at which ON run does that stop being true? (It asked "at what corpus
// size" until the corpus dimension was stripped — see sources/stack-ledger.mjs.)
//
// RENDER RULES:
//  - null is a designed state. Three kinds of nothing stay visually distinct:
//      unobserved  — not measured yet
//      unwired     — the source that would carry it is not connected
//      zero        — measured, and the answer is 0 (a real result)
//  - CORRECTNESS and EFFICIENCY are two axes, never blended. Nothing anywhere
//    combines them into one number.
//  - A stopped cell must never imply motion.
//  - No hover-dependent information.
// ─────────────────────────────────────────────────────────────────────────────

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

// ── THE LIVE STREAM ──────────────────────────────────────────────────────────
//
// The board was refetching /api/board every 2 seconds — 240KB per poll, of
// which 82% was 400 event rows that had not changed. It is now PUSHED: the
// server assembles once for all clients and sends a board frame only when the
// board actually changed, plus event rows newer than this client's cursor.
//
// SSE rather than a raw WebSocket, deliberately — see the rationale block in
// server.mjs. The property that matters here: EventSource reconnects by itself
// with backoff, so a control-plane restart mid-run does not leave a dark board
// and there is no hand-rolled retry loop to get wrong.
//
// THE LAST GOOD BOARD ALWAYS STAYS UP. A dropped stream marks the feed stale in
// the top bar; it never blanks the screen. Staleness is information.

/** High-water mark of events this client has rendered. Resumes a reconnect. */
let eventCursor = 0;
/** The accumulated event window, mirrored from the pushed deltas. */
let eventRows = [];
const EVENT_WINDOW_CAP = 400;

// Pin grading rows (user/harness): their chips count the whole ring, so they
// must survive the window cap to stay filterable. The cap applies only to the
// five agent kinds (tool/file/thinking/error/lifecycle).
//
// This MIRRORS the source-side helper in sources/control-plane.mjs, which pins
// the same rows in the server's window. It is inlined because board.js runs in
// the browser and must not import server-side source modules; the predicate
// must stay identical in both layers.
function capWindow(rows, cap) {
  const pinned = [];
  const rest = [];
  for (const r of rows) (r.kind === "user" || r.kind === "harness" ? pinned : rest).push(r);
  if (rest.length <= cap) return rows;
  const kept = rest.slice(rest.length - cap);
  return [...pinned, ...kept].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

let stream = null;

/**
 * Reconnect the stream.
 *
 * Used when the client's SUBSCRIPTION changes — today that is only the TUI
 * popout opening or closing, which changes whether the server should spend
 * 12.4KB per tick sending terminal frames. The cursor is preserved, so no
 * event is replayed or skipped across the reconnect.
 */
export function resubscribe() {
  if (stream) {
    stream.close();
    stream = null;
  }
  connect();
}

function connect() {
  // A reconnect resumes FROM THE CURSOR, so the server replays only what was
  // missed rather than the whole ring. `tui=1` opts into full terminal frames;
  // without it the server sends the mirror's STATUS only, which is all the
  // other two tabs of the curve card ever need.
  //
  // THE TAB IS THE SUBSCRIPTION. This used to read the TUI dock's expanded
  // flag; the dock is gone and the mirror is a tab on the transfer-curve card,
  // so the same 12.4KB-per-tick decision is now made by which tab is selected.
  const wantsTui = curveTab() === "tui" ? "&tui=1" : "";
  stream = new EventSource(`/api/stream?since=${eventCursor}${wantsTui}`);

  stream.addEventListener("board", (msg) => {
    try {
      const next = JSON.parse(msg.data);
      // Event rows live on the client and are merged in below — the server
      // deliberately strips them from the board frame so an unchanged ring is
      // never re-sent. Re-attach the local window before rendering.
      board = next;
      board.events = board.events ? { ...board.events, events: eventRows } : null;
      lastError = null;
      consecutiveErrors = 0;
      render();
    } catch (err) {
      console.error("board frame failed to parse:", err);
    }
  });

  // ── PATCH: ONLY THE SECTIONS THAT CHANGED ──────────────────────────────
  // The server digests each top-level key independently and sends only the
  // ones that moved. A ticking `run.elapsed_s` therefore costs ~486 bytes
  // instead of re-sending the 12.4KB TUI screen sitting beside it.
  //
  // MERGE IS BY KEY AND WHOLESALE WITHIN A KEY. Each section is published by
  // exactly one source and is internally consistent, so a deep merge would
  // risk splicing two assemblies together — a half-old `stack` is a lie in a
  // way a whole-old one is not. `null` means the section is GONE and is
  // assigned as null, never skipped: a panel must not keep rendering state the
  // server no longer has.
  stream.addEventListener("patch", (msg) => {
    if (!board) return; // no baseline to patch onto; the board frame comes first
    try {
      const patch = JSON.parse(msg.data);
      for (const [k, v] of Object.entries(patch)) {
        // DOTTED KEYS ARE SPLIT SECTIONS. `control` is 6.5KB of mostly-static
        // capabilities and roster wrapped around a clock that ticks every 2s,
        // so the server digests its children separately and sends only the one
        // that moved (server.mjs granularSignatures). `parent.__rest` carries
        // whatever was not split out, so no field can vanish from the wire.
        if (k.includes(".")) {
          const [parent, child] = k.split(".");
          if (!board[parent] || typeof board[parent] !== "object") board[parent] = {};
          if (child === "__rest") {
            board[parent] = { ...board[parent], ...(v ?? {}) };
          } else {
            board[parent][child] = v;
          }
          continue;
        }
        if (k === "events") {
          // The ring's METADATA may change (counts, connected, grading) while
          // the ROWS are owned by the client's own accumulated window.
          board.events = v ? { ...v, events: eventRows } : null;
          continue;
        }
        if (k === "tui_rows") {
          // ROW SPLICE. The server sends only the terminal rows that changed,
          // addressed by index, because re-sending the whole 36KB screen at
          // 250ms cost 2.8MB per 20s — an unacceptable price for low latency.
          //
          // A splice with no frame to splice into is DISCARDED, not applied to
          // an empty grid: a partial screen rendered as if it were whole is a
          // lie about what the terminal shows. The server sends a full frame
          // whenever it has no diff base, so the next tick recovers.
          if (!board.tui?.frame) continue;
          const frame = board.tui.frame.slice();
          for (const [i, row] of v.rows ?? []) frame[i] = row;
          board.tui = { ...board.tui, ...(v.meta ?? {}), frame };
          continue;
        }
        if (k === "tui") {
          // A WITHHELD FRAME MUST NOT ERASE THE ONE ON SCREEN. The server drops
          // the 12.4KB terminal frame for a client that has not subscribed, and
          // assigning that null over a good frame would blank a live mirror.
          board.tui = v?.frame_withheld && board.tui?.frame ? { ...v, frame: board.tui.frame } : v;
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
      // THE RING RE-BASED. `cursor` is the ring's monotonic seq counter; it falls
      // below this client's high-water mark only when the control plane restarted
      // and rebuilt its ring at seq 0. Appending the fresh delta under the old
      // ring's stale rows would splice two rings together, so the accumulated
      // window is discarded and rebuilt from the replayed delta.
      const rebased = typeof cursor === "number" && eventCursor > 0 && cursor < eventCursor;
      if (rebased) eventRows = [];
      eventRows = [...eventRows, ...fresh];
      eventRows = capWindow(eventRows, EVENT_WINDOW_CAP);
      eventCursor = fresh[fresh.length - 1].seq ?? (rebased ? 0 : eventCursor);
      if (typeof cursor === "number" && cursor > eventCursor) eventCursor = cursor;
      if (board) {
        board.events = board.events ? { ...board.events, events: eventRows } : null;
        // The feed paints itself out of band (append-only, scroll-compensated),
        // so a pure event frame does not need a whole-board render.
        try { paintFeed(board); } catch (err) { console.error("feed paint failed:", err); }
        try { paintBackend(); } catch (err) { console.error("backend feed paint failed:", err); }
      }
    } catch (err) {
      console.error("events frame failed to parse:", err);
    }
  });

  stream.addEventListener("error", (msg) => {
    // Two different things arrive here: a server-sent `error` frame carrying a
    // reason, and EventSource's own transport error which carries none. They
    // are diagnosed differently and must not be conflated.
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
    // EventSource reconnects on its own. The board keeps its last good state
    // and the top bar says the feed is stale.
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
  recordAtChunkEndOn,
  requireTodosOn,
  setGraderWorkerTarget,
  setRecordAtChunkEnd,
  setRequireTodos,
} from "./panels/switches.js";
import {
  openTools,
  closeTools,
  isToolsOpen,
  toggleToolDetail,
  setToolArg,
} from "./panels/tools.js";
import {
  openRestore,
  closeRestore,
  clearSelection,
  isRestoreOpen,
} from "./panels/restore.js";
import { renderCurve, setCurveMetric, setCurveTab, curveTab } from "./panels/curve.js";
import { renderWall } from "./panels/wall.js";
import { renderLedger, toggleBaselineRow } from "./panels/ledger.js";
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
  clearHistoricalRun,
  historicalSelection,
} from "./panels/live.js";
import { renderHold } from "./panels/hold.js";
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
  setCreateKind,
  setCreateModel,
  toggleCreateCompact,
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
import { renderResults } from "./panels/results.js";
import { paintTicks, snapTicks } from "./panels/tick.js";
import { armSnapshot } from "./panels/snapshot.js";
import { setLearningView } from "./panels/learning.js";
import { togglePopout } from "./panels/popout.js";
import { renderOverlay } from "./overlay.js";
import { patch } from "./dom.js";
// The 16 network handlers live in board-actions.js (LI-14): state + render
// stay here, the acts that reach the control plane are dispatched by onClick.
import {
  doPreviewStop,
  doCommitStop,
  doLoadRouters,
  doSaveRouterKey,
  doToggleDevMode,
  doLaunchBaseline,
  doLoadTools,
  doRunTool,
  pointFeedAt,
  releaseHold,
  detachTui,
  doLoadBackups,
  doArmRestore,
  doCommitRestore,
  doArmReset,
  doCommitReset,
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

  // PANEL ORDER IS THE ARGUMENT THE BOARD MAKES:
  //   hold first  — a blocked run outranks everything, in the operator's face
  //   curve|wall  — the two axes, adjacent and equal, 50/50
  //   ledger      — every measured floor with its ON runs nested inside; both
  //                 axes restated. A floor's own frozen event and backend feeds
  //                 open INSIDE its row, so the record of a concluded cell is
  //                 read where the measurement it belongs to is read.
  //   live        — the running cell's pulse
  //   recall      — proof retrieval fires, demoted
  //   rail        — the honesty that buys credibility for all of the above
  //   provenance  — what a skeptic checks first
  //
  //   (below the argument, last in the shell: `results` — the
  //   durable ledger of completed cells from PAST runs, accumulated across
  //   resets (WO-43). It is history, not part of the live-run argument.)
  //
  // PATCHED, NOT REPLACED. This was `root.innerHTML = ...`, which rebuilt every
  // node on the board twice a second and destroyed scroll position, focus, the
  // caret and any live text selection along with them — the board could not be
  // read or navigated while a run was in flight. `patch()` morphs the existing
  // tree in place, so an unchanged panel is untouched and only real changes
  // reach the DOM. See dom.js.
  patch(root, `
    <div class="shell">
      ${renderTopbar(board, { stale: consecutiveErrors > 0, lastError })}
      ${renderHold(board)}
      <div class="axes-row">
        ${renderCurve(board)}
        ${renderWall(board)}
      </div>
      ${renderLedger(board)}
      ${renderLive(board)}
      ${renderRecall(board)}
      ${renderRail(board)}
      ${renderProvenance(board)}
      ${renderResults(board)}
    </div>
  `);

  // AFTER the swap: the feed is append-only and stateful, so it paints into the
  // fresh container rather than being rebuilt by the string above.
  // OVERLAY (modals) lives outside #root and survives the swap, so an open
  // dialog is not torn down by the poll.
  //
  // EACH IS WRAPPED: the board is the thing that must never go dark. A throw
  // in any one of these costs that surface, never the board — and the failure
  // is printed, never swallowed.
  try { paintFeed(board); } catch (err) { console.error("feed paint failed:", err); }
  try { paintBackend(); } catch (err) { console.error("backend feed paint failed:", err); }
  try { renderOverlay(board); } catch (err) { console.error("overlay failed:", err); }
  // The TUI mirror is painted by xterm.js into a `data-preserve` node, the same
  // out-of-band arrangement the event feed uses: the panel emits the container,
  // the renderer owns what is inside it. It also solves for the font size that
  // makes 130 columns fill the card — a render string cannot know the card's
  // width. No-ops when the mirror's tab is not selected.
  try { paintTui(board); } catch (err) { console.error("tui paint failed:", err); }
  // Live counters climb to their new reading and float what was spent. The
  // VALUE is already correct in the markup — this only animates the journey to
  // it, so a throw here costs motion and never a number.
  try { paintTicks(root); } catch (err) { console.error("tick paint failed:", err); }
}

/** Exported for board-actions.js — every handler repaints through this. */
export { render };

// ── interaction ──────────────────────────────────────────────────────────────
// ONE DELEGATED LISTENER, bound to `document` and never to a rendered node.
// All interactive elements carry data-* hooks instead of bound handlers.
//
// This is still required after the move to morphing. patch() reuses nodes where
// it can, but it REPLACES any node whose tag changed and removes any node that
// left the tree — a handler bound directly to one of those would be silently
// lost. Delegation is invariant to how the tree is updated.
//
// BOUND BY THE BOOT GUARD, NOT AT MODULE SCOPE. These three listeners used to
// run on import, which broke this module's OWN documented library/entry-point
// split (see the guard at the foot of the file): board.js exports esc/nul/clip/
// tok/dur, so every panel imports it — and any test that imports a panel
// executed `document.addEventListener` under Node and threw
// `ReferenceError: document is not defined` before a single assertion ran.
// The condition was latent only because no test had yet imported a panel
// module. Binding here keeps the behaviour identical in a browser and makes the
// module importable everywhere else, which is what the guard already claimed.
function bindInteraction() {
  document.addEventListener("click", onClick);
  // A resized window changes the card's width and therefore the font size that
  // makes 130 columns fit. The poll would correct it within half a second
  // anyway; this makes the drag itself smooth rather than steppy.
  window.addEventListener("resize", () => { try { fitTui(); } catch { /* the board never dies for the mirror */ } });
  // Returning from a background tab: the browser cancelled any counter frames
  // that were in flight, so every counter is put back onto its published value
  // rather than the frame it stopped on. See panels/tick.js.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    try { snapTicks(); } catch { /* motion is never worth a thrown board */ }
  });
  // Run-form inputs. `change` covers the selects; `input` covers typing the org.
  document.addEventListener("change", onRunSel);
  document.addEventListener("input", onRunSel);
  document.addEventListener("keydown", onKeydown);
}

function onClick(e) {
  const t = e.target.closest("[data-metric],[data-curve-tab],[data-learn-view],[data-kind],[data-clearkinds],[data-feedtab],[data-bsource],[data-blevel],[data-bclear],#evjump,[data-tui-detach],[data-tui-detach-yes],[data-tui-cancel],[data-hold-release],[data-create-open],[data-create-cancel],[data-create-scrim],[data-create-next],[data-create-back],[data-create-kind],[data-create-model],[data-create-compact],[data-create-baseline-continue],[data-create-accept],[data-baseline-expand],[data-run-baseline],[data-feed-run],[data-feed-clear],[data-feed-live],[data-feed-copy],[data-pop-toggle],[data-pop-view],[data-reset-open],[data-reset-confirm],[data-reset-cancel],[data-reset-scrim],[data-restore-open],[data-restore-pick],[data-restore-confirm],[data-restore-back],[data-restore-cancel],[data-restore-scrim],[data-preflight-fix],[data-tools-open],[data-tools-close],[data-tools-scrim],[data-tool-detail],[data-tool-run],[data-router-save],[data-stop-open],[data-stop-confirm],[data-stop-cancel],[data-devmode-set],[data-requiretodos-set],[data-recordchunk-set],[data-gradertarget-set],[data-seed-pick]");
  if (!t) return;

  if (t.dataset.metric) { setCurveMetric(t.dataset.metric); render(); return; }
  // Selecting or leaving TUI MIRROR changes what this client is subscribed to,
  // so the tab switch reconnects the stream exactly as expanding the old dock
  // did. Every other tab switch is view-only and must NOT reconnect.
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
  // TOGGLING THE TUI CHANGES THE SUBSCRIPTION, not just the view. The terminal
  // frame is 12.4KB per tick and is withheld by the server unless this client
  // asked for it, so opening the popout must re-open the stream with `tui=1`.
  // The cursor survives the reconnect, so no event is replayed or skipped.
  if (t.hasAttribute("data-tui-detach")) { askDetach(); render(); return; }
  if (t.hasAttribute("data-tui-detach-yes")) { void detachTui(); return; }
  if (t.hasAttribute("data-tui-cancel")) { cancelDetach(); render(); return; }
  if (t.hasAttribute("data-hold-release")) { void releaseHold(); return; }

  // ── THE [+ BASELINE] FLOW ─────────────────────────────────────────────────
  //
  // One entry, then a chooser and two three-step sequences (panels/create.js).
  // Every step below is pure selection held in that module — only the two
  // handlers at the end of each branch reach the network.
  if (t.hasAttribute("data-create-open")) { openCreate(); render(); return; }
  // The scrim closes the flow, but ONLY when the scrim ITSELF was clicked — a
  // click that lands inside the dialog also bubbles through it.
  if (
    t.hasAttribute("data-create-cancel")
    || (t.hasAttribute("data-create-scrim") && e.target === t)
  ) { closeCreate(); render(); return; }
  // DEV MODE DECIDES WHETHER THE SEED STEP IS IN THE SEQUENCE, so the mode has
  // to reach the step machine. It is read from the SERVER's answer on the board
  // payload — the control plane refuses to arm a snapshot when the mode is off,
  // and a board that walked an operator into that step anyway would be walking
  // them into a dead end.
  if (t.hasAttribute("data-create-next")) { createForward(isDevModeOn(board)); render(); return; }
  if (t.hasAttribute("data-create-back")) { createBack(isDevModeOn(board)); render(); return; }

  // ARM OR DISARM A BUILD SNAPSHOT. An empty value is the "build from scratch"
  // row, which disarms — expressed as the same control as picking one, because
  // it is the same kind of choice and must not be harder to make.
  if (t.hasAttribute("data-seed-pick")) {
    const id = t.getAttribute("data-seed-pick") || null;
    armSnapshot(board?.control?.base_url, id, createModel());
    render();
    return;
  }
  if (t.dataset.createKind) { setCreateKind(t.dataset.createKind); render(); return; }
  if (t.dataset.createModel) { setCreateModel(t.dataset.createModel); render(); return; }
  // The row carries what is CURRENTLY shown, so the first click flips away from
  // the state the operator can see rather than from the tri-state's null.
  if (t.dataset.createCompact) { toggleCreateCompact(t.dataset.createCompact === "on"); render(); return; }
  if (t.hasAttribute("data-create-baseline-continue")) {
    // START ACTUALLY STARTS. The sequence's own three frames are the
    // confirmation; this runs preflight, then the server's preview and start,
    // and paints the result as it arrives on BASELINE · 4.
    void doLaunchBaseline();
    return;
  }

  // ── RESET ALL BENCHMARK DATA ────────────────────────────────────────────
  // Opening the modal ALSO asks the server what a reset would move, so the
  // question and the actual list appear together rather than the operator being
  // asked to agree first and shown the consequences second.
  //
  // The scrim only closes when the scrim ITSELF was clicked; a click that
  // bubbled out of the dialog must never dismiss the question.
  // ── CUSTOM TOOLS DRAWER ─────────────────────────────────────────────────
  // The scrim closes only when the scrim ITSELF was clicked; a click that
  // bubbled out of the drawer must never dismiss it.
  // ── PREFLIGHT REFUSED -> THE BUTTON THAT FIXES IT ───────────────────────
  //
  // The launch checklist names the tool; this walks the operator to it. The
  // create dialog is CLOSED first, not left underneath: the overlay ranks every
  // dialog above the drawer (a dialog holds a decision), so an open BASELINE · 4
  // would render on top of the drawer it just sent the operator to. Closing it
  // costs nothing — preflight refused, so there is no run and nothing in that
  // dialog left to decide.
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
    // Opening loads the registry immediately — the drawer is never a shell
    // waiting for a second click to populate itself. No focus: this is the
    // hamburger, not a refusal routing the operator to one row.
    openTools();
    render();
    // BOTH REGISTRIES, because this one drawer now shows both. Only the TOOLS
    // open-state is set: `renderRoutersSection` reads the router data, not the
    // routers drawer's own open flag, so loading it here fills the section
    // without also arming the standalone routers drawer behind this one.
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
    // A tool is a command with side effects — a double-click was two runs.
    if (debounced(`tool:${t.dataset.toolRun}`)) return;
    void doRunTool(t.dataset.toolRun);
    return;
  }

  if (t.dataset.routerSave) { void doSaveRouterKey(t.dataset.routerSave); return; }

  // REQUIRE TODOS — a launch preference for THIS browser, not server state, so

  // it is written locally and rides the next launch payload. Debounced like

  // dev mode: a switch is a thing people double-tap.

  if (t.dataset.recordchunkSet) {
    if (debounced("recordchunk")) return;
    setRecordAtChunkEnd(t.dataset.recordchunkSet === "on");
    render();
    return;
  }

  // MACHINE SHARE — how much of the grading machine to use. Unlike the switches
  // around it this is NOT a measurement variable: it changes how long grading
  // takes and never what it reports (scripts/verify_worker_parity.py holds that
  // to account). Same local-preference shape: written here, sent with the next
  // launch, and the container works the count out from its own limits.
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


    // Same guard as the require-todos switch: a double-tap here would be two



    // POSTs, and the second races the poll that refreshes the first.



    if (debounced("devmode")) return; void doToggleDevMode(t.dataset.devmodeSet); return; }

  // ── STOP THE CELL IN FLIGHT ─────────────────────────────────────────────
  // Preview then confirm, like every other act with a cost.
  if (t.hasAttribute("data-stop-open")) { void doPreviewStop(); return; }
  if (t.hasAttribute("data-stop-cancel")) { disarmStop(); render(); return; }
  if (t.hasAttribute("data-stop-confirm")) { void doCommitStop(); return; }

  // ── RESTORE FROM HISTORY ────────────────────────────────────────────────
  // Opening loads the list immediately so the dialog is never a shell waiting
  // for a click to populate itself.
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
    // A run against a baseline is the ON arm. The org is NOT guessed — the
    // server requires one and the operator picks it in the run panel.
    //
    // THE MODEL AND THE SUBSTRATE COME OFF THE BASELINE ROW. An ON cell is
    // always the same model as the floor it is measured against, and it must run
    // on the substrate that floor was measured on. Reading both off the row
    // rather than defaulting to local is what makes [+ run] work on a cloud
    // baseline.
    //
    // ONE LAUNCH PATH, AND ONE CONFIRMATION. [+ run] used to jump straight to
    // the launch checklist, so an ON cell was the only cell that started without
    // the operator being shown how it was configured. It enters the same confirm
    // frame an OFF baseline does — which is where the compaction toggle lives,
    // and an ON cell whose compaction silently disagreed with its floor would
    // produce a delta measuring compaction rather than memory.
    openCellConfirm({
      model: t.dataset.runModel,
      kind: t.dataset.runKind,
      arm: "on",
    });
    render();
    return;
  }
  // ── THE BASELINES CARD ────────────────────────────────────────────────────
  // Expansion is checked AFTER the buttons that live inside the rows — [+ run]
  // must start a run, never open a drawer. Returning here is what keeps a
  // button click from also toggling the row it sits in.
  // ── CLICKING A BASELINE POINTS THE DATA FEED CARD AT IT ───────────────────
  //
  // ONE AFFORDANCE, AND IT IS THE ROW. Selecting a baseline used to be a
  // separate `[feed]` button that became `SHOWING` wired to "return to live" —
  // so the control TOGGLED, and with a record auto-opened on load, pressing the
  // button that named this row CLOSED it. The record appeared and vanished on
  // alternate clicks.
  //
  // The row already WAS a control (it opens its own drawer). It now does both:
  // expand, and point the card. It cannot un-select — clicking a row selects
  // THAT row — and the single way back to the live cell is BACK TO LIVE on the
  // card itself.
  if (t.dataset.baselineExpand) {
    toggleBaselineRow(t.dataset.baselineExpand);
    const b = (board.models_ledger?.baseline_rows ?? []).find((row) => row?.id === t.dataset.baselineExpand);
    // Paint the row state and the card's "reading…" NOW rather than after the
    // round trip — a control that shows nothing until a fetch returns reads as
    // a dead control.
    void pointFeedAt(board, b);
    render();
    return;
  }
  // ── HAND THE WHOLE RECORD SET TO WHATEVER READS IT NEXT ───────────────────
  //
  // The confirmation is written into the card rather than logged, because the
  // clipboard gives no feedback of its own and a control that appears to do
  // nothing is indistinguishable from a broken one. A FAILURE is stated the same
  // way — a denied clipboard permission is common and must not read as success.
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
  if (t.hasAttribute("data-feed-clear") || t.hasAttribute("data-feed-live")) {
    clearHistoricalRun();
    render();
    return;
  }
  // POPOUTS. The view switch is checked BEFORE the toggle: a tab click must
  // change the view, never collapse the window out from under the operator.
  if (t.dataset.popView) {
    const [id, v] = t.dataset.popView.split(":");
    if (id === "learning") setLearningView(v);
    render();
    return;
  }
  if (t.dataset.popToggle) { togglePopout(t.dataset.popToggle); render(); return; }
}

function onRunSel(e) {
  // THE CREATE FLOW'S TWO FILTERS. They are re-rendered on every keystroke, so
  // the caret would be lost if the input were rebuilt — patch() morphs the
  // existing node in place, which is what makes typing here survive the redraw.
  // Tool arguments. Values are held in the panel so a redraw cannot wipe a
  // half-typed org id; patch() morphs the input in place so the caret survives.
  const ta = e.target.closest("[data-tool-arg]");
  if (ta) { setToolArg(ta.dataset.toolArg, ta.dataset.argName, e.target.value); return; }
  // Same reason as tool arguments: a half-typed API key must survive a redraw.
  const ri = e.target.closest("[data-router-input]");
  if (ri) { setRouterDraft(ri.dataset.routerInput, e.target.value); return; }
  if (e.target.closest("[data-create-query]")) { setCreateQuery(e.target.value); render(); return; }
  if (e.target.closest("[data-create-provider]")) { setCreateProvider(e.target.value); render(); }
}

function onKeydown(e) {
  if (e.key !== "Escape") return;
  // ── THE ORDER MIRRORS THE STACK IN overlay.js ────────────────────────────
  //
  // Escape dismisses what the operator is actually LOOKING AT, so this list has
  // to match the order the overlay paints in — reset and restore render above
  // the create flow, so they are checked above it here. A mismatch would make
  // escape close a surface hidden behind the one on screen.
  if (isResetOpen()) { closeReset(); render(); return; }
  if (isRestoreOpen()) { closeRestore(); render(); return; }
  // The create flow is checked next — it is rendered above the drawer, so
  // Escape must dismiss what the operator is actually looking at.
  //
  // ESCAPE CLOSES THE WHOLE FLOW, IT DOES NOT STEP BACK. Back is a control on
  // the frame with a word on it; escape is the universal "I am done with this
  // dialog". Overloading escape as back would make a three-step sequence take
  // three escapes to leave, which is not what any operator means by it.
  if (isCreateOpen()) { closeCreate(); render(); return; }
  if (isDetachConfirming()) { cancelDetach(); render(); return; }
  // THE DRAWER IS LAST because it is the bottom of the stack — and it is here
  // at all because a surface that opens over the board and can only be closed
  // by finding a small ✕ is a surface people leave open.
  if (isToolsOpen()) { closeTools(render); render(); }
}

/** The board never posts. The browser posts DIRECTLY to the control plane. */

/**
 * CAN THIS BROWSER REACH THE CONTROL PLANE AT ALL?
 *
 * `base_url` is a loopback address, and loopback resolves to whichever machine
 * dereferences it. Browsing the board from the host, that is the host and every
 * control POST works. Browsing it from another device on the LAN — the
 * documented remote-viewing case — `127.0.0.1:7718` is THAT DEVICE, so the
 * request dies before it leaves the laptop and surfaces as a transport error
 * with no obvious cause.
 *
 * The control plane deliberately cannot be published on the LAN to fix this: it
 * binds 127.0.0.1 with no --host flag as a stated safety property
 * (control/server.mjs:23-25), because it spawns processes. The read-only board
 * may be exposed; the thing that can change the world may not.
 *
 * So the honest answer is to say so. This returns the reason a write is
 * impossible, or null when it is possible — one derivation, consumed by every
 * control path, so no button can disagree with another about whether it works.
 */
export function controlReachability(b) {
  const base = b?.control?.base_url ?? null;
  if (!base) {
    return {
      ok: false,
      code: "control_plane_unwired",
      reason: "the board does not know where the control plane is — it is not running, or the dashboard was started without it.",
      fix: null,
    };
  }
  // Only the browser knows its own origin, which is why the comparison happens
  // here and not in the source module that published the URL.
  const remote =
    b?.control?.base_url_is_loopback === true &&
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);
  if (remote) {
    return {
      ok: false,
      code: "control_plane_not_reachable_from_here",
      reason:
        `this board is open at ${location.hostname}, but the control plane is published as ${base}. ` +
        "That address means THIS device, not the bench host, so the request would never leave your machine. " +
        "The control plane binds loopback only, on purpose — it starts runs and spawns processes, so it is never exposed on a network.",
      fix:
        `ssh -L 7717:127.0.0.1:7717 -L 7718:127.0.0.1:7718 <user>@${location.hostname}\n` +
        "then open http://127.0.0.1:7717 in this browser. Both ports tunnel to the bench host's loopback, so the controls work and nothing is exposed on the network.",
    };
  }
  return { ok: true, code: null, reason: null, fix: null };
}

// FIRST PAINT, THEN THE STREAM. render() draws the "connecting to feed…" state
// immediately so the board is never a blank page while the socket opens.
//
// GUARDED BECAUSE THIS MODULE IS BOTH THE ENTRY POINT AND A LIBRARY. board.js
// exports esc/nul/clip/tok/dur, so every panel imports it — and every panel
// TEST therefore executes this file's module scope under Node, where there is
// no DOM and no EventSource. Booting unconditionally made importing a pure
// string builder throw `ReferenceError: EventSource is not defined`.
//
// The guard is a capability check, not an environment sniff: it asks whether
// the two things the boot actually needs are present. In a browser both are;
// under `node --test` neither is, and the module is then exactly what the tests
// treat it as — a library.
if (typeof document !== "undefined" && typeof EventSource !== "undefined") {
  bindInteraction();
  render();
  connect();
}
