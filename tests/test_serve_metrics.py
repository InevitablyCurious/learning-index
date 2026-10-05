"""Hermetic unit tests for harness.serve_client metrics and classification.

No live server, no docker, no model. Covers build_prompt_body,
parse_busy_status, classify_step_finish_reason, extract_transcript_metrics,
classify_transport_anomaly, founder_attach_command, the ServeClient.metrics()
window and the _http_json/_http_status error-wrap seam. Never hits the
network.
"""

import urllib.error

import pytest

from harness.serve_client import (
    ServeClient,
    ServeClientError,
    build_prompt_body,
    classify_step_finish_reason,
    classify_transport_anomaly,
    extract_transcript_metrics,
    founder_attach_command,
    parse_busy_status,
)


# ---------------------------------------------------------------------------
# build_prompt_body
# ---------------------------------------------------------------------------
def test_build_prompt_body_shape():
    body = build_prompt_body("hello world")
    assert body == {"parts": [{"type": "text", "text": "hello world"}]}


# ---------------------------------------------------------------------------
# parse_busy_status
# ---------------------------------------------------------------------------
def test_parse_busy_status_busy():
    assert parse_busy_status({"ses_1": {"type": "busy"}}, "ses_1") is True


def test_parse_busy_status_idle():
    assert parse_busy_status({"ses_1": {"type": "idle"}}, "ses_1") is False


def test_parse_busy_status_absent_session():
    assert parse_busy_status({"ses_2": {"type": "busy"}}, "ses_1") is False


def test_parse_busy_status_empty_dict():
    assert parse_busy_status({}, "ses_1") is False


# ---------------------------------------------------------------------------
# classify_step_finish_reason
# ---------------------------------------------------------------------------
def test_classify_step_finish_reason_stop():
    assert classify_step_finish_reason("stop") == "stop"


def test_classify_step_finish_reason_length():
    assert classify_step_finish_reason("length") == "length"


def test_classify_step_finish_reason_truncation_values():
    assert classify_step_finish_reason("unknown") == "unknown"
    assert classify_step_finish_reason("stream-incomplete") == "stream-incomplete"


def test_classify_step_finish_reason_default():
    assert classify_step_finish_reason(None) == "unknown"
    assert classify_step_finish_reason("unrecognized") == "unknown"


def test_classify_step_finish_reason_tool_calls():
    # opencode's normal tool-call turn close is NOT a truncation signal.
    assert classify_step_finish_reason("tool-calls") == "tool-calls"
    assert classify_step_finish_reason("tool_calls") == "tool-calls"


# ---------------------------------------------------------------------------
# extract_transcript_metrics
# ---------------------------------------------------------------------------
def _realistic_transcript():
    return [
        {
            "info": {
                "role": "user",
                "tokens": {"input": 10, "output": 0, "total": 10},
                "finish": "stop",
                "cost": 0.0,
                "time": {"created": 1, "completed": 1},
            },
            "parts": [{"type": "text", "text": "do it"}],
        },
        {
            "info": {
                "role": "assistant",
                "tokens": {
                    "input": 50,
                    "output": 30,
                    "reasoning": 12,
                    "total": 92,
                    "cache": {"read": 1000, "write": 400},
                },
                "finish": "stop",
                "cost": 0.01,
                "time": {"created": 2, "completed": 3},
            },
            "parts": [
                {"type": "step-start", "id": "s1"},
                {"type": "reasoning", "text": "thinking"},
                {"type": "text", "text": "answer"},
                {
                    "type": "step-finish",
                    "id": "s1",
                    "reason": "stop",
                    "tokens": {"input": 50, "output": 30, "total": 80},
                    "cost": 0.01,
                },
            ],
        },
        {
            "info": {
                "role": "assistant",
                "tokens": {"input": 70, "output": 20, "reasoning": 4, "total": 94},
                "finish": "length",
                "cost": 0.005,
                "time": {"created": 4, "completed": 5},
            },
            "parts": [
                {"type": "step-start", "id": "s2"},
                {"type": "step-finish", "id": "s2", "reason": "length"},
            ],
        },
        {
            "info": {
                "role": "assistant",
                "tokens": {"input": 100, "output": 5, "reasoning": 0, "total": 105},
                "finish": "stop",
                "cost": 0.001,
                "time": {"created": 6, "completed": 7},
            },
            "parts": [
                {"type": "step-start", "id": "s3"},
                {"type": "error", "message": "boom"},
                {
                    "type": "step-finish",
                    "id": "s3",
                    "reason": "stream-incomplete",
                },
            ],
        },
    ]


