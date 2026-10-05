#!/usr/bin/env python3
"""Running totals of Honcho's own model use, for the benchmark's cost record.

Honcho emits one ``llm.call.completed`` telemetry event per model call it
makes — deriving memories, summarising, dreaming, answering a query — with the
call's input and output tokens, and one ``embedding.call.completed`` per
embedding batch. Pointed at this receiver (TELEMETRY_ENDPOINT in honcho.env),
it keeps the totals; ``GET /totals`` returns them as one JSON object of
numbers, the shape BENCH_MEMORY_COST_CMD prints (harness/memory_hooks.py). The
benchmark reads it before and after each memory-ON cell and records the growth.

Streamed calls report zero tokens in their event (Honcho fills them only when
the stream ends), so they are counted as ``streamed_calls`` instead of being
silently added as zero: a non-zero value means the token totals are short.

Stdlib only; runs as a service next to Honcho (docker-compose.override.yml).
Totals live in memory: a restart starts them from zero, which the benchmark
reads as a reset and records as such.
"""

from __future__ import annotations

import argparse
import json
import threading
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

_TOKEN_FIELDS = (
    ("provider_input_tokens", "input_tokens"),
    ("provider_output_tokens", "output_tokens"),
    ("cache_read_tokens", "cache_read_tokens"),
    ("cache_creation_tokens", "cache_creation_tokens"),
)


class Totals:
    """Thread-safe running totals over Honcho's telemetry events."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._totals: dict[str, int] = defaultdict(int)

    def add_events(self, events: list[Any]) -> None:
        with self._lock:
            for event in events:
                if isinstance(event, dict):
                    self._add(event)

    def _add(self, event: dict[str, Any]) -> None:
        data = event.get("data")
        if not isinstance(data, dict):
            return
        kind = event.get("type")
        if kind == "llm.call.completed":
            purpose = str(data.get("call_purpose") or "unknown")
            self._totals["calls"] += 1
            self._totals[f"{purpose}.calls"] += 1
            if data.get("outcome") == "error":
                self._totals["errors"] += 1
            if data.get("was_stream"):
                self._totals["streamed_calls"] += 1
                return
            for field, name in _TOKEN_FIELDS:
                value = _int(data.get(field))
                self._totals[name] += value
                self._totals[f"{purpose}.{name}"] += value
        elif kind == "embedding.call.completed":
            self._totals["embedding_calls"] += 1
            self._totals["embedding_input_tokens"] += _int(
                data.get("input_tokens_estimate")
            )

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            base = {"calls": 0, "input_tokens": 0, "output_tokens": 0}
            return {**base, **dict(sorted(self._totals.items()))}


def _int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def make_handler(totals: Totals) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(length) or b"null")
            except json.JSONDecodeError:
                self._reply(400, {"error": "not JSON"})
                return
            # One event (structured mode) or a batch (a JSON array).
            totals.add_events(body if isinstance(body, list) else [body])
            self._reply(200, {"ok": True})

        def do_GET(self) -> None:
            if self.path.rstrip("/") != "/totals":
                self._reply(404, {"error": "GET /totals"})
                return
            self._reply(200, totals.snapshot())

        def _reply(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args: Any) -> None:  # one line per event batch is noise
            pass

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8795)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), make_handler(Totals()))
    print(f"honcho telemetry sink listening on {args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
