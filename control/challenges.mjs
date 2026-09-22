// CHALLENGES — what this benchmark can be pointed at (what the cell builds and
// the gates grade), and whether each is ready. Backgammon ships; others are git
// repos cloned into challenges/. One that can't run is listed with the reason,
// never hidden. Read-only; whether a run may start is preflight's call.

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
 * Why this challenge can't run, or null: it needs starting files, a frozen
 * fingerprint, a gate suite, and the two scripts that list and run checks.
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

/**
 * How many build chunks a challenge sends, counted from its prompts folder.
 *
 * COUNTED, NEVER A CONSTANT. The board carried a literal 6 here, written when
 * the backgammon task had six chunks. It has five — the no-op first chunk was
 * dropped — so every live cell rendered "chunk 3 of 6" against a five-chunk
 * build. A constant cannot notice that; a count can. `null` when the folder
 * cannot be read, because "unknown" renders honestly and a wrong number does
 * not.
 *
 * The glob matches `PromptPack.chunks()` on the harness side (`chunk-*.md`),
 * which is what actually decides how many the model is sent.
 */
export async function countChunkPrompts(challengeDir) {
  if (!challengeDir) return null;
  try {
    const names = await readdir(join(challengeDir, "prompts"));
    const n = names.filter((f) => /^chunk-.*\.md$/.test(f)).length;
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}
