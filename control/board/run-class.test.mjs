// ─────────────────────────────────────────────────────────────────────────────
// RUN CLASSIFICATION — lib/run-class.mjs, the one shared contract every run
// source uses to decide archived / living / legacy.
//
// Path-first is the property these tests exist for: a run dir under an archive
// root is "archived" even when it declares the v2 epoch. The classifier is
// pure — no filesystem, no cache — so every case below is a plain input/output
// pair. The one cross-module check pins the epoch literal while contract.mjs
// still carries its own copy (a later chunk makes it import this module).
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  SYSTEM_EPOCH,
  ARCHIVE_DIR_NAME,
  BACKUPS_DIR,
  isArchiveSegment,
  firstSegment,
  isArchivePath,
  classifyRun,
  archiveRoot,
} from "./lib/run-class.mjs";

import { SYSTEM_EPOCH as CONTRACT_SYSTEM_EPOCH } from "./contract.mjs";

test("SYSTEM_EPOCH is the v2 wire epoch, and contract.mjs re-exports THIS literal", () => {
  assert.equal(SYSTEM_EPOCH, "2026-11-08");
  assert.equal(SYSTEM_EPOCH, CONTRACT_SYSTEM_EPOCH);
});

test("the archive root names are the disk names", () => {
  assert.equal(BACKUPS_DIR, "backups");
  assert.equal(ARCHIVE_DIR_NAME, "runs-archive");
});

// ── isArchiveSegment / isArchivePath ──

test("isArchiveSegment: the two archive roots and the _archived prefix", () => {
  assert.equal(isArchiveSegment("backups"), true);
  assert.equal(isArchiveSegment("runs-archive"), true);
  assert.equal(isArchiveSegment("_archived-2026-09-24-fresh-start"), true);
  assert.equal(isArchiveSegment("_archived"), true);
});

test("isArchiveSegment: a run stamp and an empty segment are not archives", () => {
  assert.equal(isArchiveSegment("1794141736"), false);
  assert.equal(isArchiveSegment(""), false);
  assert.equal(isArchiveSegment("archive"), false); // no prefix match by accident
});

test("firstSegment: first non-empty /-split segment, \"\" when none", () => {
  assert.equal(firstSegment("backups/123/tree/model"), "backups");
  assert.equal(firstSegment("1794141736/run/cell"), "1794141736");
  assert.equal(firstSegment("/leading/slash"), "leading");
  assert.equal(firstSegment(""), "");
  assert.equal(firstSegment("///"), "");
});

test("isArchivePath: decided by the leading segment only", () => {
  assert.equal(isArchivePath("backups/123/tree/model"), true);
  assert.equal(isArchivePath("runs-archive/2026-11-08/abc"), true);
  assert.equal(isArchivePath("_archived-2026-09-24-fresh-start/x"), true);
  assert.equal(isArchivePath("1794141736/run/cell"), false);
  // an archive name appearing deeper does not make a path archived
  assert.equal(isArchivePath("1794141736/backups/cell"), false);
  assert.equal(isArchivePath(""), false);
});

// ── classifyRun: path first, epoch second ──

test("classifyRun: an archive path wins even over the v2 epoch", () => {
  assert.equal(classifyRun({ relative: "backups/x", systemEpoch: SYSTEM_EPOCH }), "archived");
  assert.equal(classifyRun({ relative: "backups/x", systemEpoch: null }), "archived");
  assert.equal(classifyRun({ relative: "runs-archive/x", systemEpoch: SYSTEM_EPOCH }), "archived");
  assert.equal(classifyRun({ relative: "runs-archive/x", systemEpoch: null }), "archived");
  assert.equal(
    classifyRun({ relative: "_archived-2026-09-24-fresh-start/x", systemEpoch: null }),
    "archived",
  );
});

test("classifyRun: a non-archive path is living only on the exact v2 epoch", () => {
  assert.equal(classifyRun({ relative: "1794141736/run/cell", systemEpoch: SYSTEM_EPOCH }), "living");
  assert.equal(classifyRun({ relative: "flatrun/cell", systemEpoch: SYSTEM_EPOCH }), "living");
});

test("classifyRun: anything else non-archived is legacy", () => {
  assert.equal(classifyRun({ relative: "flatrun/cell", systemEpoch: null }), "legacy");
  assert.equal(classifyRun({ relative: "flatrun/cell" }), "legacy"); // missing epoch
  assert.equal(classifyRun({ relative: "flatrun/cell", systemEpoch: "2026-11-09" }), "legacy");
  assert.equal(classifyRun({ relative: "flatrun/cell", systemEpoch: " 2026-11-08 " }), "legacy");
});

test("classifyRun: always exactly one of the three strings", () => {
  const allowed = new Set(["archived", "living", "legacy"]);
  const cases = [
    { relative: "backups/x", systemEpoch: SYSTEM_EPOCH },
    { relative: "runs-archive/x", systemEpoch: null },
    { relative: "flatrun/cell", systemEpoch: SYSTEM_EPOCH },
    { relative: "flatrun/cell", systemEpoch: null },
    { relative: "", systemEpoch: null },
  ];
  for (const input of cases) {
    const cls = classifyRun(input);
    assert.equal(typeof cls, "string");
    assert.ok(allowed.has(cls), `unexpected class ${cls}`);
  }
});

// ── archiveRoot ──

test("archiveRoot: the runs-archive sibling beside runs/", () => {
  assert.equal(archiveRoot("/x/Learning-Index"), join("/x/Learning-Index", "runs-archive"));
  assert.equal(
    archiveRoot("/x/Learning-Index").split("/").at(-1),
    "runs-archive",
  );
});
