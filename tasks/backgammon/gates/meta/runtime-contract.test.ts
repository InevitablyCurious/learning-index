// The grader's own runtime contract.
//
// Two defects, both measured on real runs, both invisible until they weren't:
//
//   1789076475 — a candidate's `maxPlies` recursed forever on doubles. Vitest's
//   `testTimeout` cannot fire against a SYNCHRONOUS loop, `spawnSync` had no
//   deadline, and the harness's 3600s watchdog killed the process group with the
//   suite one file in. No report was written AT ALL: 118 gates unscored, and the
//   repair loop had nothing to say because there was nothing to read.
//
//   The start script's flags were dropped from every spawn, so grading ran
//   `node <entrypoint>` flagless and worked only because the operator's host
//   Node (22.23.2) strips types natively. The worker image is node:22.12.0,
//   which does not — so on any host below 22.18 every candidate's server fails
//   to boot, `REQ-BIND/boot` is recorded as the CANDIDATE's failure, and 118
//   false capability deficits are certified in the tester's voice.
//
// These are grader self-tests: they grade the grader, never the candidate, and
// live in meta/ which is excluded from the roster.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { STALL_AREAS, stallCheckFor } from "../lib/stall.mjs";
import {
  HOST_NODE_FLOOR,
  assertHostNodeFloor,
  resolveEntrypoint,
  resolveStartCommand,
} from "../lib/entrypoint.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATES = path.resolve(HERE, "..");
const BENCH = path.resolve(GATES, "..", "..", "..");