def test_extract_transcript_metrics_realistic():
    m = extract_transcript_metrics(_realistic_transcript())
    # step-finish parts across assistant messages: s1(stop), s2(length), s3(stream-incomplete)
    assert m["turns"] == 3
    # max input across assistants: 50,70,100 -> 100
    assert m["input_tokens"] == 100
    # sum output: 30+20+5
    assert m["output_tokens"] == 55
    # sum reasoning: 12+4+0
    assert m["reasoning_tokens"] == 16
    # CACHE IS SUMMED, NOT MAXED — every turn is billed for its own cache read,
    # so the cumulative bill is the sum. Only the first assistant carries a
    # cache block; the other two have none and contribute 0 rather than raising.
    assert m["cache_read_tokens"] == 1000
    assert m["cache_write_tokens"] == 400
    # sum cost: 0.01+0.005+0.001
    assert abs(m["cost_usd"] - 0.016) < 1e-9
    # s2's length finish is BELOW the cap (output 20 + reasoning 4 << 32000)
    # and s3 is stream-incomplete: both are genuine provider truncations.
    assert m["provider_truncations"] == 2
    assert m["cap_cutoffs"] == 0
    # last step-finish reason seen is stream-incomplete
    assert m["last_finish"] == "stream-incomplete"
    # error parts: one "error" part
    assert m["error_parts"] == 1
    assert m["assistant_messages"] == 3
    assert m["user_messages"] == 1


def test_extract_transcript_metrics_ignores_empty_placeholder():
    # One bare step-finish placeholder (no tokens/text/tool) + one real
    # assistant message carrying a text part -> turns == 1.
    transcript = [
        {
            "info": {"role": "assistant"},
            "parts": [{"type": "step-finish", "reason": "stop"}],
        },
        {
            "info": {"role": "assistant", "tokens": {"output": 0, "reasoning": 0}},
            "parts": [{"type": "text", "text": "real answer"}],
        },
    ]
    m = extract_transcript_metrics(transcript)
    assert m["turns"] == 1
    assert m["assistant_messages"] == 2


def test_extract_transcript_metrics_empty():
    m = extract_transcript_metrics([])
    assert m == {
        "turns": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "reasoning_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "cost_usd": 0.0,
        "provider_truncations": 0,
        "cap_cutoffs": 0,
        "last_finish": None,
        "error_parts": 0,
        "info_errors": 0,
        "guard_aborted_turns": 0,
        "finalize_timeouts": 0,
        "error_texts": [],
        "assistant_messages": 0,
        "user_messages": 0,
    }


def test_extract_transcript_metrics_malformed():
    # Non-list / list of non-dicts / missing keys must not raise.
    assert extract_transcript_metrics(None)["turns"] == 0
    m = extract_transcript_metrics([None, "nope", 42, {"info": None}])
    assert m["assistant_messages"] == 0
    assert m["user_messages"] == 0
    assert m["turns"] == 0


def test_extract_transcript_metrics_missing_keys():
    # Bare step-finish placeholder: no tokens, no text/tool -> NOT a turn, but
    # the missing keys must not raise and must default to safe zeros.
    msg = {"info": {"role": "assistant"}, "parts": [{"type": "step-finish"}]}
    m = extract_transcript_metrics([msg])
    assert m["turns"] == 0
    assert m["input_tokens"] == 0
    assert m["output_tokens"] == 0
    assert m["last_finish"] == "unknown"  # reason None -> classified "unknown"


