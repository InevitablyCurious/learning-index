// ─────────────────────────────────────────────────────────────────────────────
// DEV MODE — the drawer section, the topbar marker, and the toggle POST
//
// Two facts this file pins:
//
//  1. THE TOGGLE SENDS THE DESIRED VALUE, not a flip of a local copy. The
//     server owns the state; a flip computed in the panel would race the poll
//     that refreshes it and could show ON for a server that refused.
//
//  2. UNREACHABLE IS NOT OFF. A board with no `control.capabilities` renders
//     UNKNOWN in BOTH the drawer section and the topbar marker. Drawing a
//     confident OFF for a service that did not reply is the same defect as
//     reporting a stalled cell from silence — the answer to "no signal" is
//     "no signal".
//
// Everything under test is pure (string in / string out) or uses fetch, so no
// DOM stub is needed — only the `globalThis.fetch` stub, following the idiom
// in panel-fetch-wiring.test.mjs. Board shapes follow run-liveness.test.mjs.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

const { setDevMode, renderDevModeSection } = await import("./panels/devmode.js");
const { renderTopbar } = await import("./panels/chrome.js");


/** A board whose control plane answered, carrying a dev_mode capability. */
function boardWithDevMode(devMode) {
  return {
    run: {},
    control: { capabilities: { dev_mode: devMode } },
    sources: [],
  };
}

// ── the toggle POST ──────────────────────────────────────────────────────────

test("setDevMode POSTs the DESIRED value — on", async () => {
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), opts });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  await setDevMode(true);

  assert.equal(seen.length, 1, "the toggle must hit the control plane exactly once");
  assert.equal(seen[0].url, `/api/devmode`);
  assert.equal(seen[0].opts.method, "POST");
  assert.deepEqual(
    JSON.parse(seen[0].opts.body),
    { enabled: true },
    "the body carries the value we WANT, not a flip of a local copy",
  );
});

test("setDevMode POSTs the DESIRED value — off", async () => {
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), opts });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  await setDevMode(false);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `/api/devmode`);
  assert.equal(seen[0].opts.method, "POST");
  assert.deepEqual(JSON.parse(seen[0].opts.body), { enabled: false });
});

// ── the drawer section ───────────────────────────────────────────────────────

test("renderDevModeSection ON — the switch position carries the state", () => {
  const html = renderDevModeSection(
    boardWithDevMode({ enabled: true, source: "state_file" }),
  );
  assert.ok(html.includes('data-state="on"'), "the row must carry the server's state");
  assert.ok(html.includes('role="switch"'), "it is a state, so it is a switch");
  assert.ok(html.includes('aria-checked="true"'), "and assistive tech must read it as on");
  assert.ok(html.includes("class=\"sw on\""), "the knob position is the value");
});

test("renderDevModeSection OFF — off is off, and settable", () => {
  const html = renderDevModeSection(
    boardWithDevMode({ enabled: false, source: "state_file", settable: true }),
  );
  assert.ok(html.includes('data-state="off"'));
  assert.ok(html.includes('aria-checked="false"'));
  assert.ok(!html.includes("disabled"), "a settable off switch must not be disabled");
});

test("renderDevModeSection UNKNOWN — absence of the control plane is a THIRD position, never OFF", () => {
  // No `control.capabilities` at all: the control plane did not answer.
  const html = renderDevModeSection({});
  assert.ok(html.includes('data-state="unknown"'), "silence must render as its own state");
  assert.ok(html.includes('aria-checked="mixed"'), "not true, not false — mixed");
  assert.ok(html.includes("disabled"), "and it cannot be operated while unread");
  assert.ok(
    !html.includes('aria-checked="false"'),
    "a confident OFF for a service that did not reply is the whole defect",
  );
});

test("renderDevModeSection ON warns that seeded cells are not floors", () => {
  const html = renderDevModeSection(boardWithDevMode({ enabled: true, source: "state_file" }));
  assert.ok(html.includes("NOT scorable floors"), "the cost of the mode must stay on screen");
});

test("an unsettable mode renders disabled and says why", () => {
  const html = renderDevModeSection(
    boardWithDevMode({
      enabled: false,
      source: "environment",
      settable: false,
      settable_reason: "pinned by the environment",
    }),
  );
  assert.ok(html.includes("disabled"));
  assert.ok(html.includes("pinned by the environment"), "a refusal must name its reason");
});

// ── the topbar marker ────────────────────────────────────────────────────────

test("renderTopbar marks DEV MODE ON when the server says on", () => {
  const html = renderTopbar(
    boardWithDevMode({ enabled: true, source: "state_file" }),
    { stale: false, lastError: null },
  );
  assert.ok(html.includes("DEV MODE ON"), "the fact belongs in the bar, before any drawer opens");
  assert.ok(html.includes("devmode-on"), "with the on marker class");
});

test("renderTopbar renders NO marker when the server says off", () => {
  const html = renderTopbar(
    boardWithDevMode({ enabled: false, source: "state_file" }),
    { stale: false, lastError: null },
  );
  assert.ok(!html.includes("DEV MODE ON"), "off must not wear the on marker");
  assert.ok(!html.includes("DEV MODE ?"), "off is an answer — it is not unknown");
});

test("renderTopbar marks DEV MODE ? when the control plane is unreachable — never ON, never OFF", () => {
  // The run-liveness board shape for "the control plane did not answer".
  const html = renderTopbar(
    { run: {}, control: null, sources: [] },
    { stale: false, lastError: null },
  );
  assert.ok(html.includes("DEV MODE ?"), "silence must render as the unknown marker");
  assert.ok(html.includes("devmode-unknown"), "with the unknown marker class");
  assert.ok(!html.includes("DEV MODE ON"), "an unreachable plane is not on");
});
