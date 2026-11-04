// ─────────────────────────────────────────────────────────────────────────────
// RENDER-BLOCKED FLAG — the grader's fact, in the card, in operator words
//
//     cd bench/dashboard && node --test build-render.test.mjs
//
// The flag is view-derived skeleton state: renderBuild reads the LATEST
// attempt's render_blocked from board.live.attempts (ascending, so the last
// entry) and paints its reason as a plain label in the card's .phead. A
// healthy attempt — or a build with no live feed at all — paints nothing.
//
// THE DOM STUB: importing any panel runs board.js's listener registration.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

const noop = () => {};
const stubEl = () => ({
  innerHTML: "", style: {}, classList: { add: noop, remove: noop },
  appendChild: noop, addEventListener: noop, childNodes: [],
  content: { childNodes: [] },
});
globalThis.document = {
  addEventListener: noop, getElementById: stubEl, createElement: stubEl,
  querySelector: () => null, querySelectorAll: () => [], body: { appendChild: noop },
};
globalThis.window = {
  addEventListener: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop }),
};
globalThis.setInterval = noop;

const { renderBuild } = await import("./panels/build.js");

// The strip is derived from the attempts the live overlay OBSERVES, never from
// a configured cap: the board carries max_attempts as null (unbounded).
const blocked = (reason) => ({
  live: { attempts: [{ attempt: 1, render_blocked: { reason } }] },
  max_attempts: null,
});

test("a render-blocked attempt names the reason, in operator words", () => {
  const html = renderBuild(blocked("server-not-answering"));
  assert.ok(html.includes("render blocked — the game isn't answering"));
  assert.ok(!html.includes("no active build"));
});

test("state-empty and no-positions carry their own plain labels", () => {
  assert.ok(
    renderBuild(blocked("state-empty")).includes("render blocked — the game starts but returns empty"),
  );
  assert.ok(
    renderBuild(blocked("no-positions")).includes("render blocked — pieces show but none sits on a numbered space"),
  );
});

test("geometry-not-drawn carries its own plain label", () => {
  assert.ok(
    renderBuild(blocked("geometry-not-drawn")).includes("render blocked — the board geometry didn't draw"),
  );
});

test("a healthy attempt paints no flag", () => {
  const html = renderBuild({ live: { attempts: [{ attempt: 1 }] }, max_attempts: null });
  assert.ok(!html.includes("render blocked"));
});

test("a build with no live feed still renders, and shows no flag", () => {
  const html = renderBuild({ max_attempts: null });
  assert.ok(html.includes("LIVE BUILD"));
  assert.ok(!html.includes("render blocked"));
});

// ── the strip's length is OBSERVED ──────────────────────────────────────────
// Tabs run 1..N for the attempts the overlay actually reports, then "live".
// No cap is applied and no tab is padded: a run that reached round 7 has seven
// numbered tabs, and a run with nothing yet has none of them.

const tabs = (html) => [...html.matchAll(/data-build-tab="([^"]+)"/g)].map((m) => m[1]);

test("seven observed rounds make seven numbered tabs, and no more", () => {
  const attempts = Array.from({ length: 7 }, (_, i) => ({ attempt: i + 1 }));
  const html = renderBuild({ live: { attempts }, max_attempts: null });
  assert.ok(html.includes('data-build-tab="7"'), "round 7 is an observed round, so it has a tab");
  assert.ok(!html.includes('data-build-tab="8"'), "nothing is padded past the last observed round");
  assert.deepEqual(tabs(html), ["1", "2", "3", "4", "5", "6", "7", "live"]);
});

test("a board with no attempts yet has only the live tab", () => {
  const html = renderBuild({ live: { attempts: [] }, max_attempts: null });
  assert.deepEqual(tabs(html), ["live"]);
});
