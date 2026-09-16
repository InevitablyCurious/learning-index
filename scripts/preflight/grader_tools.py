"""Grader test tools on the host — the gate list every run and the board read."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

from harness.challenge_spec import default_spec
from preflight.core import Check

INSTALL_CMD = "(cd grader && npm ci)"

# A cold listing takes ~3s; the run's own enumerator allows 300s
# (run_cumulative/paths.py GATE_ROSTER_TIMEOUT_S). Anything near this bound is a
# broken install, not a slow one.
ENUMERATE_TIMEOUT_S = 120

_TOOLS = ("vitest", "playwright")


def check_grader_tools(
    c: Check, grader_dir: Path | None = None, run=subprocess.run
) -> None:
    """BLOCKING: the host can list the full gate suite.

    WHY. Every run lists the gates ON THE HOST at cell start
    (`_write_gate_roster` -> `grader/roster.mjs`), and the board's gate wall does
    the same before any run exists (`control/wall.mjs`). `roster.mjs` lists
    through the grader's own vitest and playwright, which live in
    `grader/node_modules` — installed, never tracked, so a fresh clone does not
    have them. Without them the list comes back EMPTY, the run writes that empty
    roster anyway (write-once, so the campaign's wall stays at zero gates for its
    whole life), and nothing stops. Grading itself still works — the grader IMAGE
    installs its own copy — which is exactly why the gap was silent.

    A present `node_modules` is not proof, so this lists for real and requires a
    complete, non-empty suite. Listing is execution-free: `roster.mjs` only runs
    `vitest list` and `playwright test --list`, so no test runs and no port binds.
    """
    name = "grader tools"
    gdir = grader_dir if grader_dir is not None else default_spec().grader_dir

    # THE CONTRACT A CHALLENGE'S SUITE HAS TO MEET. Two scripts: one that lists
    # the checks without running them, one the grading image runs against a
    # candidate. Named here rather than discovered, because a suite missing
    # either produces an empty roster or an ungradeable cell — both of which
    # look like a quiet zero rather than a broken challenge.
    absent = [s for s in ("roster.mjs", "report.mjs") if not (gdir / s).is_file()]
    if absent:
        c.add(
            name,
            False,
            f"the grading suite at {gdir} is missing {', '.join(absent)} — a "
            "challenge's suite must provide roster.mjs (list the checks) and "
            "report.mjs (run them against a candidate)",
        )
        return

    missing = [t for t in _TOOLS if not (gdir / "node_modules" / ".bin" / t).exists()]
    if missing:
        c.add(
            name,
            False,
            f"NOT INSTALLED ({', '.join(missing)} missing) — the gate list would "
            f"come back empty. Install: {INSTALL_CMD}",
        )
        return

    roster = None
    with tempfile.TemporaryDirectory(prefix="bench-preflight-roster-") as tmp:
        # A path that does not exist yet: roster.mjs refuses to overwrite.
        out = Path(tmp) / "roster.json"
        try:
            run(
                ["node", str(gdir / "roster.mjs"), "--out", str(out)],
                cwd=str(gdir),
                capture_output=True,
                text=True,
                timeout=ENUMERATE_TIMEOUT_S,
                check=False,
            )
        except FileNotFoundError:
            c.add(name, False, "node is not on PATH — the gate list cannot be made")
            return
        except subprocess.TimeoutExpired:
            c.add(
                name,
                False,
                f"listing the gates took over {ENUMERATE_TIMEOUT_S}s — the grader "
                f"tools are broken. Reinstall: {INSTALL_CMD}",
            )
            return
        try:
            roster = json.loads(out.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            roster = None

    if not isinstance(roster, dict):
        c.add(
            name,
            False,
            f"the gate lister wrote no readable list. Reinstall: {INSTALL_CMD}",
        )
        return

    total = roster.get("total") or 0
    enumeration = roster.get("enumeration") or {}
    if enumeration.get("complete") is not True or total == 0:
        reason = enumeration.get("incomplete_reason") or "no gates listed"
        c.add(
            name,
            False,
            f"the gate list is incomplete ({total} gates; {reason}). "
            f"Reinstall: {INSTALL_CMD}",
        )
        return

    c.add(name, True, f"{total} gates listed from grader/")
