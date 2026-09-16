// ─────────────────────────────────────────────────────────────────────────────
// GATE WALL — the dumb component stays dumb
//
//     cd bench/dashboard && node --test
//
// WHY THIS EXISTS
//
// The wall grew from 124 lines to 681 across five sessions. Every addition was
// individually defensible — an attempt axis, a live amber pulse, an abandoned
// state, a phase-set disclosure, a three-axis choreography — and together they
// made a panel that decided more about a gate than the grader did. This file
// pins it back down.
//
// WHAT IT PINS
//
//  1. THREE STATES REACH THE SCREEN, and only three: passing, failing,
//     untested. Any other `state` the server could ever send renders as
//     untested, never as a pass.
//  2. TWO COLOURS. green and red are the only fills. No blue, no amber, no
//     slate — those were the attempt axis and the live signal, and both are
//     gone.
//  3. NO PHASE ANYWHERE. Not in the markup, not in the classes, not in the
//     prose. A gate's phase is not a fact about its result.
//  4. NO MOTION. The wall never animates, so nothing on it can be read as
//     "still working" — the panel has no live signal to report.
//  5. UNTESTED IS NOT A WEAKER PASS. It renders distinctly from green, and the
//     headline never counts it toward passing.
//  6. THE DENOMINATOR IS NEVER FABRICATED. `total: null` says so in words and
//     never prints 0.
//  7. SLOTS NEVER REFLOW: slot count and order are byte-stable as states change.
//
// THE DOM STUB. `board.js` is both the browser entry point and the module that
// exports `esc`/`nul`/`clip`, so importing any panel executes its listener
// registration and first paint. The stub below is the smallest thing that lets
// a pure string builder be tested in node; it asserts nothing and stands in for
// no behaviour.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const noop = () => {};
const stubEl = () => ({
  innerHTML: "",
  style: {},
  classList: { add: noop, remove: noop },
  appendChild: noop,
  addEventListener: noop,
  childNodes: [],
  content: { childNodes: [] },
});
globalThis.document = {
  addEventListener: noop,
  getElementById: stubEl,
  createElement: stubEl,
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { appendChild: noop },
};
globalThis.window = {
  addEventListener: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop }),
};
globalThis.setInterval = noop;

const { renderWall, gateVisual, wallColumns } = await import("./panels/wall.js");

// ── fixtures ────────────────────────────────────────────────────────────────
//
// Shaped from the REAL /api/wall payload (control/wall.mjs foldGateStates):
// `id`/`req`/`title` plus a server-decided `state`, and nothing else. If a
// fixture here needs a field the server does not send, the panel is deriving.

const GATES = [
  { id: "C:a", req: "REQ-STATE", title: "passing", state: "passing" },
  { id: "C:b", req: "REQ-STATE", title: "also passing", state: "passing" },
  { id: "C:c", req: "REQ-MOVE", title: "failing", state: "failing" },
  { id: "C:d", req: "REQ-MOVE", title: "also failing", state: "failing" },
  { id: "C:e", req: "REQ-DBL", title: "not yet tested", state: "untested" },
];

const suiteWith = (gates, over = {}) => ({
  ok: true,
  contract_version: 2,
  run_dir: "cumulative",
  suite_source: "run",
  suite: { total: gates.length, fingerprint: "fp", complete: true, incomplete_reason: null, captured_at: null },
  attempt: 2,
  gates,
  totals: {
    passing: gates.filter((g) => g.state === "passing").length,
    failing: gates.filter((g) => g.state === "failing").length,
    untested: gates.filter((g) => g.state === "untested").length,
  },
  unwired: [],
  unwired_reasons: {},
  ...over,
});

const boardWith = (suite) => ({ suite });

/** Every `class="..."` value appearing on a grid square. */
function cellClassList(html) {
  return [...html.matchAll(/<span class="gcell ([^"]*)"/g)].map((m) => m[1].trim());
}

// ── 1 & 2. three states, two colours ────────────────────────────────────────

test("passing is green, failing is red, untested is the uncoloured square", () => {
  assert.equal(gateVisual({ state: "passing" }), "green");
  assert.equal(gateVisual({ state: "failing" }), "red");
  assert.equal(gateVisual({ state: "untested" }), "unobserved");
});

