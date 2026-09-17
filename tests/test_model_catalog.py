"""The local worker model list comes from the model proxy, never a local table."""

import pytest

from harness import model_catalog
from harness.context_budget import model_limits
from tests.conftest import PROXY_BENCH_ROWS


def test_registry_is_the_proxy_bench_rows() -> None:
    registry = model_catalog.worker_model_registry()
    bench_ids = {r["id"] for r in PROXY_BENCH_ROWS if r["purpose"] == model_catalog.BENCH_PURPOSE}
    assert set(registry) == bench_ids, "interactive aliases are never worker models"
    block = registry["deepseek-v4-flash-bench"]
    assert block["name"] == "DeepSeek V4 Flash 0731 MXFP4 via Proxy (bench)"
    assert block["limit"] == {"context": 256_512, "output": 32_768}
    assert block["modalities"] == {"input": ["text"], "output": ["text"]}
    assert block["attachment"] is False


def test_limits_follow_the_proxy(monkeypatch) -> None:
    rows = [dict(r) for r in PROXY_BENCH_ROWS]
    for r in rows:
        if r["id"] == "qwen3.6-35b-a3b-bench":
            r["context_length"] = 131_072
    monkeypatch.setattr(model_catalog, "fetch_proxy_models", lambda *a, **k: rows)
    model_catalog.worker_model_registry.cache_clear()
    assert model_limits("local-llm-proxy/qwen3.6-35b-a3b-bench") == {"context": 131_072, "output": 32_768}


def test_proxy_down_is_a_hard_error(monkeypatch) -> None:
    def down(*_a, **_k):
        raise model_catalog.ModelCatalogUnavailable("cannot read the local model list")

    monkeypatch.setattr(model_catalog, "fetch_proxy_models", down)
    model_catalog.worker_model_registry.cache_clear()
    with pytest.raises(model_catalog.ModelCatalogUnavailable):
        model_limits("local-llm-proxy/qwen3.6-35b-a3b-bench")


def test_row_without_limits_is_refused() -> None:
    with pytest.raises(model_catalog.ModelCatalogUnavailable):
        model_catalog.build_registry([{"id": "x-bench", "purpose": "okp-bench"}])
