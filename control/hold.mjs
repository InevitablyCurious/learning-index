import { promises as fs } from "node:fs";
import { join } from "node:path";
import { statOrNull, listDir } from "./lib/fs.mjs";

const HOLD_FILE = "hold-ui.json";
// A hold sits in its cell's directory, a few levels below the run directory
// (<run_dir>/memoryOFF/cell-0000/hold-ui.json). The model's code (worktree and
// checkpoint copies) is never walked.
const MAX_DEPTH = 4;
const SKIP_DIRS = new Set(["worktree", "checkpoints", "node_modules"]);

async function findHoldFiles(root, depth = 0, out = []) {
  if (depth > MAX_DEPTH) return out;
  for (const ent of await listDir(root)) {
    const path = join(root, ent.name);
    if (ent.isFile() && ent.name === HOLD_FILE) {
      const st = await statOrNull(path);
      if (st?.isFile()) out.push({ path, mtime: st.mtimeMs });
      continue;
    }
    if (ent.isDirectory() && !SKIP_DIRS.has(ent.name)) await findHoldFiles(path, depth + 1, out);
  }
  return out;
}

/**
 * Only a LIVE run can be held: `runDirs` are the run directories of the runs
 * in flight, relative to `runsRoot` (readRunState's `run_dir`). A hold file a
 * dead run left behind is never shown, and never "released" into a file
 * nothing reads.
 */
async function findActiveHold(runsRoot, runDirs) {
  const files = [];
  for (const dir of runDirs) await findHoldFiles(join(runsRoot, dir), 0, files);
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0] ?? null;
}

export async function readHold({ runsRoot, runDirs }) {
  const hit = await findActiveHold(runsRoot, runDirs);
  if (!hit) return null;

  let raw;
  try {
    raw = await fs.readFile(hit.path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { released: true };
    throw err;
  }

  const data = JSON.parse(raw);
  if (data?.schema_version !== 2) {
    return {
      invalid_schema: true,
      schema_version: data?.schema_version ?? null,
      hold_path: hit.path,
      reason: "unknown hold-ui.json schema_version — only v2 is produced (v1 was removed with BENCH_HOLD_UI); refusing to render guessed fields",
    };
  }

  let heldSeconds = null;
  if (typeof data.started_at === "string") {
    const t = Date.parse(data.started_at);
    if (Number.isFinite(t)) heldSeconds = Math.max(0, Math.round((Date.now() - t) / 1000));
  }

  return {
    ...data,
    hold_path: hit.path,
    held_seconds: heldSeconds,
  };
}
