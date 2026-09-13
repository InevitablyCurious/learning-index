import { expect, test } from "@playwright/test";
import {
  REQUIRED_STATE_KEYS,
  REQUIRED_STATIC_TESTIDS,
  runPreGate,
  type Problem,
} from "./pregate.ts";

// ─────────────────────────────────────────────────────────────────────────────
// ONE TEST PER CHECK — because one test is one gate.
//
// This was a SINGLE test that ran the whole pre-gate and asserted the problem
// list was empty. `roster.mjs` enumerates one gate per test case, so the entire
// pre-gate was one roster entry, one square on the wall, and one line in
// `feedback.json`. Every check inside it therefore rendered the SAME sentence,
// and the dedupe kept one: eleven distinct findings reached the model on run
// 1788599410 as "The game doesn't seem to start up correctly at all" — a
// sentence contradicted by the 36 gates that passed in the same attempt.
//
// Splitting it here needs no change to `roster.mjs`: its rule is already
// "every enumerable test is exactly one gate", and `playwright test --list`
// walks these without executing them.
//
// ── THE PRE-GATE RUNS ONCE ───────────────────────────────────────────────────
// `runPreGate()` boots a server on :8002 and a browser. It must NOT run 65
// times, so it runs in `beforeAll` and every test reads the shared result. The
// config is `workers: 1, fullyParallel: false`, so one run serves the file.
//
// `--list` never executes it: listing registers the tests without running any
// hook, which is what keeps enumeration safe beside a live cell (roster.mjs
// verified :8002 is never bound during a list).
//
// ── THE TOKEN IS SHARED ON PURPOSE ───────────────────────────────────────────
// Every title carries `[CONF]`. `roster.mjs` only promotes a token to the gate
// id when it is UNIQUE, so a shared token means each test gets a slug id
// (`conformance/pregate.spec.ts::[CONF] …`) while `gate_token` stays `CONF` —
// the documented shape for exactly this case: "keep the token in `gate_token`,
// so the board can still GROUP by requirement without the roster pretending
// five tests are one."
// ─────────────────────────────────────────────────────────────────────────────

let problems: Problem[] = [];
let preGateError: unknown = null;

test.beforeAll(async () => {
  try {
    problems = await runPreGate();
  } catch (error) {
    // A pre-gate that throws must fail every gate loudly rather than reporting
    // an empty problem list, which would read as a clean sweep.
    preGateError = error;
  }
});

/**
 * The finding for one check, or `undefined` when it passed.
 *
 * Matched on the id PLUS a trailing space, never a bare prefix: `state.off` and
 * `state.off.white` are different checks, as are `health.body` and
 * `health.body.status`, and a bare prefix would let one swallow the other's
 * failure and silently green a gate that failed.
 */
function findingFor(id: string): Problem | undefined {
  if (preGateError) {
    return {
      check: id,
      expected: "the conformance pre-gate completes",
      observed: String((preGateError as Error)?.message ?? preGateError),
    };
  }
  return problems.find((p) => p.check.startsWith(`${id} `));
}

function checkGate(id: string, title: string): void {
  test(`[CONF] ${title}`, () => {
    const found = findingFor(id);
    if (found) {
      // ── THE `PROBLEM` LINE IS A CONTRACT WITH report.mjs ──────────────────
      //
      // `parseProblemLine` requires exactly `PROBLEM <check>: expected <x>,
      // observed <y>` on stderr, and `runConformancePhase` reads it from each
      // test result's own stderr. Splitting this spec into 65 tests without
      // carrying these lines across silently emptied `problems`: the report
      // fell back to a single `conformance:boot` entry, and the repair prompt
      // went back to ONE generic complaint — the very collapse the split was
      // done to remove, reintroduced by a different route.
      //
      // Emitted per-test rather than in a batch, so each finding rides the
      // stderr of the gate it belongs to and the mapping stays one-to-one.
      console.error(
        `PROBLEM ${found.check}: expected ${found.expected}, observed ${found.observed}`,
      );
    }
    expect(
      found,
      found ? `${found.check}: expected ${found.expected}, observed ${found.observed}` : undefined,
    ).toBeUndefined();
  });
}

// ── boot and health ─────────────────────────────────────────────────────────
checkGate("REQ-BIND/boot", "the app boots and serves");
checkGate("REQ-BIND/health", "the health check responds");
checkGate("REQ-API/health.status", "the health check returns a success status");
checkGate("REQ-API/health.body", "the health check returns a JSON body");
checkGate("REQ-API/health.body.status", 'the health body carries status "ok"');

// ── the reported state, one gate per declared field ─────────────────────────
for (const key of REQUIRED_STATE_KEYS) {
  checkGate(`REQ-STATE/state.${key}`, `the reported state carries "${key}"`);
}
checkGate("REQ-STATE/state.off.white", "borne-off counts survive a set and read back");

// ── debug hooks the suite drives the app with ───────────────────────────────
checkGate("REQ-DEBUG/debug.setState", "a specific board position can be set and read back");
checkGate("REQ-DEBUG/debug.roll", "a queued dice roll is honoured");

// ── automation handles, one gate per declared name ──────────────────────────
for (const testId of REQUIRED_STATIC_TESTIDS) {
  checkGate(`REQ-TESTID/testid.${testId}`, `the page tags "${testId}"`);
}

// ── counted elements: DRAWN and TAGGED are separate gates ───────────────────
// Split because the two failures have different audiences — a board with 20
// points is visible to anyone playing, 24 points that are untagged are visible
// only to an automated consumer. See `countedElement` in pregate.ts.
for (const [label, thing, verb] of [
  ["point", "24 board points", "are"],
  ["checker", "30 checkers", "are"],
  ["bar", "the bar", "is"],
  ["off-tray", "the off tray", "is"],
  ["die", "the dice", "are"],
] as const) {
  checkGate(`REQ-RENDER/${label}`, `${thing} ${verb} drawn`);
  checkGate(`REQ-TESTID/${label}`, `${thing} ${verb} tagged for automation`);
}

// ── behaviour ───────────────────────────────────────────────────────────────
checkGate("REQ-HINT/hint", "selecting a movable checker shows move hints");

// ── the pre-gate's own failures ─────────────────────────────────────────────
checkGate("REQ-TESTID/dom", "the page can be read by automation");
checkGate("REQ-TESTID/pregate", "the conformance run completes");
