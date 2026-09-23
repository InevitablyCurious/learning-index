// CELL FEEDS — one event subscription per running cell.
//
// ── WHY NOT ONE FIXED URL ───────────────────────────────────────────────────
//
// Every cell's `opencode serve` now binds its own free host port
// (harness/free_port.py), published as `serve_url` on the cell.start record at
// the head of its live.jsonl. The control plane used to subscribe to one fixed
// `--serve-url` (:8719) for the life of the process. After per-cell ports that
// address had nobody behind it, and the N=4 batch of 2026-09-22 (runs/
// 1790106437) captured no agent-events.jsonl at all: the DATA FEED was empty for
// every cell, including a single-cell run.
//
// So the subscriptions follow the cells. Every tick: each running cell with a
// resolvable serve_url gets a subscription; a cell that stopped running loses
// its own. All of them feed the ONE ring, whose sink persists every row to the
// run's agent-events.jsonl — each row carries the opencode session id it came
// from, which is how the per-cell read (agent-events.mjs readAgentEvents)
// separates cells.
//
// The ring's `connected` is the union: connected when any cell's feed is. With
// nothing running it is not connected and says so.

import { readRunState, cellServeUrl } from "./runstate.mjs";
import { subscribe } from "./events.mjs";

const TICK_MS = 2000;

/** `${run_dir}::${sequence_index}` — the cell's address, composed once. */
function keyOf(run) {
  return `${run.run_dir}::${run.sequence_index}`;
}

/**
 * The reconcile core, dependency-injected so it is testable without sockets.
 *   listRunning()          -> [{run_dir, sequence_index}] running cells
 *   serveUrlFor(run)       -> the cell's serve_url, or null (not published yet)
 *   subscribeImpl(url, t)  -> stop(); feeds frames into t.push()
 */
export function createCellFeeds({ ring, listRunning, serveUrlFor, subscribeImpl = subscribe }) {
  /** key -> { url, stop, status } */
  const feeds = new Map();

  function aggregate() {
    const statuses = [...feeds.values()].map((f) => f.status);
    const live = statuses.filter((s) => s.connected);
    if (live.length) {
      ring.connected = true;
      ring.reason = null;
      ring.connected_at = Math.min(...live.map((s) => s.connected_at ?? Date.now()));
      return;
    }
    ring.connected = false;
    ring.connected_at = null;
    ring.reason = statuses.length
      ? (statuses.find((s) => s.reason)?.reason ?? "event feed connecting")
      : "no cell is running";
  }

  async function reconcile() {
    const running = (await listRunning()).filter(
      (r) => typeof r?.run_dir === "string" && r.run_dir && Number.isInteger(r.sequence_index),
    );
    const want = new Set(running.map(keyOf));

    for (const [key, feed] of feeds) {
      if (!want.has(key)) {
        feed.stop();
        feeds.delete(key);
      }
    }

    for (const run of running) {
      const key = keyOf(run);
      if (feeds.has(key)) continue;
      // Absent until the harness writes cell.start (seconds after launch):
      // retried next tick, never guessed.
      const url = await serveUrlFor(run);
      if (!url) continue;
      // Each subscription writes its own connection state here, never onto the
      // shared ring — N feeds would otherwise overwrite each other.
      const status = {
        connected: false,
        reason: null,
        connected_at: null,
        push: (raw) => ring.push(raw),
      };
      const stop = subscribeImpl(`${url}/event`, status);
      feeds.set(key, { url, stop, status });
    }

    aggregate();
  }

  function stopAll() {
    for (const feed of feeds.values()) feed.stop();
    feeds.clear();
    aggregate();
  }

  return { reconcile, stopAll, feeds };
}

/** Wire the reconcile to the real run state and start its timer; returns stop(). */
export function startCellFeeds({ ring, runsRoot }) {
  const cellFeeds = createCellFeeds({
    ring,
    listRunning: async () => {
      const state = await readRunState({ runsRoot });
      return (state?.runs ?? []).filter((r) => r.running === true);
    },
    serveUrlFor: (run) => cellServeUrl(runsRoot, run.run_dir, run.sequence_index),
  });
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await cellFeeds.reconcile();
    } catch (err) {
      // A run-state read failure never takes the feeds down; it is stated.
      ring.reason = `cell feed reconcile failed: ${String(err?.message ?? err)}`;
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    cellFeeds.stopAll();
  };
}
