// Playing a built result — the operator's own validator.
//
// The refusals are the interesting half. An operator who clicks "view result"
// and gets nothing needs to know WHICH of the reasons it was, and a build that
// ignores the port it is handed must be stopped rather than left squatting on
// the grader's.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { freePort, playStatus, startPlay, stopPlay } from "./play.mjs";
import { listServers } from "./servers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, "..", "task", "backgammon", "golden");
const CELL = "local/prov/campaign/memoryOFF/cell-0000";

/** A runs root holding one cell whose worktree is `build`. */
function fixture(build) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okp-play-"));
  const cellDir = path.join(root, "runs", "9999000001", CELL);
  fs.mkdirSync(cellDir, { recursive: true });
  if (build) fs.cpSync(build, path.join(cellDir, "worktree"), { recursive: true });
  return { root, runsRoot: path.join(root, "runs") };
}

const args = (f, cell = CELL) => ({
  runsRoot: f.runsRoot,
  benchRoot: f.root,
  run: "9999000001",
  cell,
});

test("freePort hands back a port nothing is listening on", async () => {
  const a = await freePort();
  const b = await freePort();
  assert.ok(Number.isInteger(a) && a > 1024);
  assert.ok(Number.isInteger(b) && b > 1024);
});

test("an identifier that escapes the runs root is refused as invalid_run", async () => {
  const f = fixture(null);
  for (const bad of ["../../../etc", "/etc", "..", ""]) {
    const r = await startPlay(args(f, bad));
    assert.equal(r.ok, false);
    assert.equal(r.code, "invalid_run", `${bad} must not resolve`);
  }
});

test("a cell with no worktree is refused as no_build, naming the path", async () => {
  const f = fixture(null);
  const r = await startPlay(args(f));
  assert.equal(r.code, "no_build");
  assert.equal(r.status, 404);
  assert.match(r.reason, /aborted before writing files|run tree has been reset/);
});

test("a build that honours PORT plays, reports its URL, and is registered", async (t) => {
  const f = fixture(GOLDEN);
  const r = await startPlay(args(f));
  t.after(() => stopPlay(f.root));

  assert.equal(r.ok, true, `expected a boot, got ${r.code}: ${r.reason}`);
  assert.match(r.url, /^http:\/\/localhost:\d+\/$/);
  assert.ok(r.port > 1024);
  assert.notEqual(r.port, 8002, "play must never take the grader's default port");

  const res = await fetch(r.url);
  assert.equal(res.status, 200, "the page must actually serve");

  const rows = listServers(f.root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "play");
  assert.equal(rows[0].label, `9999000001::${CELL}`);
});

test("the played build runs WITHOUT the debug seam", async (t) => {
  const f = fixture(GOLDEN);
  const r = await startPlay(args(f));
  t.after(() => stopPlay(f.root));
  assert.equal(r.ok, true);

  // Every gate boots with DEBUG_API=1; the shipped product does not, and that
  // is the artifact a person should be playing.
  const res = await fetch(`${r.url}api/debug/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 404, "the debug routes must be closed when DEBUG_API is unset");
});

test("playStatus reflects what is up, and stopPlay takes it down", async () => {
  const f = fixture(GOLDEN);
  const r = await startPlay(args(f));
  assert.equal(r.ok, true);

  const live = playStatus(f.root);
  assert.equal(live.pid, r.pid);
  assert.equal(live.run, "9999000001");
  assert.equal(live.cell, CELL);

  const stopped = await stopPlay(f.root);
  assert.equal(stopped.stopped, 1);
  assert.equal(playStatus(f.root), null);
  await assert.rejects(() => fetch(r.url, { signal: AbortSignal.timeout(500) }));
});

test("stopPlay on nothing is a result, not an error", async () => {
  const f = fixture(null);
  assert.deepEqual(await stopPlay(f.root), { ok: true, stopped: 0, pruned: 0 });
});

test("a build that IGNORES PORT is refused as port_ignored and left running nowhere", async () => {
  const f = fixture(GOLDEN);
  // Re-hardcode the port, which is exactly what a candidate that rewrote the
  // scaffold's port line would have shipped.
  const srv = path.join(f.runsRoot, "9999000001", CELL, "worktree", "src", "server.ts");
  fs.writeFileSync(
    srv,
    fs.readFileSync(srv, "utf-8").replace(
      "const PORT = Number(process.env.PORT ?? 8002);",
      "const PORT = 8002;",
    ),
  );

  const r = await startPlay(args(f));
  assert.equal(r.ok, false);
  assert.equal(r.code, "port_ignored");
  assert.equal(r.status, 409);
  assert.match(r.reason, /has been stopped/);
  assert.deepEqual(listServers(f.root), [], "the squatter's record must be gone");
});

test("a seeded-but-unbuilt cell boots, and the page it serves is REPORTED", async (t) => {
  // The scaffold's serveStatic throws "not implemented" while /health works,
  // so this cell answers health and serves a 500. It must still play — seeing a
  // broken board is the point — but the caller has to be told what it served.
  const SCAFFOLD = path.join(HERE, "..", "task", "backgammon", "scaffold");
  const f = fixture(SCAFFOLD);
  const r = await startPlay(args(f));
  t.after(() => stopPlay(f.root));

  assert.equal(r.ok, true, `a scaffold cell must still boot, got ${r.code}: ${r.reason}`);
  assert.notEqual(r.page_status, 200, "the scaffold cannot serve its own page");
  assert.match(r.page_excerpt, /not implemented/);
});

test("a finished build reports page_status 200", async (t) => {
  const f = fixture(GOLDEN);
  const r = await startPlay(args(f));
  t.after(() => stopPlay(f.root));
  assert.equal(r.ok, true);
  assert.equal(r.page_status, 200);
});

test("the debug seam is probed on the shipped configuration — closed on the golden", async (t) => {
  // REQ-DEBUG: the debug routes must behave as unknown endpoints without
  // DEBUG_API. No gate can check it — every gate boots the candidate WITH the
  // seam on — so this is the only place the clause is observable at all.
  const f = fixture(GOLDEN);
  const r = await startPlay(args(f));
  t.after(() => stopPlay(f.root));

  assert.equal(r.ok, true);
  assert.equal(r.debug_seam_open, false, "the golden gates its debug routes");
  assert.equal(r.debug_seam_status, 404);
});

test("a build that leaves the debug seam open is DETECTED, not refused", async (t) => {
  const f = fixture(GOLDEN);
  // Strip the gate, which is exactly what a candidate that ignored REQ-DEBUG
  // would have shipped: the routes exist unconditionally.
  const srv = path.join(f.runsRoot, "9999000001", CELL, "worktree", "src", "server.ts");
  const src = fs.readFileSync(srv, "utf-8");
  assert.match(src, /const DEBUG = process\.env\.DEBUG_API === "1";/);
  fs.writeFileSync(srv, src.replace('const DEBUG = process.env.DEBUG_API === "1";', "const DEBUG = true;"));

  const r = await startPlay(args(f));
  t.after(() => stopPlay(f.root));

  assert.equal(r.ok, true, "an open seam is a finding, not a reason to withhold the build");
  assert.equal(r.debug_seam_open, true);
  assert.notEqual(r.debug_seam_status, 404);
});
