// ─────────────────────────────────────────────────────────────────────────────
// RESET / RESTORE TESTS — split VERBATIM from control/control.test.mjs
// (lines 3473–3778; writeLiveStream moved to liveness-heartbeat.test.mjs).
// Local helper kept here: benchWithHistory. treeFixture/campaignAt are
// imported from ./_shared.mjs, not redefined.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  mintTree,
  activeTreeId,
  readTreePointer,
  listLiveCampaignDirs,
  isBenchmarkData,
  planReset,
  resetAll,
  BACKUPS_DIR,
} from "../tree.mjs";
import { listBackups, checkBackup, resolveBackupDir, restoreBackup } from "../backups.mjs";
import { treeFixture, campaignAt } from "./_shared.mjs";

test("RESET: live process state and tooling output are NEVER swept", () => {
  // THE ONE THAT BREAKS THE BENCH. `mcp4550.pid` holds the PID of the running
  // bench MCP on :4550 and `mcp4550.log` is being appended to by it. Moving
  // either orphans a live process and the next `bench-mcp.sh stop` cannot find
  // what it is meant to stop.
  assert.equal(isBenchmarkData("mcp4550.pid"), false);
  assert.equal(isBenchmarkData("mcp4550.log"), false);

  // Tooling output is about the SOFTWARE, not about a measurement. An operator
  // clearing the benchmark is not asking to lose their build history.
  for (const n of [
    "pytest-20260811T051148.log",
    "pytest-last.log",
    "redeploy-20260815T044328.log",
    "dashboard-rebuild-20260820T222605.log",
    "worker-rebuild-20260816T144401.log",
    "hold-ui-verify-20260810T115428.log",
    "control-plane.log",
    "proxy-e2e",
  ]) {
    assert.equal(isBenchmarkData(n), false, `${n} must be left alone`);
  }

  // The backup folder is never swept into itself.
  assert.equal(isBenchmarkData(BACKUPS_DIR), false);

  // UNRECOGNISED STAYS PUT — the allow list fails safe by design.
  assert.equal(isBenchmarkData("something-nobody-anticipated"), false);
});

test("RESET: every surface the board reads IS swept", () => {
  // These are exactly the things that survived the first version of reset and
  // left an operator staring at their old baselines on a supposedly clean bench.
  for (const n of [
    "1787293682",          // a results tree
    "active-tree.json",    // which tree was live
    "baselines.json",      // the floor
    "cumulative-kimi-kimi-k2-5",
    "cumulative-minimax-minimax-m3",
    "off-cell-20260820T154843.log",
    "on-cell-20260820T154843.log",
    "master",
    "failed",
    "failed-starts",
    "backgammon",
  ]) {
    assert.equal(isBenchmarkData(n), true, `${n} must be swept`);
  }
});

