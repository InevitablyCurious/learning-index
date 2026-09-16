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

import { test as base, expect, type Locator } from "@playwright/test";

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

// ── CLICK WHERE A PLAYER CLICKS ─────────────────────────────────────────────
//
// `locator.click()` insists that the element ITSELF receives the click, and
// times out when it does not. A player's mouse has no such rule: it lands on
// whatever is drawn on top at that spot. Run 1789564423's page set
// `pointer-events: none` on its checkers and handled the click on the point
// underneath — playable by hand, and four gates (F03, F04, F10, F14) timed out
// on the click alone. The checker must still be on screen; what receives the
// click is the page's own business.
export async function playerClick(target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  // Pages redraw checkers by replacing their elements, so an element found a
  // moment ago can be gone by the time it is measured. Each try looks it up
  // afresh; the position is read in the page, in the same coordinates the
  // mouse uses.
  let box: { x: number; y: number; width: number; height: number } | null = null;
  for (let tries = 0; tries < 20 && !box; tries++) {
    try {
      box = await target.evaluate((el) => {
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, undefined, { timeout: 1000 });
    } catch {
      await target.page().waitForTimeout(100);
    }
  }
  if (!box) throw new Error("the element never held still on screen long enough to click");
  await target.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
