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

// ── CUSTOM TOOLS ────────────────────────────────────────────────────────────
//
// Custom tools reach the drawer only through a separate service at
// BENCH_TOOLS_URL (CUSTOM-TOOLS.md). These pin the benchmark's side of that: with
// no service it serves only its own tools; a service that cannot be read is
// REPORTED as one row; a service can neither redefine a built-in nor reach
// preflight; and running a custom tool forwards exactly its declared arguments
// and the service's own output. Each test runs its own throwaway service.

async function withToolsService(handler, fn) {
  const { createServer } = await import("node:http");
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const saved = process.env.BENCH_TOOLS_URL;
  process.env.BENCH_TOOLS_URL = url;
  try {
    return await fn(url);
  } finally {
    if (saved === undefined) delete process.env.BENCH_TOOLS_URL;
    else process.env.BENCH_TOOLS_URL = saved;
    await new Promise((r) => server.close(r));
  }
}

function readJson(req) {
  return new Promise((done) => {
    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", () => done(body ? JSON.parse(body) : {}));
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const SERVED = {
  id: "join-something",
  name: "Join something",
  blurb: "asks to be admitted",
  seams: ["one", "two"],
  args: [{ name: "org", label: "org id", required: true, default: "org-0", help: "which org" }],
  success_note: "Sent, NOT accepted",
  timeout_ms: 5000,
};

test("SEAM: with no custom-tools service the drawer serves only the benchmark's own tools", async () => {
  const { describeTools } = await import("../tools.mjs");
  const saved = process.env.BENCH_TOOLS_URL;
  delete process.env.BENCH_TOOLS_URL;
  try {
    const tools = await describeTools(BENCH);
    assert.deepEqual(tools.map((t) => t.id), [
      "worker-image-rebuild",
      "grader-image-rebuild",
      "control-restart",
      "board-rebuild",
    ]);
    assert.equal(tools.filter((t) => t.external).length, 0, "no service means no custom rows at all");
    for (const t of tools) assert.equal(t.success_note, null, "a built-in's own output is its report");
  } finally {
    if (saved === undefined) delete process.env.BENCH_TOOLS_URL;
    else process.env.BENCH_TOOLS_URL = saved;
  }
});

test("REFRESH: the control plane restarts itself only when launchd owns it", async () => {
  const { describeBuiltinTools } = await import("../tools.mjs");
  const saved = process.env.BENCH_LAUNCHD_LABEL;
  try {
    delete process.env.BENCH_LAUNCHD_LABEL;
    const byHand = describeBuiltinTools(BENCH).find((t) => t.id === "control-restart");
    assert.equal(byHand.status, "blocked", "a hand-started process has nothing to restart it");
    assert.match(byHand.blocked_reason, /started by hand/);

    process.env.BENCH_LAUNCHD_LABEL = "com.example.bench-control";
    const agent = describeBuiltinTools(BENCH).find((t) => t.id === "control-restart");
    assert.equal(agent.status, "wired");
    assert.equal(agent.refuse_while_running, true, "a restart would kill the running cell");
  } finally {
    if (saved === undefined) delete process.env.BENCH_LAUNCHD_LABEL;
    else process.env.BENCH_LAUNCHD_LABEL = saved;
  }
});

test("REFRESH: the board refresh is allowed during a run and reloads the page", async () => {
  const { describeBuiltinTools } = await import("../tools.mjs");
  const board = describeBuiltinTools(BENCH).find((t) => t.id === "board-rebuild");
  assert.equal(board.refuse_while_running, false, "the board is not part of the measurement");
  assert.equal(board.reload_page, true);
});

test("SEAM: a service that is down or off-contract is REPORTED, never silently skipped", async () => {
  const { describeTools } = await import("../tools.mjs");

  // Off-contract: answers, but with no tools array.
  await withToolsService((req, res) => sendJson(res, 200, { hello: true }), async (url) => {
    const row = (await describeTools(BENCH)).find((t) => t.id === "custom-tools");
    assert.ok(row, "an off-contract service must surface as a named blocked row");
    assert.equal(row.status, "blocked");
    assert.match(row.blocked_reason, /custom tools unavailable at/);
    assert.ok(row.blocked_reason.includes(url));
  });

  // Down: an address nothing listens on any more.
  let closedUrl = "";
  await withToolsService((req, res) => sendJson(res, 200, { tools: [] }), async (url) => { closedUrl = url; });
  const saved = process.env.BENCH_TOOLS_URL;
  process.env.BENCH_TOOLS_URL = closedUrl;
  try {
    const tools = await describeTools(BENCH);
    const row = tools.find((t) => t.id === "custom-tools");
    assert.equal(row.status, "blocked");
    assert.ok(row.blocked_reason.includes(closedUrl));
    assert.ok(tools.some((t) => t.id === "worker-image-rebuild"), "the built-ins are unaffected");
  } finally {
    if (saved === undefined) delete process.env.BENCH_TOOLS_URL;
    else process.env.BENCH_TOOLS_URL = saved;
  }
});

test("SEAM: served tools arrive with their own inputs and caveat, marked as custom", async () => {
  const { describeTools } = await import("../tools.mjs");
  await withToolsService((req, res) => sendJson(res, 200, { tools: [SERVED] }), async () => {
    const row = (await describeTools(BENCH)).find((t) => t.id === "join-something");
    assert.equal(row.status, "wired");
    assert.equal(row.external, true);
    assert.equal(row.args[0].name, "org");
    assert.equal(row.args[0].default, "org-0");
    assert.equal(row.success_note, "Sent, NOT accepted");
    assert.equal(row.refuse_while_running, true, "a tool that does not say otherwise is refused mid-cell");
  });
});

test("SEAM: a service cannot redefine a built-in", async () => {
  const { describeTools, toolRegistry } = await import("../tools.mjs");
  const hijack = { id: "worker-image-rebuild", name: "hijack", timeout_ms: 1 };
  await withToolsService((req, res) => sendJson(res, 200, { tools: [hijack] }), async () => {
    const builtin = (await toolRegistry(BENCH)).filter((t) => t.id === "worker-image-rebuild");
    assert.equal(builtin.length, 1, "the built-in must survive intact");
    assert.match(String(builtin[0].invoke.argv[0] ?? ""), /rebuild_worker_image\.py$/);
    const collision = (await describeTools(BENCH)).find((t) => t.id === "worker-image-rebuild-external");
    assert.equal(collision.status, "blocked");
    assert.match(collision.blocked_reason, /built-in/);
  });
});

test("SEAM: running a custom tool forwards only its declared arguments and the service's own output", async () => {
  const { invokeTool } = await import("../tools.mjs");
  let received = null;
  const handler = async (req, res) => {
    if (req.method === "GET") return sendJson(res, 200, { tools: [SERVED] });
    received = await readJson(req);
    sendJson(res, 200, { ok: false, code: "exit_2", reason: "the hub refused", stdout: "out", stderr: "err" });
  };
  await withToolsService(handler, async () => {
    const out = await invokeTool(BENCH, "join-something", { org: "org-7", smuggled: "--evil" });
    assert.deepEqual(received, { id: "join-something", args: { org: "org-7" } });
    assert.equal(out.ok, false);
    assert.equal(out.code, "exit_2", "the service's own verdict is forwarded, not rewritten");
    assert.equal(out.reason, "the hub refused");
    assert.equal(out.stdout, "out");

    const missing = await invokeTool(BENCH, "join-something", {});
    assert.equal(missing.code, "missing_arg");
  });
});

test("SEAM: preflight's fix buttons never contact the custom-tools service", async () => {
  const { describeBuiltinTools } = await import("../tools.mjs");
  let hits = 0;
  await withToolsService((req, res) => { hits += 1; sendJson(res, 200, { tools: [SERVED] }); }, async () => {
    const ids = describeBuiltinTools(BENCH).map((t) => t.id);
    assert.deepEqual(ids, ["worker-image-rebuild", "grader-image-rebuild", "control-restart", "board-rebuild"]);
    assert.equal(hits, 0, "resolving preflight remedies must not depend on the service");
  });
});

test("TOOLS: the drawer renders the job's own output, live and at the verdict", () => {
  // A tool run is a tracked job (control/tooljobs.mjs): the drawer renders the
  // live output tail while it runs and the same tail with the verdict when it
  // settles. A drawer that drops it leaves an operator with a verdict and no
  // evidence — the state that made a successful rebuild look like nothing.
  const src = readFileSync(join(BENCH, "dashboard", "panels", "tools.js"), "utf8");
  assert.match(src, /job\.output_tail/, "tools.js must render the job's output tail");
  assert.match(src, /jobLiveBlock/, "a running job must render live (elapsed, output age, log)");
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

