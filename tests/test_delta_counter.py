"""The stall bound's view of a thinking model: the serve's streamed deltas.

Run 1790258326 (2026-09-24): at ~225k context one block of thinking streamed
for over 10 minutes. The stored transcript does not move while a block streams
(the reasoning part reads back with empty text until the block ends), so the
stall bound killed the model mid-sentence. DeltaCounter counts the session's
``message.part.delta`` events on the serve's ``GET /event`` stream instead —
the events opencode 1.18.10 was observed publishing for every streamed token.
"""

from __future__ import annotations

import http.server
import json
import socket
import threading
import time

import pytest

from harness.serve_client import DeltaCounter, ServeClientError


def _event(kind: str, session: str) -> dict:
    return {
        "type": kind,
        "properties": {"sessionID": session, "field": "text", "delta": "x"},
    }


class _Stream(http.server.BaseHTTPRequestHandler):
    """Serves one batch of events per connection, then closes it (HTTP/1.0)."""

    batches: list = []
    served = 0

    def do_GET(self) -> None:  # noqa: N802 — http.server's name
        cls = type(self)
        n = cls.served
        cls.served += 1
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        self.wfile.write(b'data: {"type":"server.connected","properties":{}}\n\n')
        for event in cls.batches[n] if n < len(cls.batches) else []:
            self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
        self.wfile.flush()

    def log_message(self, *args) -> None:
        pass


def _serve(batches: list):
    handler = type("Handler", (_Stream,), {"batches": batches, "served": 0})
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, handler, f"http://127.0.0.1:{server.server_address[1]}/event"


def _until(predicate, timeout_s: float = 5.0) -> bool:
    end = time.monotonic() + timeout_s
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def test_counts_only_this_sessions_streamed_tokens():
    server, _, url = _serve(
        [
            [
                _event("message.part.delta", "ses_A"),
                _event("message.part.delta", "ses_B"),  # another session's tokens
                _event("message.part.updated", "ses_A"),  # a stored update, not a token
                _event("message.part.delta", "ses_A"),
            ]
        ]
    )
    counter = DeltaCounter(url, "ses_A")
    try:
        assert _until(lambda: counter.count() == 2)
        time.sleep(0.2)
        assert counter.count() == 2
    finally:
        counter.close()
        server.shutdown()


def test_keeps_counting_across_a_dropped_stream():
    server, handler, url = _serve(
        [
            [_event("message.part.delta", "ses_A")],
            [
                _event("message.part.delta", "ses_A"),
                _event("message.part.delta", "ses_A"),
            ],
        ]
    )
    counter = DeltaCounter(url, "ses_A")
    try:
        assert _until(lambda: counter.count() == 3), (
            "the count must survive a reconnect"
        )
        assert handler.served >= 2
    finally:
        counter.close()
        server.shutdown()


def test_an_unopenable_stream_fails_loud():
    # Without the stream every long thought reads as a stall again; that must
    # never happen silently.
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    with pytest.raises(ServeClientError):
        DeltaCounter(f"http://127.0.0.1:{port}/event", "ses_A")


def test_close_stops_the_reader():
    server, _, url = _serve([])
    counter = DeltaCounter(url, "ses_A")
    try:
        counter.close()
        assert _until(lambda: not counter._thread.is_alive(), timeout_s=3.0)
    finally:
        server.shutdown()
