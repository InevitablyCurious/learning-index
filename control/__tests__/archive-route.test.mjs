// POST /api/archive/historical — the move logic, exercised directly on a temp
// bench (no network, no live control plane). A legacy run moves out of the
// living root into the sibling `runs-archive/`; a v2 run, a run under the
// active tree, a live run and a held run each stay put, with a reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { archiveHistorical } from "../archive.mjs";

// state.mjs reads the bench root once at import: point it at a temp dir before
// the route module (which imports state) loads, so the route test never touches
// the real runs root. (node --test runs each file in its own process.)
process.env.OKP_CONTROL_BENCH_ROOT = mkdtempSync(join(tmpdir(), "archive-route-bench-"));
const { routes } = await import("../routes/archive.mjs");
const { BENCH_ROOT, RUNS_ROOT } = await import("../state.mjs");

const V2 = "2026-11-08";
const ACTIVE = "1794141736";

/** A temp bench: <parent>/runs is the living root, <parent>/runs-archive the archive. */
function makeBench(activeTree = ACTIVE) {
  const parent = mkdtempSync(join(tmpdir(), "archive-route-"));
  const runsRoot = join(parent, "runs");
  mkdirSync(runsRoot, { recursive: true });
  if (activeTree !== null) {
    writeFileSync(
      join(runsRoot, "active-tree.json"),
      JSON.stringify({ active: activeTree, created_at: null, history: [] }),
    );
  }
  return { parent, runsRoot };
}

