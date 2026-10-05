from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import textwrap
from typing import Any

import pytest

import harness.adapters.challenge as challenge_mod
from harness.adapters.challenge import (
    REASON_TOOL_CALL_TIMEOUT,
    TURN_TERMINAL_STALLED,
    ChallengeRunner,
    _OpencodeRunStats,
)
from harness.adapters.docker_worker import ImageFingerprint
from harness.adapters.challenge.constants import _REGRESSION_HEADER
from harness.adapters.challenge.runner import _FIRST_MESSAGE_PREAMBLE


def _told(checks):
    """What the runner records as told for each check (runner.py told_first_label)."""
    from harness.adapters.challenge import ChallengeRunner as _R

    return {
        c: _R._told_label({"check": c}, pass_kind="first")[0]
        for c in checks
        if not _R._is_harness_infra_check(c)
    }


TASK_DIR = (Path(__file__).resolve().parents[1] / "task" / "backgammon").resolve()

# A real graded gate check (a bracket token that HAS a feedback override). The
# single-system feedback contract hard-fails on synthetic labels, so loop
# mechanics tests must drive the cell with genuine gate ids.
REAL_CHECK = "[G02] REQ-PIP — pip count"
REAL_PASS1 = "[G01] REQ-INIT — initial position"
REAL_PASS2 = "[G03] REQ-DICE — dice to moves"


def _make_runner(
    tmp_path: Path,
    *,
    cost_limit_usd: float | None = None,
    max_attempts: int = 8,
    max_output_tokens: int | None = None,
    max_steps_per_attempt: int | None = None,
    output_price_per_1m: float | None = None,
    mock: str | None = None,
    progress: Any = None,
) -> ChallengeRunner:
    return ChallengeRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model="local-llm-proxy/okp-bench-worker",
        cost_limit_usd=cost_limit_usd,
        max_attempts=max_attempts,
        max_output_tokens=max_output_tokens,
        max_steps_per_attempt=max_steps_per_attempt,
        output_price_per_1m=output_price_per_1m,
        mock=mock,
        progress=progress,
    )


def _stats(
    *,
    session_id: str | None = "sess-1",
    killed_reason: str | None = None,
    exit_code: int | None = 0,
    cost_usd: float = 0.0,
    budget_stop_detected: bool = False,
    budget_stop_signature: str | None = None,
    terminal_zero_tool_turn: bool = False,
    turn_anomalies: tuple[dict[str, Any], ...] = (),
) -> _OpencodeRunStats:
    return _OpencodeRunStats(
        input_tokens=10,
        output_tokens=20,
        reasoning_tokens=5,
        turns=1,
        session_id=session_id,
        killed_reason=killed_reason,
        exit_code=exit_code,
        cost_usd=cost_usd,
        budget_stop_detected=budget_stop_detected,
        budget_stop_signature=budget_stop_signature,
        terminal_zero_tool_turn=terminal_zero_tool_turn,
        turn_anomalies=turn_anomalies,
    )


