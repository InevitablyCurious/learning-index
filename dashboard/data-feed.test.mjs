// THE DATA FEED CARD'S TWO SOURCES — the live cell, and a concluded record.
//
// ONE SURFACE, TWO SOURCES. The card reads either the running cell or a frozen
// baseline record, and it is the same card either way: same tabs, same kind
// chips, same source/severity facets, same row renderers. These tests pin the
// SOURCE SWITCH (`selectHistoricalRun` / `clearHistoricalRun`) and the two
// invariants that make one card safe to point at two things —
//
//   1. a run starting takes the card back, and
//   2. a stale read never lands on top of a newer choice.
//
// THE DEFECT THIS FILE REPLACED. The concluded feeds first rendered as their own
// stacked sections inside the BASELINES drawer, gated behind a memory PROFILE —
// so with no profile frozen (which is every bench now) the record was persisted,
// served, and unreachable. It then rendered in the drawer WITHOUT the drawer
// having any of the reading tools. Both are gone; the record opens in the card
// built for reading.
//
// Module state in panels/live.js persists across tests in this file, so each
// subtest establishes the state it asserts on and the ordering is declared.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  selectHistoricalRun,
  selectHistoricalRunUnreachable,
  clearHistoricalRun,
  historicalSelection,
  renderLive,
  mergeBackendRows,
  condenseBackend,
  bRow,
  EVENT_KINDS,
  resetAutoSelect,
} from "./panels/live.js";
import { renderLedger } from "./panels/ledger.js";

const BASE_URL = "http://127.0.0.1:7718";
const RUN_DIR = "1788717847/local/omlx/model-a";
const SEL = { run_dir: RUN_DIR, sequence_index: 0, label: "base-a · model-a" };

/** The persisted /api/events envelope, in the shape control/server.mjs serves. */
const EVENTS = {
  connected: false,
  reason: "persisted",
  source: "agent-events.jsonl",
  attached: true,
  returned: 2,
  retained: 2,
  total: 2,
  counts: { tool: 1, file: 1, thinking: 0, error: 0, lifecycle: 0, harness: 0, user: 0 },
  events: [
    { seq: 1, kind: "tool", name: "run grades", detail: "okp-bench run --cell a1", at: 1788700000000 },
    { seq: 2, kind: "file", name: "wrote report", detail: "/tmp/okp/report.md", at: 1788700005000 },
  ],
};

/** The /api/backend-feed envelope. `ts` IS A NUMBER — control/backend-feed.mjs `toRow`. */
const BACKEND = {
  returned: 2,
  total: 2,
  sources: { live: { attached: true }, notices: { attached: true } },
  rows: [
    { ts: 1788700001000, kind: "gate.result", source: "harness", level: "info", event: "gate.result", detail: { id: "a" } },
    { ts: 1788699999000, kind: "notice", source: "sequencer", level: "warn", event: "cell.queued" },
  ],
  errors: [],
};

/** Stub fetch, recording every URL. Returns the two envelopes by path. */
function withFetch(fn, { events = EVENTS, backend = BACKEND } = {}) {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, json: async () => (String(url).includes("/api/events") ? events : backend) };
  };
  return Promise.resolve(fn(seen)).finally(() => { globalThis.fetch = real; });
}

