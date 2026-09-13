"""The recording turn: the chain, the placement, and the gap measurement.

WHY THESE ARE SOURCE-SHAPE TESTS. This flag crosses five files and three kwarg
hops (CLI -> sequencer -> runner kwargs dict -> adapter -> cell). Three separate
wiring bugs in this session were invisible to every functional test because
nothing executed the line: a name that existed in one scope and not the next, a
value added to a function that looked like the payload builder and was not, and
a kwarg whose name drifted between the dict and the constructor. Pinning the
shape is what catches that class.
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path

import pytest

from harness.adapters import backgammon
from harness.cumulative.run_artifacts import RunManifest

REPO = Path(__file__).resolve().parents[1]


def test_the_flag_survives_every_hop_of_the_chain():
    # 1. the adapter accepts it
    sig = inspect.signature(backgammon.BackgammonRunner.__init__)
    assert "record_at_chunk_end" in sig.parameters

    # 2. the sequencer's runner-kwargs dict passes it under the SAME name — a
    #    drift here is a TypeError at cell construction, not at import.
    seq = (REPO / "scripts" / "run_cumulative.py").read_text()
    assert '"record_at_chunk_end": bool(getattr(self, "_record_at_chunk_end", False)),' in seq

    # 3. the CLI declares it and hands it to the sequencer
    assert "--record-at-chunk-end" in seq
    assert 'record_at_chunk_end=bool(getattr(args, "record_at_chunk_end", False)),' in seq

    # 4. the run records the condition it ran under, or it cannot be compared
    assert "record_at_chunk_end" in {f for f in RunManifest.__dataclass_fields__}


def test_the_ask_is_placed_between_the_chunk_drive_and_compaction():
    """Placement IS the fix. Anywhere else and it does not solve anything.

    Run 1788976174 lost all 13 boundaries in the gap between the chunk closing
    and compaction firing. Before the chunk drive returns there is nothing to
    record; after compaction the material is gone.
    """
    src = inspect.getsource(backgammon.BackgammonRunner._run_opencode_serve_chunked)
    drive = src.index("stats = _drive(phase, chunk_prompt)")
    ask = src.index("if self.record_at_chunk_end:")
    settle = src.index("LET THE WORKER'S OWN COMPACTION SETTLE")
    assert drive < ask < settle, (
        "the ask must sit after the chunk drive and before compaction"
    )


def test_the_record_turn_is_the_compaction_boundary_when_enabled():
    """With the record turn on, IT carries the build phase — not the chunk drive.

    That is what puts the worker's own compaction after the recording instead
    of before it. With the record turn off there is no trailing turn, so the
    chunk drive is the boundary. Either way exactly one drive per chunk is
    flagged `build`, which is what the plugin's six-fire budget assumes.
    """
    on = backgammon.compact_phase_for
    # Record turn ON: the chunk drive (and any recovery nudge inside it) is
    # held; the record turn fires the compaction.
    assert on("initial-chunk-3", record_turn_enabled=True) == "repair"
    assert on("initial-chunk-3-record-3", record_turn_enabled=True) == "build"
    # Record turn OFF: the chunk drive itself is the boundary.
    assert on("initial-chunk-3", record_turn_enabled=False) == "build"
    # Repair is never a compaction point under either arm.
    for record_turn in (True, False):
        assert on("feedback-2", record_turn_enabled=record_turn) == "repair"
        assert on("something-new", record_turn_enabled=record_turn) == "repair"


def test_off_by_default_because_it_costs_a_turn():
    sig = inspect.signature(backgammon.BackgammonRunner.__init__)
    assert sig.parameters["record_at_chunk_end"].default is False


@pytest.mark.parametrize(
    "master,expected",
    [
        (None, None),  # no memory layer at all
        ({"trajectories": []}, 0),  # a layer that recorded nothing
        ({"trajectories": [{"knowledge": [1, 2]}, {"knowledge": [3]}]}, 3),
        ({"trajectories": "not a list"}, None),  # malformed
    ],
)
def test_the_gap_is_measured_from_the_artifact_not_a_self_report(tmp_path, master, expected):
    """UNREADABLE is a third answer and never collapses into zero.

    "no memory layer" and "a memory layer that recorded nothing" are different
    facts, and the second is the finding. Folding them together would hide it.
    """
    import json

    session = "ses_test"
    if master is None:
        assert backgammon._recorded_claim_count(tmp_path, session) is None
        return
    d = tmp_path / "insession" / session
    d.mkdir(parents=True)
    (d / "master.json").write_text(json.dumps(master))
    assert backgammon._recorded_claim_count(tmp_path, session) == expected


def test_a_missing_state_dir_is_unreadable_never_zero():
    assert backgammon._recorded_claim_count(None, "ses_x") is None


def test_the_prompt_says_when_and_never_how():
    """`bench/` says WHEN, the memory layer says HOW (canon-ref §3).

    Naming a tool here would put vendor protocol in the public harness and make
    the benchmark Okp-specific.
    """
    text = backgammon._RECORD_NOW_MD
    assert "okp" not in text.lower()
    assert "tool" not in text.lower()
    # And it must preserve the golden run's flexibility: an empty answer is a
    # legitimate answer, stated in the prompt itself.
    assert "nothing worth recording" in text


def test_the_prompt_carries_no_evaluation_vocabulary():
    from harness.blinding import offending_lines

    assert offending_lines(backgammon._RECORD_NOW_MD) == []


def test_the_source_parses_and_the_helper_is_module_level():
    """A nested def would be invisible to the tests above and to reuse."""
    tree = ast.parse((REPO / "harness" / "adapters" / "backgammon.py").read_text())
    names = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
    assert "_recorded_claim_count" in names
