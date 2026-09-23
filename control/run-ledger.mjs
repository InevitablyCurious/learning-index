// THE RUN LEDGER — the live-cell cache over the durable cell registry
// (cell-registry.mjs). Every launched cell is written through to disk at
// spawn, so a control-plane restart loses no pid: initLedger re-adopts the
// unfinished cells from their durable records. The Map below holds ONLY live
// records (finished === false) — a finished or ended cell lives on disk, not
// in memory; that is the bound on this module's state. Every read computes
// from the Map, never from a second copy.

import { randomUUID } from "node:crypto";

import { endRecord, listRecords, writeRecord } from "./cell-registry.mjs";

/**
 * One run slot in the ledger. This is the contract other modules read.
 *
 * @typedef {Object} RunRecord
 * @property {string} run_id          control-plane run id — the ledger key
 * @property {number} sequence_index  cell position, allocated by campaign.mjs
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

/** The runs root the durable registry writes under; null until initLedger. */
let RUNS_ROOT = null;

/** @type {Map<string, RunRecord>} run_id → LIVE record. The only in-memory state. */
const runs = new Map();

/**
 * Bind the ledger to its durable store and hydrate from it: every record on
 * disk with `finished === false` becomes a live slot again. Cells are spawned
 * detached, so they outlive the control plane — this is how a restart
 * re-adopts them instead of losing their pids. Called once, from initState
 * (state.mjs), before anything reads the ledger.
 */
export function initLedger(runsRoot) {
  RUNS_ROOT = runsRoot;
  for (const rec of listRecords(runsRoot)) {
    if (rec?.finished === false) runs.set(rec.run_id, rec);
  }
}

/** A fresh unique control-plane run id. */
export function newRunId() {
  return randomUUID();
}

/**
 * Insert (or overwrite, by `record.run_id`) one live slot — write-through:
 * the durable record lands on disk BEFORE the cache slot, so a crash after
 * spawn can never leave a cell with no record.
 * @param {RunRecord} record
 * @returns {RunRecord} the stored record
 */
export function registerRun(record) {
  // Fail loud: a record without a key cannot occupy a slot, and keying the
  // Map on undefined would be silent corruption.
  if (typeof record?.run_id !== "string" || record.run_id === "") {
    throw new TypeError("registerRun: record.run_id must be a non-empty string");
  }
  if (RUNS_ROOT) writeRecord(RUNS_ROOT, record.run_dir, record);
  runs.set(record.run_id, { ...record, finished: false });
  return record;
}

/**
 * Evict one run slot from the cache — a PURE cache eviction, no disk write.
 * The caller that ends a run writes the durable end itself (cell-registry
 * endRecord) before evicting, so the durable fact and the cache removal are
 * one explicit sequence at the call site, never a hidden side effect here.
 *
 * @param {string} runId
 * @returns {boolean} true if the slot existed, false if runId was absent
 */
export function evictRun(runId) {
  return runs.delete(runId);
}

/**
 * Record a cell's process end — durably. endRecord merges
 * `{ finished:true, ended }` into the on-disk record, so this works even when
 * the cache slot is already gone (a restart, a prior finish); the slot is
 * evicted either way. A cell that ends is recorded as ended with a reason —
 * never erased.
 *
 * @param {string} runId
 * @param {string|null} runDir  the cell's run_dir — resolves the durable record
 * @param {{ reason: string, code?: number|null, signal?: string|null, at?: number, log_tail?: string|null }} ending
 * @returns {boolean} true if a durable record was merged, false if there was
 *   none (or the ledger is unbound — nothing durable was written).
 */
export function recordCellEnded(runId, runDir, { reason, code = null, signal = null, at = Date.now(), log_tail = null }) {
  const merged = RUNS_ROOT
    ? endRecord(RUNS_ROOT, runDir, runId, { at, code, signal, reason, log_tail })
    : null;
  runs.delete(runId);
  return merged !== null;
}

/** @returns {RunRecord|undefined} */
export function getRun(runId) {
  return runs.get(runId);
}

/** Every live record, in insertion order. The Map holds only live slots. */
export function liveRuns() {
  return [...runs.values()];
}

/** How many runs are live. */
export function runCount() {
  return runs.size;
}

/** The distinct models with a live run — the per-model in-flight gate. */
export function inFlightModels() {
  return new Set(liveRuns().map((r) => r.model));
}
