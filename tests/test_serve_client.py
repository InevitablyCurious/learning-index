"""Hermetic unit tests for harness.serve_client.

No live server, no docker, no model. All HTTP IO is made injectable via the
module-level ``_http_json`` / ``_http_status`` helpers, which these tests
monkeypatch. Never hits the network.
"""

import json
import time
import urllib.error

import pytest

from harness.serve_client import (
    LOOP_KILL_WAIT_REASON,
    ServeClient,
    ServeClientError,
    build_prompt_body,
    classify_step_finish_reason,
    classify_transport_anomaly,
    extract_transcript_metrics,
    founder_attach_command,
    loop_kill_marker_name,
    parse_busy_status,
    read_loop_kill_marker,
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
    # truncations: length + stream-incomplete = 2
    assert m["truncations"] == 2
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
        "truncations": 0,
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
    assert m["truncations"] == 0
    assert m["last_finish"] == "tool-calls"


# ---------------------------------------------------------------------------
# classify_transport_anomaly
# ---------------------------------------------------------------------------
def test_classify_transport_anomaly_truncated():
    assert classify_transport_anomaly({"truncations": 1, "error_parts": 0}) == (
        "truncated",
        "stream-incomplete",
    )


def test_classify_transport_anomaly_error():
    assert classify_transport_anomaly({"truncations": 0, "error_parts": 1}) == (
        "transport_error",
        "error_event",
    )


def test_classify_transport_anomaly_clean():
    assert classify_transport_anomaly({"truncations": 0, "error_parts": 0}) == (
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
            "truncations": 1,
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
            "truncations": 0,
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
            "truncations": 0,
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
            "truncations": 0,
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
                    "truncations": 0,
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
            "truncations": 0,
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
            "parts": [{"type": "text", "text": "recovered work, carried on from where I stopped"}],
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


# ---------------------------------------------------------------------------
# ServeClient (IO injected via monkeypatched module helpers)
# ---------------------------------------------------------------------------
def _fake_json(monkeypatch, responses):
    """Pop a (payload) from ``responses`` per call to ``_http_json``."""
    calls = []

    def fake(method, url, body=None, timeout=5.0):
        calls.append((method, url, body))
        if isinstance(responses, Exception):
            raise responses
        return responses.pop(0)

    monkeypatch.setattr("harness.serve_client._http_json", fake)
    return calls


def test_create_session_parses_id(monkeypatch):
    calls = _fake_json(monkeypatch, [{"id": "ses_abc"}])
    client = ServeClient("http://127.0.0.1:4096")
    assert client.create_session() == "ses_abc"
    method, url, body = calls[0]
    assert method == "POST"
    assert url == "http://127.0.0.1:4096/session"
    assert body == {}


def test_create_session_sends_title_in_body_when_provided(monkeypatch):
    """WO-STRIP-2b: a titled create seeds session DB ``session.title``."""
    calls = _fake_json(monkeypatch, [{"id": "ses_titled"}])
    client = ServeClient("http://127.0.0.1:4096")
    title = "okp-bench-okp-org-0-off-1786777435"
    assert client.create_session(title=title) == "ses_titled"
    method, url, body = calls[0]
    assert method == "POST"
    assert url == "http://127.0.0.1:4096/session"
    assert body == {"title": title}


def test_create_session_missing_id(monkeypatch):
    _fake_json(monkeypatch, [{}])
    with pytest.raises(ServeClientError):
        ServeClient("http://127.0.0.1:4096").create_session()


def test_send_prompt_accepts_204(monkeypatch):
    seen = {}

    def fake(method, url, body=None, timeout=5.0):
        seen.update(method=method, url=url, body=body)
        return 204

    monkeypatch.setattr("harness.serve_client._http_status", fake)
    client = ServeClient("http://127.0.0.1:4096")
    client.send_prompt("ses_1", "run it")
    assert seen["method"] == "POST"
    assert seen["body"] == build_prompt_body("run it")
    assert "/ses_1/prompt_async" in seen["url"]


def test_send_prompt_rejects_non_204(monkeypatch):
    monkeypatch.setattr(
        "harness.serve_client._http_status",
        lambda method, url, body=None, timeout=5.0: 500,
    )
    with pytest.raises(ServeClientError):
        ServeClient("http://127.0.0.1:4096").send_prompt("ses_1", "x")


def test_abort_accepts_2xx(monkeypatch):
    seen = {}

    def fake(method, url, body=None, timeout=5.0):
        seen.update(method=method, url=url, body=body)
        return 200

    monkeypatch.setattr("harness.serve_client._http_status", fake)
    client = ServeClient("http://127.0.0.1:4096")
    assert client.abort("ses_1") is None
    assert seen["method"] == "POST"
    assert seen["body"] is None
    assert seen["url"] == "http://127.0.0.1:4096/session/ses_1/abort"


def test_abort_rejects_non_2xx(monkeypatch):
    monkeypatch.setattr(
        "harness.serve_client._http_status",
        lambda method, url, body=None, timeout=5.0: 500,
    )
    with pytest.raises(ServeClientError):
        ServeClient("http://127.0.0.1:4096").abort("ses_1")


def test_abort_wraps_transport_error(monkeypatch):
    from harness import serve_client as sc

    def boom(*args, **kwargs):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(sc.urllib.request, "urlopen", boom)
    with pytest.raises(ServeClientError):
        ServeClient("http://127.0.0.1:4096").abort("ses_1")


def test_session_busy_parses(monkeypatch):
    _fake_json(monkeypatch, [{"ses_1": {"type": "busy"}}])
    assert ServeClient("http://127.0.0.1:4096").session_busy("ses_1") is True


def test_session_busy_idle(monkeypatch):
    _fake_json(monkeypatch, [{}])
    assert ServeClient("http://127.0.0.1:4096").session_busy("ses_1") is False


def test_get_messages(monkeypatch):
    _fake_json(monkeypatch, [[{"info": {"role": "assistant"}, "parts": []}]])
    msgs = ServeClient("http://127.0.0.1:4096").get_messages("ses_1")
    assert msgs[0]["info"]["role"] == "assistant"


def test_wait_idle_returns_true(monkeypatch):
    # First poll busy, second poll idle -> True.
    busy = iter([True, False])
    monkeypatch.setattr(
        "harness.serve_client.ServeClient.session_busy",
        lambda self, sid: next(busy),
    )
    client = ServeClient("http://127.0.0.1:4096", poll_interval=0.0)
    assert client.wait_idle("ses_1", timeout_s=5) is True


def test_wait_idle_times_out(monkeypatch):
    monkeypatch.setattr(
        "harness.serve_client.ServeClient.session_busy",
        lambda self, sid: True,
    )
    client = ServeClient("http://127.0.0.1:4096", poll_interval=0.0)
    assert client.wait_idle("ses_1", timeout_s=0.05) is False


# ---------------------------------------------------------------------------
# read_loop_kill_marker / the loop_killed wait reason
# ---------------------------------------------------------------------------
def _now_ms() -> int:
    return int(time.time() * 1000)


def _write_loop_kill_marker(dir_path, session_id="ses_1", timestamp=None):
    """Write a contract-shaped marker: loop-kill-<sid>.json, epoch MS."""
    payload = {
        "session_id": session_id,
        "timestamp": _now_ms() if timestamp is None else timestamp,
        "signature": "relay_loop_detected n=40 limit=3",
    }
    path = dir_path / f"loop-kill-{session_id}.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_loop_kill_marker_name_matches_the_sidecar_sanitizer():
    # Must mirror writeLoopKillMarker in loop-kill-scanner.cjs byte-for-byte:
    # every char outside [A-Za-z0-9_-] becomes "_".
    assert loop_kill_marker_name("ses_aB3-x") == "loop-kill-ses_aB3-x.json"
    assert loop_kill_marker_name("ses.a/b c") == "loop-kill-ses_a_b_c.json"


def test_read_loop_kill_marker_none_dir_is_false():
    assert read_loop_kill_marker(None, session_id="ses_1") is False


def test_read_loop_kill_marker_missing_dir_is_false(tmp_path):
    assert (
        read_loop_kill_marker(str(tmp_path / "no-such-dir"), session_id="ses_1")
        is False
    )


def test_read_loop_kill_marker_file_path_is_false(tmp_path):
    # A regular file is not a directory: False, never an exception.
    f = tmp_path / "not-a-dir"
    f.write_text("x", encoding="utf-8")
    assert read_loop_kill_marker(str(f), session_id="ses_1") is False


def test_read_loop_kill_marker_fresh_marker_is_true(tmp_path):
    _write_loop_kill_marker(tmp_path)
    assert read_loop_kill_marker(str(tmp_path), session_id="ses_1") is True
    # Fresh relative to a turn that started a minute ago.
    assert (
        read_loop_kill_marker(str(tmp_path), _now_ms() - 60_000, session_id="ses_1")
        is True
    )


def test_read_loop_kill_marker_older_than_since_is_false(tmp_path):
    _write_loop_kill_marker(tmp_path, timestamp=_now_ms() - 120_000)
    assert (
        read_loop_kill_marker(str(tmp_path), _now_ms() - 60_000, session_id="ses_1")
        is False
    )
    # Without a since bound, any timestamp counts.
    assert read_loop_kill_marker(str(tmp_path), session_id="ses_1") is True


def test_read_loop_kill_marker_tolerates_malformed_file(tmp_path):
    # A half-written marker for THIS session must never wedge the waiter.
    (tmp_path / "loop-kill-ses_1.json").write_text("{not json", encoding="utf-8")
    assert read_loop_kill_marker(str(tmp_path), session_id="ses_1") is False
    # ...and is superseded by the sidecar's next (complete) write.
    _write_loop_kill_marker(tmp_path)
    assert (
        read_loop_kill_marker(str(tmp_path), _now_ms() - 60_000, session_id="ses_1")
        is True
    )


def test_read_loop_kill_marker_ignores_non_marker_and_timestampless(tmp_path):
    (tmp_path / "other.json").write_text(
        json.dumps({"timestamp": _now_ms()}), encoding="utf-8"
    )
    (tmp_path / "loop-kill-ses_1.json").write_text(
        json.dumps({"session_id": "ses_1"}), encoding="utf-8"
    )
    assert read_loop_kill_marker(str(tmp_path), session_id="ses_1") is False


def test_read_loop_kill_marker_never_honours_the_unknown_marker(tmp_path):
    # REGRESSION (run 1788883142). The sidecar writes loop-kill-unknown.json
    # for every request without an X-Session-Id header — which is every request
    # that is not the model provider's. Globbing loop-kill-*.json let that file
    # kill 62 healthy turns of a session it says nothing about.
    (tmp_path / "loop-kill-unknown.json").write_text(
        json.dumps(
            {
                "session_id": None,
                "timestamp": _now_ms(),
                "signature": "relay_loop_detected",
            }
        ),
        encoding="utf-8",
    )
    assert read_loop_kill_marker(str(tmp_path), session_id="ses_1") is False
    assert read_loop_kill_marker(str(tmp_path), session_id="unknown") is False


def test_read_loop_kill_marker_ignores_another_sessions_marker(tmp_path):
    _write_loop_kill_marker(tmp_path, session_id="ses_other")
    assert read_loop_kill_marker(str(tmp_path), session_id="ses_1") is False


def test_read_loop_kill_marker_requires_the_payload_session_to_match(tmp_path):
    # Right file name, wrong recorded identity: both gates must agree.
    (tmp_path / "loop-kill-ses_1.json").write_text(
        json.dumps(
            {
                "session_id": "ses_other",
                "timestamp": _now_ms(),
                "signature": "relay_loop_detected",
            }
        ),
        encoding="utf-8",
    )
    assert read_loop_kill_marker(str(tmp_path), session_id="ses_1") is False


def test_read_loop_kill_marker_consume_removes_the_marker(tmp_path):
    # One marker ends at most ONE turn: without this a marker that stops being
    # refreshed still kills every later turn whose start precedes it.
    path = _write_loop_kill_marker(tmp_path)
    assert (
        read_loop_kill_marker(str(tmp_path), session_id="ses_1", consume=True) is True
    )
    assert not path.exists()
    assert read_loop_kill_marker(str(tmp_path), session_id="ses_1") is False


def test_read_loop_kill_marker_does_not_consume_by_default(tmp_path):
    path = _write_loop_kill_marker(tmp_path)
    assert read_loop_kill_marker(str(tmp_path), session_id="ses_1") is True
    assert path.exists()


def test_read_loop_kill_marker_leaves_an_unhonoured_marker_in_place(tmp_path):
    # A stale marker is not consumed by a turn it did not end — the next real
    # kill overwrites it, and consumption stays tied to an actual honour.
    path = _write_loop_kill_marker(tmp_path, timestamp=_now_ms() - 120_000)
    assert (
        read_loop_kill_marker(
            str(tmp_path), _now_ms() - 60_000, session_id="ses_1", consume=True
        )
        is False
    )
    assert path.exists()


def test_wait_idle_detailed_returns_loop_killed_on_fresh_marker(tmp_path, monkeypatch):
    # Busy forever, as a wedged post-loop-kill session is; the marker must end
    # the wait on the first poll, long before timeout_s.
    monkeypatch.setattr(
        "harness.serve_client.ServeClient.session_busy",
        lambda self, sid: True,
    )
    _write_loop_kill_marker(tmp_path, session_id="ses_1")
    client = ServeClient("http://127.0.0.1:4096", poll_interval=0.0)
    started = time.monotonic()
    reached, reason = client.wait_idle_detailed(
        "ses_1",
        timeout_s=30.0,
        loop_kill_marker_dir=str(tmp_path),
        turn_start_ts_ms=_now_ms() - 60_000,
    )
    assert (reached, reason) == (False, "loop_killed")
    assert reason == LOOP_KILL_WAIT_REASON
    assert time.monotonic() - started < 5.0, "the marker must short-circuit the wait"


def test_wait_idle_detailed_ignores_a_marker_older_than_the_turn(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "harness.serve_client.ServeClient.session_busy",
        lambda self, sid: True,
    )
    _write_loop_kill_marker(tmp_path, timestamp=_now_ms() - 120_000)
    client = ServeClient("http://127.0.0.1:4096", poll_interval=0.0)
    reached, reason = client.wait_idle_detailed(
        "ses_1",
        timeout_s=0.05,
        loop_kill_marker_dir=str(tmp_path),
        turn_start_ts_ms=_now_ms() - 60_000,
    )
    assert (reached, reason) == (False, "timeout")


def test_wait_idle_detailed_ignores_an_unknown_session_marker(tmp_path, monkeypatch):
    # REGRESSION (run 1788883142). loop-kill-unknown.json was refreshed on every
    # harness poll by opencode's replay of an already-recorded loop-kill error,
    # so every turn died ~4s in. It must not end this session's wait.
    monkeypatch.setattr(
        "harness.serve_client.ServeClient.session_busy",
        lambda self, sid: True,
    )
    (tmp_path / "loop-kill-unknown.json").write_text(
        json.dumps(
            {
                "session_id": None,
                "timestamp": _now_ms(),
                "signature": "relay_loop_detected",
            }
        ),
        encoding="utf-8",
    )
    client = ServeClient("http://127.0.0.1:4096", poll_interval=0.0)
    reached, reason = client.wait_idle_detailed(
        "ses_1",
        timeout_s=0.05,
        loop_kill_marker_dir=str(tmp_path),
        turn_start_ts_ms=_now_ms() - 60_000,
    )
    assert (reached, reason) == (False, "timeout")


def test_wait_idle_detailed_consumes_the_marker_so_the_next_turn_survives(
    tmp_path, monkeypatch
):
    # The marker ends ONE turn. A second turn started after it must not be
    # killed by the same file — that latch is what burned the 20-nudge budget
    # in three consecutive phases and blew the per-benchmark error cap.
    monkeypatch.setattr(
        "harness.serve_client.ServeClient.session_busy",
        lambda self, sid: True,
    )
    marker = _write_loop_kill_marker(tmp_path, session_id="ses_1")
    client = ServeClient("http://127.0.0.1:4096", poll_interval=0.0)
    first = client.wait_idle_detailed(
        "ses_1",
        timeout_s=30.0,
        loop_kill_marker_dir=str(tmp_path),
        turn_start_ts_ms=_now_ms() - 60_000,
    )
    assert first == (False, LOOP_KILL_WAIT_REASON)
    assert not marker.exists()
    second = client.wait_idle_detailed(
        "ses_1",
        timeout_s=0.05,
        loop_kill_marker_dir=str(tmp_path),
        turn_start_ts_ms=_now_ms() - 60_000,
    )
    assert second == (False, "timeout")


def test_wait_idle_detailed_without_a_marker_keeps_stall_and_timeout(
    tmp_path, monkeypatch
):
    # Empty marker dir: stall detection and the budget behave exactly as before.
    monkeypatch.setattr(
        "harness.serve_client.ServeClient.session_busy",
        lambda self, sid: True,
    )
    monkeypatch.setattr(
        "harness.serve_client.ServeClient.session_progress_token",
        lambda self, sid: (1, 1),
    )
    client = ServeClient("http://127.0.0.1:4096", poll_interval=0.0)
    reached, reason = client.wait_idle_detailed(
        "ses_1",
        timeout_s=5.0,
        stall_timeout_s=0.0,
        progress_interval_s=0.0,
        loop_kill_marker_dir=str(tmp_path),
        turn_start_ts_ms=_now_ms(),
    )
    assert (reached, reason) == (False, "stalled")


def test_wait_idle_detailed_default_has_no_marker_check(monkeypatch):
    # loop_kill_marker_dir=None (the default) must never touch the filesystem
    # nor change the outcome: busy until the budget expires.
    monkeypatch.setattr(
        "harness.serve_client.ServeClient.session_busy",
        lambda self, sid: True,
    )
    client = ServeClient("http://127.0.0.1:4096", poll_interval=0.0)
    reached, reason = client.wait_idle_detailed("ses_1", timeout_s=0.05)
    assert (reached, reason) == (False, "timeout")


def test_metrics_composition(monkeypatch):
    transcript = [
        {
            "info": {"role": "assistant"},
            "parts": [{"type": "step-finish", "reason": "stop"}],
        }
    ]
    _fake_json(monkeypatch, [transcript])
    m = ServeClient("http://127.0.0.1:4096").metrics("ses_1")
    # Bare step-finish with no tokens/text/tool is a placeholder -> 0 turns.
    assert m["turns"] == 0
    assert m["last_finish"] == "stop"


def test_http_error_wraps_serve_client_error(monkeypatch):
    from harness import serve_client as sc

    def boom(*args, **kwargs):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(sc.urllib.request, "urlopen", boom)
    with pytest.raises(ServeClientError):
        sc._http_json("GET", "http://127.0.0.1:4096/session/status")
    with pytest.raises(ServeClientError):
        sc._http_status("POST", "http://127.0.0.1:4096/session")


# ---------------------------------------------------------------------------
# D-SERVE-MESSAGE-500 — transient observation-read retry (2026-08-11)
#
# A single HTTP 500 from GET /session/{id}/message killed a 32-minute cell.
# The session was alive; only the harness's ability to OBSERVE it failed, and
# recovery could not fire because the nudge decision reads that same endpoint.
# These tests pin the retry contract that closes it.
# ---------------------------------------------------------------------------
def _http_error(code):
    return urllib.error.HTTPError(
        url="http://127.0.0.1:4096/session/ses_1/message",
        code=code,
        msg="Internal Server Error",
        hdrs=None,
        fp=None,
    )


def _flaky_json(monkeypatch, outcomes, sleeps=None):
    """Pop an outcome per _http_json call; Exceptions are raised, else returned."""
    calls = []

    def fake(method, url, body=None, timeout=5.0):
        calls.append(url)
        item = outcomes.pop(0)
        if isinstance(item, Exception):
            raise ServeClientError(f"{method} {url} failed: {item}") from item
        return item

    monkeypatch.setattr("harness.serve_client._http_json", fake)
    monkeypatch.setattr(
        "harness.serve_client.time.sleep",
        lambda s: sleeps.append(s) if sleeps is not None else None,
    )
    return calls


def test_get_messages_retries_through_the_exact_500_that_voided_the_cell(monkeypatch):
    """Two consecutive 500s then success -> the read succeeds, cell survives."""
    payload = [{"info": {"role": "assistant"}, "parts": []}]
    sleeps = []
    calls = _flaky_json(
        monkeypatch, [_http_error(500), _http_error(500), payload], sleeps
    )
    msgs = ServeClient("http://127.0.0.1:4096").get_messages("ses_1")
    assert msgs == payload
    assert len(calls) == 3, "must retry until the read lands"
    assert sleeps == [0.5, 1.0], "linear backoff between attempts"


def test_get_messages_raises_after_exhausting_retries(monkeypatch):
    """A genuinely dead serve still fails LOUDLY — retry is not a hang."""
    _flaky_json(monkeypatch, [_http_error(500)] * 4)
    with pytest.raises(ServeClientError) as excinfo:
        ServeClient("http://127.0.0.1:4096").get_messages("ses_1")
    assert "4 consecutive transient failures" in str(excinfo.value)


def test_get_messages_never_retries_a_real_answer(monkeypatch):
    """A 404 is the serve ANSWERING (unknown session); retrying would be a lie."""
    calls = _flaky_json(monkeypatch, [_http_error(404)])
    with pytest.raises(ServeClientError):
        ServeClient("http://127.0.0.1:4096").get_messages("ses_1")
    assert len(calls) == 1, "4xx must not be retried"


def test_session_busy_retries_transient_faults(monkeypatch):
    """The completion signal must not read 'idle' because of a transient 500."""
    calls = _flaky_json(monkeypatch, [_http_error(503), {"ses_1": {"type": "busy"}}])
    assert ServeClient("http://127.0.0.1:4096").session_busy("ses_1") is True
    assert len(calls) == 2


def test_wait_idle_treats_a_dead_probe_as_busy_never_idle(monkeypatch):
    """Fail-safe direction: an unreadable probe must never release the gates.

    Reading 'idle' from a failed probe lets the harness gate a worktree the
    worker is still writing (the 2026-08-09 turns=0/gates-race void).
    """

    def always_fails(self, sid):
        raise ServeClientError("probe down")

    monkeypatch.setattr("harness.serve_client.ServeClient.session_busy", always_fails)
    client = ServeClient("http://127.0.0.1:4096", poll_interval=0.0)
    assert client.wait_idle("ses_1", timeout_s=0.05) is False


def test_wait_idle_returns_true_once_a_probe_recovers(monkeypatch):
    """A transient probe outage mid-wait resolves to a real idle reading."""
    results = iter([ServeClientError("down"), True, False])

    def flaky(self, sid):
        item = next(results)
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr("harness.serve_client.ServeClient.session_busy", flaky)
    client = ServeClient("http://127.0.0.1:4096", poll_interval=0.0)
    assert client.wait_idle("ses_1", timeout_s=5) is True
