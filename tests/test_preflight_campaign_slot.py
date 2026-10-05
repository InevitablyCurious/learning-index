"""The campaign-slot check asks control/campaign.mjs, the launch's own rule."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO = Path(__file__).resolve().parents[1]
if str(REPO / "scripts") not in sys.path:
    sys.path.insert(0, str(REPO / "scripts"))

from preflight.campaign import check_run_dir  # noqa: E402
from preflight.core import Check  # noqa: E402

LOCAL = SimpleNamespace(
    cloud=False, model="qwen3.6-35b-a3b-bench", provider=None, router=None
)
CLOUD = SimpleNamespace(cloud=True, model="claude-x", provider="anthropic", router=None)


def _slot(c: Check):
    [row] = [r for r in c.rows if r[0] == "campaign slot"]
    return row


@pytest.fixture
def runs(tmp_path):
    (tmp_path / "active-tree.json").write_text(json.dumps({"active": "1789000000"}))
    return tmp_path


def test_empty_slot_passes_and_names_the_launch_folder(runs):
    c = Check()
    check_run_dir(c, LOCAL, runs_root=runs)
    name, ok, detail, *_ = _slot(c)
    assert ok
    assert (
        "1789000000/local/local-llm-proxy/omlx/qwen3-6-35b-a3b-bench ABSENT" in detail
    )


def test_occupied_slot_blocks(runs):
    (runs / "1789000000/cloud/orcarouter/anthropic/claude-x").mkdir(parents=True)
    c = Check()
    check_run_dir(c, CLOUD, runs_root=runs)
    name, ok, detail, *_ = _slot(c)
    assert not ok
    assert "EXISTS" in detail


def test_unreadable_pointer_blocks(tmp_path):
    (tmp_path / "active-tree.json").write_text("{not json")
    c = Check()
    check_run_dir(c, LOCAL, runs_root=tmp_path)
    name, ok, detail, *_ = _slot(c)
    assert not ok
    assert "refusing to guess" in detail
