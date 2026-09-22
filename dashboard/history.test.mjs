// ─────────────────────────────────────────────────────────────────────────────
// HISTORY PAGE — PURE RENDERERS + LOADER URL ENCODING
//
// /history shows the RECORD: runs → check-points → changed files → side-by-side
// diff. history.js keeps its renderers pure (HTML strings, no DOM) and its
// loaders fetch-based, so everything here runs under plain Node: fixtures use
// the REAL endpoint shapes (/api/history, /api/history/checkpoints) and we
// assert on returned HTML substrings. No DOM lib exists in this repo — none is
// needed. boot() is deliberately NOT tested here (it requires a document).
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  renderRuns,
  renderRunRow,
  renderCheckpoints,
  renderFiles,
  renderDiff,
  loadRuns,
  loadCheckpoints,
  loadDiff,
  cellWirePair,
  currentToasts,
} from "./history.js";

// ── fixtures — the real endpoint shapes ─────────────────────────────────────

/** One run as /api/history returns it. */
const RUN = {
  benchmark_id: "1788672514",
  cell: "local/x/cell-0000",
  dev_mode_enabled: true,
  dev_mode_source: "state_file",
  dev_mode_file: "/runs/1788672514/local/x/cell-0000/state.json",
  checkpoints_dir: "/runs/1788672514/local/x/cell-0000/checkpoints",
  transcript_file: "/runs/1788672514/local/x/cell-0000/transcript.md",
};

/** Two check-points as /api/history/checkpoints returns them. */
const CHECKPOINTS = [
  { id: "cp-01", attempt: 1, phase: "bench", state_hash: "abc123", wall_ts: 1788700000000, tree_path: "checkpoints/cp-01/tree" },
  { id: "cp-02", attempt: 2, phase: "bench", state_hash: "def456", wall_ts: 1788700600000, tree_path: "checkpoints/cp-02/tree" },
];

/** The stored diffs: cp-01 → cp-02 touched one file. cp-01 is the baseline. */
const DIFFS = [
  {
    id: "cp-01_to_cp-02",
    from: "cp-01",
    to: "cp-02",
    combined: "checkpoints/diffs/cp-01_to_cp-02/combined.diff",
    files: [
      {
        path: "src/game.ts",
        change: "modified",
        diff: "checkpoints/diffs/cp-01_to_cp-02/files/src/game.ts.diff",
      },
    ],
  },
];

// ── renderRuns ───────────────────────────────────────────────────────────────

test("renderRuns: empty state says No runs yet", () => {
  const html = renderRuns({ runs: [], loading: false, error: null });
  assert.ok(html.includes("No runs yet"), html);
});

test("renderRuns: loading state says reading history", () => {
  const html = renderRuns({ runs: null, loading: true, error: null });
  assert.ok(html.includes("reading history"), html);
});

test("renderRuns: error state renders the error string", () => {
  const html = renderRuns({ runs: null, loading: false, error: "HTTP 502" });
  assert.ok(html.includes("HTTP 502"), html);
});

test("renderRuns: archived selection expands beneath its own row, before the next run", () => {
  const first = { ...RUN, benchmark_id: "backups", cell: "first/cell-0000" };
  const second = { ...first, cell: "second/cell-0000" };
  const html = renderRuns({ runs: [first, second] }, {
    run: first.benchmark_id,
    cell: first.cell,
    details: '<section id="history-details">checkpoints</section>',
  });
  assert.ok(html.indexOf('data-cell="first/cell-0000"') < html.indexOf('<section id="history-details">'));
  assert.ok(html.indexOf('<section id="history-details">') < html.indexOf('data-cell="second/cell-0000"'));
  assert.equal((html.match(/aria-expanded="true"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-expanded="false"/g) ?? []).length, 1);
});

// ── renderRunRow ─────────────────────────────────────────────────────────────

