// ─────────────────────────────────────────────────────────────────────────────
// BENCHMARK TREE — where a campaign lands, and how a wipe becomes cheap
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
//
// Campaigns used to sit FLAT under `runs/`, one directory per model
// (`runs/cumulative-<model>`), and a "wipe" meant renaming a directory into the
// dotted archive convention. Two things were wrong with that:
//
//   1. A wipe was an AGENT ACTION. Clearing a dirty tree meant asking something
//      with a shell to delete directories — the same class of act that
//      destroyed the 2026-08-19 run records. The operator had no button.
//   2. Debris outlived the wipe. Top-level `off-cell-<ts>.log` files are
//      written beside the campaign directories, so a wiped bench still reported
//      a run in progress until someone hand-deleted them (runstate.mjs:75).
//
// ── THE LAYOUT ──────────────────────────────────────────────────────────────
//
//   runs/
//     active-tree.json                  ← the pointer. One line of truth.
//     1787310000/                       ← a TREE. Unix seconds, minted on reset.
//       local/                          ← substrate: local | cloud
//         local-llm-proxy/              ← router
//           omlx/                       ← provider
//             qwen3-6-35b-a3b-bench/    ← model  ← THE CAMPAIGN HOME
//               manifest.json
//               manifest.status.jsonl
//               memoryOFF/cell-0000/
//               memoryON/cell-0007/
//
// The campaign home is the MODEL directory, and that placement is load-bearing.
// One manifest carries a full schedule — OFF baseline first, then the seeded ON
// phase (`cumulative/ordering.py:build_schedule`) — so memory mode is a property
// of a CELL, not of a campaign. Hoisting `memoryOFF/memoryON` above the model
// would split one manifest across two directories and break RC-5 (one run
// directory, one manifest, one status stream) along with the roster-hash freeze
// the sequencer re-checks on every launch.
//
// ── RESET ROLLS FORWARD. IT NEVER UNLINKS. ──────────────────────────────────
//
// Minting a new tree makes the previous one INERT — no reader resolves into it,
// because every reader resolves through the pointer. Nothing is deleted, so a
// misclicked reset costs a directory, not a measurement. This is deliberate: on
// this bench an irreversible unlink has already cost a night of records once.
//
// ── DOTS AND SLASHES DIE HERE ───────────────────────────────────────────────
//
// `isArchivedRun()` (baselines.mjs:131) reads ANY dot in a run directory name as
// the archive convention, so a model named `qwen3.6-…` would land in a directory
// that every floor reader treats as archived and skips. A slash is not a name at
// all — it is another level of tree. Both are substituted, in every segment.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { join, sep } from "node:path";

export const TREE_POINTER = "active-tree.json";

/** Where a reset parks the previous bench. Never read as bench data. */
export const BACKUPS_DIR = "backups";

// Deep enough for <tree>/<substrate>/<router>/<provider>/<model>, and no
// deeper. An unbounded walk over a runs root would descend into `sessions/`,
// every cell's `worktree/`, and its node_modules — turning a 2s board poll into
// a filesystem crawl.
const CAMPAIGN_MAX_DEPTH = 5;

/**
 * One path segment, safe for this tree.
 *
 * Shares its substitution with `campaignDirName` in campaign.mjs by intent: dots
 * read as the archive convention, slashes read as depth. Empty input yields a
 * NAMED placeholder rather than an empty segment, because an empty segment
 * silently collapses a level and lands the campaign one directory too high.
 */