def _patch_fake_docker(monkeypatch: pytest.MonkeyPatch) -> dict[str, int]:
    state: dict[str, int] = {
        "force_kill_calls": 0,
        "process_kill_calls": 0,
        "container_removed": 0,
    }

    class _FakeDockerCellConfig:
        def __init__(
            self,
            *,
            worktree: Path,
            memory_mode: str,
            container_name: str,
            output_token_max: int | None = None,
        ) -> None:
            self.worktree = worktree
            self.memory_mode = memory_mode
            self.container_name = container_name
            self.output_token_max = output_token_max

    class _FakeDockerCell:
        def __init__(self, config: _FakeDockerCellConfig, progress: Any) -> None:
            self.config = config
            self.progress = progress
            # Mirrors the real DockerCell surface (docker_worker.py sets
            # self.container_name = config.container_name at construction).
            self.container_name = config.container_name

        def __enter__(self) -> "_FakeDockerCell":
            return self

        def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
            return False

        def exec_argv(self, inner: list[str]) -> list[str]:
            return [sys.executable, "-c", "print('fake')", *inner]

        def force_kill(self) -> None:
            state["force_kill_calls"] += 1
            state["container_removed"] = 1

        def kill_worker_processes(self) -> None:
            state["process_kill_calls"] += 1

        def start_serve(self) -> None:
            # Live-view serve is a no-op in tests: never start a real `opencode
            # serve`. The session itself is served by the in-memory stub below.
            pass

    monkeypatch.setattr(challenge_mod, "DockerCellConfig", _FakeDockerCellConfig)
    monkeypatch.setattr(challenge_mod, "DockerCell", _FakeDockerCell)
    monkeypatch.setattr(challenge_mod, "docker_available", lambda: (True, "ok"))
    monkeypatch.setattr(
        challenge_mod,
        "worker_image_fingerprint",
        lambda: ImageFingerprint(
            image_id="sha256:fake-test-worker",
            created="2026-07-31T01:25:11Z",
        ),
    )

    real_run = challenge_mod.subprocess.run

    def _run(*args: Any, **kwargs: Any) -> subprocess.CompletedProcess[str]:
        cmd = args[0] if args else kwargs.get("args")
        if isinstance(cmd, list) and cmd and cmd[0] == "docker":
            return subprocess.CompletedProcess(
                cmd, 1, stdout="", stderr="No such container"
            )
        return real_run(*args, **kwargs)

    monkeypatch.setattr(challenge_mod.subprocess, "run", _run)

    # Hermetic serve stub. `_run_cell_impl` constructs a real ServeClient and
    # calls create_session() against 127.0.0.1:<serve_host_port>; this stands in
    # so no HTTP is attempted.
    #
    # IT SUCCEEDS, AND IT HAS TO. This stub used to fail closed, which sent
    # every one of these tests down the stdout fallback — so they exercised a
    # path production has not taken since serve became the transport, and they
    # would have kept passing after that path stopped being reachable at all.
    # A failed create_session is now a scored-cell abort, and the behaviour
    # these tests are actually about (prompt ordering, pass-verdict injection,
    # sidecar fidelity, kill accounting) lives above the transport.
    class _FakeServeClient:
        def __init__(self, base_url: str, **kwargs: Any) -> None:
            self.base_url = base_url

        def create_session(self, title: str | None = None) -> str:
            return "ses_hermetic"

        def get_messages(self, session_id: str) -> list[dict[str, Any]]:
            return []

        def assistant_texts_since(self, session_id: str, watermark: int) -> list[str]:
            # Every chunk closes cleanly: the marker gate has its own tests, and
            # nudging here would add turns these tests count.
            return [challenge_mod.CHUNK_MARKER]

    monkeypatch.setattr(challenge_mod, "ServeClient", _FakeServeClient)
    return state


