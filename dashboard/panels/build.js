// PANEL: LIVE BUILD — the rendered running game, beside the prose that graded it.
//
// The operator question this panel answers: do the grader's complaints match
// what is actually rendered? Top: the benchmark model's own backgammon app,
// booted by POST /api/play/start on a free port — for the cell in flight by the
// control plane itself (control/livebuild.mjs), for any other run when the
// operator clicks "load build" — and framed here. Below: the
// numbered "user prose" the grader fed the model in its last failing round —
// GET /api/feedback, the LAST kind:"feedback" message (kind:"chunk" is the
// initial GOAL, not "what's still wrong").
//
// ── THE RENDERED APP IS UNTRUSTED MODEL OUTPUT ──────────────────────────────
//
// The iframe carries sandbox="allow-scripts allow-same-origin" and nothing
// else — no popups, no top-navigation, no forms, no modals, no pointer-lock —
// plus referrerpolicy="no-referrer". It is built with createElement, never
// parsed from a string, so both attributes reliably exist before the first
// navigation. The prose is written with textContent, never innerHTML: it is
// derived from model interactions and may contain < and >.
//
// ── LAZY BOOT; THE TICK NEVER POSTS ─────────────────────────────────────────
//
// The framed app is untrusted model output, so the game boots ONLY on an
// explicit operator click ([data-build-load] → requestLoad → POST
// /api/play/start). A passive page load performs ZERO writes: the one
// automatic fetch is the read-only prose GET /api/feedback — the board smoke
// check blocks, and fails on, any write a page attempts. startPlay
// reaps-then-spawns: re-POSTing would kill and respawn the running game on
// every 2s tick. So paintBuild is idempotent on
// `${run_dir}::${sequence_index}` — via loadedKey (booted) and preparedKey
// (prose fetched, load affordance up): a tick whose selection did not change
// only refreshes the liveness note. All stateful work (prepare, boot, iframe,
// teardown) runs inside ONE busy-guarded sequence: `busy` is the guard the
// teardown design names first — while a sequence is in flight, ticks never
// start a second one; a failed boot leaves loadedKey unset and requestLoad
// re-offers the affordance — retry is the operator's click, never a tick.
// Endpoints are same-origin literals (the dashboard relays /api/* to
// the control plane; a panel building URLs from a stored address once blanked
// the whole board — panel-fetch-wiring.test.mjs).
//
// ── ATTEMPT TABS ────────────────────────────────────────────────────────────
//
// The strip over the viewport (1..max_attempts, then live) is skeleton, NOT
// data-preserve: patch() re-derives its active/disabled state every tick from
// the board's completed attempts and the module's activeTab. A numeric tab is
// enabled once that attempt completed; clicking it swaps the viewport to that
// attempt's stored grader screenshot (/api/screenshot) — the ONLY path that
// fires a screenshot GET, so a passive page load stays read-clean. A missing
// capture retries once, then states the absence — never another attempt's
// board, never the live view. Every run switch resets to the live tab, so the
// prepare/boot paths always paint the live viewport.
//
// ── THE SKELETON / PAINTER SPLIT ────────────────────────────────────────────
//
// renderBuild emits ONLY the static skeleton — no fetch, no iframe, no state.
// The three data-preserve="1" nodes (.build-note, .build-frame,
// .build-wrong) are painter-owned: dom.js patch() syncs their attributes
// on every morph but never touches their children, so the iframe survives the
// 2s refresh and paintBuild owns everything inside them.

import { esc } from "../board.js";
import { activeCell } from "./cells.js";
import { paintWrong, promptForTab } from "./build-prose.js";
import { setWallAttempt } from "./wall.js";

// ── state ── module-level, persists across ticks. The boot guard is
// loadedKey: play/start fires once per explicit load click, never per tick.

/** `${run_dir}::${sequence_index}` of the booted run, or null. */
let loadedKey = null;
/** `${run_dir}::${sequence_index}` of the selection already prepared — prose
 *  fetched, load affordance shown — or null. Preparation is once-per-
 *  selection: an unbooted tick only refreshes the liveness note. */
