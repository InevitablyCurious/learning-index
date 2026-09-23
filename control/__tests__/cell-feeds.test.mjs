// CELL FEEDS — one event subscription per running cell (control/cell-feeds.mjs).
//
// The control plane subscribed to ONE fixed serve URL (:8719) for its whole
// life. Per-cell serve ports (harness/free_port.py) left that address empty, and
// the N=4 batch of 2026-09-22 captured no agent events for any cell. These pin
// that subscriptions follow the running cells, one each, on each cell's own URL.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCellFeeds } from "../cell-feeds.mjs";

function harness(initial) {
  let running = initial;
  const urls = new Map(); // key -> url
  const opened = [];
  const stopped = [];
  const ring = { pushed: [], push(raw) { this.pushed.push(raw); }, connected: false, reason: null, connected_at: null };
  const feeds = createCellFeeds({
    ring,
    listRunning: async () => running,
    serveUrlFor: async (r) => urls.get(`${r.run_dir}::${r.sequence_index}`) ?? null,
    subscribeImpl: (url, status) => {
      opened.push({ url, status });
      return () => stopped.push(url);
    },
  });
  return {
    ring, feeds, opened, stopped, urls,
    setRunning(next) { running = next; },
  };
}

const A = { run_dir: "r/x", sequence_index: 0, running: true };
const B = { run_dir: "r/x", sequence_index: 1, running: true };

test("one subscription per running cell, on that cell's own serve URL", async () => {
  const h = harness([A, B]);
  h.urls.set("r/x::0", "http://127.0.0.1:57734");
  h.urls.set("r/x::1", "http://127.0.0.1:57741");
  await h.feeds.reconcile();
  assert.deepEqual(h.opened.map((o) => o.url).sort(), [
    "http://127.0.0.1:57734/event",
    "http://127.0.0.1:57741/event",
  ]);
  await h.feeds.reconcile();
  assert.equal(h.opened.length, 2, "a cell already followed is not re-subscribed");
});

test("a cell whose serve_url is not published yet is retried, never guessed", async () => {
  const h = harness([A]);
  await h.feeds.reconcile();
  assert.equal(h.opened.length, 0);
  h.urls.set("r/x::0", "http://127.0.0.1:57734");
  await h.feeds.reconcile();
  assert.equal(h.opened.length, 1);
});

test("a cell that stops running loses its subscription", async () => {
  const h = harness([A, B]);
  h.urls.set("r/x::0", "http://a");
  h.urls.set("r/x::1", "http://b");
  await h.feeds.reconcile();
  h.setRunning([B]);
  await h.feeds.reconcile();
  assert.deepEqual(h.stopped, ["http://a/event"]);
  assert.equal(h.feeds.feeds.size, 1);
});

test("an unaddressable run is skipped", async () => {
  const h = harness([{ run_dir: null, sequence_index: 0 }, { run_dir: "r/x", sequence_index: null }]);
  await h.feeds.reconcile();
  assert.equal(h.opened.length, 0);
});

test("every cell's frames land in the one ring", async () => {
  const h = harness([A, B]);
  h.urls.set("r/x::0", "http://a");
  h.urls.set("r/x::1", "http://b");
  await h.feeds.reconcile();
  h.opened[0].status.push({ type: "x", n: 1 });
  h.opened[1].status.push({ type: "x", n: 2 });
  assert.deepEqual(h.ring.pushed.map((f) => f.n), [1, 2]);
});

test("the ring is connected while ANY cell's feed is, and says why when none is", async () => {
  const h = harness([A, B]);
  h.urls.set("r/x::0", "http://a");
  h.urls.set("r/x::1", "http://b");
  await h.feeds.reconcile();
  assert.equal(h.ring.connected, false);
  h.opened[1].status.connected = true;
  h.opened[1].status.connected_at = 5;
  await h.feeds.reconcile();
  assert.equal(h.ring.connected, true);
  assert.equal(h.ring.reason, null);

  h.setRunning([]);
  await h.feeds.reconcile();
  assert.equal(h.ring.connected, false);
  assert.equal(h.ring.reason, "no cell is running");
});
