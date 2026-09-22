// TuiMirror.pollFor — one bounded capture per run identity. The captures are
// real (PTY child processes) but exec /usr/bin/true, so they start and exit
// immediately without an opencode binary, a cell, or a serve port.

import test from "node:test";
import assert from "node:assert/strict";

import { TuiMirror, MAX_CAPTURES } from "./tui.mjs";

const HARMLESS_BIN = "/usr/bin/true";

function makeMirror() {
  return new TuiMirror({ serveUrl: "http://127.0.0.1:1", bin: HARMLESS_BIN });
}

test("pollFor keys one capture per runId and echoes run_id in the payload", (t) => {
  const m = makeMirror();
  t.after(() => m.shutdown());

  const a = m.pollFor("run-a", "ses_a", "http://127.0.0.1:9001");
  const b = m.pollFor("run-b", "ses_b", "http://127.0.0.1:9002");

  assert.equal(a.run_id, "run-a");
  assert.equal(b.run_id, "run-b");
  assert.equal(a.session_id, "ses_a");
  assert.equal(b.session_id, "ses_b");
  assert.equal(m.captures.size, 2);
  assert.notEqual(m.captures.get("run-a"), m.captures.get("run-b"));
  // Each capture is attached to its own cell's serve URL.
  assert.equal(m.captures.get("run-a").serveUrl, "http://127.0.0.1:9001");
  assert.equal(m.captures.get("run-b").serveUrl, "http://127.0.0.1:9002");
});

test("pollFor replaces the capture when a runId's sessionId changes", (t) => {
  const m = makeMirror();
  t.after(() => m.shutdown());

  m.pollFor("run-a", "ses_old", "http://127.0.0.1:9001");
  const old = m.captures.get("run-a");
  const res = m.pollFor("run-a", "ses_new", "http://127.0.0.1:9001");

  assert.equal(m.captures.size, 1);
  assert.notEqual(m.captures.get("run-a"), old);
  assert.equal(old.detached, true, "old capture was stopped");
  assert.equal(res.session_id, "ses_new");
  assert.equal(res.run_id, "run-a");
});

test("pollFor without a sessionId reports not-running with the run_id", (t) => {
  const m = makeMirror();
  t.after(() => m.shutdown());

  const res = m.pollFor("run-a", null, "http://127.0.0.1:9001");
  assert.equal(res.running, false);
  assert.equal(res.run_id, "run-a");
  assert.equal(res.session_id, null);
  assert.equal(m.captures.size, 0);
});

test("captures are bounded by MAX_CAPTURES with LRU eviction", (t) => {
  const m = makeMirror();
  t.after(() => m.shutdown());

  for (let i = 0; i < MAX_CAPTURES; i++) {
    m.pollFor(`run-${i}`, `ses_${i}`, `http://127.0.0.1:${9100 + i}`);
  }
  assert.equal(m.captures.size, MAX_CAPTURES);

  // Touch run-0 so run-1 becomes the least-recently-used, then overflow by one.
  m.pollFor("run-0", "ses_0", "http://127.0.0.1:9100");
  const evicted = m.captures.get("run-1");
  m.pollFor("run-overflow", "ses_x", "http://127.0.0.1:9999");

  assert.equal(m.captures.size, MAX_CAPTURES, "map stays at the bound");
  assert.equal(m.captures.has("run-overflow"), true);
  assert.equal(m.captures.has("run-0"), true, "recently polled capture survives");
  assert.equal(m.captures.has("run-1"), false, "LRU capture was evicted");
  assert.equal(evicted.detached, true, "evicted capture was stopped");
});

test("shutdown stops every capture", (t) => {
  const m = makeMirror();
  m.pollFor("run-a", "ses_a", "http://127.0.0.1:9001");
  m.pollFor("run-b", "ses_b", "http://127.0.0.1:9002");
  const captures = [...m.captures.values()];

  m.shutdown();
  assert.equal(m.captures.size, 0);
  for (const c of captures) assert.equal(c.detached, true);
});
