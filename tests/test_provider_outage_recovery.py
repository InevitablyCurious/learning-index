"""A provider outage must not be scored as the model failing.

Live cell 2026-08-24: the run lost 8 turns to stream deaths, two of them the
provider itself answering "The upstream provider is temporarily unavailable."
Only 2 of the 8 were retried, because the recoverable set covered loop kills
and finalize timeouts and nothing else — so six turns of work were simply gone,
and the cell was scored as though the model had produced nothing in them.

A provider being down is not agentic behaviour at all. Recovering from it is
the same argument that put guard kills and finalize timeouts in the
recoverable set, only stronger.
"""

from __future__ import annotations

import json

import pytest

from harness.serve_client import (
    REASON_PROVIDER_UNAVAILABLE,
    REASON_STREAM_FINALIZE_TIMEOUT,
    REASON_STREAM_INCOMPLETE,
    TERMINAL_TRANSPORT_ERROR,
    classify_transport_anomaly,
)

# Byte-for-byte the assistant-message error orcarouter produced in the live run
# (message table, session ses_fcb27f348ffe9Cs9q003iqZ25D).
LIVE_ERROR = json.dumps(
    {
        "name": "UnknownError",
        "data": {
            "message": '"The upstream provider is temporarily unavailable. Please try again later."'
        },
    }
)


class TestClassification:
    def test_the_real_live_payload_is_recognised(self):
        terminal, reason = classify_transport_anomaly(
            {"error_texts": [LIVE_ERROR], "truncations": 1}
        )
        assert (terminal, reason) == (
            TERMINAL_TRANSPORT_ERROR,
            REASON_PROVIDER_UNAVAILABLE,
        )

    def test_an_outage_beats_the_derived_truncation_reading(self):
        # An outage usually ALSO leaves a truncation part behind. Reporting
        # "the stream stopped" would hide why it stopped, and "stream
        # incomplete" is not recoverable while an outage is.
        terminal, reason = classify_transport_anomaly(
            {"error_texts": [LIVE_ERROR], "truncations": 5, "error_parts": 2}
        )
        assert reason == REASON_PROVIDER_UNAVAILABLE

    def test_more_specific_terminals_still_win(self):
        # A loop kill and the finalize watchdog are named terminals — they say
        # what ENDED the turn and must keep precedence.
        for text, expected in (
            ("relay_loop_detected", "loop_guard"),
            ("stream did not finalize", REASON_STREAM_FINALIZE_TIMEOUT),
        ):
            _, reason = classify_transport_anomaly(
                {"error_texts": [text, LIVE_ERROR], "truncations": 1}
            )
            assert reason == expected

    def test_a_plain_truncation_is_unchanged(self):
        terminal, reason = classify_transport_anomaly(
            {"error_texts": [], "truncations": 1}
        )
        assert reason == REASON_STREAM_INCOMPLETE

    def test_a_clean_window_is_still_clean(self):
        assert classify_transport_anomaly({"error_texts": [], "truncations": 0}) == (
            None,
            None,
        )

    def test_model_output_cannot_trip_it(self):
        # Signatures are matched only against error_texts — text the TRANSCRIPT
        # recorded as an error. A model writing the words in its own answer
        # must never be read as an outage.
        assert classify_transport_anomaly(
            {
                "error_texts": [],
                "truncations": 0,
                "assistant_text": "the service is temporarily unavailable",
            }
        ) == (None, None)


class TestBackoff:
    def test_escalates_then_holds(self):
        from harness.adapters.backgammon import _provider_backoff_seconds

        seq = [_provider_backoff_seconds(i) for i in range(1, 7)]
        assert seq == [15.0, 30.0, 60.0, 120.0, 120.0, 120.0]

    def test_never_returns_zero_or_negative(self):
        from harness.adapters.backgammon import _provider_backoff_seconds

        for i in (-5, 0, 1, 99):
            assert _provider_backoff_seconds(i) > 0

    def test_holding_at_a_cap_rides_out_long_outages_within_budget(self):
        # The schedule must PLATEAU rather than grow without limit: an outage
        # longer than the schedule is ridden out at the cap (within the
        # terminating _MAX_SERVE_RECOVERY_NUDGES budget), not given up on.
        from harness.adapters.backgammon import (
            PROVIDER_BACKOFF_SCHEDULE_S,
            _provider_backoff_seconds,
        )

        assert _provider_backoff_seconds(1000) == PROVIDER_BACKOFF_SCHEDULE_S[-1]


class TestTheNudgeReadsAsAPerson:
    def _nudge(self) -> str:
        from harness.adapters.backgammon import _PROVIDER_RECOVERY_NUDGE

        return _PROVIDER_RECOVERY_NUDGE

    @pytest.mark.parametrize(
        "tell",
        [
            "provider",
            "upstream",
            "transport notice",
            "the model",
            "harness",
            "retry",
            "error",
            "503",
            "api",
            "benchmark",
            "outage",
        ],
    )
    def test_says_nothing_about_the_machinery(self, tell: str) -> None:
        assert tell not in self._nudge().lower(), (
            f"the recovery nudge leaks {tell!r}; from the model's side a message "
            "simply did not go through"
        )

    def test_absolves_the_model(self) -> None:
        # A model told only "that failed, try again" may conclude its own work
        # was wrong and start rewriting good code.
        assert "nothing to do with what you were doing" in self._nudge().lower()

    def test_tells_it_not_to_redo_finished_work(self) -> None:
        assert "no need to redo" in self._nudge().lower()


class TestRecoveryIsWired:
    def test_an_outage_is_in_the_recoverable_set(self):
        from pathlib import Path

        src = (
            Path(__file__).resolve().parents[1] / "harness" / "adapters" / "backgammon.py"
        ).read_text(encoding="utf-8")
        assert "or is_provider_outage" in src
        assert "prompt_to_send = _PROVIDER_RECOVERY_NUDGE" in src
        assert "self._provider_backoff(backoff_s)" in src

    def test_backoff_is_injectable_so_tests_never_sleep(self):
        from harness.adapters.backgammon import BackgammonRunner

        assert hasattr(BackgammonRunner, "_provider_backoff")
