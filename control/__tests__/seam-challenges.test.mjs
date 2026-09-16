// The challenge list the run sequence is built on.
//
// A challenge is what the cell builds and what the gates grade. The list is
// read from the manifests on disk, and a challenge that cannot run is reported
// with its reason rather than hidden — a picker that silently omits the thing
// the operator just cloned sends them hunting through directories.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listChallenges, findChallenge } from "../challenges.mjs";
import { BENCH } from "./_shared.mjs";

test("CHALLENGES: the bundled example is listed and runnable", async () => {
  const list = await listChallenges(BENCH);
  const example = list.find((c) => c.id === "backgammon");
  assert.ok(example, `backgammon missing from ${list.map((c) => c.id).join(", ")}`);
  assert.equal(example.ready, true, example.blocked_reason ?? "");
  assert.equal(example.bundled, true);
  assert.ok(example.summary.length > 10, "a challenge says what it is");
});

test("CHALLENGES: the skeleton authors copy is never offered as one", async () => {
  // challenges/TEMPLATE has no starting files and no frozen fingerprint. Listing
  // it would put a dead option in the picker.
  const list = await listChallenges(BENCH);
  assert.ok(!list.some((c) => c.id === "TEMPLATE"));
});

test("CHALLENGES: one that cannot run is listed WITH the reason, not hidden", async () => {
  const root = await mkdtemp(join(tmpdir(), "bench-challenges-"));
  const dir = join(root, "challenges", "half-built");
  await mkdir(join(dir, "prompts"), { recursive: true });
  await writeFile(join(dir, "challenge.json"), JSON.stringify({ name: "half-built" }), "utf8");

  const list = await listChallenges(root);
  const found = list.find((c) => c.id === "half-built");
  assert.ok(found, "a half-built challenge must still be listed");
  assert.equal(found.ready, false);
  assert.match(found.blocked_reason, /scaffold/);
});

test("CHALLENGES: an unknown id resolves to nothing, for the caller to refuse", async () => {
  assert.equal(await findChallenge(BENCH, "chess"), null);
  assert.equal(await findChallenge(BENCH, ""), null);
});

test("SEAM: the launch refuses an unknown challenge and pins the campaign", async () => {
  // Both refusals are the validator's and the route's own words — pinned here
  // so a rename cannot quietly drop either.
  const { readFileSync } = await import("node:fs");
  const validate = readFileSync(join(BENCH, "control", "lib", "validate.mjs"), "utf8");
  assert.match(validate, /challenge_unknown/);
  assert.match(validate, /challenge_not_runnable/);
  const run = readFileSync(join(BENCH, "control", "routes", "run.mjs"), "utf8");
  assert.match(run, /challenge_pinned/);
  assert.match(run, /env\.BENCH_TASK_DIR = challenge\.dir/);
});