test("selectHistoricalRun — the source switch", async (t) => {
  await t.test("reads BOTH feeds once, keyed on run_dir + sequence_index", async () => {
    await withFetch(async (seen) => {
      clearHistoricalRun();
      const read = await selectHistoricalRun(BASE_URL, SEL);
      assert.equal(read, true, "an actual read reports true");
      assert.equal(seen.length, 2, "exactly two reads, in parallel, once");
      const run = encodeURIComponent(RUN_DIR);
      assert.ok(seen.includes(`${BASE_URL}/api/events?run_dir=${run}&sequence_index=0`), "events URL carries the cell address");
      assert.ok(seen.includes(`${BASE_URL}/api/backend-feed?run_dir=${run}&sequence_index=0`), "backend URL carries the cell address");
      assert.deepEqual(historicalSelection(), SEL, "the selection is readable by the card that renders it");
    });
  });

  await t.test("re-selecting what is already shown re-reads nothing", async () => {
    await withFetch(async (seen) => {
      const read = await selectHistoricalRun(BASE_URL, { ...SEL });
      assert.equal(read, false);
      assert.equal(seen.length, 0, "a frozen record already on screen is not re-fetched");
    });
  });

  await t.test("clearing returns the card to the live cell", () => {
    clearHistoricalRun();
    assert.equal(historicalSelection(), null);
  });

  await t.test("an unaddressable cell is refused before any read", async () => {
    await withFetch(async (seen) => {
      for (const bad of [
        null,
        { run_dir: "", sequence_index: 0 },
        { run_dir: RUN_DIR, sequence_index: null },
        { run_dir: RUN_DIR, sequence_index: -1 },
      ]) {
        assert.equal(await selectHistoricalRun(BASE_URL, bad), false, JSON.stringify(bad));
      }
      assert.equal(await selectHistoricalRun(null, SEL), false, "no base url");
      assert.equal(seen.length, 0, "not one read was attempted");
      assert.equal(historicalSelection(), null, "and nothing was selected");
    });
  });

  await t.test("a stale read never lands on top of a newer choice", async () => {
    // The operator switched away — or went back to live — while the first read
    // was in flight. Landing it now shows a run nobody asked for.
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => ({
      ok: true,
      json: async () => {
        clearHistoricalRun();               // the switch, mid-flight
        return String(url).includes("/api/events") ? EVENTS : BACKEND;
      },
    });
    try {
      const read = await selectHistoricalRun(BASE_URL, SEL);
      assert.equal(read, false, "a read whose selection moved reports false");
      assert.equal(historicalSelection(), null, "and does not resurrect the abandoned selection");
    } finally {
      globalThis.fetch = real;
    }
  });
});

test("the card renders whichever source it is pointed at", async (t) => {
  const liveBoard = {
    run: { arm: "off", cell_label: "cell 0" },
    events: { connected: true, counts: {}, events: [], retained: 0, returned: 0, total: 0 },
    control: { base_url: BASE_URL },
    models_ledger: { run_in_flight: false },
  };

  await t.test("the card is named DATA FEED and names the live cell by default", () => {
    clearHistoricalRun();
    const html = renderLive(liveBoard);
    assert.ok(html.includes("DATA FEED"), "the card is DATA FEED, not LIVE RUN");
    assert.ok(html.includes("CELL 0") || html.includes("cell 0"), "the live cell is named");
    assert.ok(!html.includes("CONCLUDED"), "nothing claims a record is on screen");
    assert.ok(!html.includes("data-feed-live"), "no back-to-live control when already live");
  });

  await t.test("a selected record is NAMED and marked CONCLUDED, with a way back", async () => {
    await withFetch(async () => {
      await selectHistoricalRun(BASE_URL, SEL);
    });
    const html = renderLive(liveBoard);
    assert.ok(html.includes("base-a · model-a"), "the record is named on the card");
    assert.ok(html.includes("CONCLUDED — READ ONCE"), "and marked as a record, not a live feed");
    assert.ok(html.includes("data-feed-live"), "the way back to the live cell is offered");
    // The chips are drawn from the persisted counts, which the control plane now
    // TALLIES rather than zeroing — a concluded run's filters must populate.
    assert.ok(/tool\s*1/.test(html), "the tool chip carries its real count");
    assert.ok(/file\s*1/.test(html), "the file chip carries its real count");
  });

  await t.test("a run STARTING takes the card back — but only on the edge", async () => {
    // THE EDGE, NOT THE STATE. This cleared on every render while a cell ran, so
    // a record selected mid-run was wiped by the next 2s tick — the same
    // "fleeting and inconsistent" failure the toggling [feed] button caused. The
    // operator asked for the row to work "whether it's old or running now".
    await withFetch(async () => {
      clearHistoricalRun();
      resetAutoSelect();
      await selectHistoricalRun(BASE_URL, SEL);
    });
    assert.notEqual(historicalSelection(), null, "precondition: a record is selected");

    // Establish "not running", then transition into a run: that RECLAIMS.
    renderLive(liveBoard);
    renderLive({ ...liveBoard, models_ledger: { run_in_flight: true } });
    assert.equal(historicalSelection(), null, "the rising edge of a run takes the card");

    // Now select a record DURING the run and hold it across many renders.
    await withFetch(async () => { await selectHistoricalRun(BASE_URL, SEL); });
    const running = { ...liveBoard, models_ledger: { run_in_flight: true } };
    for (let k = 0; k < 5; k += 1) renderLive(running);
    assert.notEqual(historicalSelection(), null,
      "a record selected mid-run survives — the run is continuing, not starting");
    clearHistoricalRun();
    resetAutoSelect();
  });

  await t.test("an unreachable control plane states its reason on the card", () => {
    clearHistoricalRun();
    selectHistoricalRunUnreachable(SEL, "control_plane_not_reachable_from_here: opened at 192.168.1.9");
    const html = renderLive(liveBoard);
    assert.ok(html.includes("base-a · model-a"), "the attempted selection is still named");
    assert.ok(html.includes("CONCLUDED"), "the card admits which mode it is in");
    clearHistoricalRun();
  });
});

