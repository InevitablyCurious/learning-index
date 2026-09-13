// ─────────────────────────────────────────────────────────────────────────────
// HOW MANY WORKERS — asked of the machine, never written down.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
//
// No number here comes from any particular host. The grading container reads
// its OWN limits — the cgroup files Docker writes for it — so the answer is
// correct on a laptop and on a build server without either being told, and
// adding cores or memory changes it without anyone editing this file.
//
// ── IT SIZES AGAINST WHAT IS FREE, NOT WHAT EXISTS ──────────────────────────
//
// The operator may already have containers running — this bench's own cell, a
// database, anything. Sizing against TOTAL memory would start browsers into
// memory that is already spoken for and let the OOM killer choose which gate
// fails, which looks exactly like a candidate defect. See
// `availableMemoryBytes`.
//
// ── WHY MEMORY USUALLY DECIDES, NOT CORES ───────────────────────────────────
//
// Each frontend worker runs a browser. Measured on the real failing candidate
// (run 1788804359), ten of the fifteen frontend gates spend their time WAITING
// — the test asks "is the board there?", nothing appears, and it waits out its
// limit. The CPU is idle for most of the phase, so cores are rarely the binding
// constraint; browser memory is.
//
// ── THE ONE RULE THAT OUTRANKS SPEED ────────────────────────────────────────
//
// This may change how LONG grading takes and must never change WHAT it
// reports. A starved worker that blows a wait because the machine was busy is
// a false failure that depends on the hardware — the exact thing a benchmark
// cannot have. `meta/` holds the guard: the golden must grade identically at
// one worker and at the maximum.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import os from "node:os";

/** Fraction of the machine to use. Operator-set; the only knob. */
export const DEFAULT_TARGET = 0.7;

/**
 * Memory one worker needs: a browser plus the candidate's server.
 *
 * A property of the IMAGE (its Chromium build), not of any host, which is why
 * it is a constant rather than something re-guessed per machine. Verified by
 * `scripts/measure_worker_footprint.py` against the built image; raise it there
 * and here together if the browser version changes.
 */
export const WORKER_FOOTPRINT_BYTES = 450 * 1024 * 1024;

function readFirstNumber(paths) {
  for (const p of paths) {
    try {
      const raw = fs.readFileSync(p, "utf-8").trim();
      if (!raw || raw === "max") continue;
      const n = Number(raw.split(/\s+/)[0]);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      // Not this cgroup layout; try the next.
    }
  }
  return null;
}

/** CPUs this container may use — its cgroup quota, else the host count. */
export function availableCpus() {
  // cgroup v2: "<quota> <period>", quota in microseconds per period.
  try {
    const raw = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf-8").trim();
    const [quota, period] = raw.split(/\s+/);
    if (quota !== "max") {
      const n = Number(quota) / Number(period);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    // Not cgroup v2, or unreadable.
  }
  // cgroup v1.
  const q = readFirstNumber(["/sys/fs/cgroup/cpu/cpu.cfs_quota_us"]);
  const p = readFirstNumber(["/sys/fs/cgroup/cpu/cpu.cfs_period_us"]);
  if (q && p) return q / p;

  // No limit set: the container may use the whole machine.
  return typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
}

/**
 * Memory actually AVAILABLE to this container right now, in bytes.
 *
 * ── FREE, NOT TOTAL ─────────────────────────────────────────────────────────
 *
 * Sizing against the total is wrong the moment anything else is running. The
 * operator may already have containers up — this bench's own cell, a database,
 * anything — and a worker count derived from the total would then start
 * browsers into memory that is already spoken for, and the OOM killer decides
 * which gate fails. That failure would look exactly like a candidate defect.
 *
 * Three sources, most specific first:
 *   1. This container's own cgroup: `memory.max - memory.current`.
 *   2. `/proc/meminfo` MemAvailable — the kernel's own estimate of what can be
 *      handed out without swapping, and it already accounts for every other
 *      container on the same host.
 *   3. `os.freemem()`.
 */
export function availableMemoryBytes() {
  const limit = readFirstNumber([
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  ]);
  // An unset v1 limit is reported as an absurd sentinel rather than "max".
  if (limit && limit < Number.MAX_SAFE_INTEGER / 2) {
    const used = readFirstNumber([
      "/sys/fs/cgroup/memory.current",
      "/sys/fs/cgroup/memory/memory.usage_in_bytes",
    ]);
    return Math.max(0, limit - (used ?? 0));
  }

  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf-8");
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
    if (m) return Number(m[1]) * 1024;
  } catch {
    // Not Linux, or unreadable.
  }
  return os.freemem();
}

