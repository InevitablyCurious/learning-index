"""LAYERED GRADING: which pass a check belongs to (grader/layers.json).

A layer is a pass over the challenge: 1 is the board/controls surface, 2 is the
pieces and the tags they are found by, 3 is gameplay/backend. A check is graded
by the pass that owns its surface, and a check may only defer (`[needs: …]`) to
a check from the SAME OR AN EARLIER layer: a later layer has not been graded yet
when the earlier pass runs, so deferring to it would hide a real fault.

The map is data (grader/layers.json, beside checks.json); the resolver and its
rules are harness/adapters/challenge/stages.py. These tests pin both sides:
the map reads, every kind of key resolves, the layer reaches the grader as
argv (never env), and no needs marker points an earlier layer at a later one.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from harness.adapters.challenge.constants import _GRADER_DIR
from harness.adapters.challenge.stages import (
    LayerMap,
    UnstagedCheckError,
    load_layers,
    load_stages,
)
from harness.grader_run import gate_argv

LAYERS = load_layers(_GRADER_DIR / "layers.json")
STAGES = load_stages(_GRADER_DIR / "checks.json")


def test_load_layers_reads_the_map() -> None:
    # The map is the layer feature itself: a silently shrunk one would layer
    # everything by stage default and never fail.
    assert isinstance(LAYERS, LayerMap)
    assert len(LAYERS.checks) == 159
    assert len(LAYERS.stages) == 19
    assert LAYERS.stages[1] == 1  # first look, the board surface
    assert LAYERS.stages[6] == 1  # first look's last stage, the pieces
    assert LAYERS.stages[19] == 3  # finished: gameplay, the last pass


def test_layer_of_resolves_exact_template_and_stage() -> None:
    # A check is named three ways and every one of them must resolve: an exact
    # key, a `{x}` setup template, and the stage default for a check the map
    # names no key for.
    assert LAYERS.layer_of("REQ-RENDER/checker", STAGES) == 2
    assert LAYERS.layer_of("[F01] board appears", STAGES) == 1
    assert LAYERS.layer_of("G05", STAGES) == 3
    # REQ-STATE/state.points is not named one by one: it is an instance of the
    # REQ-STATE/state.{x} template.
    assert LAYERS.layer_of("REQ-STATE/state.points", STAGES) == 3
    # F87/F29 are written as {"layer": int, "reason": str} — the reason records
    # WHY a stage-1 gate sits in a later layer, so both forms must read.
    assert LAYERS.layer_of("F87", STAGES) == 2
    assert LAYERS.layer_of("F29", STAGES) == 1
    # Named by neither key nor template: resolves through its stage (1).
    assert LAYERS.layer_of("REQ-RESPONSIVE/startup", STAGES) == 1
    with pytest.raises(UnstagedCheckError):
        LAYERS.layer_of("[Z99] nope", STAGES)


def test_stages_carry_layer() -> None:
    assert len(STAGES) == 19
    assert STAGES[0].name == "First look: the game opens" and STAGES[0].layer == 1
    assert STAGES[-1].number == 19 and STAGES[-1].layer == 3


def _contains_pair(argv: list[str], left: str, right: str) -> bool:
    for idx, item in enumerate(argv[:-1]):
        if item == left and argv[idx + 1] == right:
            return True
    return False


def test_gate_argv_threads_layer_as_argv(tmp_path: Path) -> None:
    # The pass being graded is the RUN's scope, so it is an argument of the
    # grading run itself. Never an env var: the container must not inherit a
    # layer from its environment.
    layered = gate_argv(
        worktree=tmp_path,
        report_path=tmp_path / "report.json",
        roster_path=None,
        attempt=1,
        layer=2,
    )
    assert _contains_pair(layered, "--layer", "2")
    assert not any(
        item == "-e" and "LAYER" in layered[index + 1]
        for index, item in enumerate(layered[:-1])
    ), "the layer must never be threaded as -e …LAYER…: it is the run's scope, not env"
    # The default path is unchanged: no layer, no flag.
    unlayered = gate_argv(
        worktree=tmp_path,
        report_path=tmp_path / "report.json",
        roster_path=None,
        attempt=1,
    )
    assert "--layer" not in unlayered


# ── No needs marker points an earlier layer at a later one ───────────────────

_TITLE = re.compile(r"test\(\s*['\"`]\[([A-Z]+[0-9]*)\]")
_NEEDS = re.compile(r"\[needs: ([^\]]+)\]")
_FUNCTION = re.compile(r"^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)")
_FRONTEND = _GRADER_DIR / "frontend"
_CONFORMANCE = _GRADER_DIR / "conformance"
# A marker in a shared helper sits in no test. Its owner is the helper, and the
# helper is reached from the gates that call it: it may not defer to a later
# layer than the EARLIEST of them, or the earliest pass would be told nothing. A
# helper no test calls directly is reached through the fixtures' `page` setup,
# which every frontend gate goes through — layer 1.
_SCANNED = (
    sorted(_FRONTEND.glob("*.spec.ts"))
    + [_FRONTEND / "fixtures.ts"]
    + sorted(_CONFORMANCE.glob("*.spec.ts"))
)


def _layer_of(token: str) -> int:
    return LAYERS.layer_of(
        token if token.startswith("REQ-") else f"[{token}] x", STAGES
    )


def _title_above(lines: list[str], start: int) -> str | None:
    for index in range(start, -1, -1):
        if match := _TITLE.search(lines[index]):
            return match.group(1)
    return None


def _caller_titles(helper: str) -> set[str]:
    found: set[str] = set()
    for path in _FRONTEND.glob("*.spec.ts"):
        lines = path.read_text(encoding="utf-8").splitlines()
        for lineno, line in enumerate(lines):
            if re.search(rf"\b{re.escape(helper)}\(", line) and (
                title := _title_above(lines, lineno)
            ):
                found.add(title)
    return found


def _owner(lines: list[str], marker_line: int) -> tuple[str, int]:
    """(owner, its layer) for the marker on `marker_line`."""
    if title := _title_above(lines, marker_line):
        return title, _layer_of(title)
    for index in range(marker_line, -1, -1):
        match = _FUNCTION.match(lines[index])
        if match is None:
            continue
        helper = match.group(1)
        callers = _caller_titles(helper)
        # min(): the violation is an edge ANY caller can reach too early.
        return helper, min((_layer_of(c) for c in callers), default=1)
    return "(top level)", 1


def _violating_edges() -> tuple[set[tuple[str, str]], int]:
    """(edges from an earlier layer to a later one, edges scanned)."""
    violations: set[tuple[str, str]] = set()
    scanned = 0
    for path in _SCANNED:
        lines = path.read_text(encoding="utf-8").splitlines()
        for lineno, line in enumerate(lines):
            for marker in _NEEDS.finditer(line):
                owner, owner_layer = _owner(lines, lineno)
                for needed in marker.group(1).split():
                    scanned += 1
                    if owner_layer < _layer_of(needed):
                        violations.add((owner, needed))
    return violations, scanned


def test_needs_edges_never_point_earlier_layer_to_later() -> None:
    # A layer-1 check that waits on a layer-2 check is told to nobody in the
    # layer-1 pass: the check it waits on has not been graded yet, and the
    # deferral silently swallows a fault the player can see.
    #
    # The invariant is zero earlier→later edges, and it only ever gets stricter:
    # a new edge fails here, and nothing may be added to this set to excuse one.
    # Chunk B removed the last four — F29 and F32 (board-geometry.spec.ts) and
    # the shared gameReady settle gate (fixtures.ts), which used to defer to
    # REQ-RENDER/checker and REQ-TESTID/checker while sizing the bar, the off
    # tray and the board-settle gate against a piece. Those bands are now read
    # in pointWidth, so the deferrals are same-layer and this set is empty.
    violations, scanned = _violating_edges()
    assert scanned > 400, (
        f"only {scanned} needs edges read — the scan is not reading the suite"
    )
    assert violations == set(), (
        f"needs markers point an earlier layer at a later one: {sorted(violations)}"
    )
