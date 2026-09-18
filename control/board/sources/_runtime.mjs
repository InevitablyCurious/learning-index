// SOURCE RUNTIME. Every source exports { id, describe(), fields, async
// read(ctx) } and read returns { ok, patch, provenance, reason? }. A source
// cannot take the board down: each read has a timeout and a catch, and a failure
// is reported `unwired` with a reason. Reads are read-only and tail-bounded.

import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { isTreeId, activeTreeId as treeActiveId, listLiveCampaignDirs } from "../../tree.mjs";
import { statOrNull, listDir } from "../../lib/fs.mjs";
export { statOrNull, listDir };

/** Never read more than this from the tail of any log. */
export const TAIL_BYTES = 256 * 1024;

/**
 * Per-source read budget. Must exceed any timeout a source applies inside
 * (control-plane.mjs uses 2500ms), so a slow sub-call fails with its own reason
 * instead of the whole source vanishing.
 */
export const READ_TIMEOUT_MS = 4000;

export async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Read the last `bytes` of a file as utf8. Returns "" when absent. */
export async function readTail(path, bytes = TAIL_BYTES) {
  const st = await statOrNull(path);
  if (!st || !st.isFile()) return "";
  const start = Math.max(0, st.size - bytes);
  return await new Promise((resolve) => {
    let buf = "";
    const s = createReadStream(path, { start, encoding: "utf8" });
    s.on("data", (c) => {
      buf += c;
    });
    s.on("end", () => resolve(buf));
    s.on("error", () => resolve(""));
  });
}

/** Read a whole small file (configs, manifests). Returns null when absent. */
export async function readTextCapped(path, cap = 4 * 1024 * 1024) {
  const st = await statOrNull(path);
  if (!st || !st.isFile() || st.size > cap) return null;
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function readJson(path) {
  const text = await readTextCapped(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Parse JSON-lines tolerantly: a half-written last line is normal and skipped. */
export function parseJsonl(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object") out.push(v);
    } catch {
      // A truncated head (tail read) or half-flushed last line: expected.
    }
  }
  return out;
}

// ── THE ACTIVE RUN ── one run is on screen, and every source agrees which:
// the run whose manifest declares the newest created_at (written once at run
// start). Not mtime (renames and reads move it), not the launch log (archived
// runs keep their old path), not the folder name. A manifest with no parseable
// created_at ranks below any that has one; when neither declares, a run with
// attempt records beats a bare folder, then mtime. Pinned by
// arm-delta-validity.test.mjs.
//
// ── BENCHMARK TREE ── the rules live in control/tree.mjs; these are the
// readers' views of them.

export { isTreeId };

/** The live tree id, or null when there is no pointer or it is unreadable. */
export async function activeTreeId(runsRoot) {
  try {
    return await treeActiveId(runsRoot);
  } catch {
    return null;
  }
}

/**
 * Campaign directories in the live tree (plus legacy flat ones), each with
 * stats for its two manifests — what a board reader needs to rank them.
 */
export async function listCampaignDirs(runsRoot) {
  const out = [];
  for (const c of await listLiveCampaignDirs(runsRoot)) {
    out.push({
      ...c,
      status: await statOrNull(join(c.dir, "manifest.status.jsonl")),
      manifest: await statOrNull(join(c.dir, "manifest.json")),
    });
  }
  return out;
}


// Only stack-ledger.mjs spans runs, and says so; this prevents cross-run folds.
export async function activeRun(runsRoot) {
  let best = null;
  for (const ent of await listCampaignDirs(runsRoot)) {
    const dir = ent.dir;
    const status = ent.status;
    const manifest = ent.manifest;

    // The run's declared start, or null (ranked below any run that declares one).
    const declared = manifest?.isFile()
      ? (Date.parse(String((await readJson(join(dir, "manifest.json")))?.created_at ?? "")) || null)
      : null;
    const mtime = Math.max(status?.mtimeMs ?? 0, manifest?.mtimeMs ?? 0);

    const candidate = {
      name: ent.name,
      dir,
      declared,
      // Only consulted when neither run declares a start.
      rank: status?.isFile() ? 1 : 0,
      mtime,
      statusPath: status?.isFile() ? join(dir, "manifest.status.jsonl") : null,
      statusStat: status ?? null,
      manifestPath: manifest?.isFile() ? join(dir, "manifest.json") : null,
      manifestStat: manifest ?? null,
    };

    if (!best || newerRun(candidate, best)) best = candidate;
  }
  return best;
}

// ── WHERE THE LIVE STREAM IS ── the harness writes it per cell
// (<campaign>/memory<ARM>/cell-<seq>/live.jsonl), one level below the campaign
// folder activeRun() resolves. A campaign-level stream wins if present (where
// LIVE-STREAM.md documents it); otherwise the newest per-cell stream. null when
// neither exists.
export const LIVE_STREAM_FILENAME = "live.jsonl";

export async function liveStreamPath(runDir) {
  if (!runDir) return null;

  const top = join(runDir, LIVE_STREAM_FILENAME);
  if ((await statOrNull(top))?.isFile()) return top;

  let best = null;
  for (const arm of await listDir(runDir)) {
    if (!arm.isDirectory() || !/^memory/i.test(arm.name)) continue;
    const armDir = join(runDir, arm.name);
    for (const cell of await listDir(armDir)) {
      if (!cell.isDirectory() || !/^cell-/i.test(cell.name)) continue;
      const path = join(armDir, cell.name, LIVE_STREAM_FILENAME);
      const st = await statOrNull(path);
      if (!st?.isFile()) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { path, mtimeMs: st.mtimeMs };
    }
  }
  return best?.path ?? null;
}

/** Is `a` more current than `b`? Declared start, then attempt data, then mtime. */
function newerRun(a, b) {
  if (a.declared !== null && b.declared !== null) {
    return a.declared !== b.declared ? a.declared > b.declared : a.mtime > b.mtime;
  }
  if (a.declared !== null) return true; // a declares, b does not
  if (b.declared !== null) return false; // b declares, a does not
  if (a.rank !== b.rank) return a.rank > b.rank; // data beats a bare directory
  return a.mtime > b.mtime;
}

/** Run one source with full isolation. Never throws. */
export async function runSource(mod, ctx) {
  const started = Date.now();
  try {
    const res = await withTimeout(
      Promise.resolve(mod.read(ctx)),
      READ_TIMEOUT_MS,
      mod.id,
    );
    const ok = Boolean(res && res.ok);
    return {
      id: mod.id,
      ok,
      fields: mod.fields ?? [],
      reason: ok ? null : (res?.reason ?? "no data"),
      provenance: res?.provenance ?? null,
      patch: ok ? (res.patch ?? {}) : {},
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      id: mod.id,
      ok: false,
      fields: mod.fields ?? [],
      reason: String(err?.message ?? err).slice(0, 200),
      provenance: null,
      patch: {},
      ms: Date.now() - started,
    };
  }
}

/**
 * Deep-merge a source patch into the board: null never overwrites a value (a
 * source can only add information); arrays replace wholesale (one owner each).
 */
export function mergePatch(target, patch) {
  if (!patch || typeof patch !== "object") return target;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      target[k] = v;
    } else if (typeof v === "object" && typeof target[k] === "object" && target[k] !== null && !Array.isArray(target[k])) {
      mergePatch(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}
