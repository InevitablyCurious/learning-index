// Every board request is same-origin: the dashboard relays /api/* to the
// control plane. No panel may build URLs from a stored address — that is how
// a dozen panels once went blank when the address became "".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function stubDom() {
  globalThis.document = { getElementById: () => ({ innerHTML: "", hidden: false }) };
}

test("the live panel fetches the backend feed same-origin", async () => {
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
  renderLive({ control: {}, run: {}, events: null });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, ["/api/backend-feed"]);
});

test("no board code builds a URL from a stored control address", async () => {
  const files = ["board.js", "board-actions.js", "history.js"];
  for (const dir of ["panels", "panels/live"]) {
    for (const f of await readdir(join(HERE, dir))) if (f.endsWith(".js")) files.push(`${dir}/${f}`);
  }
  const bad = [];
  for (const rel of files) {
    const src = await readFile(join(HERE, rel), "utf8");
    if (/\$\{\w+\}\/api\//.test(src) || /base_url/.test(src)) bad.push(rel);
  }
  assert.deepEqual(bad, []);
});