test("the BASELINE ROW is the feed selector, and it cannot un-select", async (t) => {
  // THE DEFECT THIS PINS. Selecting was a separate `[feed]` button that became
  // `SHOWING` wired to "return to live". So the control TOGGLED: with a record
  // auto-opened on load, pressing the button that NAMED this row closed it. The
  // operator saw the feed appear, pressed the thing labelled for it, and watched
  // it vanish — "its existence is fleeting and inconsistent", which it was.
  //
  // Selecting a baseline is now clicking the baseline. One affordance, one
  // readout, and exactly one way back (BACK TO LIVE, on the card).
  const row = {
    id: "base-a", model: "model-a", kind: "local", kind_label: "LOCAL",
    state: "complete", scorable: true, run_dir: RUN_DIR, sequence_index: 0,
    turns: 9, gates: { passed: 9, total: 9 }, runs: [], run_count: 0, best: null,
    can_run: { allowed: true, reason: null },
  };
  const board = (over = {}) => ({
    control: { base_url: BASE_URL, roster: null },
    models_ledger: { baseline_rows: [row], counts: { complete: 1, running: 0, void: 0 }, startable: [], run_in_flight: false, ...over },
  });

  await t.test("the row carries the selection, and no toggling button exists", () => {
    clearHistoricalRun();
    resetAutoSelect();
    const html = renderLedger(board());
    assert.ok(html.includes(`data-baseline-expand="base-a"`), "the ROW is the affordance");
    assert.ok(!html.includes("data-feed-run"), "no separate select button");
    assert.ok(!html.includes("data-feed-clear"), "and nothing on the row can un-select");
    assert.ok(!html.includes("SHOWING"), "the toggling label is gone");
  });

  await t.test("the selected row marks itself — a readout, not a control", async () => {
    await withFetch(async () => { await selectHistoricalRun(BASE_URL, SEL); });
    const html = renderLedger(board());
    assert.ok(html.includes("blfeed on"), "the row says the card is pointed at it");
    assert.ok(html.includes("feeding"), "and the row itself is marked");
    // Still not a control: the mark is a span, and the row keeps its own handler.
    assert.ok(!/<button[^>]*blfeed/.test(html), "the mark is never a button");
    clearHistoricalRun();
    resetAutoSelect();
  });

  await t.test("a running cell's row reads LIVE — its feed is the live one", () => {
    const html = renderLedger({
      control: { base_url: BASE_URL, roster: null },
      models_ledger: {
        baseline_rows: [{ ...row, state: "running", can_run: { allowed: false, reason: "still running" } }],
        counts: { complete: 0, running: 1, void: 0 }, startable: [], run_in_flight: true,
      },
    });
    assert.ok(html.includes("blfeed live"), "a running row points at the live feed, not a record");
    assert.ok(html.includes(`data-baseline-expand`), "and is still selectable — old OR running now");
  });

  await t.test("an unaddressable row says so and offers nothing", () => {
    const html = renderLedger({
      control: { base_url: BASE_URL, roster: null },
      models_ledger: {
        baseline_rows: [{ ...row, run_dir: null, sequence_index: null }],
        counts: { complete: 1, running: 0, void: 0 }, startable: [], run_in_flight: false,
      },
    });
    assert.ok(html.includes("blfeed none"), "a row that can address nothing marks itself");
  });
});

