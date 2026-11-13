"""DECISION 3: AFTER A COMPACTION, THE SPEC GOES BACK IN.

THE RULE (harness/adapters/challenge/runner.py, ``_run_cell_impl``). A build
step sends the phase header plus the spec so far — phases 1..K, never a later
one (``pack.build_step_message``) — because a phase is only honest if the model
holds everything it has been asked to build up to it. The window between the
build and the grades is long enough for the model's own context to compact, and
a compaction rewrites the transcript the spec was handed in — so the spec can
silently stop being in context while the model keeps being graded against it.

So the re-hand is EDGE-TRIGGERED on the observed compaction: a feedback drive
that reports ``compactions_observed >= 1`` arms ``spec_rehand_pending``, and the
NEXT feedback composition prepends ``pack.build_step_message(phase.index)`` —
the SAME composer the build used, so the plan has one string and never a second
paraphrase. The flag is consumed by that one message, so the round after does
not repeat it, and one observable compaction is enough: a second re-hand per
compaction, not per stretch.

WHY IT IS A RULE AND NOT AN IMPLEMENTATION DETAIL. Without the re-hand, a
model that compacted is graded on a spec it can no longer read; with a re-hand
on every round the message becomes a wall of spec and the complaint — the only
news in it — is buried. The told problems must still be in the re-handed
message: the spec says what to build, the complaint says what is still broken,
and the model needs both at once.

WHAT THESE TESTS STATE, one rule each:

  (a) every build message carries the phase header and the labels of phases
      1..K and no later one, so the build-side hand-over is the plan so far;
  (b) one observed compaction during troubleshooting re-hands the spec on
      exactly the next feedback message, and the message after does not repeat;
  (c) the re-handed message still carries the layer-1 told problem — the spec
      is added to the complaint, never sent instead of it;
  (d) two compactions in one stretch produce two re-hands, not one;
  (e) the harness's OWN build compaction (``self.compact``) arms the re-hand,
      so the FIRST feedback of the stretch carries the spec and the second
      does not — the build compacts after the model stops building, which is
      exactly where no drive can report it.

No model runs: the serve drive, the gate oracle and Docker are the shared fakes
from tests/_serve_drive_fakes.py, tests/test_layered_sequence.py and
tests/test_challenge_budget_stop.py. The prompt pack is the CHALLENGE'S OWN —
nothing here scripts the plan.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from harness.adapters.challenge import ChallengeRunner, _OpencodeRunStats
from harness.prompt_pack import PromptPack
from tests._serve_drive_fakes import TASK_DIR
from tests.test_challenge_budget_stop import _stats
from tests.test_layered_sequence import (
    _L1_PROBLEM,
    _PASS,
    L1_CHECK,
    _cell_runner,
)

# The real plan: 7 phases, phase 4 is layer 1 ("Layer 1 — board and controls").
L1_PHASE = 4


def _pack() -> PromptPack:
    """The challenge's own pack — the build's composer, read from disk."""
    return PromptPack(TASK_DIR / "prompts")


def _phase_names(pack: PromptPack) -> dict[int, str]:
    return {phase.index: phase.name for phase in pack.phases()}


def _all_phase_labels(pack: PromptPack) -> list[str]:
    """Every ``## Phase K: name`` label, in order (index K-1 is phase K's)."""
    return [f"## Phase {p.index}: {p.name}" for p in pack.phases()]


def _drive_layer_one(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    observed: list[int],
    fail_grades: int,
    compact: bool = False,
) -> tuple[Any, list[tuple[str, str]]]:
    """Drive the REAL plan until layer 1 goes green; return the feedback messages.

    ``fail_grades`` is how many grades FAIL before one passes, so there are
    exactly that many feedback rounds. ``observed`` scripts, one entry per
    feedback drive, how many live compactions that round's drive reports —
    the only channel through which the model's compaction reaches the runner.

    ``compact`` is the runner's build-compaction switch. True means the
    harness's own chunked build summarized after every chunk (serve.py, ``if
    self.compact``), which is the SECOND arming source of the spec re-hand and
    the one no drive reports. Default False keeps every existing test's
    behaviour: no build compaction, so the flag opens disarmed.

    Each returned entry is ``(phase, prompt)``: the phase label the drive was
    called with (``feedback-1``, ...) and the message the runner composed for
    it, which IS what the model receives over the one transport.
    """
    runner = _cell_runner(tmp_path, monkeypatch)
    runner.compact = compact

    feedback: list[tuple[str, str]] = []

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        phase = str(kwargs.get("phase") or "")
        if phase.startswith("initial-chunk-"):
            return _stats(session_id="sess-1", exit_code=0, cost_usd=0.0)
        compactions = observed[len(feedback)] if len(feedback) < len(observed) else 0
        feedback.append((phase, str(kwargs.get("prompt") or "")))
        return _stats(
            session_id="sess-1",
            exit_code=0,
            cost_usd=0.0,
            compactions_observed=compactions,
        )

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)

    grades: list[int | None] = []

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        grades.append(kwargs.get("layer"))
        if len(grades) <= fail_grades:
            return {
                "verdict": "FAIL",
                "conformed": True,
                "problems": [dict(_L1_PROBLEM)],
                "failed_gates": [L1_CHECK],
            }
        return dict(_PASS)

    monkeypatch.setattr(runner, "_run_gate_report", _fake_gate)

    result = runner._run_cell_impl(
        run_label="spec-rehand",
        run_dir=tmp_path / "spec-rehand",
        task_id="backgammon",
    )
    return result, feedback