test("only the five published visual classes can ever reach a square", () => {
  // Was three, then four. `recovered` splits the PASSING square by trajectory;
  // `instrument` splits the UNMEASURED square by whether the runner stated a
  // cause. NEITHER is a new verdict — `state` is still the only thing that
  // decides pass/fail, and an instrument-faulted gate has neither passed nor
  // failed.
  const gates = [
    ...GATES,
    { id: "C:f", req: "REQ-DBL", title: "green eventually", state: "passing", first_pass_attempt: 3, ever_failed: true },
    { id: "C:g", req: "REQ-DIED", title: "worker died", state: "untested", unmeasured_cause: "runner_died" },
  ];
  const html = renderWall(boardWith(suiteWith(gates)));
  const classes = new Set(cellClassList(html).map((c) => c.replace(/\s*sm\s*/, "")));
  assert.deepEqual([...classes].sort(), ["green", "instrument", "recovered", "red", "unobserved"]);
});

test("an instrument fault is drawn apart from a gate nobody reached", () => {
  // THE DEFECT THIS EXISTS FOR. Four gates went blank because a grading worker
  // was killed mid-file, and they rendered exactly like four gates the runner
  // had not got to yet — so a killed worker passed for an ordinary early-run
  // wall, three attempts running.
  assert.equal(gateVisual({ state: "untested", unmeasured_cause: "runner_died" }), "instrument");
  assert.equal(gateVisual({ state: "untested" }), "unobserved");
  assert.equal(gateVisual({ state: "untested", unmeasured_cause: null }), "unobserved");
});

test("a cause never overrides a real verdict", () => {
  // A gate that PASSED in a file whose worker later died holds a real result:
  // the death cost the gates that had not reported yet, not the ones that had.
  // `state` remains the sole verdict and the cause cannot outrank it.
  assert.equal(
    gateVisual({ state: "passing", first_pass_attempt: 1, unmeasured_cause: "runner_died" }),
    "green",
  );
  assert.equal(gateVisual({ state: "failing", unmeasured_cause: "runner_died" }), "red");
});

test("an instrument fault moves NO ratio — it is not a verdict", () => {
  // It sits with `unobserved` in the untested tally. A square that pulled the
  // passing ratio would make an instrument failure look like a capability
  // result, which is the inversion this whole surface refuses.
  const gates = [
    ...GATES,
    { id: "C:g", req: "REQ-DIED", title: "worker died", state: "untested", unmeasured_cause: "runner_died" },
  ];
  const html = renderWall(boardWith(suiteWith(gates)));
  const withNone = renderWall(
    boardWith(suiteWith([...GATES, { id: "C:g", req: "REQ-DIED", title: "unreached", state: "untested" }])),
  );
  const ratio = (h) => h.match(/<span class="bright">(\d+)<\/span>\/(\d+) passing/)?.slice(1).join("/");
  assert.equal(ratio(html), ratio(withNone), "the cause must not change the count");
});

// ── THE TRAJECTORY SPLIT ────────────────────────────────────────────────────

test("a gate green on the first attempt is plain green; one that recovered is not", () => {
  assert.equal(
    gateVisual({ state: "passing", first_pass_attempt: 1, ever_failed: false }),
    "green",
  );
  assert.equal(
    gateVisual({ state: "passing", first_pass_attempt: 3, ever_failed: true }),
    "recovered",
    "fail → fail → pass is a different result from pass → pass → pass",
  );
  assert.equal(
    gateVisual({ state: "passing", first_pass_attempt: 2, ever_failed: true }),
    "recovered",
  );
});

test("a gate that REGRESSED and was repaired reads as recovered, not clean", () => {
  // pass → fail → pass. `first_pass_attempt` is 1, but it broke on the way, and
  // a rim is exactly the honest mark for that.
  assert.equal(
    gateVisual({ state: "passing", first_pass_attempt: 1, ever_failed: true }),
    "recovered",
  );
});

test("A MISSING TRAJECTORY DEGRADES TO GREEN, never to recovered", () => {
  // Runs recorded before these fields existed publish neither. An absent fact
  // must not render as an adverse one.
  assert.equal(gateVisual({ state: "passing" }), "green");
  assert.equal(gateVisual({ state: "passing", first_pass_attempt: null, ever_failed: false }), "green");
});

test("trajectory NEVER overrides the verdict — failing stays failing", () => {
  assert.equal(gateVisual({ state: "failing", first_pass_attempt: 1, ever_failed: false }), "red");
  assert.equal(gateVisual({ state: "untested", first_pass_attempt: 2, ever_failed: true }), "unobserved");
});

