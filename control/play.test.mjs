// Playing a built result — the operator's own validator.
//
// Two things are pinned here. The refusals: an operator who clicks "view
// result" and gets nothing needs to know WHICH reason it was. And the wiring to
// harness/play_container.py — the candidate runs inside the grader image, so
// this module never starts it on the host. Both edges are replaced in these
// tests (no docker, no venv): what is exercised is the JS around them — the
// argv the module is asked for, the refusal mapping, the registry record, and
// the boot probe against a real local HTTP server.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { playStatus, setPlayContainer, startPlay, stopPlay } from "./play.mjs";
import { listServers, registerServer, setExecRunner } from "./servers.mjs";

const RUN = "9999000001";
const CELL = "local/prov/campaign/memoryOFF/cell-0000";
const NAME = `${RUN}::${CELL}`;
const CANDIDATE = "okp-play-0123456789ab-cand";

/** A runs root holding one cell, with a worktree that has a src/ (or has not). */
function fixture({ build = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okp-play-"));
  const cellDir = path.join(root, "runs", RUN, CELL);
  fs.mkdirSync(cellDir, { recursive: true });
  if (build) {
    const src = path.join(cellDir, "worktree", "src");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "server.ts"), "// the build under play\n");
  }
  return { root, runsRoot: path.join(root, "runs"), worktree: path.join(cellDir, "worktree") };
}

const args = (f, cell = CELL) => ({
  runsRoot: f.runsRoot,
  benchRoot: f.root,
  run: RUN,
  cell,
});

/**
 * Replace the play CLI. `handler` answers from a script; every call is recorded
 * with the argv it was asked for, which is half of what these tests assert.
 */
function cli(t, handler) {
  const calls = [];
  setPlayContainer(async (argv, benchRoot) => {
    calls.push({ argv, benchRoot });
    return handler(argv, benchRoot);
  });
  t.after(() => setPlayContainer(null));
  return calls;
}

/** The CLI must not be reached at all: these refusals are decided before it. */
function cliForbidden(t) {
  return cli(t, (argv) => {
    throw new Error(`the play CLI was asked for "${argv.join(" ")}"`);
  });
}

/**
 * A stand-in for the played build, on an ephemeral 127.0.0.1 port. Its `url` is
 * what the fake CLI hands back, so the boot probe in play.mjs is real.
 */
function app(t, { health = 200, page = 200, pageBody = "board ok", seam = 404 } = {}) {
  const srv = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(body);
    };
    if (req.url === "/health") return send(health, health === 200 ? "ok" : "sick");
    if (req.url === "/api/debug/state") return send(seam, seam === 404 ? "" : "{}");
    if (req.url === "/") return send(page, pageBody);
    return send(404, "");
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      t.after(() => new Promise((r) => srv.close(r)));
      resolve({ port, url: `http://127.0.0.1:${port}/` });
    });
  });
}

/** What `start` prints for a session that came up. */
const started = (site) => ({
  ok: true,
  name: NAME,
  candidate: CANDIDATE,
  forwarder: "okp-play-0123456789ab-fwd",
  network: "okp-play-0123456789ab-net",
  host_port: site.port,
  url: site.url,
});

test("an identifier that escapes the runs root is refused as invalid_run", async (t) => {
  const f = fixture();
  cliForbidden(t);
  for (const bad of ["../../../etc", "/etc", "..", ""]) {
    const r = await startPlay(args(f, bad));
    assert.equal(r.ok, false);
    assert.equal(r.code, "invalid_run", `${bad} must not resolve`);
  }
});

test("a cell with no worktree is refused as no_build, naming the path", async (t) => {
  const f = fixture({ build: false });
  cliForbidden(t);
  const r = await startPlay(args(f));
  assert.equal(r.code, "no_build");
  assert.equal(r.status, 404);
  assert.match(r.reason, /aborted before writing files|run tree has been reset/);
});