let preparedKey = null;
/** Date.now() of the successful boot; drives the liveness note. */
let bootedAt = null;
/** The card paintBuild last saw; requestLoad boots THIS selection. */
let currentCard = null;
/** A teardown→boot sequence owns the panel; ticks never start a second. */
let busy = false;
/** The live iframe element (the nested browsing context), or null. */
let iframeEl = null;
/** Last known `.build-frame` element (re-queried every paint; patch may swap nodes). */
let frameEl = null;
/** The play server's process id, from play/start. */
let pid = null;
/** The play server's port, from play/start. */
let port = null;
/** The booted game's URL (`http://localhost:<port>/`), from play/start. */
let playUrl = null;
/** Kills the sequence's in-flight fetches on teardown. */
let abort = null;
/** Interval/timeout ids owned by this panel; teardown clears every one. */
let timers = [];
/** Reserved stream slot — always null here (the game speaks over HTTP in the
 *  iframe; there is no stream). Teardown's close() call stays structural. */
let es = null;
/** The delegated document click listener is attached exactly once. */
let listenersAttached = false;
/** The selected viewport tab: "live", or an attempt number held as a STRING
 *  ("1", "2", …) so it compares cleanly against the data-build-tab attribute;
 *  numeric tabs parse where a number is needed. Reset on every run switch. */
let activeTab = "live";
/** The selection's feedback messages (kind:"feedback" only), or null before
 *  the first fetch lands, or {error} when it failed. Which one is DRAWN depends
 *  on activeTab (build-prose.promptForTab), so a tab click redraws from this
 *  with no fetch. */
let feedbackMsgs = null;
/** Completed-attempt count when feedbackMsgs was last fetched: a live run
 *  writes a new message each time an attempt is graded, so a changed count
 *  re-fetches (a read-only GET, allowed on the tick). */
let feedbackAtDone = null;
/** A feedback GET is in flight; the tick never starts a second. */
let feedbackFetching = false;
/** The board view paintBuild last saw (attempt count, cap, run state). */
let lastView = null;

// ── interaction ── ONE delegated listener, never per-tick. Bound under a
// guard (not at raw import) so Node tests can import this module; paintBuild
// re-offers the attach, and the flag makes it once-only either way.

function onBuildClick(e) {
  const t = e.target;
  if (typeof t?.closest !== "function") return;
  const tab = t.closest("[data-build-tab]");
  if (tab) {
    // Attempt/live tab: swap the viewport now, and sync every tab's active
    // class to match — the next patch() tick re-derives the same strip state
    // from activeTab, so both paths agree. A tab click is NOT a boot: it
    // never touches requestLoad, loadedKey or busy.
    if (tab.disabled !== true) {
      activeTab = tab.getAttribute("data-build-tab");
      // The gate wall follows the tab: attempt N shows the wall as it stood after
      // attempt N, and live puts the live wall back (panels/wall.js).
      setWallAttempt(currentCard, activeTab === "live" ? null : Number(activeTab));
      for (const b of document.querySelectorAll("[data-build-tab]")) {
        b.classList.toggle("active", b.getAttribute("data-build-tab") === activeTab);
      }
      paintTabViewport();
      renderWrong();
    }
    return;
  }
  if (t.closest("[data-build-fullprompt]")) {
    // Show/hide the untouched message under the split lists.
    const full = document.querySelector(".bw-full");
    full?.classList.toggle("open");
    t.closest("[data-build-fullprompt]").textContent = full?.classList.contains("open") ? "hide full prompt" : "show full prompt";
    fitProblems();
    return;
  }
  if (t.closest("[data-build-load]")) {
    // The ONLY path to POST /api/play/start: an explicit operator click.
    void requestLoad();
    return;
  }
  if (t.closest("[data-build-reload]")) {
    // Reconcile against the LIVE play registry: startPlay reaps-then-spawns on
    // a fresh port, so the cached boot-time url can go dead while the card
    // still shows the build. GET /api/play is read-only; never re-POST play/start.
    void (async () => {
      const playing = await fetchPlaying();
      if (playing?.url) {
        pid = playing.pid ?? null;
        port = playing.port ?? null;
        playUrl = playing.url;
        paintFrame(playing.url);
      } else {
        // Nothing running: drop the stale frame + boot state so "load build"
        // boots again; re-offer the pre-load affordance.
        loadedKey = null;
        bootedAt = null;
        pid = null;
        port = null;
        playUrl = null;
        paintFrameLoad();
      }
    })();
    return;
  }
  if (t.closest("[data-build-open]")) {
    void (async () => {
      const playing = await fetchPlaying();
      if (playing?.url) window.open(playing.url, "_blank", "noopener");
    })();
    return;
  }
}

