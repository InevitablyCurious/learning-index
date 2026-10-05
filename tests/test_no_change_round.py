"""A repair round that changed no code is told so, first.

Runs 1789536879 and 1789564423 each had rounds whose graded code was identical
to the round before, and the model answered with "hard-refresh your browser".
"""

from __future__ import annotations

from harness.adapters.challenge.constants import _LOOP_RECOVERY_NUDGE, _NO_CHANGE_NOTE
from harness.adapters.challenge.runner import _code_unchanged_since_last_round


def test_identical_hashes_mean_the_code_did_not_change() -> None:
    assert _code_unchanged_since_last_round([{"state_hash": "a"}, {"state_hash": "a"}])


def test_a_changed_hash_or_a_first_round_is_not_unchanged() -> None:
    assert not _code_unchanged_since_last_round(
        [{"state_hash": "a"}, {"state_hash": "b"}]
    )
    assert not _code_unchanged_since_last_round([{"state_hash": "a"}])


def test_an_unknown_hash_never_counts_as_unchanged() -> None:
    assert not _code_unchanged_since_last_round(
        [{"state_hash": None}, {"state_hash": None}]
    )
    assert not _code_unchanged_since_last_round([{}, {"state_hash": "a"}])


def test_the_texts_the_model_receives() -> None:
    assert (
        _NO_CHANGE_NOTE.strip() == "You didn't change any code since my last message."
    )
    assert _LOOP_RECOVERY_NUDGE.strip() == (
        "You started going in circles there and repeating yourself, so I stopped it. "
        # Not "continue where you left off": after a real loop that is an
        # instruction to resume it — run 1790202713 answered 21 nudges by
        # re-reading the same board, with no edit and no tool call.
        "Try another way."
    )
