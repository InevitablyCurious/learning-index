// ARCHIVED RUN VIEWS ARE THE CLIENT'S — kept outside the board, fetched once.
//
// by_cell is built server-side for the current tree; an archived run's view
// comes from /api/run-view. It used to be cached INTO the board object, and
// selecting a run re-keyed the TUI mirror, which reconnects the stream. Every
// (re)connect sends a full "board" frame that REPLACES the client's board, so
// the view was drawn and then wiped, and the mirror blanked: the gate wall and
// the TUI mirror flashed, then showed nothing, on every card switch.
//
// These tests pin what the fix rests on: the view lives outside the board, a
// run is fetched once, loading and failure are stated on the wall, and an
// archived pick never touches the stream.
//
//     cd dashboard && node --test run-view-cache.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { cellView, followActiveCell, retryRunView, runViewEntry, setTuiCell, tuiCell } from "./board.js";
import { setSelectedCell } from "./panels/cells.js";
import { renderWall } from "./panels/wall.js";
import { renderTuiBody } from "./panels/tui.js";

const LIVE = { run_dir: "1790257061/local/x", sequence_index: 0, archived: false, status: "live" };
const liveKey = `${LIVE.run_dir}::0`;

/** An archived card; every test uses its own tree so the page cache starts empty for it. */
function archived(tree) {
  return { run_dir: `backups/1790000000/${tree}/local/x`, sequence_index: 0, archived: true, status: "scored" };
}
const keyOf = (c) => `${c.run_dir}::${c.sequence_index}`;

/** What a full "board" frame installs: a brand-new object with the current tree only. */
function boardFrame(cards) {
  return {
    run: { model: "m" },
    runs: { list: [LIVE, ...cards] },
    by_cell: { [liveKey]: { run: { phase: "live-phase" }, suite: { gates: [{ id: "LIVE-GATE" }] }, live: null, learning: null } },
    tui: { status: "live", frame: [[{ t: "live terminal" }]], cell: liveKey },
  };
}

/** A run-view answer whose suite names the run it came from. */
function viewFor(card) {
  return { run: { phase: `phase-of-${card.run_dir}` }, suite: { gates: [{ id: card.run_dir }] }, live: null, learning: null, honesty: {}, sources: null };
}

/** fetch stub: answers from `answer(url)`, counts calls. */
function stubFetch(answer) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return answer(url);
  };
  return calls;
}
const okAnswer = (view) => ({ ok: true, status: 200, json: async () => ({ ok: true, view }) });

test("(a) an archived view survives a full board frame — it never lived in the board", async () => {
  const A = archived("1789000001");
  stubFetch(() => okAnswer(viewFor(A)));
  const before = boardFrame([A]);
  setSelectedCell(keyOf(A));
  await followActiveCell(before, () => {});
  assert.equal(before.by_cell[keyOf(A)], undefined, "the load writes nothing into the board");

  // The reconnect's frame replaces the board wholesale.
  const after = boardFrame([A]);
  const v = cellView(after);
  assert.deepEqual(v.suite.gates, [{ id: A.run_dir }], "the wall still draws the archived run");
  assert.equal(v.run.phase, `phase-of-${A.run_dir}`);
  assert.equal(v.run_view, null);
  setSelectedCell(null);
});

test("(b) A → B → A shows A's view with no second fetch", async () => {
  const A = archived("1789000002");
  const B = archived("1789000003");
  const calls = stubFetch((url) => okAnswer(viewFor(url.includes("1789000002") ? A : B)));
  const b = boardFrame([A, B]);

  setSelectedCell(keyOf(A));
  await followActiveCell(b, () => {});
  setSelectedCell(keyOf(B));
  await followActiveCell(boardFrame([A, B]), () => {});
  setSelectedCell(keyOf(A));
  assert.equal(followActiveCell(boardFrame([A, B]), () => {}), null, "a held view starts no load");

  assert.equal(calls.length, 2, "one fetch per run per page load");
  assert.deepEqual(cellView(boardFrame([A, B])).suite.gates, [{ id: A.run_dir }]);
  setSelectedCell(null);
});