/** A follow read is in flight; the tick never starts a second. */
let followBusy = false;

/** Frame the live cell's running build, and re-frame when the control plane
 *  boots a newer one (a new pid). Read-only: GET /api/play only. */
async function followLive(card, key) {
  if (followBusy || busy) return;
  followBusy = true;
  try {
    const p = await fetchPlaying();
    if (!p?.url || p.run !== card.benchmark_id || p.cell !== card.cell) return;
    if (!currentCard || `${currentCard.run_dir}::${currentCard.sequence_index}` !== key || activeTab !== "live") return;
    if (p.pid === pid && p.url === playUrl && key === loadedKey) return;
    pid = p.pid ?? null;
    port = p.port ?? null;
    playUrl = p.url;
    paintFrame(p.url);
    loadedKey = key;
    bootedAt = Date.now();
  } finally {
    followBusy = false;
  }
}

/** GET /api/play → the current running play server {pid,port,url,…}, or null.
 *  Same-origin literal (panel-fetch-wiring); read-only, cache-control no-store. */
async function fetchPlaying() {
  try {
    const res = await fetch("/api/play");
    const data = res.ok ? await res.json().catch(() => null) : null;
    return data?.playing ?? null;
  } catch {
    return null;
  }
}

function attachListeners() {
  if (listenersAttached) return;
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
  document.addEventListener("click", onBuildClick);
  listenersAttached = true;
}

attachListeners();

// ── the static skeleton ──

// The grader's render_blocked fact (control/board/sources/live-stream.mjs)
// arrives per attempt on the live overlay. The flag is view-derived skeleton
// state — a pure read of board, no fetch, and independent of activeTab: it
// always speaks for the LATEST attempt, whichever tab the viewport shows.

/** The four render_blocked reasons the grader emits, in operator-facing words. */
const RENDER_BLOCKED_LABEL = {
  "server-not-answering": "the game isn't answering",
  "state-empty": "the game starts but returns empty",
  "no-positions": "pieces show but none sits on a numbered space",
  "geometry-not-drawn": "the board geometry didn't draw",
};

/** Flag HTML for the latest attempt's render_blocked fact; "" when healthy.
 *  The labels are this file's own literals; an unknown reason is escaped.
 *  attempts is sorted ascending, so the last entry is the latest attempt. An
 *  unknown reason falls back to its raw string — stated, never swallowed. */
function renderBlockedFlag(board) {
  const attempts = board?.live?.attempts;
  if (!Array.isArray(attempts) || attempts.length === 0) return "";
  const rb = attempts[attempts.length - 1]?.render_blocked;
  if (!rb || typeof rb !== "object" || !rb.reason) return "";
  return `render blocked — ${RENDER_BLOCKED_LABEL[rb.reason] ?? esc(String(rb.reason))}`;
}

export function renderBuild(board) {
  // activeCell guards board?.runs?.list ?? [] itself; one call, never repeated.
  const card = activeCell(board);
  const id = card ? esc(`s${card.sequence_index}${card.archived ? " · archived" : ""}`) : "—";
  // Attempt tabs, re-derived every tick (the strip is NOT data-preserve, so
  // patch() morphs this state in place). Count: the board frame's
  // max_attempts. Enabled: that attempt COMPLETED — an attempt.end entry in
  // the ACTIVE CELL's own live overlay (view.live covers archived runs too;
  // the board-root live and by_cell both miss them). Class names stay
  // double-quoted literals so the style-coverage guard sees them.
  const attempts = board?.live?.attempts ?? [];
  const max = board?.max_attempts ?? 5;
  const flag = renderBlockedFlag(board);
  let tabs = "";
  for (let n = 1; n <= max; n += 1) {
    const enabled = attempts.some((a) => a?.attempt === n);
    tabs +=
      `<button type="button" class="build-tab${activeTab === String(n) ? " active" : ""}"` +
      ` data-build-tab="${n}"${enabled ? "" : " disabled"}>${n}</button>`;
  }
  tabs +=
    `<button type="button" class="build-tab${activeTab === "live" ? " active" : ""}"` +
    ` data-build-tab="live">live</button>`;
  return `
    <section class="panel build">
      <div class="phead">
        <span class="ttl">LIVE BUILD</span>
        <span class="build-id">${id}</span>
        <span class="build-note" data-preserve="1"></span>
        <span class="build-blocked">${flag}</span>
        <div class="build-tabs">${tabs}</div>
      </div>
      <div class="build-split">
        <div class="build-left">
          <div class="build-frame" data-preserve="1"></div>
        </div>
        <div class="build-right">
          <div class="phead">
            <span class="ttl">WHAT'S STILL WRONG</span>
          </div>
          <div class="build-wrong" data-preserve="1"></div>
        </div>
      </div>
    </section>`;
}

