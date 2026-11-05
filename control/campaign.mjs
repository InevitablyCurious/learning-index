// CAMPAIGN LAYOUT — which campaign (manifest) a cell writes to. Pure path
// resolution, kept apart from server.mjs so it can be tested.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The one resolver for which model a cell measures (local and cloud differ).
import { identifyCell } from "./baselines.mjs";
// tree.mjs decides where campaigns live; this decides which one.
import { activeTreeId, campaignSegments } from "./tree.mjs";

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

// LEGACY FLAT LAYOUT (no tree): one campaign folder per model, because a
// manifest freezes its roster hash and a second model can't share it.
// `runs/cumulative` keeps whichever model's manifest is already there; others get
// `runs/cumulative-<model>`. Dots become dashes (a dot reads as the archive
// convention) and so do slashes (a cloud {provider}/{model} would otherwise
// nest the folder where no reader finds it).
export function campaignDirName(model) {
  return `cumulative-${String(model).replace(/[./]/g, "-")}`;
}

/**
 * Which manifest a cell on `model` writes to; null when the default
 * (runs/cumulative) is right, so no --manifest is passed.
 */
export async function manifestArgFor(model, runsRoot) {
  const legacyPath = join(runsRoot, "cumulative", "manifest.json");
  const mine = join(runsRoot, campaignDirName(model), "manifest.json");

  // Absent: this model names its own folder. Unreadable: use the default and let
  // the harness fail loudly on the broken file, rather than routing around it.
  if (!existsSync(legacyPath)) return mine;

  const legacy = await readJsonOrNull(legacyPath);
  if (!legacy) return null;

  const owner = legacyManifestModel(legacy);
  if (!owner || owner === model) return null;
  return mine;
}

/**
 * Where this cell will land, resolved before launch and echoed back. The
 * sequence_index is the manifest's own current_index, read just before spawn —
 * a claim to verify against the cell found later, not an address to trust.
 */
export async function campaignTargetFor(subject, runsRoot) {
  // A bare model string is still accepted: a local cell is just its model.
  const s = typeof subject === "string" ? { model: subject, kind: "local", cloud: null } : (subject ?? {});
  const model = s.model;

  // The tree wins when there is one, resolved through the pointer (never by
  // newest folder: reset works by rewriting the pointer).
  let treeId = null;
  try {
    treeId = await activeTreeId(runsRoot);
  } catch {
    // An unreadable pointer falls through to the legacy layout.
    treeId = null;
  }

  if (treeId) {
    const rel = join(treeId, ...campaignSegments(s));
    const manifestArg = join(runsRoot, rel, "manifest.json");
    const manifest = await readJsonOrNull(manifestArg);
    const current = Number.isFinite(manifest?.current_index) ? Number(manifest.current_index) : 0;
    return { manifest_arg: manifestArg, run_dir: rel, sequence_index: current, tree: treeId };
  }

  // ── LEGACY FLAT LAYOUT ── only when the pointer is missing or broken.
  const manifestArg = await manifestArgFor(model, runsRoot);
  const dir = manifestArg ? campaignDirName(model) : "cumulative";
  const manifest = await readJsonOrNull(join(runsRoot, dir, "manifest.json"));

  // No manifest yet: the first cell is index 0.
  const current = Number.isFinite(manifest?.current_index) ? Number(manifest.current_index) : 0;

  return { manifest_arg: manifestArg, run_dir: dir, sequence_index: current, tree: null };
}

