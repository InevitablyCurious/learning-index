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

