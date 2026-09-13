// ─────────────────────────────────────────────────────────────────────────────
// ONE SERVER PER WORKER — what makes the frontend gates parallelisable.
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
//
// `playwright.config.ts` used to declare a `webServer`: Playwright booted ONE
// copy of the candidate before the run and every test shared it. That is why
// the config carried `workers: 1, fullyParallel: false` — two tests at once
// would overwrite each other's position through the debug API.
//
// The tests were never sequential in themselves. Each builds its own state from
// nothing: F03 starts a new game and forces its own dice, F09 constructs an
// entire board and pushes it in. They needed to not be DISTURBED, not to run in
// order. A server each gives them that, and the ordering constraint disappears.
//
// ── WHY A WORKER FIXTURE AND NOT A TEST FIXTURE ─────────────────────────────
//
// `scope: "worker"` boots one server per worker PROCESS and reuses it across
// every test that worker runs. Per-test would be correct too and hopelessly
// slow — fifteen server boots instead of N — and the isolation that matters is
// between workers running AT THE SAME TIME, not between consecutive tests on
// one worker, which were already fine sharing a server when they were serial.
//
// ── WHY baseURL IS OVERRIDDEN HERE ──────────────────────────────────────────
//
// `lib/harness.ts` derives its port from the worker index and is evaluated per
// process, so `BASE_URL` is already right inside a worker — which is why F15,
// importing it directly, needs no change. But `use.baseURL` in the config is
// read in the MAIN process, where the index is 0. Left alone it would point
// every worker at worker 0's server. It is overridden per worker instead.
// ─────────────────────────────────────────────────────────────────────────────

import { test as base, expect } from "@playwright/test";

import { BASE_URL, PORT, startServer, stopServer, type ServerHandle } from "../lib/harness.ts";

export const test = base.extend<{}, { gameServer: ServerHandle }>({
  gameServer: [
    async ({}, use) => {
      // DEBUG_API on: the gates drive positions and dice through it, exactly as
      // the conformance and backend runners do.
      const handle = await startServer({ debug: true });
      await use(handle);
      await stopServer(handle);
    },
    { scope: "worker", auto: true },
  ],

  // Every worker talks to its OWN server. `PORT` already carries the worker
  // index; this is only here because the config's copy cannot.
  baseURL: [
    async ({ gameServer }, use) => {
      void gameServer; // ordering: the server must exist before a URL means anything
      await use(BASE_URL);
    },
    { scope: "test" },
  ],
});

export { expect, PORT, BASE_URL };
