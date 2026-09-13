// ─────────────────────────────────────────────────────────────────────────────
// STARTUP FEED — the derivation, and the yield rule
//
//     cd bench/dashboard && node --test
//
// WHY THIS EXISTS
//
// The operator clicked [+ baseline]; the benchmark did not start; and NOTHING
// on the board said so. Both halves were defects, and the second is the one
// that made it expensive — the failure existed, was written to `ui.refusal` and
// to `console.error`, and reached no surface.
//
// So the assertions here are about VISIBILITY, not about styling:
//
//   · a refusal must reach the feed VERBATIM, with its code
//   · The arm→confirm handshake this file once covered is GONE. Starting a
//     run is one act now (panels/create.js: launchCell) and the launch
//     checklist on BASELINE · 4 reports it, so the feed no longer carries a
//     `run-lifecycle` row and these tests went with it.
//
// PURE BY CONSTRUCTION: `startupFeed()` takes a board payload and returns a
// list. No DOM, no fetch, no clock beyond Date.now(). That is what makes the
// derivation testable at all, and it is why the renderer is a thin projection
// of it rather than a second derivation.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import { startupFeed, renderStartupFeed } from "./panels/startup.js";
import { renderTuiBody } from "./panels/tui.js";

// The mirror is a tab on the transfer-curve card now, not a dock with a
// minimized form — `renderTuiBody` IS the view the yield rule governs, so
// there is no state to set up before asserting on it.

/** A board payload with everything healthy and idle. Each test breaks ONE thing. */
function healthyBoard(over = {}) {
  return {
    control: {
      base_url: "http://127.0.0.1:7718",
      base_url_is_loopback: true,
      run: { state: "idle", can_start: true },
      roster: { proxy_ok: true, bench_models: [{ id: "m1", bench_eligible: true, resident: true }] },
      capabilities: {},
    },
    run: {},
    events: { connected: true, total: 5 },
    tui: { running: false, status: null, frame: null },
    hold: null,
    ...over,
  };
}

const byId = (feed, id) => feed.processes.find((p) => p.id === id);

test("every process reports a state, and nothing is silently omitted", () => {
  const feed = startupFeed(healthyBoard(), null);
  const ids = feed.processes.map((p) => p.id);
  // Pinned explicitly: a process quietly dropped from the derivation is
  // invisible in exactly the way this surface exists to prevent.
  for (const id of [
    "control-plane", "runner", "model-proxy", "event-feed",
    "tui-mirror", "hold-gate",
  ]) {
    assert.ok(ids.includes(id), `${id} is missing from the startup feed`);
  }
  for (const p of feed.processes) {
    assert.ok(p.name && p.state && p.why, `${p.id} is missing name/state/why`);
    assert.ok(
      ["ok", "busy", "idle", "off", "bad", "unknown"].includes(p.state),
      `${p.id} has an undeclared state: ${p.state}`,
    );
  }
});

test("a healthy idle board blocks nothing and says so", () => {
  const feed = startupFeed(healthyBoard(), { armed: false, pending: false, refusal: null, startedAt: null, starting: false });
  assert.equal(feed.blocking.length, 0);
  assert.equal(feed.ok, true);
  assert.match(feed.verdict, /ready to start/i);
});

// ── THE OPERATOR'S ACTUAL FAILURE ───────────────────────────────────────────

// ── NEVER CRY WOLF, NEVER GREEN-LIGHT BY OMISSION ───────────────────────────

test("the deleted live lane no longer occupies a row", () => {
  // The live-lane / choreography surface was torn out (control/live-lane.mjs,
  // live-surface.mjs, choreography.mjs, build-scan.mjs). Its startup row stayed
  // behind and reported "off · not running" forever — a permanent status line
  // for a subsystem that cannot exist. A row that can only ever say one thing
  // teaches the operator to stop reading the feed.
  const feed = startupFeed(healthyBoard(), null);
  assert.equal(byId(feed, "live-lane"), undefined);
});

test("a disconnected event feed is off while idle but bad while a cell runs", () => {
  const idle = startupFeed(healthyBoard({ events: { connected: false, reason: "fetch failed", total: 0 } }), null);
  assert.equal(byId(idle, "event-feed").state, "off");

  const running = startupFeed(
    healthyBoard({
      events: { connected: false, reason: "fetch failed", total: 0 },
      control: { ...healthyBoard().control, run: { state: "running", can_start: false } },
    }),
    null,
  );
  // A cell IS running, so a dead stream is a real loss of visibility.
  assert.equal(byId(running, "event-feed").state, "bad");
});

test("an unreachable model proxy blocks a start, with the reason attached", () => {
  const feed = startupFeed(
    healthyBoard({
      control: { ...healthyBoard().control, roster: { proxy_ok: false, reason: "connection refused on :4545" } },
    }),
    null,
  );
  const mp = byId(feed, "model-proxy");
  assert.equal(mp.state, "bad");
  assert.match(mp.reason, /connection refused on :4545/);
  assert.equal(feed.ok, false);
});

