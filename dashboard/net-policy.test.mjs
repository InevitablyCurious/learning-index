// The LAN trust + origin contract (lib/net-policy.mjs).
//
// Once the dashboard can bind to a LAN interface, these functions are the
// ONLY thing standing between "reachable from the house" and "writable by
// anything that can route to it". The cases below pin both directions of the
// classifier — every RFC boundary that matters (172.16/12's edges, the
// IPv4-mapped forms, the ULA range) and the fail-closed rule that garbage,
// public and unspecified addresses are all refused. The origin cases pin the
// CSRF half: no browser, no Origin, allowed; a sandboxed "null" origin or a
// foreign page, refused.

import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyAddress,
  guardPeer,
  isSameOrigin,
  isTrustedPeer,
} from "./lib/net-policy.mjs";

// ── classifyAddress: IPv4 ───────────────────────────────────────────────────

test("classifyAddress: IPv4 loopback is the whole 127.0.0.0/8, not just .0.0.1", () => {
  assert.equal(classifyAddress("127.0.0.1"), "loopback");
  assert.equal(classifyAddress("127.8.8.8"), "loopback");
});

test("classifyAddress: RFC 1918 ranges are private, including 172.16/12 edges", () => {
  assert.equal(classifyAddress("10.0.0.1"), "private");
  assert.equal(classifyAddress("172.16.0.1"), "private");
  assert.equal(classifyAddress("172.31.255.255"), "private");
  assert.equal(classifyAddress("192.168.1.5"), "private");
});

test("classifyAddress: 172.32.0.1 is just outside 172.16/12 → public", () => {
  assert.equal(classifyAddress("172.32.0.1"), "public");
});

test("classifyAddress: link-local, internet, and the bind wildcard", () => {
  assert.equal(classifyAddress("169.254.1.1"), "link-local");
  assert.equal(classifyAddress("8.8.8.8"), "public");
  assert.equal(classifyAddress("0.0.0.0"), "unspecified");
});

// ── classifyAddress: IPv6 ───────────────────────────────────────────────────

test("classifyAddress: IPv6 loopback and unspecified", () => {
  assert.equal(classifyAddress("::1"), "loopback");
  assert.equal(classifyAddress("::"), "unspecified");
});

test("classifyAddress: fe80::/10 link-local, fc00::/7 ULA private, doc prefix public", () => {
  assert.equal(classifyAddress("fe80::1"), "link-local");
  assert.equal(classifyAddress("fc00::1"), "private");
  assert.equal(classifyAddress("fd12::1"), "private");
  assert.equal(classifyAddress("2001:db8::1"), "public");
});

test("classifyAddress: IPv4-mapped IPv6 classifies the embedded v4", () => {
  assert.equal(classifyAddress("::ffff:192.168.1.5"), "private");
  assert.equal(classifyAddress("::ffff:8.8.8.8"), "public");
  // The SIIT "::ffff:0:" spelling is the same peer, rendered longer.
  assert.equal(classifyAddress("::ffff:0:192.168.1.5"), "private");
});

// ── classifyAddress: fail-closed on anything else ───────────────────────────

test("classifyAddress: garbage and non-strings are unparseable, never trusted classes", () => {
  assert.equal(classifyAddress("garbage"), "unparseable");
  assert.equal(classifyAddress(undefined), "unparseable");
});

// ── isTrustedPeer ───────────────────────────────────────────────────────────

test("isTrustedPeer: local-wire classes are trusted", () => {
  assert.equal(isTrustedPeer("127.0.0.1"), true);
  assert.equal(isTrustedPeer("192.168.1.5"), true);
  assert.equal(isTrustedPeer("fe80::1"), true);
});

test("isTrustedPeer: public, unspecified and unparseable are refused", () => {
  assert.equal(isTrustedPeer("8.8.8.8"), false);
  assert.equal(isTrustedPeer("0.0.0.0"), false);
  assert.equal(isTrustedPeer("garbage"), false);
});

// ── isSameOrigin ────────────────────────────────────────────────────────────

test("isSameOrigin: no Origin header means non-browser client → allowed", () => {
  assert.equal(isSameOrigin(null, "192.168.1.10:8717"), true);
});

test("isSameOrigin: matching origin and host → true", () => {
  assert.equal(
    isSameOrigin("http://192.168.1.10:8717", "192.168.1.10:8717"),
    true,
  );
});

test("isSameOrigin: a foreign page's origin → false", () => {
  assert.equal(isSameOrigin("http://evil.com", "192.168.1.10:8717"), false);
});

test('isSameOrigin: the sandboxed "null" origin must never write', () => {
  assert.equal(isSameOrigin("null", "192.168.1.10:8717"), false);
});

test("isSameOrigin: an unparseable Origin is refused, not errored past", () => {
  assert.equal(isSameOrigin("not a url", "192.168.1.10:8717"), false);
});

// ── guardPeer ───────────────────────────────────────────────────────────────

test("guardPeer: a public peer is refused with a reason naming address and class", () => {
  const r = guardPeer("8.8.8.8");
  assert.equal(r.ok, false);
  assert.ok(r.reason, "a refusal without a reason is undebuggable");
  assert.match(r.reason, /8\.8\.8\.8/);
  assert.match(r.reason, /public/);
});

test("guardPeer: a private-LAN peer passes with no reason", () => {
  assert.deepEqual(guardPeer("192.168.1.5"), { ok: true, reason: null });
});
