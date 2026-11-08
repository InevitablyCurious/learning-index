// ─────────────────────────────────────────────────────────────────────────────
// RUN CLASSIFICATION — the ONE place that decides whether a run dir is
// archived, living (v2 epoch), or legacy (pre-v2).
//
// Every consumer of run dirs (the board's runs source, the archive endpoint)
// imports THIS module: a second copy of the archive-segment test would let the
// board prune one set of dirs while the endpoint listed another, silently.
//
// PATH-FIRST. A run dir under an archive root is "archived" no matter what
// epoch it declares — the path is the fact, the epoch is a label a run states
// about itself. Architecture decisions here are pure: nothing in this file
// reads the filesystem, so callers pass a path relative to RUNS_ROOT plus the
// run's declared system_epoch (string or null).
//
// Archive roots:
//   runs/backups/            — the existing tree-reset archive (INSIDE runs/)
//   runs-archive/            — the future sibling archive root (OUTSIDE runs/)
//   runs/_archived-<date>/   — hand-dated archives (prefix match)
// ─────────────────────────────────────────────────────────────────────────────

import { join } from "node:path";

/**
 * The v2-epoch wire literal. Canonical home: a later chunk makes
 * board/contract.mjs import this instead of re-declaring it.
 */
export const SYSTEM_EPOCH = "2026-11-08";

/** Future sibling archive root basename, OUTSIDE runs/. */
export const ARCHIVE_DIR_NAME = "runs-archive";

/** Existing tree-reset archive root, INSIDE runs/. */
export const BACKUPS_DIR = "backups";

/** Hand-dated archive dirs carry this prefix. */
const ARCHIVED_PREFIX = "_archived";

/**
 * Does one path segment name an archive root?
 * @param {string} seg
 * @returns {boolean}
 */
export function isArchiveSegment(seg) {
  if (typeof seg !== "string" || seg === "") return false;
  return seg === BACKUPS_DIR || seg === ARCHIVE_DIR_NAME || seg.startsWith(ARCHIVED_PREFIX);
}

/**
 * First non-empty "/"-split segment of a path relative to RUNS_ROOT.
 * @param {string} relative
 * @returns {string} "" when there is no such segment
 */
export function firstSegment(relative) {
  if (typeof relative !== "string") return "";
  return relative.split("/").find((seg) => seg !== "") ?? "";
}

/**
 * Is this run dir under an archive root? Decided by path alone.
 * @param {string} relative
 * @returns {boolean}
 */
export function isArchivePath(relative) {
  return isArchiveSegment(firstSegment(relative));
}

/**
 * Classify a run dir. Exactly one of "archived" | "living" | "legacy".
 * @param {{ relative: string, systemEpoch?: string | null }} input
 * @returns {"archived" | "living" | "legacy"}
 */
export function classifyRun({ relative, systemEpoch }) {
  if (isArchivePath(relative)) return "archived";
  if (systemEpoch === SYSTEM_EPOCH) return "living";
  return "legacy";
}

/**
 * The sibling archive root beside runs/: <benchRoot>/runs-archive.
 * @param {string} benchRoot
 * @returns {string}
 */
export function archiveRoot(benchRoot) {
  return join(benchRoot, ARCHIVE_DIR_NAME);
}
