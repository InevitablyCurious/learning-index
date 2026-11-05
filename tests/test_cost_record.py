"""Per-cell ``cost.json``: six outcomes, two phases, absent-not-zero.

WHY A CELL NEEDS A COST ARTIFACT AT ALL. Cost used to live only on the
``type:"attempt"`` status row, which is appended after the cell finishes — and
after the ``ErrorCapExceeded`` fast-fail. A stopped, crashed or capped cell
therefore lost its cost entirely, and those are exactly the cells that burn
spend without producing a measurement. The writer runs from a ``finally`` so no
exit path can skip it, which is what the outcome table below pins.

WHY THESE TESTS DRIVE THE REAL HELPERS. The rules being asserted are the
writer's own (one void classification, peaks that never sum, a total that never
mixes a priced phase with an unpriced one), so a re-implementation in the test
would only prove the test agrees with itself. ``_cost_record`` /
``_write_cost_json`` / ``_cell_outcome`` are called as the runner calls them,
and the six-outcome case drives ``run_session`` end-to-end with a stubbed
``run_cell`` so the ``finally`` path is exercised rather than assumed.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from harness.adapters.challenge import ERROR_CAP_PER_TYPE, ErrorCapExceeded
from harness.adapters.challenge.models import ChallengeCellResult, PhaseCost
from harness.cumulative.run_artifacts import cell_void
from harness.cumulative.types import PhaseGroup, SessionRecord

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
from run_cumulative import runner as runner_mod


def _cell_result(**overrides: Any) -> ChallengeCellResult:
    """A real ``ChallengeCellResult`` for a cell that ran and was graded.

    The real dataclass, not a stub: the writer reads it through ``getattr`` with
    defaults, so a fake would silently absorb a field the writer renames.
    """
    defaults: dict[str, Any] = {
        "verdict": "PASS",
        "attempts_to_green": 1,
        "termination_reason": "gates_green",
        "conformed": True,
        "input_tokens": 100,
        "output_tokens": 50,
        "turns": 3,
        "wall_seconds": 12.5,
        "delivery": "verified",
        "failed_gates": [],
        "problems_final": [],
        "attempt_reports": [],
        "worktree": "",
        "session_id": "sid-1",
        "memory_mode": "off",
        "model": "local-llm-proxy/x",
    }
    defaults.update(overrides)
    return ChallengeCellResult(**defaults)


def _session(sequence_index: int) -> SessionRecord:
    return SessionRecord(
        sequence_index=sequence_index,
        model="local-llm-proxy/x",
        provider_pin="local",
        memory_mode="off",
        phase_group=PhaseGroup.OFF_BASELINE.value,
        phase="RUN_SESSION",
    )


class _FakeSpendMeter:
    """No spend DB: prices and contention are read elsewhere / not at all here."""

    def model_identity(self, session_id: str) -> list[Any]:
        return []

    def contention_covariates(self, *args: Any, **kwargs: Any) -> Any:
        from harness.contention import ContentionCovariates

        return ContentionCovariates.empty()


def _build_runner(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    behaviour: Callable[[], Any],
) -> Any:
    """A partially constructed ``RealSessionRunner`` whose cell is ``behaviour``.

    Built via ``__new__`` (precedent: tests/test_cumulative_wiring.py) so only
    the seams ``run_session`` actually reaches are set. ``OKP_PROXY_RUNS_DIR``
    is pointed at an empty dir: served-model observation must read nothing from
    a real relay log on the machine running the suite.
    """
    empty_proxy = tmp_path / "empty-proxy-runs"
    empty_proxy.mkdir()
    monkeypatch.setenv("OKP_PROXY_RUNS_DIR", str(empty_proxy))

    class _FakeCellRunner:
        def __init__(self, **kwargs: Any) -> None:
            self._kwargs = kwargs

        def run_cell(
            self,
            run_label: str,
            run_dir: Path,
            task_id: str = "backgammon",
            run_identity: str | None = None,
        ) -> Any:
            return behaviour()

    runs_dir = tmp_path / "runs"
    runner = runner_mod.RealSessionRunner.__new__(runner_mod.RealSessionRunner)
    runner._session_states = {}
    runner._error_totals = {
        "guard_aborted_turns": 0,
        "finalize_timeout_turns": 0,
        "stalled_turns": 0,
    }
    runner._runs_dir = runs_dir
    runner._task_dir = tmp_path / "task"
    runner._task = "backgammon"
    runner._org_id = "org-test"
    runner._repo_root = tmp_path
    runner._proxy_base_url = "http://127.0.0.1:11434/v1"
    runner._proxy_token = "proxy-token-value"
    runner._progress = lambda message: None
    runner._run_identity = "test-run-identity"
    runner._run_manifest_base_path = str(runs_dir / "manifest.json")
    runner._run_manifest_written = False
    runner._spend_meter = _FakeSpendMeter()
    runner._runner_cls = _FakeCellRunner
    return runner


def _read_cost(run_dir: Path) -> dict[str, Any]:
    path = run_dir / runner_mod.COST_FILENAME
    assert path.is_file(), f"cost.json missing at {path}"
    return json.loads(path.read_text(encoding="utf-8"))


# ── THE SIX ENDINGS, EACH PRICED ─────────────────────────────────────────────
#
# One vocabulary for every exit a cell can have. ``passed`` /
# ``failed`` / ``aborted_compaction`` come from ``_cell_outcome`` (the cell
# returned), ``stopped`` / ``crashed`` / ``error_cap`` from ``run_session``'s
# own except arms (the cell raised). Both halves are asserted, because a cell
# that never returned is the one whose cost used to vanish.


def _passed() -> Any:
    return _cell_result(verdict="PASS")


def _failed() -> Any:
    return _cell_result(verdict="FAIL", termination_reason="gates_red")


def _aborted_compaction() -> Any:
    # Two completed compactions before any grade: the harness ended the cell,
    # so this is neither a pass nor a capability failure.
    return _cell_result(verdict="FAIL", termination_reason="compactions_before_grade")


def _stopped() -> Any:
    raise KeyboardInterrupt()


def _crashed() -> Any:
    raise RuntimeError("cell died")


def _error_cap() -> Any:
    return _cell_result(guard_aborted_turns=ERROR_CAP_PER_TYPE + 1)


_CASES: list[tuple[str, Callable[[], Any], type[BaseException] | None]] = [
    ("passed", _passed, None),
    ("failed", _failed, None),
    ("aborted_compaction", _aborted_compaction, None),
    ("stopped", _stopped, KeyboardInterrupt),
    ("crashed", _crashed, RuntimeError),
    ("error_cap", _error_cap, ErrorCapExceeded),
]


@pytest.mark.parametrize(
    ("expected_outcome", "behaviour", "raises"), _CASES, ids=[c[0] for c in _CASES]
)
def test_cost_json_is_written_for_every_outcome(
    expected_outcome: str,
    behaviour: Callable[[], Any],
    raises: type[BaseException] | None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every exit writes ``cost.json``, and it names the exit.

    The three raising cases are the ones the old attempt-row-only accounting
    lost: the row is appended after the cell finishes, so a stopped, crashed or
    capped cell had no cost record anywhere.
    """
    runner = _build_runner(tmp_path, monkeypatch, behaviour)
    session = _session(0)
    if raises is None:
        runner.run_session(session)
    else:
        with pytest.raises(raises):
            runner.run_session(session)

    run_dir = runner._state_for_session(session).run_dir
    record = _read_cost(run_dir)
    assert record["outcome"] == expected_outcome
    assert "phases" in record
    assert "void" in record


