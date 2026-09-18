// The REMOTE_VIEWING LAN switch's resolution contract (lib/remote-viewing.mjs).
//
// The property under test is NOT "does it parse env vars" — it is "can this
// switch ever guess". Every case here pins one direction of that: absence
// means disabled, an explicit word means exactly that word (however it was
// cased or padded), and anything else is a LOUD refusal with the raw value
// echoed back — never a silent fallback. The bind cases pin the second half,
// FAIL-CLOSED (WO-RV03): disabled always lands on loopback (and says so when
// it overrides a wider OKP_DASH_HOST); enabled requires a SPECIFIC physical
// LAN address — unset, loopback and wildcard are refusals, never coercions
// to 0.0.0.0; and inside a container the internal bind is always 0.0.0.0
// while the compose publish host (OKP_BIND_HOST) is validated against the
// mode — disabled refuses a wide publish, enabled refuses wildcard, loopback
// and unset alike.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTAINER_ENV_VAR,
  REMOTE_VIEWING_ENV_VAR,
  resolveBind,
  resolveRemoteViewing,
} from "./lib/remote-viewing.mjs";

// ── the contract's names ────────────────────────────────────────────────────
// These strings appear in the Dockerfile/compose, the README and operator
// shell history; if the module ever renames them, that is a breaking change
// and this test is where it gets noticed.

test("env var names are the published contract", () => {
  assert.equal(REMOTE_VIEWING_ENV_VAR, "REMOTE_VIEWING");
  assert.equal(CONTAINER_ENV_VAR, "OKP_DASH_CONTAINER");
});

// ── resolveRemoteViewing: absence is disabled, and says "default" ───────────

test("unset REMOTE_VIEWING resolves disabled/default", () => {
  assert.deepEqual(resolveRemoteViewing({ env: {} }), {
    mode: "disabled",
    source: "default",
    error: null,
  });
});

test("empty REMOTE_VIEWING resolves disabled/default", () => {
  assert.deepEqual(resolveRemoteViewing({ env: { REMOTE_VIEWING: "" } }), {
    mode: "disabled",
    source: "default",
    error: null,
  });
});

test("whitespace-only REMOTE_VIEWING resolves disabled/default", () => {
  assert.deepEqual(resolveRemoteViewing({ env: { REMOTE_VIEWING: "   " } }), {
    mode: "disabled",
    source: "default",
    error: null,
  });
});

// ── resolveRemoteViewing: explicit words, case/space-insensitive ────────────

test('REMOTE_VIEWING="disabled" resolves disabled/environment', () => {
  assert.deepEqual(resolveRemoteViewing({ env: { REMOTE_VIEWING: "disabled" } }), {
    mode: "disabled",
    source: "environment",
    error: null,
  });
});

test('REMOTE_VIEWING="DISABLED" is the same explicit disabled', () => {
  assert.deepEqual(resolveRemoteViewing({ env: { REMOTE_VIEWING: "DISABLED" } }), {
    mode: "disabled",
    source: "environment",
    error: null,
  });
});

test('REMOTE_VIEWING=" Enabled " resolves enabled/environment (trimmed, lowercased)', () => {
  assert.deepEqual(resolveRemoteViewing({ env: { REMOTE_VIEWING: " Enabled " } }), {
    mode: "enabled",
    source: "environment",
    error: null,
  });
});

// ── resolveRemoteViewing: anything else is a loud refusal, never a guess ────

test('REMOTE_VIEWING="banana" refuses with mode null and the raw value echoed', () => {
  const r = resolveRemoteViewing({ env: { REMOTE_VIEWING: "banana" } });
  assert.equal(r.mode, null);
  assert.equal(r.source, "environment");
  assert.equal(r.error.value, "banana");
  assert.deepEqual(r.error.accepted, ["disabled", "enabled"]);
});

// ── resolveBind: disabled always lands on loopback (host path) ─────────────

test("disabled with no dashHost binds 127.0.0.1 with no note", () => {
  assert.deepEqual(resolveBind({ mode: "disabled" }), {
    host: "127.0.0.1",
    note: null,
    error: null,
  });
});

test("disabled overrides a wider dashHost to 127.0.0.1 AND says so", () => {
  const r = resolveBind({ mode: "disabled", dashHost: "0.0.0.0" });
  assert.equal(r.host, "127.0.0.1");
  assert.equal(r.error, null, "on the host path, disabled coerces loudly — not fatally");
  assert.ok(r.note, "overriding an explicit OKP_DASH_HOST must produce a note");
  assert.match(r.note, /OKP_DASH_HOST/);
});

