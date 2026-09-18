// The same-origin control-plane relay (lib/control-relay.mjs).
//
// These cases pin the three hard edges of the relay: the EXACT-match
// allowlist (unknown path, wrong method and extra segments all 404 without a
// fetch ever happening), the origin/CSRF gate on writes (a foreign or opaque
// Origin is refused BEFORE the body is read; absent Origin — curl on a
// trusted peer — passes), and honest forwarding (query string verbatim,
// upstream status verbatim, unreachable control plane → 502). The credential
// cases pin the hygiene contract: a secret body reaches the control plane
// intact but is never echoed back in ANY relay-composed or forwarded reply.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createControlRelay,
  defaultReadBody,
} from "./lib/control-relay.mjs";

const CONTROL_URL = "http://127.0.0.1:8718";
const HOST = "192.168.1.10:8717";

// A res double: records writeHead status+headers and the ended body string.
function makeRes() {
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
      return res;
    },
    end(body) {
      res.body = body ?? "";
      return res;
    },
  };
  return res;
}

function makeReq({ method = "GET", path = "/", search = "", origin, host = HOST, extraHeaders }) {
  return {
    method,
    url: new URL(path + search, "http://x"),
    headers: {
      ...(origin !== undefined ? { origin } : {}),
      host,
      "content-type": "application/json",
      ...extraHeaders,
    },
  };
}

// Harness: stub fetchImpl records every call and returns a canned upstream
// reply; stub readBody returns a fixed JSON string. opts: { status, text,
// fetchThrows, readBody, controlUrl }.
function makeRelay(opts = {}) {
  const fetched = [];
  const responses = [];
  const fetchImpl = async (url, init) => {
    fetched.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (opts.fetchThrows) throw new Error(opts.fetchThrows);
    return {
      status: opts.status ?? 200,
      headers: { get: (k) => (k === "content-type" ? "application/json" : null) },
      text: async () => opts.text ?? '{"ok":true}',
    };
  };
  const relay = createControlRelay({
    controlUrl: opts.controlUrl ?? CONTROL_URL,
    fetchImpl,
    readBody: opts.readBody ?? (async () => '{"k":"v"}'),
  });
  async function call(reqOpts) {
    const req = makeReq(reqOpts);
    const res = makeRes();
    await relay(req, res, req.url);
    responses.push(res);
    return res;
  }
  return { relay, fetched, responses, call };
}

// ── the allowlist itself ────────────────────────────────────────────────────

test("GET proxies to the control plane", async () => {
  const h = makeRelay();
  const res = await h.call({ method: "GET", path: "/api/roster" });
  assert.equal(h.fetched.length, 1);
  assert.equal(h.fetched[0].method, "GET");
  assert.equal(h.fetched[0].url, `${CONTROL_URL}/api/roster`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/json");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.body, '{"ok":true}');
});

test("an unknown path is the control plane's to refuse", async () => {
  const h = makeRelay({ status: 404, text: '{"ok":false,"code":"upstream_unwired"}' });
  const res = await h.call({ method: "GET", path: "/api/nope" });
  assert.equal(h.fetched[0].url, `${CONTROL_URL}/api/nope`);
  assert.equal(res.statusCode, 404);
});

test("methods other than GET and POST are refused and never forwarded", async () => {
  const h = makeRelay();
  const res = await h.call({ method: "PUT", path: "/api/run/start" });
  assert.equal(res.statusCode, 405);
  assert.equal(h.fetched.length, 0);
});

test("a live stream is piped through as it arrives", async () => {
  const chunks = [];
  const res = {
    headersSent: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; },
    write(c) { chunks.push(Buffer.from(c).toString()); },
    end() { this.ended = true; },
  };
  const relay = createControlRelay({
    controlUrl: CONTROL_URL,
    fetchImpl: async () => new Response(new ReadableStream({
      start(ctl) { ctl.enqueue(new TextEncoder().encode("event: board\n\n")); ctl.close(); },
    }), { headers: { "content-type": "text/event-stream" } }),
  });
  const req = { method: "GET", headers: { host: HOST }, on() {} };
  await relay(req, res, new URL("http://x/api/stream?since=0"));
  assert.equal(res.headers["content-type"], "text/event-stream");
  assert.deepEqual(chunks, ["event: board\n\n"]);
  assert.ok(res.ended);
});

// ── origin / CSRF on writes ─────────────────────────────────────────────────

