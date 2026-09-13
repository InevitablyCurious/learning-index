// ─────────────────────────────────────────────────────────────────────────────
// RUN HISTORY — the pure reader for what every era's cells actually produced.
//
// WHAT THIS IS (WO-HIST-04-I1)
//
// The runs root is a forest of benchmark trees (`<treeId>/…/<campaign>/`). A
// campaign home holds memory arms (`memoryON`/`memoryOFF`/…), and an arm holds
// cells (`cell-NNNN`) — one cell is one graded run, leaving on disk:
//
//   checkpoints/index.json   {"run_id","checkpoints","diffs"} — the attempt chain
//   checkpoints/diffs/…      unified diffs between consecutive checkpoints,
//                            recorded in index.json relative to the CELL dir
//   transcript.md            the verbatim session transcript
//   mapping.json             checkpoint phases → transcript entry ranges
//
// This module enumerates cells across ALL eras — `listCampaignDirs`, never the
// live-only variant, because history does not stop being history when a tree
// goes inert — and reads those artifacts back.
//
// PURE READER: no HTTP, no writes, no spawns. Every failure degrades: a
// missing runs root enumerates as [], a missing checkpoint index reads as
// null, a missing transcript as not_found. Nothing here throws at a caller.
//
// IDENTIFIERS ARRIVE FROM THE WIRE. benchmark_id and cell are request inputs,
// so every resolution is containment-checked (resolveCellDir / resolveWithin):
// a path that escapes the runs root or the checkpoints directory is refused,
// not served. These guards are the only door — no caller re-derives the path.
// ─────────────────────────────────────────────────────────────────────────────

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, relative, sep, isAbsolute } from "node:path";

import { BACKUPS_DIR, listCampaignDirs } from "./tree.mjs";

// ── internal helpers (never exported) ───────────────────────────────────────

/** A windows drive prefix counts as absolute even where isAbsolute() says no. */
const WINDOWS_DRIVE = /^[a-zA-Z]:/;

/** The one refusal shape for a bad (benchmark_id, cell) pair, from the wire. */
const INVALID_RUN = Object.freeze({
  ok: false,
  code: "invalid_run",
  reason: "run or cell identifier is invalid",
  status: 400,
});

