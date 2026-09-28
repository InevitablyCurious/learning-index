// ─────────────────────────────────────────────────────────────────────────────
// ONE SERVER PER TEST — parallel across workers, isolated between tests.
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
// ── ONE SERVER PER TEST, NOT PER WORKER ─────────────────────────────────────
//
// It was one server per worker PROCESS, reused across every test that worker
// ran, on the belief that consecutive tests were fine sharing one. They were
// not: the page shows whatever game the server holds (the spec: load the
// current state, never start one on load), so a test read what the test
// before it left. F15 counted F12's finished board (13 checkers) and blamed the
// host name; F09 passed or failed on the same code depending on whether F08
// had changed the difficulty first (run 1790194347). Each test now gets its
// own server from its own clean checkout — about a second of boot per test,
// and no result depends on what ran before it.
//
// ── WHY baseURL IS OVERRIDDEN HERE ──────────────────────────────────────────
//
// `lib/harness.ts` derives its port from the worker index and is evaluated per
// process, so `BASE_URL` is already right inside a worker — which is why F15,
// importing it directly, needs no change. But `use.baseURL` in the config is
// read in the MAIN process, where the index is 0. Left alone it would point
// every worker at worker 0's server. It is overridden per worker instead.
// ─────────────────────────────────────────────────────────────────────────────

import { test as base, expect, type Locator, type Page } from "@playwright/test";

import { BASE_URL, PORT, SETUP_REFUSED, assertSetupTook, startServer, stopServer, type ServerHandle } from "../lib/harness.ts";
import { waitForBoardSettled } from "./board-geometry.ts";

export const test = base.extend<{ gameServer: ServerHandle }>({
  gameServer: [
    async ({}, use) => {
      // DEBUG_API on: the gates drive positions and dice through it, exactly as
      // the conformance and backend runners do.
      const handle = await startServer({ debug: true });
      await use(handle);
      await stopServer(handle);
    },
    { scope: "test", auto: true },
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

  // THE GAME READY, BEFORE ANY GATE TOUCHES IT. The spec has the page load its
  // game from the server when it opens, so a correct page draws its pieces —
  // and wires its buttons — a moment after the frame appears. Gates that
  // clicked or read in that moment judged page-load speed, not the game: the
  // reference delayed by 400 ms (mutation M49, a legal page) failed 9 of 37
  // frontend gates, and run 1790329339's first Roll click was ignored ("no dice
  // after a roll") where a player's, a moment later, rolled. Every open and
  // reload now waits, as a player does, for the drawn board to hold still.
  page: async ({ page }, use) => {
    const goto = page.goto.bind(page);
    const reload = page.reload.bind(page);
    page.goto = async (...args: Parameters<Page["goto"]>) => {
      const response = await goto(...args);
      await gameReady(page);
      return response;
    };
    page.reload = async (...args: Parameters<Page["reload"]>) => {
      const response = await reload(...args);
      await gameReady(page);
      return response;
    };
    await use(page);
  },
});

/** A board that never draws or never settles is the render checks' complaint
 *  (a needs marker, harness/adapters/challenge/stages.py) — and a board whose
 *  points or pieces are drawn but untagged is the tag checks' complaint: the
 *  settle wait finds them by tag, and run 1790597957's untagged page read as a
 *  board that never settled, told in the player's voice through every check. */
async function gameReady(page: Page): Promise<void> {
  try {
    await waitForBoardSettled(page);
  } catch (err) {
    throw new Error(
      `[needs: REQ-RENDER/point REQ-RENDER/checker REQ-TESTID/point REQ-TESTID/checker] ${(err as Error).message}`,
    );
  }
}

export { expect, PORT, BASE_URL };

/**
 * Put the server into a position through the candidate's debug endpoint, and
 * fail with the SETUP_REFUSED marker when it did not take (see lib/harness.ts
 * assertSetupTook) — so a refused setup is never reported as the behaviour
 * the gate goes on to judge.
 */
export async function setupState(page: Page, body: Record<string, any>): Promise<any> {
  const response = await page.request.post("/api/debug/state", { data: body });
  if (!response.ok()) {
    throw new Error(`${SETUP_REFUSED}: /api/debug/state answered HTTP ${response.status()}`);
  }
  const echo = await response.json().catch(() => null);
  assertSetupTook(body, echo);
  return echo;
}

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
  // WAIT FOR IT TO HOLD STILL, THEN CLICK WHERE IT IS. A checker slides into
  // place after a redraw; reading its position mid-slide clicks where it WAS.
  // That is the stability wait `locator.click()` does for itself, and leaving
  // it out made the reference solution fail F10 and F14 (grader image of
  // 2026-09-16). Its centre must match on two consecutive animation frames.
  //
  // Pages also redraw checkers by replacing their elements, so an element found
  // a moment ago can be gone: each try looks it up afresh, and a replaced
  // element (zero size, or never still) simply gets another try.
  //
  // Held still means its CENTRE stayed put: a hint pulsing in place (the prompt
  // asks for animated hints) never keeps one box, and a player clicks it anyway.
  //
  // And a player clicks the part of it that shows. A hint drawn on top of a
  // stack can have the stack's last checker over its centre — the reference at
  // 1280x800 with checkers a few px wider (FIX-17: M59, M63, M66) — and a click
  // aimed at the centre went to the checker, told as "could make only one
  // move". When no part of it shows, the click lands on whatever covers it, as
  // a player's would.
  let point: { x: number; y: number } | null = null;
  for (let tries = 0; tries < 20 && !point; tries++) {
    try {
      point = await target.evaluate(
        async (el) => {
          el.scrollIntoView({ block: "center", inline: "center" });
          const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
          let prev = "";
          let box: DOMRect | null = null;
          for (let i = 0; i < 120 && !box; i++) {
            await frame();
            if (!el.isConnected) return null;
            const r = el.getBoundingClientRect();
            const cur = [r.x + r.width / 2, r.y + r.height / 2].map((v) => v.toFixed(1)).join(",");
            if (cur === prev && r.width > 0 && r.height > 0) box = r;
            prev = cur;
          }
          if (!box) return null;
          const shows = (x: number, y: number) => {
            const hit = document.elementFromPoint(x, y);
            return !!hit && (hit === el || el.contains(hit));
          };
          const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          if (shows(centre.x, centre.y)) return centre;
          for (const fy of [0.5, 0.3, 0.7, 0.2, 0.8]) {
            for (const fx of [0.5, 0.3, 0.7, 0.2, 0.8]) {
              const x = box.x + box.width * fx;
              const y = box.y + box.height * fy;
              if (shows(x, y)) return { x, y };
            }
          }
          return centre;
        },
        undefined,
        { timeout: 5000 },
      );
    } catch {
      point = null;
    }
    if (!point) await target.page().waitForTimeout(100);
  }
  if (!point) throw new Error("the element never held still on screen long enough to click");
  await target.page().mouse.click(point.x, point.y);
}

