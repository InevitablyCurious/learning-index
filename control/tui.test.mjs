// TuiMirror.pollFor — one bounded capture per cell address. The captures are
// real (PTY child processes) but exec /usr/bin/true, so they start and exit
// immediately without an opencode binary, a cell, or a serve port.

import test from "node:test";
import assert from "node:assert/strict";

import { TuiMirror, MAX_CAPTURES } from "./tui.mjs";

const HARMLESS_BIN = "/usr/bin/true";

function makeMirror() {
  return new TuiMirror({ bin: HARMLESS_BIN });
}

test("pollFor keys one capture per cell and echoes the cell in the payload", (t) => {
  const m = makeMirror();
  t.after(() => m.shutdown());

  const a = m.pollFor("run-a", "ses_a", "http://127.0.0.1:9001");
  const b = m.pollFor("run-b", "ses_b", "http://127.0.0.1:9002");

  assert.equal(a.cell, "run-a");
  assert.equal(b.cell, "run-b");
  assert.equal(a.session_id, "ses_a");
  assert.equal(b.session_id, "ses_b");
  assert.equal(m.captures.size, 2);
  assert.notEqual(m.captures.get("run-a"), m.captures.get("run-b"));
  // Each capture is attached to its own cell's serve URL.
  assert.equal(m.captures.get("run-a").serveUrl, "http://127.0.0.1:9001");
  assert.equal(m.captures.get("run-b").serveUrl, "http://127.0.0.1:9002");
});

test("pollFor replaces the capture when a cell's sessionId changes", (t) => {
  const m = makeMirror();
  t.after(() => m.shutdown());

  m.pollFor("run-a", "ses_old", "http://127.0.0.1:9001");
  const old = m.captures.get("run-a");
  const res = m.pollFor("run-a", "ses_new", "http://127.0.0.1:9001");

  assert.equal(m.captures.size, 1);
  assert.notEqual(m.captures.get("run-a"), old);
  assert.equal(old.detached, true, "old capture was stopped");
  assert.equal(res.session_id, "ses_new");
  assert.equal(res.cell, "run-a");
});

test("pollFor without a sessionId reports not-running with the cell", (t) => {
  const m = makeMirror();
  t.after(() => m.shutdown());

  const res = m.pollFor("run-a", null, "http://127.0.0.1:9001");
  assert.equal(res.running, false);
  assert.equal(res.cell, "run-a");
  assert.equal(res.session_id, null);
  assert.equal(m.captures.size, 0);
});

test("pollFor without a serve URL attaches nothing — there is no default port", (t) => {
  const m = makeMirror();
  t.after(() => m.shutdown());

  const res = m.pollFor("run-a", "ses_a", null);
  assert.equal(res.running, false);
  assert.match(res.reason, /not published its serve address/);
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

// ── A capture that exits on its own is retried (2026-09-23, s0001) ────────
// s0001's mirror attached before its serve port answered, exited 1, and the
// dead capture was reused for the rest of the run. These drive the backoff with
// an explicit clock; /usr/bin/true exits at once, standing in for that client.

import { TUI_RETRY_DELAYS_MS } from "./tui.mjs";

function exitedCapture(t) {
  const m = makeMirror();
  t.after(() => m.shutdown());
  m.pollFor("run-x", "ses-x", "http://127.0.0.1:1");
  const c = m.captures.get("run-x");
  c.child = null;
  c.exited = { code: 1, signal: null, at: 1_000 };
  return c;
}

test("an exited capture reads 'reconnecting' and is restarted once its backoff passes", (t) => {
  const c = exitedCapture(t);
  assert.equal(c.read().status, "reconnecting");
  assert.equal(c.retryIfDue(1_000 + TUI_RETRY_DELAYS_MS[0] - 1), false, "not before the backoff");
  assert.equal(c.retryIfDue(1_000 + TUI_RETRY_DELAYS_MS[0]), true);
  assert.equal(c.retries, 1);
  assert.equal(c.exited, null, "a fresh attach is under way");
  assert.equal(c.lastExit.code, 1, "the exit that caused it is kept");
});

test("after the last retry it stays exited and says it gave up", (t) => {
  const c = exitedCapture(t);
  c.retries = TUI_RETRY_DELAYS_MS.length;
  assert.equal(c.retryIfDue(10_000_000), false);
  const r = c.read();
  assert.equal(r.status, "exited");
  assert.match(r.reason, /gave up after 5 retries/);
});

test("a capture torn down with its cell is never restarted", (t) => {
  const c = exitedCapture(t);
  c.detached = true;
  assert.equal(c.retryIfDue(10_000_000), false);
  assert.equal(c.read().status, "detached");
});
