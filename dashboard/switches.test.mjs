// The settings drawer's stored preferences.
//
// Every one of these is a BROWSER preference that rides the next launch, not
// server state — so the failure mode they share is a control that looks set and
// is not. These cover the two halves of that: a value written here comes back,
// and a value that could not be honoured is refused where somebody sets it
// rather than silently ignored later.

import assert from "node:assert/strict";
import test from "node:test";

import {
  GRADER_TARGET_CHOICES,
  GRADER_TARGET_DEFAULT,
  graderWorkerTarget,
  setGraderWorkerTarget,
} from "./panels/switches.js";

/** Run `fn` with a fake localStorage backed by `store`. */
function withStorage(store, fn) {
  const real = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
    },
  };
  try {
    return fn();
  } finally {
    globalThis.window = real;
  }
}

// ── MACHINE SHARE (2026-09-11) ──────────────────────────────────────────────
//
// Not the same class as the run switches beside it, and the tests say why:
// those change what the AGENT does and make two runs incomparable. This changes
// how many test workers the GRADING container starts after the model is
// finished, and the gates and their verdicts are identical either way —
// enforced by scripts/verify_worker_parity.py.

test("machine share defaults to 70% when nothing is stored", () => {
  withStorage({}, () => {
    assert.equal(graderWorkerTarget(), GRADER_TARGET_DEFAULT);
    assert.equal(GRADER_TARGET_DEFAULT, 0.7);
  });
});

test("machine share round-trips a stored fraction", () => {
  const store = {};
  withStorage(store, () => {
    setGraderWorkerTarget(0.25);
    assert.equal(graderWorkerTarget(), 0.25);
  });
});

test("a nonsense fraction is never stored and never returned", () => {
  // A bad value would reach the container and be silently ignored there, so it
  // is refused at the point somebody could set it.
  const store = {};
  withStorage(store, () => {
    for (const bad of [0, -1, 2, Number.NaN, "abc", null, undefined]) {
      setGraderWorkerTarget(bad);
      assert.equal(graderWorkerTarget(), GRADER_TARGET_DEFAULT, `${bad} must be refused`);
    }
  });
});

test("a corrupted stored value falls back rather than propagating", () => {
  withStorage({ "okp.bench.graderWorkerTarget": "not-a-number" }, () => {
    assert.equal(graderWorkerTarget(), GRADER_TARGET_DEFAULT);
  });
  withStorage({ "okp.bench.graderWorkerTarget": "9" }, () => {
    assert.equal(graderWorkerTarget(), GRADER_TARGET_DEFAULT);
  });
});

test("blocked storage does not break the session", () => {
  const real = globalThis.window;
  globalThis.window = {
    get localStorage() {
      throw new Error("storage blocked");
    },
  };
  try {
    assert.equal(graderWorkerTarget(), GRADER_TARGET_DEFAULT);
    assert.doesNotThrow(() => setGraderWorkerTarget(0.5));
  } finally {
    globalThis.window = real;
  }
});

test("every offered choice is one the setting will actually accept", () => {
  // An option in the UI that the setter refuses would be a button that does
  // nothing — the class of defect this board's rules exist to prevent.
  const store = {};
  withStorage(store, () => {
    for (const f of GRADER_TARGET_CHOICES) {
      setGraderWorkerTarget(f);
      assert.equal(graderWorkerTarget(), f, `${f} is offered but not accepted`);
    }
  });
});
