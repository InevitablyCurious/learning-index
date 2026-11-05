"""Per-cell ``cost.json``: six outcomes, on-disk phases, absent-not-zero.

WHY A CELL NEEDS A COST ARTIFACT AT ALL. Cost used to live only on the
``type:"attempt"`` status row, which is appended after the cell finishes — and
after the ``ErrorCapExceeded`` fast-fail. A stopped, crashed or capped cell
therefore lost its cost entirely, and those are exactly the cells that burn
spend without producing a measurement. The writer runs from a ``finally`` so no
exit path can skip it, which is what the outcome table below pins.

WHY THESE TESTS DRIVE THE REAL PATH. The rules being asserted are the writer's
own — one void classification, peaks that never sum, absent fields that stay
absent — so a re-implementation in the test would only prove the test agrees
with itself. Here the phases come from ``derive_cost_from_disk`` over fixtures
built the way the cell's own components build them (``tests/cost_fixture.py``),
``_cost_record`` / ``_write_cost_json`` / ``_cell_outcome`` are called as the
runner calls them, and the six-outcome case and the stopped-while-paused case
drive ``run_session`` end-to-end with a stubbed ``run_cell`` so the ``finally``
path is exercised rather than assumed.

THE CELL THIS FILE EXISTS FOR is the stopped-while-paused one: the session DB,
the live stream and attempt 1's report all landed, then an operator killed the
cell inside a pause. It never returned a result, so every figure in its record
has to come from disk — and it does, down to the 140.793s the pause held.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from harness.adapters.challenge import ERROR_CAP_PER_TYPE, ErrorCapExceeded
from harness.adapters.challenge.models import ChallengeCellResult
from harness.cumulative.run_artifacts import cell_void
from harness.cumulative.types import PhaseGroup, SessionRecord
from tests import cost_fixture

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
from run_cumulative import runner as runner_mod
from run_cumulative.cost_from_disk import derive_cost_from_disk


def _cell_result(**overrides: Any) -> ChallengeCellResult:
    """A real ``ChallengeCellResult`` for a cell that ran and was graded.

    The real dataclass, not a stub: the writer's void verdict reads it through
    ``getattr`` with defaults, so a fake would silently absorb a field that
    moved.
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
    behaviour: Callable[[Path], Any],
) -> Any:
    """A partially constructed ``RealSessionRunner`` whose cell is ``behaviour``.

    ``behaviour`` receives the cell's ``run_dir`` — the directory the real
    adapter publishes its session DB, live stream and reports into — so a case
    can plant disk artifacts and THEN die, which is exactly the ending whose
    cost used to vanish.

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
            return behaviour(run_dir)

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


# ── THE SIX ENDINGS, EACH RECORDED ──────────────────────────────────────────
#
# One vocabulary for every exit a cell can have. ``passed`` /
# ``failed`` / ``aborted_compaction`` come from ``_cell_outcome`` (the cell
# returned), ``stopped`` / ``crashed`` / ``error_cap`` from ``run_session``'s
# own except arms (the cell raised). Both halves are asserted, because a cell
# that never returned is the one whose cost used to vanish — and ``void`` says
# which of those endings means the instrument never measured the cell.


def _passed(run_dir: Path) -> Any:
    return _cell_result(verdict="PASS")


def _failed(run_dir: Path) -> Any:
    return _cell_result(verdict="FAIL", termination_reason="gates_red")


def _aborted_compaction(run_dir: Path) -> Any:
    # Two completed compactions before any grade: the harness ended the cell,
    # so this is neither a pass nor a capability failure.
    return _cell_result(verdict="FAIL", termination_reason="compactions_before_grade")


def _stopped(run_dir: Path) -> Any:
    raise KeyboardInterrupt()


def _stopped_while_paused(run_dir: Path) -> Any:
    """The real ending: every artifact published, then the operator stopped it.

    Nothing is returned, so ``run_session`` records the outcome from the raised
    exception and the ``finally`` builds the record from these files alone.
    """
    cost_fixture.write_stopped_while_paused(run_dir)
    raise KeyboardInterrupt()


def _crashed(run_dir: Path) -> Any:
    raise RuntimeError("cell died")


def _error_cap(run_dir: Path) -> Any:
    return _cell_result(guard_aborted_turns=ERROR_CAP_PER_TYPE + 1)


_CASES: list[
    tuple[str, Callable[[Path], Any], type[BaseException] | None, dict[str, Any]]
] = [
    ("passed", _passed, None, {"is_void": False, "reason": None}),
    ("failed", _failed, None, {"is_void": False, "reason": None}),
    (
        "aborted_compaction",
        _aborted_compaction,
        None,
        {"is_void": True, "reason": "compactions_before_grade"},
    ),
    ("stopped", _stopped, KeyboardInterrupt, {"is_void": True, "reason": "stopped"}),
    ("crashed", _crashed, RuntimeError, {"is_void": True, "reason": "crashed"}),
    ("error_cap", _error_cap, ErrorCapExceeded, {"is_void": False, "reason": None}),
]


@pytest.mark.parametrize(
    ("expected_outcome", "run_cell", "raises", "expected_void"),
    _CASES,
    ids=[case[0] for case in _CASES],
)
def test_cost_json_is_written_for_every_outcome(
    expected_outcome: str,
    run_cell: Callable[[Path], Any],
    raises: type[BaseException] | None,
    expected_void: dict[str, Any],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every exit writes ``cost.json``, and it names the exit and its void.

    The three raising cases are the ones the old attempt-row-only accounting
    lost: the row is appended after the cell finishes, so a stopped, crashed or
    capped cell had no cost record anywhere. A stopped or crashed cell did not
    finish, so it is void WITH the ending as its reason; an aborted compaction
    is void on the rule's own name for it.
    """
    runner = _build_runner(tmp_path, monkeypatch, run_cell)
    session = _session(0)
    if raises is None:
        runner.run_session(session)
    else:
        with pytest.raises(raises):
            runner.run_session(session)

    record = _read_cost(runner._state_for_session(session).run_dir)
    assert record["outcome"] == expected_outcome
    assert "phases" in record
    assert record["void"] == expected_void


