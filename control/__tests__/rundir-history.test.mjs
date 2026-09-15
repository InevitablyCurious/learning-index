// ─────────────────────────────────────────────────────────────────────────────
// RUNDIR + HISTORY TESTS — split VERBATIM from control/control.test.mjs
// (lines 5224–5586). Local helpers kept here: HISTORY_DIFF, HISTORY_CAMPAIGN,
// writeHistoryCell, historyWireCell.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listCampaignDirs } from "../tree.mjs";
import { runDirOf } from "../runstate.mjs";
import { listRunCells, readCheckpointIndex, readDiffText, readTranscriptText } from "../history.mjs";
import { HERE } from "./_shared.mjs";

test("RUNDIR: a seed line's two /runs/ paths resolve to the destination run", () => {
  const line =
    "PROGRESS step=seed-copy src=/x/bench/runs/snapshots/1788598797371/tree "
    + "dst=/x/bench/runs/1788599410/local/local-llm-proxy/omlx/qwen3-6-35b-a3b-bench/memoryOFF/cell-0000/worktree";
  assert.equal(runDirOf(line), "1788599410/local/local-llm-proxy/omlx/qwen3-6-35b-a3b-bench");
});

test("RUNDIR: the capture never spans whitespace", () => {
  // The property, not the one line that exposed it: whatever a log carries, a
  // run directory is one path. A capture containing a space is a capture that
  // crossed from one path into another, and it can only ever name a directory
  // that does not exist.
  const lines = [
    "a=/r/runs/snapshots/1/tree b=/r/runs/2000000000/s/p/m/memoryON/cell-0000/worktree",
    "/r/runs/snapshots/1/tree /r/runs/2000000000/s/p/m/sessions/x",
    "old=/r/runs/1999999999/a/b/c/d/memoryOFF/ new=/r/runs/2000000000/s/p/m/memoryOFF/",
  ];
  for (const l of lines) {
    const got = runDirOf(l);
    assert.ok(got && !/\s/.test(got), `run dir must not contain whitespace: ${JSON.stringify(got)}`);
  }
});

test("RUNDIR: an ordinary single-path line is unchanged", () => {
  // The fix must not cost the case that always worked.
  assert.equal(
    runDirOf("step=worktree-git-init path=/x/bench/runs/1788592301/local/p/o/m/memoryOFF/cell-0000/worktree"),
    "1788592301/local/p/o/m",
  );
});

// ── HISTORY: ─────────────────────────────────────────────────────────────────
// The run forest's pure reader (WO-HIST-04). history.mjs enumerates cells
// across ALL eras and reads their artifacts back; benchmark_id, cell, and the
// diff relPath all arrive from the wire, so every refusal shape (invalid_run /
// path_traversal / not_found) is asserted here, not just the happy path.
// server.mjs self-listens at import, so the route wiring is pinned by source
// text (routes/tree.mjs since LI-14 phase 2) — the same deliberate trade the
// GUARD section makes.

const HISTORY_DIFF = "--- a/src/game.ts\n+++ b/src/game.ts\n@@ -1 +1 @@\n-old\n+new\n";
const HISTORY_CAMPAIGN = "local/local-llm-proxy/omlx/qwen3-6-35b-a3b-bench";

// One cell on disk, plus the manifest.json that makes its campaign visible to
// listCampaignDirs — the campaign home is the parent of the /^memory/i arm.
function writeHistoryCell(root, rel, { withCheckpoints = false, withTranscript = false } = {}) {
  const segs = rel.split("/");
  const armIdx = segs.findIndex((s) => /^memory/i.test(s));
  assert.notEqual(armIdx, -1, `writeHistoryCell: no memory arm segment in ${rel}`);
  const cellDir = join(root, rel);
  mkdirSync(cellDir, { recursive: true });
  writeFileSync(join(root, ...segs.slice(0, armIdx), "manifest.json"), "{}");
  if (withCheckpoints) {
    const diffs = join(cellDir, "checkpoints", "diffs", "cp-01_to_cp-02");
    mkdirSync(join(diffs, "files", "src"), { recursive: true });
    writeFileSync(
      join(cellDir, "checkpoints", "index.json"),
      JSON.stringify({
        run_id: "r1",
        checkpoints: [
          { id: "cp-01", attempt: 1, phase: "initial", state_hash: "h1", wall_ts: 1, tree_path: "checkpoints/cp-01/tree" },
        ],
        diffs: [
          {
            id: "cp-01_to_cp-02",
            from: "cp-01",
            to: "cp-02",
            combined: "checkpoints/diffs/cp-01_to_cp-02/combined.diff",
            files: [
              { path: "src/game.ts", change: "modified", diff: "checkpoints/diffs/cp-01_to_cp-02/files/src/game.ts.diff" },
            ],
          },
        ],
      }),
    );
    writeFileSync(join(diffs, "combined.diff"), HISTORY_DIFF);
    writeFileSync(join(diffs, "files", "src", "game.ts.diff"), HISTORY_DIFF);
  }
  if (withTranscript) {
    writeFileSync(join(cellDir, "transcript.md"), "# Session transcript\n\n## 1. User\nhello\n");
  }
  return { cellDir, rel, treeId: segs[0] };
}