def test_extract_transcript_metrics_tool_calls_not_truncation():
    # A tool-calls step-finish is a normal turn close, not a truncation.
    transcript = [
        {
            "info": {"role": "assistant", "tokens": {"input": 10, "output": 5}},
            "parts": [
                {"type": "step-start", "id": "s1"},
                {"type": "step-finish", "id": "s1", "reason": "tool-calls"},
            ],
        }
    ]
    m = extract_transcript_metrics(transcript)
    assert m["provider_truncations"] == 0
    assert m["cap_cutoffs"] == 0
    assert m["last_finish"] == "tool-calls"


# ---------------------------------------------------------------------------
# cap-cut-off split: provider_truncations vs cap_cutoffs
# ---------------------------------------------------------------------------
def _finish_transcript(output: int, reasoning: int, reason: str):
    """One assistant message whose step-finish carries ``reason``."""
    return [
        {
            "info": {
                "role": "assistant",
                "tokens": {
                    "input": 200,
                    "output": output,
                    "reasoning": reasoning,
                    "total": 200 + output + reasoning,
                },
                "finish": reason,
            },
            "parts": [
                {"type": "step-start", "id": "s1"},
                {"type": "text", "text": "partial work"},
                {"type": "step-finish", "id": "s1", "reason": reason},
            ],
        }
    ]


def test_length_finish_at_cap_is_cap_cutoff():
    # output+reasoning == 32000 (the built-in cap): opencode cut the turn at
    # its output cap — a cap cut-off, NOT a provider truncation.
    m = extract_transcript_metrics(_finish_transcript(31_990, 10, "length"))
    assert m["provider_truncations"] == 0
    assert m["cap_cutoffs"] == 1
    assert m["last_finish"] == "length"


def test_length_finish_above_cap_is_cap_cutoff():
    m = extract_transcript_metrics(_finish_transcript(32_000, 500, "length"))
    assert m["provider_truncations"] == 0
    assert m["cap_cutoffs"] == 1


def test_length_finish_below_cap_is_provider_truncation():
    # A length finish well BELOW the cap is the provider itself stopping short.
    m = extract_transcript_metrics(_finish_transcript(1_200, 300, "length"))
    assert m["provider_truncations"] == 1
    assert m["cap_cutoffs"] == 0


def test_unknown_and_stream_incomplete_are_provider_truncations():
    m = extract_transcript_metrics(
        _finish_transcript(500, 0, "unknown")
        + _finish_transcript(500, 0, "stream-incomplete")
    )
    assert m["provider_truncations"] == 2
    assert m["cap_cutoffs"] == 0


def test_explicit_output_cap_parameter_moves_the_boundary():
    # The cap is a parameter: the same 1500-token length finish is a cap
    # cut-off when the run's effective cap is 1500.
    m = extract_transcript_metrics(
        _finish_transcript(1_200, 300, "length"), output_cap=1_500
    )
    assert m["provider_truncations"] == 0
    assert m["cap_cutoffs"] == 1


def test_classify_transport_anomaly_cap_cutoff_is_truncated():
    assert classify_transport_anomaly(
        {"provider_truncations": 0, "cap_cutoffs": 1, "error_parts": 0}
    ) == ("truncated", "stream-incomplete")


# ---------------------------------------------------------------------------
# per-message token helpers (cap-cutoff trigger)
# ---------------------------------------------------------------------------
def test_message_token_helpers():
    from harness.serve_transport import (
        last_assistant_message,
        message_generation_tokens,
        message_has_tool_part,
    )

    msg = {
        "info": {
            "role": "assistant",
            "tokens": {
                "input": 50,
                "output": 30,
                "reasoning": 12,
                "total": 92,
                "cache": {"read": 1000, "write": 400},
            },
        },
        "parts": [{"type": "tool", "id": "t1"}],
    }
    assert message_generation_tokens(msg) == (30, 12)
    assert message_has_tool_part(msg) is True
    assert message_has_tool_part({"info": {"role": "assistant"}, "parts": []}) is False

    bare = {"info": {"role": "assistant"}}
    transcript = [{"info": {"role": "user"}}, msg, bare]
    assert last_assistant_message(transcript) is bare
    assert last_assistant_message([]) is None
    # Malformed input must not raise.
    assert message_generation_tokens("nope") == (0, 0)
    assert message_has_tool_part(42) is False


