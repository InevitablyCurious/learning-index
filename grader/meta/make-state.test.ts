import { describe, expect, it } from "vitest";
import { makeState } from "../lib/harness";

// WO-AUDIT-A class b: the debug route keeps the previous test's fields, so a
// position that does not name turnOver inherited G28's `true` and G32 read the
// game as already over.
describe("a built position starts mid-turn", () => {
  it("clears turnOver unless the test sets it", () => {
    expect(makeState({}).turnOver).toBe(false);
    expect(makeState({ turnOver: true }).turnOver).toBe(true);
  });
});