test("RESET: everything moves to a backup and the bench comes back empty", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    const old = await mintTree(runs, { now: 1787310000_000 });
    campaignAt(runs, join(old.active, "local", "local-llm-proxy", "omlx", "model-a"));
    writeFileSync(join(runs, "baselines.json"), "{}");
    campaignAt(runs, "cumulative-legacy-model");
    writeFileSync(join(runs, "off-cell-20260820T154843.log"), "x");
    // Live + tooling, which must survive untouched.
    writeFileSync(join(runs, "mcp4550.pid"), "30673");
    writeFileSync(join(runs, "pytest-last.log"), "x");

    const plan = await planReset(runs);
    assert.ok(plan.keeps.includes("mcp4550.pid"));

    const done = await resetAll(runs, { now: 1787320000_000 });

    // NOTHING DELETED — every swept item is in the backup, under its own name.
    for (const n of ["baselines.json", "cumulative-legacy-model", "off-cell-20260820T154843.log", old.active]) {
      assert.ok(existsSync(join(runs, BACKUPS_DIR, done.backup_id, n)), `${n} must be in the backup`);
      assert.ok(!existsSync(join(runs, n)), `${n} must be gone from the runs root`);
    }
    assert.ok(
      existsSync(join(runs, BACKUPS_DIR, done.backup_id, old.active, "local", "local-llm-proxy", "omlx", "model-a", "manifest.json")),
      "the backed-up results are intact, not just the folder",
    );

    // THE LIVE BENCH IS UNTOUCHED.
    assert.ok(existsSync(join(runs, "mcp4550.pid")), "the running bench MCP's pid file must not move");
    assert.ok(existsSync(join(runs, "pytest-last.log")), "tooling logs must not move");

    // AND THE BOARD READS AS BRAND NEW.
    assert.equal(await activeTreeId(runs), done.active);
    assert.equal((await listLiveCampaignDirs(runs)).length, 0, "no results, no legacy rows, nothing");
    const pointer = await readTreePointer(runs);
    assert.deepEqual(pointer.history, [], "a reset bench carries no history forward");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RESET: two resets inside one second are refused rather than merging backups", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "baselines.json"), "{}");
    await resetAll(runs, { now: 1787310000_000 });
    // Merging two resets into one backup folder would make the older one
    // unrecoverable as a distinct state.
    await assert.rejects(() => resetAll(runs, { now: 1787310000_400 }), /already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


// ═════════════════════════════════════════════════════════════════════════════
// RESTORE FROM HISTORY
// ═════════════════════════════════════════════════════════════════════════════

/** A bench with results, a floor and a run log — then reset. */
async function benchWithHistory(runs, { now = 1787310000_000 } = {}) {
  const tree = await mintTree(runs, { now });
  const dir = join(runs, tree.active, "local", "local-llm-proxy", "omlx", "model-a");
  mkdirSync(join(dir, "memoryOFF", "cell-0000"), { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      created_at: "2026-08-20T15:48:58Z",
      org_id: "okp-org-0",
      task: "backgammon-cumulative-primary",
      seed: 20260709,
      schedule: [
        { memory_mode: "off", model: "orcarouter/kimi/kimi-k2.5", sequence_index: 0 },
        { memory_mode: "on", model: "orcarouter/kimi/kimi-k2.5", sequence_index: 1 },
      ],
    }),
  );
  writeFileSync(join(dir, "manifest.status.jsonl"), '{"type":"attempt"}\n{"type":"attempt"}\n');
  writeFileSync(join(runs, "baselines.json"), "{}");
  writeFileSync(join(runs, "off-cell-20260820T154843.log"), "x");
  return tree;
}

test("RESTORE: a backup id is confined to a child of the backups folder", () => {
  // The id arrives in a request body and reaches an fs path.
  assert.equal(resolveBackupDir("/runs", "../../etc"), null);
  assert.equal(resolveBackupDir("/runs", "/etc/passwd"), null);
  assert.equal(resolveBackupDir("/runs", "1787310000/../.."), null);
  assert.equal(resolveBackupDir("/runs", "not-a-timestamp"), null);
  assert.ok(resolveBackupDir("/runs", "1787310000")?.endsWith(join("backups", "1787310000")));
});

test("RESTORE: the list describes a backup by its CONTENT, not just its timestamp", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    await benchWithHistory(runs);
    await resetAll(runs, { now: 1787320000_000 });

    const list = await listBackups(runs);
    assert.equal(list.length, 1);
    const b = list[0];

    // The line an operator actually recognises their own work by.
    assert.deepEqual([...new Set(b.results.flatMap((r) => r.models))], ["orcarouter/kimi/kimi-k2.5"]);
    assert.equal(b.counts.results, 1);
    assert.equal(b.counts.run_logs, 1);
    assert.equal(b.results[0].cells_off, 1);
    assert.equal(b.results[0].cells_on, 1);
    assert.equal(b.results[0].org_id, "okp-org-0");
    assert.ok(b.bytes > 0);
    assert.equal(b.check.ok, true);
    // The id IS the moment, so the two can never disagree.
    assert.equal(b.created_at, new Date(1787320000_000).toISOString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CHECK: a pointer naming a tree that is not in the backup is a HARD refusal", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    const dir = join(runs, BACKUPS_DIR, "1787320000");
    mkdirSync(dir, { recursive: true });
    // The dangerous shape: it restores QUIETLY WRONG — a bench that renders as
    // empty while holding results, with no error anywhere.
    writeFileSync(join(dir, "active-tree.json"), JSON.stringify({ active: "1787310000" }));
    const check = await checkBackup(dir);
    assert.equal(check.ok, false);
    assert.match(check.errors.join(" "), /points at tree 1787310000, which is not in this backup/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CHECK: foreign content and an empty folder are refused; a soft problem only warns", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });

    const empty = join(runs, BACKUPS_DIR, "1787320001");
    mkdirSync(empty, { recursive: true });
    assert.equal((await checkBackup(empty)).ok, false, "an empty backup restores nothing");

    // Everything here is about to be moved into the runs root, so anything the
    // bench would not recognise there does not belong here either.
    const foreign = join(runs, BACKUPS_DIR, "1787320002");
    mkdirSync(join(foreign, "some-random-folder"), { recursive: true });
    const f = await checkBackup(foreign);
    assert.equal(f.ok, false);
    assert.match(f.errors.join(" "), /does not recognise/);

    // SOFT: an unreadable result folder is named but does not block — the
    // operator can still recover everything else in the backup.
    const soft = join(runs, BACKUPS_DIR, "1787320003");
    mkdirSync(join(soft, "cumulative-broken"), { recursive: true });
    writeFileSync(join(soft, "cumulative-broken", "manifest.json"), "{ not json");
    const sc = await checkBackup(soft);
    assert.equal(sc.ok, true, "a broken result folder must not block the whole restore");
    assert.match(sc.warnings.join(" "), /will not appear on the board/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RESTORE: the live bench is parked first, so nothing is ever overwritten", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    const original = await benchWithHistory(runs);
    const wiped = await resetAll(runs, { now: 1787320000_000 });

    // Work done AFTER the reset — the thing a naive overwrite would destroy.
    writeFileSync(join(runs, "baselines.json"), '{"since":"the reset"}');
    writeFileSync(join(runs, "off-cell-20260821T090000.log"), "newer work");

    const done = await restoreBackup(runs, wiped.backup_id, { now: 1787330000_000 });

    // The old bench is back, in place.
    assert.ok(existsSync(join(runs, original.active, "local", "local-llm-proxy", "omlx", "model-a", "manifest.json")));
    assert.equal(await activeTreeId(runs), original.active, "the restored pointer is the one in charge");
    assert.equal((await listLiveCampaignDirs(runs)).length, 1);

    // And the work done since the reset was SAVED, not lost.
    assert.equal(done.parked_as, "1787330000");
    assert.ok(existsSync(join(runs, BACKUPS_DIR, "1787330000", "off-cell-20260821T090000.log")));
    assert.equal(
      JSON.parse(readFileSync(join(runs, BACKUPS_DIR, "1787330000", "baselines.json"), "utf8")).since,
      "the reset",
    );

    // The restored backup is consumed — its contents are the bench now, so
    // leaving an empty folder would read as data loss.
    assert.equal(done.consumed, true);
    assert.ok(!existsSync(join(runs, BACKUPS_DIR, wiped.backup_id)));

    // RESTORE IS REVERSIBLE: what we just left is the newest entry in the list.
    const list = await listBackups(runs);
    assert.deepEqual(list.map((b) => b.id), ["1787330000"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RESTORE: a backup that fails the check is refused before anything moves", async () => {
  const { root, runs } = treeFixture();
  try {
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "baselines.json"), '{"live":true}');
    const bad = join(runs, BACKUPS_DIR, "1787320000");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "active-tree.json"), JSON.stringify({ active: "1787310000" }));

    await assert.rejects(() => restoreBackup(runs, "1787320000"), /did not pass the check/);
    // THE BENCH IS UNTOUCHED. A refusal that had already parked the live data
    // would leave an operator worse off than before they clicked.
    assert.ok(existsSync(join(runs, "baselines.json")));
    assert.equal((await listBackups(runs)).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── LIVENESS IS A KERNEL FACT, NOT A LOG MTIME (2026-08-26) ─────────────────
//
// `launcher` is null on the documented CLI launch path, and `alive` used to be
// hardcoded false there — so run state reduced to log recency alone and was
// wrong in both directions. These two tests pin both directions.

// ── LIVENESS — THE HARNESS SAYS SO, NOTHING INFERS IT ────────────────────────
//
// THE DEFECT THIS CLOSES: liveness was inferred from the harness LOG'S MTIME,
// but the harness writes PROGRESS at PHASE boundaries and one build phase ran
// 86 model turns between two of them — so the header read
// `CELL STALLED — SILENT 21:49` over a cell that was mid-turn. A first repair
// took the minimum of the log age and the serve event feed; that narrowed the
// window and did not close it, because a disconnected or merely quiet feed
// falls back to the log-mtime signal already known to be wrong.
//
// Liveness now comes from ONE place: the `heartbeat` record the harness writes
// into its cell's live.jsonl every 15s. These four pin the whole contract.

/** A run tree whose live stream holds exactly the records given. */

