// FACET FILTERS — pick what you want to SEE.
//
// The model these replaced began with every kind ON and removed one per click,
// so "show me just the errors" cost six clicks to exclude everything else and
// six more to undo. The work scaled with what you did NOT want. Every test here
// is a property of the inversion.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createFacet,
  toggleFacet,
  clearFacet,
  facetAccepts,
  facetActive,
  facetState,
  facetSignature,
  facetPicked,
} from "./panels/facet.js";

const KINDS = ["tool", "file", "thinking", "error", "lifecycle", "user", "harness"];

test("FACET: nothing selected shows EVERYTHING, and is not 'all filters on'", () => {
  const f = createFacet(KINDS);
  assert.equal(facetActive(f), false, "the resting state has no filter engaged");
  for (const k of KINDS) {
    assert.equal(facetAccepts(f, k), true, `${k} must pass when nothing is picked`);
    // Not `picked`: with every chip lit, "nothing is filtered" and "everything
    // is explicitly included" would look identical and the operator could not
    // tell whether a filter was engaged.
    assert.equal(facetState(f, k), "neutral");
  }
});

test("FACET: ONE CLICK shows one kind — the thing the old model could not do", () => {
  const f = createFacet(KINDS);
  toggleFacet(f, "error");

  assert.equal(facetActive(f), true);
  assert.equal(facetAccepts(f, "error"), true);
  for (const other of KINDS.filter((k) => k !== "error")) {
    assert.equal(facetAccepts(f, other), false, `${other} must be excluded`);
    assert.equal(facetState(f, other), "muted");
  }
  assert.equal(facetState(f, "error"), "picked");
});

test("FACET: several picks are a UNION, never an intersection", () => {
  // A row carries exactly one kind, so an intersection is always empty — every
  // second click would blank the feed.
  const f = createFacet(KINDS);
  toggleFacet(f, "error");
  toggleFacet(f, "harness");

  assert.equal(facetAccepts(f, "error"), true);
  assert.equal(facetAccepts(f, "harness"), true);
  assert.equal(facetAccepts(f, "tool"), false);
});

test("FACET: unpicking the last value returns to showing everything", () => {
  const f = createFacet(KINDS);
  toggleFacet(f, "error");
  toggleFacet(f, "error");

  assert.equal(facetActive(f), false, "back to the resting state, not an empty feed");
  for (const k of KINDS) assert.equal(facetAccepts(f, k), true);
});

test("FACET: CLEAR is always one action away from any selection", () => {
  const f = createFacet(KINDS);
  for (const k of KINDS) toggleFacet(f, k);
  assert.equal(facetActive(f), true);

  clearFacet(f);
  assert.equal(facetActive(f), false);
  for (const k of KINDS) assert.equal(facetAccepts(f, k), true);
});

test("FACET: selecting every value still shows everything", () => {
  // The degenerate case must agree with the resting state: a feed that hid rows
  // when the operator had picked every kind would be indefensible.
  const f = createFacet(KINDS);
  for (const k of KINDS) toggleFacet(f, k);
  for (const k of KINDS) assert.equal(facetAccepts(f, k), true);
});

test("FACET: an unknown value is ignored, never silently added", () => {
  // The chip row is drawn from `values`, so a selection holding something not in
  // it would filter the feed by a control the operator cannot see or unpick.
  const f = createFacet(KINDS);
  toggleFacet(f, "not-a-kind");
  assert.equal(facetActive(f), false);
  assert.equal(facetAccepts(f, "tool"), true);
});

test("FACET: the signature ignores click ORDER — the same filter repaints once", () => {
  const a = createFacet(KINDS);
  toggleFacet(a, "error");
  toggleFacet(a, "harness");

  const b = createFacet(KINDS);
  toggleFacet(b, "harness");
  toggleFacet(b, "error");

  assert.equal(facetSignature(a), facetSignature(b));
  assert.notEqual(facetSignature(a), facetSignature(createFacet(KINDS)));
});

test("FACET: picked values come back in DISPLAY order, for prose", () => {
  // The empty-feed note names what is picked. Reading them back in click order
  // would make the same filter describe itself two different ways.
  const f = createFacet(KINDS);
  toggleFacet(f, "user");
  toggleFacet(f, "file");
  assert.deepEqual(facetPicked(f), ["file", "user"]);
});

test("FACET: two facets are independent", () => {
  // The backend feed filters by SOURCE while the event feed filters by KIND, and
  // both are on screen at once.
  const kinds = createFacet(KINDS);
  const sources = createFacet(["harness", "gates", "control"]);

  toggleFacet(kinds, "error");
  assert.equal(facetActive(sources), false, "picking a kind must not filter sources");
  assert.equal(facetAccepts(sources, "gates"), true);
});