// ── the painter ── all stateful work, called by board.js after every patch.

export function paintBuild(view) {
  attachListeners();
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return;

  const card = activeCell(view);
  const key = card ? `${card.run_dir}::${card.sequence_index}` : null;
  // Before every early return: requestLoad boots the selection paintBuild saw.
  currentCard = card;
  lastView = view;

  frameEl = document.querySelector(".build-frame");
  const noteEl = document.querySelector(".build-note");
  const proseEl = document.querySelector(".build-wrong");

  // Liveness, every tick, textContent only. "booted" is tied to the SELECTED
  // key so a deselected run's game never shows as this card's liveness.
  if (noteEl) {
    const bootable = Boolean(card && card.benchmark_id && card.cell);
    noteEl.textContent =
      bootedAt !== null && key !== null && key === loadedKey
        ? `● booted ${Math.floor((Date.now() - bootedAt) / 1000)}s ago`
        : bootable
          ? "● not loaded"
          : "no active build";
  }

  // The busy guard: one stateful sequence at a time. A tick arriving
  // mid-flight only refreshed the note above; if a sequence fails, its key
  // stays unset — a failed prepare re-runs next tick (preparedKey reset), a
  // failed boot waits for the operator's next click (loadedKey unset).
  if (busy) return;

  // Nothing bootable: the designed absence, and teardown of whatever was up.
  if (!card || !card.benchmark_id || !card.cell) {
    activeTab = "live"; // run-switch reset: nothing here has attempts to show
    setWallAttempt(null, null);
    preparedKey = null; // a returning card must re-prepare
    feedbackMsgs = null;
    feedbackAtDone = null;
    paintFrameEmpty();
    if (proseEl) proseEl.textContent = "";
    if (loadedKey !== null) {
      busy = true;
      void teardown().catch(() => {}).finally(() => { busy = false; });
    }
    return;
  }

  // A live run grades another attempt: re-read the prose (GET only), and
  // keep the readout in step with the selected tab. Both are read-only.
  if (key === preparedKey || key === loadedKey) {
    const done = completedAttempts(view);
    if (done !== feedbackAtDone && !feedbackFetching) {
      feedbackAtDone = done;
      void paintProse(card, abort?.signal);
    }
    renderWrong();
  }

  // The cell in flight: the control plane keeps its build running (and boots
  // it again as the source changes), so the panel only READS the registry and
  // frames whatever is there — no click, no write.
  if (card.status === "live" && (key === preparedKey || key === loadedKey)) void followLive(card, key);

  // Same selection as the booted run: idempotent. NEVER re-POST play/start
  // here — startPlay reaps-then-spawns and would kill the game every 2s.
  if (key === loadedKey) return;

  // Same selection as the prepared one: prose fetched (or fetching), load
  // affordance up, waiting on the operator. Idempotent — re-preparing every
  // tick would re-fetch the prose, re-paint the button out from under the
  // cursor, and abort the previous tick's still-in-flight fetch.
  if (key === preparedKey) return;

  // Selection changed: tear the old game down — ONLY when one is up, since
  // teardown POSTs /api/play/stop and an unbooted page load must stay
  // write-free — auto-fetch the new prose (read-only), and offer the load
  // affordance. The game itself boots ONLY on the operator's click.
  busy = true;
  void (async () => {
    // Run-switch reset: the prepare/boot paths below always paint the LIVE
    // viewport (load affordance → iframe), so they must start from "live".
    // The old screenshot <img> dies with teardown's .build-host clear (booted
    // path) or paintFrameLoad's overwrite (unbooted path); a pending retry
    // timer is cleared by teardown's timers loop, and its isConnected guard
    // covers the unbooted path. Availability re-derives next tick from the
    // new cell's own live.attempts.
    activeTab = "live";
    setWallAttempt(null, null);
    try {
      if (loadedKey !== null) await teardown();
      else abort?.abort(); // kill the previous selection's in-flight prose fetch
      abort = new AbortController();
      preparedKey = key;
      feedbackMsgs = null;
      feedbackAtDone = completedAttempts(view);
      renderWrong();
      void paintProse(card, abort.signal); // own region, own failures
      paintFrameLoad();
    } catch (err) {
      console.error("build panel: selection change failed:", err);
      preparedKey = null; // let the next tick re-prepare
    } finally {
      busy = false;
    }
  })();
}

