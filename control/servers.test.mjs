// The spawned-server registry: ownership-based cleanup.
//
// The behaviour under test is the one that replaced `freePort()`'s SIGKILL —
// the bench kills what it started and REFUSES when a stranger holds the port.
// Every assertion here is about that distinction, because getting it wrong is
// how the old code took out processes the operator cared about.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyServer,
  deregisterServer,
  listServers,
  processCommand,
  reapServers,
  registerServer,
  serversDir,
} from "./servers.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "okp-servers-"));
}

/** A real, long-lived child whose command line names a unique marker path. */
function sleeper(marker) {
  const proc = spawn("node", [marker, "--sleep"], { stdio: "ignore" });
  return proc;
}

test("registers, lists, and deregisters by pid", () => {
  const root = tmpRoot();
  registerServer({ pid: 424242, port: 9001, kind: "play", entrypoint: "/x/server.ts" }, root);
  const rows = listServers(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, 424242);
  assert.equal(rows[0].kind, "play");
  assert.equal(rows[0].port, 9001);
  assert.ok(rows[0].started_at, "a record without a timestamp cannot be ordered");

  deregisterServer(424242, root);
  assert.deepEqual(listServers(root), []);
});

test("a record with no pid or no entrypoint is refused, not stored", () => {
  const root = tmpRoot();
  assert.equal(registerServer({ port: 1 }, root), null);
  assert.equal(registerServer({ pid: 5, port: 1 }, root), null);
  assert.equal(registerServer({ pid: 0, entrypoint: "/x" }, root), null);
  assert.deepEqual(listServers(root), []);
});

test("a corrupt record is skipped, never fatal", () => {
  const root = tmpRoot();
  fs.mkdirSync(serversDir(root), { recursive: true });
  fs.writeFileSync(path.join(serversDir(root), "1.json"), "{not json");
  registerServer({ pid: 4242, port: 2, kind: "gate", entrypoint: "/y/server.ts" }, root);
  assert.equal(listServers(root).length, 1);
});

test("a dead pid classifies dead — the record is worthless, nothing is killed", async () => {
  // 424242 is far above the default pid_max on darwin/Linux for a fresh boot,
  // and re-checked here rather than assumed.
  const c = await processCommand(424242);
  if (c !== null) return; // that pid really is in use; the case is untestable here
  const got = await classifyServer({ pid: 424242, entrypoint: "/x/server.ts" });
  assert.equal(got.state, "dead");
});

test("a live pid whose command does NOT match classifies recycled, and is never killed", async () => {
  const root = tmpRoot();
  // This very test process is alive and is definitely not "/nope/server.ts".
  registerServer({ pid: process.pid, port: 1, kind: "gate", entrypoint: "/nope/server.ts" }, root);
  const rec = listServers(root)[0];
  assert.equal((await classifyServer(rec)).state, "recycled");

  const report = await reapServers({ kind: "gate" }, root);
  assert.equal(report.killed.length, 0, "a recycled pid must never be signalled");
  assert.equal(report.pruned.length, 1, "but its record is worthless and must go");
  assert.deepEqual(listServers(root), []);
  assert.ok(await processCommand(process.pid), "this process must still be alive");
});

test("a live pid whose command DOES match classifies ours, and is reaped", async () => {
  const root = tmpRoot();
  const marker = path.join(root, "marker-server.mjs");
  fs.writeFileSync(marker, "setTimeout(() => {}, 60_000);\n");
  const proc = sleeper(marker);
  await new Promise((r) => setTimeout(r, 400));

  registerServer({ pid: proc.pid, port: 1, kind: "play", entrypoint: marker }, root);
  const rec = listServers(root)[0];
  assert.equal((await classifyServer(rec)).state, "ours");

  const report = await reapServers({ kind: "play" }, root);
  assert.equal(report.killed.length, 1);
  assert.equal(await processCommand(proc.pid), null, "the reaped process must be gone");
  assert.deepEqual(listServers(root), []);
});

test("kind narrows the reap — one arm's orphans are not the other's business", async () => {
  const root = tmpRoot();
  registerServer({ pid: process.pid, port: 1, kind: "gate", entrypoint: "/nope/a.ts" }, root);
  registerServer({ pid: 424243, port: 2, kind: "play", entrypoint: "/nope/b.ts" }, root);

  const report = await reapServers({ kind: "play" }, root);
  assert.equal(report.left.length, 1);
  assert.equal(report.left[0].kind, "gate");
  assert.equal(listServers(root).length, 1, "the gate record survives a play reap");
});
