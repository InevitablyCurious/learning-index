import { describe, expect, it } from "vitest";
import {
  COUNTED_ELEMENT_LABELS,
  REQUIRED_STATE_KEYS,
  REQUIRED_STATIC_TESTIDS,
  verdictFor,
  type PreGateResult,
} from "../conformance/pregate.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE BENCHMARK MUST NOT SCORE WHAT IT DID NOT LOOK AT.
//
// The pre-gate runs its checks in one pass and every step skips the rest when
// it fails. For a long time a skipped check produced no problem, and the spec
// read "no problem" as a pass. Measured on a scaffold with no implementation
// at all: 65 of 68 conformance gates green, 66 of 134 overall — the benchmark
// reporting half a product where there was none, and the error growing or
// shrinking with HOW the candidate failed, so it did not even cancel between
// the OFF and ON arms it exists to compare.
//
// `verdictFor` decides this now, and these tests pin it. They are unit tests
// on purpose: the rule is pure, and a test that needed a server and a browser
// would be the first thing skipped when it got slow.
// ─────────────────────────────────────────────────────────────────────────────

const result = (
  problems: PreGateResult["problems"],
  resolved: string[],
): PreGateResult => ({ problems, resolved: new Set(resolved) });

describe("a check the pre-gate never reached is not a pass", () => {
  it("reports a failure naming the reason, not silence", () => {
    const v = verdictFor("REQ-TESTID/testid.board", result([], []));
    expect(v).toBeDefined();
    expect(v?.observed).toMatch(/never evaluated/);
  });

  it("passes only when the check was actually resolved", () => {
    expect(verdictFor("REQ-BIND/boot", result([], ["REQ-BIND/boot"]))).toBeUndefined();
  });

  it("still reports a real finding when one exists", () => {
    const problems = [
      { check: "REQ-BIND/boot — server boots", expected: "listening", observed: "threw" },
    ];
    expect(verdictFor("REQ-BIND/boot", result(problems, ["REQ-BIND/boot"]))?.observed).toBe("threw");
  });

  it("prefers the real finding over the never-evaluated one", () => {
    // Both conditions true at once: a finding exists AND the id is unresolved.
    // The candidate's own failure is the more useful thing to report.
    const problems = [
      { check: "REQ-BIND/boot — server boots", expected: "listening", observed: "threw" },
    ];
    expect(verdictFor("REQ-BIND/boot", result(problems, []))?.observed).toBe("threw");
  });

  it("does not let one id swallow another's verdict by prefix", () => {
    // `state.off` must not absorb `state.off.white`'s finding.
    const problems = [
      { check: "REQ-STATE/state.off.white — seeded off counts survive", expected: "7", observed: "0" },
    ];
    const r = result(problems, ["REQ-STATE/state.off", "REQ-STATE/state.off.white"]);
    expect(verdictFor("REQ-STATE/state.off", r)).toBeUndefined();
    expect(verdictFor("REQ-STATE/state.off.white", r)?.observed).toBe("0");
  });
});

describe("the do-nothing control", () => {
  // Every conformance check the spec declares. A build that implements nothing
  // reaches the boot step and no further, so everything past it must report
  // "never evaluated" rather than green.
  const AFTER_BOOT = [
    ...REQUIRED_STATE_KEYS.map((k) => `REQ-STATE/state.${k}`),
    "REQ-STATE/state.off.white",
    "REQ-STATE/state.points.length",
    "REQ-DEBUG/debug.setState",
    "REQ-DEBUG/debug.roll",
    ...REQUIRED_STATIC_TESTIDS.map((t) => `REQ-TESTID/testid.${t}`),
    ...COUNTED_ELEMENT_LABELS.flatMap((l) => [`REQ-RENDER/${l}`, `REQ-TESTID/${l}`]),
    "REQ-RENDER/die-reload",
    "REQ-HINT/hint",
    "REQ-HINT/selectable",
  ];

  it("greens nothing when the server never booted", () => {
    // What a boot failure actually leaves behind: its own finding, and the
    // one id it managed to resolve.
    const stalled = result(
      [{ check: "REQ-BIND/boot — server boots", expected: "listening", observed: "threw" }],
      ["REQ-BIND/boot"],
    );
    const greened = AFTER_BOOT.filter((id) => verdictFor(id, stalled) === undefined);
    expect(greened).toEqual([]);
  });

  it("covers every check the pre-gate can resolve", () => {
    // A guard on the guard: if a check id is added to the spec and never
    // resolved anywhere, it would fail forever and this list would drift.
    // Keeping the count visible makes that obvious in review.
    expect(AFTER_BOOT.length).toBeGreaterThan(50);
  });
});
