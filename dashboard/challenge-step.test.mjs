// The challenge step sits between the model and the confirmation, and a
// baseline cannot be launched without one.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const create = readFileSync(join(HERE, "panels", "create.js"), "utf8");

test("STEPS: the sequence is kind -> model -> challenge -> confirm", () => {
  assert.match(create, /NEXT_BASE = \{ b1: "b2", b2: "bc", bc: "b3"/);
  assert.match(create, /BACK_BASE = \{ b2: "b1", bc: "b2", b3: "bc" \}/);
  // Dev mode splices the seed step in BEFORE the challenge, so the challenge is
  // the last thing chosen either way.
  assert.match(create, /NEXT_DEV = \{ \.\.\.NEXT_BASE, b2: "b2s", b2s: "bc" \}/);
});

test("STEPS: the frames are numbered as the operator counts them", () => {
  // Inserting a step renumbered the two after it; a stale label would have the
  // dialog counting 1, 2, 3, 3.
  assert.match(create, /step: "BASELINE · 3",\n\s+branch: "start new baseline",\n\s+title: "Pick the challenge"/);
  assert.match(create, /step: isOn \? "RUN · 1" : "BASELINE · 4"/);
  assert.match(create, /step: "BASELINE · 5"/);
});

test("LAUNCH: the chosen challenge rides the payload", () => {
  assert.match(create, /if \(ui\.challenge\) payload\.challenge = ui\.challenge;/);
});

test("LAUNCH: a new sequence never inherits the last one's challenge", () => {
  const open = create.slice(create.indexOf("export function openCreate()"));
  assert.match(open.slice(0, 400), /ui\.challenge = null;/);
});

test("PICKER: only a runnable challenge is clickable", () => {
  const panel = readFileSync(join(HERE, "panels", "challenge.js"), "utf8");
  assert.match(panel, /const attr = c\.ready \? ` data-create-challenge=/);
  assert.match(panel, /blocked_reason/);
});
