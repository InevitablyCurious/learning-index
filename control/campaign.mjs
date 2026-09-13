// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN LAYOUT — which manifest a cell writes to
//
// Split out of server.mjs so it can be TESTED: importing server.mjs binds a
// port, so anything only reachable from there is only reachable by running the
// service. This is pure path resolution over what is already on disk, and it
// decides where hours of measurement land — exactly the kind of rule that must
// be asserted rather than read.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ONE RESOLVER FOR "WHICH MODEL IS THIS CELL". Imported rather than reimplemented
// — the local/cloud split reads two different fields and getting it wrong here
// routes a campaign into another campaign's directory.
import { identifyCell } from "./baselines.mjs";
// WHERE THE TREE PUTS THINGS. This module decides WHICH campaign; tree.mjs
// decides WHERE campaigns live. Kept apart so the layout can be reasoned about
// (and reset) without touching the ownership rules below.
import { activeTreeId, campaignSegments } from "./tree.mjs";

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

// ── ONE CAMPAIGN DIRECTORY PER MODEL ────────────────────────────────────────
//
// THE PROBLEM THIS SOLVES. The harness defaults every run to
// `runs/cumulative/manifest.json`, and a manifest FREEZES its roster hash. The
// sequencer re-checks that hash on EVERY launch (not only on resume) and refuses
// on drift. So a baseline for a second model, launched with no --manifest, died
// at startup with `roster hash drift detected` — a button that looked live and
// could never work. Enabling [+ baseline] for every un-floored model (which is
// the rule: one floor per model) is only true if each model has somewhere to put
// its campaign.
//
// THE LEGACY DIRECTORY KEEPS ITS OWNER. `runs/cumulative` belongs to whichever
// model's manifest is already sitting in it, and that model keeps launching
// there — the live campaign, its baseline and its status stream are untouched by
// this change. Every OTHER model gets `runs/cumulative-<model>`.
//
// This is not a new concept on the board: the dashboard's stack key is
// (org, task, roster_hash, seed), so a second model was ALREADY a separate stack
// — it simply had nowhere to live on disk. RC-5 (one run directory, one
// manifest, one status stream) is preserved rather than bent.
//
// DOTS ARE STRIPPED FROM THE DIRECTORY NAME, and that is load-bearing rather
// than cosmetic: `isArchivedRun()` treats ANY dot in a run directory name as the
// archive convention (`runs/cumulative.<why>-<date>`), so a directory named for
// `qwen3.6-35b-a3b-bench` would be read as archived and its baseline would
// silently vanish from the floor index.
//
// SLASHES ARE STRIPPED FOR A DIFFERENT AND SHARPER REASON. A cloud model is
// identified by its `{provider}/{model}` key (`anthropic/claude-opus-5`), and a
// slash in a directory name is not a name at all — it is a path. Left in, the
// campaign for a cloud baseline would resolve to `runs/cumulative-anthropic/
// claude-opus-5`: a NESTED directory whose parent `cumulative-anthropic` holds
// no manifest, so every reader that scans `runs/` for campaign directories walks
// straight past it and the cell's measurements are invisible on the board it was
// launched from. The harness, meanwhile, would create the tree happily.
//
// Local names contain no slashes, so this rule cannot change any existing
// directory — the substitution is a no-op on every campaign that exists today.
export function campaignDirName(model) {
  return `cumulative-${String(model).replace(/[./]/g, "-")}`;
}

/**
 * Which manifest should a cell on `model` write to?
 *
 * Returns null when the default (`runs/cumulative`) is correct, so the launcher
 * passes no --manifest and the invocation stays byte-identical to the RUNBOOK's
 * for the model that already owns it.
 */
export async function manifestArgFor(model, runsRoot) {
  const legacyPath = join(runsRoot, "cumulative", "manifest.json");
  const mine = join(runsRoot, campaignDirName(model), "manifest.json");

  // ABSENT and UNREADABLE ARE DIFFERENT ANSWERS, and collapsing them is the
  // dangerous case. Absent = no campaign has claimed the default directory, so
  // this model names its own and the layout stays uniform. Unreadable = a
  // campaign IS there and cannot be parsed; routing around it would present as
  // the whole run history having vanished, so the default is used and the
  // harness fails loudly on the file that is actually broken.
  if (!existsSync(legacyPath)) return mine;

  const legacy = await readJsonOrNull(legacyPath);
  if (!legacy) return null;

  const owner = legacyManifestModel(legacy);
  if (!owner || owner === model) return null;
  return mine;
}