def test_a_cell_with_no_artifacts_records_no_phase_at_all(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Crashed with nothing on disk: ``phases`` is EMPTY, never a zeroed phase.

    These behaviours publish no session DB, no live stream and no report — the
    state a cell is in when it dies before its first turn. A zeroed build would
    claim the phase ran and cost nothing: a false measurement that sums cleanly
    and understates the run.
    """
    runner = _build_runner(tmp_path, monkeypatch, _crashed)
    session = _session(0)
    with pytest.raises(RuntimeError):
        runner.run_session(session)

    record = _read_cost(runner._state_for_session(session).run_dir)
    assert record["outcome"] == "crashed"
    assert record["phases"] == {}
    assert "paused_seconds" not in record
    # A crash is void: the cell never finished, so it measured nothing.
    assert record["void"] == {"is_void": True, "reason": "crashed"}


def test_a_cell_stopped_while_paused_still_records_its_full_cost(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE CELL THIS RECORD EXISTS FOR: no result, and a complete accounting.

    ``run_session`` sees only a ``KeyboardInterrupt``; the adapter returned
    nothing at all. Every figure below is read back out of the cell's disk
    artifacts, so this asserts the end-to-end path — outcome, void, the 140.793s
    the operator's pause held, and the build's tokens, turns, compactions,
    grades, peak and net wall.

    The numbers are hardcoded, not recomputed from the fixture: a test that
    re-derived them would agree with any fixture it was handed.
    """
    runner = _build_runner(tmp_path, monkeypatch, _stopped_while_paused)
    session = _session(0)
    with pytest.raises(KeyboardInterrupt):
        runner.run_session(session)

    record = _read_cost(runner._state_for_session(session).run_dir)
    assert record["outcome"] == "stopped"
    assert record["void"] == {"is_void": True, "reason": "stopped"}
    # pause.start 1793882346528 → cell.end 1793882487321, never released.
    assert record["paused_seconds"] == pytest.approx(140.793)

    phases = record["phases"]
    # Stopped before any troubleshooting round: the phase never opened, and its
    # (0.052s) span is folded into the build's wall rather than dropped.
    assert "troubleshooting" not in phases
    build = phases["build"]
    assert build["input_tokens"] == 6_300
    assert build["output_tokens"] == 2_100
    assert build["reasoning_tokens"] == 1_120
    assert build["cache_read_tokens"] == 840
    assert build["cache_write_tokens"] == 140
    assert build["turns"] == 3
    assert build["compactions"] == 5
    assert build["context_peak"] == 4_000
    assert build["grades"] == {"total": 2, "passed": 1, "failed": 1}
    assert build["wall_seconds"] == pytest.approx(5_781.029)
    assert phases["total"]["wall_seconds"] == pytest.approx(5_781.029)
    assert phases["total"]["turns"] == 3
    assert phases["total"]["compactions"] == 5


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


# ── TWO PHASES, ONE TOTAL ───────────────────────────────────────────────────


def test_build_and_troubleshooting_partition_and_the_total_combines(
    tmp_path: Path,
) -> None:
    """Cost answers "building vs troubleshooting"; the total recombines them.

    Additive fields SUM, ``context_peak`` takes the MAX (peaks do not add), and
    the phases are split on the live stream's attempt-1 ``attempt.end`` — the
    first graded round's end — not on any timestamp the DB carries.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    cost_fixture.write_partitioned(run_dir)

    phases = runner_mod._cost_record(
        outcome="passed",
        run_dir=run_dir,
        void={"is_void": False, "reason": None},
    )["phases"]
    build = phases["build"]
    assert build["input_tokens"] == 2_100
    assert build["turns"] == 2
    assert build["compactions"] == 1
    assert build["context_peak"] == 2_000
    assert build["wall_seconds"] == pytest.approx(100.0)

    troubleshooting = phases["troubleshooting"]
    assert troubleshooting["input_tokens"] == 2_220
    assert troubleshooting["turns"] == 1
    assert troubleshooting["compactions"] == 1
    assert troubleshooting["context_peak"] == 3_000
    assert troubleshooting["wall_seconds"] == pytest.approx(60.0)

    total = phases["total"]
    assert total["input_tokens"] == 4_320
    assert total["output_tokens"] == 1_440
    assert total["reasoning_tokens"] == 744
    assert total["cache_read_tokens"] == 612
    assert total["cache_write_tokens"] == 84
    assert total["turns"] == 3
    assert total["compactions"] == 2
    assert total["wall_seconds"] == pytest.approx(160.0)
    assert total["context_peak"] == 3_000  # a peak, not a sum
    # Wall is net of pauses, and this cell held none.
    assert runner_mod._cost_record(
        outcome="passed",
        run_dir=run_dir,
        void={"is_void": False, "reason": None},
    )["paused_seconds"] == pytest.approx(0.0)


def test_attempt_reports_grade_the_phase_they_belonged_to(tmp_path: Path) -> None:
    """Attempt 1 is the BUILD's grade; attempts 2..N are troubleshooting's.

    ``not_run`` / ``error`` are the instrument's own silence, so they belong to
    no denominator: the graded total counts decided rows only.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    cost_fixture.write_partitioned(run_dir)

    phases = runner_mod._cost_record(
        outcome="passed",
        run_dir=run_dir,
        void={"is_void": False, "reason": None},
    )["phases"]
    assert phases["build"]["grades"] == {"total": 2, "passed": 1, "failed": 1}
    assert phases["troubleshooting"]["grades"] == {
        "total": 2,
        "passed": 2,
        "failed": 0,
    }
    assert phases["total"]["grades"] == {"total": 4, "passed": 3, "failed": 1}


def test_grades_alone_still_open_the_phase_they_belong_to(tmp_path: Path) -> None:
    """A report with no session DB and no anchors still grades its phase.

    The reports are published before the loop can die, so they are the only
    grade source that survives every exit — and a phase that was graded opened
    even when nothing else about it was observed. Nothing is invented to fill
    the rest: no token sums, no wall.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    cost_fixture.write_report(run_dir, 1, ["pass", "fail", "not_run"])
    cost_fixture.write_report(run_dir, 2, ["pass"])

    phases = runner_mod._cost_record(
        outcome="passed",
        run_dir=run_dir,
        void={"is_void": False, "reason": None},
    )["phases"]
    assert set(phases["build"]) == {"grades"}
    assert set(phases["troubleshooting"]) == {"grades"}
    assert phases["total"]["grades"] == {"total": 3, "passed": 2, "failed": 1}


# ── ABSENT IS NOT ZERO ───────────────────────────────────────────────────────


def test_an_empty_cell_derives_no_phases_and_no_pause(tmp_path: Path) -> None:
    """Nothing landed: ``{"phases": {}, "paused_seconds": None}``, not zeros."""
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()

    derived = derive_cost_from_disk(run_dir)
    assert derived == {"phases": {}, "paused_seconds": None}
    record = runner_mod._cost_record(
        outcome="crashed", run_dir=run_dir, void={"is_void": True, "reason": "crashed"}
    )
    assert record["phases"] == {}
    assert "paused_seconds" not in record


def test_a_db_only_cell_omits_wall_and_grades(tmp_path: Path) -> None:
    """No live stream means no wall; no report means no grades — both ABSENT.

    ``0.0`` seconds would claim the phase took no time and ``{"total": 0}``
    would claim it graded nothing and passed, when neither was observed.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    cost_fixture.write_session_db(run_dir, cost_fixture.PARTITION_MESSAGES[:2])

    phases = derive_cost_from_disk(run_dir)["phases"]
    assert set(phases) == {"build", "total"}
    assert "wall_seconds" not in phases["build"]
    assert "grades" not in phases["build"]
    assert "wall_seconds" not in phases["total"]
    assert "grades" not in phases["total"]
    assert phases["build"]["turns"] == 2
    assert phases["build"]["compactions"] == 0


def test_a_live_only_cell_records_wall_and_nothing_else(tmp_path: Path) -> None:
    """Anchors alone give the whole net wall; no tokens, turns or grades exist.

    Wall is enough to make a build — a cell that ran consumed real time — and
    with no troubleshooting activity the entire span is the build's.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    cost_fixture.write_live(
        run_dir,
        [
            {"v": 1, "ts": cost_fixture.PARTITION_START_MS, "kind": "cell.start"},
            {
                "v": 1,
                "ts": cost_fixture.PARTITION_BOUNDARY_MS,
                "kind": "attempt.end",
                "attempt": 1,
            },
            {"v": 1, "ts": cost_fixture.PARTITION_END_MS, "kind": "cell.end"},
        ],
    )

    derived = derive_cost_from_disk(run_dir)
    phases = derived["phases"]
    assert set(phases) == {"build", "total"}
    assert set(phases["build"]) == {"wall_seconds"}
    assert phases["build"]["wall_seconds"] == pytest.approx(160.0)
    assert set(phases["total"]) == {"wall_seconds"}
    assert "troubleshooting" not in phases


def test_the_derivation_never_emits_cost_usd(tmp_path: Path) -> None:
    """The disk path has no pricing: the KEY is absent everywhere, not ``0.0``.

    A local cell has no dollars at all, and a zero would be indistinguishable
    from a genuinely free remote call in any aggregate.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    cost_fixture.write_partitioned(run_dir)

    phases = runner_mod._cost_record(
        outcome="passed",
        run_dir=run_dir,
        void={"is_void": False, "reason": None},
    )["phases"]
    for name, phase in phases.items():
        assert "cost_usd" not in phase, f"{name} carries cost_usd"
    assert set(phases) == {"build", "troubleshooting", "total"}


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
    truncation → void, with the reason the single rule returned. Driven through
    ``_write_cost_json`` so the record is read back from the artifact.
    """
    green_dir = tmp_path / "green"
    runner_mod._write_cost_json(
        green_dir,
        outcome="passed",
        result=_cell_result(verdict="PASS", provider_truncations=3),
    )
    assert _read_cost(green_dir)["void"] == {"is_void": False, "reason": None}

    red_dir = tmp_path / "red"
    runner_mod._write_cost_json(
        red_dir,
        outcome="failed",
        result=_cell_result(verdict="FAIL", provider_truncations=3),
    )
    assert _read_cost(red_dir)["void"] == {
        "is_void": True,
        "reason": "provider_truncation",
    }
