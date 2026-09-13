// The process-group kill, proven BEHAVIOURALLY.
//
// The defect class: a deadline that kills only the DIRECT child is not a
// deadline. The old spawnSync timeout SIGKILLed `npx` — but its surviving
// vitest/playwright descendant held the inherited write end of the stdio
// pipe, so the call never returned, `writeReport` never ran, and the harness
// watchdog killed the whole suite (1789076475: 118 gates unscored, no report).
// Source-text pins cannot catch a helper that says the right words and kills
// the wrong process; only a real descendant holding a real pipe can.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { spawnWithDeadline } from "../lib/runner.mjs";

// The fixture: a direct child that (a) announces itself, (b) spawns a
// grandchild which INHERITS its stdout/stderr — so the grandchild holds the
// helper's pipe open exactly like a surviving vitest worker did — (c) records
// the grandchild's pid for the post-kill liveness probe, and (d) hangs forever.
// `node -e` runs this as CommonJS, hence require().
const HANG_WITH_DESCENDANT = `
console.log("direct-child-started");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const g = spawn(
  process.execPath,
  ["-e", "setInterval(()=>{},1000); console.log('grandchild-alive');"],
  { stdio: ["ignore", "inherit", "inherit"] }
);
fs.writeFileSync(process.env.GRANDCHILD_PIDFILE, String(g.pid));
setInterval(()=>{},1000);
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the deadline kills the WHOLE process group, not just the direct child", () => {
  it("a descendant holding the pipe cannot outlive the deadline", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-kill-"));
    try {
      const pidFile = path.join(dir, "grandchild.pid");
      const startedAt = Date.now();
      const run = await spawnWithDeadline({
        cmd: process.execPath,
        args: ["-e", HANG_WITH_DESCENDANT],
        cwd: dir,
        env: { ...process.env, GRANDCHILD_PIDFILE: pidFile },
        deadlineMs: 600,
        logPath: path.join(dir, "phase.log"),
      });
      const wallMs = Date.now() - startedAt;

      expect(run.timedOut).toBe(true);
      expect(run.status).toBe(null);
      expect(run.signal).toBe("SIGKILL");
      expect(run.error.code).toBe("ETIMEDOUT");
      // The await RESOLVING promptly is half the proof: the helper resolves on
      // stdio close, which a surviving pipe-holder would block indefinitely —
      // the original hang. If only the direct child died, this test times out.
      expect(wallMs, "helper stayed blocked on the inherited pipe").toBeLessThan(5000);

      // And the other half: the grandchild itself is dead. SIGKILL reap can lag
      // a beat (the orphan is reparented to init before it disappears), so
      // poll the liveness probe briefly instead of failing on the first EPERM
      // window.
      expect(fs.existsSync(pidFile), "fixture never wrote the grandchild pid").toBe(true);
      const pid = Number(fs.readFileSync(pidFile, "utf-8").trim());
      expect(pid).toBeGreaterThan(0);
      let alive = true;
      const grace = Date.now() + 2000;
      while (Date.now() < grace) {
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
          break;
        }
        await sleep(50);
      }
      expect(alive, `grandchild ${pid} outlived the group kill`).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a killed runner's output survives in the phase log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-log-"));
    try {
      const logPath = path.join(dir, "phase.log");
      const run = await spawnWithDeadline({
        cmd: process.execPath,
        args: ["-e", HANG_WITH_DESCENDANT],
        cwd: dir,
        env: { ...process.env, GRANDCHILD_PIDFILE: path.join(dir, "grandchild.pid") },
        deadlineMs: 1500,
        logPath,
      });
      expect(run.timedOut).toBe(true);
      // Diagnosability: the kill must not cost the operator what the runner
      // said before it — the streamed log is what a stalled phase is judged
      // from, and SIGKILL gives the child no chance to flush on the way out.
      // Both lines matter: the grandchild's arrives through the INHERITED
      // pipe, proving descendant output is captured too.
      const log = fs.readFileSync(logPath, "utf-8");
      expect(log).toContain("direct-child-started");
      expect(log).toContain("grandchild-alive");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a clean exit resolves with ok and its status", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-clean-"));
    try {
      const run = await spawnWithDeadline({
        cmd: process.execPath,
        args: ["-e", "console.log('done'); process.exit(0)"],
        cwd: dir,
        env: { ...process.env },
        deadlineMs: 5000,
        logPath: path.join(dir, "phase.log"),
      });
      expect(run.ok).toBe(true);
      expect(run.status).toBe(0);
      expect(run.timedOut).toBe(false);
      expect(run.signal).toBe(null);
      expect(run.stdout).toContain("done");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
