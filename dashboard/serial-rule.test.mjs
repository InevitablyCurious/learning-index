// ─────────────────────────────────────────────────────────────────────────────
// THE SERIAL RULE IS RENDERED — so it must be asserted.
//
// One session, one cell: while a cell is in flight every launch is blocked, and
// the board says so in two places. The baselines card carries the chip
// (panels/ledger.js serialChip(), drawn by head()); the provenance strip states
// the contract line (panels/chrome.js renderProvenance()). Both strings were
// rendered with zero tests asserting them — a rewording, a lost em-dash, or a
// chip that stopped rendering at all would pass the suite silently.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderLedger } from "./panels/ledger.js";
import { renderProvenance } from "./panels/chrome.js";

// Copied byte-for-byte from panels/ledger.js:84-85 and panels/chrome.js:180.
const IDLE = "IDLE \u2014 NO CELL IN FLIGHT";
const BLOCKED = "CELL IN FLIGHT \u2014 ALL LAUNCHES BLOCKED";
const PROVENANCE_SERIAL = "serial by contract \u2014 one session, one cell, HTTP 409 on overlap";

const board = (over = {}) => ({
  control: { roster: null },
  models_ledger: {
    baseline_rows: [],
    counts: { complete: 0, running: 0, void: 0 },
    startable: [],
    run_in_flight: false,
    ...over,
  },
});

test("the ledger chip reads IDLE when no cell is in flight", () => {
  const html = renderLedger(board());
  assert.ok(html.includes(IDLE), `expected the idle chip, got:\n${html}`);
  assert.ok(!html.includes(BLOCKED), "the blocked chip must not render while idle");
});

test("the ledger chip blocks every launch while a cell is in flight", () => {
  const html = renderLedger(board({ run_in_flight: true }));
  assert.ok(html.includes(BLOCKED), `expected the in-flight chip, got:\n${html}`);
  assert.ok(!html.includes(IDLE), "the idle chip must not render while a cell is in flight");
});

test("the provenance strip states the serial contract", () => {
  const html = renderProvenance({});
  assert.ok(html.includes(PROVENANCE_SERIAL), `expected the serial contract line, got:\n${html}`);
});