def test_every_build_message_carries_the_header_and_the_spec_so_far(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """(a) Build step K = header(K) + the labels of phases 1..K, never a later one.

    This is what makes the re-hand a one-line rule rather than a second
    composer: the build and the re-hand both go through
    ``pack.build_step_message``, so whatever the build's message carries, every
    re-hand carries too.
    """
    pack = _pack()
    names = _phase_names(pack)
    labels = _all_phase_labels(pack)
    assert sorted(names) == list(range(1, 8)), "the real plan is 7 phases"

    runner = _cell_runner(tmp_path, monkeypatch)

    builds: dict[str, str] = {}

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        phase = str(kwargs.get("phase") or "")
        if phase.startswith("initial-chunk-"):
            builds[phase] = str(kwargs.get("prompt") or "")
        return _stats(session_id="sess-1", exit_code=0, cost_usd=0.0)

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        return dict(_PASS)

    monkeypatch.setattr(runner, "_run_gate_report", _fake_gate)

    result = runner._run_cell_impl(
        run_label="build-carries-spec",
        run_dir=tmp_path / "build-carries-spec",
        task_id="backgammon",
    )

    assert result.verdict == "PASS"
    assert list(builds) == [f"initial-chunk-{k}" for k in range(1, 8)]

    for k in range(1, 8):
        message = builds[f"initial-chunk-{k}"]
        # The build sends EXACTLY the composer's message — no extra preamble,
        # so the re-hand (which prepends the same string) cannot drift from it.
        assert message == pack.build_step_message(k)
        header = pack.build_step_message(k).split("\n\n", 1)[0]
        assert f"phase {k}: {names[k]}" in header
        for index, label in enumerate(labels, start=1):
            if index <= k:
                assert label in message, f"build step {k} must carry {label}"
            else:
                assert label not in message, f"build step {k} shows {label}"


def test_one_compaction_rehands_the_spec_on_the_very_next_message_only(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """(b) Observed once -> the next feedback message carries the spec, then no more.

    Layer 1 fails three grades, so three feedback rounds run. Only the FIRST
    round's drive observed a compaction, so only the SECOND message is the
    re-hand: it is armed by the drive that just returned and consumed by the
    composition right after it. The first message cannot carry it (nothing has
    been observed yet — the edge, not a steady state), and the third does not
    repeat it (the flag was cleared).
    """
    pack = _pack()
    spec = pack.build_step_message(L1_PHASE)
    labels = _all_phase_labels(pack)

    result, feedback = _drive_layer_one(
        monkeypatch, tmp_path, observed=[1, 0, 0], fail_grades=3
    )

    assert [phase for phase, _ in feedback] == [
        "feedback-1",
        "feedback-2",
        "feedback-3",
    ]
    assert result.verdict == "PASS"

    first, second, third = (prompt for _, prompt in feedback)
    # EDGE-TRIGGER, NOT A STEADY STATE: round one has nothing armed yet.
    assert not first.startswith(spec)
    # THE RE-HAND: the very next message, and the plan so far with it.
    assert second.startswith(spec)
    assert second.count(spec) == 1, "one re-hand per message, never a duplicate"
    for label in labels[:L1_PHASE]:
        assert label in second
    for label in labels[L1_PHASE:]:
        assert label not in second, f"the re-hand shows a later phase: {label}"
    # CONSUMED: the message after it is a plain complaint again.
    assert not third.startswith(spec)


def test_the_rehanded_message_still_carries_the_told_problem(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """(c) The spec is ADDED to the complaint, never sent instead of it.

    The re-hand exists so the model can act on the complaint with the plan in
    context — a message that re-handed the spec and dropped the told problem
    would be worse than no re-hand at all. The told line is the one the runner
    records for this gate (``_told_label``), so this asserts the model's own
    message, not a paraphrase the test composed.
    """
    pack = _pack()
    spec = pack.build_step_message(L1_PHASE)
    # ROUND TWO IS A REPEAT: the same person's second sighting of the same
    # fault, said in its own REPEAT line. A part told as its general line the
    # first round is told by its specific lines after that (Jerry, 2026-11-13),
    # so the repeat is the gate's own line, not the general list again.
    told = ChallengeRunner._told_label(dict(_L1_PROBLEM), pass_kind="repeat")[0]
    assert told, "the layer-1 gate resolves to a told line"

    _, feedback = _drive_layer_one(
        monkeypatch, tmp_path, observed=[1, 0, 0], fail_grades=3
    )
    rehand = feedback[1][1]

    assert rehand.startswith(spec)
    assert told in rehand, "the told problem survives the re-hand"
    # The complaint comes AFTER the spec it is about.
    assert rehand.index(told) > rehand.index(spec)


def test_two_compactions_in_one_stretch_produce_two_rehands(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """(d) Two observed compactions -> two re-hands, not one.

    The flag is armed by EVERY drive that observed a compaction, so a stretch
    whose context was rewritten twice re-hands twice: each message follows the
    compaction that made it necessary. Disarming after the first would leave
    the second rewrite unanswered.
    """
    pack = _pack()
    spec = pack.build_step_message(L1_PHASE)

    result, feedback = _drive_layer_one(
        monkeypatch, tmp_path, observed=[1, 1, 0], fail_grades=3
    )

    assert [phase for phase, _ in feedback] == [
        "feedback-1",
        "feedback-2",
        "feedback-3",
    ]
    assert result.verdict == "PASS"

    first, second, third = (prompt for _, prompt in feedback)
    assert not first.startswith(spec)
    assert second.startswith(spec), "the first compaction re-hands the spec"
    assert third.startswith(spec), "the second compaction re-hands it again"


def test_the_builds_own_compaction_rehands_the_spec_on_the_first_feedback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """(e) The harness's OWN build compaction arms the re-hand, exactly once.

    NOTHING HERE OBSERVES A LIVE COMPACTION: every feedback drive reports zero,
    so the only compaction in the stretch is the harness's own — the summarize
    ``serve.py`` fires after each build chunk when ``self.compact`` is on. That
    is the seam this test pins: the build compacts after the model is done
    building, so the FIRST message the model reads afterwards is the attempt-1
    feedback, and it must carry the plan the compaction just rewrote away.

    Then the edge: the flag is consumed by that message, so attempt 2's
    complaint arrives WITHOUT the spec — one re-hand per event, never a wall.
    """
    pack = _pack()
    spec = pack.build_step_message(L1_PHASE)
    labels = _all_phase_labels(pack)
    # ATTEMPT ONE IS A FIRST SIGHTING, so the told line is the first-sighting
    # voice (contrast the live-compaction test, whose round two is a repeat).
    told = ChallengeRunner._told_label(
        dict(_L1_PROBLEM), pass_kind="first", among=[dict(_L1_PROBLEM)]
    )[0]
    assert told, "the layer-1 gate resolves to a told line"

    result, feedback = _drive_layer_one(
        monkeypatch, tmp_path, observed=[0, 0], fail_grades=2, compact=True
    )

    assert [phase for phase, _ in feedback] == ["feedback-1", "feedback-2"]
    assert result.verdict == "PASS"

    first, second = (prompt for _, prompt in feedback)
    # THE RE-HAND AFTER THE BUILD'S OWN COMPACTION: the very first message.
    assert first.startswith(spec)
    assert first.count(spec) == 1, "one re-hand per message, never a duplicate"
    # The header names the phase that was just built, and the whole plan rides
    # with it — the spec, not a paraphrase of it.
    header = spec.split("\n\n", 1)[0]
    assert f"phase {L1_PHASE}" in header
    assert "Layer 1" in header
    for label in labels[:L1_PHASE]:
        assert label in first, f"the re-hand must carry {label}"
    for label in labels[L1_PHASE:]:
        assert label not in first, f"the re-hand shows a later phase: {label}"
    # THE COMPLAINT IS STILL THERE, after the spec it is about.
    assert told in first, "the told problem survives the re-hand"
    assert first.index(told) > first.index(spec)
    # CONSUMED: no drive observed a compaction and the build's was answered, so
    # the second message is a plain complaint again.
    assert not second.startswith(spec)
