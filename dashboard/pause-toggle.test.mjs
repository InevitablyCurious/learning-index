// ─────────────────────────────────────────────────────────────────────────────
// PAUSE-AFTER-EACH-GRADE TOGGLE
//
//     cd dashboard && node --test
//
// The confirm-step pause toggle is visible ONLY in dev mode, defaults ON, and
// reaches the start payload as pauseAfterGrade when on — but is never sent when
// dev mode is off. The pause itself has no panel on the board: it serves the
// agent iterating on the grader, which reads and releases it through the
// control plane (Jerry, 2026-10-18).
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import { openCellConfirm, renderCreate, launchCell, toggleCreatePause } from "./panels/create.js";

const BOARD = {
  models_ledger: {
    startable: [{ id: "a/model", label: "A Model", context: 262144 }],
    cloud: { spend_ceiling_usd: 5, spend_note: "" },
  },
  control: { capabilities: { dev_mode: { enabled: true } } },
};

test("the pause toggle renders ONLY in dev mode, default ON", () => {
  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });
  const html = renderCreate(BOARD);
  assert.match(html, /PAUSE AFTER EACH GRADE: ON/, "the toggle defaults on");
  assert.ok(html.includes("data-create-pause"), "the click hook the board routes on");
  assert.match(html, /The run stops after every grade so you can play the game and read what the model will be told, before anything is sent\./);
});

test("the pause toggle is hidden entirely when dev mode is off", () => {
  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });
  const html = renderCreate({
    ...BOARD,
    control: { capabilities: { dev_mode: { enabled: false } } },
  });
  assert.ok(!html.includes("PAUSE AFTER EACH GRADE"), "no toggle when dev mode is off");
  assert.ok(!html.includes("data-create-pause"));
});

test("pause on reaches the start payload as pauseAfterGrade (dev mode on)", async () => {
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method ?? "GET";
    seen.push({ url: u, method, opts });
    if (u.startsWith("/api/preflight")) {
      return { ok: true, status: 200, json: async () => ({ verdict: "go", blocking_failures: 0, checks: [] }) };
    }
    if (u === "/api/run/preview" && method === "POST") {
      return { ok: true, status: 200, json: async () => ({ ok: true, token: "t" }) };
    }
    if (u === "/api/run/start" && method === "POST") {
      return { ok: true, status: 200, json: async () => ({ ok: true, pid: 1 }) };
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };

  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });
  // Default ON; confirm the toggle is on, then launch with dev mode on.
  await launchCell({ devOn: true });

  const start = seen.find((c) => c.url === "/api/run/start" && c.method === "POST");
  const body = JSON.parse(start.opts.body);
  assert.equal(body.pauseAfterGrade, true, "the start body carries pauseAfterGrade: true");
});

test("pause is never sent when dev mode is off", async () => {
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method ?? "GET";
    seen.push({ url: u, method, opts });
    if (u.startsWith("/api/preflight")) {
      return { ok: true, status: 200, json: async () => ({ verdict: "go", blocking_failures: 0, checks: [] }) };
    }
    if (u === "/api/run/preview" && method === "POST") {
      return { ok: true, status: 200, json: async () => ({ ok: true, token: "t" }) };
    }
    if (u === "/api/run/start" && method === "POST") {
      return { ok: true, status: 200, json: async () => ({ ok: true, pid: 1 }) };
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };

  openCellConfirm({ model: "a/model", kind: "local", arm: "off" });
  toggleCreatePause(); // force it to whatever; the point is dev mode is off
  await launchCell({ devOn: false });

  const start = seen.find((c) => c.url === "/api/run/start" && c.method === "POST");
  const body = JSON.parse(start.opts.body);
  assert.ok(!("pauseAfterGrade" in body), "dev mode off means the key is never sent");
});
