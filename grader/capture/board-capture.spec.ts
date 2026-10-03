// ─────────────────────────────────────────────────────────────────────────────
// BOARD SCREENSHOT CAPTURE — an artifact, not a gate. UNCONDITIONAL.
//
// This spec exists so every graded attempt leaves a picture of the rendered
// board behind: attempt-N-board.png, written into BENCH_CAPTURE_DIR (the /out
// cell directory) beside the attempt-N-report.json it illustrates. report.mjs
// runs it best-effort AFTER the report is written, under
// playwright.capture.config.ts, and ignores the outcome — there is nothing
// here to pass and nothing here that can fail an attempt.
//
// The picture is the point, so NOTHING may stand between the run and the
// screenshot. Hence NO assertions and NO settle gate: a blank, broken, or
// half-drawn board is still photographed — that is precisely when the
// operator's live review most needs the picture. The frontend fixtures are
// deliberately NOT used here: their wrapped page.goto waits for tagged
// checkers to settle and throws when none render, and their auto gameServer
// fixture fails the test before the body runs when the candidate cannot
// boot. Either throw used to skip the screenshot entirely.
//
// Instead this spec boots the candidate itself (lib/harness.ts startServer)
// and navigates a raw page, each inside a try/catch that IGNORES failure:
// a server that never boots ("no entrypoint resolved", crash before
// /health) or a navigation refused still ends in a screenshot of whatever
// the browser is showing. A bounded fixed wait lets CSS and static layout
// render; there is no conditional wait to time out.
//
// The only skip left is the naming one: no BENCH_ATTEMPT or no
// BENCH_CAPTURE_DIR means nowhere to put the PNG (report.mjs always sets
// both; the skip covers hand-runs).
// ─────────────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";

import { test } from "@playwright/test";

import { BASE_URL, startServer, stopServer, type ServerHandle } from "../lib/harness.ts";

const ATTEMPT = String(process.env.BENCH_ATTEMPT ?? "").trim();
const CAPTURE_DIR = String(process.env.BENCH_CAPTURE_DIR ?? "").trim();

// No attempt number or no output directory: nothing to name the PNG or
// nowhere to put it. report.mjs always sets both; this covers hand-runs.
test.skip(!ATTEMPT || !CAPTURE_DIR, "BENCH_ATTEMPT and BENCH_CAPTURE_DIR must be set");

test("board capture", async ({ page }) => {
  // Playwright does NOT create parent directories for a screenshot path.
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });

  let server: ServerHandle | null = null;
  try {
    // Boot the candidate manually — the auto gameServer fixture is gone on
    // purpose: a boot failure must not abort the test before the body runs.
    // If it throws, `server` stays null and the capture proceeds anyway.
    try {
      server = await startServer({ debug: true });
    } catch {
      server = null;
    }

    // Raw navigation, no settle gate. Connection refused or a server that
    // died mid-load throws — ignored; the blank page is still worth a photo.
    try {
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    } catch {
      // Navigation failed — capture whatever is on screen regardless.
    }

    // Bounded fixed wait so CSS and static layout get a chance to render.
    await page.waitForTimeout(2500);

    await page.screenshot({
      path: path.join(CAPTURE_DIR, `attempt-${ATTEMPT}-board.png`),
    });
  } finally {
    if (server) await stopServer(server);
  }
});
