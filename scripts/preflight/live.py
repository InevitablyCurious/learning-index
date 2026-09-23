"""The board's during-the-run surface — the reader's own resolver, invoked
directly, against the streams actually on disk."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

from preflight.core import REPO, Check

# ── the board's during-the-run surface ──────────────────────────────────────
#
# LIVENESS IS NOT WIRING (AGENTS.md §2.1). The board answering 200 on :8717
# proves nothing about whether its sources RESOLVE, exactly as a port answering
# proved nothing about identity. This asserts the SEAM instead: the reader's own
# resolver, invoked directly, against the streams actually on disk.
#
# THE DEFECT THIS EXISTS FOR (2026-08-29). LIVE-STREAM.md documents the stream
# at `runs/<run>/live.jsonl`, but the harness opens it in `run_cell` via
# `LiveStream.for_run(run_dir)` where `run_dir` is the CELL directory — so it
# lands at `<campaign>/memory<ARM>/cell-<seq>/live.jsonl`, one level below the
# campaign dir `activeRun()` resolves. Both dashboard readers joined the bare
# filename onto `run.dir` and opened a path that never exists, so the gate wall
# and the learning matrix sat empty for the entire life of every run while the
# harness appended to a file a few directories down.
#
# WHY NEITHER TEST SUITE CAUGHT IT, WHICH IS THE REAL LESSON. All 12 contract
# tests in tests/test_live_stream.py pass `tmp_path` to `for_run`; the reader's
# tests passed a synthetic directory to the reader. Each half was verified
# against a directory IT SUPPLIED, so both agreed in tests and disagreed on
# disk. A writer test and a reader test cannot find a disagreement about WHERE —
# only something that reads the writer's real output with the reader's real code
# can, and that is this check.
STREAM_SEAM_JS = """
import { activeRun, cellLiveStreamPath } from './sources/_runtime.mjs';
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';

// GROUND TRUTH, gathered WITHOUT the resolver — a check that used
// cellLiveStreamPath to find what it should find proves nothing.
// Skips worktree/.git: the model's checkout is large and never holds a stream.
async function walk(dir, depth, hits) {
  if (depth > 4) return hits;
  let ents = [];
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return hits; }
  for (const e of ents) {
    if (e.isFile() && e.name === 'live.jsonl') hits.push(join(dir, e.name));
    else if (e.isDirectory() && e.name !== '.git' && e.name !== 'worktree' && e.name !== 'node_modules') {
      await walk(join(dir, e.name), depth + 1, hits);
    }
  }
  return hits;
}

// Each stream on disk, and what the board's per-cell resolver answers for
// the address the path names (<run_dir>/memory<ARM>/cell-<seq>/live.jsonl).
const runsRoot = process.env.SEAM_RUNS_ROOT;
const run = await activeRun(runsRoot);
const out = { run_dir: run?.dir ?? null, on_disk: [], pairs: [] };
if (run?.dir) {
  out.on_disk = await walk(run.dir, 0, []);
  const runDir = relative(runsRoot, run.dir);
  for (const path of out.on_disk) {
    const m = /\\/memory[^/]+\\/cell-(\\d+)\\/live\\.jsonl$/.exec(path);
    const address = m ? { run_dir: runDir, sequence_index: Number(m[1]) } : null;
    out.pairs.push({ path, resolved: address ? await cellLiveStreamPath(runsRoot, address) : null });
  }
}
process.stdout.write(JSON.stringify(out));
"""


def check_live_stream(c: Check) -> None:
    """The board's reader must find the stream the harness actually writes."""
    dash = REPO / "control" / "board"
    node = shutil.which("node")
    if node is None:
        c.add(
            "board live stream",
            True,
            "node not on PATH — reader seam unverified",
            blocking=False,
        )
        return
    if not (dash / "sources" / "_runtime.mjs").is_file():
        c.add(
            "board live stream",
            False,
            f"the board's stream reader is missing at {dash / 'sources' / '_runtime.mjs'}",
        )
        return

    proc = subprocess.run(
        [node, "--input-type=module", "-e", STREAM_SEAM_JS],
        capture_output=True,
        text=True,
        check=False,
        cwd=str(dash),
        timeout=60,
        env={**os.environ, "SEAM_RUNS_ROOT": str(REPO / "runs")},
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        c.add(
            "board live stream",
            False,
            "the dashboard's stream resolver FAILED TO RUN: "
            + (detail[-1][:160] if detail else f"exit {proc.returncode}"),
        )
        return
    try:
        res = json.loads(proc.stdout)
    except json.JSONDecodeError:
        c.add(
            "board live stream",
            False,
            f"resolver returned unparseable output: {proc.stdout[:120]!r}",
        )
        return

    run_dir = res.get("run_dir")
    on_disk = res.get("on_disk") or []
    pairs = res.get("pairs") or []

    if not run_dir:
        c.add(
            "board live stream",
            True,
            "no run on disk yet — reader seam unverified until a cell has written one",
            blocking=False,
        )
        return

    rel = Path(run_dir).name
    if not on_disk:
        # Pre-launch on a fresh tree. Nothing to disagree about YET.
        c.add(
            "board live stream",
            True,
            f"no live.jsonl under the active run ({rel}) — nothing written yet, seam unverified",
            blocking=False,
        )
        return

    wrong = [p for p in pairs if p.get("resolved") != p.get("path")]
    if wrong:
        first = wrong[0]
        c.add(
            "board live stream",
            False,
            f"BOARD IS BLIND: {len(wrong)} of {len(on_disk)} cell stream(s) on disk do not resolve "
            f"from their own cell address (e.g. {first.get('path')!r} -> {first.get('resolved')!r}). "
            "That cell's gate wall and learning matrix would read 'no live.jsonl yet'. Fix "
            "control/board/sources/_runtime.mjs::cellLiveStreamPath — do NOT launch onto a blind board.",
        )
        return

    c.add(
        "board live stream",
        True,
        f"reader resolves every cell's own stream: {len(on_disk)} on disk, each from its own address",
    )
