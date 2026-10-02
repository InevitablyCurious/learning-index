// ─────────────────────────────────────────────────────────────────────────────
// GET /api/screenshot — serves the grader's per-attempt board capture
// (<cellDir>/attempt-<N>-board.png) as image/png. The cell directory is
// resolved server-side; the only wire inputs are run_dir (containment-gated),
// sequence_index and attempt (1..10).
//
// The fixture is a run under RUNS_ROOT with attempt-1 and attempt-3 captures
// present and attempt-2 ABSENT: the route must stream the present one
// byte-verbatim and 404 the absent one with a stated reason — never fall back
// to another attempt. Bad/escaping parameters refuse with { ok:false, reason }.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

// state.mjs reads the bench root and port once at import: point them at a
// temp dir and an unused port FIRST, so nothing here touches the real runs
// root. (node --test runs each file in its own process: this never leaks.)
process.env.OKP_CONTROL_BENCH_ROOT = mkdtempSync(join(tmpdir(), "screenshot-bench-"));
process.env.OKP_CONTROL_PORT = "8998";
const { routes } = await import("./screenshot.mjs");
const { RUNS_ROOT } = await import("../state.mjs");

const RUN_DIR = "1790000003/local/local-llm-proxy/omlx/model-x";
const CELL_DIR = join(RUNS_ROOT, RUN_DIR, "memoryOFF", "cell-0000");
// A minimal PNG-shaped fixture: the route serves bytes, it does not decode.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

mkdirSync(CELL_DIR, { recursive: true });
writeFileSync(join(CELL_DIR, "attempt-1-board.png"), PNG);
writeFileSync(join(CELL_DIR, "attempt-3-board.png"), PNG);
// attempt-2 deliberately absent.

function screenshotRoute() {
  const r = routes.find((r) => r.method === "GET" && r.path === "/api/screenshot");
  assert.ok(r, "GET /api/screenshot route exists");
  return r;
}

/** JSON fake for the 400/404 paths (sendJson: writeHead + end). */
function fakeJsonRes() {
  return {
    status: null,
    body: null,
    writeHead(code) { this.status = code; },
    end(text) { this.body = JSON.parse(text); },
  };
}

/** Streaming fake for the 200 path (writeHead + pipe). */
function fakeStreamRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, enc, cb) { chunks.push(chunk); cb(); },
  });
  res.writeHead = (code, headers) => { res.status = code; res.headers = headers; };
  res.bytes = () => Buffer.concat(chunks);
  return res;
}

async function callJson(query) {
  const res = fakeJsonRes();
  await screenshotRoute().handle({}, res, new URL(`http://x/api/screenshot${query}`));
  return res;
}

const good = `run_dir=${encodeURIComponent(RUN_DIR)}&sequence_index=0`;
const rd = `run_dir=${encodeURIComponent(RUN_DIR)}`;

test("GET /api/screenshot streams the stored capture as image/png, byte-verbatim", async () => {
  const res = fakeStreamRes();
  await screenshotRoute().handle({}, res, new URL(`http://x/api/screenshot?${good}&attempt=1`));
  await new Promise((r) => res.on("finish", r));
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "image/png");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual(res.bytes(), PNG);
});

test("GET /api/screenshot on an absent capture → 404 with a stated reason, never a fallback", async () => {
  const res = await callJson(`?${good}&attempt=2`);
  assert.equal(res.status, 404);
  assert.equal(res.body.ok, false);
  assert.equal(typeof res.body.reason, "string");
  assert.match(res.body.reason, /no screenshot for attempt 2/);
});

test("GET /api/screenshot refuses missing, malformed and escaping parameters", async () => {
  const bad = [
    "", // no parameters at all
    `?run_dir=${encodeURIComponent(RUN_DIR)}&attempt=1`, // no sequence_index
    `?${good}`, // no attempt
    `?${rd}&sequence_index=abc&attempt=1`,
    `?${rd}&sequence_index=-1&attempt=1`,
    `?${good}&attempt=0`, // below the 1..10 window
    `?${good}&attempt=11`, // above the hard ceiling
    `?${good}&attempt=abc`,
    `?run_dir=${encodeURIComponent("../../..")}&sequence_index=0&attempt=1`, // escape
    `?run_dir=${encodeURIComponent("/etc")}&sequence_index=0&attempt=1`, // absolute
  ];
  for (const q of bad) {
    const res = await callJson(q);
    assert.equal(res.status, 400, q);
    assert.equal(res.body.ok, false, q);
    assert.equal(typeof res.body.reason, "string", q);
  }
});