test("a build that boots plays, reports its published URL, and is registered", async (t) => {
  const f = fixture();
  const site = await app(t);
  const calls = cli(t, () => started(site));

  const r = await startPlay(args(f));

  assert.equal(r.ok, true, `expected a boot, got ${r.code}: ${r.reason}`);
  assert.equal(r.url, site.url);
  assert.equal(r.port, site.port);
  assert.equal(r.pid, NAME, "the board keys play on the session identity");
  assert.equal(r.run, RUN);
  assert.equal(r.cell, CELL);
  assert.equal(r.page_status, 200);
  assert.equal(r.page_excerpt, "board ok");
  assert.equal(r.debug_seam_open, false);

  // The argv is the contract with the module. No entrypoint travels from here:
  // the module resolves the start command itself.
  assert.deepEqual(calls[0].argv, [
    "start",
    "--name",
    NAME,
    "--worktree",
    f.worktree,
    "--owner",
    "control",
    "--cell",
    CELL,
  ]);
  assert.equal(calls[0].benchRoot, f.root);

  const rows = listServers(f.root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "play");
  assert.equal(rows[0].pid, NAME);
  assert.equal(rows[0].container, CANDIDATE);
  assert.equal(rows[0].port, site.port);
  assert.equal(rows[0].ready, true);
  assert.equal(rows[0].label, NAME);
  assert.ok(rows[0].started_at, "a record without a timestamp cannot be ordered");
});

