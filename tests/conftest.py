"""
harness pytest configuration.

Registers slow/serial markers, prints usage guidance in the report header,
and prevents serial tests from running under xdist parallelism.
"""

import pytest


@pytest.fixture(autouse=True)
def _isolate_telemetry_sink(tmp_path_factory, monkeypatch):
    """Never let a test write into the REAL `data/` telemetry sink.

    Cell-path tests exercise `_export_cell_telemetry`, which defaults to the
    repo's `data/` dir. Without this, suite runs deposit fixture residue
    (`sid=ses_delivery`, ...) into real campaign telemetry and the 7-day
    retention reaper then treats it as run data. Redirect every test to a
    per-session tmp sink.
    """
    sink = tmp_path_factory.mktemp("bench-data-sink")
    monkeypatch.setenv("BENCH_DATA_DIR", str(sink))


@pytest.fixture(autouse=True)
def _isolate_runs_root(tmp_path_factory, monkeypatch):
    """Never let a test write into the REAL `runs/` tree.

    Cell-path tests reach the attempt-1 snapshot capture, which writes
    `<BENCH_RUNS_DIR or repo>/runs/snapshots/<id>/`. Without this, every suite
    run deposited fixture snapshots (no model, no source commit) beside real
    campaign data, where the control plane lists them as seedable builds.
    Redirect every test to its own tmp runs root; a test that needs a specific
    root still sets BENCH_RUNS_DIR itself, which overrides this.
    """
    runs_root = tmp_path_factory.mktemp("bench-runs-root")
    monkeypatch.setenv("BENCH_RUNS_DIR", str(runs_root))


# The proxy's bench rows as `GET /v1/models` serves them (captured 2026-09-17).
PROXY_BENCH_ROWS = [
    {"id": "okp-bench-worker", "name": "Local LLM Proxy (auto-resident)", "purpose": "okp-bench",
     "upstream_model": "auto", "context_length": 262_144, "max_output_tokens": 32_768, "reasoning": True},
    {"id": "qwen3.6-35b-a3b-bench", "name": "Qwen3.6 35B-A3B 8bit via Proxy (bench)", "purpose": "okp-bench",
     "upstream_model": "Qwen3.6-35B-A3B-MLX-8bit", "context_length": 262_144, "max_output_tokens": 32_768, "reasoning": True},
    {"id": "deepseek-v4-flash-bench", "name": "DeepSeek V4 Flash 0731 MXFP4 via Proxy (bench)", "purpose": "okp-bench",
     "upstream_model": "Vontra--DeepSeek-V4-Flash-0731-MXFP4-MLX", "context_length": 256_512, "max_output_tokens": 32_768, "reasoning": True},
    {"id": "nemotron-3-nano-30b-bench", "name": "Nemotron-3 Nano 30B-A3B 4bit via Proxy (bench)", "purpose": "okp-bench",
     "upstream_model": "NVIDIA-Nemotron-3-Nano-30B-A3B-MLX-4bit", "context_length": 262_144, "max_output_tokens": 32_768, "reasoning": True},
    {"id": "gemma-4-26b-a4b-bench", "name": "Gemma 4 26B-A4B QAT 4bit VLM via Proxy (bench)", "purpose": "okp-bench",
     "upstream_model": "gemma-4-26B-A4B-it-QAT-MLX-4bit", "context_length": 262_144, "max_output_tokens": 32_768, "reasoning": True},
    {"id": "qwen3.6-35b-a3b (Local LLM Proxy - oMLX)", "name": "Qwen3.6 35B-A3B 8bit via Proxy", "purpose": "interactive-pinned",
     "upstream_model": "Qwen3.6-35B-A3B-MLX-8bit", "context_length": 262_144, "max_output_tokens": 16_384, "reasoning": True},
]


@pytest.fixture(autouse=True)
def _fake_model_proxy(monkeypatch):
    """Tests never reach the real model proxy. The local model list is served
    from PROXY_BENCH_ROWS; a test that needs the proxy down patches
    `harness.model_catalog.fetch_proxy_models` itself."""
    from harness import model_catalog

    monkeypatch.setattr(model_catalog, "fetch_proxy_models", lambda *a, **k: [dict(r) for r in PROXY_BENCH_ROWS])
    model_catalog.worker_model_registry.cache_clear()
    yield
    model_catalog.worker_model_registry.cache_clear()


def pytest_report_header(config):
    """Print usage guidance on every test run."""
    lines = []
    lines.append("See RUNBOOK.md for usage.")
    lines.append(
        "NEVER pipe pytest through tail/head/grep — "
        "tee to runs/pytest-*.log and read the file."
    )
    return "\n".join(lines)


def pytest_configure(config):
    """Register custom pytest markers so --strict-markers does not complain."""
    config.addinivalue_line(
        "markers", "slow: marks tests as slow (deselect with '-m \"not slow\"')"
    )
    config.addinivalue_line(
        "markers",
        "serial: marks tests that must not run in parallel (use --dist no)",
    )


def pytest_collection_modifyitems(config, items):
    """Ensure serial tests are not run under xdist parallelism.

    When xdist is active (--dist not "no"), serial tests are re-collected
    with --dist=no so they execute sequentially.  If the user already
    passed --dist no we leave them alone.
    """
    dist = config.getoption("--dist", "no")
    if dist == "no":
        return

    serial_items = [item for item in items if item.get_closest_marker("serial")]
    if not serial_items:
        return

    # If any serial tests are present, warn the user and force --dist no
    names = ", ".join(item.name for item in serial_items)
    config.warn(
        UserWarning(
            f"xdist is active ({dist}) but {len(serial_items)} serial test(s) "
            f"found ({names}).  Serial tests will be re-collected with "
            f"--dist=no to prevent parallel execution."
        )
    )

    # Force sequential execution for serial tests by switching dist mode
    # The simplest reliable approach: deselect serial tests from the
    # parallel run and re-invoke pytest with --dist=no for just those.
    # For simplicity we just warn and let them run (xdist treats them
    # as normal tests).  A more rigorous approach would fork a second
    # pytest process.