test("the recovered tooltip names the attempt the gate first passed on", () => {
  const gates = [{ id: "G07", req: "REQ-X", title: "late green", state: "passing", first_pass_attempt: 2, ever_failed: true }];
  const html = renderWall(boardWith(suiteWith(gates)));
  assert.ok(html.includes("first passed on attempt 2"), "the round is on hover, not encoded in the square");
});

test("the retired states are gone — no blue, no amber, no slate", () => {
  // The whole grid, the legend swatches, and every class string.
  const html = renderWall(boardWith(suiteWith(GATES)));
  for (const dead of ["blue", "testing", "slate", "settled", "gf-", "gm-", "gk-", "gl-"]) {
    assert.ok(!html.includes(dead), `retired visual "${dead}" is still emitted by the wall`);
  }
});

test("an UNKNOWN server state renders as untested, never as a pass", () => {
  // Fail-safe direction. A control plane that grows a fourth state must degrade
  // to "no result", because the alternative is a square claiming a pass nobody
  // measured.
  assert.equal(gateVisual({ state: "abandoned" }), "unobserved");
  assert.equal(gateVisual({ state: "resolved" }), "unobserved");
  assert.equal(gateVisual({}), "unobserved");
});

// ── 3. no phase, anywhere ───────────────────────────────────────────────────

test("THE GRID never mentions a phase", () => {
  // SCOPED TO THE GRID, and that narrowing is the point rather than a
  // concession. The rule this protects is that a SQUARE is never coloured,
  // ordered or altered by phase or live state — two surfaces disagreeing about
  // one gate is the class of bug this panel was rebuilt to remove.
  //
  // The card now also carries the running cell's phase spine and counters,
  // beside the gates those phases produce. That does not touch the rule: the
  // spine is rendered from `board.run` by panels/live.js exactly as it was on
  // the live card, it derives nothing about any gate, and no square can read it.
  // Asserting over the whole card would have been asserting on the card's
  // CONTENTS while claiming to assert on the grid's INDEPENDENCE.
  const html = renderWall(boardWith(suiteWith(GATES)));
  const from = html.indexOf('class="gwall"');
  const to = html.indexOf('class="wall-legend"');
  assert.ok(from !== -1 && to > from, "the grid and legend must both be present to scope this");
  const grid = html.slice(from, to);
  assert.ok(!/phase/i.test(grid), "the grid must carry no phase distinction of any kind");

  // And the squares themselves are still a pure function of gate state: every
  // class on every cell comes from `gateVisual`, nothing else.
  const allowed = new Set(["green", "recovered", "red", "unobserved", "instrument", "sm"]);
  for (const cls of cellClassList(html).flatMap((c) => c.split(/\s+/)).filter(Boolean)) {
    assert.ok(allowed.has(cls), `unexpected class on a gate square: ${cls}`);
  }
});

