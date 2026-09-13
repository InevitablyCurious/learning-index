// A PANEL THAT FETCHES MUST READ THE BASE URL OFF THE REAL BOARD SHAPE.
//
// `renderLive` called `maybeRefreshBackend(board.base)`. No board object has
// `.base` — the control plane's URL lives at `board.control.base_url`, which is
// what the ledger's stats strip reads. So the guard `if (!base) return` fired on
// every render, the fetch never happened, and the BACKEND FEED tab showed
// "no backend records yet" for the whole of a live run while `/api/backend-feed`
// was serving eleven rows correctly.
//
// IT SURVIVED A MANUAL CHECK because that check stubbed the board with the shape
// the panel expected (`{ base: "http://x" }`) rather than the shape the board
// actually has. A fixture that agrees with the bug cannot see it — so these
// tests build the board from the SAME accessor path the shipping panels use.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The board shape the control plane actually produces, minimally. */
function realBoard(baseUrl) {
  return { control: { base_url: baseUrl }, run: {}, events: null };
}

function stubDom() {
  const store = {};
  globalThis.document = {
    getElementById: (id) =>
      (store[id] ??= {
        _h: "",
        hidden: false,
        set innerHTML(v) {
          this._h = v;
        },
        get innerHTML() {
          return this._h;
        },
      }),
  };
  return store;
}

test("the live panel fetches the backend feed off board.control.base_url", async () => {
  stubDom();
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return {
      ok: true,
      json: async () => ({ ok: true, rows: [], errors: [], errors_total: 0, total: 0, returned: 0, windowed: false, sources: null }),
    };
  };

  const { renderLive } = await import("./panels/live.js");
  renderLive(realBoard("http://127.0.0.1:7718"));
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(
    seen,
    ["http://127.0.0.1:7718/api/backend-feed"],
    "the panel must fetch, and from the base the board actually carries",
  );
});

test("no run means no fetch, and no crash", async () => {
  // An idle board has no control plane URL. The guard is correct; what was wrong
  // was that it fired ALWAYS because the accessor was wrong.
  stubDom();
  let called = 0;
  globalThis.fetch = async () => {
    called += 1;
    return { ok: true, json: async () => ({}) };
  };
  const { renderLive } = await import("./panels/live.js");
  renderLive({ run: {}, events: null });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(called, 0);
});

test("every panel that fetches reads the base from the same place", async () => {
  // The accessor is duplicated across panels by necessity — each fetches on its
  // own. Two spellings of "where is the control plane" is how one of them ends up
  // reading a key nothing sets, which is exactly what happened here.
  const files = ["panels/live.js", "panels/ledger.js"];
  /** @type {Record<string,string[]>} */
  const wrong = {};
  for (const rel of files) {
    const src = await readFile(join(HERE, rel), "utf8");
    if (!/\bfetch\(/.test(src)) continue;
    // Any `board.<something>` handed to a refresh helper must be the known path.
    const bad = [...src.matchAll(/maybeRefresh\w*\(\s*(board[^)]*)\)/g)]
      .map((m) => m[1].trim())
      .filter((expr) => !/^board\?\.control\?\.base_url$/.test(expr));
    if (bad.length) wrong[rel] = bad;
  }
  assert.deepEqual(
    wrong,
    {},
    `these panels resolve the control-plane URL by a different path — one of ` +
      `them is reading a key nothing sets:\n${JSON.stringify(wrong, null, 2)}`,
  );
});
