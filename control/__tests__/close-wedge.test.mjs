// ─────────────────────────────────────────────────────────────────────────────
// CLOSE-WEDGE TESTS — pin runCommand's settlement on the child's `exit`.
// A descendant that outlives the child (a rebuild script's docker) holds the
// stdio pipe write-ends open, so `close` may never fire; runCommand must
// settle via its 300ms trailing-stdio grace after `exit`, and the timeout arm
// must still SIGTERM a live child and report code:"timeout".
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommand } from "../tools.mjs";

test("RUNCOMMAND: settles on `exit` when a surviving grandchild wedges the stdio pipes", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-close-wedge-"));
  try {
    // The exact wedge shape the old `close`-based settlement hung on: the
    // child writes a marker, spawns a grandchild that INHERITS the child's
    // stdout/stderr pipes and outlives the 300ms grace by a wide margin
    // (1200ms), then exits 0 naturally (the grandchild is unref'd, so it
    // never holds the child's loop — and natural exit flushes the marker,
    // which process.exit() could truncate on a pipe).
    const script = `
      const { spawn } = require("node:child_process");
      const g = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 1200)"], { stdio: "inherit" });
      g.unref();
      process.stdout.write("WEDGE_MARKER\\n");
    `;
    const started = Date.now();
    const out = await runCommand({
      command: process.execPath,
      argv: ["-e", script],
      cwd: root,
      timeoutMs: 5000,
    });
    const elapsed = Date.now() - started;
    // Discriminating bound: the grace settles at ~300ms; a `close`-dependent
    // settle would wait for the grandchild (~1200ms) or the timeout (5000ms).
    assert.ok(
      elapsed < 1000,
      `must settle via the 300ms grace without \`close\`, took ${elapsed}ms`,
    );
    assert.equal(out.ok, true, "child exited 0 — verdict must be ok");
    assert.equal(out.code, "ok", "clean exit maps to code:\"ok\"");
    assert.ok(
      out.stdout.includes("WEDGE_MARKER"),
      "stdout written before exit must be drained within the grace",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RUNCOMMAND: timeout arm SIGTERMs a live child and resolves code:\"timeout\"", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-close-wedge-"));
  try {
    const started = Date.now();
    const out = await runCommand({
      command: process.execPath,
      argv: ["-e", "setTimeout(()=>{}, 60000)"],
      cwd: root,
      timeoutMs: 300,
    });
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 1000,
      `timeout must settle promptly at ~timeoutMs, took ${elapsed}ms`,
    );
    assert.equal(out.ok, false, "a timed-out command is never ok");
    assert.equal(out.code, "timeout", "the timeout arm names itself");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RUNCOMMAND: a signal-killed child reflects the signal name, not exit_null", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-close-wedge-"));
  try {
    const out = await runCommand({
      command: process.execPath,
      argv: ["-e", "process.kill(process.pid, 'SIGTERM')"],
      cwd: root,
      timeoutMs: 5000,
    });
    assert.equal(out.ok, false, "a SIGTERM'd child is never ok");
    assert.equal(
      out.code,
      "SIGTERM",
      "exit(code=null, signal=SIGTERM) must surface the signal name",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