// The (benchmark_id, cell) pair as the wire carries it: cell is rel minus its
// tree-id head — exactly what listRunCells reports and resolveCellDir re-joins.
const historyWireCell = (h) => h.rel.split("/").slice(1).join("/");

test("HISTORY: listRunCells returns most-recent-first with honest null artifact fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-hist-list-"));
  try {
    writeHistoryCell(root, `1788672514/${HISTORY_CAMPAIGN}/memoryOFF/cell-0000`);
    const populated = writeHistoryCell(root, `1788672514/${HISTORY_CAMPAIGN}/memoryOFF/cell-0001`, {
      withCheckpoints: true,
      withTranscript: true,
    });
    writeHistoryCell(root, `1788600000/${HISTORY_CAMPAIGN}/memoryOFF/cell-0000`);
    writeHistoryCell(root, `1788600000/${HISTORY_CAMPAIGN}/memoryOFF/cell-0001`);

    const cells = await listRunCells(root);
    assert.equal(cells.length, 4);

    // Tree ids are epoch stamps: numeric descending, cell path descending within.
    assert.deepEqual(
      cells.map((c) => [c.benchmark_id, c.cell]),
      [
        ["1788672514", `${HISTORY_CAMPAIGN}/memoryOFF/cell-0001`],
        ["1788672514", `${HISTORY_CAMPAIGN}/memoryOFF/cell-0000`],
        ["1788600000", `${HISTORY_CAMPAIGN}/memoryOFF/cell-0001`],
        ["1788600000", `${HISTORY_CAMPAIGN}/memoryOFF/cell-0000`],
      ],
    );

    // The full entry shape — 11 keys, in source order (history.mjs cells.push).
    // `tree_id`, `archived` and `unreadable` were added 2026-09-10 for the
    // archive. They are DISPLAY identity, derived from the path, deliberately
    // separate from the resolvable (benchmark_id, cell) pair rather than
    // replacing it — and `unreadable` carries WHY when the path does not match
    // the layout the reset writes, because the rule is to standardise the view
    // and never the data.
    const KEYS = [
      "benchmark_id",
      "cell",
      "tree_id",
      "archived",
      "unreadable",
      "dev_mode_enabled",
      "dev_mode_source",
      "dev_mode_file",
      "checkpoints_dir",
      "transcript_file",
      "mapping_file",
    ];
    for (const c of cells) assert.deepEqual(Object.keys(c), KEYS);

    // Presence is measured with stat, never guessed: the populated cell carries
    // absolute paths; the bare three carry honest nulls. mapping.json is never
    // written by the fixture — not even the populated cell may invent one.
    assert.equal(cells[0].checkpoints_dir, join(populated.cellDir, "checkpoints"));
    assert.equal(cells[0].transcript_file, join(populated.cellDir, "transcript.md"));
    assert.equal(cells[0].mapping_file, null);
    for (const bare of cells.slice(1)) {
      assert.equal(bare.checkpoints_dir, null);
      assert.equal(bare.transcript_file, null);
      assert.equal(bare.mapping_file, null);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HISTORY: listRunCells carries dev_mode fields when provided and defaults otherwise", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-hist-devmode-"));
  try {
    writeHistoryCell(root, `1788672514/${HISTORY_CAMPAIGN}/memoryOFF/cell-0000`);

    // The reader never measures dev mode itself — absent input means defaults.
    const defaults = await listRunCells(root);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].dev_mode_enabled, false);
    assert.equal(defaults[0].dev_mode_source, null);
    assert.equal(defaults[0].dev_mode_file, null);

    // What the caller measured once is broadcast onto every entry as-is.
    const carried = await listRunCells(root, {
      enabled: true,
      source: "state_file",
      file: "/bench/config/devmode.json",
    });
    assert.equal(carried.length, 1);
    for (const c of carried) {
      assert.equal(c.dev_mode_enabled, true);
      assert.equal(c.dev_mode_source, "state_file");
      assert.equal(c.dev_mode_file, "/bench/config/devmode.json");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HISTORY: absent artifacts are honest null/404, never 500", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-hist-absent-"));
  try {
    const h = writeHistoryCell(root, `1788672514/${HISTORY_CAMPAIGN}/memoryOFF/cell-0000`);
    const cell = historyWireCell(h);

    // A run without checkpoint history is a legitimate state, not a failure.
    assert.deepEqual(await readCheckpointIndex(root, h.treeId, cell), {
      ok: true,
      checkpoints: null,
      diffs: null,
    });

    const diff = await readDiffText(root, h.treeId, cell, "diffs/x/combined.diff");
    assert.equal(diff.ok, false);
    assert.equal(diff.code, "not_found");
    assert.equal(diff.status, 404);

    // A transcript is the record of what the model was actually told — absence
    // is a 404, never an empty string passed off as content.
    const transcript = await readTranscriptText(root, h.treeId, cell);
    assert.equal(transcript.ok, false);
    assert.equal(transcript.code, "not_found");
    assert.equal(transcript.status, 404);

    // Only an invalid identifier is refused — as a 400, never a throw.
    const invalid = await readCheckpointIndex(root, "../..", cell);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, "invalid_run");
    assert.equal(invalid.status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HISTORY: diff route refuses path traversal", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-hist-traversal-"));
  try {
    const h = writeHistoryCell(root, `1788672514/${HISTORY_CAMPAIGN}/memoryOFF/cell-0000`, {
      withCheckpoints: true,
    });
    const cell = historyWireCell(h);

    // relPath is wire input: `..` segments, absolute paths, and the backslash
    // form are all refused BEFORE any read — a 400, never a served /etc/passwd.
    for (const evil of ["../../etc/passwd", "/etc/passwd", "..\\..\\etc"]) {
      const got = await readDiffText(root, h.treeId, cell, evil);
      assert.equal(got.ok, false, `expected refusal for ${JSON.stringify(evil)}`);
      assert.equal(got.code, "path_traversal");
      assert.equal(got.status, 400);
    }

    // The cell identifier is wire input too — containment is checked first.
    const badCell = await readDiffText(root, h.treeId, "../../etc", "diffs/x/combined.diff");
    assert.equal(badCell.ok, false);
    assert.equal(badCell.code, "invalid_run");
    assert.equal(badCell.status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HISTORY: a synthetic run round-trips checkpoints, diff, and transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-hist-roundtrip-"));
  try {
    const h = writeHistoryCell(root, `1788672514/${HISTORY_CAMPAIGN}/memoryOFF/cell-0000`, {
      withCheckpoints: true,
      withTranscript: true,
    });
    const cell = historyWireCell(h);

    const idx = await readCheckpointIndex(root, h.treeId, cell);
    assert.equal(idx.ok, true);
    assert.equal(idx.checkpoints.length, 1);
    assert.equal(idx.diffs.length, 1);
    assert.equal(idx.diffs[0].files[0].path, "src/game.ts");

    // index.json records every path relative to the CELL dir, so a served
    // relPath may arrive with the checkpoints/ prefix — one leading prefix is
    // stripped and both forms resolve identically.
    const bare = await readDiffText(root, h.treeId, cell, "diffs/cp-01_to_cp-02/combined.diff");
    assert.equal(bare.ok, true);
    assert.ok(bare.text.includes("+new"));
    const prefixed = await readDiffText(root, h.treeId, cell, "checkpoints/diffs/cp-01_to_cp-02/combined.diff");
    assert.equal(prefixed.ok, true);
    assert.equal(prefixed.text, bare.text);

    const transcript = await readTranscriptText(root, h.treeId, cell);
    assert.equal(transcript.ok, true);
    assert.ok(transcript.text.includes("## 1. User"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HISTORY: routes/tree.mjs wires the four routes, the import, and sendText", () => {
  // server.mjs calls listen() at import, so the wiring is pinned by source
  // text — the same deliberate trade the GUARD section makes. Since LI-14
  // phase 2 the history routes live in control/routes/tree.mjs, one directory
  // down from the modules they import, so the needles carry the ../ prefix.
  const TREE_ROUTES_SRC = readFileSync(join(HERE, "routes", "tree.mjs"), "utf8");
  for (const needle of [
    '"/api/history"',
    '"/api/history/checkpoints"',
    '"/api/history/diff"',
    '"/api/history/transcript"',
    'from "../history.mjs"',
    'from "../lib/http.mjs"',
  ]) {
    assert.ok(TREE_ROUTES_SRC.includes(needle), `routes/tree.mjs no longer contains ${needle}`);
  }
  // sendText's DEFINITION moved to lib/http.mjs (LI-14 phase 1); the import
  // needle above is what wires it into the routes this test pins.
  const httpSrc = readFileSync(join(HERE, "lib", "http.mjs"), "utf8");
  assert.ok(httpSrc.includes("function sendText("), "lib/http.mjs no longer defines sendText");
});

// ── /history must show the archive, and the board must not (2026-09-10) ─────

test("HISTORY: archived trees are enumerated, live-only walks still are not", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-hist-backups-"));
  try {
    // A live tree, and one parked by a reset at backups/<new>/<old>/…
    const live = join(root, "1789023699", "local", "prov", "omlx", "model-a");
    const arch = join(root, "backups", "1789023699", "1788976174", "local", "prov", "omlx", "model-a");
    for (const campaign of [live, arch]) {
      mkdirSync(join(campaign, "memoryOFF", "cell-0000"), { recursive: true });
      writeFileSync(join(campaign, "manifest.json"), "{}");
    }

    const cells = await listRunCells(root);
    const ids = cells.map((c) => c.tree_id).sort();
    assert.deepEqual(ids, ["1788976174", "1789023699"], "the archive is history too");

    const archived = cells.find((c) => c.archived);
    assert.equal(archived.tree_id, "1788976174", "display id is the run's own, not 'backups'");
    assert.equal(archived.benchmark_id, "backups", "resolvable half is unchanged");
    assert.ok(
      archived.cell.startsWith("1789023699"),
      "the cell path carries the rest, so resolveCellDir still re-joins it",
    );

    // The board's walk must be untouched: descending into backups there is how
    // a reset would undo itself on the next poll.
    const live_only = await listCampaignDirs(root);
    assert.equal(live_only.length, 1, "default walk must still skip the archive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HISTORY: an archived cell still resolves to a real directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "okp-hist-resolve-"));
  try {
    const campaign = join(root, "backups", "1789023699", "1788976174", "local", "prov", "omlx", "m");
    mkdirSync(join(campaign, "memoryOFF", "cell-0000", "checkpoints"), { recursive: true });
    writeFileSync(join(campaign, "manifest.json"), "{}");
    writeFileSync(
      join(campaign, "memoryOFF", "cell-0000", "checkpoints", "index.json"),
      JSON.stringify({ run_id: "r", checkpoints: [{ id: "cp-01" }], diffs: [] }),
    );

    const [row] = await listRunCells(root);
    const got = await readCheckpointIndex(root, row.benchmark_id, row.cell);
    assert.equal(got.ok, true, "the pair listRunCells reports must be resolvable");
    assert.equal(got.checkpoints.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── A LAUNCH SETTING MUST REACH THE ARGV (2026-09-11) ───────────────────────
//
// `graderWorkerTarget` was threaded through five places — payload parse, the
// preview call, the preview signature, its return, and the argv builder — and
// ONE destructure of `check` was missed. Everything parsed, every test passed,
// and the failure surfaced as `launcher_failed: graderWorkerTarget is not
// defined` when the operator pressed Launch.
//
// A source-level check, because that is where the defect lives: the value is
// not in scope at the site that uses it. Running the server would need a whole
// launch to reach that line.

