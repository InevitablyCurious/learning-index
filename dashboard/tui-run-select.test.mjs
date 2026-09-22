// THE TUI CELL SELECTOR — the subscription carries the selected run_id, the
// selector lists the live runs, and the selection state round-trips.
//
// WHY: the board's SSE fast path is keyed by run_id (control/board/lib/tui.mjs
// groups frame subscribers by it, and every TUI patch carries its run_id). A
// dashboard that subscribed with tui=1 only could never mirror anything but
// the default/newest cell — the operator had no way to pick another live one.
//
// Zero dependencies. Stock `node --test`, no install, no build step:
//
//     cd dashboard && node --test tui-run-select.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { streamUrl, tuiRunId, setTuiRunId } from "./board.js";
import { renderTuiBody } from "./panels/tui.js";

// ── the subscription URL ──

test("stream URL omits run_id when no cell is selected", () => {
  assert.equal(streamUrl(0, true, null), "/api/stream?since=0&tui=1");
  assert.equal(streamUrl(42, false, null), "/api/stream?since=42");
});

test("stream URL carries the selected run_id alongside tui=1", () => {
  const url = streamUrl(7, true, "3f2a1b0c-0000-4000-8000-000000000009");
  assert.equal(
    url,
    "/api/stream?since=7&tui=1&run_id=3f2a1b0c-0000-4000-8000-000000000009",
  );
});

test("run_id is URI-encoded into the subscription", () => {
  assert.ok(streamUrl(0, true, "a b&c").includes("run_id=a%20b%26c"));
});

// ── the selection state ──

test("setTuiRunId round-trips; empty values mean the default (null)", () => {
  // No EventSource under Node: connect() is guarded, so this is pure state.
  setTuiRunId("run-1");
  assert.equal(tuiRunId(), "run-1");
  setTuiRunId("");
  assert.equal(tuiRunId(), null);
});

// ── the selector + identity label ──

/** A board with two addressable live runs and one external (no run_id). */
function boardWithRuns(tui = {}) {
  return {
    control: {
      run: {
        runs: [
          { run_id: "run-b", session_id: "bbbb2222-xyz", model: "m2", arm: "off", state: "running" },
          { run_id: "run-a", session_id: "aaaa1111-xyz", model: "m1", arm: "on", state: "running" },
          { run_id: null, session_id: "cccc3333-xyz", model: "m3", arm: "on", state: "running" },
        ],
        live_count: 3,
      },
    },
    run: {},
    events: { connected: true, total: 0 },
    tui: { status: "live", frame: null, ...tui },
    hold: null,
  };
}

// ── THE HEAD CARRIES NONE OF IT ANY MORE ────────────────────────────────────
//
// The selector, the run/pty identity label and the model/arm line were removed
// when the CELL STRIP became the selector. They are not "temporarily hidden":
// with N replicates of one configuration the label was identical across every
// cell, so it could not tell them apart, and two selectors for one subject let
// the board and the terminal drift onto different cells.
//
// The tests that pinned that markup are gone with it, replaced by these, which
// pin the absence — so putting any of it back is a deliberate act with a
// failing test to answer for, not a quiet regression.

test("the head carries no cell selector — the strip is the selector", () => {
  const html = renderTuiBody(boardWith({ runs: [{ run_id: "r1", model: "m", arm: "off" }] }));
  assert.ok(!html.includes("data-tui-run"), "no <select> in the mirror head");
  assert.ok(!html.includes("<option"), "no options either");
});

test("the head states no identity — which cell is the strip's job", () => {
  const html = renderTuiBody(boardWith({
    tui: { status: "live", run_id: "ee363af4-aaaa", session_id: "ses_f355aaaa", frame: null },
  }));
  assert.ok(!html.includes("ee363af4"), "no run_id in the head");
  assert.ok(!html.includes("ses_f355"), "no pty session in the head");
  assert.ok(!html.includes("cols ×"), "no terminal dimensions");
});

test("the head keeps the one thing that is a fact about right now", () => {
  // Whether frames are arriving is the only non-constant the head carried.
  const html = renderTuiBody(boardWith({ tui: { status: "live", frame: null } }));
  assert.ok(html.includes("live"), "the status word survives");
});

function boardWith({ runs = [], tui = null } = {}) {
  return { control: { run: { runs } }, tui, preflight: null, control_plane: null };
}
