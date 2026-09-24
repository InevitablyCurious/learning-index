"""Hermetic unit tests for harness.serve_client loop-kill marker handling.

No live server, no docker, no model. Covers loop_kill_marker_name,
read_loop_kill_marker and ServeClient.wait_idle_detailed (the loop_killed
wait reason). Marker IO uses pytest's tmp_path fixture only. Never hits the
network.
"""

import json
import time

from harness.serve_client import (
    LOOP_KILL_WAIT_REASON,
    ServeClient,
    loop_kill_marker_name,
    read_loop_kill_marker,
)


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

    class _NoTokens:  # the serve's delta stream: nothing streaming
        def count(self) -> int:
            return 0

        def close(self) -> None:
            pass

    monkeypatch.setattr(
        "harness.serve_client.ServeClient.open_delta_counter",
        lambda self, sid: _NoTokens(),
    )
    # A command still running: the wedged turn the stall bound exists for.
    monkeypatch.setattr(
        "harness.serve_client.ServeClient.session_tool_running",
        lambda self, sid: True,
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