# ---------------------------------------------------------------------------
# classify_transport_anomaly
# ---------------------------------------------------------------------------
def test_classify_transport_anomaly_truncated():
    assert classify_transport_anomaly(
        {"provider_truncations": 1, "error_parts": 0}
    ) == (
        "truncated",
        "stream-incomplete",
    )


def test_classify_transport_anomaly_error():
    assert classify_transport_anomaly(
        {"provider_truncations": 0, "error_parts": 1}
    ) == (
        "transport_error",
        "error_event",
    )


def test_classify_transport_anomaly_clean():
    assert classify_transport_anomaly(
        {"provider_truncations": 0, "error_parts": 0}
    ) == (
        None,
        None,
    )


# ---------------------------------------------------------------------------
# WO-LOOPREC-1: error-text capture + loop-guard classification
# ---------------------------------------------------------------------------
def _loop_killed_transcript():
    """The relay StreamLoopGuard kill as opencode 1.18.x actually persists it:
    ``info.error`` on the assistant message (processor halt path), NOT an
    "error" part (verified against pinned 1.18.1 source + a live 1.18.15
    session DB — zero error parts, 2113 info.error rows)."""
    return [
        {"info": {"role": "user"}, "parts": [{"type": "text", "text": "fix it"}]},
        {
            "info": {
                "role": "assistant",
                "tokens": {"input": 500, "output": 300, "reasoning": 50, "total": 850},
                "finish": "error",
                "cost": 0.0,
                "error": {
                    "name": "UnknownError",
                    "data": {
                        # Live-observed shape (2026-08-10 runs): the relay stamps
                        # a per-request trace id in the parens — placeholder here.
                        "message": "relay: generation loop detected (<request-id>)"
                    },
                },
            },
            "parts": [
                {"type": "step-start", "id": "s1"},
                {"type": "text", "text": "repeated repeated repeated"},
            ],
        },
    ]


def test_extract_transcript_metrics_captures_info_error_text():
    m = extract_transcript_metrics(_loop_killed_transcript())
    assert m["info_errors"] == 1
    assert m["error_parts"] == 0
    assert len(m["error_texts"]) == 1
    assert "generation loop detected" in m["error_texts"][0]
    # The killed message carries a text part -> it is a real turn, so the
    # turn-aligned exclusion count records it (WO-TURNACCT-1).
    assert m["guard_aborted_turns"] == 1
    assert m["finalize_timeouts"] == 0
    # The looped turn still meters (turn accounting unchanged).
    assert m["turns"] == 1
    assert m["output_tokens"] == 300


def test_extract_transcript_metrics_error_texts_bounded():
    long_msg = "x" * 500 + " relay_loop_detected"
    msgs = [
        {
            "info": {
                "role": "assistant",
                "error": {"name": "UnknownError", "data": {"message": long_msg}},
            },
            "parts": [],
        }
        for _ in range(12)
    ]
    m = extract_transcript_metrics(msgs)
    assert m["info_errors"] == 12  # count is exact
    assert len(m["error_texts"]) == 8  # capture is capped
    assert all(len(t) <= 240 for t in m["error_texts"])  # and truncated
    # Turn-aligned: a killed message with no text/tool parts is not a real
    # turn, so it must NOT enter the exclusion count (WO-TURNACCT-1) — the
    # subtraction downstream keys on ``turns``, which never counted these.
    assert m["guard_aborted_turns"] == 0


