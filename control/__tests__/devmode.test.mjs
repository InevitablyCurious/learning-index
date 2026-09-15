// ─────────────────────────────────────────────────────────────────────────────
// DEVMODE TESTS — split VERBATIM from control/control.test.mjs
// (lines 5067–5223).
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDevMode, readDevMode, writeDevMode } from "../devmode.mjs";

test("DEVMODE: env truthy resolves ON and pins the toggle", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  const r = await resolveDevMode({ benchRoot: root, env: { BENCH_DEV_MODE: "on" } });
  assert.equal(r.enabled, true);
  assert.equal(r.source, "environment");
  // PINNED: the toggle must refuse rather than write a file the next read ignores.
  assert.equal(r.settable, false);
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: env falsy resolves OFF and pins the toggle", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  const r = await resolveDevMode({ benchRoot: root, env: { BENCH_DEV_MODE: "off" } });
  assert.equal(r.enabled, false);
  assert.equal(r.source, "environment");
  assert.equal(r.settable, false);
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: an exported value wins over the state file", async () => {
  // CI and scripted runs pin the mode without writing to disk; a file saying
  // otherwise must not change the answer.
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "devmode.json"), JSON.stringify({ enabled: false }));

  const r = await resolveDevMode({ benchRoot: root, env: { BENCH_DEV_MODE: "on" } });
  assert.equal(r.enabled, true);
  assert.equal(r.source, "environment");
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: no env reads the state file and stays toggleable", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "devmode.json"), JSON.stringify({ enabled: true }));

  const r = await resolveDevMode({ benchRoot: root, env: {} });
  assert.equal(r.enabled, true);
  assert.equal(r.source, "state_file");
  assert.equal(r.settable, true);
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: a fresh clone is OFF by default and toggleable", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  const r = await resolveDevMode({ benchRoot: root, env: {} });
  assert.equal(r.enabled, false);
  assert.equal(r.source, "default");
  assert.equal(r.settable, true);
  // NOT a reason — nothing is wrong, so the board renders no warning.
  assert.equal(r.reason, null);
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: a malformed env value reads OFF and says misconfiguration", async () => {
  // Absence and misconfiguration are different facts. A silently-ignored
  // setting is how an operator concludes the feature is broken.
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  const r = await resolveDevMode({ benchRoot: root, env: { BENCH_DEV_MODE: "banana" } });
  assert.equal(r.enabled, false);
  assert.equal(r.source, "environment_malformed");
  assert.equal(r.settable, false);
  assert.match(r.reason, /misconfiguration/);
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: a malformed state file reads OFF but stays settable", async () => {
  // STILL SETTABLE: writing repairs it. A refusal would leave the operator
  // with a broken file and no board-side way to fix it.
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "devmode.json"), "enabled: true\n");

  const r = await resolveDevMode({ benchRoot: root, env: {} });
  assert.equal(r.enabled, false);
  assert.equal(r.source, "state_file_malformed");
  assert.equal(r.settable, true);
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: a state file with no boolean enabled reads OFF but stays settable", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "devmode.json"), JSON.stringify({ mode: "dev" }));

  const r = await resolveDevMode({ benchRoot: root, env: {} });
  assert.equal(r.enabled, false);
  assert.equal(r.source, "state_file_malformed");
  assert.equal(r.settable, true);
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: an env-pinned mode REFUSES the write and writes nothing", async () => {
  // The POST must not succeed-and-be-ignored: the refusal is the point.
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  const w = await writeDevMode({ benchRoot: root, enabled: false, env: { BENCH_DEV_MODE: "on" } });
  assert.equal(w.ok, false);
  assert.equal(w.code, "pinned_by_environment");
  assert.equal(existsSync(join(root, "config", "devmode.json")), false, "a refused write must not touch the state file");
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: writeDevMode round-trips through the state file", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  const on = await writeDevMode({ benchRoot: root, enabled: true, env: {} });
  assert.equal(on.ok, true);
  // The RE-RESOLVED state, never what the writer hoped it wrote.
  assert.equal(on.dev_mode.enabled, true);
  assert.equal(on.dev_mode.source, "state_file");

  const read1 = await readDevMode({ benchRoot: root, env: {} });
  assert.equal(read1.dev_mode.enabled, true);

  const off = await writeDevMode({ benchRoot: root, enabled: false, env: {} });
  assert.equal(off.ok, true);
  const read2 = await readDevMode({ benchRoot: root, env: {} });
  assert.equal(read2.dev_mode.enabled, false);
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: a non-boolean write is refused by name", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  const w = await writeDevMode({ benchRoot: root, enabled: "yes", env: {} });
  assert.equal(w.ok, false);
  assert.equal(w.code, "enabled_not_boolean");
  rmSync(root, { recursive: true, force: true });
});

test("DEVMODE: the toggled state survives a restart", async () => {
  // Persistence, not process memory: a FRESH resolve (a restarted control
  // plane) must read the file the previous process wrote.
  const root = mkdtempSync(join(tmpdir(), "okp-devmode-"));
  const w = await writeDevMode({ benchRoot: root, enabled: true, env: {} });
  assert.equal(w.ok, true);

  const restarted = await resolveDevMode({ benchRoot: root, env: {} });
  assert.equal(restarted.enabled, true);
  assert.equal(restarted.source, "state_file");
  rmSync(root, { recursive: true, force: true });
});

// ── RUNDIR: a log line carrying two /runs/ paths ────────────────────────────
//
// MEASURED DEFECT, 2026-09-05. `runDirOf`'s anchored branch was
// `/\/runs\/(.+?)\/(?:…|memoryOFF|…)\//` and `.` matches a space. A run
// directory is a path and can never contain one, so the character class was
// always wrong — it just had nothing to bite on until a single log line carried
// TWO `/runs/` paths.
//
// Seeding produced the first one. Starting at the FIRST `/runs/`, the lazy
// `.+?` grew across the space and the `dst=` to reach `/memoryOFF/`, capturing
// `snapshots/<id>/tree dst=/Users/…/<model>`. No such directory exists, so
// `newestLog` rejected the only candidate and returned null, and `readRunState`
// reported `state:"idle"` while the harness was alive and grading — which the
// board drew as "SOMETHING FAILED · the process probe no longer sees the
// harness" over a healthy cell.
