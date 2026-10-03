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

const blocked = (reason) => ({
  live: { attempts: [{ attempt: 1, render_blocked: { reason } }] },
  max_attempts: 5,
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
  const html = renderBuild({ live: { attempts: [{ attempt: 1 }] }, max_attempts: 5 });
  assert.ok(!html.includes("render blocked"));
});

test("a build with no live feed still renders, and shows no flag", () => {
  const html = renderBuild({ max_attempts: 5 });
  assert.ok(html.includes("LIVE BUILD"));
  assert.ok(!html.includes("render blocked"));
});
