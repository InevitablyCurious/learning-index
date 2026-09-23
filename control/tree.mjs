// BENCHMARK TREE — where a campaign lands, and how a reset works.
//
//   runs/
//     active-tree.json                  ← the pointer
//     1787310000/                       ← a tree (unix seconds, minted on reset)
//       local/local-llm-proxy/omlx/     ← substrate / router / provider
//         qwen3-6-35b-a3b-bench/        ← model: the campaign home
//           manifest.json, manifest.status.jsonl
//           memoryOFF/cell-0000/  memoryON/cell-0007/
//
// The campaign home is the model folder: one manifest schedules both arms, so
// memory mode belongs to a cell, not a campaign. Readers resolve through the
// pointer, so minting a new tree makes the old one inert without deleting
// anything. Dots and slashes in names are replaced in every segment (a dot reads
// as the archive convention; a slash is a level).

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { join, sep } from "node:path";

export const TREE_POINTER = "active-tree.json";

/** Where a reset parks the previous bench. Never read as bench data. */
export const BACKUPS_DIR = "backups";

// Deep enough for <tree>/<substrate>/<router>/<provider>/<model>; deeper
// would crawl every cell's worktree and node_modules.
const CAMPAIGN_MAX_DEPTH = 5;

/**
 * One path segment, safe for this tree. Empty input becomes a named
 * placeholder, never an empty segment (which would collapse a level).
 */