// ── teardown ── exact order per the approved design. The busy guard itself
// lives at the sequence entry (paintBuild): teardown never overlaps another
// sequence, so it runs the rest unconditionally.

async function teardown() {
  abort?.abort(); // kill in-flight fetches of the previous sequence
  es?.close(); // reserved; always null today — the call stays structural
  for (const id of timers) {
    clearInterval(id);
    clearTimeout(id);
  }
  timers = [];
  iframeEl?.remove(); // discard the nested browsing context
  iframeEl = null;
  // Clear the frame host (the iframe's container). Fresh query: patch() may
  // have swapped the section since the last paint. A no-op when the frame
  // already shows the fallback (no .build-host), so the fallback survives.
  document.querySelector(".build-frame .build-host")?.replaceChildren();
  try {
    // Idempotent, bodyless (control/routes/tree.mjs). Awaited here — the boot
    // path wants the old server reaped before startPlay spawns the new one.
    await fetch("/api/play/stop", { method: "POST" });
  } catch {
    // Control plane unreachable: nothing more to do — startPlay reaps anyway.
  }
  loadedKey = null;
  bootedAt = null;
  pid = null;
  port = null;
  playUrl = null;
}

// ── the load click ── the ONLY boot path. Busy-guarded and once-only: a
// click mid-sequence is a no-op, and a booted selection never re-POSTs.

async function requestLoad() {
  if (busy || !currentCard) return;
  const key = `${currentCard.run_dir}::${currentCard.sequence_index}`;
  if (key === loadedKey) return; // already booted — play/start fires once
  busy = true;
  try {
    // Share the prepared selection's live controller when one exists, so a
    // later teardown can still abort EVERY in-flight fetch of this sequence.
    if (!abort || abort.signal.aborted) abort = new AbortController();
    await startGame(currentCard, key, abort.signal);
    if (loadedKey !== key) {
      // startGame caught a real failure (it never throws): re-offer the
      // affordance — the tick never will; retry is the operator's click.
      paintFrameLoad();
    }
  } catch (err) {
    console.error("build panel: game boot failed:", err);
    paintFrameLoad();
  } finally {
    busy = false;
  }
}

// ── the two fetches ── prose and game are independent: each paints its own
// region and catches its own failures, so one never blocks or fails the other.

async function paintProse(card, signal) {
  feedbackFetching = true;
  try {
    const res = await fetch(
      `/api/feedback?run_dir=${encodeURIComponent(card.run_dir)}&sequence_index=${card.sequence_index}`,
      { signal },
    );
    const data = res.ok ? await res.json() : null;
    if (!res.ok || !data) throw new Error(`GET /api/feedback → ${res.status}`);
    const messages = Array.isArray(data.messages) ? data.messages : [];
    // kind:"chunk" is the initial GOAL and kind:"pass_verdict" is not a
    // problem list — only the feedback messages are "what's still wrong".
    feedbackMsgs = messages.filter((m) => m?.kind === "feedback");
  } catch (err) {
    if (err?.name === "AbortError") return;
    console.error("build panel: feedback fetch failed:", err);
    // Stated absence, never stale prose from another run.
    feedbackMsgs = { error: String(err?.message ?? err) };
  } finally {
    feedbackFetching = false;
  }
  renderWrong();
}

/** Attempts the board reports as completed; the live tab's "how far along". */
function completedAttempts(view) {
  return Array.isArray(view?.live?.attempts) ? view.live.attempts.length : 0;
}

/**
 * Draw the selected tab's prompt into the readout. A pure function of
 * (feedbackMsgs, activeTab, lastView): skipped when nothing it reads changed,
 * so the 2s tick neither flickers nor collapses an open "full prompt".
 */
function renderWrong() {
  const el = document.querySelector(".build-wrong");
  if (!el) return;
  const shown = feedbackMsgs === null ? { empty: "loading the prompt…" } : feedbackMsgs.error
    ? { empty: `feedback unavailable — ${feedbackMsgs.error}` }
    : promptForTab(feedbackMsgs, activeTab, {
        completed: completedAttempts(lastView),
        max: lastView?.max_attempts ?? 5,
      });
  const sig = JSON.stringify([activeTab, shown.empty ?? null, shown.meta ?? null, shown.text ?? null]);
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  paintWrong(el, shown);
  fitProblems();
}

