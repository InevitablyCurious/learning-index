// ─────────────────────────────────────────────────────────────────────────────
// TWO MODES, AND NOTHING ELSE
//
//     cd dashboard && node --test
//
// The run modal offers exactly two modes, and they differ in ONE way — on the
// SERVER, after the launch has arrived:
//
//   Normal — one click, no pauses.
//   Dev    — the same method, but the run pauses after every grade and once at
//            the end.
//
// The mode is not a launch parameter. The control plane derives the pause from
// its own dev-mode state, so both modes post the SAME body and the modal has no
// mode-specific step. There is no per-run pause flag and no per-run concurrency
// flag to send: one click is one cell, one run.
//
// What this file pins:
//
//   A. The confirm frame carries NO continuous control and NO seed step. Both
//      were machinery for chaining runs from snapshots; the control plane's
//      /api/continuous* and /api/snapshots* routes are gone, so a modal that
//      still offered them would be a button that can only fail.
//   B. The confirm frame is byte-identical in both modes: no pause row, no
//      concurrency row, nothing mode-shaped to render.
//   C. A start sends neither `continuous`, `pauseAfterGrade` nor `concurrency` —
//      ABSENCE, not false (absent = the server's own default).
//
// Drives the REAL launchCell path against a pure mock fetch — the body-capture
// idiom from two-mode's siblings (no server, no DOM).
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import { openCellConfirm, renderCreate, launchCell } from "./panels/create.js";

/** A board whose ledger answers the confirm frame's two reads. */
const BOARD = {
  models_ledger: {
    startable: [{ id: "a/model", label: "A Model", context: 262144 }],
    cloud: { spend_ceiling_usd: 5, spend_note: "" },
  },
  control: { capabilities: { dev_mode: { enabled: false } } },
};

const DEV_BOARD = {
  ...BOARD,
  control: { capabilities: { dev_mode: { enabled: true } } },
};

const json = (body) => ({ ok: true, status: 200, json: async () => body });

/**
 * The mock control plane: records every call and answers launchCell's exact
 * sequence — preflight "go", a fixed preview token, a fixed start ok. Anything
 * else is a test bug, not a tolerated 404.
 */
function mockControlPlane() {
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method ?? "GET";
    seen.push({ url: u, method, opts });
    if (u.startsWith("/api/preflight")) {
      return json({ verdict: "go", blocking_failures: 0, checks: [] });
    }
    if (u === "/api/run/preview" && method === "POST") {
      return json({ ok: true, token: "t" });
    }
    if (u === "/api/run/start" && method === "POST") {
      return json({ ok: true, pid: 4242 });
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };
  return seen;
}

const starts = (seen) => seen.filter((c) => c.url === "/api/run/start" && c.method === "POST");

// ── A: the modal offers no third path ────────────────────────────────────────

for (const [label, board] of [["normal mode", BOARD], ["dev mode", DEV_BOARD]]) {
  for (const arm of ["off", "on"]) {
    test(`the confirm frame (${label}, ${arm} arm) offers no continuous control and no seed step`, () => {
      openCellConfirm({ model: "a/model", kind: "local", arm });
      const html = renderCreate(board);

      assert.ok(!html.includes("data-create-continuous"), "no continuous click hook");
      assert.ok(!/CONTINUOUS/.test(html), "no control named CONTINUOUS");
      assert.ok(!html.includes("data-seed-pick"), "no snapshot seed picker");
      assert.ok(!/seed/i.test(html), "nothing in the frame speaks of seeding");
    });
  }
}

// ── B: the frame has no mode-specific step ───────────────────────────────────

test("the confirm frame is identical in both modes, and still offers one START", () => {
  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });
  const normal = renderCreate(BOARD);
  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });
  const dev = renderCreate(DEV_BOARD);

  // The mode lives on the server, not in this frame: a per-run pause row or a
  // concurrency row here would be a second control over the same thing.
  assert.equal(dev, normal, "dev mode adds nothing to the confirm frame");
  for (const html of [normal, dev]) {
    assert.ok(!html.includes("data-create-pause"), "no pause toggle");
    assert.ok(!html.includes("data-create-concurrency"), "no concurrency toggle");
    // Both frames carry the still-meaningful configurables.
    assert.ok(html.includes("data-create-compact"), "compaction survives in both modes");
    assert.ok(html.includes("data-create-baseline-continue"), "one START in both modes");
  }
});

// ── C: a start sends no mode key, no pause key, no concurrency key ───────────

test("a start sends neither continuous, pauseAfterGrade nor concurrency", async () => {
  const seen = mockControlPlane();
  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });

  await launchCell();

  assert.equal(starts(seen).length, 1, "exactly one start POST");
  const body = JSON.parse(starts(seen)[0].opts.body);
  assert.ok(!("continuous" in body), "there is no chain key to send");
  assert.ok(!("pauseAfterGrade" in body), "the pause is the server's dev-mode state, not a flag");
  assert.ok(!("concurrency" in body), "one click is one cell");
  assert.equal(body.arm, "off");
  assert.equal(body.model, "a/model");
});
