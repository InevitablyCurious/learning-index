// THE TUI MIRROR'S CELL — the subscription carries the address of the cell
// the strip points at (`<run_dir>::<sequence_index>`), and the selection state
// round-trips.
//
// WHY THE ADDRESS AND NOT run_id: the ledger run_id lives only in the control
// plane's memory. An ended cell, a CLI launch, or any cell after a control-plane
// restart had none, and a missing key fell back to "the newest cell" — another
// cell's terminal under this one's name.
//
// Zero dependencies. Stock `node --test`, no install, no build step:
//
//     cd dashboard && node --test tui-run-select.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { streamUrl, tuiCell, setTuiCell, cellKey } from "./board.js";
import { renderTuiBody } from "./panels/tui.js";

// ── the subscription URL ──

test("stream URL carries no cell when none is selected", () => {
  assert.equal(streamUrl(0, true, null), "/api/stream?since=0&tui=1");
  assert.equal(streamUrl(42, false, null), "/api/stream?since=42");
});

test("stream URL carries the cell address, URI-encoded", () => {
  assert.equal(
    streamUrl(7, true, "1790/local/x::3"),
    "/api/stream?since=7&tui=1&cell=1790%2Flocal%2Fx%3A%3A3",
  );
});

// ── the cell address ──

test("cellKey is run_dir::sequence_index, and null when either is missing", () => {
  assert.equal(cellKey({ run_dir: "r/x", sequence_index: 2 }), "r/x::2");
  assert.equal(cellKey({ run_dir: "r/x", sequence_index: 0, run_id: null }), "r/x::0", "no ledger run_id needed");
  assert.equal(cellKey({ run_dir: null, sequence_index: 2 }), null);
  assert.equal(cellKey({ run_dir: "r/x", sequence_index: null }), null);
  assert.equal(cellKey(null), null);
});

// ── the selection state ──

test("setTuiCell round-trips; an empty value means no cell", () => {
  // No EventSource under Node: connect() is guarded, so this is pure state.
  setTuiCell("r/x::1");
  assert.equal(tuiCell(), "r/x::1");
  setTuiCell("");
  assert.equal(tuiCell(), null);
});

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