test("a missing control plane is bad and is rendered FIRST", () => {
  const board = healthyBoard({ control: null });
  const feed = startupFeed(board, null);
  assert.equal(byId(feed, "control-plane").state, "bad");
  // The verdict names the blocking process, so the operator reads WHAT is
  // wrong before any row.
  assert.match(feed.verdict, /blocking a benchmark start — control plane/);

  // Worst-first ordering: the blocking row is the first one rendered. Asserted
  // on the FIRST `.sfname` rather than on substring order, because a later
  // mention anywhere in the document would satisfy a looser check.
  const html = renderStartupFeed(board, null);
  const firstName = html.slice(html.indexOf("sfrow")).match(/sfname">([^<]+)/)[1];
  assert.equal(firstName, "control plane");
});

test("a hold is reported as a deliberate stop, not a crash", () => {
  const feed = startupFeed(healthyBoard({ hold: { reason: "integrity gate awaiting review" } }), null);
  const h = byId(feed, "hold-gate");
  assert.equal(h.state, "bad");
  assert.match(h.reason, /on purpose/);
});

// ── RENDERING ───────────────────────────────────────────────────────────────

test("the rendered feed escapes publisher prose rather than interpolating it raw", () => {
  // The injection point moved when the run-lifecycle row was deleted, but the
  // property did not: EVERY string on this feed is published by something else
  // — a source's failure reason, a control-plane error, a harness log line —
  // and any of them can carry markup. A source reason is the live equivalent.
  const html = renderStartupFeed(
    healthyBoard({
      control: null,
      sources: [{ id: "control-plane", ok: false, reason: "<img src=x onerror=alert(1)>" }],
    }),
  );
  assert.ok(!html.includes("<img src=x"), "publisher prose reached the DOM unescaped");
  assert.match(html, /&lt;img/);
});

test("a control-plane READ failure is not reported as 'not running'", () => {
  // OBSERVED LIVE, 2026-08-13: every control endpoint answered in ~2ms from
  // inside the container while the dashboard's aggregate source timed out at
  // 2000ms, because /api/wall alone took 2062ms. Reporting that as "it is not
  // running" would send the operator to restart a perfectly healthy service.
  const feed = startupFeed(
    healthyBoard({
      control: null,
      sources: [{ id: "control-plane", ok: false, reason: "control-plane: timed out after 2000ms" }],
    }),
    null,
  );
  const cp = byId(feed, "control-plane");
  assert.equal(cp.state, "bad");
  assert.match(cp.reason, /timed out after 2000ms/);
  assert.match(cp.reason, /may be running and healthy/);
  assert.ok(!/it is not running/.test(cp.reason));
});

test("worst-first: a blocking row is rendered before a healthy one", () => {
  const html = renderStartupFeed(
    healthyBoard({ hold: { reason: "held for review" } }),
    { armed: false, pending: false, starting: false, startedAt: null, refusal: null },
  );
  // The hold is the only bad row here, so it must precede every healthy one.
  // `model proxy` is chosen because it is `ok` and sits AFTER the hold gate in
  // derivation order — so a passing assertion can only come from the sort.
  assert.ok(html.indexOf("hold gate") < html.indexOf("model proxy"));
});

// ── THE YIELD RULE ──────────────────────────────────────────────────────────
// "Once the TUI renders, the data feed for the benchmark process disappears
// since we no longer need to see it." Asserted through renderTuiBody's real output,
// because the rule is only worth anything if the ACTUAL panel obeys it.

const FRAME = [[{ t: "hello from the pty", fg: 2 }]];

test("with no terminal frame, the mirror shows the startup feed", () => {
  const html = renderTuiBody(healthyBoard({ tui: { status: null, frame: null } }), null);
  assert.match(html, /BENCHMARK STARTUP/);
});

test("a painted live frame DISPLACES the feed entirely", () => {
  const html = renderTuiBody(healthyBoard({ tui: { status: "live", frame: FRAME } }), null);
  assert.ok(!html.includes("BENCHMARK STARTUP"), "the feed must yield to a live terminal frame");
  // THE FRAME IS NO LONGER IN THE MARKUP, and asserting on its text here would
  // be asserting on the old renderer rather than on the rule. xterm.js owns the
  // pixels; the panel's job is to hand it a `data-preserve` node to own. That
  // node appearing in place of the feed IS the yield rule.
  assert.match(html, /class="tui-term[^"]*"[^>]*data-preserve/);
});

test("a WITHHELD frame does not count as painted — the feed stays", () => {
  // The server drops the frame for a minimized client. Treating that as "the
  // terminal is up" would hide the feed behind a frame that was never sent.
  const html = renderTuiBody(healthyBoard({ tui: { status: "live", frame: null, frame_withheld: true } }), null);
  assert.match(html, /BENCHMARK STARTUP/);
});

test("the feed RETURNS when the mirror fails or exits after painting", () => {
  // This is exactly when an operator needs the process list again: a mirror
  // that died mid-run is a question the last frame cannot answer.
  for (const status of ["failed", "exited"]) {
    const html = renderTuiBody(healthyBoard({ tui: { status, frame: FRAME, reason: "pty closed" } }), null);
    assert.match(html, /BENCHMARK STARTUP/, `the feed must return on status=${status}`);
  }
});

test("a SILENT terminal keeps its frame — silence is a healthy, legible state", () => {
  const html = renderTuiBody(healthyBoard({ tui: { status: "silent", frame: FRAME, reason: "no output" } }), null);
  assert.ok(!html.includes("BENCHMARK STARTUP"));
  // The terminal host is still emitted (the last frame is held, not cleared)
  // and it is dimmed and labelled — a silent terminal must LOOK silent.
  assert.match(html, /class="tui-term dim"/);
  assert.match(html, /the mirror is live and the grid is unchanged/);
});