/**
 * WHERE THIS CELL WILL LAND, resolved BEFORE it is launched.
 *
 * ── THE HOLE THIS FILLS ─────────────────────────────────────────────────────
 *
 * A launch resolved which manifest the cell would write to and then discarded
 * it, so the response could not say where the cell was about to land and the
 * operator had nothing to check the board's next row against.
 *
 * The launcher already resolves which manifest the cell writes to (that is what
 * `manifestArgFor` above is for), and the manifest already records which cell in
 * its schedule is current. Both facts are knowable AT LAUNCH and at no other
 * time from the launcher's side, so they are resolved here and echoed back.
 *
 * `sequence_index` IS OBSERVED, NOT PREDICTED. It is the manifest's own
 * `current_index` — the slot the harness will step next — read a moment before
 * the spawn. A cell that the harness then re-schedules elsewhere would make this
 * wrong, which is why the reader treats it as a claim to be VERIFIED against the
 * cell it finds (the arm must match) rather than as an address to trust blindly.
 */
export async function campaignTargetFor(subject, runsRoot) {
  // Callers passed a bare model string before the tree existed. Accepting both
  // keeps every existing call site and test honest rather than requiring a
  // sweep of them to land this — a local cell IS just its model.
  const s = typeof subject === "string" ? { model: subject, kind: "local", cloud: null } : (subject ?? {});
  const model = s.model;

  // ── THE TREE WINS WHEN THERE IS ONE ───────────────────────────────────────
  //
  // Resolved through the pointer, never by scanning for the newest directory:
  // reset makes a tree live by REWRITING THE POINTER, so a resolver that picked
  // by mtime would keep writing into the tree the operator just retired.
  let treeId = null;
  try {
    treeId = await activeTreeId(runsRoot);
  } catch {
    // An unreadable pointer must not silently divert a campaign into a fresh
    // tree — fall through to the legacy layout and let the pointer be fixed.
    treeId = null;
  }

  if (treeId) {
    const rel = join(treeId, ...campaignSegments(s));
    const manifestArg = join(runsRoot, rel, "manifest.json");
    const manifest = await readJsonOrNull(manifestArg);
    const current = Number.isFinite(manifest?.current_index) ? Number(manifest.current_index) : 0;
    return { manifest_arg: manifestArg, run_dir: rel, sequence_index: current, tree: treeId };
  }

  // ── LEGACY FLAT LAYOUT ────────────────────────────────────────────────────
  // Reached only on a bench whose pointer is missing or broken. Unchanged.
  const manifestArg = await manifestArgFor(model, runsRoot);
  const dir = manifestArg ? campaignDirName(model) : "cumulative";
  const manifest = await readJsonOrNull(join(runsRoot, dir, "manifest.json"));

  // NO MANIFEST MEANS NO CAMPAIGN YET, and the first cell the harness builds is
  // index 0. That is a fact about how the schedule is constructed, not a guess:
  // a fresh campaign has one slot and it is the one about to run.
  const current = Number.isFinite(manifest?.current_index) ? Number(manifest.current_index) : 0;

  return { manifest_arg: manifestArg, run_dir: dir, sequence_index: current, tree: null };
}

/**
 * The model a manifest froze.
 *
 * RESOLVED BY THE ONE RULE, `identifyCell` in baselines.mjs, rather than by a
 * second reading of the same two fields. This function used to prefer
 * `provider_pin` outright, which is the bench alias on a local slug and the
 * ROUTER on a cloud one — so a legacy directory owned by a cloud baseline
 * reported its owner as "orcarouter", matched no model, and every cloud cell was
 * routed into `runs/cumulative` on top of whichever campaign already lived
 * there. Sharing the resolver means the owner named here and the model named on
 * the board cannot be two different answers.
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