test("the wall SOURCE carries no phase logic", async () => {
  const src = await readFile(join(HERE, "panels/wall.js"), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");
  for (const banned of ["under_test", "live_signal", "grading", "stalled", "armed", "resolved_at_attempt"]) {
    assert.ok(!code.includes(banned), `panels/wall.js still reads "${banned}" — that is phase/live logic`);
  }
});

// ── 4. no motion ────────────────────────────────────────────────────────────

test("the wall emits no animation hook and the stylesheet defines none for it", async () => {
  const html = renderWall(boardWith(suiteWith(GATES)));
  assert.ok(!html.includes("still"), "the takeover freeze is gone because there is nothing to freeze");

  const css = await readFile(join(HERE, "index.html"), "utf8");
  const wallRules = css
    .split("\n")
    .filter((l) => /^\.(gwall|gcell|wall-)/.test(l.trim()));
  assert.ok(wallRules.length > 0, "the wall must still be styled");
  for (const rule of wallRules) {
    assert.ok(!/animation/.test(rule), `the wall must not animate: ${rule}`);
  }
});

// ── 5. untested is not a weaker pass ────────────────────────────────────────

test("untested renders distinctly from passing and is never counted as passing", () => {
  const html = renderWall(boardWith(suiteWith(GATES)));
  assert.ok(html.includes(`<span class="bright">2</span>/5 passing`), "2 of 5 pass; the untested one is not one of them");
  assert.ok(html.includes("1 not yet tested"), "the untested count is stated, not swallowed");
  assert.ok(html.includes("not yet tested"), "and named in the legend");
});

test("a wall with nothing tested reports zero passing, not an empty grid", () => {
  const gates = GATES.map((g) => ({ ...g, state: "untested" }));
  const html = renderWall(boardWith(suiteWith(gates)));
  assert.ok(html.includes(`<span class="bright">0</span>/5 passing`));
  assert.equal(cellClassList(html).filter((c) => c === "unobserved").length, 5);
});

// ── 6. the denominator is never fabricated ──────────────────────────────────

test("an unknown suite size says so and never prints 0", () => {
  const suite = suiteWith([], {
    suite: { total: null, fingerprint: null, complete: false, incomplete_reason: null, captured_at: null },
    totals: null,
    unwired: ["gate-roster"],
    unwired_reasons: { "gate-roster": "the suite size is unknowable, not zero" },
  });
  const html = renderWall(boardWith(suite));
  assert.ok(html.includes("SUITE SIZE UNKNOWN — NOT ZERO"));
  assert.ok(!/\/0\b/.test(html), "a null denominator must never render as 0");
});

test("an absent suite surface states the reason rather than rendering empty", () => {
  const html = renderWall(boardWith(null));
  assert.ok(html.includes("GATE SUITE UNAVAILABLE"));
  assert.ok(html.includes("not the same as a suite of zero gates"));
});

test("a roster with no outcomes yet explains itself", () => {
  const suite = suiteWith([], {
    totals: null,
    unwired: ["gate-outcomes"],
    unwired_reasons: { "gate-outcomes": "no attempt record carries gate_results yet" },
  });
  const html = renderWall(boardWith(suite));
  assert.ok(html.includes("No gate outcomes published yet"));
  assert.ok(html.includes("not the same as everything failing"));
  assert.ok(html.includes("gate_results"), "the control plane's reason is shown, not swallowed");
});

// ── 7. slots never reflow ───────────────────────────────────────────────────

test("SLOTS NEVER REFLOW: slot count and order survive every state change", () => {
  const frames = [
    GATES.map((g) => ({ ...g, state: "untested" })),
    GATES,
    GATES.map((g) => ({ ...g, state: "failing" })),
    GATES.map((g) => ({ ...g, state: "passing" })),
  ].map((gates) => renderWall(boardWith(suiteWith(gates))));

  const counts = frames.map((h) => cellClassList(h).filter((c) => !c.includes("sm")).length);
  assert.deepEqual(counts, [5, 5, 5, 5], "the slot count is fixed for the life of the run");

  const ids = frames.map((h) => [...h.matchAll(/title="(C:[a-e])/g)].map((m) => m[1]).join(","));
  assert.equal(new Set(ids).size, 1, `slot ORDER moved across frames: ${JSON.stringify(ids)}`);
});

test("the grid keeps its SHAPE as the suite grows", () => {
  // WAS "a fixed 12 columns at every suite size" (design §9.3), and that was
  // right while the suite was 53. Conformance is now 65 individual gates and
  // the suite is 117 — at 12 columns that is ten rows of squares instead of
  // five, and the card doubled in height for nothing a reader gains.
  //
  // Cells are `aspect-ratio: 1`, so at a fixed width the column count sets BOTH
  // the cell size and the row count and the height falls with the SQUARE of it.
  // What must hold is the block's shape, not a magic number.
  //
  // The 53-gate case still draws 12 — the old look is preserved exactly, which
  // is what makes this a generalisation rather than a change of appearance.
  assert.equal(wallColumns(53), 12, "the previous suite must look exactly as it did");

  for (const n of [1, 5, 71, 117, 240]) {
    const cols = wallColumns(n);
    const rows = Math.ceil(n / cols);
    assert.ok(cols >= 8 && cols <= 28, `suite ${n}: ${cols} columns is outside the readable range`);
    // Never a tall thin column of squares, never a single long strip.
    if (n >= 20) {
      assert.ok(rows <= cols, `suite ${n}: ${rows} rows x ${cols} cols is taller than it is wide`);
      assert.ok(cols <= rows * 4, `suite ${n}: ${cols} cols x ${rows} rows is a strip, not a block`);
    }
  }
});

test("the wall publishes its column count so the CSS can size the cell", () => {
  // Every band on a square (the recovered rim, its inset, the attempt digit)
  // used to be a `cqw` fraction chosen when the grid was fixed at 12 columns.
  // At 17 columns a rim sized for a 45px square would be drawn on a 31px one,
  // so the count has to reach the stylesheet.
  const gates = Array.from({ length: 117 }, (_, i) => ({ ...GATES[0], id: `C:${i}` }));
  const html = renderWall(boardWith(suiteWith(gates)));
  const cols = wallColumns(117);
  assert.ok(html.includes(`--wall-cols:${cols}`), "the cell size cannot be derived without it");
  assert.ok(html.includes(`repeat(${cols},1fr)`));
});

// ── PROVENANCE: the wall names the run it is showing ─────────────────────────
//
// These pin the defect that made a stale run-directory default invisible: the
// panel rendered a real 71-gate denominator with every square empty and said
// nothing about WHICH run it had read. `run_dir` and `suite_source` were in the
// payload the whole time.

test("the header names the run directory the squares came from", () => {
  // MOVED FROM THE LEGEND TO THE HEADER, not dropped. The wrapped sentence under
  // the legend cost vertical space the card did not have; the fact it carried is
  // the one this suite exists for, and nothing else on the board names this
  // suite's run — so it is a chip on the header row, which costs no height.
  const html = renderWall(boardWith(suiteWith(GATES, { run_dir: "cumulative-minimax-minimax-m3" })));
  assert.ok(
    html.includes("runs/cumulative-minimax-minimax-m3"),
    "a panel that shows measurements must say what it measured",
  );
  assert.ok(html.includes("pinned roster"), "and that the roster was pinned to that run");
});

test("a path-shaped run directory shows the segments that distinguish it", () => {
  // The leading segments are identical across every run on this board; the last
  // two are the whole distinction. Clipping from the front would print the part
  // that cannot tell two runs apart.
  const html = renderWall(
    boardWith(suiteWith(GATES, { run_dir: "1788592301/local/local-llm-proxy/omlx/qwen3-6-35b" })),
  );
  assert.ok(html.includes("omlx/qwen3-6-35b"), "the distinguishing tail is visible");
  assert.ok(
    html.includes("runs/1788592301/local/local-llm-proxy/omlx/qwen3-6-35b"),
    "and the full path is recoverable from the title",
  );
});

test("a suite with no run directory says so rather than saying nothing", () => {
  const html = renderWall(boardWith(suiteWith(GATES, { run_dir: null })));
  assert.match(html, /RUN UNSTATED/);
});

test("AN ENUMERATED SUITE IS LABELLED: no run behind it, so no square is a verdict", () => {
  // The exact payload the stale default produced: a true denominator, a live
  // enumeration, and not one outcome.
  const gates = GATES.map((g) => ({ ...g, state: "untested" }));
  const html = renderWall(
    boardWith(
      suiteWith(gates, {
        run_dir: "cumulative",
        suite_source: "enumerated",
        attempt: null,
        unwired: ["gate-outcomes"],
      }),
    ),
  );

  // THE CLAIM IS THE TAG NOW. The legend sentence that spelled this out went
  // with the other two notes; the headline tag says the stronger half — that no
  // square here is a verdict — and it says it where it qualifies the headline.
  assert.ok(html.includes("NO RUN — SUITE ENUMERATED"), "the headline states it");
  // The run chip is deliberately NOT doubled up on this case: the tag already
  // says something stronger than "which run", so printing a path beside it would
  // suggest there was a run to read.
  assert.ok(!html.includes("pinned roster"), "no provenance chip claiming a graded run");
  // Every square must still read as unmeasured rather than failed — the count
  // comes from the fixture so this cannot drift into asserting a magic number.
  assert.match(html, new RegExp(`${gates.length} not yet tested`));
  // Asserted on the SQUARES, not on the headline's wording: not one of them may
  // be drawn as a failure when nothing was read.
  //
  // The legend is a KEY and deliberately shows every state whether or not it
  // occurs, so exactly one red swatch is expected — its own. More than one means
  // a square in the grid is claiming a failure that was never measured.
  const reds = (html.match(/gcell red/g) ?? []).length;
  assert.equal(reds, 1, "only the legend's key swatch may be red");
});

test("a run-backed suite carries NO enumerated-suite warning", () => {
  const html = renderWall(boardWith(suiteWith(GATES)));
  assert.ok(!html.includes("NO RUN — SUITE ENUMERATED"), "the warning is for the enumerated case only");
  assert.ok(!html.includes("no run at runs/"), "and so is its legend line");
});

// ── AN ABORTED RUNNER IS NOT A SCORE ────────────────────────────────────────

test("an ungradable attempt is labelled, and its reason is stated", () => {
  const gates = [
    { id: "a", state: "passing" },
    { id: "b", state: "untested" },
    { id: "c", state: "untested" },
  ];
  const html = renderWall(
    boardWith(
      suiteWith(gates, {
        gradable: false,
        ungradable_reason: "backend gates-13-16.test.ts aborted, leaving 2 gates unmeasured",
        aborted_runners: ["backend gates-13-16.test.ts"],
      }),
    ),
  );

  assert.ok(html.includes("NOT A SCORE — RUNNER ABORTED"), "the headline refuses the ratio");
  assert.ok(html.includes("leaving 2 gates unmeasured"), "and the harness's own reason is shown");
});

test("gradability NEVER repaints a square — it answers 'was this measured'", () => {
  const gates = [
    { id: "a", state: "passing" },
    { id: "b", state: "failing" },
    { id: "c", state: "untested" },
  ];
  const ok = renderWall(boardWith(suiteWith(gates, { gradable: true })));
  const bad = renderWall(boardWith(suiteWith(gates, { gradable: false, ungradable_reason: "r" })));

  assert.deepEqual(
    cellClassList(bad).filter((c) => !c.includes("sm")),
    cellClassList(ok).filter((c) => !c.includes("sm")),
    "the same gate states must draw the same squares regardless of gradability",
  );
});

test("a gradable run carries no abort badge", () => {
  const html = renderWall(boardWith(suiteWith(GATES, { gradable: true })));
  assert.ok(!html.includes("NOT A SCORE"), "the badge belongs to the aborted case only");
});

test("an attempt from before the field existed is not badged either way", () => {
  const html = renderWall(boardWith(suiteWith(GATES)));
  assert.ok(!html.includes("NOT A SCORE"), "unknown gradability is not an accusation");
});

// ── THE ATTEMPT NUMBER IN THE SQUARE (2026-08-26) ──────────────────────────
//
// The rim says a gate needed repair; the digit says how much. With a ceiling of
// 10 that is the difference between a gate that wobbled once and one that took
// nine rounds — a headline measurement that was previously reachable only by
// hovering each square in turn.

test("a recovered gate carries its first-pass attempt number", () => {
  const html = renderWall({
    suite: { gates: [{ id: "G1", req: "REQ-A", title: "t", state: "passing", ever_failed: true, first_pass_attempt: 7 }] },
  });
  assert.match(html, /class="gcell recovered"[^>]*>7</, "the digit is the cell's content");
  assert.match(html, /first passed on attempt 7/, "and the tooltip still spells it out");
});

test("a two-digit attempt renders whole — the ceiling is 10, not 9", () => {
  const html = renderWall({
    suite: { gates: [{ id: "G1", state: "passing", ever_failed: true, first_pass_attempt: 10 }] },
  });
  assert.match(html, />10</);
});

test("green, red and unobserved squares carry NO number", () => {
  const html = renderWall({
    suite: {
      gates: [
        { id: "A", state: "passing", first_pass_attempt: 1 },   // green first try
        { id: "B", state: "failing", first_pass_attempt: null },
        { id: "C", state: "not_run" },
      ],
    },
  });
  // A "1" on every green square is noise: no rim already says attempt 1.
  assert.doesNotMatch(html, /class="gcell green"[^>]*>[^<]/);
  assert.doesNotMatch(html, /class="gcell unobserved"[^>]*>[^<]/);
  // A failing square carries the X GLYPH and never a digit — the mark says
  // "failed", and a number on it would read as an attempt count it does not have.
  assert.match(html, /class="gcell red"[^>]*>X<\/span>/);
  assert.doesNotMatch(html, /class="gcell red"[^>]*>\d/);
});

test("the X is a character, not a drawn shape, and matches the digit's font", async () => {
  // It used to be two rotated pseudo-elements whose geometry put the crossing
  // point off-centre, so the mark read lop-sided at every grid size. A glyph
  // cannot be lop-sided — and it must be set in the SAME font declaration as
  // the recovered digit, or the two marks render at different sizes.
  const css = await readFile(join(HERE, "index.html"), "utf8");
  const redRule = css.match(/\.gcell\.red\{([^}]*)\}/)[1];
  const recoveredRule = css.match(/\.gcell\.recovered\{([\s\S]*?)\}/)[1];

  const fontOf = (rule) => (rule.match(/font:([^;]+);/) ?? [])[1]?.trim();
  assert.ok(fontOf(redRule), "the red cell must declare a font for its glyph");
  assert.equal(fontOf(redRule), fontOf(recoveredRule), "X and digit must share one font declaration");

  // The drawing is gone, rather than left behind to paint over the glyph.
  assert.doesNotMatch(css, /\.gcell\.red::(before|after)\{content/);
  assert.match(redRule, /align-items:center/);
  assert.match(redRule, /justify-content:center/);
});

test("a recovered gate with no published attempt draws no digit, not a zero", () => {
  const html = renderWall({
    suite: { gates: [{ id: "G1", state: "passing", ever_failed: true }] },
  });
  assert.match(html, /class="gcell recovered"[^>]*><\/span>/, "absent trajectory must not invent a number");
});

test("the number never changes the verdict — state alone still decides", () => {
  const html = renderWall({
    suite: { gates: [{ id: "G1", state: "failing", ever_failed: true, first_pass_attempt: 3 }] },
  });
  // Passed at some point, failing now: the square is RED and numberless.
  assert.match(html, /class="gcell red"/);
  assert.doesNotMatch(html, />3</);
});

// ── THE HEADLINE MUST AGREE WITH THE GRID BENEATH IT ────────────────────────
//
// `suite.totals` is folded from manifest.status.jsonl, appended once per
// COMPLETED cell, while `overlayLive` moves the grid on every verdict pass.
// Reading the fold in the headline produced a measured contradiction on a live
// run: 65 green + 6 red squares under the words `0/71 passing · 71 not yet
// tested`. A headline that disagrees with its own grid leaves the viewer with
// no way to tell which half is lying, so these tests pin them together.

/** Count squares by rendered colour class, the grid's own account. */
function drawnCounts(html) {
  const cells = cellClassList(html);
  return {
    green: cells.filter((c) => c === "green").length,
    recovered: cells.filter((c) => c === "recovered").length,
    red: cells.filter((c) => c === "red").length,
    unobserved: cells.filter((c) => c === "unobserved").length,
  };
}

test("headline counts the live overlay, not the stale server fold", () => {
  // The fold has seen nothing yet — exactly the state during a cell's first
  // verdict pass, when manifest.status.jsonl has not been appended.
  const gates = GATES.map((g) => ({ ...g, state: "untested" }));
  const suite = suiteWith(gates, {
    attempt: null,
    totals: { passing: 0, failing: 0, untested: gates.length },
  });
  const live = {
    attempt: 1,
    gates: [
      { id: "C:a", status: "pass", phase: "backend", attempt: 1, ts: 1 },
      { id: "C:b", status: "pass", phase: "backend", attempt: 1, ts: 2 },
      { id: "C:c", status: "fail", phase: "frontend", attempt: 1, ts: 3 },
    ],
  };
  const html = renderWall({ suite, live });
  const drawn = drawnCounts(html);

  // The grid moved...
  assert.equal(drawn.green + drawn.recovered, 2);
  assert.equal(drawn.red, 1);
  // ...and the headline moved with it, rather than reading 0/5.
  assert.match(html, /<span class="bright">2<\/span>\/5 passing/);
  assert.match(html, /1 FAILING/);
  assert.match(html, /2 not yet tested/);
});

test("headline and grid never disagree, overlay or not", () => {
  for (const live of [null, { attempt: 1, gates: [{ id: "C:e", status: "pass", phase: "backend", attempt: 1, ts: 1 }] }]) {
    const html = renderWall({ suite: suiteWith(GATES), live });
    const drawn = drawnCounts(html);
    const passing = Number(html.match(/<span class="bright">(\d+)<\/span>\/\d+ passing/)[1]);
    const failing = Number((html.match(/(\d+) FAILING/) ?? [0, "0"])[1]);
    const untested = Number((html.match(/(\d+) not yet tested/) ?? [0, "0"])[1]);

    assert.equal(passing, drawn.green + drawn.recovered, "headline passing vs green squares");
    assert.equal(failing, drawn.red, "headline failing vs red squares");
    assert.equal(untested, drawn.unobserved, "headline untested vs blank squares");
  }
});

test("an in-flight attempt is not described as a completed test run", () => {
  const gates = GATES.map((g) => ({ ...g, state: "untested" }));
  const suite = suiteWith(gates, { attempt: null, totals: { passing: 0, failing: 0, untested: gates.length } });
  const live = { attempt: 1, gates: [{ id: "C:a", status: "pass", phase: "backend", attempt: 1, ts: 1 }] };

  // THE SENTENCE BECAME A TAG. "still in flight — this cell has not closed" is a
  // claim about whether these numbers are final, not an explanation, so it
  // survived the note cull as `attemptTag()` in the header. A running cell
  // reading as a finished one is the exact misreading being prevented, and the
  // tag must keep preventing it.
  const html = renderWall({ suite, live });
  assert.match(html, /ATTEMPT 1 · IN FLIGHT/);

  // Once the fold carries a completed attempt, it is stated without the caveat.
  const done = renderWall({ suite: suiteWith(GATES), live });
  assert.match(done, /ATTEMPT 2/);
  assert.doesNotMatch(done, /IN FLIGHT/);
});

test("an empty grid still says nothing was measured, never 0 passing", () => {
  const html = renderWall({ suite: suiteWith([], { totals: null, attempt: null }), live: null });
  assert.match(html, /NO GATE OUTCOMES YET/);
  assert.doesNotMatch(html, /0\/0 passing/);
});

// ── THE GATE CARD ───────────────────────────────────────────────────────────
//
// Hover shows one card; click pins it; escape closes the pin. The card renders
// the server's detail as given and states when a description is missing.

test("gate card: hovering a square renders its description, rounds, failure and told lines", async () => {
  const { setGateHover, toggleGatePin, clearGatePin } = await import("./panels/wall.js");
  const gates = [
    {
      id: "E04",
      title: "shut out",
      state: "failing",
      ever_failed: true,
      detail: {
        description: { key: "E04", name: "Shut out on the bar", what: "No legal move.", how: "White on the bar." },
        rounds: [{ attempt: 1, status: "fail" }, { attempt: 2, status: "fail" }],
        last_failure: { attempt: 2, message: "expected 2 to be +0", location: "edge.test.ts:116" },
        told: { first: "The bar is wrong.", repeat: "Still wrong." },
      },
    },
    { id: "G01", title: "start", state: "passing", detail: { description: null, rounds: [], last_failure: null, told: null } },
  ];
  const board = boardWith(suiteWith(gates));

  assert.ok(!renderWall(board).includes('class="gcard'), "no card before a hover");
  assert.equal(setGateHover("E04", { left: 10, right: 20, top: 10, bottom: 20 }), true);
  const html = renderWall(board);
  for (const text of ["Shut out on the bar", "FAILED — never fixed", "No legal move.", "White on the bar.",
    "LAST FAILURE · round 2", "expected 2 to be +0", "edge.test.ts:116", "The bar is wrong.", "Still wrong."]) {
    assert.ok(html.includes(text), `card is missing: ${text}`);
  }

  // Pinned wins over a passing hover, and escape releases it.
  toggleGatePin("E04", null);
  setGateHover("G01", null);
  assert.ok(renderWall(board).includes("Shut out on the bar"), "the pinned card stays while the pointer moves");
  assert.equal(clearGatePin(), true);
  const passed = renderWall(board);
  assert.ok(passed.includes("PASSED — round 1") && passed.includes("No description for this check yet"));
  assert.ok(!passed.includes("WHAT THE MODEL WAS TOLD"), "a gate that never failed shows no complaint lines");
  setGateHover(null, null);
  assert.ok(!renderWall(board).includes('class="gcard'), "leaving the wall closes an unpinned card");
});

test("gate card: placement is measured so the whole card fits the window — it never scrolls", async () => {
  const { setGateHover, fitGateCard } = await import("./panels/wall.js");
  const gates = [{ id: "T1", title: "tall", state: "failing", detail: { description: null, rounds: [], last_failure: null, told: null } }];
  const board = boardWith(suiteWith(gates));
  // A stand-in card whose height shrinks as it widens: 900px of text at 420px wide.
  const fakeCard = () => {
    let width = 420;
    const el = {
      className: "gcard",
      classList: { toggle: noop },
      style: {
        set cssText(v) { width = Number(/width:(\d+)px/.exec(v)?.[1] ?? width); },
        get cssText() { return `width:${width}px`; },
      },
      getBoundingClientRect: () => ({ height: Math.ceil(378000 / width) }),
    };
    return el;
  };
  setGateHover("T1", { left: 500, right: 520, top: 300, bottom: 320 });
  assert.ok(renderWall(board).includes("visibility:hidden"), "the first paint is invisible, for measuring");
  const view = { innerWidth: 1280, innerHeight: 600 };
  assert.equal(fitGateCard(fakeCard(), view), true);
  const html = renderWall(board);
  const width = Number(/class="gcard[^"]*"[^>]*width:(\d+)px/.exec(html)[1]);
  const top = Number(/class="gcard[^"]*"[^>]*top:(\d+)px/.exec(html)[1]);
  const height = Math.ceil(378000 / width);
  assert.ok(!html.includes("visibility:hidden"), "the measured card is shown");
  assert.ok(top >= 8 && top + height <= 600 - 8, `card ${top}–${top + height} fits a 600px window`);
  assert.equal(fitGateCard(fakeCard(), view), false, "a settled card does not redraw again");
  setGateHover(null, null);
});