def test_extract_transcript_metrics_guard_aborted_count_is_exact_and_turn_aligned():
    # 12 guard-killed REAL turns (text part each): the exclusion count is
    # exact even though the error_texts capture caps at 8.
    msgs = [
        {
            "info": {
                "role": "assistant",
                "error": {
                    "name": "UnknownError",
                    "data": {
                        "message": "relay: generation loop detected (<request-id>)"
                    },
                },
            },
            "parts": [{"type": "text", "text": "repeated"}],
        }
        for _ in range(12)
    ]
    m = extract_transcript_metrics(msgs)
    assert m["guard_aborted_turns"] == 12
    assert m["turns"] == 12
    assert len(m["error_texts"]) == 8


def test_extract_transcript_metrics_finalize_timeout_counted_separately():
    m = extract_transcript_metrics(
        [
            {
                "info": {
                    "role": "assistant",
                    "error": {
                        "name": "UnknownError",
                        "data": {
                            "message": "relay: upstream completed but the stream "
                            "did not finalize within 30000ms (<request-id>)"
                        },
                    },
                },
                "parts": [{"type": "text", "text": "partial work"}],
            }
        ]
    )
    assert m["finalize_timeouts"] == 1
    assert m["guard_aborted_turns"] == 0


def test_extract_transcript_metrics_error_part_text_still_captured():
    m = extract_transcript_metrics(
        [
            {
                "info": {"role": "assistant"},
                "parts": [
                    {"type": "error", "message": "relay_loop_detected n=40 limit=3"}
                ],
            }
        ]
    )
    assert m["error_parts"] == 1
    assert m["info_errors"] == 0
    assert m["error_texts"] == ["relay_loop_detected n=40 limit=3"]


def test_classify_transport_anomaly_loop_guard_from_info_error_text():
    m = extract_transcript_metrics(_loop_killed_transcript())
    assert classify_transport_anomaly(m) == ("guard_abort", "loop_guard")


def test_classify_transport_anomaly_loop_guard_beats_truncation():
    assert classify_transport_anomaly(
        {
            "provider_truncations": 1,
            "error_parts": 0,
            "info_errors": 1,
            "error_texts": ["relay_loop_detected n=40 limit=3"],
        }
    ) == ("guard_abort", "loop_guard")


def test_classify_transport_anomaly_loop_guard_legacy_shape_still_matches():
    # The older proxy build's literal signature (pinned stdout fixture shape)
    # must keep classifying as the guard terminal alongside the live shape.
    assert classify_transport_anomaly(
        {
            "provider_truncations": 0,
            "error_parts": 0,
            "info_errors": 1,
            "error_texts": ["relay_loop_detected n=40 limit=3"],
        }
    ) == ("guard_abort", "loop_guard")


def test_classify_transport_anomaly_finalize_timeout_is_not_loop_guard():
    # The relay's 30s stream-finalize watchdog (observed 2x in the 2026-08-10
    # run's worker DB) is a transport death, NOT a repetition guard kill: it
    # gets its own reason so recovery picks the resume nudge, never the
    # anti-repetition nudge.
    assert classify_transport_anomaly(
        {
            "provider_truncations": 0,
            "error_parts": 0,
            "info_errors": 1,
            "error_texts": [
                "relay: upstream completed but the stream did not finalize "
                "within 30000ms (<request-id>)"
            ],
        }
    ) == ("transport_error", "stream_finalize_timeout")


def test_classify_transport_anomaly_relay_stream_incomplete_is_named():
    """The relay's OTHER stream death gets its own named reason (2026-09-09).

    It used to fall through to the generic ``error_event``, which is NOT in the
    recoverable set — so a stream that died mid-flight ended the phase
    unretried and climbed the cell ledger as an unrecovered anomaly. It is a
    relay terminal exactly like the finalize watchdog, so it is recovered
    exactly like one.
    """
    assert classify_transport_anomaly(
        {
            "provider_truncations": 0,
            "error_parts": 0,
            "info_errors": 1,
            "error_texts": [
                "relay: stream incomplete (a03b34fe888a4c739dbb0fb2c122ec25)"
            ],
        }
    ) == ("transport_error", "relay_stream_incomplete")


