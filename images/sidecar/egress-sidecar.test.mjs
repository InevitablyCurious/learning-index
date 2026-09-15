/*
 * egress-sidecar — port routing and the loop-kill SCAN GATE.
 *
 * The gate is the fix for run 1788883142: the scanner used to run on every
 * port, including the WO-25 ingress forward that carries the harness's own
 * opencode-serve reads. Once a loop kill is recorded in a session, opencode
 * replays that error out of its persisted message list on every poll, so the
 * sidecar forged a fresh marker each time and killed 62 healthy turns.
 *
 * These tests boot the real `listen`/`forward` against a stub upstream on
 * ephemeral ports and assert which ports write markers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.OKP_LOOP_KILL_MARKER_DIR ||= fs.mkdtempSync(
  path.join(os.tmpdir(), "okp-sidecar-markers-"),
);
const MARKER_DIR = process.env.OKP_LOOP_KILL_MARKER_DIR;

// The sidecar reads BENCH_COMPACT_PHASE_FILE once at module load, so the
// sentinel path must be in the env BEFORE the require below — same posture
// as MARKER_DIR. Unset outside this file: the writer no-ops.
const PHASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "okp-sidecar-phase-"));
process.env.BENCH_COMPACT_PHASE_FILE ||= path.join(PHASE_DIR, "phase");
const COMPACT_PHASE_FILE = process.env.BENCH_COMPACT_PHASE_FILE;

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const { UPSTREAMS, listen } = require("./egress-sidecar.js");

// A stub upstream that answers every request with a body carrying the
// loop-kill signature — exactly what opencode's message list replays.
function stubUpstream(body) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function get(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/session/ses_1/message", headers },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve(out));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const SIGNATURE_BODY = JSON.stringify({
  parts: [{ error: { type: "relay_loop_detected" } }],
});

async function markersAfterRequest({ scan, sessionId }) {
  for (const f of fs.readdirSync(MARKER_DIR)) fs.rmSync(path.join(MARKER_DIR, f));
  const upstream = await stubUpstream(SIGNATURE_BODY);
  const upPort = upstream.address().port;
  const proxy = await listen(0, {
    proto: "http",
    host: "127.0.0.1",
    port: upPort,
    ...(scan ? { scan: true } : {}),
  });
  try {
    const body = await get(
      proxy.address().port,
      sessionId ? { "x-session-id": sessionId } : {},
    );
    assert.equal(body, SIGNATURE_BODY, "the pipe must stay byte-transparent");
    // The marker write happens on the "data" event, which has already fired by
    // the time the response ends; one macrotask makes the fs write observable.
    await new Promise((r) => setImmediate(r));
    return fs.readdirSync(MARKER_DIR);
  } finally {
    proxy.close();
    upstream.close();
  }
}

test("(a) a scan:true port writes a session-keyed marker on the signature", async () => {
  const markers = await markersAfterRequest({ scan: true, sessionId: "ses_1" });
  assert.deepEqual(markers, ["loop-kill-ses_1.json"]);
  const payload = JSON.parse(
    fs.readFileSync(path.join(MARKER_DIR, "loop-kill-ses_1.json"), "utf8"),
  );
  assert.equal(payload.session_id, "ses_1");
  assert.equal(payload.signature, "relay_loop_detected");
});

test("(b) a port WITHOUT scan writes no marker, signature or not", async () => {
  // The regression: this is the ingress forward replaying a recorded loop kill.
  const markers = await markersAfterRequest({ scan: false, sessionId: null });
  assert.deepEqual(markers, [], "a non-model port must never forge a marker");
});

test("(c) a scanned port with no session header still cannot forge 'unknown'", async () => {
  // The sidecar may still write loop-kill-unknown.json here, but the harness
  // never honours it (see read_loop_kill_marker). What matters is that it is
  // never mistaken for a real session's marker.
  const markers = await markersAfterRequest({ scan: true, sessionId: null });
  assert.deepEqual(markers, ["loop-kill-unknown.json"]);
});

test("(d) only the model-wire ports carry scan in the shipped UPSTREAMS map", () => {
  const scanned = Object.entries(UPSTREAMS)
    .filter(([, up]) => up.scan)
    .map(([port]) => Number(port))
    .sort((a, b) => a - b);
  // 4545 = local model relay, 8443 = cloud model API. 4550 (MCP), 4440 (hub)
  // and 4096 (ingress forward) carry our own traffic and must stay unscanned.
  assert.deepEqual(scanned, [4545, 8443]);
});

test("(e) the ingress forward is registered without scan", async () => {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(
    process.execPath,
    [
      "-e",
      'const m=require("./egress-sidecar.js");' +
        'console.log(JSON.stringify(m.UPSTREAMS[4096]||null));',
    ],
    {
      cwd: path.dirname(new URL(import.meta.url).pathname),
      env: { ...process.env, OKP_INGRESS_CELL_HOST: "okp-cell-x" },
    },
  ).toString();
  const ingress = JSON.parse(out);
  assert.equal(ingress.host, "okp-cell-x");
  assert.equal(ingress.scan, undefined, "the ingress forward must not be scanned");
});

test("(f) a scan:true port writes the repair sentinel before the response completes", async () => {
  fs.rmSync(COMPACT_PHASE_FILE, { force: true }); // prove THIS request writes it
  const upstream = await stubUpstream(SIGNATURE_BODY);
  const upPort = upstream.address().port;
  const proxy = await listen(0, {
    proto: "http",
    host: "127.0.0.1",
    port: upPort,
    scan: true, // model-wire port: the only place the sentinel writer runs
  });
  try {
    const body = await get(proxy.address().port, { "x-session-id": "ses_phase" });
    assert.equal(body, SIGNATURE_BODY, "the pipe must stay byte-transparent");
    // No setImmediate here: onMatch runs synchronously inside the proxyRes
    // "data" listener registered BEFORE pipe(), so the sentinel must already
    // read repair by the time the client's response completes — the write
    // lands before the session can idle, not after.
    assert.equal(fs.readFileSync(COMPACT_PHASE_FILE, "utf8"), "repair\n");
  } finally {
    proxy.close();
    upstream.close();
    fs.rmSync(COMPACT_PHASE_FILE, { force: true });
  }
});
