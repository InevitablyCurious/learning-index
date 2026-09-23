"""Path layout, retention, and repo-root constants for the cumulative CLI.

Split out of ``scripts/run_cumulative.py`` (LI-14). ``REPO_ROOT`` /
``PROMPTS_DIR`` replace the original ``Path(__file__).resolve().parents[1]``
derivations, which would resolve to ``scripts/`` from inside the package.
"""

from __future__ import annotations

import argparse
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NamedTuple

from harness import config
from harness.challenge_spec import default_spec

# The original module derived the repo root as ``Path(__file__).resolve().parents[1]``
# (scripts/run_cumulative.py -> repo root). From inside the package the same
# expression would land on ``scripts/``, so the root is derived once here from
# the package file (scripts/run_cumulative/paths.py -> parents[2] -> repo root)
# and every former ``__file__`` derivation reads these constants.
REPO_ROOT = Path(__file__).resolve().parents[2]
PROMPTS_DIR = REPO_ROOT / "task" / "backgammon" / "prompts"

DEFAULT_MANIFEST_PATH = Path("runs") / "cumulative" / "manifest.json"
DEFAULT_ORG_ID = "okp-org-0"
DEFAULT_PROXY_RUNS_DIR = Path(
    os.environ.get("OKP_PROXY_RUNS_DIR", str(Path.home() / ".okp" / "proxy-runs"))
)
# The challenge names its own campaign; the example calls itself
# backgammon-cumulative-primary (task/backgammon/challenge.json).
DEFAULT_TASK_LABEL = default_spec().run_label
# Gate enumeration shells out to `vitest list` + `playwright --list` twice. Cold,
# that is tens of seconds; the bound exists so a wedged enumerator can never
# hold a campaign's first cell hostage — it is instrumentation, not grading.
GATE_ROSTER_TIMEOUT_S = 300
DEFAULT_SEED = config.RunConfig().rng_seed
DEFAULT_ON_BUDGET = 0


class PathLayout(NamedTuple):
    manifest_path: Path
    runs_dir: Path


def _utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _resolve_manifest_layout(manifest_arg: str) -> PathLayout:
    manifest_path = Path(manifest_arg).expanduser().resolve()
    runs_dir = manifest_path.parent
    return PathLayout(
        manifest_path=manifest_path,
        runs_dir=runs_dir,
    )


def _runs_root_from_args(args: argparse.Namespace) -> Path:
    """Where this run's launch logs accumulate — the retention prune's root.

    ``parent.parent`` was correct while campaigns were flat under ``runs/``. Under
    the benchmark tree a manifest sits at
    ``runs/<tree>/<substrate>/<router>/<provider>/<model>/manifest.json``, so the
    same expression lands on the PROVIDER directory: the prune would then glob a
    directory that holds no logs, silently retaining every launch log forever.

    Resolved by walking up to the tree — the one ancestor whose name is a unix
    timestamp — because that is where the control plane writes launch logs, and
    because it is the boundary a reset retires. Falls back to the legacy
    ``parent.parent`` when no tree is in the path.
    """
    manifest = Path(str(getattr(args, "manifest", None) or DEFAULT_MANIFEST_PATH))
    resolved = manifest.expanduser().resolve()
    for ancestor in resolved.parents:
        if re.fullmatch(r"\d{9,11}", ancestor.name):
            return ancestor
    return resolved.parent.parent


# A launch log: "<arm>-cell-<YYYYmmddTHHMMSS>[-sNNNN].log". Every cell of one
# concurrent batch carries the batch's launch stamp.
_LAUNCH_LOG = re.compile(r"^(?P<arm>[a-z]+)-cell-(?P<stamp>\d{8}T\d{6})")


def _prune_runs_retention(runs_root: Path, *, keep: int = 2) -> dict[str, Any]:
    """Prune accumulated launch logs under ``runs/``, keeping the newest ``keep``
    LAUNCHES — every log of a kept launch, never a subset of one.

    It kept the newest ``keep`` FILES. That was one launch per file while one
    cell ran at a time; a concurrent batch writes one log per cell under one
    launch stamp, so the first cell to exit deleted its running siblings' logs
    (2026-09-23: 6 of 8). The control plane finds running cells through those
    logs, so the board went blind — no cells, no feed, no TUI — while the cells
    ran on. A log that does not parse as a launch log is its own launch.

    Retention controls LOG FILES ONLY. Session DBs and archived run directories
    are extraction substrate and are never deleted by this policy, including for
    failed runs. A failed run may have its old top-level launch log pruned, but
    its ``session-db/opencode.db`` must persist so the operator can extract from
    any cell that later receives a complete gate.
    """
    summary: dict[str, Any] = {"kept": [], "deleted": [], "skipped_root": None}
    try:
        if not runs_root.is_dir():
            summary["skipped_root"] = str(runs_root)
            return summary
        launches: dict[str, list[Path]] = {}
        for p in runs_root.glob("*-cell-*.log"):
            if not p.is_file():
                continue
            m = _LAUNCH_LOG.match(p.name)
            launches.setdefault(m.group("stamp") if m else p.name, []).append(p)
        newest_first = sorted(
            launches.values(),
            key=lambda logs: max(p.stat().st_mtime for p in logs),
            reverse=True,
        )
        for idx, logs in enumerate(newest_first):
            for path in sorted(logs):
                if idx < keep:
                    summary["kept"].append(path.name)
                    continue
                path.unlink()
                summary["deleted"].append(path.name)
    except Exception as exc:
        summary["error"] = f"{type(exc).__name__}: {exc}"
    return summary


def _mode_dir(memory_mode: str) -> str:
    """The cell container for a memory mode.

    Cells used to sit flat under ``<campaign>/sessions/``, which meant the ONE
    fact an operator most wants to see on disk — was this the control arm or the
    memory arm — was legible only by parsing a run label. Under the benchmark
    tree they are split at the directory level, so an OFF baseline and its ON
    phase are two folders a human can point at.

    The campaign home stays ABOVE this split, and deliberately: one manifest
    carries the whole schedule (OFF baseline then seeded ON phase, see
    ``cumulative/ordering.py:build_schedule``), so hoisting the mode any higher
    would split one manifest across two directories.
    """
    mode = str(memory_mode or "").strip().lower()
    if mode == "on":
        return "memoryON"
    if mode == "off":
        return "memoryOFF"
    # Never silently folded into one of the two real arms: a cell whose mode did
    # not resolve is a cell whose arm is unknown, and filing it under an arm it
    # may not belong to would corrupt the contrast this bench exists to measure.
    return "memoryUNKNOWN"
