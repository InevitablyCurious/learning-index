"""The build phases are data: one declaration, one loader, one composed spec.

WHY. The owner's layered build is seven phases whose order, names and grader
layers live in the prompt pack (phase-plan.json), never in Python. Every
build-step message is the approved header plus the WHOLE spec, so a fresh
context always sees all seven phases under their labels.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from harness.prompt_pack import MissingPromptError, PromptPack, default_pack

REPO = Path(__file__).resolve().parents[1]
PACK = default_pack()

HEADER = (
    "This build has 7 phases. You are in phase {K}: {name}. The build spec so "
    "far follows, ending with this phase. Build only what phase {K} asks for — "
    "don't build anything from an earlier or later phase now. Earlier phases "
    "are done and must keep working."
)

EXPECTED = [
    (1, "Backend 1 — engine", None, "chunk-01.md"),
    (2, "Backend 2 — AI", None, "chunk-02.md"),
    (3, "Backend 3 — server", None, "chunk-03.md"),
    (4, "Layer 1 — board and controls", 1, "chunk-04-l1-board.md"),
    (5, "Layer 2 — pieces", 2, "chunk-04-l2-pieces.md"),
    (6, "Layer 3 — gameplay", 3, "chunk-04-l3-gameplay.md"),
    (7, "Wire and verify", 3, "chunk-05.md"),
]

REMOVED_FRAMING = [
    "This is chunk 1 of 7",
    "This is chunk 2 of 7",
    "This is chunk 3 of 7",
    "This is the frontend build",
    "This is the final chunk",
    "chunk 4 of 7",
    "layer 1 of 3",
    "layer 2 of 3",
    "layer 3 of 3",
    "No pieces are drawn yet",
    "No pieces are drawn in this layer",
    "built in layer 1",
    "on top of the board (layer 1)",
]


def test_phase_plan_is_the_seven_declared_phases_in_order() -> None:
    plan = PACK.phases()
    assert [(p.index, p.name, p.layer, p.file) for p in plan] == EXPECTED


def test_every_build_step_message_has_the_header_and_the_spec_so_far() -> None:
    # Never a later phase: with all seven in every message, fresh runs built the
    # whole product during phase 1 (Jerry, 2026-11-13).
    for k in range(1, 8):
        phase = PACK.phase(k)
        message = PACK.build_step_message(k)
        assert message.startswith(HEADER.format(K=k, name=phase.name))
        positions = []
        for p in PACK.phases():
            label = f"## Phase {p.index}: {p.name}"
            if p.index > k:
                assert label not in message, f"phase {k} shows later phase {p.index}"
                assert p.text not in message, (
                    f"phase {k} carries phase {p.index}'s text"
                )
                continue
            assert label in message, f"phase {k} is missing the label for {p.index}"
            assert p.text in message, f"phase {k} is missing the text for {p.index}"
            positions.append(message.index(label))
        assert positions == sorted(positions), "phase labels out of order"


def test_no_removed_framing_appears_anywhere() -> None:
    spec = PACK.whole_spec()
    for fragment in REMOVED_FRAMING:
        assert fragment not in spec, f"removed framing leaked: {fragment!r}"


def test_shared_boilerplate_appears_exactly_once() -> None:
    spec = PACK.whole_spec()
    assert spec.count("REQUIREMENT — the game state MUST survive page reloads.") == 1
    assert spec.count("GOAL: We are building a fully functional backgammon game") == 1
    assert spec.count("~150 lines") == 1


def test_a_missing_declaration_is_loud(tmp_path: Path) -> None:
    (tmp_path / "chunk-01.md").write_text("hello", encoding="utf-8")
    with pytest.raises(MissingPromptError):
        PromptPack(tmp_path).phases()


def test_a_declared_file_missing_from_disk_is_loud(tmp_path: Path) -> None:
    src = REPO / "task" / "backgammon" / "prompts"
    for chunk in src.glob("chunk-*.md"):
        (tmp_path / chunk.name).write_text(
            chunk.read_text(encoding="utf-8"), encoding="utf-8"
        )
    data = json.loads((src / "phase-plan.json").read_text(encoding="utf-8"))
    data["phases"][0]["file"] = "chunk-99.md"
    (tmp_path / "phase-plan.json").write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(MissingPromptError):
        PromptPack(tmp_path).phases()


def test_an_undeclared_chunk_file_on_disk_is_loud(tmp_path: Path) -> None:
    src = REPO / "task" / "backgammon" / "prompts"
    for chunk in src.glob("chunk-*.md"):
        (tmp_path / chunk.name).write_text(
            chunk.read_text(encoding="utf-8"), encoding="utf-8"
        )
    (tmp_path / "chunk-99.md").write_text("extra", encoding="utf-8")
    (tmp_path / "phase-plan.json").write_text(
        (src / "phase-plan.json").read_text(encoding="utf-8"), encoding="utf-8"
    )
    with pytest.raises(MissingPromptError):
        PromptPack(tmp_path).phases()
