"""Campaign slot — asks the control plane's own rule where this campaign lands.

The launch files a campaign wherever control/campaign.mjs `campaignTargetFor`
says. This check runs that same code through node rather than keeping a Python
copy of it: two copies of "where does a run go" disagreed on the unreadable-
pointer case, on the no-tree folder name and on prefixed model names.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess

from preflight.core import REPO, Check

TARGET_JS = """
import { readTreePointer } from './tree.mjs';
import { campaignTargetFor } from './campaign.mjs';
const runs = process.env.SLOT_RUNS_ROOT;
const s = JSON.parse(process.env.SLOT_SUBJECT);
let pointer_error = null;
try { await readTreePointer(runs); } catch (err) { pointer_error = String(err?.message ?? err); }
const t = await campaignTargetFor(s, runs);
process.stdout.write(JSON.stringify({ pointer_error, run_dir: t.run_dir, tree: t.tree }));
"""


def _subject(args) -> dict:
    """The launch's subject, shaped the way control/routes/run.mjs builds it."""
    if args.cloud:
        return {
            "kind": "cloud",
            "model": str(args.model or "").strip(),
            "router": str(args.router or "orcarouter").strip(),
            "cloud": {
                "provider": str(args.provider or "").strip(),
                "model": str(args.model or "").strip(),
            },
        }
    return {"kind": "local", "model": str(args.model or "").strip(), "cloud": None}


def check_run_dir(c: Check, args, runs_root=None) -> None:
    """Report whether the chosen model's campaign slot is already occupied.

    READ-ONLY. An unreadable tree pointer blocks: the launch would quietly file
    the run outside the tree, where a reset never sweeps it.
    """
    node = shutil.which("node")
    if node is None:
        c.add("campaign slot", False, "node not on PATH — cannot ask control/campaign.mjs")
        return
    runs_root = runs_root or REPO / "runs"
    proc = subprocess.run(
        [node, "--input-type=module", "-e", TARGET_JS],
        capture_output=True,
        text=True,
        check=False,
        cwd=str(REPO / "control"),
        timeout=60,
        env={**os.environ, "SLOT_RUNS_ROOT": str(runs_root), "SLOT_SUBJECT": json.dumps(_subject(args))},
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        c.add(
            "campaign slot",
            False,
            "control/campaign.mjs FAILED TO RUN: " + (detail[-1][:160] if detail else f"exit {proc.returncode}"),
        )
        return
    res = json.loads(proc.stdout)
    if res["pointer_error"]:
        c.add("campaign slot", False, f"{res['pointer_error']} — refusing to guess which tree is live")
        return

    rel = res["run_dir"]
    tree_note = f"active tree {res['tree']}" if res["tree"] else "no active tree — legacy flat layout"
    if not (runs_root / rel).exists():
        c.add("campaign slot", True, f"{rel} ABSENT ({tree_note}) — clean slate")
        return
    c.add(
        "campaign slot",
        False,
        f"{rel} EXISTS ({tree_note}) — a campaign occupies this slot. "
        "Reset mints a new tree (never delete); a launch into it RESUMES that "
        "campaign — intended only for resumes.",
    )