def test_prompts_are_delivered_over_the_serve_session_never_on_argv(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Every prompt reaches the model as a serve-session message.

    The original form of this test asserted that the prompt never appeared as a
    positional argument on the `opencode run` argv. That argv no longer exists:
    serve is the only transport, so a prompt has no way to reach a command line.
    What is still worth pinning is the delivery itself — the initial task prompt
    and the repair feedback both arrive, in order, as session prompts."""
    runner = _make_runner(tmp_path, cost_limit_usd=None, max_attempts=3)
    _patch_fake_docker(monkeypatch)

    task_prompt = "D6 initial prompt marker"
    monkeypatch.setattr(
        runner, "_load_chunk_prompts", lambda *args, **kwargs: [task_prompt]
    )

    gate_calls = {"count": 0}

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        gate_calls["count"] += 1
        if gate_calls["count"] == 1:
            return {
                "verdict": "FAIL",
                "conformed": True,
                "problems": [{"check": REAL_CHECK}],
                "failed_gates": [REAL_CHECK],
            }
        return {
            "verdict": "PASS",
            "conformed": True,
            "problems": [],
            "failed_gates": [],
        }

    monkeypatch.setattr(runner, "_run_gate_report", _fake_gate)

    delivered: list[str | None] = []

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        delivered.append(kwargs.get("prompt"))
        return _stats(session_id="sess-1", exit_code=0, cost_usd=0.0)

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)

    result = runner._run_cell_impl(
        run_label="prompt-delivery",
        run_dir=tmp_path / "prompt-delivery",
        task_id="backgammon",
    )

    assert result.verdict == "PASS"
    feedback_prompt = runner._build_feedback_prompt(checks=[REAL_CHECK])
    assert delivered == [task_prompt, f"{_FIRST_MESSAGE_PREAMBLE}\n\n{feedback_prompt}"]


def test_feedback_gap_folds_pass_verdict_into_failure_feedback_with_sidecar_fidelity(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    runner = _make_runner(tmp_path, cost_limit_usd=None, max_attempts=4)
    _patch_fake_docker(monkeypatch)
    monkeypatch.setattr(
        runner, "_load_chunk_prompts", lambda *args, **kwargs: ["INITIAL PROMPT"]
    )

    gate_calls = {"count": 0}

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        gate_calls["count"] += 1
        if gate_calls["count"] == 1:
            # PLAYER ORDER: G01 and G02 are stage 1 (the first look), G03 is
            # stage 2 (rolling and moving) — so round 1 tells the model
            # about G01 and G02 only, and G03 is withheld.
            return {
                "verdict": "FAIL",
                "conformed": True,
                "problems": [
                    {"check": REAL_PASS1},
                    {"check": REAL_CHECK},
                    {"check": REAL_PASS2},
                ],
                "failed_gates": [REAL_PASS1, REAL_CHECK, REAL_PASS2],
            }
        if gate_calls["count"] == 2:
            return {
                "verdict": "FAIL",
                "conformed": True,
                "problems": [{"check": REAL_CHECK}],
                "failed_gates": [REAL_CHECK],
            }
        if gate_calls["count"] == 3:
            return {
                "verdict": "FAIL",
                "conformed": True,
                "problems": [{"check": REAL_CHECK}],
                "failed_gates": [REAL_CHECK],
            }
        if gate_calls["count"] == 4:
            return {
                "verdict": "PASS",
                "conformed": True,
                "problems": [],
                "failed_gates": [],
            }
        return {
            "verdict": "PASS",
            "conformed": True,
            "problems": [],
            "failed_gates": [],
        }

    monkeypatch.setattr(runner, "_run_gate_report", _fake_gate)

    calls: list[dict[str, Any]] = []

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        calls.append({"phase": kwargs.get("phase"), "prompt": kwargs.get("prompt")})
        return _stats(
            session_id="sess-1",
            exit_code=0,
            cost_usd=0.0,
            terminal_zero_tool_turn=False,
        )

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)
    # The fake model edits nothing, but this test is about a model that did fix
    # things between rounds: give each graded round its own code fingerprint so
    # the "you didn't change any code" line (tests/test_no_change_round.py)
    # stays out of it.
    hashes = iter(f"hash-{n}" for n in range(100))
    monkeypatch.setattr(
        "harness.adapters.challenge.runner._snapshot_state_hash",
        lambda _worktree: next(hashes),
    )

    result = runner._run_cell_impl(
        run_label="feedback-gap-pass-verdict",
        run_dir=tmp_path / "feedback-gap-pass-verdict",
        task_id="backgammon",
    )

    assert result.verdict == "PASS"
    # 4 calls: initial + feedback-1 + feedback-2 + feedback-3 — ONE prompt per
    # round (WO-FEEDBACK-ONEPHASE). The attempt-2 pass verdict rides INSIDE
    # feedback-2; there is no separate verdict-pass-2 prompt any more.
    # Gate [G02] B keeps failing until attempt 4, so there's an extra feedback round
    assert len(calls) == 4

    # WO-FEEDBACK-VOICE-3: grader tokens are stripped from delivered text. The
    # pass verdict names the human symptom sentences of the newly-passing gates.
    # PLAYER ORDER: only a check the model was TOLD about can be reported fixed.
    # REAL_PASS2 (G03, stage 2) was withheld in round 1, so its passing is not
    # news to the model and is not named.
    pass_verdict = runner._build_pass_verdict(
        newly_passing=[REAL_PASS1], told=_told([REAL_PASS1])
    )
    # REAL_CHECK failed in BOTH of the last two attempts, so it is a repeat and
    # renders as that gate's second-sighting line — the gradient, per gate.
    failure_feedback = runner._build_feedback_prompt(
        checks=[REAL_CHECK],
        repeat_complaints={REAL_CHECK},
    )
    assert (
        "I've checked your resolution for the problems that were given before, "
        "played the game in full again, and I'm still seeing these problems:"
        in failure_feedback
    )

    phases = [entry["phase"] for entry in calls]
    prompt_texts = [entry["prompt"] for entry in calls]
    # `initial-chunk-1`, not `initial`: the build is driven chunk by chunk over
    # the serve session, one phase per chunk prompt.
    assert phases == [
        "initial-chunk-1",
        "feedback-1",
        "feedback-2",
        "feedback-3",
    ]

    # Verify the initial prompt is correct
    assert prompt_texts[0] == "INITIAL PROMPT"
    # Feedback 1 — the player's FIRST report, so the first-pass opener. Nothing
    # newly passed after attempt 1, so no pass verdict rides along.
    assert prompt_texts[
        1
    ] == f"{_FIRST_MESSAGE_PREAMBLE}\n\n" + runner._build_feedback_prompt(
        checks=[REAL_PASS1, REAL_CHECK]
    )
    assert runner._humanize_check(REAL_PASS2) not in prompt_texts[1], (
        "a stage-2 problem is withheld while stage 1 still fails"
    )
    # Feedback 2 — the FOLDED message (WO-FEEDBACK-ONEPHASE): REAL_PASS1 and
    # REAL_PASS2 newly passed after attempt 2, so the pass verdict opens the
    # single round message and the failure report follows it. The failure part
    # is a re-report: the model has already been given a list, so the opener
    # refers back to it (this is keyed on prior feedback, NOT on whether
    # anything newly passed).
    assert calls[2]["prompt"] == f"{pass_verdict}\n\n{failure_feedback}"
    # ONE message carries BOTH voices: the pass-verdict opener AND the
    # still-failing content.
    assert "That fixed it —" in calls[2]["prompt"]
    assert (
        "I've checked your resolution for the problems that were given before, "
        "played the game in full again, and I'm still seeing these problems:"
        in calls[2]["prompt"]
    )
    # Feedback 3 — nothing newly passed after attempt 3, so the round message is
    # the failure report alone (same inputs as feedback-2's failure part).
    assert prompt_texts[3] == failure_feedback

    sidecar_path = Path(f"{result.worktree}.user-events.jsonl")
    sidecar_rows = [
        json.loads(line)
        for line in sidecar_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    # 4 rows: attempt 1 (initial), attempt 2 (feedback-1), attempt 3 (folded
    # feedback-2), attempt 4 (feedback-3). No separate pass-verdict row —
    # WO-FEEDBACK-ONEPHASE records ONE prompt per round.
    assert len(sidecar_rows) == 4
    assert not any(row["kind"] == "pass_verdict" for row in sidecar_rows)
    assert sidecar_rows[0]["text"] == "INITIAL PROMPT"
    assert sidecar_rows[1]["attempt"] == 2  # feedback-1
    # The attempt-2 round's row carries the FOLDED message, byte-exact.
    assert sidecar_rows[2]["text"] == f"{pass_verdict}\n\n{failure_feedback}"

    assert [row["text"] for row in sidecar_rows] == prompt_texts


def test_zero_progress_gap_has_no_pass_verdict_and_uses_false_header(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    runner = _make_runner(tmp_path, cost_limit_usd=None, max_attempts=3)
    _patch_fake_docker(monkeypatch)
    monkeypatch.setattr(
        runner, "_load_chunk_prompts", lambda *args, **kwargs: ["INITIAL PROMPT"]
    )

    gate_calls = {"count": 0}

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        gate_calls["count"] += 1
        if gate_calls["count"] in {1, 2}:
            return {
                "verdict": "FAIL",
                "conformed": True,
                "problems": [{"check": "[G02] B"}],
                "failed_gates": ["[G02] B"],
            }
        return {
            "verdict": "PASS",
            "conformed": True,
            "problems": [],
            "failed_gates": [],
        }

    monkeypatch.setattr(runner, "_run_gate_report", _fake_gate)

    calls: list[dict[str, Any]] = []

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        calls.append({"phase": kwargs.get("phase"), "prompt": kwargs.get("prompt")})
        return _stats(
            session_id="sess-1",
            exit_code=0,
            cost_usd=0.0,
            terminal_zero_tool_turn=False,
        )

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)

    result = runner._run_cell_impl(
        run_label="feedback-gap-zero-progress",
        run_dir=tmp_path / "feedback-gap-zero-progress",
        task_id="backgammon",
    )

    assert result.verdict == "PASS"

    phases = [entry["phase"] for entry in calls]
    # 3 calls: initial + feedback-1 (no pass verdict because gates never improve) + feedback-2
    assert phases == ["initial-chunk-1", "feedback-1", "feedback-2"]

    # Verify no pass verdict was injected (zero progress = no newly passing gates)
    for phase in phases:
        assert not phase.startswith("verdict-pass")

    sidecar_path = Path(f"{result.worktree}.user-events.jsonl")
    sidecar_rows = [
        json.loads(line)
        for line in sidecar_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    # 3 rows: initial + feedback-1 + feedback-2
    assert len(sidecar_rows) == 3
    assert sidecar_rows[0]["text"] == "INITIAL PROMPT"


def test_a_complaint_that_was_fixed_and_came_back_is_not_still_there(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Run 1790357047: the off tray was told, then "That fixed it", then the
    # model undid its own fix — and was told the tray was "still" over the
    # points. A complaint is a repeat only if it failed in every grade since it
    # was told; one that came back is a REGRESSION — told under its own opener,
    # never "still". The complaint that never went away keeps its
    # second-sighting line under "I'm still seeing these problems".
    runner = _make_runner(tmp_path, cost_limit_usd=None, max_attempts=4)
    _patch_fake_docker(monkeypatch)
    monkeypatch.setattr(
        runner, "_load_chunk_prompts", lambda *args, **kwargs: ["INITIAL PROMPT"]
    )
    # Both stage 1: CAME_BACK is told, fixed while STAYS is told, then returns.
    came_back, stays = REAL_CHECK, REAL_PASS1
    rounds = iter([[came_back], [stays], [came_back, stays]])

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        checks = next(rounds, [])
        return {
            "verdict": "FAIL" if checks else "PASS",
            "conformed": True,
            "problems": [{"check": c} for c in checks],
            "failed_gates": checks,
        }

    monkeypatch.setattr(runner, "_run_gate_report", _fake_gate)
    calls: list[dict[str, Any]] = []

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        calls.append({"phase": kwargs.get("phase"), "prompt": kwargs.get("prompt")})
        return _stats(
            session_id="sess-1",
            exit_code=0,
            cost_usd=0.0,
            terminal_zero_tool_turn=False,
        )

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)
    hashes = iter(f"hash-{n}" for n in range(100))
    monkeypatch.setattr(
        "harness.adapters.challenge.runner._snapshot_state_hash",
        lambda _worktree: next(hashes),
    )

    runner._run_cell_impl(
        run_label="complaint-came-back",
        run_dir=tmp_path / "complaint-came-back",
        task_id="backgammon",
    )

    third = calls[3]["prompt"]
    first_line = runner._humanize_check(came_back)
    still_line = runner._told_label({"check": came_back}, pass_kind="repeat")[0]
    assert first_line in third and still_line not in third, (
        "the returning complaint is a first sighting"
    )
    assert runner._told_label({"check": stays}, pass_kind="repeat")[0] in third, (
        "the complaint that never went away keeps its second-sighting line"
    )
    assert _REGRESSION_HEADER in third, (
        "the returning complaint is told as a regression"
    )
    assert "I'm still seeing these problems" in third, (
        "the complaint that never went away is still headed 'still'"
    )


@pytest.mark.parametrize(
    ("conformed", "expected_attempts_to_green"),
    [
        (True, "FAIL"),
        (False, "DID_NOT_CONFORM"),
    ],
)
def test_hard_attempt_ceiling_sets_fail_termination_label(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    conformed: bool,
    expected_attempts_to_green: str,
) -> None:
    runner = _make_runner(tmp_path, mock="scaffold", max_attempts=2)

    monkeypatch.setattr(
        runner,
        "_run_gate_report",
        lambda **kwargs: {
            "verdict": "FAIL",
            "conformed": conformed,
            "problems": [{"check": "[G02] REQ-PIP — pip count"}],
            "failed_gates": ["[G02] REQ-PIP — pip count"],
        },
    )

    result = runner._run_cell_impl(
        run_label="ceiling",
        run_dir=tmp_path / "ceiling",
        task_id="backgammon",
    )

    assert result.verdict == "FAIL"
    assert result.termination_reason == "attempt_ceiling_reached"
    assert result.attempts_to_green == expected_attempts_to_green
    assert result.attempt_reports[-1]["termination_reason"] == "attempt_ceiling_reached"
    assert result.attempt_reports[-1]["parity_pending"] is True
    assert all(ar["parity_pending"] is True for ar in result.attempt_reports)


def test_harness_limit_kill_does_not_force_budget_stop_and_loop_can_continue(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A harness-limit kill does not force a budget_stop; the loop continues.

    The kill now lands on a FEEDBACK round, not the build: per the 2026-09-08
    ruling (WO-ABORT) a partial build fast-fails with ``IncompleteBuildError``
    and is never graded, so the build here completes cleanly. ``max_attempts=3``
    so the feedback kill's ``worker_killed_reason`` actually reaches the
    ``continue_if_budget`` branch on the NEXT loop iteration — with
    ``max_attempts=2`` the attempt-2 gate PASS would short-circuit before it.
    """
    runner = _make_runner(tmp_path, cost_limit_usd=None, max_attempts=3)
    docker_state = _patch_fake_docker(monkeypatch)
    monkeypatch.setattr(
        runner, "_load_chunk_prompts", lambda *args, **kwargs: ["PROMPT"]
    )

    gate_calls = {"count": 0}

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        gate_calls["count"] += 1
        if gate_calls["count"] in {1, 2}:
            return {
                "verdict": "FAIL",
                "conformed": True,
                "problems": [{"check": REAL_CHECK}],
                "failed_gates": [REAL_CHECK],
            }
        return {
            "verdict": "PASS",
            "conformed": True,
            "problems": [],
            "failed_gates": [],
        }

    monkeypatch.setattr(runner, "_run_gate_report", _fake_gate)

    opencode_calls = {"count": 0}

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        opencode_calls["count"] += 1
        if opencode_calls["count"] == 1:
            # The build chunk completes cleanly (the fake ServeClient reports
            # the CHUNK_MARKER), so the WO-ABORT guard sees a complete build.
            return _stats(
                session_id="sess-1", killed_reason=None, exit_code=0, cost_usd=0.4
            )
        if opencode_calls["count"] == 2:
            # Feedback round 1 takes the harness-limit kill. The feedback drive
            # passes the same kill_hook (backgammon.py:3417 -> _run_cell_attempt).
            kill_hook = kwargs.get("kill_hook")
            assert callable(kill_hook)
            kill_hook()
            return _stats(
                session_id="sess-1",
                killed_reason="run_timeout",
                exit_code=137,
                cost_usd=0.1,
            )
        return _stats(
            session_id="sess-1", killed_reason=None, exit_code=0, cost_usd=0.1
        )

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)

    result = runner._run_cell_impl(
        run_label="harness-limit-continue",
        run_dir=tmp_path / "harness-limit-continue",
        task_id="backgammon",
    )

    assert result.verdict == "PASS"
    assert result.termination_reason == "gates_green"
    # Gate PASSes on attempt 3 (FAIL, FAIL, PASS), so two feedback rounds rode.
    assert result.attempts_to_green == 2
    assert docker_state["process_kill_calls"] == 1
    assert docker_state["force_kill_calls"] == 0


