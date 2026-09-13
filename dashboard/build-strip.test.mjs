// ─────────────────────────────────────────────────────────────────────────────
// BUILD STRIP — the display that must never become a verdict
//
//     cd okp-bench/dashboard && node --test
//
// WO-CHUNKVIS-1. Which of the six build chunks landed, rendered per cell. This
// panel decides NOTHING: the harness does not gate on these values and neither
// does the strip. What this file pins is the three ways it could still lie.
//
//  1. ABSENT IS NOT INCOMPLETE. `build_chunks: null` is every cell measured
//     before this shipped. Drawing six ✗ would mark the whole historical
//     campaign broken, so absent draws NOTHING.
//  2. THE CULPRIT IS NAMED. A chunk that died carries its reason; the chunks
//     that never ran because of it do not. "4 ✗ run_timeout · 5 – · 6 –" sends
//     an operator to one fault, "incomplete: 4, 5, 6" sends them to three.
//  3. AN OUTCOME CONTRADICTED BY ITS FILE IS SHOWN. `complete` with stubs
//     still in the file it owns is the self-report failing, and it surfaces as
//     words rather than being silently trusted.
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

const { buildStrip } = await import("./panels/ledger.js");

// The live 2026-08-26 build, as collectCells publishes it.
const INCIDENT = [
  { chunk: 1, state: "complete", stub_file: null, stubs_remaining: null },
  { chunk: 2, state: "complete", stub_file: "src/game.ts", stubs_remaining: 0 },
  { chunk: 3, state: "complete", stub_file: "src/ai.ts", stubs_remaining: 0 },
  { chunk: 4, state: "died", reason: "run_timeout", stub_file: "src/server.ts", stubs_remaining: 21 },
  { chunk: 5, state: "not_reached", stub_file: null, stubs_remaining: null },
  { chunk: 6, state: "not_reached", stub_file: null, stubs_remaining: null },
];

test("absent build data draws nothing — never six failures", () => {
  assert.equal(buildStrip({}), "");
  assert.equal(buildStrip({ build_chunks: null }), "");
  assert.equal(buildStrip({ build_chunks: [] }), "");
});

test("the culprit is named and the collateral is not", () => {
  const html = buildStrip({ build_chunks: INCIDENT });
  assert.match(html, /run_timeout/, "the chunk that died says why");
  // Exactly one reason on the strip: chunks 5 and 6 did not fail, they never ran.
  assert.equal((html.match(/run_timeout/g) ?? []).length, 1);
  assert.match(html, /bc died/);
  assert.equal((html.match(/bc not_reached/g) ?? []).length, 2);
  assert.equal((html.match(/bc complete/g) ?? []).length, 3);
});

test("a chunk declared complete while its file still holds stubs is surfaced", () => {
  const html = buildStrip({
    build_chunks: [
      { chunk: 2, state: "complete", stub_file: "src/game.ts", stubs_remaining: 0 },
      { chunk: 3, state: "complete", stub_file: "src/ai.ts", stubs_remaining: 5 },
    ],
  });
  assert.match(html, /ran clean but is not built/);
  assert.match(html, /chunk 3/);
  assert.match(html, /src\/ai\.ts/);
  assert.doesNotMatch(html, /chunk 2 \(/, "a chunk that really built must not be accused");
});

test("a clean build raises no discrepancy", () => {
  const html = buildStrip({
    build_chunks: [
      { chunk: 2, state: "complete", stub_file: "src/game.ts", stubs_remaining: 0 },
    ],
  });
  assert.doesNotMatch(html, /ran clean but is not built/);
});

test("an unknown state degrades to not-reached, never to complete", () => {
  const html = buildStrip({ build_chunks: [{ chunk: 1, state: "who-knows" }] });
  assert.doesNotMatch(html, /✓/, "only a real 'complete' may draw the completion glyph");
});