// ── fit ── the card's geometry, solved from its height. Called by panels/fit.js
// after every patch and on resize; reads layout, writes only sizes.

/** The size the grader lays the game out at (and captures it at), so what is
 *  framed here is the layout its complaints describe — never the operator's own
 *  screen, which would show a different layout from the saved capture. */
function screenSize() {
  return { w: 1280, h: 800 };
}

const PROBLEM_FONT_MIN = 9;
const PROBLEM_FONT_MAX = 12.5;

/**
 * The game column is as wide as the screen's shape needs at the card's height
 * (capped at 60% of the card, the rest goes to the problems); then the stage
 * and the problem text are fitted to what they were given.
 */
export function fitBuild() {
  const split = document.querySelector(".build-split");
  const left = split?.querySelector(".build-left");
  if (!split || !left) return;
  if (window.innerWidth < 1100) {
    split.style.removeProperty("--build-cols");
  } else {
    const bar = left.querySelector(".build-bar")?.offsetHeight ?? 0;
    const wellH = left.clientHeight - bar - 2;
    const { w, h } = screenSize();
    const gw = Math.min(Math.round(split.clientWidth * 0.6), Math.round((wellH * w) / h) + 2);
    split.style.setProperty("--build-cols", `${gw}px minmax(0,1fr)`);
  }
  fitStage();
  fitProblems();
}

/** Lay the iframe out at the screen's size and scale it evenly into its well. */
function fitStage() {
  if (!iframeEl?.isConnected) return;
  const view = iframeEl.closest(".build-view");
  if (!view || !view.clientWidth || !view.clientHeight) return;
  const { w, h } = screenSize();
  const scale = Math.min(view.clientWidth / w, view.clientHeight / h);
  iframeEl.style.width = `${w}px`;
  iframeEl.style.height = `${h}px`;
  iframeEl.style.transform = `translate(-50%,-50%) scale(${scale})`;
  const read = view.querySelector(".build-size");
  if (read) read.textContent = `${w}×${h} @ ${Math.round(scale * 100)}%`;
}

/**
 * The largest problem-text size at which the whole readout fits its column
 * without scrolling, between 9px and 12.5px. Beyond the floor it scrolls. Left
 * alone while the full prompt is open: that is a reading mode, not a fit.
 */
function fitProblems() {
  const el = document.querySelector(".build-wrong");
  if (!el || !el.clientHeight || el.querySelector(".bw-full.open")) return;
  let lo = PROBLEM_FONT_MIN;
  let hi = PROBLEM_FONT_MAX;
  for (let i = 0; i < 9; i += 1) {
    const mid = (lo + hi) / 2;
    el.style.setProperty("--bw-fit", `${mid}px`);
    if (el.scrollHeight <= el.clientHeight + 1) lo = mid;
    else hi = mid;
  }
  el.style.setProperty("--bw-fit", `${lo}px`);
}

async function startGame(card, key, signal) {
  // The boot/refusal reason from play/start, scoped so the catch can surface
  // it in the frame fallback instead of a bare "no active build".
  let bootReason = null;
  try {
    const res = await fetch("/api/play/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run: card.benchmark_id, cell: card.cell }),
      signal,
    });
    const data = res.ok ? await res.json().catch(() => null) : null;
    if (!res.ok || data?.ok !== true || !data.url) {
      bootReason = data?.reason ?? `play/start → HTTP ${res.status}`;
      throw new Error(
        `POST /api/play/start → ${res.status}${data?.reason ? ` ${data.reason}` : ""}`,
      );
    }
    pid = data.pid ?? null;
    port = data.port ?? null;
    playUrl = data.url;
    paintFrame(data.url);
    loadedKey = key;
    bootedAt = Date.now();
  } catch (err) {
    console.error("build panel: game boot failed:", err);
    // loadedKey stays unset; requestLoad re-offers the load affordance so the
    // operator can retry. The board never dies for this panel.
    paintFrameEmpty(bootReason);
  }
}

// ── frame painting ── painter-owned contents of the data-preserve region.

