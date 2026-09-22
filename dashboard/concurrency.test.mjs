// ─────────────────────────────────────────────────────────────────────────────
// CONCURRENT LAUNCH — the toggle + N, end to end at the module level
//
// Pins the four facts the OFF-arm concurrency control promises:
//
//  1. The confirm frame RENDERS the toggle and the numeric N field.
//  2. Toggle ON + N → the /api/run/start body CARRIES `concurrency: N`.
//  3. Toggle OFF (the default) → the body carries NO `concurrency` key at all
//     (absent = the server's default of 1; a sent 1 would be a guess).
//  4. Garbage N → refused LOUDLY on the client: nothing is ever POSTed (the
//     validation at create.js:728-736 runs before the preview POST), and the
//     launch row says "positive integer" in so many words.
//
// Drives the REAL launchCell path against a pure mock fetch (the body-capture
// idiom from devmode.test.mjs; no server, no network). No DOM stub is needed:
// board.js binds its listeners behind a boot guard (board.js:665) precisely so
// panel tests can import it under Node — same as refusal-remedy-render.test.mjs.
//
// `ui` is module-global and launchCell mutates it, so every test re-opens via
// openCellConfirm (resets step/arm/concurrency/launch — but NOT concurrencyN,
// which is set explicitly wherever it matters).
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  openCellConfirm,
  renderCreate,
  launchCell,
  launchRows,
  toggleCreateConcurrency,
  setCreateConcurrencyN,
} from "./panels/create.js";

/** A board whose ledger answers the confirm frame's two reads. */
const BOARD = {
  models_ledger: {
    startable: [{ id: "a/model", label: "A Model", context: 262144 }],
    cloud: { spend_ceiling_usd: 5, spend_note: "" },
  },
};

const json = (body) => ({ ok: true, status: 200, json: async () => body });

/**
 * The mock control plane: routes on url + method, records every call, and
 * answers launchCell's exact sequence — preflight "go", a fixed preview token,
 * a fixed start ok. Anything else is a test bug, not a tolerated 404.
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
const previews = (seen) => seen.filter((c) => c.url === "/api/run/preview" && c.method === "POST");

// ── A: the control renders ───────────────────────────────────────────────────

test("the OFF-arm confirm frame renders the concurrency toggle and the N field", () => {
  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });
  setCreateConcurrencyN("8");
  const html = renderCreate(BOARD);

  assert.match(html, /CONCURRENT/i, "the toggle must be present and named");
  assert.ok(html.includes("data-create-concurrency"), "the click hook the board routes on");
  assert.ok(html.includes("cconcurrent-n"), "the numeric N field");
});

// ── B: ON + N is sent ────────────────────────────────────────────────────────

test("toggle ON with N=3: the start POST carries concurrency 3", async () => {
  const seen = mockControlPlane();
  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });
  toggleCreateConcurrency();
  setCreateConcurrencyN("3");

  await launchCell({});

  assert.equal(starts(seen).length, 1, "exactly one start POST");
  const body = JSON.parse(starts(seen)[0].opts.body);
  assert.equal(body.concurrency, 3, "the count the operator typed, as a number");
  assert.equal(body.confirm, "t", "the preview token still rides along");
});

// ── C: OFF sends nothing ─────────────────────────────────────────────────────

test("toggle OFF (the default): the start POST carries no concurrency key", async () => {
  const seen = mockControlPlane();
  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });
  setCreateConcurrencyN("8"); // openCellConfirm does NOT reset N; be explicit.

  await launchCell({});

  assert.equal(starts(seen).length, 1);
  const body = JSON.parse(starts(seen)[0].opts.body);
  assert.ok(!("concurrency" in body), "absent key = the server's default, never a sent guess");
});

// ── D: garbage N refuses loudly, posts nothing ───────────────────────────────

test("garbage N: refused client-side — no preview, no start, and the row says why", async () => {
  const seen = mockControlPlane();
  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });
  toggleCreateConcurrency();
  setCreateConcurrencyN("abc");

  await launchCell({});

  // THE load-bearing assertion: nothing was ever POSTed. The validation runs
  // before the preview POST (create.js:728-736 precede :752), so "never posted"
  // means neither endpoint saw the garbage — preflight (a GET) did run.
  assert.equal(starts(seen).length, 0, "start must never be called");
  assert.equal(previews(seen).length, 0, "the refusal precedes the preview POST");
  assert.ok(seen.some((c) => c.url.startsWith("/api/preflight")), "preflight ran first");

  // And it is LOUD: the launch row carries the refusal in words.
  const launch = launchRows({}).find((r) => r.id === "launch");
  assert.equal(launch.state, "fail");
  assert.match(launch.detail, /positive integer/);
  assert.match(launch.detail, /"abc"/, "the operator's own input, quoted back");
});
