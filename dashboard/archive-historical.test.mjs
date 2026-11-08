// ─────────────────────────────────────────────────────────────────────────────
// ARCHIVE HISTORICAL — the drawer's manual verb for pre-v2 runs
//
// Three facts this file pins:
//
//  1. THE COUNT IS THE BOARD'S. The button reads `runs.counts.legacy` off the
//     stream frame — never a local tally — and renders (0) DISABLED before the
//     first frame arrives, so "not yet known" can never read as "something to
//     move". The button stays visible at (0): the state is legible.
//
//  2. ONE PRESS = ONE POST, same-origin, to /api/archive/historical. There is no
//     confirm step here (the drawer has none, and nothing is deleted), so the
//     verb itself is asserted: one request, method POST, and the answer shown in
//     the drawer in the server's own words.
//
//  3. A SUCCESSFUL MOVE REFRESHES THE BOARD. The count on the button and the
//     cards both come from the stream, so the handler resubscribes — after the
//     verb's answer, and only when it succeeded. That ordering is asserted from
//     the handler source: `board-actions.js` needs a live board binding, which
//     only the SSE stream assigns, so the ordering is checked where it lives
//     rather than by fabricating a board no test can legitimately produce.
//
// The verb test mocks `globalThis.fetch`; it never reaches a live endpoint.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const { openTools, renderToolsDrawer, archiveHistorical } = await import("./panels/tools.js");

/** A board frame carrying only what the archive section reads. */
function board(legacy) {
  return { run: {}, control: {}, sources: [], runs: { list: [], counts: { legacy } } };
}

const drawer = (b) => {
  openTools();
  return renderToolsDrawer(b);
};

/** The one button this section emits, as source text. */
function archiveButton(html) {
  const m = html.match(/<button[^>]*data-archive-historical="1"[^>]*>Archive Historical \((\d+)\)<\/button>/);
  assert.ok(m, "the drawer does not render the ARCHIVE button");
  return m[0];
}

// ── the rendered control ────────────────────────────────────────────────────

test("ARCHIVE: the label carries the board's legacy count", () => {
  const html = drawer(board(7));
  const button = archiveButton(html);
  assert.match(button, />Archive Historical \(7\)</);
  assert.ok(!/\bdisabled\b/.test(button), "a non-zero count must be pressable");
});

test("ARCHIVE: the button is red — the existing destroy grammar, no new class", () => {
  const button = archiveButton(drawer(board(7)));
  assert.match(button, /\bclass="[^"]*\bdestroy\b/, "the button must use .btn.destroy");
});

test("ARCHIVE: zero — and a board that has not arrived — render (0) disabled", () => {
  for (const b of [board(0), null, {}]) {
    const button = archiveButton(drawer(b));
    assert.match(button, />Archive Historical \(0\)</, `count must fall back to 0 for ${JSON.stringify(b)}`);
    assert.match(button, /\bdisabled\b/, `(0) must be disabled for ${JSON.stringify(b)}`);
  }
});

// ── the verb ────────────────────────────────────────────────────────────────

test("ARCHIVE: one press POSTs the archive route and shows what moved", async () => {
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), opts });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, moved: 3, skipped: 1, archive_root: "/tmp/runs-archive" }),
    };
  };

  const moved = await archiveHistorical();

  assert.equal(moved, true, "a successful verb reports success to its caller");
  assert.equal(seen.length, 1, "the press must hit the control plane exactly once");
  assert.equal(seen[0].url, "/api/archive/historical");
  assert.equal(seen[0].opts.method, "POST");
  assert.match(seen[0].opts.headers["content-type"], /application\/json/);
  assert.deepEqual(JSON.parse(seen[0].opts.body), {});

  // The answer is on screen, in the drawer, in the server's own numbers.
  const html = renderToolsDrawer(board(0));
  assert.match(html, /moved 3/);
  assert.match(html, /skipped 1/);
});

test("ARCHIVE: a refusal is reported, not counted as a success", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, code: "runs_root_unwritable", reason: "the runs root is read-only" }),
  });

  const moved = await archiveHistorical();

  assert.equal(moved, false);
  const html = renderToolsDrawer(board(0));
  assert.match(html, /the runs root is read-only/, "the server's reason must reach the drawer");
  assert.ok(!/moved /.test(html), "a refusal must not leave a stale 'moved' line");
});

// ── the wiring ──────────────────────────────────────────────────────────────

test("ARCHIVE: the delegated click reaches the button and calls the handler", async () => {
  const src = await readFile(join(HERE, "board.js"), "utf8");
  const sel = src.match(/const t = e\.target\.closest\(\s*"([^"]+)"\s*\)/);
  assert.ok(sel, "could not find the delegated closest() selector in board.js");
  assert.ok(
    sel[1].includes("[data-archive-historical]"),
    "the button's attribute is missing from the closest() selector — it would render and do nothing",
  );

  const onClick = src.slice(src.indexOf("function onClick("));
  assert.match(
    onClick,
    /hasAttribute\("data-archive-historical"\)[\s\S]{0,200}doArchiveHistorical\(\)/,
    "no onClick branch resolves the ARCHIVE button to its handler",
  );
});

test("ARCHIVE: the handler refreshes the stream after a successful move, and not after a refusal", async () => {
  const src = await readFile(join(HERE, "board-actions.js"), "utf8");
  const start = src.indexOf("export async function doArchiveHistorical()");
  assert.notEqual(start, -1, "doArchiveHistorical is missing");
  const end = src.indexOf("export async function", start + 1);
  const body = src.slice(start, end === -1 ? undefined : end);

  assert.match(body, /controlReachability\(board\)/, "the write path must re-check reachability on click");
  const post = body.indexOf("await archiveHistorical()");
  const refresh = body.indexOf("resubscribe()");
  assert.notEqual(post, -1, "the handler never calls the verb");
  assert.notEqual(refresh, -1, "the handler never refreshes the board — a moved run would stay on screen");
  assert.ok(refresh > post, "the refresh must follow the verb's answer");
  assert.match(body, /if \(moved\) resubscribe\(\)/, "a refused verb changed nothing; it must not refresh");
});