function paintFrame(url) {
  frameEl = document.querySelector(".build-frame");
  if (!frameEl) return;
  // innerHTML is safe here: the only dynamic part is the server-given url,
  // and it is escaped. Class names stay double-quoted literals so the
  // style-coverage guard sees them.
  frameEl.innerHTML =
    `<div class="build-bar"><span class="build-url">${esc(url)}</span>` +
    `<button type="button" class="build-btn" data-build-reload>reload</button>` +
    `<button type="button" class="build-btn" data-build-open>open ↗</button></div>` +
    `<div class="build-view"><div class="build-host"></div><span class="build-size"></span></div>`;
  // The iframe is BUILT, never parsed from a string, so sandbox and
  // referrerpolicy reliably exist before the first navigation. Untrusted
  // model output: scripts + its own origin only — every other capability
  // stays denied.
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.src = url;
  frameEl.querySelector(".build-host")?.appendChild(iframe);
  iframeEl = iframe;
  fitStage();
}

// The frame fallback. With a reason (the play/start refusal), it states the
// refusal — escaped, because the reason embeds model/server output. Without
// one (the no-card teardown and tab-viewport paths), the plain absence.
function paintFrameEmpty(reason) {
  frameEl = document.querySelector(".build-frame");
  if (frameEl)
    frameEl.innerHTML = reason
      ? `<div class="build-empty">render blocked — ${esc(reason)}</div>`
      : `<div class="build-empty">no active build</div>`;
}

// The load affordance: the game boots ONLY from this button's click. Class
// names stay double-quoted literals so the style-coverage guard sees them.
function paintFrameLoad() {
  frameEl = document.querySelector(".build-frame");
  if (frameEl)
    frameEl.innerHTML =
      `<div class="build-empty"><button type="button" class="build-btn" data-build-load>load build</button></div>`;
}

// ── the tab viewport ── swaps .build-frame between the live iframe and a
// stored grader screenshot, from activeTab + the current card + boot state.
// Called ONLY from a tab click: a passive page load and the 2s tick never
// fire a screenshot GET (the board smoke check flags any GET ≥400, and a
// missing capture 404s by design — control/routes/screenshot.mjs).

function paintTabViewport() {
  const card = currentCard;
  if (activeTab === "live") {
    // The play server stays up across tab switches — never /api/play/stop
    // here; paintFrame just re-creates the iframe onto the live URL.
    if (loadedKey !== null && playUrl) paintFrame(playUrl);
    else if (card && card.benchmark_id && card.cell) paintFrameLoad();
    else paintFrameEmpty();
    return;
  }
  const n = Number(activeTab);
  if (!Number.isInteger(n) || n < 1 || !card) return;
  paintScreenshot(card, n);
}

// The stored grader capture for ONE attempt: /api/screenshot streams
// attempt-<N>-board.png with Cache-Control: no-store, so re-setting src
// re-fetches from the server. The <img> is BUILT, never parsed from a
// string — the URL carries dynamic values. On error: retry ONCE after
// ~500ms; on the second error, a stated absence — never another attempt's
// board, never the live view.
function paintScreenshot(card, n) {
  frameEl = document.querySelector(".build-frame");
  if (!frameEl) return;
  // paintFrame's structure minus the URL bar: the screenshot fills the same
  // well (.build-view owns the height; .build-host img mirrors the iframe).
  frameEl.innerHTML = `<div class="build-view"><div class="build-host"></div></div>`;
  const host = frameEl.querySelector(".build-host");
  if (!host) return;
  const img = document.createElement("img");
  const src =
    "/api/screenshot?run_dir=" + encodeURIComponent(card.run_dir) +
    "&sequence_index=" + card.sequence_index +
    "&attempt=" + n;
  img.alt = `attempt ${n} board screenshot`;
  let retried = false;
  img.addEventListener("error", () => {
    if (!retried) {
      retried = true;
      // The timers array makes this teardown's problem: a run switch clears
      // it. isConnected covers what teardown cannot — a tab click or
      // paintFrameLoad may have already replaced this img, and a detached
      // img would still fetch, so the retry dies with its node.
      timers.push(setTimeout(() => { if (img.isConnected) img.src = src; }, 500));
      return;
    }
    // Fresh query: patch() may have swapped the section since the paint.
    const f = document.querySelector(".build-frame");
    if (f) f.innerHTML = `<div class="build-empty">screenshot unavailable</div>`;
  });
  img.src = src;
  host.appendChild(img);
}