def test_stalled_feedback_turn_increments_cell_stalled_turns_exactly_once(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """WO-ERRDATA-C5: a watchdog-killed turn lands on the cell result.

    ``stalled_turns`` is recomputed from the anomaly ledger — records whose
    ``terminal == "turn_stalled"``. WO-21 made a stall leave ``killed_reason``
    and ``exit_code`` clean and record a ``turn_stalled`` anomaly instead, so
    one stalled turn must increment it exactly once — and the cell must still
    complete: ``turn_stalled`` is a harness-limit reason, not a harness error,
    so the loop continues to the next gate.

    The stalled turn now lands on a FEEDBACK round. A stalled BUILD aborts
    with ``IncompleteBuildError`` per the 2026-09-08 ruling (WO-ABORT) — a
    partial build is never graded — so the build here completes cleanly.
    """
    runner = _make_runner(tmp_path, cost_limit_usd=None, max_attempts=2)
    _patch_fake_docker(monkeypatch)
    monkeypatch.setattr(
        runner, "_load_chunk_prompts", lambda *args, **kwargs: ["INITIAL PROMPT"]
    )

    gate_calls = {"count": 0}

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        gate_calls["count"] += 1
        if gate_calls["count"] == 1:
            return {
                "verdict": "FAIL",
                "conformed": True,
                "problems": [{"check": REAL_CHECK}],
                "failed_gates": [REAL_CHECK],
            }
        return {
            "verdict": "PASS",
            "conformed": True,
            "problems": [],
            "failed_gates": [],
        }

    monkeypatch.setattr(runner, "_run_gate_report", _fake_gate)

    opencode_calls = {"count": 0}

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        opencode_calls["count"] += 1
        if opencode_calls["count"] == 1:
            # The build completes cleanly (the fake ServeClient reports the
            # CHUNK_MARKER), so the WO-ABORT guard sees a complete build.
            return _stats(
                session_id="sess-1", killed_reason=None, exit_code=0, cost_usd=0.0
            )
        # The feedback round stalls. WO-21: a stall leaves killed_reason and
        # exit_code clean (the recovery gate requires it) and is recorded as a
        # turn_stalled anomaly; stalled_turns is recomputed from that ledger.
        return _stats(
            session_id="sess-1",
            cost_usd=0.0,
            turn_anomalies=(
                {
                    "terminal": TURN_TERMINAL_STALLED,
                    "reason": REASON_TOOL_CALL_TIMEOUT,
                },
            ),
        )

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)

    result = runner._run_cell_impl(
        run_label="stall-count",
        run_dir=tmp_path / "stall-count",
        task_id="backgammon",
    )

    # The stall was delivered on the feedback round only; the build ran clean.
    assert result.stalled_turns == 1
    # The cell still completed cleanly — a stall is a harness limit, not an error.
    assert result.verdict == "PASS"
    assert result.termination_reason == "gates_green"