// ── PICK UP A PIECE THE WAY A PLAYER DOES ───────────────────────────────────
//
// A movable piece is one that answers a click with its move hints. The build
// prompt names no class for it, so the page's own markings are never read:
// run 1790414346's pieces picked up fine with none, and the model was told
// "After I rolled, there was no checker I could pick up to move" (FIX-26).
// The top white piece of each point the game has a legal move from (its own
// /api/state list) is tried first, then every other white stack: a player
// tries the pieces they see. True once a click brought hints up.
export async function pickUpAPiece(page: Page, hints: Locator): Promise<boolean> {
  const response = await page.request.post("/api/state", { data: {} });
  const state = response.ok()
    ? ((await response.json().catch(() => ({}))) as { legalMoves?: { from: number }[] })
    : {};
  const legal = [...new Set((state.legalMoves ?? []).map((m) => (m.from === 0 ? "bar" : String(m.from))))];
  const occupied = await page
    .locator('[data-testid="checker"][data-color="white"]')
    .evaluateAll((els) => [...new Set(els.map((el) => (el as HTMLElement).dataset.loc ?? ""))]);
  const others = occupied.filter((loc) => loc !== "" && loc !== "off" && !legal.includes(loc));
  for (const [locs, tries] of [
    [legal, 3],
    [others, 1],
  ] as const) {
    for (const loc of locs) {
      const pieces = page.locator(`[data-testid="checker"][data-color="white"][data-loc="${loc}"]`);
      // The highest piece a player can see: a tall stack can run past the
      // window's edge (run 1790608868 drew fifteen pieces on one point up past
      // the top of the screen, the top piece's click landed nowhere, and the
      // model was told "no checker I could pick up" of a stack that picked up
      // at a click on any piece in view).
      const onScreen = await pieces.evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          return r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
        }),
      );
      const top = onScreen.lastIndexOf(true);
      if (top < 0) continue;
      await playerClickUntilShown(pieces.nth(top), hints, tries);
      if ((await hints.count()) > 0) return true;
    }
  }
  return false;
}

/**
 * Click a checker the way a player does when the game is not ready yet: click,
 * look for the move hints, and click again if none came up. The reference
 * solution makes a checker clickable only after the dice finish rolling — a
 * player just clicks again, and `locator.click()` used to hide that by waiting
 * for the element to accept clicks. Stops as soon as `shown` appears; if it
 * never does, the caller's own assertion reports it.
 */
export async function playerClickUntilShown(target: Locator, shown: Locator, tries = 8): Promise<void> {
  for (let i = 0; i < tries; i++) {
    await playerClick(target);
    try {
      await expect(shown.first()).toBeAttached({ timeout: 1500 });
      return;
    } catch {
      // not ready yet — a player would click again
    }
  }
}

