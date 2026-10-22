// ─────────────────────────────────────────────────────────────────────────────
// BROWSER GUARD TESTS — control/lib/browser-guard.mjs: a web page open on this
// machine must not be able to drive the control plane, either by a blind
// cross-site write or by rebinding its own domain to 127.0.0.1. The relay,
// continuous mode and the tools must pass untouched.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import { isLoopbackHost, refuseBrowser } from "../lib/browser-guard.mjs";

const req = (method, headers) => ({ method, headers });

test("GUARD: the relay's forward (no Origin, host.docker.internal) passes", () => {
  assert.equal(refuseBrowser(req("POST", { host: "host.docker.internal:8718" })), null);
});

test("GUARD: continuous mode and the tools (no Origin, 127.0.0.1) pass, reads and writes", () => {
  assert.equal(refuseBrowser(req("POST", { host: "127.0.0.1:8718" })), null);
  assert.equal(refuseBrowser(req("GET", { host: "localhost:8718" })), null);
});

test("GUARD: a blind cross-site write is refused, naming the Origin", () => {
  const r = refuseBrowser(req("POST", { host: "127.0.0.1:8718", origin: "https://evil.example" }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "cross_origin_denied");
  assert.match(r.reason, /evil\.example/);
});

test('GUARD: a sandboxed page\'s "null" Origin cannot write either', () => {
  assert.equal(refuseBrowser(req("POST", { host: "127.0.0.1:8718", origin: "null" })).code, "cross_origin_denied");
});

test("GUARD: a rebound domain is refused on reads too, since it can read the reply", () => {
  const r = refuseBrowser(req("GET", { host: "evil.example:8718" }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "untrusted_host");
  assert.match(r.reason, /evil\.example/);
});

test("GUARD: isLoopbackHost takes IP literals and the two loopback names, nothing else", () => {
  assert.equal(isLoopbackHost("127.0.0.1:8718"), true);
  assert.equal(isLoopbackHost("[::1]:8718"), true);
  assert.equal(isLoopbackHost("LOCALHOST:8718"), true);
  assert.equal(isLoopbackHost("localhost.evil.example:8718"), false);
  assert.equal(isLoopbackHost(undefined), false);
  assert.equal(isLoopbackHost("bad host"), false);
});
