import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // GRADED GATES ONLY. `backend/**` is the suite that runs against the
    // candidate's code and whose count is the roster denominator. The grader's
    // OWN self-tests live in `meta/` and are deliberately NOT included here —
    // see meta/README.md. Run them with `npm run test:meta`.
    include: ["backend/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    globals: false,
    environment: "node",
    // Backend gate files each boot a server on the fixed port 8002 — run files
    // strictly serially so they never contend for the port.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
