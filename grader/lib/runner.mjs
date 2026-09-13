// The per-runner execution primitive: spawn detached (child becomes its own
// process-group leader), stream stdout/stderr to a per-phase log file, and
// enforce the deadline by SIGKILLing the WHOLE process group — not just the
// direct child, which was the old spawnSync behaviour that let a surviving
// vitest/playwright descendant hold the pipe and hang grading forever.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

// Mirrors spawnSync's old maxBuffer safety valve: a runner that spews output
// must not balloon the grader's memory before the deadline kills it.
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Spawn cmd/args detached, stream output to logPath, enforce deadlineMs by
 * killing the process group. Resolves with the same shape the old spawnSync
 * returned so every downstream consumer is unchanged:
 *   { ok, status, signal, error, timedOut, skipped, elapsedMs, stdout, stderr }
 */
export async function spawnWithDeadline({ cmd, args, cwd, env, deadlineMs, logPath }) {
  const child = spawn(cmd, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (logPath) mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = logPath ? createWriteStream(logPath, { flags: "a" }) : null;

  let stdout = "";
  let stderr = "";
  const push = (target, chunk) => {
    if (target.length < MAX_BUFFER) target += chunk;
    return target;
  };
  const streamToLog = (chunk) => {
    if (logStream && !logStream.destroyed) logStream.write(chunk);
  };
  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = push(stdout, chunk); streamToLog(chunk); });
  }
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = push(stderr, chunk); streamToLog(chunk); });
  }

  const startedAt = Date.now();
  let timedOut = false;
  let spawnError = null;

  const killGroup = () => {
    try {
      // SIGKILL, not SIGTERM: a process wedged in a synchronous loop never
      // reaches a signal handler, and SIGTERM on a stuck vitest leaves the
      // worker fork alive holding the pipe — which is the hang again, one
      // level down.
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // group already gone — nothing left to reap
    }
  };

  // Manual deadline: kill the WHOLE group, not just the direct child.
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, deadlineMs);

  const { code, signal } = await new Promise((resolve) => {
    child.on("error", (err) => {
      spawnError = err;
      clearTimeout(timer);
      resolve({ code: null, signal: null });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  // Reap any descendant that outlived the direct child.
  killGroup();

  if (logStream) {
    await new Promise((resolve) => {
      if (logStream.destroyed) return resolve();
      logStream.end(resolve);
    });
  }

  const status = code;
  const elapsedMs = Date.now() - startedAt;
  const error = timedOut
    ? { code: "ETIMEDOUT", message: `deadline ${deadlineMs}ms exceeded` }
    : spawnError;

  return {
    ok: status === 0 && !error,
    status,
    signal: signal ?? null,
    error,
    timedOut,
    skipped: false,
    elapsedMs,
    stdout,
    stderr,
  };
}