/**
 * Workers to run. `maxUseful` caps it where more cannot help — there is no
 * point starting more workers than there are tests, whatever the machine has.
 */
export function resolveWorkers({
  target = Number(process.env.BENCH_WORKER_TARGET ?? DEFAULT_TARGET),
  maxUseful = Infinity,
  footprint = WORKER_FOOTPRINT_BYTES,
  cpus = availableCpus(),
  memoryBytes = availableMemoryBytes(),
} = {}) {
  // An explicit count wins outright: the 1-vs-N guard needs to be able to pin
  // it, and an operator debugging a flake needs to be able to force one worker.
  const forced = Number(process.env.BENCH_WORKERS);
  if (Number.isFinite(forced) && forced >= 1) return Math.floor(forced);

  const fraction = Number.isFinite(target) && target > 0 && target <= 1 ? target : DEFAULT_TARGET;
  const byCpu = Math.floor(cpus * fraction);
  const byMemory = Math.floor((memoryBytes * fraction) / footprint);
  return Math.max(1, Math.min(byCpu, byMemory, Math.floor(maxUseful)));
}

/**
 * Is there room for even ONE worker?
 *
 * Returns a refusal string, or null when grading may proceed. Called by
 * preflight: starting a grading pass that cannot fit a single browser produces
 * an OOM kill mid-suite, and an OOM kill is recorded as gates failing — a
 * machine that was busy, certified as a candidate that was wrong.
 */
export function insufficientResources({
  footprint = WORKER_FOOTPRINT_BYTES,
  memoryBytes = availableMemoryBytes(),
  cpus = availableCpus(),
} = {}) {
  const gib = (b) => `${(b / 1024 ** 3).toFixed(1)}GiB`;
  if (memoryBytes < footprint) {
    return (
      `not enough free memory to grade: ${gib(memoryBytes)} available, and one ` +
      `test worker needs ${gib(footprint)}. Free some memory (other containers ` +
      "are the usual cause) or raise Docker's memory allocation, then re-run. " +
      "Grading now would be killed part-way and recorded as the candidate failing."
    );
  }
  if (!(cpus >= 1)) {
    return `not enough CPU to grade: ${cpus} available, at least 1 required`;
  }
  return null;
}

/** What the decision was, for the log — a number with no reasoning is unarguable. */
export function describeWorkers(opts = {}) {
  const cpus = opts.cpus ?? availableCpus();
  const memoryBytes = opts.memoryBytes ?? availableMemoryBytes();
  const target = opts.target ?? Number(process.env.BENCH_WORKER_TARGET ?? DEFAULT_TARGET);
  const n = resolveWorkers({ ...opts, cpus, memoryBytes });
  const gib = (b) => `${(b / 1024 ** 3).toFixed(1)}GiB`;
  return (
    `workers=${n} target=${target} cpus=${cpus.toFixed(1)} memory=${gib(memoryBytes)} ` +
    `footprint=${gib(opts.footprint ?? WORKER_FOOTPRINT_BYTES)}` +
    (Number.isFinite(opts.maxUseful) ? ` max_useful=${opts.maxUseful}` : "")
  );
}
