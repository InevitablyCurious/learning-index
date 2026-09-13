// ─────────────────────────────────────────────────────────────────────────────
// CLICK-TO-EXPAND EVENT ROWS — the captured text is rendered, honestly labelled
//
// A feed row carries `text` (for a `user` row, the verbatim prompt the harness
// handed the model) that the compact one-line row never shows. The expansion
// renders it under a label that claims "verbatim" ONLY when nothing was cut —
// a truncated payload must say it was truncated and name the surviving length,
// because a cut prompt presented silently as complete is the same lie as a
// partial delta presented as a result.
//
// These tests pin the pure seams (evBody/evRow — no DOM at import, mirroring
// phase-source.test.mjs) and, by source assertion, the two load-bearing
// mechanics the expansion must NOT regress: the click binding is delegated on
// the #sc-events box (bound once, survives rebuilds — never per-row), and
// paintFeed still appends past the renderedSeq watermark.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { evRow, evBody } from "./panels/live.js";

const LIVE_SRC = readFileSync(
  fileURLToPath(new URL("./panels/live.js", import.meta.url)),
  "utf8",
);

/** The shape control/events.mjs produces for a user turn. */
const USER_ROW = {
  seq: 7,
  at: 1788598797375,
  kind: "user",
  name: "user",
  detail: "fix the failing tests",
  text: "Fix the failing tests in bench/dashboard, then rerun the suite.",
  truncated: false,
};

// ── evBody — the honest label ───────────────────────────────────────────────

test("evBody renders an uncut payload under the verbatim label", () => {
  const html = evBody(USER_ROW);
  assert.ok(html.includes("verbatim — exactly what the model was sent"));
  assert.ok(html.includes(USER_ROW.text), "the captured text is rendered");
  assert.ok(html.includes('<pre class="evtext">'));
  assert.ok(!html.includes("truncated"), "an uncut payload is not called truncated");
});

test("evBody labels a cut payload as truncated and names the surviving length", () => {
  const cut = { ...USER_ROW, text: "x".repeat(120), truncated: true };
  const html = evBody(cut);
  assert.ok(html.includes("truncated"));
  assert.ok(html.includes("showing first 120 chars"), "the cut is quantified, not hidden");
  assert.ok(!html.includes("verbatim"), "a cut payload never claims verbatim");
});

test("evBody says so when nothing was captured — null or missing text", () => {
  for (const e of [{ ...USER_ROW, text: null }, { seq: 8, kind: "tool" }]) {
    const html = evBody(e);
    assert.ok(html.includes("no captured text for this event"));
    assert.ok(!html.includes("<pre"), "no empty text block is painted");
  }
});

test("evBody escapes the payload — a script in the text never reaches the DOM raw", () => {
  const hostile = { ...USER_ROW, text: `<script>alert("pwn")</script>` };
  const html = evBody(hostile);
  assert.ok(!html.includes("<script>"), "raw markup does not pass through");
  assert.ok(html.includes("&lt;script&gt;"), "it is rendered as escaped text");
});

// ── evRow — the compact row is unchanged; expansion is additive ─────────────

test("evRow collapsed: no body, aria-expanded=false, still one clickable row", () => {
  const html = evRow(USER_ROW, false, false);
  assert.ok(!html.includes("evbody"), "a collapsed row carries no body");
  assert.ok(html.includes('aria-expanded="false"'));
  assert.ok(html.includes('role="button"') && html.includes('tabindex="0"'));
  assert.ok(html.includes('data-seq="7"'), "the seq the click handler reads");
  assert.ok(!html.includes(" open"), "no open class while collapsed");
});

test("evRow expanded: body appended in place, aria-expanded=true, text shown", () => {
  const html = evRow(USER_ROW, false, true);
  assert.ok(html.includes("evbody"));
  assert.ok(html.includes('aria-expanded="true"'));
  assert.ok(html.includes(" open"), "the open class drives the CSS height");
  assert.ok(html.includes(USER_ROW.text), "the verbatim text is inside the row");
});

test("evRow keeps the four compact spans in both states", () => {
  for (const html of [evRow(USER_ROW, false, false), evRow(USER_ROW, false, true)]) {
    assert.ok(html.includes('<span class="evt">'));
    assert.ok(html.includes('<span class="evmark">'));
    assert.ok(html.includes('<span class="evname">'));
    assert.ok(html.includes('<span class="evdetail'));
    assert.ok(html.includes(USER_ROW.detail), "the compact detail still renders");
  }
});

// ── source assertions — the mechanics the expansion must not regress ────────

test("the click binding is delegated on #sc-events, bound once — never per row", () => {
  const start = LIVE_SRC.indexOf("function ensureExpandBound");
  assert.ok(start !== -1, "ensureExpandBound exists");
  const tail = LIVE_SRC.slice(start);
  const bindAt = tail.indexOf('addEventListener("click"');
  assert.ok(bindAt !== -1, "a click listener is bound");
  const before = tail.slice(0, bindAt);
  assert.ok(
    before.includes('getElementById("sc-events")'),
    "the listener is bound on the #sc-events box (delegated), not on rows",
  );
  assert.ok(before.includes("if (expandBound) return"), "bound lazily exactly once");
  assert.ok(!LIVE_SRC.includes("onclick"), "no inline per-row handlers anywhere");
  assert.ok(!evRow(USER_ROW, false, false).includes("onclick"));
});

test("paintFeed still appends past the renderedSeq watermark (append-only intact)", () => {
  const pfStart = LIVE_SRC.indexOf("export function paintFeed");
  assert.ok(pfStart !== -1);
  const pf = LIVE_SRC.slice(pfStart, LIVE_SRC.indexOf("\nfunction isAtBottom", pfStart));
  assert.ok(
    pf.includes('insertAdjacentHTML("beforeend"'),
    "fresh rows are still appended, never innerHTML-rebuilt on the happy path",
  );
  assert.ok(pf.includes("> renderedSeq"), "the append is still gated by the seq watermark");
});
