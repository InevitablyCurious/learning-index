"""A stall report names how long the tester waited.

"It locked up and never came back" is true but unfalsifiable from inside the
cell: it does not distinguish an infinite loop from a function slower than
someone's patience. The duration is what makes the report actionable, and it is
what a person would actually say.

The number comes from the grader (only it knows how long it waited) and is
substituted into the hand-written line's ``{seconds}`` placeholder — the same
one-number-one-place contract the nudge files use for ``{write_limit}``. The
sentence stays human-written; nothing here generates prose.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from harness.adapters.challenge import ChallengeRunner as R
from harness.adapters.challenge.stages import load_stages, stage_of

REPO = Path(__file__).resolve().parents[1]
FAILURES = REPO / "task" / "backgammon" / "prompts" / "failures"
CHECKS = REPO / "grader" / "checks.json"

STALL_FILES = sorted(FAILURES.glob("REQ-RESPONSIVE-*.md"))


def test_there_are_stall_lines_to_check() -> None:
    # Six areas, two lines each. A glob that silently matched nothing would
    # make every parametrised test below vacuously pass.
    assert len(STALL_FILES) == 12


@pytest.mark.parametrize("path", STALL_FILES, ids=lambda p: p.stem)
def test_every_stall_line_asks_for_the_wait(path: Path) -> None:
    """A hang line without the duration is the weaker report; none may ship."""
    text = path.read_text(encoding="utf-8")
    assert "{seconds}" in text, f"{path.name} does not say how long the tester waited"


@pytest.mark.parametrize("path", STALL_FILES, ids=lambda p: p.stem)
def test_the_placeholder_carries_its_own_unit(path: Path) -> None:
    """`{seconds}` renders as "63 seconds", so "{seconds} seconds" reads wrong.

    It also has to survive the fallback, which is a phrase rather than a
    number: "a long while seconds" is how that goes wrong.
    """
    text = path.read_text(encoding="utf-8")
    assert not re.search(r"\{seconds\}\s+seconds", text), (
        f"{path.name} doubles the unit — the placeholder already includes it"
    )


def test_the_number_reaches_the_line() -> None:
    line = R._humanize_check(
        "REQ-RESPONSIVE/moving", pass_kind="first", observed="no response after 63s"
    )
    assert "63 seconds" in line
    assert "{seconds}" not in line


def test_an_absent_duration_degrades_to_a_phrase_never_a_zero() -> None:
    """ "It hung for 0 seconds" would be a false report, so it is never said."""
    line = R._humanize_check("REQ-RESPONSIVE/moving", pass_kind="first", observed="")
    assert "{seconds}" not in line
    assert "0 seconds" not in line
    assert "a long while" in line


def test_the_graders_observed_format_is_parseable_here() -> None:
    """Pins the seam: `stallObserved` in the grader writes what this reads.

    The two live in different languages and neither imports the other, so the
    shape is copied here deliberately — if the grader's wording changes, this
    fails rather than the model quietly hearing "a long while" forever.
    """
    for elapsed_s in (1, 63, 206, 900):
        observed = f"no response after {elapsed_s}s"
        line = R._humanize_check(
            "REQ-RESPONSIVE/aiturn", pass_kind="repeat", observed=observed
        )
        assert f"{elapsed_s} seconds" in line


@pytest.mark.parametrize(
    "area,expected_stage",
    [
        ("startup", 1),
        ("moving", 2),
        ("playing", 2),
        ("awkwardroll", 3),
        ("bearingoff", 4),
        ("aiturn", 7),
    ],
)
def test_a_stall_speaks_only_when_its_situation_is_reachable(
    area: str, expected_stage: int
) -> None:
    """You cannot report a bear-off hang if the pieces never loaded.

    Stall findings are staged like every other check, so the repair loop can
    only deliver the ones whose situation the tester could actually have
    reached. This pins the ordering rather than trusting it.
    """
    stages = load_stages(CHECKS)
    assert stage_of(f"REQ-RESPONSIVE/{area}", stages).number == expected_stage
