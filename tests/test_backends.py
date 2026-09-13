from __future__ import annotations

from harness.backends.base import NeedCard
from harness.config import BenchmarkSchedule, BenchmarkWave, RunConfig


def _cfg_seeded(seed: int) -> RunConfig:
    """RunConfig carrying an explicit rng_seed, matching the retired harness setup."""
    return RunConfig(
        schedule=BenchmarkSchedule(
            waves=(
                BenchmarkWave(
                    wave_id="single",
                    models=("model-x",),
                ),
            ),
        ),
        rng_seed=seed,
        mcp_recall_url="http://offline.local",
        session_token_path="/tmp/__bench_missing_token__",
    )


def test_need_card_inv6_prompt_digest_and_wire_shape() -> None:
    """Live NeedCard.prompt_digest + to_wire wire shape (repointed from retired test_integrity.py).

    Covers live behaviour used by backgammon.py — NOT the retired ablation harness machinery.
    """
    cfg = _cfg_seeded(102)
    need = NeedCard(
        intent="INTENT_TOKEN",
        task="TASK_TOKEN",
        language="python",
        stack=["STACK_TOKEN"],
        frameworks=["FW_TOKEN"],
        deps=["DEPS_TOKEN"],
        error_strings=["ERRORS_TOKEN"],
        files=["FILES_TOKEN"],
        directory="DIRECTORY_TOKEN",
        project_name="PROJECT_TOKEN",
        query="QUERY_TOKEN",
    )

    digest = need.prompt_digest
    assert digest == "INTENT_TOKEN. TASK_TOKEN"
    assert "STACK_TOKEN" not in digest
    assert "DEPS_TOKEN" not in digest
    assert "ERRORS_TOKEN" not in digest
    assert "FILES_TOKEN" not in digest
    assert "DIRECTORY_TOKEN" not in digest
    assert "PROJECT_TOKEN" not in digest

    wire = need.to_wire(cfg, session_id="session-1")
    assert "prompt_digest" not in wire
    assert wire["query"] == "QUERY_TOKEN"
    assert wire["intent"] == "INTENT_TOKEN"
    assert wire["task"] == "TASK_TOKEN"
    assert wire["stack"] == ["STACK_TOKEN"]
    assert wire["frameworks"] == ["FW_TOKEN"]
    assert wire["deps"] == ["DEPS_TOKEN"]
    assert wire["errorStrings"] == ["ERRORS_TOKEN"]
    assert wire["files"] == ["FILES_TOKEN"]
    assert wire["directory"] == "DIRECTORY_TOKEN"
    assert wire["projectName"] == "PROJECT_TOKEN"