test("the paint signature changes with the SOURCE, not just the filters", async (t) => {
  // WHY THIS IS PINNED. `paintFeed` appends past a seq watermark rather than
  // rebuilding — a rebuild every poll resets scrollTop and makes "new"
  // undetectable. It rebuilds only when the signature changes, a FORWARD seq gap
  // appears, or seqs run BACKWARD. Two frozen records are each numbered from
  // their own session, so if the incoming one's seqs happen to sit above what is
  // already painted, none of those three fire — and the card splices two
  // different runs into one list with nothing on screen saying so.
  //
  // `sigOf` is module-private, so this asserts on the observable consequence:
  // the note and the subtitle both re-derive per source, and the card can name
  // which record it is on. The signature carrying the source key is what makes
  // the paint agree with them.
  const liveBoard = {
    run: { arm: "off", cell_label: "cell 0" },
    events: { connected: true, counts: {}, events: [], retained: 0, returned: 0, total: 0 },
    control: { base_url: BASE_URL },
    models_ledger: { run_in_flight: false },
  };

  await t.test("switching records re-points the card, and says so", async () => {
    await withFetch(async () => {
      clearHistoricalRun();
      await selectHistoricalRun(BASE_URL, SEL);
    });
    assert.ok(renderLive(liveBoard).includes("base-a · model-a"));

    const other = { run_dir: "1788717847/local/omlx/model-b", sequence_index: 3, label: "base-b · model-b" };
    await withFetch(async (seen) => {
      const read = await selectHistoricalRun(BASE_URL, other);
      assert.equal(read, true, "a DIFFERENT record is a real read, never a cache hit");
      assert.equal(seen.length, 2, "and it re-reads both feeds");
    });
    const html = renderLive(liveBoard);
    assert.ok(html.includes("base-b · model-b"), "the card names the record it switched to");
    assert.ok(!html.includes("base-a · model-a"), "and stops naming the one it left");
    assert.deepEqual(historicalSelection(), other);
    clearHistoricalRun();
  });

  await t.test("a complete record is never described as capped", async () => {
    await withFetch(async () => {
      clearHistoricalRun();
      await selectHistoricalRun(BASE_URL, SEL);
    });
    const html = renderLive(liveBoard);
    // "cap 400" is the LIVE path's server-side window. The persisted read does
    // not apply it — it answers with the whole transcript — so claiming a cap
    // over a complete record is a false statement about the rows on screen.
    assert.ok(!html.includes("cap 400"), "the live cap sentence must not ride a frozen record");
    assert.ok(html.includes("complete record"), "the record says what it is");
    clearHistoricalRun();
  });
});

test("mergeBackendRows — the union that feeds both sources", async (t) => {
  await t.test("dedupes on the RECORD, not on a time bucket", () => {
    // THE DEFECT THIS PINS. The key was `ts|kind|source|event`, which is not an
    // identity: a gate suite reports every result in the same millisecond, from
    // one source, under one event name, differing ONLY in detail. Measured on a
    // real run, 600 records collapsed to 53 — and the header went on saying 600.
    const gate = (id) => ({ ts: 1788700000000, kind: "gate.result", source: "harness", level: "info", event: "gate.result", detail: { id } });
    const merged = mergeBackendRows({ rows: [gate("a"), gate("b"), gate("c")], errors: [] });
    assert.equal(merged.length, 3, "three distinct gate results are three rows");
  });

  await t.test("a record on BOTH lists renders once", () => {
    const err = { ts: 1788700002000, kind: "notice", source: "control", level: "error", event: "cell.failed", detail: { why: "x" } };
    const merged = mergeBackendRows({ errors: [err], rows: [{ ...err }] });
    assert.equal(merged.length, 1, "one failure must not look like two");
  });

  await t.test("oldest first, by numeric ts", () => {
    const merged = mergeBackendRows({
      errors: [],
      rows: [
        { ts: 1788700005000, kind: "notice", source: "control", level: "info", event: "late" },
        { ts: 1788700001000, kind: "notice", source: "control", level: "info", event: "early" },
      ],
    });
    assert.deepEqual(merged.map((r) => r.event), ["early", "late"]);
  });
});

