"""The live-stream contract (LIVE-STREAM.md).

These pin the promises a THIRD-PARTY backend is told it can rely on. Breaking
one of these breaks every backend that integrated against the spec, which is
the whole point of having a spec.
"""

import json
import os
import time

from bench.live_stream import (
    HEARTBEAT_INTERVAL_S,
    Heartbeat,
    ENV_NS,
    ENV_PATH,
    SCHEMA_VERSION,
    STREAM_FILENAME,
    LiveStream,
)


def _lines(path):
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def test_stream_lives_beside_run_artifacts_not_in_a_backend_state_dir(tmp_path):
    # Rule 5: hosting this inside a backend's state dir makes the control arm
    # go dark, because Okp leaves the OFF worktree deliberately unbound.
    s = LiveStream.for_run(tmp_path, run_id="r1")
    assert s.path == tmp_path / STREAM_FILENAME


def test_envelope_shape_is_the_documented_one(tmp_path):
    s = LiveStream.for_run(tmp_path, run_id="r1")
    s.emit("cell.start", cell_seq=0, session_id="ses_abc", arm="off")
    (rec,) = _lines(s.path)
    assert rec["v"] == SCHEMA_VERSION
    assert rec["kind"] == "cell.start"
    assert rec["run_id"] == "r1"
    assert rec["session_id"] == "ses_abc"
    assert isinstance(rec["ts"], int)


def test_none_fields_are_omitted_never_written_as_null(tmp_path):
    # Absence is its own state on the board; a null on the wire is
    # indistinguishable from "this producer does not set that field".
    s = LiveStream.for_run(tmp_path, run_id="r1")
    s.emit("cell.start", session_id="ses_abc", arm=None)
    (rec,) = _lines(s.path)
    assert "arm" not in rec


def test_ext_payload_is_opaque_and_passes_through_untouched(tmp_path):
    # The modularity claim: the harness does not read, validate or reshape a
    # backend's data. Anything JSON-serialisable survives byte for byte.
    s = LiveStream.for_run(tmp_path, run_id="r1")
    payload = {"marks": 3, "nested": {"a": [1, 2, {"b": None}]}, "unicode": "café"}
    s.ext("acme.recall", "recall.served", payload, session_id="ses_abc")
    (rec,) = _lines(s.path)
    assert rec["kind"] == "ext"
    assert rec["ns"] == "acme.recall"
    assert rec["type"] == "recall.served"
    assert rec["data"] == payload


def test_append_only_across_many_writes(tmp_path):
    # Rule 2: a reader that consumed N lines can consume from N+1 forever.
    s = LiveStream.for_run(tmp_path, run_id="r1")
    for i in range(50):
        s.emit("gate.result", attempt=1, id=f"g{i}", status="pass")
    recs = _lines(s.path)
    assert len(recs) == 50
    assert [r["id"] for r in recs] == [f"g{i}" for i in range(50)]


def test_two_producers_interleave_whole_lines(tmp_path):
    # Rule 3: the harness and a backend hold separate handles to one file.
    harness = LiveStream.for_run(tmp_path, run_id="r1")
    backend = LiveStream(harness.path)
    for i in range(20):
        harness.emit("gate.result", id=f"g{i}", status="pass")
        backend.ext("acme.recall", "recall.served", {"i": i})
    recs = _lines(harness.path)  # every line parses => none were shredded
    assert len(recs) == 40
    assert sum(r["kind"] == "ext" for r in recs) == 20


def test_a_write_failure_is_dropped_never_raised(tmp_path):
    # Rule 1: telemetry must never kill a run.
    s = LiveStream(tmp_path / "nope" / "x")
    (tmp_path / "nope").write_text("i am a file, not a directory")
    assert s.emit("cell.start", session_id="ses_abc") is False
    assert s.dropped == 1
    assert s.ok is False


def test_unserialisable_payload_degrades_instead_of_losing_the_record(tmp_path):
    s = LiveStream.for_run(tmp_path, run_id="r1")
    assert s.ext("acme.recall", "weird", {"path": tmp_path, "set": {1, 2}}) is True
    (rec,) = _lines(s.path)
    assert rec["ns"] == "acme.recall"


def test_backend_side_from_env_is_the_whole_integration_surface(tmp_path):
    target = tmp_path / STREAM_FILENAME
    backend = LiveStream.from_env({ENV_PATH: str(target)})
    assert backend is not None
    backend.ext("acme.recall", "recall.served", {"hits": 3})
    assert _lines(target)[0]["ns"] == "acme.recall"


def test_absent_env_means_no_telemetry_wanted_not_an_error(tmp_path):
    # A backend outside a benchmark run must carry on, never raise.
    assert LiveStream.from_env({}) is None


def test_env_export_carries_path_and_namespace(tmp_path):
    s = LiveStream.for_run(tmp_path, run_id="r1")
    env = s.env("okp.plugin")
    assert env[ENV_PATH] == str(tmp_path / STREAM_FILENAME)
    assert env[ENV_NS] == "okp.plugin"
    assert LiveStream.from_env(env) is not None


