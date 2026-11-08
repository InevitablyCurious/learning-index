"""The cost RULES, stated where they can be read: labels decide, sums add up.

WHY A SEPARATE FILE FROM ``test_cost_record.py``. That one follows a cell through
the writer's six endings — its subject is the ARTIFACT (every exit lands a
``cost.json``, absent never becomes zero). This one is the DERIVATION's own
logic, which no exit path exercises:

  * A phase's ``build`` is everything up to and including its OWN first
    ``attempt.end`` — the grade that reads what the build drive wrote — and its
    ``troubleshooting`` is what it did after that grade. A backend phase carries
    no ``phase_layer`` and therefore has only a build.
  * ``by_phase`` is the accounting and the roll-ups are ITS arithmetic: additive
    fields add, ``context_peak`` takes the max (peaks do not add), grade counts
    add. Not a second, parallel count that can drift from its parts.
  * The attempt number is a cell-global counter and infers NOTHING. A report
    grades the phase its own ``attempt.end`` labelled, so attempt 1 can be the
    second phase's repair round, and moving numbers between records must not move
    the split.
  * ``cache.read`` / ``cache.write`` are their own kinds of token, counted once
    in ``cache_read_tokens`` / ``cache_write_tokens`` and never folded into
    ``input_tokens``, which stays the prompt the model was actually sent.

Fixtures are built the way the producers build them (``tests/cost_fixture.py``),
whose label helpers emit ``phase_label``'s exact wire shape — ``phase_layer``
omitted for a backend phase, never written as ``None``.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from tests import cost_fixture

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
from run_cumulative.cost_from_disk import derive_cost_from_disk

#: The real plan's phases: a backend one (no grader layer) and the first frontend
#: layer, which is phase 4. The layer is the LABEL's, never inferred from the
#: index — that inference is what this file exists to forbid.
BACKEND_INDEX = 1
BACKEND_PHASE = "Backend 1 — engine"
LAYER_INDEX = 4
LAYER_PHASE = "Layer 1 — board and controls"
LAYER = 1


def _write_backend_and_layered_cell(run_dir: Path) -> None:
    """A backend phase (build only) and a layered phase (build + repair).

    Walls are round — 50s of build each, 50s of repair on the layer — and no two
    figures coincide, so a fold of one field into another cannot look right. The
    repair interval is closed by the cell's end, which is where the stream says
    the last phase's repair rounds are over.
    """
    base_ms = 2_000_000_000_000
    cost_fixture.write_session_db(
        run_dir,
        (
            # Phase 1, build: one turn and one completed compaction.
            {
                "time_created": base_ms + 10_000,
                "mode": "build",
                "tokens": cost_fixture.tokens(
                    input_=100, output=50, reasoning=10, cache_read=20, cache_write=5
                ),
            },
            {
                "time_created": base_ms + 20_000,
                "mode": "compaction",
                "summary": True,
                "tokens": cost_fixture.tokens(
                    input_=200, output=100, reasoning=20, cache_read=40, cache_write=10
                ),
            },
            # Phase 4, build: two turns.
            {
                "time_created": base_ms + 60_000,
                "mode": "build",
                "tokens": cost_fixture.tokens(
                    input_=1_000,
                    output=500,
                    reasoning=100,
                    cache_read=200,
                    cache_write=50,
                ),
            },
            {
                "time_created": base_ms + 70_000,
                "mode": "build",
                "tokens": cost_fixture.tokens(
                    input_=1_100,
                    output=550,
                    reasoning=110,
                    cache_read=220,
                    cache_write=55,
                ),
            },
            # Phase 4, repair: one turn and one completed compaction.
            {
                "time_created": base_ms + 110_000,
                "mode": "build",
                "tokens": cost_fixture.tokens(
                    input_=800, output=400, reasoning=80, cache_read=160, cache_write=40
                ),
            },
            {
                "time_created": base_ms + 120_000,
                "mode": "compaction",
                "summary": True,
                "tokens": cost_fixture.tokens(
                    input_=400, output=200, reasoning=40, cache_read=80, cache_write=20
                ),
            },
        ),
    )
    cost_fixture.write_live(
        run_dir,
        [
            {"v": 1, "ts": base_ms, "kind": "cell.start"},
            cost_fixture.phase_start(BACKEND_INDEX, BACKEND_PHASE, "build", base_ms),
            cost_fixture.attempt_end(
                1, BACKEND_INDEX, BACKEND_PHASE, "build", base_ms + 50_000
            ),
            cost_fixture.phase_start(
                LAYER_INDEX, LAYER_PHASE, "build", base_ms + 50_000, LAYER
            ),
            cost_fixture.attempt_end(
                2, LAYER_INDEX, LAYER_PHASE, "build", base_ms + 100_000, LAYER
            ),
            cost_fixture.attempt_end(
                3,
                LAYER_INDEX,
                LAYER_PHASE,
                "troubleshooting",
                base_ms + 150_000,
                LAYER,
            ),
            {"v": 1, "ts": base_ms + 150_000, "kind": "cell.end"},
        ],
    )
    cost_fixture.write_report(run_dir, 1, ["pass", "pass", "fail"])
    cost_fixture.write_report(run_dir, 2, ["pass", "fail"])
    cost_fixture.write_report(run_dir, 3, ["pass"])


# ── (c) PER-PHASE BUCKETS, AND ROLL-UPS THAT ARE THEIR SUM ──────────────────


def test_every_phase_keeps_its_own_buckets_and_the_rollups_are_their_sum(
    tmp_path: Path,
) -> None:
    """RULE: the phases are the accounting and each roll-up is their arithmetic.

    The backend phase has a build and nothing else; the layered phase has a build
    and a repair, each with its own tokens, turns, wall and grade. Every bucket is
    asserted as an EXACT dict — the whole key set and every number — and each
    roll-up is asserted both as its exact value and as the recombination of the
    per-phase buckets, because a total computed on a parallel path is how a
    roll-up starts disagreeing with its parts.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    _write_backend_and_layered_cell(run_dir)

    derived = derive_cost_from_disk(run_dir)
    assert derived["paused_seconds"] == 0.0
    phases = derived["phases"]
    assert set(phases["by_phase"]) == {str(BACKEND_INDEX), str(LAYER_INDEX)}
    backend = phases["by_phase"][str(BACKEND_INDEX)]
    layered = phases["by_phase"][str(LAYER_INDEX)]

    # Identity is the label's: the layer comes from ``phase_layer``, so a backend
    # phase has none even though its index is also an int.
    assert set(backend) == {"name", "build"}
    assert backend["name"] == BACKEND_PHASE
    assert set(layered) == {"name", "layer", "build", "troubleshooting"}
    assert layered["name"] == LAYER_PHASE
    assert layered["layer"] == LAYER

    # Backend phase: one turn, one compaction, and the one grade that read them.
    assert backend["build"] == {
        "input_tokens": 300,
        "output_tokens": 150,
        "reasoning_tokens": 30,
        "cache_read_tokens": 60,
        "cache_write_tokens": 15,
        "turns": 1,
        "compactions": 1,
        "context_peak": 370,
        "grades": {"count": 1, "last": {"total": 3, "passed": 2, "failed": 1}},
        "wall_seconds": 50.0,
    }

    # Layered phase: two turns and a grade before the boundary...
    assert layered["build"] == {
        "input_tokens": 2_100,
        "output_tokens": 1_050,
        "reasoning_tokens": 210,
        "cache_read_tokens": 420,
        "cache_write_tokens": 105,
        "turns": 2,
        "compactions": 0,
        "context_peak": 2_035,
        "grades": {"count": 1, "last": {"total": 2, "passed": 1, "failed": 1}},
        "wall_seconds": 50.0,
    }
    # ... then a repair turn, a repair compaction and the repair's own grade.
    assert layered["troubleshooting"] == {
        "input_tokens": 1_200,
        "output_tokens": 600,
        "reasoning_tokens": 120,
        "cache_read_tokens": 240,
        "cache_write_tokens": 60,
        "turns": 1,
        "compactions": 1,
        "context_peak": 1_480,
        "grades": {"count": 1, "last": {"total": 1, "passed": 1, "failed": 0}},
        "wall_seconds": 50.0,
    }

    # RULE: the roll-ups ARE the sum over the buckets above — 300+2_100 in, 1+2
    # turns, 1+0 compactions, 50+50 seconds, the peak a MAX not a sum.
    assert phases["build"] == {
        "input_tokens": 2_400,
        "output_tokens": 1_200,
        "reasoning_tokens": 240,
        "cache_read_tokens": 480,
        "cache_write_tokens": 120,
        "turns": 3,
        "compactions": 1,
        "context_peak": 2_035,
        "grades": {"count": 2, "last": {"total": 2, "passed": 1, "failed": 1}},
        "wall_seconds": 100.0,
    }
    assert phases["troubleshooting"] == layered["troubleshooting"]
    assert phases["total"] == {
        "input_tokens": 3_600,
        "output_tokens": 1_800,
        "reasoning_tokens": 360,
        "cache_read_tokens": 720,
        "cache_write_tokens": 180,
        "turns": 4,
        "compactions": 2,
        "context_peak": 2_035,
        "grades": {"count": 3, "last": {"total": 1, "passed": 1, "failed": 0}},
        "wall_seconds": 150.0,
    }

    # ... and the same numbers read back out of ``by_phase``, the way a consumer
    # recombining the phases for itself would get them.
    assert phases["build"] == cost_fixture.recombine_buckets(phases, "build")
    assert phases["troubleshooting"] == cost_fixture.recombine_buckets(
        phases, "troubleshooting"
    )
    assert phases["total"] == cost_fixture.recombine_buckets(
        phases, "build", "troubleshooting"
    )


