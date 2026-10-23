// The started-server registry: ownership-based cleanup.
//
// The behaviour under test is the one that replaced `freePort()`'s SIGKILL —
// the bench stops what it started and REFUSES to touch a stranger. Every
// assertion here is about that distinction, because getting it wrong is how the
// old code took out processes the operator cared about.
//
// Ownership is asked per kind, so both shapes are covered: a host process (the
// process table says whether it is ours) and a play server (a container in the
// grader image, where docker says so and the module — never a signal — stops it).

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
  setExecRunner,
} from "./servers.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "okp-servers-"));
}

/** A real, long-lived child whose command line names a unique marker path. */
function sleeper(marker) {
  const proc = spawn("node", [marker, "--sleep"], { stdio: "ignore" });
  return proc;
}

/**
 * Answer for docker and the play CLI, neither of which is installed in a unit
 * test. Every call is recorded: which one was made is part of the assertion.
 */
function fakeExec(t, handler) {
  const calls = [];
  setExecRunner(async (cmd, argv) => {
    calls.push({ cmd, argv });
    return handler(cmd, argv);
  });
  t.after(() => setExecRunner(null));
  return calls;
}

test("registers, lists, and deregisters by pid", () => {
  const root = tmpRoot();
  registerServer({ pid: 424242, port: 9001, kind: "gate", entrypoint: "/x/server.ts" }, root);
  const rows = listServers(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, 424242);
  assert.equal(rows[0].kind, "gate");
  assert.equal(rows[0].port, 9001);
  assert.equal(rows[0].container, null, "a host process has no container");
  assert.ok(rows[0].started_at, "a record without a timestamp cannot be ordered");

  deregisterServer(424242, root);
  assert.deepEqual(listServers(root), []);
});

test("a play record is keyed by its session identity, and carries its container", () => {
  const root = tmpRoot();
  // The cell segment carries slashes, which is why the pid is not a host pid.
  const name = "9999000001::local/prov/campaign/memoryOFF/cell-0000";
  const path_ = registerServer(
    {
      pid: name,
      container: "okp-play-0123456789ab-cand",
      port: 8003,
      kind: "play",
      label: name,
      entrypoint: "okp-play-0123456789ab-cand",
    },
    root,
  );
  assert.ok(path_, "a play server must be recordable");

  const rows = listServers(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pid, name, "the identity is stored verbatim");
  assert.equal(rows[0].container, "okp-play-0123456789ab-cand");
  assert.equal(rows[0].port, 8003);

  // One file per server: the identity's slashes must not become directories.
  const files = fs.readdirSync(serversDir(root));
  assert.deepEqual(files.length, 1);
  assert.ok(!files[0].includes("/"), `the record name must be one path component: ${files[0]}`);

  deregisterServer(name, root);
  assert.deepEqual(listServers(root), []);
});

test("a record with no pid, no identity, or no entrypoint is refused, not stored", () => {
  const root = tmpRoot();
  assert.equal(registerServer({ port: 1 }, root), null);
  assert.equal(registerServer({ pid: 5, port: 1 }, root), null);
  assert.equal(registerServer({ pid: 0, entrypoint: "/x" }, root), null);
  // A play server has no host pid: a number is not its identity, and a blank
  // string is not either.
  assert.equal(
    registerServer({ pid: 424242, kind: "play", entrypoint: "/x", container: "c" }, root),
    null,
  );
  assert.equal(
    registerServer({ pid: "  ", kind: "play", entrypoint: "/x", container: "c" }, root),
    null,
  );
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

  registerServer({ pid: proc.pid, port: 1, kind: "gate", entrypoint: marker }, root);
  const rec = listServers(root)[0];
  assert.equal((await classifyServer(rec)).state, "ours");

  const report = await reapServers({ kind: "gate" }, root);
  assert.equal(report.killed.length, 1);
  assert.equal(await processCommand(proc.pid), null, "the reaped process must be gone");
  assert.deepEqual(listServers(root), []);
});

