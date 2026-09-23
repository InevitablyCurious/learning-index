// THE CELL REGISTRY — the durable launch-record store beneath the run ledger.
// One JSON file per launched cell: runs/<treeId>/launches/<run_id>.json when
// the cell's run_dir starts with a tree id, else the flat runs/launches/. The
// ledger (run-ledger.mjs) is a write-through cache over this store: a control-
// plane restart re-adopts every unfinished cell from disk, and a cell that
// ends is recorded as ended with a reason — never erased. RESET archives
// records with the whole tree dir; nothing here ever deletes.
//
// Zero dependencies (node builtins only), so this module can never participate
// in an import cycle. All writes are atomic — temp file + rename — so a crash
// mid-write can never leave a half record.

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The tree pointer's file name (tree.mjs TREE_POINTER) and the tree-id shape
// (tree.mjs isTreeId): unix seconds, 9-11 digits. Duplicated deliberately to
// keep this module dependency-free.
const TREE_POINTER = "active-tree.json";
const TREE_ID = /^\d{9,11}$/;

/**
 * The durable record of one launched cell.
 *
 * @typedef {Object} LaunchRecord
 * @property {string} run_id
 * @property {number} sequence_index
 * @property {string} model
 * @property {'off'|'on'} arm
 * @property {string} kind
 * @property {string|null} org
 * @property {string|null} context
 * @property {string|null} manifest_arg
 * @property {number|null} pid
 * @property {number|null} started_at
 * @property {string|null} log_path
 * @property {string|null} run_dir
 * @property {boolean} finished
 * @property {string|null} terminal_status
 * @property {boolean|null} terminal_ok
 * @property {null|{at:number,code:number|null,signal:string|null,reason:string,log_tail:string|null}} ended
 */

/** The first /-separated segment of a run_dir when it is a tree id, else null. */
function treeIdOf(runDir) {
  const first = String(runDir ?? "").split("/")[0];
  return TREE_ID.test(first) ? first : null;
}

/**
 * The launches dir for a cell's run_dir: under its tree when the run_dir's
 * first segment is a tree id, else the flat legacy dir. Absolute.
 */
export function launchesDirFor(runsRoot, runDir) {
  const treeId = treeIdOf(runDir);
  return treeId ? join(runsRoot, treeId, "launches") : join(runsRoot, "launches");
}

/** The durable record's path: <launchesDir>/<run_id>.json. Absolute. */
export function recordPathFor(runsRoot, runDir, runId) {
  return join(launchesDirFor(runsRoot, runDir), `${runId}.json`);
}

/**
 * Atomic durable write: mkdir the parents, write <path>.tmp, rename over
 * <path>. A crash mid-write leaves the tmp file and any previous record
 * intact. Fail loud: an unwritable disk throws to the caller.
 * @returns {string} the record's path
 */
export function writeRecord(runsRoot, runDir, record) {
  const path = recordPathFor(runsRoot, runDir, record.run_id);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

/** The parsed record, or null. Never throws: missing or corrupt is null. */
export function readRecord(runsRoot, runDir, runId) {
  try {
    return JSON.parse(readFileSync(recordPathFor(runsRoot, runDir, runId), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Merge the end of a cell into its durable record: { finished: true, ended }.
 * The end of a cell is a fact ADDED to its record, never a deletion.
 * @returns {LaunchRecord|null} the merged record, or null when no record
 *   exists — nothing is written then; a partial record would be an invented
 *   history.
 */
export function endRecord(runsRoot, runDir, runId, ended) {
  const existing = readRecord(runsRoot, runDir, runId);
  if (!existing || typeof existing !== "object") return null;
  const merged = { ...existing, finished: true, ended };
  writeRecord(runsRoot, runDir, merged);
  return merged;
}

/**
 * The active tree id from the pointer, or null (no tree / legacy flat layout).
 * Synchronous: listRecords runs inside the ledger's sync startup hydrate. A
 * missing or malformed pointer is null here — this is a read of what exists,
 * never a routing decision (tree.mjs readTreePointer is the one that refuses
 * to guess).
 */
function activeTreeIdSync(runsRoot) {
  try {
    const raw = JSON.parse(readFileSync(join(runsRoot, TREE_POINTER), "utf8"));
    return TREE_ID.test(String(raw?.active ?? "")) ? String(raw.active) : null;
  } catch {
    return null;
  }
}

/** One dir's *.json records, parsed. Never throws; unparseable files skip. */
function recordsIn(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    // "<run_id>.json" only — a mid-write "<run_id>.json.tmp" is not a record.
    if (!name.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (rec && typeof rec === "object") out.push(rec);
    } catch {
      // One corrupt record must not blind the whole hydrate.
    }
  }
  return out;
}

/**
 * EVERY durable record: the ACTIVE tree's launches dir plus the flat
 * runs/launches/. A reset archives the old tree with its records inside, so
 * the active tree plus the flat legacy dir is the complete live view.
 * Never throws.
 * @returns {LaunchRecord[]}
 */
export function listRecords(runsRoot) {
  const dirs = [];
  const treeId = activeTreeIdSync(runsRoot);
  if (treeId) dirs.push(join(runsRoot, treeId, "launches"));
  dirs.push(join(runsRoot, "launches"));
  return dirs.flatMap(recordsIn);
}
