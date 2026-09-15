"""Hermetic unit tests for the harness.serve_client HTTP surface.

No live server, no docker, no model. All HTTP IO is made injectable via the
module-level ``_http_json`` / ``_http_status`` helpers, which these tests
monkeypatch. Covers create_session, send_prompt, abort, session_busy,
get_messages, wait_idle, metrics() composition and the D-SERVE-MESSAGE-500
transient observation-read retry contract. Never hits the network.
"""

import urllib.error

import pytest

from harness.serve_client import (
    ServeClient,
    ServeClientError,
    build_prompt_body,
)


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
    title = "bench-okp-org-0-off-1786777435"
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
