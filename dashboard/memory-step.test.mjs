// BASELINE · 3 — THE MEMORY BACKEND STEP.
//
// Run 1788848333 went out with the record mandate unwired. The seam did exactly
// what it promised — an unset variable means "no memory layer", so it seeded the
// neutral notes and said nothing — and the cell ran to completion with the model
// never told to record anything. The empty result was indistinguishable from a
// real finding about the memory system.
//
// That is not fixable by making the adapter louder: a bare bench legitimately
// runs with no memory layer, so "unset" cannot be an error there. It is fixable
// on this frame, because choosing a backend here is the operator DECLARING that
// one is supposed to be plugged in.
//
// Every test below is a property of that.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  openCreate,
  closeCreate,
  createStep,
  createForward,
  createBack,
  setCreateModel,
  setCreateMemory,
  createMemoryBackend,
  verifyMemoryBackend,
  renderCreate,
} from "./panels/create.js";

/** Walk the plain (non-dev) sequence from the top. */
function toMemoryStep() {
  openCreate();
  createForward(false); // b1 -> b2
  createForward(false); // b2 -> b2m
  return createStep();
}

test("SEQUENCE: the memory step sits between the model and the confirmation", () => {
  assert.equal(toMemoryStep(), "b2m", "after the model, before the confirmation");
  createForward(false);
  assert.equal(createStep(), "b3", "and it leads to the confirmation");
  createBack(false);
  assert.equal(createStep(), "b2m", "back from the confirmation returns here, not to the model");
  closeCreate();
});

test("SEQUENCE: the dev seed step does not displace it", () => {
  // Under dev mode the sequence gains b2s. The memory step must still be the
  // last thing before the confirmation — it is the last frame that is free.
  openCreate();
  createForward(true); // b1 -> b2
  createForward(true); // b2 -> b2s
  assert.equal(createStep(), "b2s");
  createForward(true); // b2s -> b2m
  assert.equal(createStep(), "b2m");
  createForward(true);
  assert.equal(createStep(), "b3");
  createBack(true);
  assert.equal(createStep(), "b2m");
  createBack(true);
  assert.equal(createStep(), "b2s", "back from memory returns to the seed step under dev mode");
  closeCreate();
});

test("DEFAULT: a fresh sequence has NO backend picked", () => {
  toMemoryStep();
  assert.equal(createMemoryBackend(), null, "nothing is assumed; the operator declares it");
  closeCreate();
});

test("NONE IS A CHOICE, and it is reachable", () => {
  // Every bench runs with no memory layer out of the box. A chooser that only
  // offered backends would make the default configuration unreachable — and,
  // worse, unspoken.
  toMemoryStep();
  setCreateMemory("tokp");
  assert.equal(createMemoryBackend(), "tokp");
  setCreateMemory("");
  assert.equal(createMemoryBackend(), null, "the empty id means 'none', not 'unchanged'");
  const html = renderCreate({ models_ledger: null });
  assert.match(html, /data-create-memory=""/, "the none row must be clickable");
  closeCreate();
});

test("A VERDICT BELONGS TO THE BACKEND IT MEASURED", async () => {
  // Leaving a green verdict standing under a freshly-picked backend is the most
  // expensive thing this frame could do: it would say "verified" about something
  // nobody checked.
  toMemoryStep();
  setCreateMemory("tokp");

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => ({ ok: true, verdict: "go", blocking_failures: 0, checks: [], applied_env: { A: "1" } }),
  });
  try {
    await verifyMemoryBackend("http://x");
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.match(renderCreate({ models_ledger: null }), /WIRED/, "the pass verdict renders");
  setCreateMemory("");
  assert.doesNotMatch(
    renderCreate({ models_ledger: null }),
    /WIRED/,
    "changing the backend must discard the verdict",
  );
  closeCreate();
});

test("A REFUSAL IS SHOWN AS A REFUSAL, not as a failed verdict", async () => {
  // "Could not ask" and "asked, and the answer was no" send an operator to
  // different places, so they must not render the same.
  toMemoryStep();
  setCreateMemory("tokp");

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 400,
    json: async () => ({ ok: false, code: "unknown_backend", reason: "no memory backend named 'tokp'" }),
  });
  try {
    await verifyMemoryBackend("http://x");
  } finally {
    globalThis.fetch = realFetch;
  }

  const html = renderCreate({ models_ledger: null });
  assert.match(html, /no memory backend named/, "the server's own words, verbatim");
  assert.match(html, /RETRY/, "a refusal offers the retry, not a verdict");
  assert.doesNotMatch(html, /NOT WIRED/, "a refusal is not a negative verdict");
  closeCreate();
});

test("A TRANSPORT FAILURE NEVER READS AS 'NOT WIRED'", async () => {
  toMemoryStep();
  setCreateMemory("tokp");

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("connection refused"); };
  try {
    await verifyMemoryBackend("http://x");
  } finally {
    globalThis.fetch = realFetch;
  }

  const html = renderCreate({ models_ledger: null });
  assert.match(html, /could not reach the control plane/);
  assert.doesNotMatch(html, /NOT WIRED/, "an unreachable control plane says nothing about the backend");
  closeCreate();
});

test("THE APPLIED ENVIRONMENT IS SHOWN AS VALUES", async () => {
  // A name tells an operator nothing they did not already assume. The path is
  // what catches a stale or renamed mandate file before it costs a run — which
  // is the entire lesson of 1788848333.
  toMemoryStep();
  setCreateMemory("tokp");

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => ({
      ok: true,
      verdict: "go",
      blocking_failures: 0,
      checks: [{ name: "seeded AGENTS.md carries it", status: "pass", detail: "" }],
      applied_env: { BENCH_AGENTS_AUX_FILE: "/plugins/tokp-record-mandate.md" },
    }),
  });
  try {
    await verifyMemoryBackend("http://x");
  } finally {
    globalThis.fetch = realFetch;
  }

  const html = renderCreate({ models_ledger: null });
  assert.match(html, /BENCH_AGENTS_AUX_FILE/);
  assert.match(html, /tokp-record-mandate\.md/, "the VALUE, not just the variable name");
  closeCreate();
});

test("NOTHING HERE BLOCKS — an unverified backend still advances", () => {
  // The operator may be deliberately measuring what an unwired backend does.
  // What the frame guarantees is that nobody reaches the confirmation without
  // having been told; it does not get to decide the run.
  toMemoryStep();
  setCreateMemory("tokp");
  const html = renderCreate({ models_ledger: null });
  assert.match(html, /Verify before continuing/, "the warning is loud");
  createForward(false);
  assert.equal(createStep(), "b3", "and the sequence still advances");
  closeCreate();
});

test("A NEW SEQUENCE NEVER INHERITS THE LAST ONE'S BACKEND", () => {
  toMemoryStep();
  setCreateMemory("tokp");
  assert.equal(createMemoryBackend(), "tokp");
  closeCreate();

  toMemoryStep();
  assert.equal(createMemoryBackend(), null, "a backend is declared per run, never carried forward");
  closeCreate();
});

test("THE MODEL PICKER STILL WORKS WITH THE STEP SPLICED IN", () => {
  // Guards the splice itself: a mis-wired step map is invisible until someone
  // walks the whole sequence.
  openCreate();
  createForward(false);
  setCreateModel("some-model");
  createForward(false);
  assert.equal(createStep(), "b2m");
  closeCreate();
});
