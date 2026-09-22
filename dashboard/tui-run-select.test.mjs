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

test("the selector lists addressable runs, skips run_id-less ones, and marks the selection", () => {
  setTuiRunId("run-b");
  const html = renderTuiBody(boardWithRuns({ run_id: "run-b", session_id: "bbbb2222-xyz" }));
  assert.ok(html.includes("data-tui-run"), "the selector is present");
  assert.ok(html.includes('value=""'), "the default/newest option is first");
  assert.ok(html.includes('value="run-a"'), "run-a is listed");
  assert.ok(html.includes('value="run-b" selected'), "the selected run is marked");
  assert.ok(html.includes("pty aaaa1111 · m1 · on"), "the label carries session short + model + arm");
  assert.ok(!html.includes("cccc3333"), "a run with no run_id is not addressable and is skipped");
  setTuiRunId("");
});

test("the identity label shows the frame's run_id when the patch carries one", () => {
  const html = renderTuiBody(boardWithRuns({ run_id: "run-b", session_id: "bbbb2222-xyz" }));
  assert.ok(html.includes("run run-b"), "the identity label shows the frame's run_id");
  assert.ok(html.includes("pty bbbb2222"), "label keeps the pty session short");
});

test("with no run_id on the frame the label falls back to the session short", () => {
  const html = renderTuiBody(boardWithRuns({ run_id: null, session_id: "dddd4444-xyz" }));
  assert.ok(html.includes("pty dddd4444"), "session short is kept");
  assert.ok(!html.includes("· run "), "no run label is invented");
});

test("a board with no live runs still renders the default option", () => {
  const html = renderTuiBody({
    control: { run: { runs: [], live_count: 0 } },
    run: {},
    events: null,
    tui: { status: null, frame: null },
    hold: null,
  });
  assert.ok(html.includes("data-tui-run"), "the selector is present");
  assert.ok(html.includes('value="" selected'), "default is selected");
});
