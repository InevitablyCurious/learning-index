import { defineConfig } from "vitest/config";

// Quarantined tests — excluded from grading, kept runnable so the work to make
// them deterministic starts from something that executes. See quarantine/README.md.
export default defineConfig({
  test: {
    include: ["quarantine/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    globals: false,
    environment: "node",
    fileParallelism: false,
    pool: "forks",
    // vitest 4 spelling of v2's `poolOptions.forks.singleFork`: one fork, and the
    // module isolation singleFork already turned off (vitest 4 migration guide).
    maxWorkers: 1,
    isolate: false,
  },
});
