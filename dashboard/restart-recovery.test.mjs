// ─────────────────────────────────────────────────────────────────────────────
// RING-RESTART RECOVERY — the USER chip count and the filterable rows agree
//
// The USER chip counts the WHOLE ring (server metadata `counts.user`); the rows
// the filter can show are the client's accumulated window. Those two agree only
// while every `kind:"user"` row survives the window pipeline. A control-plane
// RESTART re-bases the ring's `seq` to 0, which used to strand re-admitted rows
// behind four monotonic seq watermarks — the chip said N, the filter showed
// fewer, and no click fixed it until a full browser refresh.
//
// The fix detects the restart (the ring's `cursor` counter falls) and resets
// every watermark, at all four layers. These tests pin the pure seams and the
// wiring the way event-window.test.mjs pins the pinning (source assertions —
// no DOM exists in this repo's test environment).
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ringRestarted, capWindow } from "./sources/control-plane.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFile(join(HERE, rel), "utf8");

/** Strip comments so a rule is never satisfied or broken by prose ABOUT it. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ── THE PURE RESTART PREDICATE ──────────────────────────────────────────────

test("ringRestarted detects a cursor that fell (a re-based ring)", () => {
  assert.equal(ringRestarted({ cursor: 4 }, 900), true);
});

test("ringRestarted ignores a cursor that grew or held steady", () => {
  assert.equal(ringRestarted({ cursor: 900 }, 4), false);
  assert.equal(ringRestarted({ cursor: 900 }, 900), false);
});

test("ringRestarted never fires without a cursor or before the first read", () => {
  assert.equal(ringRestarted({}, 900), false);
  assert.equal(ringRestarted({ cursor: 4 }, 0), false);
});

// ── THE USER CHIP COUNT AND THE FILTERABLE ROWS AGREE ───────────────────────

test("the USER chip count and the filterable rows agree for a mixed feed", () => {
  // The chip counts the WHOLE ring; the filter shows the window. Pinning must
  // keep every user row through the cap so the two never disagree for "user".
  const user = Array.from({ length: 4 }, (_, i) => ({ seq: i + 1, kind: "user" }));
  const agents = Array.from({ length: 600 }, (_, i) => ({ seq: 1000 + i, kind: "tool" }));
  const window = capWindow([...user, ...agents], 400);
  assert.equal(
    window.filter((r) => r.kind === "user").length,
    user.length,
    "every user row must survive the window cap (the chip's count == the rows the USER filter renders)",
  );
});

// ── THE RESTART WIRING, PINNED FROM SOURCE (all four layers) ────────────────

test("the source layer refetches from scratch when the ring re-bases", async () => {
  const src = code(await read("sources/control-plane.mjs"));
  assert.match(src, /ringRestarted\(data, eventCursor\)/);
  assert.match(src, /since=0/, "the restarting poll must refetch since=0, not advance past re-admitted rows");
});

test("the SSE proxy resets a per-client cursor that outruns the ring", async () => {
  const src = code(await read("server.mjs"));
  assert.match(src, /since > cursor/, "the tick loop must reset a stale per-client cursor");
  assert.match(src, /requested > ringCursor/, "the connect path must replay a stale reconnect from scratch");
});

test("the browser rebuilds (not splices) its window on a re-base", async () => {
  const src = code(await read("board.js"));
  assert.match(src, /cursor < eventCursor/, "the re-base is detected from the ring cursor falling");
  assert.match(src, /if \(rebased\) eventRows = \[\]/, "the stale window is discarded, never appended to");
});

test("the feed forces a full rebuild when the window's seq falls behind", async () => {
  const src = code(await read("panels/live.js"));
  assert.match(src, /< renderedSeq/, "the backward re-base is detected against the render watermark");
  assert.match(src, /stale = sig !== renderedSig \|\| wrapped \|\| rebased/, "rebased forces the full-rebuild branch");
});