test("playStatus reports what is up in the board's shape", async (t) => {
  const f = fixture();
  const site = await app(t);
  cli(t, () => started(site));
  assert.equal(await startPlay(args(f)).then((r) => r.ok), true);

  const live = playStatus(f.root);
  assert.equal(live.pid, NAME);
  assert.equal(live.port, site.port);
  assert.ok(Number.isInteger(live.port), "the board reads port as a number");
  assert.equal(live.url, `http://localhost:${site.port}/`);
  assert.equal(live.run, RUN);
  assert.equal(live.cell, CELL);
  assert.match(live.started_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test("the debug seam is probed on the shipped configuration — closed is a finding", async (t) => {
  // REQ-DEBUG: the routes must behave as unknown endpoints without DEBUG_API.
  // Grading always boots the candidate WITH the seam on, so this is the only
  // place the clause is observable at all.
  const f = fixture();
  const closed = await app(t, { seam: 404 });
  cli(t, () => started(closed));
  const r = await startPlay(args(f));
  assert.equal(r.ok, true);
  assert.equal(r.debug_seam_open, false);
  assert.equal(r.debug_seam_status, 404);
});

test("a build that leaves the debug seam open is DETECTED, not refused", async (t) => {
  const f = fixture();
  const open = await app(t, { seam: 200 });
  cli(t, () => started(open));
  const r = await startPlay(args(f));
  assert.equal(r.ok, true, "an open seam is a finding, not a reason to withhold the build");
  assert.equal(r.debug_seam_open, true);
  assert.notEqual(r.debug_seam_status, 404);
});

test("a seeded-but-unbuilt cell boots, and the page it serves is REPORTED", async (t) => {
  // The scaffold answers /health and throws at `/`. It must still play — seeing
  // a broken board is the point — but the caller has to be told what it served.
  const f = fixture();
  const broken = await app(t, { page: 500, pageBody: "not implemented" });
  cli(t, () => started(broken));
  const r = await startPlay(args(f));
  assert.equal(r.ok, true, `a scaffold cell must still boot, got ${r.code}: ${r.reason}`);
  assert.equal(r.page_status, 500);
  assert.match(r.page_excerpt, /not implemented/);
});

// ── the module's refusal codes, mapped to what the board shows ──────────────
const MAPPING = [
  ["no_entrypoint", "no_entrypoint", 422],
  ["image_missing", "image_missing", 503],
  ["docker_missing", "docker_missing", 503],
  ["start_failed", "boot_failed", 422],
  ["stop_failed", "boot_failed", 422],
  ["reap_failed", "boot_failed", 422],
  ["unexpected", "boot_failed", 422],
];

for (const [moduleCode, code, status] of MAPPING) {
  test(`the module's ${moduleCode} becomes ${code} (${status})`, async (t) => {
    const f = fixture();
    cli(t, () => ({ ok: false, code: moduleCode, reason: `the module said ${moduleCode}` }));
    const r = await startPlay(args(f));
    assert.equal(r.ok, false);
    assert.equal(r.code, code);
    assert.equal(r.status, status);
    assert.equal(r.reason, `the module said ${moduleCode}`, "the reason reaches the operator verbatim");
    assert.deepEqual(listServers(f.root), [], "a refusal records nothing");
  });
}

test("a start the module never confirms never falls back to a host process", async (t) => {
  const f = fixture();
  const calls = cli(t, () => ({ ok: false, reason: "no output" })); // unparseable/absent code
  const r = await startPlay(args(f));
  assert.equal(r.code, "boot_failed");
  assert.equal(r.status, 422);
  assert.equal(calls.length, 1, "one start, no second attempt of any kind");
  assert.equal(calls[0].argv[0], "start");
});

/** A port on 127.0.0.1 that nothing is listening on (bound, then released). */
function deadPort() {
  return new Promise((resolve) => {
    const srv = http.createServer(() => {});
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

test("a container that starts and never answers is stopped and refused as boot_failed", async (t) => {
  const f = fixture();
  // A port with nothing listening: health can never answer.
  const port = await deadPort();
  const dead = { port, url: `http://127.0.0.1:${port}/` };
  const calls = cli(t, (argv) =>
    argv[0] === "start" ? started(dead) : { ok: true, removed: [], lingering: [] },
  );

  const r = await startPlay(args(f));

  assert.equal(r.ok, false);
  assert.equal(r.code, "boot_failed");
  assert.equal(r.status, 504);
  assert.match(r.reason, /no answer at .*health after 10s/);
  assert.deepEqual(calls[1].argv, ["stop", "--name", NAME], "it must be taken down either way");
  assert.deepEqual(listServers(f.root), [], "and its record must go with it");
});

test("a session that cannot be recorded is stopped rather than left unreapable", async (t) => {
  const f = fixture();
  const site = await app(t);
  // A FILE where the registry folder belongs: the record cannot be written.
  fs.writeFileSync(path.join(f.root, "runs", "servers"), "not a directory");
  const calls = cli(t, (argv) =>
    argv[0] === "start" ? started(site) : { ok: true, removed: [], lingering: [] },
  );

  const r = await startPlay(args(f));

  assert.equal(r.code, "registry_failed");
  assert.equal(r.status, 500);
  assert.match(r.reason, /stopped rather than left running unreapable/);
  assert.deepEqual(calls[1].argv, ["stop", "--name", NAME]);
});

test("the previous session's container is retired once the new one answers", async (t) => {
  const f = fixture();
  // Another session, still recorded and (per the fake docker) still running.
  registerServer(
    { pid: "8888000002::other/cell-0001", container: "okp-play-ffffffffffff-cand", port: 8100, kind: "play", entrypoint: "okp-play-ffffffffffff-cand", ready: true },
    f.root,
  );
  const execCalls = [];
  setExecRunner(async (cmd, argv) => {
    execCalls.push({ cmd, argv });
    if (cmd === "docker") return { stdout: "true\n", stderr: "" };
    return { stdout: `${JSON.stringify({ ok: true, removed: [1, 2], lingering: [] })}\n`, stderr: "" };
  });
  t.after(() => setExecRunner(null));

  const site = await app(t);
  cli(t, () => started(site));
  const r = await startPlay(args(f));
  assert.equal(r.ok, true);

  const stops = execCalls.filter((c) => c.argv[0] === "-m");
  assert.equal(stops.length, 1, "the other session is stopped through the module");
  assert.deepEqual(stops[0].argv, [
    "-m",
    "harness.play_container",
    "stop",
    "--name",
    "8888000002::other/cell-0001",
  ]);

  const rows = listServers(f.root);
  assert.equal(rows.length, 1, "only the session that answered is left");
  assert.equal(rows[0].pid, NAME);
});

test("stopPlay reaps the containers and prunes the records", async (t) => {
  const f = fixture();
  registerServer(
    { pid: NAME, container: CANDIDATE, port: 8101, kind: "play", entrypoint: CANDIDATE, ready: true },
    f.root,
  );
  const calls = cli(t, () => ({
    ok: true,
    removed_containers: [CANDIDATE, "okp-play-0123456789ab-fwd"],
    removed_networks: ["okp-play-0123456789ab-net"],
    lingering: [],
  }));

  assert.deepEqual(await stopPlay(f.root), { ok: true, stopped: 2, pruned: 1 });
  // Only the board's own sessions: a hold review a harness still serves stays up.
  assert.deepEqual(calls[0].argv, ["reap", "--owner", "control"]);
  assert.deepEqual(listServers(f.root), []);
});

test("stopPlay on nothing is a result, not an error", async (t) => {
  const f = fixture({ build: false });
  cli(t, () => ({ ok: true, removed_containers: [], removed_networks: [], lingering: [] }));
  assert.deepEqual(await stopPlay(f.root), { ok: true, stopped: 0, pruned: 0 });
});
