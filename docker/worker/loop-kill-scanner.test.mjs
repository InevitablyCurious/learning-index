/*
 * Tests for loop-kill-scanner.cjs — run with the built-in node:test runner:
 *   cd bench/docker/worker && node --test loop-kill-scanner.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import scannerMod from "./loop-kill-scanner.cjs";

const { LOOP_KILL_SIGNATURES, createLoopKillScanner, writeLoopKillMarker, writeCompactPhaseRepair } =
  scannerMod;

function tempMarkerDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loop-kill-test-"));
}

function readMarker(dir, safeSessionId) {
  return fs.readFileSync(path.join(dir, `loop-kill-${safeSessionId}.json`), "utf8");
}

test("LOOP_KILL_SIGNATURES exports the two wire signatures", () => {
  assert.deepEqual(LOOP_KILL_SIGNATURES, ["relay_loop_detected", "generation loop detected"]);
});

test("(a) relay_loop_detected: onMatch fires and marker is written", () => {
  const dir = tempMarkerDir();
  try {
    const matches = [];
    const scanner = createLoopKillScanner({
      onMatch: (signature) => {
        matches.push(signature);
        writeLoopKillMarker({
          markerDir: dir,
          sessionId: "ses_abc123",
          signature,
          now: () => 1700000000000,
        });
      },
    });
    scanner.feed(Buffer.from('data: {"error": "relay_loop_detected"}\n\n'));
    assert.deepEqual(matches, ["relay_loop_detected"]);
    // exact content shape
    assert.equal(
      readMarker(dir, "ses_abc123"),
      '{"session_id": "ses_abc123", "timestamp": 1700000000000, "signature": "relay_loop_detected"}',
    );
    const marker = JSON.parse(readMarker(dir, "ses_abc123"));
    assert.equal(marker.session_id, "ses_abc123");
    assert.equal(typeof marker.timestamp, "number");
    assert.equal(Number.isInteger(marker.timestamp), true);
    assert.equal(marker.signature, "relay_loop_detected");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(b) generation loop detected: string chunk, filename sanitized, content raw", () => {
  const dir = tempMarkerDir();
  try {
    const matches = [];
    const scanner = createLoopKillScanner({
      onMatch: (signature) => {
        matches.push(signature);
        writeLoopKillMarker({
          markerDir: dir,
          sessionId: "ses/abc:123",
          signature,
          now: () => 1700000000001,
        });
      },
    });
    scanner.feed('data: {"error": "generation loop detected"}\n\n');
    assert.deepEqual(matches, ["generation loop detected"]);
    const marker = JSON.parse(readMarker(dir, "ses_abc_123"));
    assert.equal(marker.session_id, "ses/abc:123");
    assert.equal(marker.timestamp, 1700000000001);
    assert.equal(marker.signature, "generation loop detected");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(c) no signature: no onMatch, no marker file", () => {
  const dir = tempMarkerDir();
  try {
    const matches = [];
    const scanner = createLoopKillScanner({
      onMatch: (signature) => {
        matches.push(signature);
        writeLoopKillMarker({ markerDir: dir, sessionId: "ses_x", signature, now: () => 1 });
      },
    });
    scanner.feed("data: normal streamed tokens\n\n");
    scanner.feed(Buffer.from('data: {"content":"hello world"}\n'));
    scanner.feed("");
    assert.deepEqual(matches, []);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(d) signature split across chunk boundary is detected", () => {
  const dir = tempMarkerDir();
  try {
    const matches = [];
    const scanner = createLoopKillScanner({
      onMatch: (signature) => {
        matches.push(signature);
        writeLoopKillMarker({
          markerDir: dir,
          sessionId: "ses_split",
          signature,
          now: () => 1700000000002,
        });
      },
    });
    scanner.feed('data: {"error":"generation lo');
    assert.deepEqual(matches, []); // prefix alone must not fire
    scanner.feed('op detected at step 12"}\n');
    assert.deepEqual(matches, ["generation loop detected"]);
    assert.equal(JSON.parse(readMarker(dir, "ses_split")).signature, "generation loop detected");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(e) onMatch fires exactly once despite repeated signatures", () => {
  const matches = [];
  const scanner = createLoopKillScanner({ onMatch: (signature) => matches.push(signature) });
  scanner.feed("relay_loop_detected relay_loop_detected");
  scanner.feed("relay_loop_detected");
  scanner.feed("generation loop detected");
  assert.deepEqual(matches, ["relay_loop_detected"]);
});

test("(f) signature buried mid-chunk beyond the tail cap is detected", () => {
  const matches = [];
  const scanner = createLoopKillScanner({ onMatch: (signature) => matches.push(signature) });
  scanner.feed("x".repeat(4096) + "generation loop detected" + "y".repeat(4096));
  assert.deepEqual(matches, ["generation loop detected"]);
});

test("(g) writeLoopKillMarker: null sessionId -> unknown, overwrite, falsy markerDir no-op", () => {
  const dir = tempMarkerDir();
  try {
    writeLoopKillMarker({
      markerDir: dir,
      sessionId: null,
      signature: "relay_loop_detected",
      now: () => 1700000000003,
    });
    const marker = JSON.parse(readMarker(dir, "unknown"));
    assert.equal(marker.session_id, null);
    assert.equal(marker.timestamp, 1700000000003);
    assert.equal(marker.signature, "relay_loop_detected");

    // overwrite: same file replaced, still exactly one marker
    writeLoopKillMarker({
      markerDir: dir,
      sessionId: null,
      signature: "generation loop detected",
      now: () => 1700000000004,
    });
    assert.equal(JSON.parse(readMarker(dir, "unknown")).signature, "generation loop detected");
    assert.deepEqual(fs.readdirSync(dir), ["loop-kill-unknown.json"]);

    // falsy markerDir disables the writer: no throw, nothing written
    writeLoopKillMarker({ markerDir: "", sessionId: "ses_x", signature: "relay_loop_detected", now: () => 1 });
    writeLoopKillMarker({ markerDir: undefined, sessionId: "ses_x", signature: "relay_loop_detected", now: () => 1 });
    assert.deepEqual(fs.readdirSync(dir), ["loop-kill-unknown.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(h) writeCompactPhaseRepair writes exactly 'repair\\n' to the phase file", () => {
  const dir = tempMarkerDir();
  try {
    const phaseFile = path.join(dir, "phase");
    writeCompactPhaseRepair({ phaseFile });
    assert.equal(fs.readFileSync(phaseFile, "utf8"), "repair\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(i) writeCompactPhaseRepair is atomic: no .sidecar.tmp remains", () => {
  const dir = tempMarkerDir();
  try {
    const phaseFile = path.join(dir, "phase");
    writeCompactPhaseRepair({ phaseFile });
    // write-then-rename: the sidecar-distinct tmp path must be gone after the
    // write, and the dir must hold ONLY the sentinel (no torn tmp visible to
    // the compaction arm's reader).
    assert.equal(fs.existsSync(`${phaseFile}.sidecar.tmp`), false);
    assert.deepEqual(fs.readdirSync(dir), ["phase"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(j) writeCompactPhaseRepair is idempotent: repeated calls leave 'repair\\n'", () => {
  const dir = tempMarkerDir();
  try {
    const phaseFile = path.join(dir, "phase");
    writeCompactPhaseRepair({ phaseFile });
    writeCompactPhaseRepair({ phaseFile });
    writeCompactPhaseRepair({ phaseFile });
    assert.equal(fs.readFileSync(phaseFile, "utf8"), "repair\n");
    assert.deepEqual(fs.readdirSync(dir), ["phase"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(k) writeCompactPhaseRepair is a no-op when phaseFile is falsy", () => {
  const dir = tempMarkerDir();
  try {
    writeCompactPhaseRepair({ phaseFile: undefined });
    writeCompactPhaseRepair({ phaseFile: "" });
    writeCompactPhaseRepair({ phaseFile: null });
    writeCompactPhaseRepair({});
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