test("(c) while the fetch is in flight the wall says loading — never empty, never another run's", async () => {
  const C = archived("1789000004");
  let land;
  stubFetch(() => new Promise((resolve) => { land = () => resolve(okAnswer(viewFor(C))); }));
  const b = boardFrame([C]);
  setSelectedCell(keyOf(C));
  const pending = followActiveCell(b, () => {});
  assert.equal(runViewEntry(keyOf(C)).state, "loading");

  const html = renderWall(cellView(b));
  assert.match(html, /loading this run's view/);
  assert.match(html, /LOADING RUN VIEW/);
  assert.doesNotMatch(html, /gate suite surface is unavailable/i, "not the control-plane absence");
  assert.doesNotMatch(html, /LIVE-GATE/, "not the live cell's wall");

  land();
  await pending;
  const v = cellView(boardFrame([C]));
  assert.equal(v.run_view, null);
  assert.deepEqual(v.suite.gates, [{ id: C.run_dir }]);
  setSelectedCell(null);
});

test("(d) a failed fetch states its reason on the wall; re-selecting retries it", async () => {
  const D = archived("1789000005");
  const calls = stubFetch(() => ({ ok: false, status: 404, json: async () => ({ ok: false, reason: "no such run: 1789000005" }) }));
  const b = boardFrame([D]);
  setSelectedCell(keyOf(D));
  await followActiveCell(b, () => {});
  assert.match(renderWall(cellView(b)), /could not load this run&#39;s view — no such run: 1789000005/);

  // A failure is held (no refetch on every render) until the operator re-selects.
  assert.equal(followActiveCell(b, () => {}), null);
  retryRunView(keyOf(D));
  stubFetch(() => okAnswer(viewFor(D)));
  await followActiveCell(b, () => {});
  assert.equal(calls.length, 1);
  assert.deepEqual(cellView(b).suite.gates, [{ id: D.run_dir }]);

  // A loaded view is never dropped by a retry.
  retryRunView(keyOf(D));
  assert.equal(runViewEntry(keyOf(D)).state, "ready");
  setSelectedCell(null);
});

test("(d) a relay error page that is not JSON is reported by its status", async () => {
  const E = archived("1789000006");
  stubFetch(() => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } }));
  setSelectedCell(keyOf(E));
  await followActiveCell(boardFrame([E]), () => {});
  assert.deepEqual(runViewEntry(keyOf(E)), { state: "failed", reason: "HTTP 502" });
  setSelectedCell(null);
});

test("(e) selecting an archived run never resubscribes the stream; the mirror states it has no session", async () => {
  const F = archived("1789000007");
  const G = archived("1789000008");
  stubFetch((url) => okAnswer(viewFor(url.includes("1789000007") ? F : G)));
  const opened = [];
  globalThis.EventSource = class {
    constructor(url) { opened.push(url); }
    addEventListener() {}
    close() {}
  };
  try {
    setTuiCell(null);
    const b = boardFrame([F, G]);

    // Following the live cell subscribes the mirror to it — once.
    setSelectedCell(null);
    followActiveCell(b, () => {});
    assert.equal(tuiCell(), liveKey);
    assert.equal(opened.length, 1);

    // Live → archived → archived → live: no reconnect, and the mirror stays keyed on the live cell.
    for (const c of [F, G]) {
      setSelectedCell(keyOf(c));
      await followActiveCell(b, () => {});
      assert.equal(opened.length, 1, `selecting ${keyOf(c)} opened no stream`);
      assert.equal(tuiCell(), liveKey);
      const v = cellView(b);
      assert.equal(v.tui, null, "the live cell's frames are never drawn under an archived run");
      assert.match(renderTuiBody(v), /this run is archived — it has ended, so there is no session to mirror/);
    }
    setSelectedCell(liveKey);
    followActiveCell(b, () => {});
    assert.equal(opened.length, 1, "back on the live cell: the subscription never moved");
    assert.equal(cellView(b).tui.status, "live");
  } finally {
    delete globalThis.EventSource;
    setTuiCell(null);
    setSelectedCell(null);
  }
});
