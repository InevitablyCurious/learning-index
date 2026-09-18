// RUN HISTORY — reads what every cell of every era produced.
//
//   <tree>/…/<campaign>/<arm>/cell-NNNN/
//     checkpoints/index.json  {run_id, checkpoints, diffs} — the attempt chain
//     checkpoints/diffs/…     unified diffs between checkpoints
//     transcript.md           the verbatim session transcript
//     mapping.json            checkpoint phases → transcript ranges
//
// All eras, archives included. A pure reader: failures degrade (no runs root →
// [], no index → null, no transcript → not_found). benchmark_id and cell come
// from the wire, so every path is containment-checked (resolveCellDir,
// resolveWithin).

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, relative, sep, isAbsolute } from "node:path";

import { BACKUPS_DIR, listCampaignDirs } from "./tree.mjs";
import { statOrNull } from "./lib/fs.mjs";

// ── internal helpers ──

/** A windows drive prefix counts as absolute even where isAbsolute() says no. */
const WINDOWS_DRIVE = /^[a-zA-Z]:/;

/** The one refusal shape for a bad (benchmark_id, cell) pair, from the wire. */
const INVALID_RUN = Object.freeze({
  ok: false,
  code: "invalid_run",
  reason: "run or cell identifier is invalid",
  status: 400,
});

/**
 * The absolute cell folder for a (benchmarkId, cell) pair, or null. Both are
 * wire input: bad segments are refused, and the result must resolve under the
 * runs root.
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
 * `rel` under `root`, or null when it escapes (no absolute path, backslash,
 * NUL or `..`).
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

// ── the served surface ──

/**
 * Every cell of every era, most recent tree first. benchmark_id is the first
 * segment of the campaign path (split on path.sep, as tree.mjs builds it) and
 * `cell` the rest, so the pair round-trips through resolveCellDir. Artifact
 * fields are absolute paths or null. Never throws.
 */
export async function listRunCells(runsRoot, devMode = null) {
  let root;
  let campaigns;
  try {
    root = resolve(runsRoot);
    // Including backups/: a reset moves the old tree there, so the top level alone
    // would show one run out of a dozen.
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
        // benchmark_id + cell stay the resolvable pair ("backups" for archived rows);
        // the run's own identity is a separate display field.
        const cellRel = relative(treeRoot, cellDir);
        const archived = treeId === BACKUPS_DIR;
        // backups/<new>/<old>/…: the second segment is the archived run's id — only
        // when it looks like a tree id. Otherwise null, and the page says why.
        const archivedId = cellRel.split(sep)[1];
        const displayId = archived
          ? (/^\d+$/.test(archivedId ?? "") ? archivedId : null)
          : treeId;
        cells.push({
          benchmark_id: treeId,
          cell: cellRel,
          tree_id: displayId,
          archived,
          // Why this row can't be identified; null on healthy rows.
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
  // Most recent first (tree ids are epoch seconds), then cell path.
  cells.sort((a, b) => {
    // On tree_id: every archived row's benchmark_id is "backups".
    const d = (Number(b.tree_id) || 0) - (Number(a.tree_id) || 0);
    if (d !== 0) return d;
    return a.cell < b.cell ? 1 : a.cell > b.cell ? -1 : 0;
  });
  return cells;
}

/**
 * The cell's checkpoint index. Absent or corrupt reads as
 * {ok:true, checkpoints:null, diffs:null}; only a bad identifier is refused.
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
 * One diff file's text. A leading `checkpoints/` is accepted; an escape is a
 * 400; not a file is a 404.
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

/** The cell's verbatim transcript; absence is a 404, never a substitute. */
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