// ── Sequence-index allocation ──────────────────────────────────────────────
// The control plane owns the launch counter: N concurrent starts each get a
// DISTINCT index, handed to the harness via --sequence-index. The cursor is
// in-memory only — seeded once per manifest from manifest.current_index and
// NEVER written back, because a running cell's _checkpoint is a full-manifest
// atomic_write (harness/cumulative/sequencer.py:323-325) that would silently
// clobber any control-plane write. Restart durability is an accepted
// limitation: a restart re-seeds from the manifest, and --sequence-index runs
// never advance current_index, so indices handed out before a restart can be
// re-issued afterward.
//
// THE CURSOR HAS NO BOUND. The harness refuses --sequence-index >=
// len(session_records) (sequencer.py:207-215), but that length is not frozen:
// a launch whose --off-replicates plans a LONGER OFF schedule EXTENDS the
// manifest — strictly an append, every recorded entry surviving in place
// (sequencer.py:138-174). So allocation hands out the next contiguous index
// and the launcher grows the schedule to cover it (routes/run.mjs sends the
// accumulated OFF slot count as --off-replicates). A bound frozen at first
// seed is exactly what made a second, third and Nth Run click fail: the plan
// held only the first batch's slots, so the next index was "out of range".
const sequenceCursors = new Map(); // manifestArg -> next index to hand out
// In-flight seed promises. The seed read is async, so without this guard two
// concurrent first-calls would both see the cursor unset, both await the seed
// and both hand out the same index — a check-then-act race across the await.
// Deduplicating the seed keeps the get/increment below synchronous and atomic.
const seeding = new Map(); // manifestArg -> Promise<{seed}>

/** The cursor seed for `manifestArg`, from its manifest. */
async function seedCursor(manifestArg) {
  const manifest = await readJsonOrNull(manifestArg);
  // Fail loud on a manifest that exists but cannot be read: silently seeding 0
  // would collide with the cells already run. A manifest that does not exist
  // yet is a fresh campaign whose first cell is index 0 — the harness creates
  // it at current_index 0 (resume_or_create), matching campaignTargetFor above.
  if (manifest === null && existsSync(manifestArg)) {
    throw new Error(
      `cannot allocate sequence_index: campaign manifest ${manifestArg} exists but cannot be read`,
    );
  }
  const seed = Number.isFinite(manifest?.current_index) ? Number(manifest.current_index) : 0;
  return { seed };
}

/**
 * Allocate the next distinct sequence_index for `manifestArg`. The first call
 * for a manifest lazily seeds the cursor from manifest.current_index; every
 * call then reads and increments the in-memory cursor synchronously, so N
 * concurrent starts in this single Node process each get a distinct index.
 * There is no upper bound: an index past the current schedule is a REQUEST to
 * grow it, which the harness honours by appending the planned slots
 * (sequencer.py:138-174) — the launcher sizes --off-replicates to cover the
 * highest index it allocates. Never writes to the manifest.
 */
export async function allocateSequenceIndex(manifestArg) {
  if (!sequenceCursors.has(manifestArg)) {
    let seedPromise = seeding.get(manifestArg);
    if (!seedPromise) {
      seedPromise = seedCursor(manifestArg);
      seeding.set(manifestArg, seedPromise);
    }
    try {
      const { seed } = await seedPromise;
      // Only the first caller to land sets the cursor; the rest find it set.
      if (!sequenceCursors.has(manifestArg)) {
        sequenceCursors.set(manifestArg, seed);
      }
    } finally {
      seeding.delete(manifestArg);
    }
  }
  // Synchronous read-then-increment: no await between get and set, so the
  // single Node process makes this atomic across concurrent starts.
  const next = sequenceCursors.get(manifestArg);
  sequenceCursors.set(manifestArg, next + 1);
  return next;
}

/**
 * The model a manifest froze, via identifyCell (baselines.mjs) — the same rule
 * the board uses, so the owner named here matches.
 */
function legacyManifestModel(m) {
  const sched = Array.isArray(m?.schedule) ? m.schedule : [];
  for (const s of sched) {
    const who = identifyCell(s, m);
    if (who.id) return who.id;
  }
  const roster = Array.isArray(m?.roster) ? m.roster : [];
  for (const r of roster) {
    const who = identifyCell({ model: r?.model }, m);
    if (who.id) return who.id;
  }
  return null;
}

