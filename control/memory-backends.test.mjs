// MEMORY BACKENDS — the plug-in registry.
//
// This bench is public: anyone plugs their own memory system in. The contract
// only holds if a backend's name appears in exactly one place, and if the
// service can say what environment a run with that backend will actually get.
//
// Everything here is a property of run 1788848333, which went out with the
// record mandate unwired. Nothing was broken; nothing was wired; the cell ran
// to completion with the model never told to record anything, and the empty
// result was indistinguishable from a real finding. The registry exists so the
// service can resolve that environment itself instead of trusting a shell.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listMemoryBackends, memoryBackend, memoryBackendEnv } from "./memory-backends.mjs";

/** A plugin tree with the mandate present, as a real installation has. */
function wiredTree() {
  const root = mkdtempSync(join(tmpdir(), "okp-plugin-"));
  mkdirSync(join(root, "plugins"), { recursive: true });
  writeFileSync(join(root, "plugins", "tokp-record-mandate.md"), "Record as you go.\n");
  return root;
}

function withPluginDir(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, "BENCH_PLUGIN_DIR");
  const prev = process.env.BENCH_PLUGIN_DIR;
  if (value === null) delete process.env.BENCH_PLUGIN_DIR;
  else process.env.BENCH_PLUGIN_DIR = value;
  try {
    return fn();
  } finally {
    if (had) process.env.BENCH_PLUGIN_DIR = prev;
    else delete process.env.BENCH_PLUGIN_DIR;
  }
}

test("REGISTRY: the board never carries its own copy of the list", () => {
  const list = listMemoryBackends();
  assert.ok(list.length >= 1, "at least one backend must be offerable");
  for (const b of list) {
    assert.equal(typeof b.id, "string");
    assert.ok(b.id.length > 0);
    assert.ok(b.label, `${b.id} needs a label an operator can read`);
    assert.ok(b.blurb, `${b.id} needs to say what it does`);
  }
  // Data only. A backend's env() is resolved server-side and must never be
  // shipped as part of the list — the board would then hold a second, stale
  // opinion of what a run gets.
  assert.ok(list.every((b) => !("env" in b)));
});

test("REGISTRY: an unknown id is null, never a guess", () => {
  assert.equal(memoryBackend("mem0"), null);
  assert.equal(memoryBackend(""), null);
  assert.equal(memoryBackend(undefined), null);
  assert.equal(memoryBackend(null), null);
});

test("REGISTRY: an unknown id resolves to an EMPTY env, and does not throw", () => {
  // A run with no memory layer is a real configuration — every bench does it out
  // of the box — so this lookup must answer rather than refuse. Preflight is
  // where "no memory layer" becomes a verdict.
  assert.deepEqual(memoryBackendEnv("hindsight"), {});
  assert.deepEqual(memoryBackendEnv(""), {});
});

test("TOKP: with a plugin tree, the env names the mandate BY PATH", () => {
  const root = wiredTree();
  withPluginDir(root, () => {
    const env = memoryBackendEnv("tokp");
    assert.equal(env.BENCH_PLUGIN_DIR, root, "the run sees the same tree the control plane has");
    assert.equal(
      env.BENCH_AGENTS_AUX_FILE,
      join(root, "plugins", "tokp-record-mandate.md"),
      "the mandate is resolved to a path, because the path is the whole fact",
    );
  });
});

test("TOKP: a tree WITHOUT the mandate omits the key rather than pointing at nothing", () => {
  // The adapter's seam ABORTS on a declared-but-unreadable path. Handing it one
  // would turn a misconfiguration into a crashed run instead of a preflight
  // refusal — the failure would move later and cost more.
  const root = mkdtempSync(join(tmpdir(), "okp-plugin-bare-"));
  mkdirSync(join(root, "plugins"), { recursive: true });
  withPluginDir(root, () => {
    const env = memoryBackendEnv("tokp");
    assert.equal(env.BENCH_PLUGIN_DIR, root);
    assert.ok(!("BENCH_AGENTS_AUX_FILE" in env), "no key beats a key pointing at a missing file");
  });
});

test("TOKP: with no plugin tree at all the env is empty, not partial", () => {
  withPluginDir(null, () => {
    assert.deepEqual(memoryBackendEnv("tokp"), {});
  });
});
