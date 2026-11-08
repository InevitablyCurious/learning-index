// ─────────────────────────────────────────────────────────────────────────────
// HISTORICAL ARCHIVE — the manual verb that moves pre-v2 ("legacy") runs out
// of the living runs root into the sibling archive root, `runs-archive/`.
//
//   runs/                     ← the living root: every reader scans THIS
//     active-tree.json
//     1794141736/…            ← the live tree
//     local/…/model/          ← legacy flat campaigns (pre-v2)
//   runs-archive/             ← beside runs/, never scanned by the board
//
// Why a move and not a delete: the record is the product. A legacy run is
// inert (no v2 epoch, no live process), so relocating it costs nothing and
// keeps every byte; deleting it would be irreversible. The move preserves the
// runs-root-relative structure, so putting the directory back is one rename.
//
// What is NEVER moved: a run under the ACTIVE tree, a run with a live process,
// a held run (a `hold-ui.json` anywhere in it), and any v2 run. Those refusals
// are the point of the verb — the board prunes by path, and this tool is the
// only thing allowed to re-address a run.
//
// Everything is parameterized on `runsRoot`/`benchRoot` (never the module-global
// RUNS_ROOT) so the logic is testable on a temp bench, and so the caller owns
// the production roots.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, sep } from "node:path";

import { classifyRun, archiveRoot } from "./board/lib/run-class.mjs";
import { activeTreeId, listLiveCampaignDirs } from "./tree.mjs";
import { listDir, statOrNull } from "./lib/fs.mjs";

/** A hold sits a few levels below the run dir; mirror hold.mjs's bounded walk. */
const HOLD_FILE = "hold-ui.json";
const HOLD_MAX_DEPTH = 4;
const HOLD_SKIP_DIRS = new Set(["worktree", "checkpoints", "node_modules"]);

/** `relative` from tree.mjs is built with path.sep; classifyRun splits on "/". */
function toPosix(relative) {
  return String(relative ?? "").split(sep).join("/");
}

