// ─────────────────────────────────────────────────────────────────────────────
// SEAM TOOLS TESTS — split VERBATIM from control/control.test.mjs
// (lines 4307–4571; withStatsManifest moved to stats.test.mjs).
// NOTE: dynamic import("./runstate.mjs") and import("./tools.mjs") specifiers
// shifted to "../…" — they resolve relative to THIS module; everything else
// is byte-identical.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HERE, BENCH } from "./_shared.mjs";

test("RUNSTATE: `running` is published and agrees with `state`", async () => {
  const { readRunState } = await import("../runstate.mjs");
  const root = mkdtempSync(join(tmpdir(), "okp-runstate-"));
  try {
    const idle = await readRunState({ runsRoot: root, launcher: null });
    assert.equal(
      Object.hasOwn(idle, "running"),
      true,
      "readRunState must publish `running` — four callers in server.mjs read it",
    );
    assert.equal(typeof idle.running, "boolean", "`running` must be a boolean, never undefined");
    assert.equal(
      idle.running,
      !idle.can_start,
      "`running` and `can_start` are the same fact and must never disagree",
    );
    // A live cell is the case that mattered: an undefined here is what made
    // STOP refuse and the substrate guard fall open.
    assert.equal(idle.running, false, "an empty runs root has no cell in flight");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The stop path's container filters must track the names the harness actually
// creates. A stale prefix here is silent: stop reports success and leaves the
// sidecar running, and the next cell contends with it.
test("STOP sweeps the egress sidecar the harness actually names", async () => {
  // The stop path moved from server.mjs to lib/lifecycle.mjs (LI-14 phase 1).
  const src = readFileSync(join(HERE, "lib", "lifecycle.mjs"), "utf8");
  const py = readFileSync(join(HERE, "..", "harness", "egress.py"), "utf8");
  const prefix = /f"([a-z0-9-]+-)\{hashlib/.exec(py);
  assert.ok(prefix, "egress.py must still build the sidecar name from a literal prefix");
  assert.ok(
    src.includes(`name=${prefix[1]}`),
    `the stop filter must use the harness's own prefix '${prefix[1]}'`,
  );
  assert.ok(!src.includes("name=wv-egress-"), "the pre-rename prefix must not linger in the stop path");
});

// ── THE DEV-SHIM SEAM ───────────────────────────────────────────────────────
//
// Tools that serve the iterate-on-the-bench loop live in dev/, not here, and
// attach through BENCH_TOOLS_MANIFEST. These pin both sides of that: a
// clone of bench/ ALONE must be clean, and an attached manifest must never be
// able to reach machinery it has no business in.

test("SEAM: a clone of bench/ alone contributes no external tools", async () => {
  // The whole reason the manifest exists. Declaring dev tools in the registry
  // would put contributor orchestration into the repo people clone to measure
  // their own memory system, and a tool permanently "blocked because ../dev is
  // missing" is worse than no tool — it advertises what the clone cannot do.
  const { describeTools } = await import("../tools.mjs");
  const saved = process.env.BENCH_TOOLS_MANIFEST;
  delete process.env.BENCH_TOOLS_MANIFEST;
  try {
    const tools = describeTools(BENCH);
    assert.ok(tools.length > 0, "the built-in tools must still be there");
    assert.equal(
      tools.filter((t) => t.external).length,
      0,
      "an unset manifest must contribute nothing at all",
    );
    assert.ok(
      !tools.some((t) => t.id === "external-tools"),
      "an unset manifest is not an error and must not render a blocked row",
    );
  } finally {
    if (saved === undefined) delete process.env.BENCH_TOOLS_MANIFEST;
    else process.env.BENCH_TOOLS_MANIFEST = saved;
  }
});

test("SEAM: a broken manifest is REPORTED, never silently skipped", async () => {
  // Returning [] would make a typo in the path indistinguishable from a
  // manifest that legitimately declares nothing — the operator would go looking
  // for their tool and find no trace of why it is absent.
  const { describeTools } = await import("../tools.mjs");
  const saved = process.env.BENCH_TOOLS_MANIFEST;
  const dir = mkdtempSync(join(tmpdir(), "okp-tools-"));
  try {
    process.env.BENCH_TOOLS_MANIFEST = join(dir, "absent.json");
    let row = describeTools(BENCH).find((t) => t.id === "external-tools");
    assert.ok(row, "a missing manifest must surface as a named blocked row");
    assert.equal(row.status, "blocked");
    assert.match(row.blocked_reason, /cannot read/);

    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json", "utf8");
    process.env.BENCH_TOOLS_MANIFEST = bad;
    row = describeTools(BENCH).find((t) => t.id === "external-tools");
    assert.equal(row.status, "blocked");

    const noTools = join(dir, "empty.json");
    writeFileSync(noTools, JSON.stringify({ schema_version: 1 }), "utf8");
    process.env.BENCH_TOOLS_MANIFEST = noTools;
    row = describeTools(BENCH).find((t) => t.id === "external-tools");
    assert.match(row.blocked_reason, /no "tools" array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.BENCH_TOOLS_MANIFEST;
    else process.env.BENCH_TOOLS_MANIFEST = saved;
  }
});

test("SEAM: a manifest cannot redefine a built-in, and cannot reach mcp-admin", async () => {
  // TWO LIMITS, BOTH DELIBERATE. `mcp-admin` runs as the BENCH IDENTITY against
  // the leader keystore; identity-bearing handlers stay in the bench repo where
  // they can be reviewed. And a manifest must not be able to make
  // `worker-image-rebuild` mean something else on one installation.
  const { describeTools, toolRegistry } = await import("../tools.mjs");
  const saved = process.env.BENCH_TOOLS_MANIFEST;
  const dir = mkdtempSync(join(tmpdir(), "okp-tools-"));
  try {
    const manifest = join(dir, "tools.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        tools: [
          { id: "worker-image-rebuild", name: "hijack", command: "/bin/echo" },
          { id: "sneaky", name: "sneaky", command: "/bin/echo", invoke: { kind: "mcp-admin" } },
        ],
      }),
      "utf8",
    );
    process.env.BENCH_TOOLS_MANIFEST = manifest;

    const registry = toolRegistry(BENCH);
    const builtin = registry.filter((t) => t.id === "worker-image-rebuild");
    assert.equal(builtin.length, 1, "the built-in must survive intact");
    assert.match(
      String(builtin[0].invoke.argv[0] ?? ""),
      /rebuild_worker_image\.py$/,
      "the built-in must not be replaced",
    );

    const collision = describeTools(BENCH).find(
      (t) => t.id === "worker-image-rebuild-external",
    );
    assert.equal(collision.status, "blocked");
    assert.match(collision.blocked_reason, /built-in/);

    const sneaky = registry.find((t) => t.id === "sneaky");
    assert.equal(
      sneaky.invoke.kind,
      "script",
      "an external tool is FORCED onto the generic script runner — it must never select mcp-admin",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.BENCH_TOOLS_MANIFEST;
    else process.env.BENCH_TOOLS_MANIFEST = saved;
  }
});

test("SEAM: the dev manifest that ships in this workspace is valid and wires up", async () => {
  // The manifest lives in dev/, so this is skipped in a bench-only checkout
  // rather than failing — which is the seam working as designed.
  const manifest = join(BENCH, "..", "dev", "bench-tools.json");
  if (!existsSync(manifest)) return;

  const { describeTools } = await import("../tools.mjs");
  const saved = process.env.BENCH_TOOLS_MANIFEST;
  process.env.BENCH_TOOLS_MANIFEST = manifest;
  try {
    // bench-mcp-restart lives here too: it drives ../dev/scripts/bench-mcp.sh,
    // so declaring it as a built-in put a permanently blocked row advertising
    // dev/ on the board of anyone who cloned bench alone.
    const mcp = describeTools(BENCH).find((t) => t.id === "bench-mcp-restart");
    assert.ok(mcp, "dev/bench-tools.json must contribute bench-mcp-restart");
    assert.equal(mcp.external, true, "the bench MCP supervisor is a dev shim, not a built-in");

    const ready = describeTools(BENCH).find((t) => t.id === "bench-ready");
    assert.ok(ready, "dev/bench-tools.json must contribute bench-ready");
    assert.equal(ready.external, true, "a contributed tool must be marked as one");
    assert.equal(
      ready.status,
      "wired",
      `bench-ready is blocked: ${ready.blocked_reason}`,
    );
    assert.equal(
      ready.refuse_while_running,
      true,
      "converging the substrate mid-cell would change what is being measured",
    );
    assert.ok(ready.seams.length >= 3, "an operator must be able to see what it will do");
  } finally {
    if (saved === undefined) delete process.env.BENCH_TOOLS_MANIFEST;
    else process.env.BENCH_TOOLS_MANIFEST = saved;
  }
});

// ── A TOOL REPORTS ITS OWN OUTCOME ──────────────────────────────────────────
//
// THE MEASURED DEFECT (2026-09-03). The drawer's success block hardcoded
// request-join's vocabulary, so every tool that succeeded rendered "SENT — the
// org's leader still has to accept it on their dashboard". A worker-image
// rebuild that ran a real ten-second docker build reported that it was waiting
// on a human to approve something, and the build log the control plane returns
// in full was thrown away. From the board there was no way to tell a working
// button from a dead one.
//
// Pinned on the SHAPE (the note is data on the tool, and output is rendered)
// rather than on any one string, because the bug was that one tool's words were
// structural.

test("TOOLS: the success caveat belongs to the tool, not to the drawer", async () => {
  const { describeTools } = await import("../tools.mjs");
  const saved = process.env.BENCH_TOOLS_MANIFEST;
  delete process.env.BENCH_TOOLS_MANIFEST;
  try {
    const tools = describeTools(BENCH);
    const join = tools.find((t) => t.id === "request-join");
    assert.match(
      String(join.success_note ?? ""),
      /accept/i,
      "request-join must carry its own 'submitted is not accepted' caveat",
    );
    for (const t of tools.filter((t) => t.id !== "request-join")) {
      assert.equal(
        t.success_note,
        null,
        `${t.id} must not inherit another tool's outcome line — its output is its report`,
      );
    }
  } finally {
    if (saved === undefined) delete process.env.BENCH_TOOLS_MANIFEST;
    else process.env.BENCH_TOOLS_MANIFEST = saved;
  }
});

test("TOOLS: the drawer renders the command's own output", () => {
  // The control plane returns stdout and stderr on success AND failure. A
  // drawer that drops them leaves an operator with a verdict and no evidence,
  // which is the state that made a successful rebuild look like nothing.
  const src = readFileSync(join(BENCH, "dashboard", "panels", "tools.js"), "utf8");
  assert.match(src, /r\.stdout/, "tools.js must render stdout");
  assert.match(src, /r\.stderr/, "tools.js must render stderr");
  assert.ok(
    !/leader still has to accept/.test(src),
    "one tool's outcome line must not be hardcoded in the drawer",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// STATS — the ledger footer's one numbers surface
//
// Two populations behind one route. The tests below pin the two properties the
// surface exists to hold: the zones stay separate, and a source that could not
// be reached never reads as a measured zero.
// ─────────────────────────────────────────────────────────────────────────────

/** Run `fn` with the stats manifest pointed at `path`, then put the env back. */