function campaign(runsRoot, relative, manifest, files = {}) {
  const dir = join(runsRoot, ...relative.split("/"));
  mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, ...name.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

const LEGACY_REL = "local/local-llm-proxy/omlx/qwen-legacy";

test("mixed bench: legacy moves to runs-archive/<relative>, v2 and backups/ stay, moved === 1", async () => {
  const { parent, runsRoot } = makeBench();
  campaign(runsRoot, `${ACTIVE}/local/local-llm-proxy/omlx/qwen-v2`, { system_epoch: V2 });
  campaign(runsRoot, LEGACY_REL, {}, { "notes.txt": "legacy-bytes", "memoryOFF/cell-0000/out.json": '{"a":1}' });
  campaign(runsRoot, `backups/1800000000/${ACTIVE}/local/omlx/qwen-old`, {});

  const result = await archiveHistorical({ runsRoot, benchRoot: parent });

  assert.equal(result.ok, true);
  assert.equal(result.moved, 1);
  assert.equal(result.archive_root, join(parent, "runs-archive"));
  assert.deepEqual(
    result.skipped.find((s) => s.dir === `${ACTIVE}/local/local-llm-proxy/omlx/qwen-v2`),
    { dir: `${ACTIVE}/local/local-llm-proxy/omlx/qwen-v2`, reason: "active_tree" },
  );

  const movedTo = join(parent, "runs-archive", ...LEGACY_REL.split("/"));
  assert.equal(readFileSync(join(movedTo, "notes.txt"), "utf8"), "legacy-bytes");
  assert.equal(readFileSync(join(movedTo, "memoryOFF/cell-0000/out.json"), "utf8"), '{"a":1}');
  assert.equal(existsSync(join(runsRoot, ...LEGACY_REL.split("/"))), false);
  assert.equal(existsSync(join(runsRoot, ACTIVE, "local/local-llm-proxy/omlx/qwen-v2")), true);
  assert.equal(existsSync(join(runsRoot, "backups/1800000000", ACTIVE, "local/omlx/qwen-old")), true);
});

test("dry run: moves nothing, reports what would move", async () => {
  const { parent, runsRoot } = makeBench();
  campaign(runsRoot, LEGACY_REL, {});

  const result = await archiveHistorical({ runsRoot, benchRoot: parent, dryRun: true });

  assert.equal(result.moved, 1);
  assert.equal(existsSync(join(runsRoot, ...LEGACY_REL.split("/"))), true);
  assert.equal(existsSync(join(parent, "runs-archive")), false);
});

test("idempotent: a second real call finds nothing to move", async () => {
  const { parent, runsRoot } = makeBench();
  campaign(runsRoot, LEGACY_REL, {});

  assert.equal((await archiveHistorical({ runsRoot, benchRoot: parent })).moved, 1);
  const second = await archiveHistorical({ runsRoot, benchRoot: parent });
  assert.equal(second.moved, 0);
  assert.deepEqual(second.skipped, []);
});

test("a legacy run under the ACTIVE tree is refused", async () => {
  const { parent, runsRoot } = makeBench();
  const relative = `${ACTIVE}/local/local-llm-proxy/omlx/qwen-old`;
  campaign(runsRoot, relative, {});

  const result = await archiveHistorical({ runsRoot, benchRoot: parent });

  assert.equal(result.moved, 0);
  assert.deepEqual(result.skipped, [{ dir: relative, reason: "active_tree" }]);
  assert.equal(existsSync(join(runsRoot, ...relative.split("/"))), true);
});

test("a held legacy run is refused", async () => {
  const { parent, runsRoot } = makeBench();
  const relative = "local/local-llm-proxy/omlx/qwen-held";
  campaign(runsRoot, relative, {}, { "memoryOFF/cell-0000/hold-ui.json": '{"schema_version":2}' });

  const result = await archiveHistorical({ runsRoot, benchRoot: parent });

  assert.equal(result.moved, 0);
  assert.deepEqual(result.skipped, [{ dir: relative, reason: "held" }]);
  assert.equal(existsSync(join(runsRoot, ...relative.split("/"))), true);
});

test("a flat v2 run and a live run are both refused", async () => {
  const { parent, runsRoot } = makeBench(null);
  campaign(runsRoot, "cloud/orcarouter/anthropic/model-v2", { system_epoch: V2 });
  campaign(runsRoot, "cloud/orcarouter/anthropic/model-live", {});

  const result = await archiveHistorical({
    runsRoot,
    benchRoot: parent,
    liveRunDirs: ["cloud/orcarouter/anthropic/model-live"],
  });

  assert.equal(result.moved, 0);
  assert.deepEqual(result.skipped, [
    { dir: "cloud/orcarouter/anthropic/model-live", reason: "live_run" },
    { dir: "cloud/orcarouter/anthropic/model-v2", reason: "v2_run" },
  ]);
});

test("POST /api/archive/historical: ?dry_run=1 reports, then a real call moves under the bench root", async () => {
  const route = routes.find((r) => r.method === "POST" && r.path === "/api/archive/historical");
  assert.ok(route, "POST /api/archive/historical route exists");
  mkdirSync(RUNS_ROOT, { recursive: true });
  campaign(RUNS_ROOT, "local/local-llm-proxy/omlx/qwen-route", {});

  function fakeRes() {
    return {
      status: null,
      body: null,
      writeHead(code) { this.status = code; },
      end(text) { this.body = JSON.parse(text); },
    };
  }

  const dry = fakeRes();
  await route.handle({}, dry, new URL("http://x/api/archive/historical?dry_run=1"));
  assert.equal(dry.status, 200);
  assert.equal(dry.body.ok, true);
  assert.equal(dry.body.moved, 1);
  assert.equal(dry.body.archive_root, join(BENCH_ROOT, "runs-archive"));
  assert.equal(existsSync(join(RUNS_ROOT, "local/local-llm-proxy/omlx/qwen-route")), true);

  const real = fakeRes();
  await route.handle({}, real, new URL("http://x/api/archive/historical"));
  assert.equal(real.status, 200);
  assert.equal(real.body.moved, 1);
  assert.equal(
    existsSync(join(BENCH_ROOT, "runs-archive/local/local-llm-proxy/omlx/qwen-route/manifest.json")),
    true,
  );
  assert.equal(existsSync(join(RUNS_ROOT, "local/local-llm-proxy/omlx/qwen-route")), false);
});
