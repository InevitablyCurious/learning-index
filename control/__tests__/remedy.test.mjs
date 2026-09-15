// ─────────────────────────────────────────────────────────────────────────────
// REMEDY TESTS — split VERBATIM from control/control.test.mjs (lines 4958–5066).
// NOTE: dynamic import("./tools.mjs") specifiers shifted to "../tools.mjs" —
// they resolve relative to THIS module; everything else is byte-identical.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { BENCH } from "./_shared.mjs";

test("SEAM: the dev stats manifest is valid and the relay loop counter stays retired", async () => {
  // The relay's loop-guard counter (id "relay-loop-fires", label "LOOP ERRORS")
  // read the relay's LIFETIME fire count — shared across ALL relay traffic, the
  // wrong number per benchmark — and is RETIRED. Per-benchmark LOOP/STREAM/
  // STALLED errors now come from the scorecard's error_totals (BENCHMARK zone).
  // This pins the retirement: the shared relay counter must not come back
  // through the CUSTOM seam. Skipped in a bench-only checkout (the seam is
  // dev-only). See dev/bench-stats.json.
  const manifest = join(BENCH, "..", "dev", "bench-stats.json");
  if (!existsSync(manifest)) return;
  const parsed = JSON.parse(readFileSync(manifest, "utf8"));
  assert.ok(Array.isArray(parsed.stats), "the manifest must carry a stats array");
  assert.ok(
    !parsed.stats.some((s) => s.id === "relay-loop-fires" || s.label === "LOOP ERRORS"),
    "the relay's shared loop-guard counter must stay retired from the CUSTOM zone",
  );
  for (const s of parsed.stats) {
    assert.ok(s.id && s.url && s.pick, "every entry needs id, url and pick");
    assert.deepEqual(
      Object.keys(s).filter((k) => !k.startsWith("//")).sort(),
      ["id", "label", "mode", "pick", "url"].filter((k) => k in s || k !== "mode").sort(),
      "a stat entry carries id, label, url, pick and optionally mode",
    );
    if ("mode" in s) assert.equal(s.mode, "delta", "delta is the only mode there is");
  }
});

// ── PREFLIGHT REFUSAL -> THE BUTTON THAT FIXES IT ────────────────────────────
//
// A refusal on the board used to end at "Fix what preflight named, then start
// again", and what preflight named was a shell command — so the board sent the
// operator to a terminal for something the board itself can do. Preflight now
// names the remedy by TOOL ID; this side turns that id into a button, because
// this side is the one that knows which tools exist here.

test("REMEDY: a failure's tool id resolves to the registry's own name and status", async () => {
  const { attachRemedies, describeTools } = await import("../tools.mjs");
  const registry = describeTools(BENCH);
  const rebuild = registry.find((t) => t.id === "worker-image-rebuild");
  assert.ok(rebuild, "worker-image-rebuild is a built-in and must be in the registry");

  const checks = [
    { name: "worker image", status: "fail", remedy_tool: "worker-image-rebuild" },
  ];
  attachRemedies(checks, registry);

  assert.equal(checks[0].remedy.id, "worker-image-rebuild");
  // THE REGISTRY'S NAME, not a copy. A second id->name table is exactly the
  // drift this seam exists to prevent.
  assert.equal(checks[0].remedy.name, rebuild.name);
  assert.equal(checks[0].remedy.status, rebuild.status);
  assert.equal(checks[0].remedy.refuse_while_running, true);
});

test("REMEDY: an id this installation does not have becomes null, never a button", async () => {
  // `bench-ready` and `bench-mcp-restart` are dev-contributed: a bare clone of
  // bench/ has neither. Rendering a button for a tool that is not registered
  // would refuse the moment it was pressed, which is worse than the words the
  // check already carries.
  const { attachRemedies } = await import("../tools.mjs");
  const checks = [{ name: "control plane", status: "fail", remedy_tool: "not-installed-here" }];
  attachRemedies(checks, []);
  assert.equal(checks[0].remedy, null);
});

test("REMEDY: a check with no remedy_tool is left completely alone", async () => {
  // Most failures have no button — a campaign slot to archive, a dead hub, a
  // roster that disagrees with itself. Those must not grow an empty `remedy`
  // key the board could mistake for "resolved to nothing".
  const { attachRemedies, describeTools } = await import("../tools.mjs");
  const checks = [{ name: "campaign slot", status: "fail" }, { name: "disk free", status: "pass" }];
  attachRemedies(checks, describeTools(BENCH));
  assert.ok(!("remedy" in checks[0]));
  assert.ok(!("remedy" in checks[1]));
});

test("SEAM: every remedy preflight can name is a real tool id somewhere", async () => {
  // THE CROSS-FILE CONTRACT, pinned. Preflight names tools by id in a Python
  // file; the registry defines them in JS. Nothing but this test connects the
  // two, and an id that matches nothing degrades SILENTLY to "no button" —
  // which looks exactly like a check that never had a remedy.
  const { toolRegistry } = await import("../tools.mjs");
  const src = readFileSync(join(BENCH, "scripts", "bench_preflight.py"), "utf8");
  const declared = [...src.matchAll(/^TOOL_[A-Z_]+ = "([a-z0-9-]+)"$/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 3, `preflight declares no remedy tool ids: ${declared}`);

  // The dev manifest is what contributes bench-ready/bench-mcp-restart, and it
  // is present in this workspace — so here, every declared id must resolve.
  const saved = process.env.BENCH_TOOLS_MANIFEST;
  process.env.BENCH_TOOLS_MANIFEST = join(BENCH, "..", "dev", "bench-tools.json");
  try {
    const ids = new Set(toolRegistry(BENCH).map((t) => t.id));
    for (const id of declared) {
      assert.ok(ids.has(id), `preflight names remedy tool "${id}" and nothing registers it`);
    }
  } finally {
    if (saved === undefined) delete process.env.BENCH_TOOLS_MANIFEST;
    else process.env.BENCH_TOOLS_MANIFEST = saved;
  }
});

// ── DEV MODE ─────────────────────────────────────────────────────────────────
//
// The mode is SERVER state: environment → state file → default OFF. A pinned
// environment makes the board's toggle a lie, so it publishes settable:false
// and the write REFUSES. A malformed setting reads OFF — the safe direction —
// but never as "nobody configured anything". env is injected as a parameter
// here; process.env is never touched.