def test_a_cell_that_never_returned_records_no_phase_at_all(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Stopped/crashed: ``phases`` is EMPTY, never a zeroed phase.

    There is no result to read a phase aggregate from, and a zeroed build would
    claim the phase ran and cost nothing — a false measurement that sums
    cleanly and understates the run.
    """
    runner = _build_runner(tmp_path, monkeypatch, _crashed)
    session = _session(0)
    with pytest.raises(RuntimeError):
        runner.run_session(session)

    record = _read_cost(runner._state_for_session(session).run_dir)
    assert record["outcome"] == "crashed"
    assert record["phases"] == {}
    # A crash is a recorded crash, not a void: nothing was measured, so there
    # is no measurement to discard.
    assert record["void"] == {"is_void": False, "reason": None}


def test_cell_outcome_names_the_compaction_abort_not_a_failure() -> None:
    """``_cell_outcome`` splits the two non-green endings it can see."""
    assert runner_mod._cell_outcome(_cell_result(verdict="PASS")) == "passed"
    assert runner_mod._cell_outcome(_cell_result(verdict="FAIL")) == "failed"
    assert (
        runner_mod._cell_outcome(
            _cell_result(verdict="FAIL", termination_reason="compactions_before_grade")
        )
        == "aborted_compaction"
    )


# ── TWO PHASES, ONE TOTAL ────────────────────────────────────────────────────


def test_build_and_troubleshooting_partition_and_the_total_combines(
    tmp_path: Path,
) -> None:
    """Cost answers "building vs troubleshooting"; the total recombines them.

    Additive fields SUM, ``context_peak`` takes the MAX (peaks do not add), and
    ``cost_usd`` sums only because both phases are priced.
    """
    build = PhaseCost(
        input_tokens=100,
        output_tokens=20,
        turns=2,
        wall_seconds=10.0,
        context_peak=5_000,
        cost_usd=0.5,
    )
    troubleshooting = PhaseCost(
        input_tokens=40,
        output_tokens=10,
        turns=3,
        wall_seconds=4.0,
        context_peak=9_000,
        cost_usd=0.25,
    )
    result = _cell_result(build_phase=build, troubleshooting_phase=troubleshooting)

    record = runner_mod._cost_record(
        outcome="passed", result=result, run_dir=tmp_path / "cell"
    )
    phases = record["phases"]
    assert phases["build"]["input_tokens"] == 100
    assert phases["build"]["turns"] == 2
    assert phases["build"]["context_peak"] == 5_000
    assert phases["troubleshooting"]["input_tokens"] == 40
    assert phases["troubleshooting"]["turns"] == 3
    assert phases["troubleshooting"]["context_peak"] == 9_000

    total = phases["total"]
    assert total["input_tokens"] == 140
    assert total["output_tokens"] == 30
    assert total["turns"] == 5
    assert total["wall_seconds"] == 14.0
    assert total["context_peak"] == 9_000  # a peak, not a sum
    assert total["cost_usd"] == 0.75


def _write_report(run_dir: Path, attempt: int, statuses: list[str]) -> None:
    """Publish one attempt report whose gate rows carry ``statuses``."""
    rows = [
        {"gate": f"g{index}", "status": status} for index, status in enumerate(statuses)
    ]
    (run_dir / f"attempt-{attempt}-report.json").write_text(
        json.dumps({"gate_results": rows}), encoding="utf-8"
    )


def test_attempt_reports_grade_the_phase_they_belonged_to(tmp_path: Path) -> None:
    """Attempt 1 is the BUILD's grade; attempts 2..N are troubleshooting's.

    ``not_run`` / ``error`` are the instrument's own silence, so they belong to
    no denominator: the graded total counts decided rows only.
    """
    run_dir = tmp_path / "cell-0001"
    run_dir.mkdir()
    _write_report(run_dir, 1, ["pass", "fail", "not_run"])
    _write_report(run_dir, 2, ["pass"])
    result = _cell_result(
        build_phase=PhaseCost(turns=2), troubleshooting_phase=PhaseCost(turns=1)
    )

    phases = runner_mod._cost_record(outcome="passed", result=result, run_dir=run_dir)[
        "phases"
    ]
    assert phases["build"]["grades"] == {"total": 2, "passed": 1, "failed": 1}
    assert phases["troubleshooting"]["grades"] == {
        "total": 1,
        "passed": 1,
        "failed": 0,
    }
    assert phases["total"]["grades"] == {"total": 3, "passed": 2, "failed": 1}


def test_no_build_phase_leaves_attempt_one_ungraded_rather_than_mislabelled(
    tmp_path: Path,
) -> None:
    """A seeded cell grades the seed tree — attempt 1 is not a build's grade.

    The adapter sets ``build_phase`` exactly when a build ran, so its absence
    leaves attempt 1 unattributed; there is no phase to hang the number on.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    _write_report(run_dir, 1, ["pass"])

    record = runner_mod._cost_record(
        outcome="passed", result=_cell_result(), run_dir=run_dir
    )
    assert record["phases"] == {}


# ── ABSENT IS NOT ZERO ───────────────────────────────────────────────────────


def test_a_local_model_carries_no_cost_usd_key(tmp_path: Path) -> None:
    """A local cell has no dollars at all: the KEY is absent, not ``0.0``.

    Zero would be indistinguishable from a genuinely free remote call and would
    let a local cell masquerade as a priced one in any aggregate.
    """
    result = _cell_result(
        build_phase=PhaseCost(input_tokens=10, turns=1, cost_usd=None)
    )
    phases = runner_mod._cost_record(
        outcome="passed", result=result, run_dir=tmp_path / "cell"
    )["phases"]
    assert "cost_usd" not in phases["build"]
    assert "cost_usd" not in phases["total"]


def test_an_unobserved_field_is_absent_not_zeroed(tmp_path: Path) -> None:
    """Only observed fields are written — no ``turns: 0`` for a phase that died."""
    result = _cell_result(
        build_phase=PhaseCost(input_tokens=10, turns=None, wall_seconds=None)
    )
    phases = runner_mod._cost_record(
        outcome="passed", result=result, run_dir=tmp_path / "cell"
    )["phases"]
    assert set(phases["build"]) == {"input_tokens"}
    assert set(phases["total"]) == {"input_tokens"}


def test_a_total_never_mixes_a_priced_phase_with_an_unpriced_one(
    tmp_path: Path,
) -> None:
    """Half a cell's spend is worse than no number: it reads as the whole cost.

    ``cost_usd`` appears on the total only when EVERY observed phase carries
    it; the additive fields still sum across the pair.
    """
    build = PhaseCost(input_tokens=10, cost_usd=0.5)
    troubleshooting = PhaseCost(input_tokens=5)  # a local phase: no dollars
    result = _cell_result(build_phase=build, troubleshooting_phase=troubleshooting)
    total = runner_mod._cost_record(
        outcome="passed", result=result, run_dir=tmp_path / "cell"
    )["phases"]["total"]
    assert "cost_usd" not in total
    assert total["input_tokens"] == 15


# ── ONE VOID RULE ────────────────────────────────────────────────────────────
#
# VOID-INSTRUMENT means the instrument failed to measure, so the cell is never
# scored as a capability FAIL. ``cell_void`` is that rule's only definition; the
# cost writer calls it and never re-derives it.


def test_a_green_cell_is_never_void_over_a_truncation() -> None:
    """A green terminal attempt is scored PASS, whatever happened underneath."""
    record = {"progress": {"full_green": True}, "provider_truncations": 2}
    assert cell_void(record) == {"is_void": False, "reason": None}


@pytest.mark.parametrize("counter", ["truncated_turns", "instrument_anomaly_turns"])
def test_recovered_truncation_alone_never_voids(counter: str) -> None:
    """``truncated_turns`` is ALL anomalies and ``instrument_anomaly_turns`` is
    recoverable transport errors — voiding on either discarded measured cells.

    Measured on run 1788599410: five graded attempts over a looping model the
    harness had caught and recovered were discarded as "truncations".
    """
    record = {"progress": {"full_green": False}, counter: 3}
    assert cell_void(record)["is_void"] is False


def test_an_unrecovered_anomaly_voids_the_cell() -> None:
    """The UNRECOVERED complement is the void signal, named as such."""
    record = {
        "progress": {"full_green": False},
        "instrument_anomaly_turns": 3,
        "unrecovered_anomaly_turns": 1,
    }
    verdict = cell_void(record)
    assert verdict["is_void"] is True
    assert verdict["reason"] == "provider_truncation"


def test_the_cost_record_defers_to_the_one_void_rule(tmp_path: Path) -> None:
    """The writer's ``void`` block is ``cell_void``'s verdict, not a second rule.

    Same facts, two verdicts: green → not void; non-green with a provider
    truncation → void, with the reason the single rule returned.
    """
    green = runner_mod._cost_record(
        outcome="passed",
        result=_cell_result(verdict="PASS", provider_truncations=3),
        run_dir=tmp_path / "green",
    )
    assert green["void"] == {"is_void": False, "reason": None}

    red = runner_mod._cost_record(
        outcome="failed",
        result=_cell_result(verdict="FAIL", provider_truncations=3),
        run_dir=tmp_path / "red",
    )
    assert red["void"] == {"is_void": True, "reason": "provider_truncation"}
