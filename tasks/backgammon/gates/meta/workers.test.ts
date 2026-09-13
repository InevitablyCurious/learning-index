// How many workers — the resolution logic.
//
// This decides how fast grading runs and must never decide what it reports.
// The parity check that enforces that lives in
// `scripts/verify_worker_parity.py` (it needs docker, so it is a script rather
// than a test); these cover the arithmetic and, more importantly, the
// REFUSALS — the cases where a number must not be taken at face value.

import { describe, expect, it } from "vitest";

import { DEFAULT_TARGET, resolveWorkers, describeWorkers } from "../lib/workers.mjs";

const GiB = 1024 ** 3;

describe("workers scale with the machine, not with a number someone wrote down", () => {
  it("a bigger machine gets more workers", () => {
    const small = resolveWorkers({ cpus: 2, memoryBytes: 4 * GiB, maxUseful: 99 });
    const big = resolveWorkers({ cpus: 32, memoryBytes: 64 * GiB, maxUseful: 99 });
    expect(big).toBeGreaterThan(small);
  });

  it("a one-core machine behaves exactly as before: one worker", () => {
    expect(resolveWorkers({ cpus: 1, memoryBytes: 64 * GiB, maxUseful: 99 })).toBe(1);
  });

  it("never returns zero, however small the machine", () => {
    // Floor division on a tiny box reaches 0, and 0 workers is not a slow run,
    // it is no run at all.
    expect(resolveWorkers({ cpus: 1, memoryBytes: 128 * 1024 * 1024, maxUseful: 99 })).toBe(1);
    expect(resolveWorkers({ cpus: 0.1, memoryBytes: 1024, maxUseful: 99 })).toBe(1);
  });

  it("memory is allowed to be the binding constraint, not just cores", () => {
    // The case that actually occurs: plenty of cores, browsers do not fit.
    const n = resolveWorkers({ cpus: 64, memoryBytes: 2 * GiB, maxUseful: 99 });
    expect(n).toBeLessThan(Math.floor(64 * DEFAULT_TARGET));
  });

  it("cores are allowed to be the binding constraint too", () => {
    const n = resolveWorkers({ cpus: 2, memoryBytes: 256 * GiB, maxUseful: 99 });
    expect(n).toBe(Math.floor(2 * DEFAULT_TARGET) || 1);
  });

  it("never exceeds what could possibly help", () => {
    // More workers than there are tests is waste, whatever the hardware allows.
    expect(resolveWorkers({ cpus: 256, memoryBytes: 512 * GiB, maxUseful: 4 })).toBe(4);
  });

  it("the target scales the answer, and is the only knob", () => {
    const base = { cpus: 16, memoryBytes: 64 * GiB, maxUseful: 99 };
    const half = resolveWorkers({ ...base, target: 0.5 });
    const full = resolveWorkers({ ...base, target: 1 });
    expect(full).toBeGreaterThan(half);
  });

  it("a nonsense target falls back to the default rather than doing something absurd", () => {
    const base = { cpus: 16, memoryBytes: 64 * GiB, maxUseful: 99 };
    const sane = resolveWorkers({ ...base, target: DEFAULT_TARGET });
    for (const bad of [0, -1, 5, Number.NaN, undefined]) {
      expect(resolveWorkers({ ...base, target: bad })).toBe(sane);
    }
  });

  it("an explicit count wins outright", () => {
    // The parity check pins it to 1 and to max; an operator chasing a flake
    // needs to be able to force one worker regardless of the machine.
    const prev = process.env.BENCH_WORKERS;
    try {
      process.env.BENCH_WORKERS = "1";
      expect(resolveWorkers({ cpus: 64, memoryBytes: 256 * GiB, maxUseful: 99 })).toBe(1);
      process.env.BENCH_WORKERS = "3";
      expect(resolveWorkers({ cpus: 1, memoryBytes: 1 * GiB, maxUseful: 99 })).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.BENCH_WORKERS;
      else process.env.BENCH_WORKERS = prev;
    }
  });

  it("says what it decided and why", () => {
    // A worker count with no reasoning behind it cannot be argued with when it
    // turns out to be wrong on somebody's machine.
    const line = describeWorkers({ cpus: 8, memoryBytes: 16 * GiB, maxUseful: 15 });
    expect(line).toMatch(/workers=\d+/);
    expect(line).toMatch(/target=/);
    expect(line).toMatch(/cpus=/);
    expect(line).toMatch(/memory=/);
    expect(line).toMatch(/footprint=/);
  });
});
