// ─────────────────────────────────────────────────────────────────────────────
// THE PAUSE IS NEVER A PER-RUN FLAG
//
//     cd dashboard && node --test
//
// There is no pause toggle. The confirm step used to carry one — visible only
// in dev mode, default ON — and the launch sent `pauseAfterGrade: true` with it.
// That made the pause a property of the CLICK, and it could only ever turn
// pauses OFF inside dev mode: the server refuses a pause when dev mode is off.
//
// The pause is now the server's, derived from its own dev-mode state. So the
// client sends nothing about it: no flag on the preview request (the gate the
// server answers before anything is committed) and none on the start request.
// Dev mode IS the control, and this file pins that the run modal does not carry
// a second one.
//
// The pause itself has no panel on the board: it serves the agent iterating on
// the grader, which reads and releases it through the control plane
// (Jerry, 2026-10-18).
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import { openCellConfirm, launchCell } from "./panels/create.js";

test("neither the preview nor the start body carries pauseAfterGrade", async () => {
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
  await launchCell();

  const posts = seen.filter((c) => c.method === "POST");
  const preview = posts.find((c) => c.url === "/api/run/preview");
  const start = posts.find((c) => c.url === "/api/run/start");
  assert.ok(preview && start, "the real launch path ran: preview then start");

  const previewBody = JSON.parse(preview.opts.body);
  assert.ok(!("pauseAfterGrade" in previewBody), "the gate sees no pause flag — the server owns it");
  const startBody = JSON.parse(start.opts.body);
  assert.ok(!("pauseAfterGrade" in startBody), "the key is ABSENT, not false");
});
