// THE RUN LEDGER — the N-slot registry of control-plane runs, keyed on a
// control-plane-generated run_id. This replaces the single `launcher`
// singleton: every launched cell gets a slot here, so N concurrent cells can
// be tracked at once. The Map below is the only state; every read computes
// from it, never from a second copy.

import { randomUUID } from "node:crypto";

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
 */

/** @type {Map<string, RunRecord>} run_id → record. The only state. */
const runs = new Map();

/** A fresh unique control-plane run id. */
export function newRunId() {
  return randomUUID();
}

/**
 * Insert (or overwrite, by `record.run_id`) one run slot.
 * @param {RunRecord} record
 * @returns {RunRecord} the stored record
 */
export function registerRun(record) {
  // Fail loud: a record without a key cannot occupy a slot, and keying the
  // Map on undefined would be silent corruption.
  if (typeof record?.run_id !== "string" || record.run_id === "") {
    throw new TypeError("registerRun: record.run_id must be a non-empty string");
  }
  runs.set(record.run_id, record);
  return record;
}

/**
 * Drop one run slot.
 * @returns {boolean} true if it existed, false if absent
 */
export function unregisterRun(runId) {
  return runs.delete(runId);
}

/**
 * Mark one run slot as naturally finished: `finished:true` plus the terminal
 * facts of its ending — `null`/`null` when it ended unvouched (a wiped cell,
 * a vanished log). The record is overwritten in the same Map registerRun
 * writes, so every reader (liveRuns, runCount, inFlightModels) sees the
 * finish at once; the slot itself stays as history — only unregisterRun
 * removes it. Idempotent from the reconcile side: a finished record leaves
 * liveRuns(), so it is never visited twice.
 *
 * @param {string} runId
 * @param {{ terminal_status?: string|null, terminal_ok?: boolean|null }} [ending]
 * @returns {boolean} true if the record exists, false if runId is absent
 */
export function markRunFinished(runId, { terminal_status = null, terminal_ok = null } = {}) {
  const rec = runs.get(runId);
  if (!rec) return false;
  runs.set(runId, { ...rec, finished: true, terminal_status, terminal_ok });
  return true;
}

/** @returns {RunRecord|undefined} */
export function getRun(runId) {
  return runs.get(runId);
}

/** Every record with `finished === false`, in insertion order. */
export function liveRuns() {
  return [...runs.values()].filter((r) => r.finished === false);
}

/** How many runs are live. */
export function runCount() {
  return liveRuns().length;
}

/** The distinct models with a live run — the per-model in-flight gate. */
export function inFlightModels() {
  return new Set(liveRuns().map((r) => r.model));
}
