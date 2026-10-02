// ─────────────────────────────────────────────────────────────────────────────
// BOARD SCREENSHOT CAPTURE — an artifact, not a gate.
//
// This spec exists so every graded attempt leaves a picture of the rendered
// board behind: attempt-N-board.png, written into BENCH_CAPTURE_DIR (the /out
// cell directory) beside the attempt-N-report.json it illustrates. report.mjs
// runs it best-effort AFTER the report is written, under
// playwright.capture.config.ts, and ignores the outcome — there is nothing
// here to pass and nothing here that can fail an attempt.
//
// Hence NO assertions. A board that never renders or never settles is already
// the render gates' complaint (frontend/fixtures.ts gameReady); the only
// honest outcomes here are a PNG on disk or a clean absence of one. A goto
// that throws simply never reaches the screenshot line — absence, no error
// paths needed.
//
// The fixtures are the frontend ones: the gameServer auto-fixture boots the
// candidate itself (DEBUG_API on, per-worker port from lib/harness.ts), and
// the wrapped page.goto waits for the board to settle before returning, so
// the picture is what a player sees once the game has finished drawing.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";

import { test } from "../frontend/fixtures.ts";

const ATTEMPT = String(process.env.BENCH_ATTEMPT ?? "").trim();
const CAPTURE_DIR = String(process.env.BENCH_CAPTURE_DIR ?? "").trim();

// No attempt number or no output directory: nothing to name the PNG or
// nowhere to put it. report.mjs always sets both; this covers hand-runs.
test.skip(!ATTEMPT || !CAPTURE_DIR, "BENCH_ATTEMPT and BENCH_CAPTURE_DIR must be set");

test("board capture", async ({ page }) => {
  // Playwright does NOT create parent directories for a screenshot path.
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  await page.goto("/");
  await page.screenshot({
    path: path.join(CAPTURE_DIR, `attempt-${ATTEMPT}-board.png`),
  });
});