export function segment(value, fallback = "unknown") {
  const cleaned = String(value ?? "").trim().replace(/[./\\]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

/**
 * Subject → router / provider / model. Total: every shape resolves.
 *   cloud  {provider}/{model} under a router (default orcarouter).
 *   local  bare bench alias → local-llm-proxy / omlx / alias; an explicit
 *          local-llm-proxy/<provider>/<model> slug is kept as written.
 */
export function subjectTriple({ kind, model, cloud = null, router = null } = {}) {
  const isCloud = String(kind ?? "local") === "cloud";

  if (isCloud) {
    return {
      substrate: "cloud",
      router: segment(router ?? cloud?.router ?? "orcarouter", "orcarouter"),
      provider: segment(cloud?.provider, "unknown-provider"),
      model: segment(cloud?.model ?? model, "unknown-model"),
    };
  }

  const parts = String(model ?? "").split("/").filter(Boolean);
  if (parts.length >= 3) {
    return {
      substrate: "local",
      router: segment(parts[0]),
      provider: segment(parts[1]),
      model: segment(parts.slice(2).join("-")),
    };
  }
  if (parts.length === 2) {
    return {
      substrate: "local",
      router: segment(router ?? "local-llm-proxy", "local-llm-proxy"),
      provider: segment(parts[0]),
      model: segment(parts[1]),
    };
  }
  return {
    substrate: "local",
    router: segment(router ?? "local-llm-proxy", "local-llm-proxy"),
    // The proxy's backend (opencode → proxy :4545 → oMLX).
    provider: "omlx",
    model: segment(parts[0] ?? model, "unknown-model"),
  };
}

/** The tree-relative segments of a campaign home, without the tree id. */
export function campaignSegments(subject) {
  const t = subjectTriple(subject);
  return [t.substrate, t.router, t.provider, t.model];
}

// ── the pointer ─────────────────────────────────────────────────────────────

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Is this directory name a tree id? Unix seconds, nothing else. */
export function isTreeId(name) {
  return /^\d{9,11}$/.test(String(name ?? ""));
}

/**
 * The pointer, or null when no tree was ever minted (legacy flat layout). A
 * malformed pointer throws: guessing would route a campaign into a new tree.
 */
export async function readTreePointer(runsRoot) {
  const path = join(runsRoot, TREE_POINTER);
  if (!existsSync(path)) return null;
  const raw = await readJsonOrNull(path);
  if (!raw || typeof raw !== "object" || !isTreeId(raw.active)) {
    throw new Error(`${TREE_POINTER} is present but unreadable — refusing to guess which tree is live`);
  }
  return {
    active: String(raw.active),
    created_at: raw.created_at ?? null,
    history: Array.isArray(raw.history) ? raw.history.map(String) : [],
  };
}

/** The live tree id, or null on a bench that has never been reset. */
export async function activeTreeId(runsRoot) {
  return (await readTreePointer(runsRoot))?.active ?? null;
}

/** Absolute path of the live tree, or null. */
export async function activeTreeRoot(runsRoot) {
  const id = await activeTreeId(runsRoot);
  return id ? join(runsRoot, id) : null;
}

/**
 * Mint a new tree and point at it. Previous trees stay where they are. Two
 * resets in one second is an error, never a re-point at an occupied tree.
 */
export async function mintTree(runsRoot, { now = Date.now() } = {}) {
  const id = String(Math.floor(now / 1000));
  const dir = join(runsRoot, id);
  if (existsSync(dir)) {
    throw new Error(`tree ${id} already exists — wait a second and reset again`);
  }

  let previous = null;
  let history = [];
  try {
    const pointer = await readTreePointer(runsRoot);
    previous = pointer?.active ?? null;
    history = pointer?.history ?? [];
  } catch {
    // An unreadable pointer must not block minting a clean tree.
    previous = null;
  }

  await fs.mkdir(dir, { recursive: true });
  const next = {
    active: id,
    created_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
    history: previous ? [previous, ...history].slice(0, 64) : history.slice(0, 64),
  };
  // Written whole, then renamed, so a reader never sees half a pointer.
  const tmp = join(runsRoot, `.${TREE_POINTER}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  await fs.rename(tmp, join(runsRoot, TREE_POINTER));

  return { active: id, previous, dir };
}

// ── discovery ───────────────────────────────────────────────────────────────

/**
 * The tree a campaign-relative path belongs to, or null for a flat one
 * (split on path.sep, as the path was built).
 */
export function campaignTreeId(relative) {
  const head = String(relative ?? "").split(sep)[0];
  return isTreeId(head) ? head : null;
}

/** A directory is a campaign home when it carries a manifest or a status stream. */
async function isCampaignDir(dir) {
  return existsSync(join(dir, "manifest.json")) || existsSync(join(dir, "manifest.status.jsonl"));
}

/**
 * Every campaign folder under runsRoot, nested or flat (a folder holding a
 * manifest). Entries carry `name` and `relative` (path from the runs root).
 */
export async function listCampaignDirs(
  runsRoot,
  { maxDepth = CAMPAIGN_MAX_DEPTH, includeBackups = false } = {},
) {
  const found = [];

  // Backups sit two levels deeper (backups/<new>/<old>/…); the extra depth is
  // granted only under backups/.
  const BACKUPS_DEPTH_OFFSET = 2;

  async function walk(dir, relative, depth, bonus = 0) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      // backups/ is never bench data (a reset would undo itself on the next poll).
      // includeBackups is for /history only.
      if (depth === 0 && ent.name === BACKUPS_DIR && !includeBackups) continue;
      const child = join(dir, ent.name);
      const rel = relative ? `${relative}${sep}${ent.name}` : ent.name;
      const childBonus =
        depth === 0 && ent.name === BACKUPS_DIR ? BACKUPS_DEPTH_OFFSET : bonus;

      if (await isCampaignDir(child)) {
        found.push({ name: ent.name, dir: child, relative: rel, depth: depth + 1 });
        // A campaign never contains another campaign.
        continue;
      }
      if (depth + 1 < maxDepth + childBonus) await walk(child, rel, depth + 1, childBonus);
    }
  }

  await walk(runsRoot, "", 0);
  return found;
}

/**
 * Campaign folders in the live tree only, plus legacy flat ones: what every
 * board reader should use. Excluding inert trees is what makes reset a wipe.
 */
export async function listLiveCampaignDirs(runsRoot, opts = {}) {
  let active = null;
  try {
    active = await activeTreeId(runsRoot);
  } catch {
    // Unreadable pointer: show everything rather than nothing.
    return listCampaignDirs(runsRoot, opts);
  }
  const all = await listCampaignDirs(runsRoot, opts);
  if (!active) return all;
  return all.filter((c) => {
    const head = c.relative.split(sep)[0];
    return !isTreeId(head) || head === active;
  });
}

/**
 * The live tree, minted on first use, so a fresh checkout's first run works
 * without pressing reset.
 */
export async function ensureTree(runsRoot, { now = Date.now() } = {}) {
  const existing = await activeTreeId(runsRoot);
  if (existing) return { active: existing, previous: null, dir: join(runsRoot, existing), minted: false };
  const minted = await mintTree(runsRoot, { now });
  return { ...minted, minted: true };
}

// ═══ RESET ALL BENCHMARK DATA ═══
// Rolling the tree forward is not enough: baselines.json, legacy result folders
// and run logs sit beside the tree. Reset moves every entry positively
// recognised as benchmark data into runs/backups/<unix-seconds>/, names
// preserved. An allow list, never a skip list: live process state (the bench
// MCP's pid and log) and tooling logs stay put. Nothing is deleted.

/**
 * Is this runs-root entry a benchmark measurement (vs live process state or
 * tooling output)? Sweeping too much breaks the running bench.
 */
export function isBenchmarkData(name) {
  const n = String(name ?? "");

  // The backup folder is never swept into itself.
  if (n === BACKUPS_DIR) return false;

  // Live process state: the running bench MCP's handle.
  if (n.startsWith("mcp4550.")) return false;

  // Tooling output: about the software, not a measurement.
  if (/^(pytest|redeploy|dashboard-rebuild|worker-rebuild|hold-ui-verify)[-.]/.test(n)) return false;
  if (n === "control-plane.log") return false;
  if (n === "proxy-e2e") return false;

  // ── measurements and the state derived from them ──
  if (isTreeId(n)) return true;                       // a results tree
  if (n === TREE_POINTER) return true;                // which tree was live
  if (n === "results-ledger.jsonl") return true;      // the run-results ledger (archived here on reset, from data/)
  if (n === "baselines.json") return true;            // the floor
  if (n.startsWith("cumulative")) return true;        // pre-tree result folders
  if (n === "launches") return true;                  // durable cell launch-record dir (flat layout): a RESET must archive it, never leave it behind or delete it
  if (/^(off|on)-cell-.*\.log$/.test(n) || /^cell-.*\.log$/.test(n)) return true;
  if (n === "master" || n === "failed" || n === "failed-starts" || n === "backgammon") return true;

  // Unrecognised stays put.
  return false;
}

/** What a reset would move, without moving it (shown in the confirmation). */
export async function planReset(runsRoot) {
  let entries = [];
  try {
    entries = await fs.readdir(runsRoot, { withFileTypes: true });
  } catch {
    return { moves: [], keeps: [] };
  }
  const moves = [];
  const keeps = [];
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    (isBenchmarkData(ent.name) ? moves : keeps).push(ent.name);
  }
  moves.sort();
  keeps.sort();
  return { moves, keeps };
}

/**
 * Move every benchmark-data entry into a new backups/<ts>/ folder. No tree is
 * minted here (restore needs the sweep alone).
 */
export async function sweepToBackup(runsRoot, { now = Date.now() } = {}) {
  const stamp = String(Math.floor(now / 1000));
  const backupDir = join(runsRoot, BACKUPS_DIR, stamp);
  if (existsSync(backupDir)) {
    throw new Error(`backup ${stamp} already exists — wait a second and try again`);
  }

  const { moves, keeps } = await planReset(runsRoot);
  await fs.mkdir(backupDir, { recursive: true });

  const moved = [];
  for (const name of moves) {
    // Names preserved: the backup reads like the runs root it was.
    await fs.rename(join(runsRoot, name), join(backupDir, name));
    moved.push(name);
  }

  return { backup: backupDir, backup_id: stamp, moved, kept: keeps };
}

/**
 * RESET: sweep to backup, then mint a new tree. A crash between the two leaves
 * no pointer, which reads as "no tree yet" and self-heals on the next run.
 */
export async function resetAll(runsRoot, { now = Date.now() } = {}) {
  const swept = await sweepToBackup(runsRoot, { now });
  const minted = await mintTree(runsRoot, { now });
  return { ...swept, active: minted.active };
}