test("condenseBackend — the birds-eye view", async (t) => {
  const gate = (id, status, ts = 1788700010000) => ({
    ts, kind: "gate.result", source: "harness", level: "info", event: "gate.result",
    detail: { id, status, phase: "conformance", duration_ms: 3 },
  });
  const phase = (p, ts) => ({ ts, kind: "phase.start", source: "harness", level: "info", event: "phase.start", detail: { phase: p } });
  const attempt = (n, ts) => ({ ts, kind: "attempt.end", source: "harness", level: "info", event: "attempt.end", detail: { attempt: n, verdict: "FAIL" } });
  const dur = (ts) => ({ ts, kind: "notice", source: "gates", level: "info", event: "gate_phase_duration", detail: { phase: "conformance", duration_ms: 10412 } });
  const warn = (ts) => ({ ts, kind: "notice", source: "harness", level: "warn", event: "turn_truncated_retried", detail: { phase: "initial-chunk-6" } });

  await t.test("gate results fold into the attempt that closed them", () => {
    const groups = condenseBackend([
      phase("initial-chunk-1", 1788700000000),
      gate("a", "pass"), gate("b", "fail"), gate("c", "pass"),
      attempt(1, 1788700020000),
      phase("feedback-1", 1788700030000),
    ]);
    assert.deepEqual(groups.map((g) => g.row.kind), ["phase.start", "attempt.end", "phase.start"]);
    assert.equal(groups[1].children.length, 3, "all three gates hang off attempt 1");
    assert.equal(groups[0].children.length, 0);
    assert.equal(groups[2].children.length, 0);
  });

  await t.test("the ruling: gate_phase_duration stays TOP-LEVEL, never folded", () => {
    // Grading slowness is a thing to watch at a glance, so it keeps its own row
    // rather than becoming a detail inside an attempt.
    const groups = condenseBackend([dur(1788700005000), gate("a", "pass"), attempt(1, 1788700020000)]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].row.event, "gate_phase_duration", "the duration notice is its own row");
    assert.equal(groups[0].children.length, 0);
    assert.equal(groups[1].children.length, 1, "only the gate folded");
  });

  await t.test("warnings stay top-level — they are the red flags being looked for", () => {
    const groups = condenseBackend([warn(1788700001000), gate("a", "pass"), attempt(1, 1788700020000)]);
    assert.equal(groups[0].row.event, "turn_truncated_retried");
    assert.equal(groups[0].row.level, "warn");
  });

  await t.test("gates with no attempt after them are kept, not dropped", () => {
    // A cell still grading, or one that died mid-attempt. Losing rows because a
    // run ended untidily would hide exactly the run worth looking at.
    const groups = condenseBackend([phase("p", 1788700000000), gate("a", "pass"), gate("b", "pass")]);
    assert.equal(groups.length, 2);
    assert.equal(groups[1].open_group, true);
    assert.equal(groups[1].children.length, 2, "the orphaned gates survive");
  });

  await t.test("a 585-gate run condenses to its structural records", () => {
    // The measured shape of a real 2h19m cell: 585 gate results across 5
    // attempts, plus 45 records that say what the harness did.
    const rows = [];
    for (let a = 1; a <= 5; a += 1) {
      for (let g = 0; g < 117; g += 1) rows.push(gate(`gate-${a}-${g}`, g < 112 ? "pass" : "fail", 1788700000000 + a * 1000));
      rows.push(attempt(a, 1788700000000 + a * 1000 + 500));
    }
    assert.equal(rows.length, 590);
    const groups = condenseBackend(rows);
    assert.equal(groups.length, 5, "590 records read as five attempts");
    assert.equal(groups.reduce((n, g) => n + g.children.length, 0), 585, "and not one gate is discarded");
  });
});

test("bRow / bBody — expandable, and the whole record", async (t) => {
  const rec = { ts: 1788700010000, kind: "notice", source: "harness", level: "warn", event: "turn_truncated_retried", detail: { phase: "initial-chunk-6", terminal: "length" } };

  await t.test("every row is clickable, not just the folded ones", () => {
    // The operator does not yet know which fields matter — that is why the feed
    // is being read — so the full record is one click away on EVERY row.
    const html = bRow(rec, { children: [], open: false, groupKey: "k" });
    assert.ok(html.includes('role="button"'), "an ordinary record is still expandable");
    assert.ok(html.includes('data-bkey="k"'), "and carries a stable identity across rebuilds");
    assert.ok(html.includes('aria-expanded="false"'));
  });

  await t.test("expanding shows the record VERBATIM, not a curated subset", () => {
    const html = bRow(rec, { children: [], open: true, groupKey: "k" });
    assert.ok(html.includes("the record, verbatim"));
    assert.ok(html.includes("initial-chunk-6"), "a nested detail field survives");
    assert.ok(html.includes("terminal"), "and so does one nothing on screen summarised");
  });

  await t.test("a folded attempt summarises pass/fail and lists its gates on expand", () => {
    const kids = [
      { ts: 1, kind: "gate.result", source: "harness", level: "info", detail: { id: "g1", status: "pass", duration_ms: 3 } },
      { ts: 1, kind: "gate.result", source: "harness", level: "info", detail: { id: "g2", status: "fail", duration_ms: 9 } },
    ];
    const closed = bRow({ ...rec, kind: "attempt.end", event: "attempt.end" }, { children: kids, open: false, groupKey: "a" });
    assert.ok(closed.includes("2 gates · 1 pass · 1 fail"), "the summary carries both axes");
    assert.ok(!closed.includes("g1"), "the gates are not rendered while collapsed");

    const open = bRow({ ...rec, kind: "attempt.end", event: "attempt.end" }, { children: kids, open: true, groupKey: "a" });
    assert.ok(open.includes("g1") && open.includes("g2"), "both gates render on expand");
    assert.ok(open.includes('data-status="fail"'), "and a failing gate is findable by one column");
  });
});