/** Is any `hold-ui.json` under this run dir? Bounded: never the model's code. */
async function hasHoldFile(root, depth = 0) {
  if (depth > HOLD_MAX_DEPTH) return false;
  for (const ent of await listDir(root)) {
    const path = join(root, ent.name);
    if (ent.isFile() && ent.name === HOLD_FILE) {
      const st = await statOrNull(path);
      if (st?.isFile()) return true;
      continue;
    }
    if (ent.isDirectory() && !HOLD_SKIP_DIRS.has(ent.name)) {
      if (await hasHoldFile(path, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * The run's declared epoch, or null. A manifest that cannot be read classifies
 * as legacy by epoch alone — which is exactly why the caller must NOT trust the
 * classification without a readable manifest: an unreadable run is refused, not
 * moved, because nothing can be asserted about what it holds.
 */
async function readSystemEpoch(manifestPath) {
  try {
    const data = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    return typeof data?.system_epoch === "string" ? data.system_epoch : null;
  } catch {
    return undefined; // distinct from null: unreadable
  }
}

/**
 * A deterministic digest of a whole directory tree: every relative path, every
 * file's bytes, every symlink's target. Used to prove a cross-device copy
 * before the source is removed.
 */
async function hashTree(root) {
  const hash = createHash("sha256");
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const posix = prefix ? `${prefix}/${ent.name}` : ent.name;
      const path = join(dir, ent.name);
      if (ent.isDirectory()) {
        hash.update(`d ${posix}\n`);
        await walk(path, posix);
      } else if (ent.isSymbolicLink()) {
        hash.update(`l ${posix} ${await fs.readlink(path)}\n`);
      } else if (ent.isFile()) {
        const buf = await fs.readFile(path);
        hash.update(`f ${posix} ${buf.length}\n`);
        hash.update(buf);
      }
    }
  }
  await walk(root, "");
  return hash.digest("hex");
}

/**
 * Cross-device fallback: copy, prove the copy byte-for-byte, and only then
 * remove the source. A copy that does not match is a hard failure — the source
 * is left exactly where it was.
 */
async function moveAcrossDevices(src, dest) {
  const before = await hashTree(src);
  await fs.cp(src, dest, { recursive: true, preserveTimestamps: true });
  const after = await hashTree(dest);
  if (before !== after) {
    await fs.rm(dest, { recursive: true, force: true });
    throw new Error(`copy verification failed for ${src} — source left in place`);
  }
  await fs.rm(src, { recursive: true, force: true });
}

/**
 * Move every legacy run out of the living runs root.
 *
 * @param {{
 *   runsRoot: string,
 *   benchRoot: string,
 *   dryRun?: boolean,
 *   liveRunDirs?: string[],
 * }} input `liveRunDirs` are runs-root-relative dirs of runs in flight.
 * @returns {Promise<{ ok: true, moved: number, skipped: {dir: string, reason: string}[], archive_root: string }>}
 */
export async function archiveHistorical({
  runsRoot,
  benchRoot,
  dryRun = false,
  liveRunDirs = [],
}) {
  const archive = archiveRoot(benchRoot);

  // A malformed pointer throws: guessing which tree is live could move the
  // live tree's campaigns, so the whole verb refuses instead.
  const active = await activeTreeId(runsRoot);

  const live = liveRunDirs
    .filter((d) => typeof d === "string" && d !== "")
    .map((d) => toPosix(d).replace(/^\.\//, ""));

  // Only the living root: backups/ and runs-archive/ are never walked.
  const campaigns = await listLiveCampaignDirs(runsRoot);

  const skipped = [];
  const candidates = [];

  for (const campaign of campaigns.sort((a, b) => a.relative.localeCompare(b.relative))) {
    const relative = toPosix(campaign.relative);
    const head = relative.split("/")[0];

    // (a) the active tree is the live tree — its campaigns are never archived.
    if (active && head === active) {
      skipped.push({ dir: relative, reason: "active_tree" });
      continue;
    }

    // (b) a run with a process is live, whatever it declares. Containment in
    // either direction, so a run_dir that is a campaign's ancestor (or child)
    // is refused too.
    const isLive = live.some(
      (d) => d === relative || relative.startsWith(`${d}/`) || d.startsWith(`${relative}/`),
    );
    if (isLive) {
      skipped.push({ dir: relative, reason: "live_run" });
      continue;
    }

    // (c) a hold is a person watching this run right now.
    if (await hasHoldFile(campaign.dir)) {
      skipped.push({ dir: relative, reason: "held" });
      continue;
    }

    // The epoch is the run's own label; a manifest we cannot parse is refused
    // rather than classified by omission.
    const systemEpoch = await readSystemEpoch(join(campaign.dir, "manifest.json"));
    if (systemEpoch === undefined) {
      skipped.push({ dir: relative, reason: "manifest_unreadable" });
      continue;
    }

    // (d) v2 runs stay: defensive, they are not candidates by epoch.
    if (classifyRun({ relative, systemEpoch }) !== "legacy") {
      skipped.push({ dir: relative, reason: "v2_run" });
      continue;
    }

    // Never clobber an archive that already holds this relative path.
    const dest = join(archive, ...relative.split("/"));
    if (await statOrNull(dest)) {
      skipped.push({ dir: relative, reason: "destination_exists" });
      continue;
    }

    candidates.push({ relative, src: campaign.dir, dest });
  }

  if (dryRun) {
    return { ok: true, moved: candidates.length, skipped, archive_root: archive };
  }

  let moved = 0;
  for (const candidate of candidates) {
    await fs.mkdir(dirname(candidate.dest), { recursive: true });
    try {
      // Same filesystem (runs/ and its sibling live under one bench root):
      // atomic, and the source disappears in the same operation.
      await fs.rename(candidate.src, candidate.dest);
    } catch (err) {
      if (err?.code !== "EXDEV") throw err;
      await moveAcrossDevices(candidate.src, candidate.dest);
    }
    moved += 1;
  }

  return { ok: true, moved, skipped, archive_root: archive };
}
