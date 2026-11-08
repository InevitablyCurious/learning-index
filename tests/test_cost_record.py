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

#: The real plan's phase names, for the fixtures built inline below. The
#: derivation carries whatever name a label gives it, so these only have to look
#: like a cell's own labels — one backend phase, one layer.
BACKEND_PHASE = "Backend 1 — engine"
LAYER_PHASE = "Layer 1 — board and controls"


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


def _assert_bucket_matches(actual: dict[str, Any], expected: dict[str, Any]) -> None:
    """``actual`` is ``expected`` — same fields, same numbers, wall to the second.

    Two buckets that disagree on their FIELD SET are a bug in either case: a key
    one path invents or drops is exactly the "absent, never zero" failure these
    tests exist for, so the sets are compared before the values.
    """
    assert set(actual) == set(expected)
    for field, value in expected.items():
        if field == "wall_seconds":
            assert actual[field] == pytest.approx(value), field
        else:
            assert actual[field] == value, field


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
    assert record["paused_seconds"] is None
    # A crash is void: the cell never finished, so it measured nothing.
    assert record["void"] == {"is_void": True, "reason": "crashed"}


def test_a_cell_stopped_while_paused_still_records_its_full_cost(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE CELL THIS RECORD EXISTS FOR: no result, and a complete accounting.

    ``run_session`` sees only a ``KeyboardInterrupt``; the adapter returned
    nothing at all. Every figure below is read back out of the cell's disk
    artifacts, so this asserts the end-to-end path — outcome, void, the 140.793s
    the operator's pause held, and the phase's own build: tokens, turns,
    compactions, grades, peak and net wall.

    The numbers are hardcoded, not recomputed from the fixture: a test that
    re-derived them would agree with any fixture it was handed. The wall is
    checked TWICE — once as its value and once as the identity it has to satisfy
    (the cell's whole span MINUS the 140.793s the pause held), because a wall
    that silently kept the pause would still be "a number".
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
    assert set(phases["by_phase"]) == {"1"}
    phase = phases["by_phase"]["1"]
    assert phase["name"] == cost_fixture.STOPPED_PHASE_NAME
    # A backend phase carries no grader layer, and the cell was stopped before
    # any troubleshooting round, so its repair bucket never opened.
    assert "layer" not in phase
    assert set(phase) == {"name", "build"}

    build = phase["build"]
    assert build["input_tokens"] == 6_300
    assert build["output_tokens"] == 2_100
    assert build["reasoning_tokens"] == 1_120
    assert build["cache_read_tokens"] == 840
    assert build["cache_write_tokens"] == 140
    assert build["turns"] == 3
    assert build["compactions"] == 5
    assert build["context_peak"] == 4_000
    assert build["grades"] == {
        "count": 1,
        "last": {"total": 2, "passed": 1, "failed": 1},
    }
    # Phase start → cell end is 5_921.819s, the pause held 140.793s of it, and
    # the wall is NET of that hold: 5_781.026s.
    held_ms = cost_fixture.CELL_END_MS - cost_fixture.PAUSE_START_MS
    gross_ms = cost_fixture.CELL_END_MS - cost_fixture.STOPPED_PHASE_START_MS
    assert build["wall_seconds"] == pytest.approx(5_781.026)
    assert build["wall_seconds"] == pytest.approx((gross_ms - held_ms) / 1000.0)
    # One phase, one build: every roll-up IS that bucket, and no repair roll-up
    # exists because no repair bucket ever opened.
    assert "troubleshooting" not in phases
    _assert_bucket_matches(phases["build"], build)
    _assert_bucket_matches(phases["total"], build)


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
    """Cost answers "building vs troubleshooting" PER PHASE, and recombines them.

    One layered phase that was built, graded, repaired and graded again: the
    build interval is everything up to the phase's own first ``attempt.end``, the
    repair interval is everything after it, and the two roll-ups are the
    arithmetic recombinations of those buckets — additive fields SUM,
    ``context_peak`` takes the MAX (peaks do not add), grade counts ADD.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    cost_fixture.write_partitioned(run_dir)

    phases = runner_mod._cost_record(
        outcome="passed",
        run_dir=run_dir,
        void={"is_void": False, "reason": None},
    )["phases"]
    assert set(phases["by_phase"]) == {str(cost_fixture.PARTITION_PHASE_INDEX)}
    entry = phases["by_phase"][str(cost_fixture.PARTITION_PHASE_INDEX)]
    assert entry["name"] == cost_fixture.PARTITION_PHASE_NAME
    assert entry["layer"] == cost_fixture.PARTITION_PHASE_LAYER

    build = entry["build"]
    assert build["input_tokens"] == 2_100
    assert build["turns"] == 2
    assert build["compactions"] == 1
    assert build["context_peak"] == 2_000
    assert build["wall_seconds"] == pytest.approx(100.0)

    troubleshooting = entry["troubleshooting"]
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

    # RULE: each roll-up IS the sum over the per-phase buckets — no second
    # accounting, so a bucket that stopped being folded shows up here.
    _assert_bucket_matches(
        phases["build"], cost_fixture.recombine_buckets(phases, "build")
    )
    _assert_bucket_matches(
        phases["troubleshooting"],
        cost_fixture.recombine_buckets(phases, "troubleshooting"),
    )
    _assert_bucket_matches(
        phases["total"],
        cost_fixture.recombine_buckets(phases, "build", "troubleshooting"),
    )
    # Wall is net of pauses, and this cell held none.
    assert runner_mod._cost_record(
        outcome="passed",
        run_dir=run_dir,
        void={"is_void": False, "reason": None},
    )["paused_seconds"] == pytest.approx(0.0)


def test_attempt_reports_grade_the_phase_they_belonged_to(tmp_path: Path) -> None:
    """A report grades the phase its own ``attempt.end`` LABELLED, not a number.

    The numbers here are deliberately OUT OF ORDER: attempt **2** finished the
    first phase's build and attempt **1** is the second phase's repair round. An
    attempt number is a cell-global counter — reading it as "attempt 1 is the
    build" is what billed six of seven build phases as troubleshooting — so
    attempt 1 must land on phase 4's troubleshooting and nowhere else.

    ``not_run`` / ``error`` are the instrument's own silence and belong to no
    denominator, and a report whose attempt has no label at all is in NO bucket:
    nothing on disk says which phase graded it, and a guess is the inference this
    replaced.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    base_ms = 1_794_000_000_000
    backend = BACKEND_PHASE
    layer = LAYER_PHASE
    cost_fixture.write_live(
        run_dir,
        [
            {"v": 1, "ts": base_ms, "kind": "cell.start"},
            cost_fixture.phase_start(1, backend, "build", base_ms),
            cost_fixture.attempt_end(2, 1, backend, "build", base_ms + 50_000),
            cost_fixture.phase_start(4, layer, "build", base_ms + 50_000, 1),
            cost_fixture.attempt_end(
                1, 4, layer, "troubleshooting", base_ms + 90_000, 1
            ),
            {"v": 1, "ts": base_ms + 90_000, "kind": "cell.end"},
        ],
    )
    # Attempt 1 (the number that "must be the build's") is phase 4's repair.
    cost_fixture.write_report(run_dir, 1, ["pass", "pass"])
    cost_fixture.write_report(run_dir, 2, ["pass", "fail", "not_run"])
    # Attempt 3 published a report but no ``attempt.end`` labelled it.
    cost_fixture.write_report(run_dir, 3, ["pass"])

    phases = derive_cost_from_disk(run_dir)["phases"]
    assert phases["by_phase"]["1"]["build"]["grades"] == {
        "count": 1,
        "last": {"total": 2, "passed": 1, "failed": 1},
    }
    assert "grades" not in phases["by_phase"]["4"]["build"]
    assert phases["by_phase"]["4"]["troubleshooting"]["grades"] == {
        "count": 1,
        "last": {"total": 2, "passed": 2, "failed": 0},
    }
    # Gate counts are never summed across passes, and the unlabelled report is
    # in no count at all: 1 build pass + 1 repair pass.
    assert phases["total"]["grades"] == {
        "count": 2,
        "last": {"total": 2, "passed": 2, "failed": 0},
    }


def test_grades_alone_still_open_the_phase_they_belong_to(tmp_path: Path) -> None:
    """A labelled grade opens its phase even with no session DB and no anchors.

    The reports are published before the loop can die, so they are the only
    grade source that survives every exit — and a phase whose ``attempt.end``
    named it was graded, so its bucket opens on that grade alone. Nothing is
    invented to fill the rest: no token sums, no turns, and no wall, because no
    ``phase.start`` was ever recorded to measure a span from.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    base_ms = 1_794_000_000_000
    cost_fixture.write_live(
        run_dir,
        [
            cost_fixture.attempt_end(1, 1, BACKEND_PHASE, "build", base_ms),
            cost_fixture.attempt_end(
                2, 1, BACKEND_PHASE, "troubleshooting", base_ms + 40_000
            ),
            cost_fixture.attempt_end(3, 4, LAYER_PHASE, "build", base_ms + 140_000, 1),
        ],
    )
    cost_fixture.write_report(run_dir, 1, ["pass", "fail", "not_run"])
    cost_fixture.write_report(run_dir, 2, ["pass"])
    cost_fixture.write_report(run_dir, 3, ["pass", "pass", "pass"])

    phases = derive_cost_from_disk(run_dir)["phases"]
    assert set(phases["by_phase"]) == {"1", "4"}
    backend = phases["by_phase"]["1"]
    assert backend["name"] == BACKEND_PHASE
    assert set(backend["build"]) == {"grades"}
    assert set(backend["troubleshooting"]) == {"grades"}
    assert set(phases["by_phase"]["4"]["build"]) == {"grades"}
    # No wall was observed anywhere, so no roll-up may carry one.
    assert phases["build"] == {
        "grades": {"count": 2, "last": {"total": 3, "passed": 3, "failed": 0}}
    }
    assert phases["total"] == {
        "grades": {"count": 3, "last": {"total": 1, "passed": 1, "failed": 0}}
    }


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
    assert record["paused_seconds"] is None


def test_a_db_only_cell_invents_no_phases_without_labels(tmp_path: Path) -> None:
    """A session DB alone names no phase, so NO phase is derived — not a guess.

    Token sums are worthless without knowing which phase spent them, and the
    only thing that says so is the live stream's labels. A cell whose DB survived
    but whose stream did not therefore reports no phases at all: no wall, no
    grades, no tokens. A zeroed build would claim the phase ran and cost nothing
    — a measurement that sums cleanly and understates the run.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    cost_fixture.write_session_db(run_dir, cost_fixture.PARTITION_MESSAGES[:2])

    assert derive_cost_from_disk(run_dir) == {"phases": {}, "paused_seconds": None}
    record = runner_mod._cost_record(
        outcome="crashed", run_dir=run_dir, void={"is_void": True, "reason": "crashed"}
    )
    assert record["phases"] == {}
    assert record["paused_seconds"] is None


def test_a_live_only_cell_records_wall_and_nothing_else(tmp_path: Path) -> None:
    """A labelled span alone gives the whole net wall; nothing else is claimed.

    Wall is enough to make a phase — a cell that ran consumed real time — and
    with no message and no grade in its repair interval that interval never
    opened as a PHASE, so its 60s folds into the build's wall rather than being
    dropped. No tokens, no turns, no grades: none of them were observed.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    cost_fixture.write_live(
        run_dir,
        [
            {"v": 1, "ts": cost_fixture.PARTITION_START_MS, "kind": "cell.start"},
            cost_fixture.phase_start(
                cost_fixture.PARTITION_PHASE_INDEX,
                cost_fixture.PARTITION_PHASE_NAME,
                "build",
                cost_fixture.PARTITION_START_MS,
                cost_fixture.PARTITION_PHASE_LAYER,
            ),
            cost_fixture.attempt_end(
                1,
                cost_fixture.PARTITION_PHASE_INDEX,
                cost_fixture.PARTITION_PHASE_NAME,
                "build",
                cost_fixture.PARTITION_BOUNDARY_MS,
                cost_fixture.PARTITION_PHASE_LAYER,
            ),
            {"v": 1, "ts": cost_fixture.PARTITION_END_MS, "kind": "cell.end"},
        ],
    )

    derived = derive_cost_from_disk(run_dir)
    phases = derived["phases"]
    assert set(phases) == {"by_phase", "build", "total"}
    assert set(phases["by_phase"]) == {str(cost_fixture.PARTITION_PHASE_INDEX)}
    phase = phases["by_phase"][str(cost_fixture.PARTITION_PHASE_INDEX)]
    assert set(phase) == {"name", "layer", "build"}
    assert set(phase["build"]) == {"wall_seconds"}
    assert phase["build"]["wall_seconds"] == pytest.approx(160.0)
    assert set(phases["build"]) == {"wall_seconds"}
    assert phases["build"]["wall_seconds"] == pytest.approx(160.0)
    assert set(phases["total"]) == {"wall_seconds"}
    assert phases["total"]["wall_seconds"] == pytest.approx(160.0)
    assert "troubleshooting" not in phases


def test_the_derivation_never_emits_cost_usd(tmp_path: Path) -> None:
    """The disk path has no pricing: the KEY is absent everywhere, not ``0.0``.

    A local cell has no dollars at all, and a zero would be indistinguishable
    from a genuinely free remote call in any aggregate. That has to hold for every
    bucket — each phase's build and repair, and each roll-up — because a dollar
    total is only ever read off the roll-up.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    cost_fixture.write_partitioned(run_dir)

    phases = runner_mod._cost_record(
        outcome="passed",
        run_dir=run_dir,
        void={"is_void": False, "reason": None},
    )["phases"]
    assert set(phases) == {"by_phase", "build", "troubleshooting", "total"}
    for index, entry in phases["by_phase"].items():
        for kind in ("build", "troubleshooting"):
            assert kind in entry, f"phase {index} opened no {kind} bucket"
            assert "cost_usd" not in entry[kind], (
                f"phase {index} {kind} carries cost_usd"
            )
    for name in ("build", "troubleshooting", "total"):
        assert "cost_usd" not in phases[name], f"{name} carries cost_usd"


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
