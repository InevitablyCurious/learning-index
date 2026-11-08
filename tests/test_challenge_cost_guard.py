from __future__ import annotations

import json
from pathlib import Path

from harness.adapters.challenge import ChallengeRunner
from harness.adapters.docker_worker import DockerCellConfig, _build_run_argv

TASK_DIR = (Path(__file__).resolve().parents[1] / "task" / "backgammon").resolve()


def _contains_pair(argv: list[str], left: str, right: str) -> bool:
    for idx, item in enumerate(argv[:-1]):
        if item == left and argv[idx + 1] == right:
            return True
    return False


def _make_runner(
    tmp_path: Path,
    *,
    model: str = "local-llm-proxy/kimi/kimi-k3",
    reasoning_effort: str | None = None,
    cost_limit_usd: float | None = None,
    cost_target_usd: float | None = None,
    max_output_tokens: int | None = None,
    max_steps_per_attempt: int | None = None,
    output_price_per_1m: float | None = None,
) -> ChallengeRunner:
    return ChallengeRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model=model,
        reasoning_effort=reasoning_effort,
        cost_limit_usd=cost_limit_usd,
        cost_target_usd=cost_target_usd,
        max_output_tokens=max_output_tokens,
        max_steps_per_attempt=max_steps_per_attempt,
        output_price_per_1m=output_price_per_1m,
    )


def _write_checkpoint(
    path: Path, *, hard: float, accrued: float, committed: float
) -> None:
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "run_id": "test-run",
                "model_id": "anthropic/claude-opus-4.8",
                "profile_name": "opus",
                "hard_cap_usd": hard,
                "accrued_actual_usd": accrued,
                "committed_unproven_usd": committed,
                "outstanding": {},
                "updated_at": "2026-07-22T00:00:00+00:00",
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )


def test_worker_run_argv_injects_output_token_env(tmp_path: Path) -> None:
    runner = _make_runner(tmp_path, max_output_tokens=8192)
    cfg = DockerCellConfig(
        worktree=tmp_path / "worktree",
        memory_mode="off",
        container_name="bench-cell-output-cap-check",
        output_token_max=runner.max_output_tokens,
    )
    run_argv = _build_run_argv(
        config=cfg, worktree=cfg.worktree, uid=501, gid=20, memory_mode="off"
    )

    assert _contains_pair(run_argv, "-e", "OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=8192")


def test_worker_run_argv_omits_output_token_env_when_unclamped(tmp_path: Path) -> None:
    cfg = DockerCellConfig(
        worktree=tmp_path / "worktree",
        memory_mode="off",
        container_name="bench-cell-unclamped-check",
        output_token_max=None,
    )
    run_argv = _build_run_argv(
        config=cfg, worktree=cfg.worktree, uid=501, gid=20, memory_mode="off"
    )

    assert not any(
        item.startswith("OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=") for item in run_argv
    )
