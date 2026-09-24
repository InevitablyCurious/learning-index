// THE DATA FEED CARD — one subject: the cell the strip points at.
//
// ONE READ FOR EVERY CELL. The card shows the cell panels/cells.js activeCell
// names (the operator's pick, else the newest live run, else the first card),
// read by (run_dir, sequence_index) — running or ended, the same read. The
// strip's cards come from board.runs; liveness is the card's stated status.
// A running cell is re-read on a timer; an ended one once more after it ends.
//
// THE DEFECT THIS FILE REPLACED. The card had its own selection: a live ring for
// "the" running cell, BASELINES rows for a concluded one, BACK TO LIVE between
// them. With N concurrent cells the ring held every cell's rows at once, and the
// strip's click moved the TUI but not this card — two subjects on one page.
//
// Module state (panels/live/state.js, panels/cells.js) persists across tests in
// this file, so each subtest establishes the state it asserts on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  feedSelection,
  readCell,
  renderLive,
  mergeBackendRows,
  condenseBackend,
  bRow,
  EVENT_KINDS,
} from "./panels/live.js";
import { hist, setHist } from "./panels/live/state.js";
import { setSelectedCell } from "./panels/cells.js";
import { renderLedger } from "./panels/ledger.js";

const RUN_DIR = "1788717847/local/omlx/model-a";
// board.runs cards: liveness is the STATED status, never a derived flag.
const ENDED = { run_dir: RUN_DIR, sequence_index: 0, archived: false, status: "scored" };
const LIVE = { run_dir: RUN_DIR, sequence_index: 1, archived: false, status: "live" };

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
    { seq: 1, kind: "tool", name: "run grades", detail: "bench run --cell a1", at: 1788700000000 },
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

/** A board whose strip holds `list`; the control plane reachable unless said. */
function boardWith(list, over = {}) {
  return {
    control: {},
    events: { connected: true, reason: null },
    runs: { list },
    models_ledger: { run_in_flight: list.some((c) => c.status === "live") },
    ...over,
  };
}