test("renderRunRow: full columns + data-run/data-cell hooks", () => {
  const html = renderRunRow(RUN);
  assert.ok(html.includes("1788672514"), "benchmark_id value: " + html);
  assert.ok(html.includes("state_file"), "dev_mode_source: " + html);
  assert.ok(html.includes("/runs/1788672514/local/x/cell-0000/state.json"), "dev_mode_file: " + html);
  assert.ok(html.includes("/runs/1788672514/local/x/cell-0000/checkpoints"), "checkpoints_dir: " + html);
  assert.ok(html.includes("/runs/1788672514/local/x/cell-0000/transcript.md"), "transcript_file: " + html);
  assert.ok(html.includes('data-run="1788672514"'), "data-run: " + html);
  assert.ok(html.includes('data-cell="local/x/cell-0000"'), "data-cell: " + html);
});

test("renderRunRow: null artifacts render none", () => {
  const html = renderRunRow({ ...RUN, checkpoints_dir: null, transcript_file: null });
  assert.ok(html.includes("none"), html);
  assert.ok(html.includes('<span class="hist-none">none</span>'), html);
});

// ── renderCheckpoints ────────────────────────────────────────────────────────

test("renderCheckpoints: empty state says not captured yet", () => {
  const html = renderCheckpoints({ checkpoints: [], loading: false, error: null });
  assert.ok(html.includes("not captured yet"), html);
});

test("renderCheckpoints: list rows carry id, phase, hash, data-cp", () => {
  const html = renderCheckpoints({ checkpoints: CHECKPOINTS, loading: false, error: null });
  assert.ok(html.includes("cp-01"), html);
  assert.ok(html.includes("bench"), html);
  assert.ok(html.includes("abc123"), html);
  assert.ok(html.includes('data-cp="cp-01"'), html);
});

// ── renderFiles ──────────────────────────────────────────────────────────────

test("renderFiles: first check-point is the baseline — no diff", () => {
  const html = renderFiles(CHECKPOINTS, DIFFS, "cp-01");
  assert.ok(html.includes("baseline — no diff"), html);
});

test("renderFiles: file list carries path, change, data-file, data-change", () => {
  const html = renderFiles(CHECKPOINTS, DIFFS, "cp-02");
  assert.ok(html.includes("src/game.ts"), html);
  assert.ok(html.includes("modified"), html);
  assert.ok(html.includes('data-change="modified"'), html);
  assert.ok(html.includes('data-file="checkpoints/diffs/cp-01_to_cp-02/files/src/game.ts.diff"'), html);
});

// ── renderDiff ───────────────────────────────────────────────────────────────

test("renderDiff: absent Diff2Html vendor says diff renderer unavailable", () => {
  const prior = globalThis.Diff2Html;
  delete globalThis.Diff2Html;
  try {
    const html = renderDiff({ diffText: "--- a\n+++ b\n", diffPath: "x", loading: false, error: null });
    assert.ok(html.includes("diff renderer unavailable"), html);
  } finally {
    if (prior !== undefined) globalThis.Diff2Html = prior;
  }
});

test("renderDiff: renders via Diff2Html with side-by-side output", () => {
  const prior = globalThis.Diff2Html;
  let capturedOpts = null;
  globalThis.Diff2Html = {
    html: (text, opts) => {
      capturedOpts = opts;
      return '<div class="d2h">' + text + "</div>";
    },
  };
  try {
    const html = renderDiff({ diffText: "@@ -1 +1 @@", diffPath: "x", loading: false, error: null });
    assert.ok(html.includes("d2h"), html);
    assert.ok(html.includes("@@ -1 +1 @@"), html);
    assert.equal(capturedOpts?.outputFormat, "side-by-side");
  } finally {
    if (prior === undefined) delete globalThis.Diff2Html;
    else globalThis.Diff2Html = prior;
  }
});