describe("the start command travels with its runtime flags", () => {
  it("carries the scaffold's --experimental-strip-types", () => {
    const { entrypoint, flags } = resolveStartCommand(path.join(GATES, "..", "scaffold"));
    expect(entrypoint.endsWith("src/server.ts")).toBe(true);
    // Without this the scaffold cannot boot inside the worker image at all.
    expect(flags).toContain("--experimental-strip-types");
  });

  it("THE GOLDEN OBEYS THE CONTRACT IT DEFINES", () => {
    // It did not, and nothing caught it. CONTRACT.md and chunk-01 both publish
    // `node --experimental-strip-types src/server.ts`; the scaffold shipped
    // exactly that; the golden shipped `node src/server.ts`. The worker image
    // (node:22.12.0) cannot run a .ts entrypoint without the flag, so the
    // MEASUREMENT STANDARD could not run in the runtime candidates are built in.
    // It worked only because grading happened on a newer host Node — the exact
    // blind spot `01` warns about: what the golden satisfies incidentally.
    const golden = JSON.parse(
      fs.readFileSync(path.join(GATES, "..", "golden", "package.json"), "utf-8"),
    );
    const contract = fs.readFileSync(
      path.join(GATES, "..", "scaffold", "CONTRACT.md"),
      "utf-8",
    );
    const published = /Start command[^`]*`([^`]+)`/.exec(contract);
    expect(published, "CONTRACT.md no longer publishes a start command").toBeTruthy();
    expect(golden.scripts.start).toBe(published![1]);
  });

  it("returns no flags when the artifact declares none", () => {
    // A fixture, not the golden: tying this to a real tree made it assert
    // whatever that tree happened to do rather than the behaviour under test.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startcmd-"));
    try {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ scripts: { start: "node src/server.js" } }),
      );
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "src", "server.js"), "");
      expect(resolveStartCommand(dir).flags).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agrees with resolveEntrypoint on the file, so no caller can drift", () => {
    for (const dir of ["scaffold", "golden"]) {
      const target = path.join(GATES, "..", dir);
      expect(resolveStartCommand(target).entrypoint).toBe(resolveEntrypoint(target));
    }
  });

  it("EVERY spawn of the artifact passes the flags", () => {
    // An enumerated guard, not a spot check: a fourth spawn site added without
    // the flags would reintroduce the whole defect silently.
    // `lib/launch-server.mjs` was deleted: it existed only to register a
    // server's pid for host-side orphan sweeping, which the grading container
    // makes meaningless. Playwright's `webServer` went with it — each worker
    // now boots its own server through `frontend/fixtures.ts`, which spawns via
    // `startServer` in harness.ts and is therefore covered by the first entry.
    const sites = [
      "lib/harness.ts",
      "backend/gates-13-16.test.ts",
    ];
    for (const rel of sites) {
      const src = fs.readFileSync(path.join(GATES, rel), "utf-8");
      const bare = /spawn\(\s*"node"\s*,\s*\[\s*(?:entrypoint|resolveEntrypoint\()/;
      expect(bare.test(src), `${rel} spawns the artifact without its flags`).toBe(false);
      expect(src).toMatch(/\.\.\.(?:flags|startCmd\.flags)/);
    }
  });

  it("the frontend gets its server through the same spawn as everything else", () => {
    // One spawn path for all three runners. When the frontend had its own
    // (Playwright's `webServer` -> a launcher script), it was the one that
    // silently dropped the artifact's flags.
    const fixtures = fs.readFileSync(path.join(GATES, "frontend", "fixtures.ts"), "utf-8");
    expect(fixtures).toMatch(/startServer/);
    const cfg = fs.readFileSync(path.join(GATES, "playwright.config.ts"), "utf-8");
    expect(cfg, "webServer is back — the frontend has a second spawn path again")
      .not.toMatch(/webServer/);
  });
});

describe("the host must be able to run what the container built", () => {
  it("the floor matches the worker image, so the two cannot drift apart", () => {
    const dockerfile = fs.readFileSync(
      path.join(BENCH, "docker", "worker", "Dockerfile"),
      "utf-8",
    );
    const m = /FROM node:(\d+)\.(\d+)\.(\d+)/.exec(dockerfile);
    expect(m, "worker Dockerfile no longer pins a node:X.Y.Z base").toBeTruthy();
    expect([Number(m![1]), Number(m![2]), Number(m![3])]).toEqual(HOST_NODE_FLOOR);
  });

  it("refuses a host below the floor, and says what it would otherwise do", () => {
    expect(() => assertHostNodeFloor("v22.11.9")).toThrow(/below the floor/);
    // The message has to name the consequence: the failure it prevents looks
    // exactly like a candidate that cannot write a working server.
    expect(() => assertHostNodeFloor("v22.11.9")).toThrow(/record it as the candidate's failure/);
  });

  it("accepts the floor itself and anything above it", () => {
    expect(() => assertHostNodeFloor(`v${HOST_NODE_FLOOR.join(".")}`)).not.toThrow();
    expect(() => assertHostNodeFloor("v24.0.0")).not.toThrow();
    expect(() => assertHostNodeFloor(process.version)).not.toThrow();
  });

  it("refuses an unreadable version rather than assuming it is fine", () => {
    expect(() => assertHostNodeFloor("not-a-version")).toThrow(/could not read/);
  });
});

describe("no runner can outlive the suite", () => {
  const src = fs.readFileSync(path.join(GATES, "report.mjs"), "utf-8");

  it("every runner has a deadline clamped to what is left of the budget", () => {
    // The clamp is the arithmetic guarantee that report.mjs always reaches its
    // own write — without it a runner starting late could outlive the budget
    // and hand the ending back to the harness watchdog, which is the failure.
    expect(src).toMatch(/Math\.min\(RUNNER_TIMEOUT_MS,\s*remaining\)/);
    expect(src).toMatch(/spawnWithDeadline\(\{[\s\S]{0,200}?deadlineMs/);
  });

  it("kills with SIGKILL, because a synchronous loop never reaches a handler", () => {
    const runner = fs.readFileSync(path.join(GATES, "lib", "runner.mjs"), "utf-8");
    // SIGKILL, not SIGTERM: a process wedged in a synchronous loop never reaches
    // a signal handler. And it must hit the WHOLE group (detached + -child.pid),
    // not just the direct child — the old spawnSync timeout killed only npx and
    // let the surviving vitest/playwright descendant hold the pipe.
    expect(runner).toMatch(/detached:\s*true/);
    expect(runner).toMatch(/process\.kill\(-child\.pid,\s*"SIGKILL"\)/);
  });

  it("the suite budget leaves room under the harness's own gate timeout", () => {
    const budget = /SUITE_BUDGET_MS[\s\S]{0,200}?:\s*([\d_]+)/.exec(src);
    const runner = /RUNNER_TIMEOUT_MS[\s\S]{0,200}?:\s*([\d_]+)/.exec(src);
    expect(budget && runner).toBeTruthy();
    const budgetMs = Number(budget![1].replace(/_/g, ""));
    const runnerMs = Number(runner![1].replace(/_/g, ""));

    // The harness kills the process group at DEFAULT_GATE_TIMEOUT_S. The suite
    // must finish inside that or the report is lost — which is the whole defect.
    const harness = fs.readFileSync(
      path.join(BENCH, "bench", "adapters", "backgammon.py"),
      "utf-8",
    );
    const gate = /DEFAULT_GATE_TIMEOUT_S\s*=\s*(\d+)/.exec(harness);
    expect(gate, "harness no longer declares DEFAULT_GATE_TIMEOUT_S").toBeTruthy();
    expect(budgetMs).toBeLessThan(Number(gate![1]) * 1000);

    // And the per-runner cap must clear the slowest LEGITIMATE runner:
    // gates-09-12 is 14 tests x the 60s vitest testTimeout = 840s. A cap below
    // that would kill a slow-but-correct candidate and manufacture a failure.
    const vitest = fs.readFileSync(path.join(GATES, "vitest.config.ts"), "utf-8");
    const testTimeout = Number(
      /testTimeout:\s*([\d_]+)/.exec(vitest)![1].replace(/_/g, ""),
    );
    const worstFile = 14 * testTimeout;
    expect(runnerMs).toBeGreaterThan(worstFile);
  });
});

describe("the instrument is pinned as tightly as the corpus it measures", () => {
  // THE STANDARD THIS HOLDS THE GRADER TO IS THE CORPUS'S OWN. The scaffold is
  // frozen byte-for-byte and a run ABORTS on a mismatch. The grader was
  // installed from `vitest: "^2.1.0"` — a RANGE — so a reinstall on a different
  // day could silently swap the test runner, and `grader_hash` excludes
  // node_modules so nothing would have recorded it.
  const pkg = JSON.parse(fs.readFileSync(path.join(GATES, "package.json"), "utf-8"));
  const lock = JSON.parse(fs.readFileSync(path.join(GATES, "package-lock.json"), "utf-8"));

  it("every dependency is an exact version, never a range", () => {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    expect(Object.keys(deps).length).toBeGreaterThan(0);
    for (const [name, spec] of Object.entries(deps)) {
      expect(
        /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(String(spec)),
        `${name} is "${spec}" — a range. The grader must not be able to change itself.`,
      ).toBe(true);
    }
  });

  it("every pin matches what the lockfile actually installs", () => {
    // A pin that disagrees with the lockfile is worse than no pin: it reads as
    // controlled and installs something else.
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const [name, spec] of Object.entries(deps)) {
      const entry = lock.packages?.[`node_modules/${name}`];
      expect(entry, `${name} is not in the lockfile`).toBeTruthy();
      expect(entry.version, `${name}: package.json says ${spec}`).toBe(spec);
    }
  });

  it("the lockfile is inside the grader's fingerprint", () => {
    // `grader_hash` skips node_modules, so the lockfile IS the record of which
    // toolchain a run used. If it ever stopped being hashed, the grader would
    // have no identity at all.
    const snapshot = fs.readFileSync(
      path.join(BENCH, "bench", "snapshot.py"),
      "utf-8",
    );
    const excluded = /GRADER_HASH_EXCLUDED[\s\S]*?\{([\s\S]*?)\}/.exec(snapshot)![1];
    expect(excluded).not.toMatch(/package-lock/);
    expect(excluded).not.toMatch(/package\.json/);
  });
});

describe("a stalled runner produces a finding the model can be told", () => {
  const src = fs.readFileSync(path.join(GATES, "report.mjs"), "utf-8");

  it("every situation it can emit has a symptom line to deliver", () => {
    // CALLED, not regex-matched. The first version scraped the source and
    // could not tell a matcher string from a returned area, so it demanded a
    // line for a key the function never emits. A pure function in its own
    // module can simply be run.
    //
    // What this catches is real: a check with no override raises
    // MissingFeedbackOverrideError and ends the campaign MID-RUN, after the
    // attempt was already graded. Two files have to agree and nothing else
    // makes them.
    const feedback = JSON.parse(fs.readFileSync(path.join(GATES, "feedback.json"), "utf-8"));
    expect(STALL_AREAS.length).toBeGreaterThan(0);
    for (const area of STALL_AREAS) {
      expect(
        feedback.gates,
        `a stall can report REQ-RESPONSIVE/${area} with no line for it`,
      ).toHaveProperty(`REQ-RESPONSIVE/${area}`);
    }
  });

  it("each runner lands in its own situation", () => {
    expect(stallCheckFor("backend backend/gates-01-08.test.ts")).toBe("REQ-RESPONSIVE/moving");
    expect(stallCheckFor("backend backend/gates-09-12.test.ts")).toBe("REQ-RESPONSIVE/bearingoff");
    expect(stallCheckFor("backend backend/gates-13-16.test.ts")).toBe("REQ-RESPONSIVE/aiturn");
    expect(stallCheckFor("backend backend/edge/edge-gates.test.ts")).toBe("REQ-RESPONSIVE/awkwardroll");
    expect(stallCheckFor("frontend")).toBe("REQ-RESPONSIVE/playing");
    expect(stallCheckFor("conformance")).toBe("REQ-RESPONSIVE/startup");
  });

  it("an unrecognised runner still yields a key that HAS a line", () => {
    // Inventing a key for an unknown runner would end the campaign mid-run.
    const feedback = JSON.parse(fs.readFileSync(path.join(GATES, "feedback.json"), "utf-8"));
    for (const odd of ["", null, undefined, "backend backend/gates-99.test.ts"]) {
      const key = stallCheckFor(odd);
      expect(feedback.gates).toHaveProperty(key);
    }
  });

  it("all three phases report one when they stall, not just the backend", () => {
    // The first version wired only the backend files. A conformance or frontend
    // stall is the same freeze to the person playing.
    expect(src).toMatch(/stallCheckFor\("conformance"\)/);
    expect(src).toMatch(/stallCheckFor\("frontend"\)/);
    expect(src).toMatch(/stallCheckFor\(`backend \$\{file\}`\)/);
  });

  it("the infra check is still recorded alongside it", () => {
    // `backend:runner <file>` stays for the scored artifacts and the operator —
    // it names the FILE, which the player-facing line deliberately does not.
    expect(src).toMatch(/backend:runner \$\{file\}/);
  });
});