/** Forget every selection this file makes. */
function reset() {
  setHist(null);
  setSelectedCell(null);
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const url = (kind, c) => `/api/${kind}?run_dir=${encodeURIComponent(c.run_dir)}&sequence_index=${c.sequence_index}`;

test("the card follows the cell strip", async (t) => {
  await t.test("with no cell there is nothing to read, and the card says so", async () => {
    reset();
    await withFetch(async (seen) => {
      const html = renderLive(boardWith([]));
      await tick();
      assert.equal(seen.length, 0, "nothing is read");
      assert.ok(html.includes("no cell to show"), "the card names the absence");
      assert.equal(feedSelection(), null);
    });
  });

  await t.test("by default it reads the newest RUNNING cell, keyed on its address", async () => {
    reset();
    await withFetch(async (seen) => {
      renderLive(boardWith([ENDED, LIVE]));
      await tick();
      assert.deepEqual(seen.sort(), [url("backend-feed", LIVE), url("events", LIVE)]);
    });
    const html = renderLive(boardWith([ENDED, LIVE]));
    assert.ok(html.includes("s0001"), "the card names the cell");
    assert.ok(html.includes("feed-live"), "and marks it LIVE");
  });

  await t.test("picking a card re-points the card — no second selector, no BACK TO LIVE", async () => {
    setSelectedCell(`${RUN_DIR}::0`);
    await withFetch(async (seen) => {
      renderLive(boardWith([ENDED, LIVE]));
      await tick();
      assert.deepEqual(seen.sort(), [url("backend-feed", ENDED), url("events", ENDED)]);
    });
    const html = renderLive(boardWith([ENDED, LIVE]));
    assert.ok(html.includes("s0000"), "the picked cell is named");
    assert.ok(html.includes("ENDED — COMPLETE RECORD"), "and marked as a complete record");
    assert.ok(!html.includes("data-feed-live") && !html.includes("BACK TO LIVE"), "there is no way 'back' — the strip is the one control");
    assert.ok(/tool\s*1/.test(html), "the chips carry the record's real counts");
  });

  await t.test("a running cell is re-read when due; an ended one is not", async () => {
    reset();
    await withFetch(async () => { renderLive(boardWith([LIVE])); await tick(); });
    hist.at = 0; // due
    await withFetch(async (seen) => {
      renderLive(boardWith([LIVE]));
      await tick();
      assert.equal(seen.length, 2, "a running cell is re-read");
    });
    // It ends: exactly one more read (rows written after the last poll), then none.
    const ended = { ...LIVE, status: "scored" };
    hist.at = 0;
    await withFetch(async (seen) => {
      renderLive(boardWith([ended]));
      await tick();
      assert.equal(seen.length, 2, "one read after the cell ends");
    });
    hist.at = 0;
    await withFetch(async (seen) => {
      renderLive(boardWith([ended]));
      await tick();
      assert.equal(seen.length, 0, "and then the record is complete");
    });
  });

  await t.test("a read for a cell the card has left never lands", async () => {
    reset();
    setHist({ sel: { ...ENDED, label: "s0000" }, loading: true, at: 0 });
    const stale = { ...LIVE, label: "s0001" };
    await withFetch(async () => {
      assert.equal(await readCell(stale), false, "a read for another cell reports false");
    });
    assert.equal(feedSelection().sequence_index, 0, "and the card keeps its cell");
  });

  await t.test("an unreachable control plane states its reason and reads nothing", async () => {
    reset();
    await withFetch(async (seen) => {
      renderLive(boardWith([LIVE], { control: null, sources: [{ id: "control-plane", reason: "timed out" }] }));
      await tick();
      assert.equal(seen.length, 0);
    });
    assert.equal(hist.events.ok, false);
    assert.match(hist.events.reason, /control_plane_unreachable: timed out/);
    reset();
  });

  await t.test("a complete record is never described as capped", async () => {
    reset();
    await withFetch(async () => { renderLive(boardWith([ENDED])); await tick(); });
    const html = renderLive(boardWith([ENDED]));
    assert.ok(!html.includes("cap 400"), "no window is claimed over a whole record");
    assert.ok(html.includes("complete record"));
    reset();
  });
});

test("a BASELINES row expands and marks — it never selects the feed", async (t) => {
  const row = {
    id: "base-a", model: "model-a", kind: "local", kind_label: "LOCAL",
    state: "complete", scorable: true, run_dir: RUN_DIR, sequence_index: 0,
    turns: 9, gates: { passed: 9, total: 9 }, runs: [], run_count: 0, best: null,
    can_run: { allowed: true, reason: null },
  };
  const ledgerBoard = (over = {}) => ({
    control: { roster: null },
    models_ledger: { baseline_rows: [row], counts: { complete: 1, running: 0, void: 0 }, startable: [], run_in_flight: false, ...over },
  });

  await t.test("the row is an expander with no feed control on it", () => {
    reset();
    const html = renderLedger(ledgerBoard());
    assert.ok(html.includes(`data-baseline-expand="base-a"`));
    assert.ok(!/data-feed-(run|clear|live)/.test(html), "no feed selector or way back on the row");
  });

  await t.test("the row whose cell the card shows says FEED — a readout, not a control", async () => {
    reset();
    await withFetch(async () => { renderLive(boardWith([ENDED])); await tick(); });
    const html = renderLedger(ledgerBoard());
    assert.ok(html.includes("blfeed on"));
    assert.ok(!/<button[^>]*blfeed/.test(html), "the mark is never a button");
    reset();
  });

  await t.test("a running row reads LIVE", () => {
    const html = renderLedger(ledgerBoard({
      baseline_rows: [{ ...row, state: "running", can_run: { allowed: false, reason: "still running" } }],
      counts: { complete: 0, running: 1, void: 0 }, run_in_flight: true,
    }));
    assert.ok(html.includes("blfeed live"));
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

test("the server only merges live prompts while a cell is IN FLIGHT", async () => {
  // `activeRunDir()` resolves the NEWEST run directory whether or not anything
  // is running; on an idle bench the live path once served a finished cell's
  // prompts as live rows. The gate stays with the handler.
  const src = await readFile(new URL("../control/routes/events.mjs", import.meta.url), "utf8");
  assert.match(src, /const cellInFlight = liveRunState\.can_start !== true;/);
  assert.match(src, /if \(cellInFlight\) \{\s*\n\s*try \{\s*\n\s*const fb = await readFeedback/);
  assert.match(src, /cell_in_flight: cellInFlight,/);
});

test("the PAINT path runs — the class of bug the suite could not see", async (t) => {
  // `paintFeed` and `paintBackend` touch the DOM, so the pure-render tests never
  // execute them; a missing binding once passed every test and threw in the
  // browser. A minimal fake element is enough to make them run.
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
    await t.test("no cell paints the absence, not a fault", () => {
      reset();
      paintFeed(boardWith([]));
      assert.ok(boxes["sc-events"].innerHTML.includes("no cell to show"));
      assert.ok(!boxes["sc-events"].innerHTML.includes("feed-banner"), "an empty bench is not a dropped stream");
    });

    await t.test("a running cell whose stream dropped paints its banner", async () => {
      reset();
      const board = boardWith([LIVE], { events: { connected: false, reason: "socket hang up" } });
      await withFetch(async () => { renderLive(board); await tick(); }, { events: { ...EVENTS, events: [], retained: 0, returned: 0 } });
      paintFeed(board);
      assert.ok(boxes["sc-events"].innerHTML.includes("feed-banner"), "the fault banner is drawn");
    });

    await t.test("an ended cell paints its rows with no banner", async () => {
      reset();
      const board = boardWith([ENDED], { events: { connected: false, reason: "no cell is running" } });
      await withFetch(async () => { renderLive(board); await tick(); });
      paintFeed(board);
      const html = boxes["sc-events"].innerHTML;
      assert.ok(html.includes("run grades"), "the record's rows reach the box");
      assert.ok(!html.includes("feed-banner"), "a complete record carries no disconnection banner");
    });

    await t.test("an ended cell with an empty record says no transcript was captured", async () => {
      reset();
      const board = boardWith([ENDED]);
      await withFetch(async () => { renderLive(board); await tick(); }, { events: { ...EVENTS, events: [], retained: 0, returned: 0 } });
      paintFeed(board);
      assert.ok(boxes["sc-events"].innerHTML.includes("no transcript was captured"));
    });

    await t.test("the backend feed paints its condensed rows", async () => {
      reset();
      await withFetch(async () => { renderLive(boardWith([ENDED])); await tick(); });
      paintBackend();
      assert.ok(boxes["sc-backend"].innerHTML.includes("bkrow"), "backend rows are drawn");
      reset();
    });
  } finally {
    globalThis.document = realDoc;
  }
});