test("a dead stream must not swallow the rows the feed already holds", async (t) => {
  // THE DEFECT THIS PINS, observed on an idle bench. No cell is running, so the
  // worker's event stream is unreachable and `connected` is false — but the
  // prompts are rebuilt from files and admitted anyway. The chip counted
  // `user 10` and the box beneath it drew the disconnection note and NONE of
  // them: a surface contradicting itself in two adjacent elements.
  //
  // A dead upstream is a fact about the STREAM, not about rows already held.

  await t.test("EVENT_KINDS no longer offers a chip that is structurally always 0", () => {
    // `harness` rows moved to the backend feed (they are what the harness did,
    // and they carried no timestamp). A chip counting a kind this feed can never
    // contain reads as "this never happens", which is a claim, not an absence.
    assert.ok(!EVENT_KINDS.includes("harness"), "the harness chip is gone with its rows");
    assert.ok(EVENT_KINDS.includes("user"), "the prompts keep theirs");
    assert.deepEqual(EVENT_KINDS, ["tool", "file", "thinking", "error", "lifecycle", "user"]);
  });

  await t.test("the disconnection banner is MARKED so it cannot force a rebuild", async () => {
    // `paintFeed` treats any `.null` in the box as "this is showing a note,
    // rebuild now that there are rows". The banner is permanent while the stream
    // is down, so an unmarked one would rebuild on every 2s poll — resetting
    // scrollTop and destroying the append watermark that makes "new" detectable.
    const src = await readFile(new URL("./panels/live.js", import.meta.url), "utf8");
    assert.match(src, /class="null pad danger feed-banner"/, "the banner carries its own class");
    assert.match(
      src,
      /querySelector\("\.null:not\(\.feed-banner\)"\)/,
      "and the stale check excludes it",
    );
    // And it is prepended to BOTH render paths, not just one.
    assert.match(src, /box\.innerHTML = banner \+ rows\.map/, "the row path carries the banner");
    assert.match(src, /box\.innerHTML = banner \+ padNote/, "the empty path carries it too");
  });

  await t.test("an idle bench does not claim it is connected", async () => {
    const src = await readFile(new URL("./panels/live.js", import.meta.url), "utf8");
    // "connected, no events yet" printed under a banner that has just said the
    // stream is down asserts the opposite of the line above it.
    assert.match(src, /no events were retained before the stream dropped/);
  });

  await t.test("the export button is not a bare .chip", async () => {
    // `.chip` alone sets only font and colour, so on a <button> it inherits the
    // UA's white background — the exact defect the filter chips were fixed for.
    const src = await readFile(new URL("./panels/live.js", import.meta.url), "utf8");
    assert.match(src, /class="chip fexport"/, "the export button carries a styled variant");
    const css = await readFile(new URL("./index.html", import.meta.url), "utf8");
    assert.match(css, /\.chip\.fexport\{[^}]*background:transparent/, "and that variant declares a background");
  });
});

