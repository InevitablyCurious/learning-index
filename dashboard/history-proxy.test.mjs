// ─────────────────────────────────────────────────────────────────────────────
// HISTORY PROXY — URL FORWARDING + VERBATIM RESPONSE RELAY
//
// sources/history-proxy.mjs is import-safe (top level is declarations only),
// so these tests import it directly and stub globalThis.fetch with the
// save/restore pattern from history.test.mjs. server.mjs is deliberately NOT
// imported — it is not import-safe.
//
// What is pinned here is the two properties the /history bug turned on:
//   1. the browser's pathname + query string reach the control plane EXACTLY
//      as sent (no re-encoding, no dropped params, no prefix matching), and
//   2. the control plane's status + content-type + body come back VERBATIM —
//      the board never recomposes them, except the honest 502 it answers
//      with when the control plane cannot be reached at all.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import { proxyHistory, HISTORY_PROXY_PATHS } from "./sources/history-proxy.mjs";

const CONTROL = "http://127.0.0.1:9999";

/** A fake Response in the exact shape proxyHistory consumes. */
const fakeRes = (status, contentType, body) => ({
  status,
  headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? contentType : null) },
  text: async () => body,
});

/** Runs `fn` with globalThis.fetch stubbed; returns the captured calls. */
async function withFetch(stub, fn) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return stub(url, opts);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return calls;
}

test("HISTORY_PROXY_PATHS: exactly the read-only endpoints the page needs", () => {
  // Pinned as an EXACT set, so adding one is a deliberate act and a prefix
  // match can never creep in. /api/play is the played build's STATUS — a GET.
  // Its start and stop are POSTs and are deliberately absent: the board is
  // read-only and the browser posts to the control plane itself.
  assert.deepEqual(
    [...HISTORY_PROXY_PATHS].sort(),
    [
      "/api/history",
      "/api/history/checkpoints",
      "/api/history/diff",
      "/api/history/transcript",
      "/api/play",
    ].sort(),
  );
});

test("HISTORY_PROXY_PATHS: never carries a write endpoint", () => {
  for (const p of HISTORY_PROXY_PATHS) {
    assert.ok(
      !/\/(start|stop|arm|reset|restore)$/.test(p),
      `${p} looks like a write endpoint — the board proxies GETs only`,
    );
  }
});

test("proxyHistory: forwards pathname + query string verbatim to the control base", async () => {
  const cases = [
    ["/api/history", ""],
    ["/api/history/checkpoints", "?run=1788672514&cell=local%2Fx%2Fcell-0000"],
    ["/api/history/diff", "?run=1788672514&cell=local%2Fx%2Fcell-0000&cp=cp-01"],
    ["/api/history/transcript", ""],
  ];
  for (const [pathname, search] of cases) {
    const calls = await withFetch(
      async () => fakeRes(200, "application/json; charset=utf-8", "{}"),
      async () => {
        await proxyHistory(pathname, search, CONTROL);
      },
    );
    assert.equal(calls.length, 1, pathname);
    assert.equal(calls[0].url, `${CONTROL}${pathname}${search}`);
  }
});

test("proxyHistory: relays status, content-type and body verbatim", async () => {
  const cases = [
    [200, "application/json; charset=utf-8", '{"runs":[]}'],
    [200, "text/plain; charset=utf-8", "@@ -1 +1 @@\n-old\n+new"],
    [200, "text/markdown; charset=utf-8", "# transcript\n"],
    // The control plane's own error shape passes through untouched — the
    // board does not rewrite a 404 into a 502 or into its own JSON.
    [404, "application/json; charset=utf-8", '{"ok":false,"code":"not_found","reason":"no such run"}'],
  ];
  for (const [status, contentType, body] of cases) {
    await withFetch(async () => fakeRes(status, contentType, body), async () => {
      const r = await proxyHistory("/api/history", "", CONTROL);
      assert.deepEqual(r, { status, contentType, body });
    });
  }
});

test("proxyHistory: a missing content-type falls back to application/octet-stream", async () => {
  await withFetch(async () => fakeRes(200, null, "bytes"), async () => {
    const r = await proxyHistory("/api/history", "", CONTROL);
    assert.equal(r.contentType, "application/octet-stream");
  });
});

test("proxyHistory: an unreachable control plane becomes a 502 honest error", async () => {
  await withFetch(
    async () => {
      throw new Error("fetch failed");
    },
    async () => {
      const r = await proxyHistory("/api/history/checkpoints", "?run=1", CONTROL);
      assert.equal(r.status, 502);
      assert.equal(r.contentType, "application/json; charset=utf-8");
      const body = JSON.parse(r.body);
      assert.equal(body.ok, false);
      assert.equal(body.reason, "fetch failed");
    },
  );
});

test("proxyHistory: controlUrl defaults to the loopback control plane", async () => {
  const calls = await withFetch(
    async () => fakeRes(200, "application/json; charset=utf-8", "{}"),
    async () => {
      await proxyHistory("/api/history", "", undefined);
    },
  );
  assert.equal(calls[0].url, "http://127.0.0.1:8718/api/history");
});

test("proxyHistory: bounded timeout signal, and no JSON-assuming accept header", async () => {
  // diff is text/plain and transcript is text/markdown — an accept header
  // that assumes JSON is the exact drift this proxy must not reintroduce.
  const calls = await withFetch(
    async () => fakeRes(200, "text/markdown; charset=utf-8", "# t"),
    async () => {
      await proxyHistory("/api/history/transcript", "", CONTROL);
    },
  );
  const { opts } = calls[0];
  assert.ok(opts?.signal instanceof AbortSignal, "expected a bounded AbortSignal.timeout");
  const accept = opts?.headers?.accept ?? opts?.headers?.Accept;
  assert.ok(accept === undefined || accept === "*/*", `accept must not assume JSON: ${accept}`);
});