# ── (d) THE SPLIT FOLLOWS THE LABEL, NEVER THE ATTEMPT NUMBER ───────────────


def _write_cell_with_attempt_numbers(
    run_dir: Path, *, build_attempt: int, repair_attempt: int
) -> None:
    """Two phases whose grades carry the TWO GIVEN attempt numbers.

    Nothing here derives anything from those numbers: the first phase's build was
    graded by the record numbered ``build_attempt`` and the second phase's repair
    round by ``repair_attempt``. Both report files always exist, so swapping the
    numbers swaps which REPORT each phase is graded by — never which phase the
    work belonged to.
    """
    base_ms = 2_001_000_000_000
    cost_fixture.write_session_db(
        run_dir,
        (
            {
                "time_created": base_ms + 20_000,
                "mode": "build",
                "tokens": cost_fixture.tokens(
                    input_=100, output=10, reasoning=1, cache_read=2, cache_write=0
                ),
            },
            {
                "time_created": base_ms + 60_000,
                "mode": "build",
                "tokens": cost_fixture.tokens(
                    input_=200, output=20, reasoning=2, cache_read=4, cache_write=0
                ),
            },
        ),
    )
    cost_fixture.write_live(
        run_dir,
        [
            {"v": 1, "ts": base_ms, "kind": "cell.start"},
            cost_fixture.phase_start(
                BACKEND_INDEX, BACKEND_PHASE, "build", base_ms + 1_000
            ),
            cost_fixture.attempt_end(
                build_attempt,
                BACKEND_INDEX,
                BACKEND_PHASE,
                "build",
                base_ms + 40_000,
            ),
            cost_fixture.phase_start(
                LAYER_INDEX, LAYER_PHASE, "build", base_ms + 40_000, LAYER
            ),
            cost_fixture.attempt_end(
                repair_attempt,
                LAYER_INDEX,
                LAYER_PHASE,
                "troubleshooting",
                base_ms + 90_000,
                LAYER,
            ),
            {"v": 1, "ts": base_ms + 90_000, "kind": "cell.end"},
        ],
    )
    # A decided report for both numbers: 3 gates on 1, 2 gates on 7.
    cost_fixture.write_report(run_dir, 1, ["pass", "pass", "fail"])
    cost_fixture.write_report(run_dir, 7, ["pass", "fail"])