export function segment(value, fallback = "unknown") {
  const cleaned = String(value ?? "").trim().replace(/[./\\]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

/**
 * Split a subject into the router / provider / model triple the tree wants.
 *
 * TOTAL BY CONSTRUCTION — every shape the harness can hand us resolves, because
 * a subject that fails to resolve here would land its campaign somewhere no
 * reader looks and present as a run that produced nothing.
 *
 *   cloud  — the key is `{provider}/{model}` under a router (default
 *            `orcarouter`), exactly what `_compose_cloud_slug` composes.
 *   local  — bench aliases are BARE (`qwen3.6-35b-a3b-bench`); the proxy is the
 *            normalizer and the resident identity is read back from the API
 *            response, so the router is the proxy and the provider is its
 *            backend. An explicit `local-llm-proxy/<provider>/<model>` slug is
 *            honoured as written when one appears.
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
    // The proxy's backend, stated rather than inferred: campaigns report
    // `backend omlx` and the stack is opencode → proxy :4545 → oMLX.
    provider: "omlx",
    model: segment(parts[0] ?? model, "unknown-model"),
  };
}

/** The tree-relative segments of a campaign home, without the tree id. */
export function campaignSegments(subject) {
  const t = subjectTriple(subject);
  return [t.substrate, t.router, t.provider, t.model];
}

/** Mode directory for a cell. The only two values, spelled the operator's way. */
export function modeDir(memoryMode) {
  const m = String(memoryMode ?? "").trim().toLowerCase();
  if (m === "on" || m === "memoryon") return "memoryON";
  if (m === "off" || m === "memoryoff") return "memoryOFF";
  return "memoryUNKNOWN";
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
 * The pointer, or null when no tree has ever been minted.
 *
 * A MALFORMED POINTER IS NOT AN ABSENT ONE. Absent means "pre-tree bench, use
 * the legacy flat layout". Malformed means a file IS there and cannot be read —
 * returning null there would silently route a live campaign into a brand new
 * tree and present as the entire run history having vanished, so it raises.
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
 * Mint a new tree and point at it. THE WHOLE OF "RESET".
 *
 * Creates the directory, rewrites the pointer, and returns both ids so the
 * caller can tell the operator what just became inert. Previous trees are left
 * exactly where they are — see the header.
 *
 * COLLISION IS AN ERROR, NOT A NUDGE. Two resets inside one second would
 * otherwise silently re-point at a tree that already holds a campaign, and the
 * second operator would be writing into the first one's measurements.
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
    // An unreadable pointer must not block minting a CLEAN tree — that is
    // precisely the state an operator reaches for reset to escape.
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
 * The tree a campaign-relative path belongs to, or null for a legacy flat one.
 *
 * Uses the platform separator rather than a literal "/" — `relative` is built
 * with `path.sep`, and a hardcoded slash would silently classify every campaign
 * as legacy on any platform where those differ.
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
 * Every campaign directory under `runsRoot`, nested or flat.
 *
 * ── WHY THIS IS NOT `readdir` ───────────────────────────────────────────────
 *
 * Six readers scanned the runs root exactly one level deep. `campaign.mjs`
 * already warned what that costs: a campaign nested under a parent that holds no
 * manifest is walked straight past, and its measurements are invisible on the
 * board it was launched from. The tree makes every campaign nested, so all six
 * had to learn depth or all six would go blind at once.
 *
 * ── LEGACY CAMPAIGNS STILL RESOLVE ──────────────────────────────────────────
 *
 * The walk yields flat `runs/cumulative-<model>` directories exactly as before,
 * because it tests for a manifest rather than for a position. Pre-tree history
 * stays on the board instead of disappearing the moment this ships.
 *
 * Returns entries shaped like the `readdir` entries they replace — `name` is the
 * campaign's own directory name, `relative` its path from the runs root — so a
 * caller's existing `ent.name` logic keeps meaning what it meant.
 */
export async function listCampaignDirs(
  runsRoot,
  { maxDepth = CAMPAIGN_MAX_DEPTH, includeBackups = false } = {},
) {
  const found = [];

  // A reset parks the outgoing tree at `backups/<newTreeId>/<oldTreeId>/…`, so
  // an archived campaign sits exactly TWO segments deeper than a live one. The
  // extra budget is granted only below `backups/` — raising the global limit
  // would let the live walk descend two levels further for no reason, and the
  // limit exists to keep this off `sessions/` and every cell's node_modules.
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
      // THE BACKUP FOLDER IS NOT THE BENCH. Descending into it would surface
      // every backed-up result as a live one, so a reset would clear the board
      // and the very next poll would repopulate it from the backup — the reset
      // undoing itself, with no error anywhere.
      //
      // `includeBackups` is for the ONE caller that legitimately wants the
      // archive: /history, whose whole subject is prior runs. It is opt-in and
      // off by default precisely so the paragraph above keeps holding for every
      // board reader. A reset moves the outgoing tree to
      // `backups/<newTreeId>/<oldTreeId>/…`, so without this the page shows the
      // live tree alone — which is one run out of a dozen.
      if (depth === 0 && ent.name === BACKUPS_DIR && !includeBackups) continue;
      const child = join(dir, ent.name);
      const rel = relative ? `${relative}${sep}${ent.name}` : ent.name;
      const childBonus =
        depth === 0 && ent.name === BACKUPS_DIR ? BACKUPS_DEPTH_OFFSET : bonus;

      if (await isCampaignDir(child)) {
        found.push({ name: ent.name, dir: child, relative: rel, depth: depth + 1 });
        // A campaign never contains another campaign. Descending further would
        // walk `sessions/`, every cell worktree, and its node_modules.
        continue;
      }
      if (depth + 1 < maxDepth + childBonus) await walk(child, rel, depth + 1, childBonus);
    }
  }

  await walk(runsRoot, "", 0);
  return found;
}

/**
 * Campaign directories in the LIVE tree only, plus legacy flat ones.
 *
 * This is what a board should read. Inert trees are excluded by construction —
 * that exclusion is the entire mechanism by which reset "wipes" without
 * deleting, so it lives in one function rather than in each caller.
 */
export async function listLiveCampaignDirs(runsRoot, opts = {}) {
  let active = null;
  try {
    active = await activeTreeId(runsRoot);
  } catch {
    // Unreadable pointer: show everything rather than nothing. A board that
    // hides live measurements is worse than one showing an inert campaign.
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
 * The live tree, minting one if this bench has never had a tree.
 *
 * SELF-INITIALISING ON PURPOSE. Requiring an operator to press reset before the
 * first run would make the first run of a fresh checkout fail on a missing
 * directory — a button that must be pressed before anything works is a trap, not
 * a safeguard. Reset then means what it says: start a NEW tree, not the first.
 */
export async function ensureTree(runsRoot, { now = Date.now() } = {}) {
  const existing = await activeTreeId(runsRoot);
  if (existing) return { active: existing, previous: null, dir: join(runsRoot, existing), minted: false };
  const minted = await mintTree(runsRoot, { now });
  return { ...minted, minted: true };
}

// ═════════════════════════════════════════════════════════════════════════════
// RESET ALL BENCHMARK DATA
//
// ── WHY THE TREE ALONE WAS NOT A RESET ──────────────────────────────────────
//
// Rolling the tree forward retires the RESULTS and nothing else. Measured on a
// live bench: after a reset the board still showed two baselines, a 65/71 gate
// wall and a transfer curve — because `baselines.json`, the pre-tree
// `cumulative-*` result folders and the
// `off-cell-*.log` run logs all sit BESIDE the tree, not inside it. An operator
// pressing reset and still seeing their old numbers has been told the bench is
// clean when it is not, which is the worst failure this control can have.
//
// ── INCLUSION, NEVER EXCLUSION ──────────────────────────────────────────────
//
// Only names positively recognised as benchmark data are moved. The tempting
// shape is the opposite — sweep everything except a skip list — and it is the
// dangerous one: `runs/mcp4550.pid` holds the PID of the RUNNING bench MCP on
// :4550 and `runs/mcp4550.log` is being appended to by it right now. Moving
// either orphans a live process. A skip list forgets; an allow list simply
// leaves an unrecognised file alone, which costs nothing.
//
// Tooling output stays too — pytest, redeploy and rebuild logs are about the
// SOFTWARE, not about a measurement, and an operator resetting the benchmark is
// not asking to lose their build history.
//
// ── NOTHING IS DELETED, STILL ───────────────────────────────────────────────
//
// Everything moves into `runs/backups/<unix-seconds>/`, one folder per reset,
// with names preserved. "Reset" and "back up" are the same act here, which is
// why the confirmation can promise both without qualification.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Is this entry at the runs root a benchmark MEASUREMENT, as opposed to live
 * process state or tooling output?
 *
 * Each branch names what it protects, because the cost of a wrong answer is
 * asymmetric: sweeping too little leaves a stale row on the board, sweeping too
 * much breaks the running bench.
 */
export function isBenchmarkData(name) {
  const n = String(name ?? "");

  // The backup folder is never swept into itself.
  if (n === BACKUPS_DIR) return false;

  // LIVE PROCESS STATE. `mcp4550.pid` is the running bench MCP's own handle;
  // moving it orphans :4550 and the next `bench-mcp.sh stop` cannot find it.
  if (n.startsWith("mcp4550.")) return false;

  // TOOLING OUTPUT — about the software, not about a measurement.
  if (/^(pytest|redeploy|dashboard-rebuild|worker-rebuild|hold-ui-verify)[-.]/.test(n)) return false;
  if (n === "control-plane.log") return false;
  if (n === "proxy-e2e") return false;

  // ── MEASUREMENTS AND THE STATE DERIVED FROM THEM ──────────────────────────
  if (isTreeId(n)) return true;                       // a results tree
  if (n === TREE_POINTER) return true;                // which tree was live
  if (n === "results-ledger.jsonl") return true;      // the run-results ledger (archived here on reset, from data/)
  if (n === "baselines.json") return true;            // the floor
  if (n.startsWith("cumulative")) return true;        // pre-tree result folders
  if (/^(off|on)-cell-.*\.log$/.test(n) || /^cell-.*\.log$/.test(n)) return true;
  if (n === "master" || n === "failed" || n === "failed-starts" || n === "backgammon") return true;

  // UNRECOGNISED STAYS PUT. See the header — this is the safe direction.
  return false;
}

/**
 * What a reset would move, without moving it.
 *
 * Used by the confirmation so the operator reads the ACTUAL list rather than a
 * description of it — the same reason the run restatement is composed server
 * side.
 */
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
 * RESET: back everything up, then start a brand new tree.
 *
 * Ordered so a failure cannot leave the bench half-reset in a way that reads as
 * clean: the backup directory is created first, every move is completed, and
 * only THEN is a fresh tree minted. A crash before the mint leaves no pointer,
 * which the resolver already treats as "no tree yet" and self-heals on the next
 * run rather than writing into a directory that is half gone.
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
    // Names are preserved so the backup is browsable as the runs root it was.
    await fs.rename(join(runsRoot, name), join(backupDir, name));
    moved.push(name);
  }

  return { backup: backupDir, backup_id: stamp, moved, kept: keeps };
}

/**
 * RESET: back everything up, then start a brand new tree.
 *
 * The sweep is separated from the mint because RESTORE needs the sweep alone —
 * it parks the live bench and then moves a chosen backup in, and a tree minted
 * in between would be immediately overwritten by the restored pointer and left
 * behind as an empty directory.
 *
 * Ordered so a failure cannot leave the bench half-reset in a way that reads as
 * clean: every move completes before a fresh tree is minted. A crash in between
 * leaves no pointer, which the resolver already treats as "no tree yet" and
 * self-heals on the next run.
 */
export async function resetAll(runsRoot, { now = Date.now() } = {}) {
  const swept = await sweepToBackup(runsRoot, { now });
  const minted = await mintTree(runsRoot, { now });
  return { ...swept, active: minted.active };
}
