// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE CONFIG — the board-screenshot side effect, NOT a gate suite.
//
// Runs exactly one spec (capture/board-capture.spec.ts) that saves
// attempt-N-board.png beside the attempt report. report.mjs spawns it
// best-effort after the report is written and ignores the result entirely.
//
// Deliberately standalone: roster.mjs enumerates the gate suite with three
// --list commands (vitest, the DEFAULT frontend config, the conformance
// config) and this config is none of them — a capture is an artifact, not a
// gate, and must never enter the roster or any gate total.
//
// The viewport MUST match playwright.config.ts (1280x800): the picture is
// compared against what the player was told to expect on an ordinary laptop
// screen, and a different viewport is a different rendering. One worker, no
// parallelism: one attempt, one server, one picture.
// ─────────────────────────────────────────────────────────────────────────────

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./capture",
  workers: 1,
  fullyParallel: false,
  use: {
    // NO baseURL here, same reason as playwright.config.ts: it is a per-worker
    // fixture (frontend/fixtures.ts), and a value set in this file would be
    // read in the main process and conflict with the fixture.
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
  ],
});