def _split_without_grades(phases: dict[str, Any]) -> dict[tuple[str, str], Any]:
    """Each phase bucket MINUS its grades: the work split, attempt-blind."""
    split: dict[tuple[str, str], Any] = {}
    for index, entry in phases["by_phase"].items():
        for kind in ("build", "troubleshooting"):
            if kind in entry:
                split[(index, kind)] = {
                    field: value
                    for field, value in entry[kind].items()
                    if field != "grades"
                }
    return split


def test_attempt_one_labelled_to_phase_two_grades_phase_two(tmp_path: Path) -> None:
    """RULE: a report grades the phase its own ``attempt.end`` LABELLED.

    The record numbered 1 here is the SECOND phase's repair round — a
    "mislabelled attempt 1", exactly the shape that made the old attempt-1
    boundary bill six of seven build phases as troubleshooting. The split must
    follow the label: phase 4's troubleshooting is graded, phase 4's build is not.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    _write_cell_with_attempt_numbers(run_dir, build_attempt=7, repair_attempt=1)

    phases = derive_cost_from_disk(run_dir)["phases"]
    assert phases["by_phase"][str(LAYER_INDEX)]["troubleshooting"]["grades"] == {
        "count": 1,
        "last": {"total": 3, "passed": 2, "failed": 1},
    }
    assert "grades" not in phases["by_phase"][str(LAYER_INDEX)]["build"]
    # Attempt 7 is the first phase's build grade, simply because it says so.
    assert phases["by_phase"][str(BACKEND_INDEX)]["build"]["grades"] == {
        "count": 1,
        "last": {"total": 2, "passed": 1, "failed": 1},
    }


def test_swapping_attempt_numbers_does_not_move_the_split(tmp_path: Path) -> None:
    """RULE: numbers are a counter, so moving them moves no work.

    Same labels, the two attempt numbers exchanged. The tokens, turns and wall of
    every bucket are IDENTICAL — the split is a property of the labels and the
    timestamps — while the grades follow each number to the phase its own
    ``attempt.end`` names. An inference from the number would move the split here.
    """
    straight_dir = tmp_path / "straight"
    straight_dir.mkdir()
    _write_cell_with_attempt_numbers(straight_dir, build_attempt=7, repair_attempt=1)
    swapped_dir = tmp_path / "swapped"
    swapped_dir.mkdir()
    _write_cell_with_attempt_numbers(swapped_dir, build_attempt=1, repair_attempt=7)

    straight = derive_cost_from_disk(straight_dir)["phases"]
    swapped = derive_cost_from_disk(swapped_dir)["phases"]

    assert _split_without_grades(swapped) == _split_without_grades(straight)
    # The grades DID move with the numbers — that is the only thing they carry.
    assert swapped["by_phase"][str(BACKEND_INDEX)]["build"]["grades"] == {
        "count": 1,
        "last": {"total": 3, "passed": 2, "failed": 1},
    }
    assert swapped["by_phase"][str(LAYER_INDEX)]["troubleshooting"]["grades"] == {
        "count": 1,
        "last": {"total": 2, "passed": 1, "failed": 1},
    }


# ── (e) CACHE IS ITS OWN KIND OF TOKEN ──────────────────────────────────────


def test_cache_tokens_are_counted_as_their_own_kind(tmp_path: Path) -> None:
    """RULE: ``cache.read``/``cache.write`` are counted once, in their own field.

    A message whose prompt was 100 tokens, 20 of them served from cache and 5
    written back, holds 100 prompt tokens — not 125. Folding cache into ``input``
    would inflate the one number a reader compares against the model's context
    window, and would erase the difference between a cheap cached turn and a full
    re-send.
    """
    run_dir = tmp_path / "cell-0000"
    run_dir.mkdir()
    base_ms = 2_002_000_000_000
    cost_fixture.write_session_db(
        run_dir,
        (
            {
                "time_created": base_ms + 10_000,
                "mode": "build",
                "tokens": cost_fixture.tokens(
                    input_=100, output=50, reasoning=10, cache_read=20, cache_write=5
                ),
            },
        ),
    )
    cost_fixture.write_live(
        run_dir,
        [
            {"v": 1, "ts": base_ms, "kind": "cell.start"},
            cost_fixture.phase_start(BACKEND_INDEX, BACKEND_PHASE, "build", base_ms),
            cost_fixture.attempt_end(
                1, BACKEND_INDEX, BACKEND_PHASE, "build", base_ms + 20_000
            ),
            {"v": 1, "ts": base_ms + 20_000, "kind": "cell.end"},
        ],
    )

    build = derive_cost_from_disk(run_dir)["phases"]["by_phase"][str(BACKEND_INDEX)][
        "build"
    ]
    assert build["input_tokens"] == 100, "cache was folded into input_tokens"
    assert build["cache_read_tokens"] == 20
    assert build["cache_write_tokens"] == 5
    # ``context_peak`` is the message's full size (parts INCLUDING cache, which is
    # what the model had to hold); the sums keep the three kinds apart.
    assert build["context_peak"] == 185