/** stat that degrades to null: absence and unreadability are the same answer. */
async function statOrNull(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/**
 * The absolute cell directory for a (benchmarkId, cell) pair, or null.
 *
 * Both halves arrive from the wire, so both are refused as single segments
 * gone wrong: no separator or `.`/`..` masquerading as a benchmark id, no
 * absolute path, backslash, or `..` segment inside a cell. The final
 * containment check is the authority — whatever survived the segment rules
 * must still resolve UNDER the runs root, or the answer is null.
 */
export function resolveCellDir(runsRoot, benchmarkId, cell) {
  if (typeof benchmarkId !== "string" || benchmarkId === "") return null;
  if (benchmarkId === "." || benchmarkId === "..") return null;
  if (benchmarkId.includes("/") || benchmarkId.includes("\\")) return null;
  if (isAbsolute(benchmarkId)) return null;
  if (typeof cell !== "string" || cell === "") return null;
  if (isAbsolute(cell) || WINDOWS_DRIVE.test(cell)) return null;
  if (cell.includes("\\")) return null;
  if (cell.split("/").includes("..")) return null;
  try {
    const base = resolve(runsRoot);
    const p = resolve(base, benchmarkId, cell);
    return p === base || p.startsWith(base + sep) ? p : null;
  } catch {
    return null;
  }
}

/**
 * The absolute path of `rel` under `root`, or null when it escapes.
 *
 * `rel` is wire input (a diff path out of index.json or a query parameter),
 * so containment is the gate: no absolute path, backslash, NUL byte, or `..`
 * segment — and the resolved result must still sit under root.
 */
function resolveWithin(root, rel) {
  if (typeof rel !== "string" || rel === "") return null;
  if (rel.includes("\0")) return null;
  if (isAbsolute(rel) || WINDOWS_DRIVE.test(rel)) return null;
  if (rel.includes("\\")) return null;
  if (rel.split("/").includes("..")) return null;
  const base = resolve(root);
  const p = resolve(base, rel);
  return p === base || p.startsWith(base + sep) ? p : null;
}

// ── the served surface ──────────────────────────────────────────────────────

/**
 * Every cell of every era, most-recent tree first.
 *
 * The tree id — the wire's `benchmark_id` — is the first segment of the
 * campaign's runs-root-relative path, split on `sep` exactly as tree.mjs
 * builds it (campaignTreeId's docstring is the standing warning against a
 * hardcoded slash). `cell` is the rest: the campaign's path under its tree
 * plus arm plus cell, so (benchmark_id, cell) round-trips through
 * resolveCellDir to the same directory this walk stood on.
 *
 * Artifact fields are absolute paths or null — presence, measured with stat,
 * never a guess. `devMode` is broadcast onto every entry as-is: the caller
 * measured it once (devmode.mjs) and this reader only carries it.
 *
 * A missing or unreadable runs root enumerates as [] — an empty history is a
 * valid answer, and this function never throws.
 */
export async function listRunCells(runsRoot, devMode = null) {
  let root;
  let campaigns;
  try {
    root = resolve(runsRoot);
    // INCLUDING THE ARCHIVE. A reset does not delete the outgoing tree, it
    // moves it to `backups/<newTreeId>/<oldTreeId>/…` — so a bench that has run
    // a dozen times has ONE tree at the top level and eleven under `backups/`.
    // Enumerating only the top level made this page show a single row and call
    // it the history. Opt-in, so every board reader keeps the live-only view
    // that makes reset work (`tree.mjs`).
    campaigns = await listCampaignDirs(root, { includeBackups: true });
  } catch {
    return [];
  }
  const cells = [];
  for (const campaign of campaigns) {
    const treeId = campaign.relative.split(sep)[0];
    const treeRoot = join(root, treeId);
    let arms;
    try {
      arms = await readdir(campaign.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const arm of arms) {
      if (!arm.isDirectory() || !/^memory/i.test(arm.name)) continue;
      const armDir = join(campaign.dir, arm.name);
      let cellDirs;
      try {
        cellDirs = await readdir(armDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of cellDirs) {
        if (!ent.isDirectory() || !/^cell-/i.test(ent.name)) continue;
        const cellDir = join(armDir, ent.name);
        const [cpIndex, transcript, mapping] = await Promise.all([
          statOrNull(join(cellDir, "checkpoints", "index.json")),
          statOrNull(join(cellDir, "transcript.md")),
          statOrNull(join(cellDir, "mapping.json")),
        ]);
        // `benchmark_id` + `cell` stay the RESOLVABLE pair — they are what
        // `resolveCellDir` re-joins, and for an archived cell that means
        // benchmark_id "backups" with the tree ids carried in `cell`. The run's
        // own identity is a separate, display-only field: showing "backups" in
        // the id column for eleven different runs would be worse than showing
        // none of them.
        const cellRel = relative(treeRoot, cellDir);
        const archived = treeId === BACKUPS_DIR;
        // backups/<newTreeId>/<oldTreeId>/… — the SECOND segment is the tree
        // that was archived, i.e. the run this cell actually belongs to.
        //
        // DERIVED ONLY WHEN THE SHAPE IS RECOGNISED. Tree ids are epoch stamps,
        // so a non-numeric second segment means this archive was not written by
        // the reset this code knows about — older data, a hand-moved folder, a
        // layout that has since changed. `null` is the honest answer there, and
        // the page says so. Guessing an id would standardise the DATA; the rule
        // is to standardise the VIEW and let unrecognised shapes say what they
        // are, with a reason worth pasting to someone.
        const archivedId = cellRel.split(sep)[1];
        const displayId = archived
          ? (/^\d+$/.test(archivedId ?? "") ? archivedId : null)
          : treeId;
        cells.push({
          benchmark_id: treeId,
          cell: cellRel,
          tree_id: displayId,
          archived,
          // Why this row cannot be identified, when it cannot. Null on every
          // healthy row; a short, pasteable reason otherwise.
          unreadable: displayId
            ? null
            : `archived under an unrecognised layout: expected backups/<treeId>/<treeId>/… but the second segment is ${archivedId == null ? "absent" : `"${archivedId}"`}`,
          dev_mode_enabled: devMode?.enabled ?? false,
          dev_mode_source: devMode?.source ?? null,
          dev_mode_file: devMode?.file ?? null,
          checkpoints_dir: cpIndex ? join(cellDir, "checkpoints") : null,
          transcript_file: transcript ? join(cellDir, "transcript.md") : null,
          mapping_file: mapping ? join(cellDir, "mapping.json") : null,
        });
      }
    }
  }
  // Most-recent-first: tree ids are epoch stamps, so numeric descending; one
  // tree's many cells tiebreak on the cell path, descending. (|| 0 keeps a
  // non-numeric legacy id a deterministic sort key instead of NaN.)
  cells.sort((a, b) => {
    // On `tree_id`, not `benchmark_id`: every archived row carries the literal
    // "backups" as its benchmark_id, which sorts as 0 and would pile a dozen
    // real runs together in arbitrary order at the bottom.
    const d = (Number(b.tree_id) || 0) - (Number(a.tree_id) || 0);
    if (d !== 0) return d;
    return a.cell < b.cell ? 1 : a.cell > b.cell ? -1 : 0;
  });
  return cells;
}

/**
 * The cell's checkpoint index — `{run_id, checkpoints[], diffs[]}` on disk.
 *
 * Degrades rather than errors: an absent, unreadable, or corrupt index reads
 * as `{ok:true, checkpoints:null, diffs:null}`, because a run without
 * checkpoint history is a legitimate state, not a failure. Only an invalid
 * identifier is refused. Present-but-non-array keys read as [] — the arrays
 * themselves are carried as-is, never re-shaped.
 */
export async function readCheckpointIndex(runsRoot, benchmarkId, cell) {
  const cellDir = resolveCellDir(runsRoot, benchmarkId, cell);
  if (cellDir === null) return INVALID_RUN;
  let raw;
  try {
    raw = await readFile(join(cellDir, "checkpoints", "index.json"), "utf8");
  } catch {
    return { ok: true, checkpoints: null, diffs: null };
  }
  let index;
  try {
    index = JSON.parse(raw);
  } catch {
    return { ok: true, checkpoints: null, diffs: null };
  }
  if (index === null || typeof index !== "object" || Array.isArray(index)) {
    return { ok: true, checkpoints: null, diffs: null };
  }
  return {
    ok: true,
    checkpoints: Array.isArray(index.checkpoints) ? index.checkpoints : [],
    diffs: Array.isArray(index.diffs) ? index.diffs : [],
  };
}

/**
 * One diff file's text from under the cell's checkpoints directory.
 *
 * index.json records every path relative to the CELL dir, so a served relPath
 * may arrive prefixed with `checkpoints/` — one leading prefix is stripped and
 * both forms resolve identically. resolveWithin is the gate: a `..` escape is
 * a 400, never a read; anything that resolves but is not a file is a 404.
 */
export async function readDiffText(runsRoot, benchmarkId, cell, relPath) {
  const cellDir = resolveCellDir(runsRoot, benchmarkId, cell);
  if (cellDir === null) return INVALID_RUN;
  const checkpointsDir = join(cellDir, "checkpoints");
  let rel = relPath;
  if (typeof rel === "string" && rel.startsWith("checkpoints/")) {
    rel = rel.slice("checkpoints/".length);
  }
  const p = resolveWithin(checkpointsDir, rel);
  if (p === null) {
    return {
      ok: false,
      code: "path_traversal",
      reason: "path escapes the checkpoints directory",
      status: 400,
    };
  }
  const st = await statOrNull(p);
  if (st === null || !st.isFile()) {
    return { ok: false, code: "not_found", reason: "diff not found", status: 404 };
  }
  try {
    return { ok: true, text: await readFile(p, "utf8") };
  } catch {
    return { ok: false, code: "not_found", reason: "diff not found", status: 404 };
  }
}

/**
 * The cell's verbatim transcript text.
 *
 * Absence is a 404, not a degrade: unlike checkpoints, a transcript is the
 * record of what the model was actually told, so "not found" is the honest
 * answer — never a substitute or an empty string passed off as content.
 */
export async function readTranscriptText(runsRoot, benchmarkId, cell) {
  const cellDir = resolveCellDir(runsRoot, benchmarkId, cell);
  if (cellDir === null) return INVALID_RUN;
  const transcriptPath = join(cellDir, "transcript.md");
  const st = await statOrNull(transcriptPath);
  if (st === null || !st.isFile()) {
    return { ok: false, code: "not_found", reason: "transcript not found", status: 404 };
  }
  try {
    return { ok: true, text: await readFile(transcriptPath, "utf8") };
  } catch {
    return { ok: false, code: "not_found", reason: "transcript not found", status: 404 };
  }
}