test("cross-origin POST is refused 403 before any fetch", async () => {
  const h = makeRelay();
  const res = await h.call({
    method: "POST",
    path: "/api/devmode",
    origin: "http://evil.com",
    host: HOST,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(h.fetched.length, 0);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.code, "cross_origin_denied");
  assert.match(body.reason, /cross-origin write refused/);
});

test("same-origin POST proxies", async () => {
  const h = makeRelay();
  const res = await h.call({
    method: "POST",
    path: "/api/devmode",
    origin: `http://${HOST}`,
    host: HOST,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(h.fetched.length, 1);
  assert.equal(h.fetched[0].method, "POST");
});

test("absent origin POST proxies (curl on a trusted peer)", async () => {
  const h = makeRelay();
  const res = await h.call({ method: "POST", path: "/api/run/stop", host: HOST });
  assert.equal(res.statusCode, 200);
  assert.equal(h.fetched.length, 1);
});

test("opaque 'null' origin POST is refused 403", async () => {
  const h = makeRelay();
  const res = await h.call({ method: "POST", path: "/api/devmode", origin: "null", host: HOST });
  assert.equal(res.statusCode, 403);
  assert.equal(h.fetched.length, 0);
  assert.equal(JSON.parse(res.body).code, "cross_origin_denied");
});

// ── forwarding correctness ──────────────────────────────────────────────────

test("POST forwards method, body and content-type to the control plane", async () => {
  const h = makeRelay();
  const res = await h.call({ method: "POST", path: "/api/routers/key", host: HOST });
  assert.equal(res.statusCode, 200);
  assert.equal(h.fetched.length, 1);
  assert.equal(h.fetched[0].method, "POST");
  assert.equal(h.fetched[0].body, '{"k":"v"}');
  assert.equal(h.fetched[0].headers["content-type"], "application/json");
  assert.equal(h.fetched[0].url, `${CONTROL_URL}/api/routers/key`);
});

test("query string is forwarded verbatim", async () => {
  const h = makeRelay();
  await h.call({ method: "GET", path: "/api/history", search: "?run=1" });
  assert.equal(h.fetched.length, 1);
  assert.ok(h.fetched[0].url.includes("?run=1"));
  assert.equal(h.fetched[0].url, `${CONTROL_URL}/api/history?run=1`);
});

test("only content-type and accept cross the hop", async () => {
  const h = makeRelay();
  await h.call({
    method: "GET",
    path: "/api/roster",
    origin: `http://${HOST}`,
    extraHeaders: {
      accept: "application/json",
      cookie: "session=super-secret",
      "x-forwarded-for": "203.0.113.9",
    },
  });
  const fwd = h.fetched[0].headers;
  assert.equal(fwd["content-type"], "application/json");
  assert.equal(fwd.accept, "application/json");
  assert.ok(!("cookie" in fwd));
  assert.ok(!("x-forwarded-for" in fwd));
  assert.ok(!("origin" in fwd));
  assert.ok(!("host" in fwd));
});

test("upstream status and body are forwarded verbatim (404)", async () => {
  const upstreamBody = '{"ok":false,"code":"no_such_run","reason":"run 42 unknown"}';
  const h = makeRelay({ status: 404, text: upstreamBody });
  const res = await h.call({ method: "GET", path: "/api/run", search: "?id=42" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body, upstreamBody);
});

test("unreachable control plane becomes an honest 502", async () => {
  const h = makeRelay({ fetchThrows: "fetch failed: ECONNREFUSED 127.0.0.1:8718" });
  const res = await h.call({ method: "GET", path: "/api/roster" });
  assert.equal(res.statusCode, 502);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.match(body.reason, /ECONNREFUSED/);
});

test("oversized body becomes 413 body_too_large without fetching", async () => {
  const h = makeRelay({
    readBody: async () => {
      throw new Error("request body exceeds 64KB cap");
    },
  });
  const res = await h.call({ method: "POST", path: "/api/routers/key", host: HOST });
  assert.equal(res.statusCode, 413);
  assert.equal(h.fetched.length, 0);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.code, "body_too_large");
  assert.equal(body.reason, "request body exceeds 64KB cap");
});

// ── credential hygiene ──────────────────────────────────────────────────────

test("credential body reaches the control plane but never the response", async () => {
  const SECRET = "sk-SECRET-do-not-echo";
  const secretBody = `{"router":"openai","key":"${SECRET}"}`;
  const readBody = async () => secretBody;
  const reqOpts = { method: "POST", path: "/api/routers/key", host: HOST };

  // 2xx: forwarded intact, reply is the control plane's (fingerprint-only),
  // never an echo of the request body.
  const ok = makeRelay({ readBody });
  const okRes = await ok.call(reqOpts);
  assert.equal(okRes.statusCode, 200);
  assert.equal(ok.fetched[0].body, secretBody);
  assert.ok(!okRes.body.includes(SECRET));

  // 4xx: upstream refusal passes through verbatim — still no body echo.
  const bad = makeRelay({ readBody, status: 400, text: '{"ok":false,"reason":"key rejected by provider"}' });
  const badRes = await bad.call(reqOpts);
  assert.equal(badRes.statusCode, 400);
  assert.equal(bad.fetched[0].body, secretBody);
  assert.ok(!badRes.body.includes(SECRET));

  // 5xx: the relay-composed 502 names the transport failure only.
  const down = makeRelay({ readBody, fetchThrows: "upstream exploded" });
  const downRes = await down.call(reqOpts);
  assert.equal(downRes.statusCode, 502);
  assert.equal(down.fetched[0].body, secretBody);
  assert.ok(!downRes.body.includes(SECRET));
});

// ── defaultReadBody (the production reader) ─────────────────────────────────

test("defaultReadBody concatenates chunks into a UTF-8 string", async () => {
  async function* stream() {
    yield Buffer.from('{"a":');
    yield "1}"; // string chunks are normalized too
  }
  assert.equal(await defaultReadBody(stream()), '{"a":1}');
});

test("defaultReadBody throws when the cap is exceeded, not after", async () => {
  async function* over() {
    yield "x".repeat(8);
    yield "y"; // one byte past the cap → throw before buffering more
  }
  await assert.rejects(() => defaultReadBody(over(), 8), /request body exceeds 64KB cap/);

  async function* exact() {
    yield "x".repeat(8);
  }
  assert.equal(await defaultReadBody(exact(), 8), "x".repeat(8)); // at cap → fine
});
