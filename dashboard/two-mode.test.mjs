// ─────────────────────────────────────────────────────────────────────────────
// TWO MODES, AND NOTHING ELSE
//
//     cd dashboard && node --test
//
// The run modal offers exactly two modes, and they differ in ONE way:
//
//   Normal — one click, no pauses. The payload carries neither `pauseAfterGrade`
//            nor any chain key.
//   Dev    — the same method, but the run pauses after every grade and once at
//            the end. The payload carries `pauseAfterGrade: true`.
//
// What this file pins:
//
//   A. The confirm frame carries NO continuous control and NO seed step. Both
//      were machinery for chaining runs from snapshots; the control plane's
//      /api/continuous* and /api/snapshots* routes are gone, so a modal that
//      still offered them would be a button that can only fail.
//   B. A normal start sends no `continuous` key and no `pauseAfterGrade` key —
//      ABSENCE, not false (absent = the server's own default).
//   C. A dev start sends `pauseAfterGrade: true` and still no `continuous` key.
//
// Drives the REAL launchCell path against a pure mock fetch — the body-capture
// idiom from pause-toggle.test.mjs / concurrency.test.mjs (no server, no DOM).
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

test("dev mode adds a pause row, and that is the ONLY difference between the modes", () => {
  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });
  const normal = renderCreate(BOARD);
  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });
  const dev = renderCreate(DEV_BOARD);

  assert.ok(!normal.includes("data-create-pause"), "normal mode shows no pause toggle");
  assert.ok(dev.includes("data-create-pause"), "dev mode shows the pause toggle");
  // Both frames carry the still-meaningful configurables.
  for (const html of [normal, dev]) {
    assert.ok(html.includes("data-create-concurrency"), "concurrency survives in both modes");
    assert.ok(html.includes("data-create-compact"), "compaction survives in both modes");
    assert.ok(html.includes("data-create-baseline-continue"), "one START in both modes");
  }
});

// ── B: normal mode sends neither key ─────────────────────────────────────────

test("a normal-mode start sends neither continuous nor pauseAfterGrade", async () => {
  const seen = mockControlPlane();
  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });

  await launchCell({ devOn: false });

  assert.equal(starts(seen).length, 1, "exactly one start POST");
  const body = JSON.parse(starts(seen)[0].opts.body);
  assert.ok(!("continuous" in body), "there is no chain key to send");
  assert.ok(!("pauseAfterGrade" in body), "no pauses: the key is ABSENT, not false");
  assert.equal(body.arm, "off");
  assert.equal(body.model, "a/model");
});

// ── C: dev mode sends the pause, and still no chain key ──────────────────────

test("a dev-mode start sends pauseAfterGrade true and no continuous key", async () => {
  const seen = mockControlPlane();
  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });

  await launchCell({ devOn: true });

  assert.equal(starts(seen).length, 1, "exactly one start POST");
  const body = JSON.parse(starts(seen)[0].opts.body);
  assert.equal(body.pauseAfterGrade, true, "the pauses the operator asked for");
  assert.ok(!("continuous" in body), "no chain key in either mode");
});