def test_no_namespace_exports_path_only(tmp_path):
    s = LiveStream.for_run(tmp_path, run_id="r1")
    assert ENV_NS not in s.env("")


# ── heartbeat ────────────────────────────────────────────────────────────────
#
# The one kind that is not a transition. Every other record marks something
# HAPPENING, and a wedged cell stops producing those — so a stream of them can
# say what occurred but never whether anything still is. Before this existed,
# four surfaces each invented a liveness proxy (log mtime, the serve event
# feed, a `ps` scan, the TUI mirror's child handle) and the log-mtime one put
# "CELL STALLED" in the header of a cell that was mid-turn.


def test_heartbeat_beats_on_wall_time_and_carries_the_phase(tmp_path):
    stream = LiveStream.for_run(tmp_path, run_id="r1")
    hb = Heartbeat(stream, interval_s=0.05, cell_seq=0)
    hb.set_phase("initial-chunk-1", attempt=1)
    hb.start()
    try:
        _wait_for(lambda: len(_lines(tmp_path / STREAM_FILENAME)) >= 3)
    finally:
        hb.stop()

    beats = [r for r in _lines(tmp_path / STREAM_FILENAME) if r["kind"] == "heartbeat"]
    assert len(beats) >= 3, "a heartbeat must beat on a clock, not on work"
    assert beats[-1]["phase"] == "initial-chunk-1"
    assert beats[-1]["attempt"] == 1
    assert beats[-1]["cell_seq"] == 0
    # since_ms is monotonic: a reader uses it to tell a fresh cell from a long one.
    assert beats[-1]["since_ms"] >= beats[0]["since_ms"]


def test_the_first_beat_is_synchronous(tmp_path):
    # Waiting a full interval would leave a window at cell start where the
    # stream holds no heartbeat — indistinguishable, to a reader, from a
    # harness that never had one, which reads as "unknown" and blinds the board.
    stream = LiveStream.for_run(tmp_path, run_id="r1")
    hb = Heartbeat(stream, interval_s=3600)
    hb.start()
    try:
        assert len(_lines(tmp_path / STREAM_FILENAME)) == 1
    finally:
        hb.stop()


def test_stopping_is_immediate_and_final(tmp_path):
    # Nothing may beat after stop(): the harness writes `cell.end` right after,
    # and a late beat would tell a reader the cell is still going.
    stream = LiveStream.for_run(tmp_path, run_id="r1")
    hb = Heartbeat(stream, interval_s=0.05)
    hb.start()
    _wait_for(lambda: len(_lines(tmp_path / STREAM_FILENAME)) >= 2)
    hb.stop()
    settled = len(_lines(tmp_path / STREAM_FILENAME))
    time.sleep(0.25)
    assert len(_lines(tmp_path / STREAM_FILENAME)) == settled


def test_a_heartbeat_that_cannot_be_written_never_fails_the_cell(tmp_path):
    # DESIGN RULE 1. An unwritable stream stops the SIGNAL — which correctly
    # reads as a stall — and must never stop the RUN.
    # Genuinely unwritable: a FILE stands where the stream's parent directory
    # would have to be, so the mkdir the writer does on demand cannot succeed.
    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory")
    stream = LiveStream(blocker / "nested" / STREAM_FILENAME)
    hb = Heartbeat(stream, interval_s=0.05)
    hb.start()
    time.sleep(0.15)
    hb.stop()  # no raise
    assert stream.ok is False, "the stream knows it is failing"
    assert stream.written == 0


def test_a_heartbeat_with_no_stream_is_inert(tmp_path):
    # An adapter that predates the live stream hands None; it must not crash.
    hb = Heartbeat(None, interval_s=0.01)
    hb.start()
    hb.set_phase("x")
    assert hb.beat() is False
    hb.stop()


def test_the_beat_thread_is_a_daemon_and_cannot_hold_the_process_open(tmp_path):
    stream = LiveStream.for_run(tmp_path, run_id="r1")
    hb = Heartbeat(stream, interval_s=0.05)
    hb.start()
    try:
        assert hb._thread is not None and hb._thread.daemon
    finally:
        hb.stop()


def test_the_interval_leaves_headroom_under_the_stall_threshold(tmp_path):
    # The board stalls a cell at 900s of silence. 15s beats is 60 missed beats,
    # so a slow disk or a GC pause cannot be mistaken for a wedge. If either
    # number moves, this is the assertion that says so.
    assert HEARTBEAT_INTERVAL_S <= 30.0
    assert 900 / HEARTBEAT_INTERVAL_S >= 20


def _wait_for(pred, timeout_s: float = 3.0) -> None:
    """Poll until `pred` holds. Beats are produced by a thread on a clock, so a
    fixed sleep would either be flaky or slow; this is neither."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if pred():
            return
        time.sleep(0.01)
    raise AssertionError("condition not reached within timeout")