test("a play record's ownership is decided by docker, not by a host pid", async (t) => {
  const running = fakeExec(t, () => ({ stdout: "true\n", stderr: "" }));
  const rec = { pid: "1::c", kind: "play", container: "okp-play-abc-cand", entrypoint: "okp-play-abc-cand" };
  assert.deepEqual(await classifyServer(rec), { state: "ours", command: "okp-play-abc-cand" });
  assert.deepEqual(running[0], {
    cmd: "docker",
    argv: ["inspect", "-f", "{{.State.Running}}", "okp-play-abc-cand"],
  });
});

test("a play container that is not running classifies dead, so its record is pruned", async (t) => {
  fakeExec(t, () => ({ stdout: "false\n", stderr: "" }));
  const rec = { pid: "1::c", kind: "play", container: "okp-play-abc-cand", entrypoint: "okp-play-abc-cand" };
  assert.deepEqual(await classifyServer(rec), { state: "dead", command: null });
});

test("docker it cannot ask classifies dead — an unanswerable question is not ownership", async (t) => {
  fakeExec(t, () => {
    throw new Error("docker: command not found");
  });
  const rec = { pid: "1::c", kind: "play", container: "okp-play-abc-cand", entrypoint: "okp-play-abc-cand" };
  assert.equal((await classifyServer(rec)).state, "dead");
});

test("an ours play record is stopped THROUGH THE MODULE, never signalled", async (t) => {
  const root = tmpRoot();
  // The record's identity is this test process, so a signal would kill the run.
  const rec = {
    pid: String(process.pid),
    kind: "play",
    container: "okp-play-abc-cand",
    entrypoint: "okp-play-abc-cand",
  };
  registerServer(rec, root);
  const calls = fakeExec(t, (cmd) => {
    if (cmd === "docker") return { stdout: "true\n", stderr: "" };
    return { stdout: '{"ok":true,"removed":["okp-play-abc-cand"],"lingering":[]}\n', stderr: "" };
  });

  const report = await reapServers({ kind: "play" }, root);

  assert.equal(report.killed.length, 1);
  assert.deepEqual(listServers(root), []);
  const stop = calls.find((c) => c.argv[0] === "-m");
  assert.ok(stop, "the play stop must go through harness.play_container");
  assert.deepEqual(stop.argv, ["-m", "harness.play_container", "stop", "--name", String(process.pid)]);
  assert.ok(await processCommand(process.pid), "this process must still be alive: nothing was signalled");
});

test("a play stop that does not confirm keeps the record — it is the only handle", async (t) => {
  const root = tmpRoot();
  registerServer(
    { pid: "1::c", kind: "play", container: "okp-play-abc-cand", entrypoint: "okp-play-abc-cand" },
    root,
  );
  fakeExec(t, (cmd) => {
    if (cmd === "docker") return { stdout: "true\n", stderr: "" };
    throw new Error("the module is unreachable");
  });

  const report = await reapServers({ kind: "play" }, root);

  assert.equal(report.killed.length, 0);
  assert.equal(report.left.length, 1);
  assert.equal(listServers(root).length, 1, "an unconfirmed stop must not deregister");
});

test("kind narrows the reap — one arm's orphans are not the other's business", async (t) => {
  const root = tmpRoot();
  registerServer({ pid: process.pid, port: 1, kind: "gate", entrypoint: "/nope/a.ts" }, root);
  registerServer(
    { pid: "1::c", port: 2, kind: "play", container: "okp-play-abc-cand", entrypoint: "okp-play-abc-cand" },
    root,
  );
  // The play record is not running, so it prunes; the gate record is never asked.
  fakeExec(t, () => ({ stdout: "false\n", stderr: "" }));

  const report = await reapServers({ kind: "play" }, root);
  assert.equal(report.left.length, 1);
  assert.equal(report.left[0].kind, "gate");
  assert.equal(listServers(root).length, 1, "the gate record survives a play reap");
  assert.ok(await processCommand(process.pid));
});