@pytest.mark.slow
def test_non_budget_nonzero_worker_exit_classifies_as_harness_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    runner = _make_runner(tmp_path, cost_limit_usd=None, max_attempts=2)
    _patch_fake_docker(monkeypatch)
    monkeypatch.setattr(
        runner, "_load_chunk_prompts", lambda *args, **kwargs: ["PROMPT"]
    )
    monkeypatch.setattr(
        runner,
        "_run_opencode_serve",
        lambda **kwargs: _stats(
            session_id="sess-1",
            killed_reason=None,
            exit_code=1,
            cost_usd=0.0,
            budget_stop_detected=False,
            terminal_zero_tool_turn=False,
        ),
    )
    monkeypatch.setattr(
        runner,
        "_run_gate_report",
        lambda **kwargs: {
            "verdict": "FAIL",
            "conformed": True,
            "problems": [{"check": "[G02] REQ-PIP — pip count"}],
            "failed_gates": ["[G02] REQ-PIP — pip count"],
        },
    )

    result = runner._run_cell_impl(
        run_label="harness-error",
        run_dir=tmp_path / "harness-error",
        task_id="backgammon",
    )

    assert result.verdict == "FAIL"
    assert result.termination_reason == "harness_error"
    assert result.attempts_to_green == "FAIL"
    assert result.attempt_reports == []