test("renderDiff: error state renders the reason", () => {
  const html = renderDiff({ diffText: null, diffPath: "x", loading: false, error: "not_found" });
  assert.ok(html.includes("not_found"), html);
});

// ── loaders ──────────────────────────────────────────────────────────────────

test("loadCheckpoints: sends the wire pair — full run_dir + sequence_index, encoded", async () => {
  const realFetch = globalThis.fetch;
  let capturedUrl = null;
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return { ok: true, json: async () => ({ checkpoints: [], diffs: [] }) };
  };
  try {
    await loadCheckpoints(RUN.benchmark_id, RUN.cell);
  } finally {
    globalThis.fetch = realFetch;
  }
  // RUN is 1788672514 + local/x/cell-0000: run_dir is the full cell path
  // minus its last two segments (the arm and the cell name).
  assert.equal(capturedUrl, "/api/history/checkpoints?run=1788672514%2Flocal&sequence_index=0");
});

test("loadCheckpoints: a cell with no sequence_index refuses without fetching", async () => {
  const realFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return { ok: true, json: async () => ({ checkpoints: [], diffs: [] }) };
  };
  try {
    await loadCheckpoints(RUN.benchmark_id, "local/x/cell-abc");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetched, false, "an unaddressable row must not reach the wire");
  assert.equal(currentToasts().at(-1)?.code, "cell_unaddressable");
});

// ── same-origin — the dashboard relays /api/history* ────────────────────────

test("loadRuns: fetches same-origin /api/history — no hardcoded host", async () => {
  const realFetch = globalThis.fetch;
  let capturedUrl = null;
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return { ok: true, json: async () => ({ runs: [] }) };
  };
  try {
    await loadRuns();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(capturedUrl.startsWith("/api/history"), capturedUrl);
  assert.ok(!capturedUrl.includes("http://"), capturedUrl);
  assert.ok(!capturedUrl.includes("https://"), capturedUrl);
  assert.ok(!capturedUrl.includes("127.0.0.1"), capturedUrl);
});

test("loadDiff: fetches the same-origin encoded diff URL — no host", async () => {
  const realFetch = globalThis.fetch;
  let capturedUrl = null;
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return { ok: true, text: async () => "@@ -1 +1 @@" };
  };
  try {
    await loadDiff(RUN.benchmark_id, RUN.cell, "a/b.txt");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(capturedUrl, "/api/history/diff?run=1788672514%2Flocal&sequence_index=0&path=a%2Fb.txt");
});

// ── cellWirePair — the row identity → the (run_dir, sequence_index) address ──

test("cellWirePair: a tree row maps to its campaign run_dir + index", () => {
  assert.deepEqual(
    cellWirePair("1790015745", "local/local-llm-proxy/omlx/qwen3/memoryOFF/cell-0007"),
    { run_dir: "1790015745/local/local-llm-proxy/omlx/qwen3", sequence_index: 7 },
  );
});

test("cellWirePair: a legacy flat row maps to the benchmark_id alone", () => {
  assert.deepEqual(cellWirePair("cumulative", "memoryOFF/cell-0000"), {
    run_dir: "cumulative",
    sequence_index: 0,
  });
});

test("cellWirePair: an archived row keeps the backups/ prefix in run_dir", () => {
  assert.deepEqual(
    cellWirePair("backups", "1790015745/1790004579/local/omlx/model/memoryOFF/cell-0012"),
    { run_dir: "backups/1790015745/1790004579/local/omlx/model", sequence_index: 12 },
  );
});

test("cellWirePair: a cell name with no index addresses nothing", () => {
  assert.equal(cellWirePair("1790015745", "local/omlx/model/memoryOFF/cell-abc"), null);
  // No arm segment between the run_dir and the cell name → no run_dir to send.
  assert.equal(cellWirePair("1790015745", "cell-0000"), null);
  assert.equal(cellWirePair("1790015745", ""), null);
  assert.equal(cellWirePair(null, null), null);
});
