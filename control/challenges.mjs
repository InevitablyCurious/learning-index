// ─────────────────────────────────────────────────────────────────────────────
// CHALLENGES — what this benchmark can be pointed at, and whether each is ready
//
// A challenge is what the cell builds and what the gates grade. Backgammon is
// the one that ships; a challenge of your own is its own git repo, cloned into
// `challenges/` (or anywhere, if you drive the harness yourself).
//
// HONEST ABSENCE, NOT A SHORT LIST. A challenge that cannot run is listed with
// the reason — no starting files, no frozen fingerprint, no gate suite — rather
// than hidden. A picker that silently omits the thing the operator just cloned
// sends them hunting through directories.
//
// READ-ONLY. This module reads manifests and stats directories. It never writes,
// never spawns, and never decides whether a run may start: that is preflight's.
// ─────────────────────────────────────────────────────────────────────────────

import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** Where challenges live: the bundled example, and anything cloned in. */
const ROOTS = ["task", "challenges"];

/** The skeleton authors copy. It is not a runnable challenge. */
const TEMPLATE = "TEMPLATE";

async function isDir(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readManifest(dir) {
  try {
    return JSON.parse(await readFile(join(dir, "challenge.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Why this challenge cannot be run, or null when it can.
 *
 * The same four facts the harness needs: starting files to copy, a frozen
 * fingerprint so two runs are comparable, a gate suite, and the two scripts
 * that list and run the checks.
 */
async function blockedReason(dir, manifest) {
  if (!manifest) return "no challenge.json";
  if (!(await isDir(join(dir, "prompts")))) return "no prompts/";
  if (!(await isDir(join(dir, "scaffold")))) return "no scaffold/ (the files the model starts from)";
  if (!manifest.scaffold_hash) return "not frozen — run scripts/freeze_challenge.py --write";
  const declared = String(manifest.grader_dir ?? "");
  if (!declared) return "no grader_dir declared";
  const graderDir = isAbsolute(declared) ? declared : resolve(dir, declared);
  if (!(await isDir(graderDir))) return `grader_dir ${declared} is not a directory`;
  for (const script of ["roster.mjs", "report.mjs"]) {
    try {
      await stat(join(graderDir, script));
    } catch {
      return `the gate suite has no ${script}`;
    }
  }
  return null;
}

/** Every challenge this installation can see, ready or not, id-sorted. */
export async function listChallenges(benchRoot) {
  const found = [];
  for (const root of ROOTS) {
    const base = join(benchRoot, root);
    let entries = [];
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === TEMPLATE) continue;
      const dir = join(base, entry.name);
      const manifest = await readManifest(dir);
      if (!manifest && !(await isDir(join(dir, "prompts")))) continue;
      const reason = await blockedReason(dir, manifest);
      const declaredSuite = String(manifest?.grader_dir ?? "");
      found.push({
        grader_dir: declaredSuite ? (isAbsolute(declaredSuite) ? declaredSuite : resolve(dir, declaredSuite)) : null,
        id: entry.name,
        name: String(manifest?.name ?? entry.name),
        dir,
        summary: String(manifest?.summary ?? ""),
        run_label: String(manifest?.run_label ?? ""),
        bundled: root === "task",
        ready: reason === null,
        blocked_reason: reason,
      });
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/** One challenge by id, or null. The caller says what an unknown id means. */
export async function findChallenge(benchRoot, id) {
  const wanted = String(id ?? "").trim();
  if (!wanted) return null;
  return (await listChallenges(benchRoot)).find((c) => c.id === wanted) ?? null;
}