# ── ONE TRANSPORT: THE TWO ABORTS THAT REPLACED THE SILENT SWAPS ────────────
#
# Both of these used to be survivable, and that was the defect. A cell that
# quietly re-ran its work by another method produced numbers on a different
# scale under the same name, and the only evidence was a PROGRESS line nobody
# was watching. These pin the aborts so the fallbacks cannot creep back.


def test_serve_session_create_failure_aborts_the_cell(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """No session at cell start => no cell.

    This used to leave `_cell_session_id` as None and run the ENTIRE cell on the
    stdout subprocess path — a cell that never touched the transport every other
    cell in the campaign used, sitting in the ledger looking identical to them.
    """
    runner = _make_runner(tmp_path, cost_limit_usd=None, max_attempts=2)
    _patch_fake_docker(monkeypatch)
    monkeypatch.setattr(
        runner, "_load_chunk_prompts", lambda *args, **kwargs: ["PROMPT"]
    )

    class _DeadServeClient:
        def __init__(self, base_url: str, **kwargs: Any) -> None:
            self.base_url = base_url

        def create_session(self, title: str | None = None) -> str:
            raise challenge_mod.ServeClientError("connection refused")

    monkeypatch.setattr(challenge_mod, "ServeClient", _DeadServeClient)

    with pytest.raises(challenge_mod.ServeTransportError) as excinfo:
        runner._run_cell_impl(
            run_label="no-session",
            run_dir=tmp_path / "no-session",
            task_id="backgammon",
        )

    assert "one transport" in str(excinfo.value)


def test_chunked_build_failure_aborts_and_never_reruns_as_one_joined_prompt(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A build that dies on the transport ABORTS.

    Historically this also pinned that the build must not restart as a single
    joined six-chunk prompt on the stdout path — that salvage erased the chunk
    boundaries (where the marker gate fires and where compaction happens), so
    the rescued cell measured a different experiment while reporting under the
    same name. The stdout transport is purged (2026-09-03), so the guarantee
    is now structural: there is no second route to restart on.
    """
    runner = _make_runner(tmp_path, cost_limit_usd=None, max_attempts=2)
    _patch_fake_docker(monkeypatch)
    monkeypatch.setattr(
        runner,
        "_load_chunk_prompts",
        lambda *args, **kwargs: ["CHUNK ONE", "CHUNK TWO"],
    )

    def _die(**kwargs: Any) -> _OpencodeRunStats:
        raise RuntimeError("transport died mid-build")

    monkeypatch.setattr(runner, "_run_opencode_serve", _die)

    with pytest.raises(challenge_mod.ServeTransportError) as excinfo:
        runner._run_cell_impl(
            run_label="build-died",
            run_dir=tmp_path / "build-died",
            task_id="backgammon",
        )

    assert "transport died mid-build" in str(excinfo.value)


def test_partial_chunked_build_aborts_with_incomplete_build_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """WO-ABORT: a build that does not deliver every chunk aborts, never graded.

    Chunk 2 stalls (``turn_stalled`` — a HARNESS-LIMIT reason, so no recovery
    branch claims it) and the chunked driver early-returns: chunk 3 is never
    sent. The cell must raise IncompleteBuildError (whole-run abort), never
    reach the grader, and record the abort as a harness_error on the cell.end
    live record.
    """
    runner = _make_runner(tmp_path, cost_limit_usd=None, max_attempts=2)
    _patch_fake_docker(monkeypatch)
    monkeypatch.setattr(
        runner,
        "_load_chunk_prompts",
        lambda *args, **kwargs: ["CHUNK ONE", "CHUNK TWO", "CHUNK THREE"],
    )

    opencode_calls = {"count": 0}

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        opencode_calls["count"] += 1
        if opencode_calls["count"] == 1:
            # Chunk 1 completes cleanly (marker lands via the fake ServeClient).
            return _stats(
                session_id="sess-1", killed_reason=None, exit_code=0, cost_usd=0.1
            )
        # Chunk 2 stalls: harness-limit kill, no marker -> state "died".
        return _stats(
            session_id="sess-1", killed_reason="turn_stalled", exit_code=1, cost_usd=0.1
        )

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)

    gate_calls = {"count": 0}

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        gate_calls["count"] += 1
        raise AssertionError("grader must never run on an incomplete build")

    monkeypatch.setattr(runner, "_run_gate_report", _fake_gate)

    run_dir = tmp_path / "rundir"
    monkeypatch.setenv("BENCH_RUNS_DIR", str(tmp_path))

    with pytest.raises(challenge_mod.IncompleteBuildError) as excinfo:
        runner.run_cell("incomplete-build", run_dir, task_id="backgammon")

    # Chunk 3 was never sent (driver early-returned after chunk 2 died).
    assert opencode_calls["count"] == 2
    # The grader never ran.
    assert gate_calls["count"] == 0
    # The message names the dead and not-reached chunks.
    msg = str(excinfo.value)
    assert "chunk 2 died" in msg
    assert "chunk 3 not_reached" in msg

    # The abort is recorded as a harness error on the cell.end live record.
    rows = [
        json.loads(line)
        for line in (run_dir / "live.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    cell_end = [row for row in rows if row.get("kind") == "cell.end"]
    assert cell_end, "expected a cell.end record"
    assert cell_end[-1]["terminal_reason"] == "harness_error"
    assert cell_end[-1]["terminal_exception"] == "IncompleteBuildError"
