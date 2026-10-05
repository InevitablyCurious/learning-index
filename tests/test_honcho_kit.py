"""The Honcho kit (memory-systems/honcho/): ready and cost commands, telemetry sink."""

from __future__ import annotations

import importlib.util
import json
import re
import threading
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import ModuleType

import pytest

from harness.memory_slot import ENV_MEMORY_ENV, MEMORY_URL_PLACEHOLDER, parse_settings

KIT = Path(__file__).resolve().parents[1] / "memory-systems" / "honcho"


def _load(name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        f"honcho_kit_{name}", KIT / f"{name}.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hooks = _load("hooks")
sink = _load("telemetry_sink")


@contextmanager
def _serve(handler: type[BaseHTTPRequestHandler]) -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def _json_server(routes: dict[str, dict]) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            payload = routes.get(self.path)
            body = json.dumps(payload or {"detail": "not found"}).encode()
            self.send_response(200 if payload is not None else 404)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args: object) -> None:
            pass

    return Handler


# --- the workspace -------------------------------------------------------------


def test_the_workspace_is_read_as_the_plugin_reads_it(tmp_path: Path) -> None:
    settings = tmp_path / "memory.env"
    settings.write_text("HONCHO_WORKSPACE_ID=series-2\n")
    assert hooks.workspace({ENV_MEMORY_ENV: str(settings)}) == "series-2"
    settings.write_text("HONCHO_WORKSPACE_ID=series-2\nHONCHO_WORKSPACE=wins\n")
    assert hooks.workspace({ENV_MEMORY_ENV: str(settings)}) == "wins"
    assert hooks.workspace({}) == "opencode"  # the plugin's own default


# --- ready ---------------------------------------------------------------------


QUEUE = "/v3/workspaces/series-1/queue/status"


@pytest.mark.parametrize(
    "pending,in_progress,ready",
    [(0, 0, True), (3, 0, False), (0, 1, False)],
)
def test_ready_means_nothing_pending_or_in_progress(
    pending: int, in_progress: int, ready: bool
) -> None:
    status = {
        "total_work_units": 9,
        "completed_work_units": 9 - pending - in_progress,
        "pending_work_units": pending,
        "in_progress_work_units": in_progress,
    }
    with _serve(_json_server({QUEUE: status})) as url:
        is_ready, said = hooks.queue_state(url, "series-1")
    assert is_ready is ready
    assert said == f"workspace=series-1 pending={pending} in_progress={in_progress}"


def test_ready_exits_by_the_queue_and_fails_when_honcho_is_down(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    settings = tmp_path / "memory.env"
    settings.write_text("HONCHO_WORKSPACE_ID=series-1\n")
    monkeypatch.setenv(ENV_MEMORY_ENV, str(settings))
    empty = {"pending_work_units": 0, "in_progress_work_units": 0}
    with _serve(_json_server({QUEUE: empty})) as url:
        assert hooks.main(["ready", "--api-url", url]) == 0
    assert hooks.main(["ready", "--api-url", url]) == 1  # the server is gone now
    assert "honcho ready:" in capsys.readouterr().err


# --- the telemetry sink and cost -----------------------------------------------


def _llm(purpose: str, tokens_in: int, tokens_out: int, **extra: object) -> dict:
    data = {
        "call_purpose": purpose,
        "provider_input_tokens": tokens_in,
        "provider_output_tokens": tokens_out,
        "cache_read_tokens": 0,
        "cache_creation_tokens": 0,
        "outcome": "success",
        "was_stream": False,
        **extra,
    }
    return {"specversion": "1.0", "type": "llm.call.completed", "data": data}


def _post(url: str, payload: object) -> None:
    request = urllib.request.Request(
        f"{url}/v1/events", data=json.dumps(payload).encode(), method="POST"
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        assert response.status == 200


def test_the_sink_totals_every_model_call_by_purpose() -> None:
    with _serve(sink.make_handler(sink.Totals())) as url:
        _post(url, _llm("deriver.representation", 1000, 200))  # one event
        _post(
            url,
            [  # a batch
                _llm("deriver.representation", 500, 100),
                _llm("dialectic.answer", 3000, 400),
                _llm("dialectic.answer", 0, 0, was_stream=True),
                _llm("summary.short", 10, 5, outcome="error"),
                {
                    "type": "embedding.call.completed",
                    "data": {"input_tokens_estimate": 77},
                },
                {"type": "message.created", "data": {"workspace_name": "w"}},
            ],
        )
        totals = hooks.totals(url, settle_s=0)

    assert totals["calls"] == 5
    assert totals["input_tokens"] == 4510
    assert totals["output_tokens"] == 705
    assert totals["deriver.representation.input_tokens"] == 1500
    assert totals["dialectic.answer.calls"] == 2
    assert totals["dialectic.answer.input_tokens"] == 3000
    assert totals["streamed_calls"] == 1
    assert totals["errors"] == 1
    assert totals["embedding_input_tokens"] == 77
    assert all(isinstance(v, int) for v in totals.values())


def test_a_fresh_sink_reports_zero_not_nothing() -> None:
    with _serve(sink.make_handler(sink.Totals())) as url:
        assert hooks.totals(url, settle_s=0) == {
            "calls": 0,
            "input_tokens": 0,
            "output_tokens": 0,
        }


def test_cost_prints_the_totals_as_one_json_object(
    capsys: pytest.CaptureFixture,
) -> None:
    with _serve(sink.make_handler(sink.Totals())) as url:
        _post(url, _llm("deriver.representation", 10, 2))
        assert hooks.main(["cost", "--sink-url", url, "--settle-s", "0"]) == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["input_tokens"] == 10


# --- the kit's files agree with each other and with the harness ------------------


def _env_file(name: str) -> dict[str, str]:
    return parse_settings((KIT / name).read_text())


def test_the_plugin_settings_are_valid_memory_settings() -> None:
    settings = _env_file("memory.env")  # parse_settings refuses reserved names
    assert settings["HONCHO_BASE_URL"] == MEMORY_URL_PLACEHOLDER
    assert settings["HONCHO_WORKSPACE_ID"]


def test_honcho_reports_to_the_sink_the_override_starts() -> None:
    honcho = _env_file("honcho.env")
    override = (KIT / "docker-compose.override.yml").read_text()
    published = re.search(r'"127\.0\.0\.1:(\d+):(\d+)"', override)
    command_port = re.search(r'"--port", "(\d+)"', override).group(1)
    assert honcho["TELEMETRY_ENABLED"] == "true"
    assert honcho["TELEMETRY_ENDPOINT"] == (
        f"http://telemetry-sink:{command_port}/v1/events"
    )
    assert published.group(2) == command_port
    assert hooks.DEFAULT_SINK_URL == f"http://localhost:{published.group(1)}"


def test_every_honcho_model_call_goes_to_the_same_alias() -> None:
    honcho = _env_file("honcho.env")
    models = {
        v
        for k, v in honcho.items()
        if k.endswith("MODEL_CONFIG__MODEL") and not k.startswith("EMBEDDING_")
    }
    urls = {v for k, v in honcho.items() if k.endswith("OVERRIDES__BASE_URL")}
    assert models == {"qwen3.6-35b-a3b-memory"}
    assert urls == {
        "http://host.docker.internal:4545/v1",  # the relay: every model call
        "http://host.docker.internal:1234/v1",  # the runtime: embeddings only
    }
    assert honcho["DERIVER_FLUSH_ENABLED"] == "true"