// ── resolveBind: enabled on the host requires a SPECIFIC LAN address ────────

test("enabled with no dashHost REFUSES (the untouched default must not go wide)", () => {
  const r = resolveBind({ mode: "enabled" });
  assert.equal(r.host, null, "a refused bind must not hand back an address");
  assert.match(r.error, /specific physical LAN host address/);
  assert.match(r.error, /OKP_DASH_HOST/);
});

test("enabled with a loopback dashHost REFUSES", () => {
  const r = resolveBind({ mode: "enabled", dashHost: "127.0.0.1" });
  assert.equal(r.host, null);
  assert.match(r.error, /specific physical LAN host address/);
});

test("enabled with a wildcard dashHost REFUSES as all-interfaces", () => {
  for (const dashHost of ["0.0.0.0", "::", "[::]", "::0"]) {
    const r = resolveBind({ mode: "enabled", dashHost });
    assert.equal(r.host, null, `wildcard ${dashHost} must not bind`);
    assert.match(r.error, /all-interfaces, not LAN-only/, `dashHost=${dashHost}`);
  }
});

test("enabled honours an explicit specific interface address", () => {
  assert.deepEqual(resolveBind({ mode: "enabled", dashHost: "192.168.1.10" }), {
    host: "192.168.1.10",
    note: null,
    error: null,
  });
});

// ── resolveBind: container — internal bind always 0.0.0.0, PUBLISH validated ─
// Inside the container the network namespace is the boundary, so the process
// binds wide unconditionally; the exposure decision is the compose publish
// host (OKP_BIND_HOST), and THAT is what the fail-closed validation covers.

test("container+disabled with no bindHost binds 0.0.0.0 internally, no error", () => {
  assert.deepEqual(resolveBind({ mode: "disabled", container: true }), {
    host: "0.0.0.0",
    note: null,
    error: null,
  });
});

test("container+disabled with a loopback bindHost is accepted", () => {
  assert.deepEqual(
    resolveBind({ mode: "disabled", container: true, bindHost: "127.0.0.1" }),
    { host: "0.0.0.0", note: null, error: null },
  );
});

test("container+disabled with a non-loopback bindHost REFUSES (the WO-RV02 bypass)", () => {
  for (const bindHost of ["0.0.0.0", "::", "192.168.50.140"]) {
    const r = resolveBind({ mode: "disabled", container: true, bindHost });
    assert.equal(r.host, "0.0.0.0", "internal bind unchanged; the error blocks listen");
    assert.match(r.error, /would publish beyond loopback/, `bindHost=${bindHost}`);
    assert.ok(r.error.includes(`OKP_BIND_HOST=${bindHost}`), "the error echoes the offending value");
  }
});

test("container+enabled with unset/empty/loopback bindHost REFUSES", () => {
  for (const bindHost of [undefined, "", "127.0.0.1"]) {
    const r = resolveBind({ mode: "enabled", container: true, bindHost });
    assert.equal(r.host, "0.0.0.0");
    assert.match(
      r.error,
      /requires OKP_BIND_HOST=<specific physical LAN address>/,
      `bindHost=${JSON.stringify(bindHost)}`,
    );
  }
});

test("container+enabled with a wildcard bindHost REFUSES as all-interfaces", () => {
  for (const bindHost of ["0.0.0.0", "::", "[::]", "::0"]) {
    const r = resolveBind({ mode: "enabled", container: true, bindHost });
    assert.equal(r.host, "0.0.0.0");
    assert.match(r.error, /all-interfaces, not LAN-only/, `bindHost=${bindHost}`);
  }
});

test("container+enabled with a specific LAN bindHost is accepted", () => {
  assert.deepEqual(
    resolveBind({ mode: "enabled", container: true, bindHost: "192.168.50.140" }),
    { host: "0.0.0.0", note: null, error: null },
  );
});

// ── resolveBind: an unresolved mode is a caller bug and still throws ────────

test("resolveBind throws on an unresolved mode (the caller must refuse first)", () => {
  assert.throws(() => resolveBind({ mode: null }), /must stop startup/);
  assert.throws(() => resolveBind({ mode: null, container: true }), /must stop startup/);
});