test("an idle bench must not impersonate the run that just finished", async (t) => {
  // THE DEFECT THIS PINS, and it cost three rounds of the operator saying "the
  // historical feed is empty" while the historical endpoint was serving 4,322
  // rows correctly the whole time.
  //
  // `activeRunDir()` resolves the NEWEST run directory whether or not anything
  // is running. So on an idle bench the LIVE feed reached into the last
  // CONCLUDED run, served its 10 prompts as live rows, and printed that finished
  // cell's name in the card's subtitle. The result read exactly like a broken
  // historical feed: `tool 0 · file 0 · thinking 0 · error 0 · lifecycle 0 ·
  // user 10` under a heading naming the run whose record was supposedly on
  // screen. Nothing was broken; the card was showing the wrong source.

  await t.test("the server only merges prompts while a cell is IN FLIGHT", async () => {
    const src = await readFile(new URL("../control/server.mjs", import.meta.url), "utf8");
    assert.match(src, /const cellInFlight = liveRunState\.can_start !== true;/,
      "the live branch resolves whether a cell is actually running");
    assert.match(src, /if \(cellInFlight\) \{\s*\n\s*try \{\s*\n\s*const fb = await readFeedback/,
      "and the feedback read is gated on it");
    assert.match(src, /cell_in_flight: cellInFlight,/,
      "and the fact is reported so the card can render the right idle state");
  });

  await t.test("an idle feed is not drawn as a fault", () => {
    // `connected:false` is equally true for a crashed run and an idle bench, and
    // those want opposite words on screen.
    const board = {
      run: { state: "complete", arm: "off" },
      control: { base_url: BASE_URL },
      models_ledger: { run_in_flight: false },
      events: { connected: false, reason: "event feed disconnected: fetch failed", cell_in_flight: false, events: [], counts: {}, retained: 0, returned: 0, total: 0 },
    };
    clearHistoricalRun();
    const html = renderLive(board);
    // The subtitle must not name the concluded cell as though it were live.
    assert.ok(html.includes("no cell running"), "the card says no cell is running");
    assert.ok(!/qwen|-0000/.test(html), "and does not name a finished cell as the live one");
  });

  await t.test("a genuinely dropped stream still reads as a fault", () => {
    // The banner must NOT be suppressed for a run that was live and died —
    // `cell_in_flight: true` with `connected: false` is a real failure.
    const board = {
      run: { state: "running", arm: "off", cell_label: "cell 0" },
      control: { base_url: BASE_URL },
      models_ledger: { run_in_flight: true },
      events: { connected: false, reason: "socket hang up", cell_in_flight: true, events: [], counts: {}, retained: 0, returned: 0, total: 0 },
    };
    clearHistoricalRun();
    const html = renderLive(board);
    assert.ok(html.includes("cell 0"), "a running cell IS named");
    assert.ok(!html.includes("no cell running"), "and is not reported as idle");
  });
});

test("the PAINT path runs — the class of bug the suite could not see", async (t) => {
  // WHY THIS EXISTS. `paintFeed` and `paintBackend` touch the DOM, so nothing in
  // this suite ever executed them: every other test drives the pure render
  // functions. A `const idle = …` that went missing while the code USING it
  // landed therefore passed `node --check`, passed 311 tests, and threw
  // `idle is not defined` the moment a real browser painted the feed — leaving
  // the operator looking at a card that silently stopped updating.
  //
  // A minimal fake element is enough: the point is that the functions EXECUTE,
  // not that the markup is inspected (the pure renderers above cover that).
  const { paintFeed, paintBackend } = await import("./panels/live.js");

  function fakeBox() {
    return {
      innerHTML: "", scrollTop: 0, scrollHeight: 100, clientHeight: 50,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      dataset: {},
    };
  }
  const boxes = { "sc-events": fakeBox(), "sc-backend": fakeBox() };
  const realDoc = globalThis.document;
  globalThis.document = { getElementById: (id) => boxes[id] ?? null };

  try {
    const board = {
      run: { state: "complete", arm: "off" },
      control: { base_url: BASE_URL },
      models_ledger: { run_in_flight: false },
      events: { connected: false, reason: "fetch failed", cell_in_flight: false, events: [], counts: {}, retained: 0, returned: 0, total: 0 },
    };

    await t.test("an idle live feed paints without throwing", () => {
      clearHistoricalRun();
      paintFeed(board);
      assert.ok(boxes["sc-events"].innerHTML.includes("no cell is running"),
        "and reaches the idle branch that the missing binding guarded");
      assert.ok(!boxes["sc-events"].innerHTML.includes("disconnected"),
        "an idle bench is not reported as a dropped stream");
    });

    await t.test("a dropped stream during a live cell paints its banner", () => {
      paintFeed({ ...board, events: { ...board.events, cell_in_flight: true } });
      assert.ok(boxes["sc-events"].innerHTML.includes("feed-banner"), "the fault banner is drawn");
    });

    await t.test("a loaded historical record paints its rows", async () => {
      await withFetch(async () => {
        clearHistoricalRun();
        await selectHistoricalRun(BASE_URL, SEL);
      });
      paintFeed(board);
      const html = boxes["sc-events"].innerHTML;
      assert.ok(html.includes("run grades"), "the record's rows reach the box");
      assert.ok(!html.includes("feed-banner"), "a complete record carries no disconnection banner");
    });

    await t.test("the backend feed paints its condensed rows", () => {
      paintBackend();
      assert.ok(boxes["sc-backend"].innerHTML.includes("bkrow"), "backend rows are drawn");
      clearHistoricalRun();
    });
  } finally {
    globalThis.document = realDoc;
  }
});

test("with nothing live, the last concluded run opens by itself", async (t) => {
  // THE DEAD END THIS REMOVES. Gating the record behind [feed] was correct and
  // useless: the bench's resting state is "one concluded run, nothing running",
  // so the default view was an empty box explaining where the data it could have
  // shown lives. The record opens instead — still marked CONCLUDED, still
  // switchable, still dropped the moment a cell starts.
  const row = {
    id: "base-a", model: "model-a", state: "complete",
    run_dir: RUN_DIR, sequence_index: 0,
  };
  const board = (over = {}) => ({
    run: { state: "complete" },
    control: { base_url: BASE_URL },
    events: { connected: false, cell_in_flight: false, events: [], counts: {}, retained: 0, returned: 0, total: 0 },
    models_ledger: { run_in_flight: false, baseline_rows: [row] },
    ...over,
  });

  await t.test("an idle board selects the newest complete baseline", async () => {
    clearHistoricalRun();
    resetAutoSelect();
    await withFetch(async (seen) => {
      renderLive(board());                 // fire-and-forget
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(seen.length, 2, "both feeds are read, once");
    });
    assert.deepEqual(historicalSelection(), { run_dir: RUN_DIR, sequence_index: 0, label: "base-a · model-a" });
  });

  await t.test("it does not re-fire on every render", async () => {
    await withFetch(async (seen) => {
      renderLive(board());
      renderLive(board());
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(seen.length, 0, "a selection already made is not re-read");
    });
  });

  await t.test("BACK TO LIVE is not undone a moment later", async () => {
    clearHistoricalRun();                  // the operator's own act
    await withFetch(async (seen) => {
      renderLive(board());
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(seen.length, 0, "the auto-select stands down");
    });
    assert.equal(historicalSelection(), null, "and the card stays on live");
  });

  await t.test("but a run lifts the stand-down, so the NEXT one opens again", async () => {
    // "I pressed BACK TO LIVE" describes the record on screen then, not a
    // permanent preference.
    renderLive(board({ models_ledger: { run_in_flight: true, baseline_rows: [row] } }));
    await withFetch(async (seen) => {
      renderLive(board());
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(seen.length, 2, "after a cell has run, the record opens by itself again");
    });
    clearHistoricalRun();
    resetAutoSelect();
  });

  await t.test("a live cell is never displaced by a record", async () => {
    clearHistoricalRun();
    resetAutoSelect();
    await withFetch(async (seen) => {
      renderLive(board({ events: { connected: true, cell_in_flight: true, events: [], counts: {}, retained: 0, returned: 0, total: 0 } }));
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(seen.length, 0, "nothing is auto-selected over a running cell");
    });
    assert.equal(historicalSelection(), null);
  });

  await t.test("a bench with no concluded record says so, and does not claim a cap", async () => {
    clearHistoricalRun();
    resetAutoSelect();
    await withFetch(async (seen) => {
      renderLive(board({ models_ledger: { run_in_flight: false, baseline_rows: [] } }));
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(seen.length, 0, "nothing to open, nothing read");
    });
    const html = renderLive(board({ models_ledger: { run_in_flight: false, baseline_rows: [] } }));
    assert.ok(!html.includes("cap 400"), "an idle feed does not state a window it is not applying");
    assert.ok(html.includes("nothing running"));
    clearHistoricalRun();
    resetAutoSelect();
  });
});
