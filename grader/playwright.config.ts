import { defineConfig } from "@playwright/test";
import { resolveWorkers } from "./lib/workers.mjs";

export default defineConfig({
  testDir: "./frontend",
  // ONE SERVER PER WORKER, so these can run at once. The old comment here read
  // "a SINGLE shared game server holds mutable in-memory state ... run strictly
  // serially so no test mutates the server out from under another" — true of
  // the arrangement, never of the tests, each of which builds its own position
  // from scratch. `frontend/fixtures.ts` gives each worker its own server on
  // its own port and the constraint is gone.
  //
  // `workers` is resolved from the machine at run time (lib/workers.mjs), so a
  // small host still runs one at a time and behaves exactly as before.
  workers: resolveWorkers(),
  fullyParallel: true,
  use: {
    // NO baseURL HERE. It is a per-worker fixture (frontend/fixtures.ts): this
    // file is read in the MAIN process, where the worker index is 0, so a value
    // set here would point every worker at worker 0's server. Playwright
    // refuses the conflict outright, which is the right behaviour.
    viewport: { width: 1280, height: 800 },
    screenshot: "on",
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
