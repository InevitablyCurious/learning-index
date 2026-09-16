"""A challenge declares its own facts; the harness never borrows the example's.

The adapter used to know the example by heart: a fixed grading-suite path, the
literal phase tuple, port 8002, a TypeScript stub marker, and "backgammon" in
the need card. A second challenge could not run without editing the harness.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from harness.challenge_spec import ChallengeSpecError, default_spec, load

REPO = Path(__file__).resolve().parents[1]
EXAMPLE = REPO / "task" / "backgammon"


def _manifest() -> dict:
    return json.loads((EXAMPLE / "challenge.json").read_text(encoding="utf-8"))


def test_the_example_declares_everything_the_harness_needs() -> None:
    spec = default_spec()
    assert spec.name == "backgammon"
    assert spec.app_port == 8002
    assert spec.grader_phases == ("conformance", "backend", "frontend")
    assert spec.grader_dir == (REPO / "grader").resolve()
    assert spec.chunk_stub_files[2].endswith(".ts")
    assert spec.summary.strip() and spec.language.strip() and spec.stack


def test_the_adapter_reads_those_facts_rather_than_its_own() -> None:
    """The values the harness runs on must BE the challenge's, not copies."""
    from harness.adapters.challenge import constants as c
    from harness.adapters.challenge.telemetry import DECLARED_TEST_COMMANDS

    spec = default_spec()
    assert c._GRADER_DIR == spec.grader_dir
    assert c._HOLD_UI_PORT == spec.app_port
    assert c._STUB_SENTINEL == spec.stub_sentinel
    assert c._CHUNK_STUB_FILE == spec.chunk_stub_files
    assert DECLARED_TEST_COMMANDS == spec.test_commands


def test_a_challenge_with_no_manifest_is_loud(tmp_path: Path) -> None:
    with pytest.raises(ChallengeSpecError) as err:
        load(tmp_path)
    assert "challenge.json" in str(err.value)


def test_a_missing_key_is_loud_and_names_it(tmp_path: Path) -> None:
    # Absolute grading suite: this test is about the missing key, not the path.
    raw = _manifest() | {"grader_dir": str(REPO / "grader")}
    del raw["app_port"]
    (tmp_path / "challenge.json").write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ChallengeSpecError) as err:
        load(tmp_path)
    assert "app_port" in str(err.value)


def test_a_grading_suite_that_is_not_there_is_loud(tmp_path: Path) -> None:
    """Silence here would start a campaign that cannot grade what it builds."""
    raw = _manifest() | {"grader_dir": "no-such-suite"}
    (tmp_path / "challenge.json").write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ChallengeSpecError) as err:
        load(tmp_path)
    assert "grader_dir" in str(err.value)


def test_the_template_declares_a_complete_manifest() -> None:
    """What an author copies must load, or their first run fails on our shape."""
    template = REPO / "challenges" / "TEMPLATE"
    raw = json.loads((template / "challenge.json").read_text(encoding="utf-8"))
    assert set(_manifest()) <= set(raw), "the template is missing a declared key"
