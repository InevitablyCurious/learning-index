// EVERY CLICKABLE A PANEL EMITS MUST BE REACHABLE BY THE DELEGATED HANDLER.
//
// `board.js::onClick` is a single delegated listener. It resolves the clicked
// element with ONE `closest(...)` selector and returns immediately when nothing
// matches — so a control whose attribute is missing from that selector renders
// perfectly, looks interactive, and does nothing at all. There is no console
// error and no visual difference: the branch below simply never runs.
//
// This is exactly what happened to the BACKEND FEED tab. The handler HAD its
// branch (`if (t.dataset.feedtab) …`) and the button HAD its attribute, and the
// tab was still dead, because `closest` never returned it.
//
// Same failure shape as an unstyled class (see style-coverage.test.mjs): the
// thing appears present and carries no behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANELS = join(HERE, "panels");

/** The one delegation selector, read out of the source rather than restated. */
async function delegationSelector() {
  const src = await readFile(join(HERE, "board.js"), "utf8");
  const m = src.match(/const t = e\.target\.closest\(\s*"([^"]+)"\s*\)/);
  assert.ok(m, "could not find the delegated closest() selector in board.js");
  return m[1];
}

test("every branch CONDITION in the handler can actually match", async () => {
  // THE PRECISE ASSERTION, and the one that catches the real failure.
  //
  // `onClick` resolves the clicked element with ONE `closest(...)` selector and
  // returns immediately when nothing matches. A branch whose CONDITION tests an
  // attribute missing from that selector can therefore never run — the control
  // renders, looks interactive, and does nothing, with no console error and no
  // visual difference from a working one. That is exactly how the BACKEND FEED
  // tab shipped dead: the branch existed and the button carried its attribute,
  // so it read as wired in review.
  //
  // CONDITIONS ONLY, NOT EVERY READ. `if (t.dataset.runProfile)` is a matcher;
  // `model: t.dataset.runModel` inside that branch is a COMPANION, read off an
  // element already matched by a sibling attribute. Companions are correct and
  // must not be flagged — scanning every `t.dataset.*` reported three of them
  // (`preflight-fix-why`, `run-kind`, `run-model`) as dead when all three work.
  const src = await readFile(join(HERE, "board.js"), "utf8");
  const selector = await delegationSelector();
  const inSelector = new Set(
    [...selector.matchAll(/\[data-([a-z0-9-]+)\]/g)].map((m) => m[1]),
  );

  const dashed = (camel) => camel.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
  const onClick = src.slice(src.indexOf("function onClick("));
  const conditions = new Set(
    [...onClick.matchAll(/if\s*\(\s*t\.dataset\.([a-zA-Z0-9]+)/g)].map((m) => dashed(m[1])),
  );
  assert.ok(conditions.size > 5, "parsed suspiciously few branch conditions");

  const dead = [...conditions].filter((c) => !inSelector.has(c)).sort();
  assert.deepEqual(
    dead,
    [],
    `these branch conditions can never match, so their controls are inert:\n  ` +
      `${dead.join("\n  ")}\nAdd [data-…] for each to the closest() selector in board.js.`,
  );
});

test("no handler branch is written twice", async () => {
  // A duplicated branch is unreachable after the first `return`, and its presence
  // suggests an edit was applied twice — which is how it got there.
  const src = await readFile(join(HERE, "board.js"), "utf8");
  const onClick = src.slice(src.indexOf("function onClick("));
  const seen = new Map();
  for (const m of onClick.matchAll(/if \(t\.dataset\.([a-zA-Z0-9]+)[^\n]*\n/g)) {
    seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  const dupes = [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);
  assert.deepEqual(dupes, [], `duplicated handler branches: ${dupes.join(", ")}`);
});
