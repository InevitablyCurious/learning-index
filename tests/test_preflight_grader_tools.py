"""The host must be able to list the gate suite before a run may start.

THE FAILURE THIS CLOSES. The grader's vitest and playwright live in
`grader/node_modules`, which git never tracks. A checkout without them lists
ZERO gates; each run then writes that empty roster (write-once) and carries on,
so its gate wall reads zero for the whole campaign while grading, done inside the
grader image, still works. Nothing said so. Preflight now refuses.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
if str(REPO / "scripts") not in sys.path:
    sys.path.insert(0, str(REPO / "scripts"))

from preflight.core import Check  # noqa: E402
from preflight.grader_tools import check_grader_tools  # noqa: E402


def _installed(tmp_path: Path) -> Path:
    bin_dir = tmp_path / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True)
    # A stand-in suite still meets the contract: a lister and a runner.
    for script in ("roster.mjs", "report.mjs"):
        (tmp_path / script).write_text("// stand-in\n", encoding="utf-8")
    for tool in ("vitest", "playwright"):
        (bin_dir / tool).write_text("")
    return tmp_path


def _writes_roster(roster: dict):
    def run(argv, **_kwargs):
        Path(argv[argv.index("--out") + 1]).write_text(json.dumps(roster))
        return subprocess.CompletedProcess(argv, 0)

    return run


def _only_row(c: Check) -> dict:
    rows = c.as_rows()
    assert len(rows) == 1
    return rows[0]


def test_missing_tools_refuse_without_running_the_lister(tmp_path: Path) -> None:
    # A real suite, missing only its installed tools — that is the branch here.
    for script in ("roster.mjs", "report.mjs"):
        (tmp_path / script).write_text("// stand-in\n", encoding="utf-8")

    def run(*_args, **_kwargs):
        raise AssertionError("the lister must not run when the tools are absent")

    c = Check()
    check_grader_tools(c, grader_dir=tmp_path, run=run)
    row = _only_row(c)
    assert row["status"] == "fail"
    assert "npm ci" in row["detail"]


def test_a_complete_non_empty_list_passes(tmp_path: Path) -> None:
    roster = {
        "total": 117,
        "enumeration": {"complete": True, "incomplete_reason": None},
    }
    c = Check()
    check_grader_tools(c, grader_dir=_installed(tmp_path), run=_writes_roster(roster))
    row = _only_row(c)
    assert row["status"] == "pass"
    assert "117" in row["detail"]


def test_an_incomplete_list_refuses_and_names_the_reason(tmp_path: Path) -> None:
    roster = {
        "total": 71,
        "enumeration": {
            "complete": False,
            "incomplete_reason": "frontend: list failed",
        },
    }
    c = Check()
    check_grader_tools(c, grader_dir=_installed(tmp_path), run=_writes_roster(roster))
    row = _only_row(c)
    assert row["status"] == "fail"
    assert "frontend: list failed" in row["detail"]


def test_an_empty_list_refuses_even_when_marked_complete(tmp_path: Path) -> None:
    roster = {"total": 0, "enumeration": {"complete": True, "incomplete_reason": None}}
    c = Check()
    check_grader_tools(c, grader_dir=_installed(tmp_path), run=_writes_roster(roster))
    assert _only_row(c)["status"] == "fail"


def test_no_written_list_refuses(tmp_path: Path) -> None:
    def run(argv, **_kwargs):
        return subprocess.CompletedProcess(argv, 1)

    c = Check()
    check_grader_tools(c, grader_dir=_installed(tmp_path), run=run)
    assert _only_row(c)["status"] == "fail"


def test_node_missing_refuses(tmp_path: Path) -> None:
    def run(*_args, **_kwargs):
        raise FileNotFoundError("node")

    c = Check()
    check_grader_tools(c, grader_dir=_installed(tmp_path), run=run)
    row = _only_row(c)
    assert row["status"] == "fail"
    assert "node" in row["detail"]