def test_classify_transport_anomaly_keys_on_the_relays_typed_codes():
    """The typed `type`/`code` is the primary match, the prose is the fallback.

    ``extract_transcript_metrics`` prefixes the error's type fields onto its
    message, so a relay build that reworded its prose — or dropped it — is
    still classified correctly.
    """
    for typed, expected in (
        ("relay_loop_detected loop_detected", ("guard_abort", "loop_guard")),
        (
            "relay_stream_finalize_timeout stream_finalize_timeout",
            ("transport_error", "stream_finalize_timeout"),
        ),
        (
            "relay_stream_incomplete stream_incomplete",
            ("transport_error", "relay_stream_incomplete"),
        ),
    ):
        assert (
            classify_transport_anomaly(
                {
                    "provider_truncations": 0,
                    "error_parts": 0,
                    "info_errors": 1,
                    "error_texts": [typed],
                }
            )
            == expected
        ), typed


def test_classify_transport_anomaly_unnamed_info_error_is_generic():
    """An error the relay did not name stays the generic, UNRECOVERABLE class.

    This is the boundary of the closed recoverable set: only the relay's own
    terminals are nudged, so an unrecognised error must not acquire a recovery
    by accident.
    """
    assert classify_transport_anomaly(
        {
            "provider_truncations": 0,
            "error_parts": 0,
            "info_errors": 1,
            "error_texts": ["ProviderModelError something went wrong"],
        }
    ) == ("transport_error", "error_event")


# ---------------------------------------------------------------------------
# founder_attach_command
# ---------------------------------------------------------------------------
def test_founder_attach_command():
    assert founder_attach_command(4096) == "opencode attach http://127.0.0.1:4096"
    assert founder_attach_command(4096, session_id="ses_abc") == (
        "opencode attach http://127.0.0.1:4096 --session ses_abc"
    )


def test_metrics_since_windows_the_classification_surface():
    """A killed turn's info.error persists in the transcript FOREVER: the
    cumulative read keeps matching it (metering never forgets), while the
    windowed read — the anomaly-classification surface — excludes it. This is
    the 2026-08-10 chunk-2 fix: a recovered, marker-landing drive must not be
    reclassified by the stale kill."""
    client = ServeClient(base_url="http://127.0.0.1:1", timeout=0.1, poll_interval=0.01)
    messages = [
        {"info": {"role": "user"}, "parts": [{"type": "text", "text": "chunk one"}]},
        {
            "info": {
                "role": "assistant",
                "error": {
                    "name": "UnknownError",
                    "data": {"message": "relay: generation loop detected (req-1)"},
                },
            },
            "parts": [{"type": "step-start"}],
        },
        {"info": {"role": "user"}, "parts": [{"type": "text", "text": "nudge"}]},
        {
            "info": {
                "role": "assistant",
                "tokens": {"input": 10, "output": 5, "reasoning": 0},
            },
            "parts": [
                {
                    "type": "text",
                    "text": "recovered work, carried on from where I stopped",
                }
            ],
        },
    ]
    client.get_messages = lambda session_id: messages  # type: ignore[method-assign]
    cumulative = client.metrics("ses_x")
    assert cumulative["info_errors"] == 1
    assert classify_transport_anomaly(cumulative) == ("guard_abort", "loop_guard")
    windowed = client.metrics("ses_x", since=2)
    assert windowed["info_errors"] == 0
    assert windowed["output_tokens"] == 5
    assert classify_transport_anomaly(windowed) == (None, None)


def test_http_error_wraps_serve_client_error(monkeypatch):
    from harness import serve_client as sc

    def boom(*args, **kwargs):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(sc.urllib.request, "urlopen", boom)
    with pytest.raises(ServeClientError):
        sc._http_json("GET", "http://127.0.0.1:4096/session/status")
    with pytest.raises(ServeClientError):
        sc._http_status("POST", "http://127.0.0.1:4096/session")
