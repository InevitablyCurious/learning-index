import { defineConfig } from "vitest/config";

// The GRADER'S OWN test suite. These files exercise `lib/acceptance.ts`, the
// negative-control fixtures and the golden reference — never the candidate's
// code — so they are not gates and must never enter the roster denominator.
// They are kept, and kept running, because they are what stops the grading
// predicates from silently rotting.
export default defineConfig({
  test: {
    include: ["meta/**/*.test.ts"],
    testTimeout: 30_000,
    globals: false,
    environment: "node",
  },
});
