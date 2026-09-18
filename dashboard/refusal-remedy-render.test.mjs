// ─────────────────────────────────────────────────────────────────────────────
// THE REFUSAL FRAME ACTUALLY RENDERS THE BUTTON
//
// remedy-plan.test.mjs pins the GROUPING; this pins that the grouping reaches
// the screen. The two are worth separating: a correct plan that never makes it
// into the HTML looks identical to no plan at all, and the old refusal frame —
// "Fix what preflight named, then start again" — was exactly that shape of
// dead end.
//
// Drives the REAL launch path against a fake control plane, so the payload
// shape here is the one the board actually parses.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { launchCell, renderCreate, openCreate } from "./panels/create.js";

const nodeFetch = globalThis.fetch;

/** The launch frame reads only the ledger off the board; nothing here needs it. */
const BOARD = { models_ledger: null };

/** A control plane that refuses preflight, with one remedy resolved and one not. */
function fakeControlPlane(payload) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      // The board fetches same-origin paths; point them at this server.
      globalThis.fetch = (url, opts) => nodeFetch(`${base}${url}`, opts);
      done({ server, base });
    });
  });
}

const NO_GO = {
  verdict: "no-go",
  blocking_failures: 2,
  checks: [
    { name: "disk free", status: "pass", detail: "660 GB free" },
    {
      name: "control plane",
      status: "fail",
      detail: "started before control/server.mjs was edited",
      remedy_tool: "bench-ready",
      remedy: {
        id: "bench-ready",
        name: "Prepare bench",
        status: "wired",
        blocked_reason: null,
        refuse_while_running: true,
      },
    },
    {
      name: "campaign slot",
      status: "fail",
      detail: "a campaign occupies this slot — archive it",
      remedy_tool: null,
      remedy: null,
    },
  ],
};

test("a refused launch renders the button, what it fixes, and what it does not", async () => {
  const { server, base } = await fakeControlPlane(NO_GO);
  try {
    openCreate();
    await launchCell({ model: "qwen3.6-35b-a3b-bench", kind: "local" });
    const html = renderCreate(BOARD);

    assert.match(html, /PREFLIGHT REFUSED — NOTHING STARTED/);

    // THE BUTTON, carrying the tool id the click handler routes on.
    assert.match(html, /data-preflight-fix="bench-ready"/);
    assert.match(html, /Prepare bench/);
    // Named, so one press reads as the fix for a named check rather than a
    // hopeful retry.
    assert.match(html, /fixes control plane/);

    // AND what no button repairs, said out loud — otherwise pressing the button
    // above reads as a promise that the next launch goes through.
    assert.match(html, /No button for: campaign slot/);

    // The note must send the operator to the button rather than to a terminal.
    assert.match(html, /Press the tool below/);
  } finally {
    server.close();
  }
});

test("a refusal nothing can repair offers no button and says so", async () => {
  const { server, base } = await fakeControlPlane({
    verdict: "no-go",
    blocking_failures: 1,
    checks: [
      { name: "port 4440 (hub)", status: "fail", detail: "CLOSED", remedy_tool: null, remedy: null },
    ],
  });
  try {
    openCreate();
    await launchCell({ model: "qwen3.6-35b-a3b-bench", kind: "local" });
    const html = renderCreate(BOARD);

    assert.ok(!/data-preflight-fix=/.test(html), "there is no tool for a dead hub");
    assert.match(html, /NOTHING HERE CAN FIX THIS/);
    assert.match(html, /No button for: port 4440 \(hub\)/);
    // The old wording is the right one when there is genuinely nothing to press.
    assert.match(html, /Fix what preflight named, then start again/);
  } finally {
    server.close();
  }
});

test("a passing preflight renders no remedy block at all", async () => {
  const { server, base } = await fakeControlPlane({
    verdict: "go",
    blocking_failures: 0,
    checks: [{ name: "disk free", status: "pass", detail: "660 GB free" }],
  });
  try {
    openCreate();
    // The launch proceeds past preflight and fails at /api/run/preview (this
    // fake answers every path with the preflight body), which is enough: the
    // remedy block is gated on the PREFLIGHT row failing, not on any failure.
    await launchCell({ model: "qwen3.6-35b-a3b-bench", kind: "local" });
    const html = renderCreate(BOARD);
    assert.ok(!/FIX IT FROM HERE/.test(html));
    assert.ok(!/data-preflight-fix=/.test(html));
  } finally {
    server.close();
  }
});
