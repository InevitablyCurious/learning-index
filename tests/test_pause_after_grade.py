"""WO-PAUSE-AFTER-GRADE — runner integration tests for the operator pause.

These drive `_run_cell_impl` with the same fake-docker/fake-gate/fake-serve
harness as test_challenge_budget_stop, and stub `_run_operator_pause` so no real
node server boots. They assert the loop-level contract:

  (a) the round pause happens AFTER the told lines are written and BEFORE the
      next drive;
  (b) one pause per graded pass, plus exactly one final pause — and no round
      pause on the final graded attempt;
  (c) with the flag off there is no hold and no waiting;
  (d) wall_seconds excludes paused time and paused_seconds is recorded;
  (e) a KeyboardInterrupt during a round pause ends the cell as stopped and
      cleans up.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest

import harness.adapters.challenge as challenge_mod
from harness.adapters.challenge import ChallengeRunner, _OpencodeRunStats
from harness.adapters.docker_worker import ImageFingerprint


TASK_DIR = (Path(__file__).resolve().parents[1] / "task" / "backgammon").resolve()

REAL_CHECK = "[G02] REQ-PIP — pip count"
REAL_PASS1 = "[G01] REQ-INIT — initial position"


def _make_runner(
    tmp_path: Path,
    *,
    max_attempts: int = 4,
    pause_after_grade: bool = True,
    mock: str | None = None,
    progress: Any = None,
) -> ChallengeRunner:
    return ChallengeRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        model="local-llm-proxy/okp-bench-worker",
        max_attempts=max_attempts,
        mock=mock,
        progress=progress,
        pause_after_grade=pause_after_grade,
    )


def _stats(*, session_id: str = "sess-1", exit_code: int | None = 0, cost_usd: float = 0.0, killed_reason: str | None = None, **kwargs: Any) -> _OpencodeRunStats:
    return _OpencodeRunStats(
        input_tokens=10,
        output_tokens=20,
        reasoning_tokens=5,
        turns=1,
        session_id=session_id,
        exit_code=exit_code,
        cost_usd=cost_usd,
        killed_reason=killed_reason,
        **kwargs,
    )


def _patch_fake_docker(monkeypatch: pytest.MonkeyPatch) -> None:
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
            self.container_name = config.container_name

        def __enter__(self) -> "_FakeDockerCell":
            return self

        def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
            return False

        def start_serve(self) -> None:
            pass

        def kill_worker_processes(self) -> None:
            pass

    monkeypatch.setattr(challenge_mod, "DockerCellConfig", _FakeDockerCellConfig)
    monkeypatch.setattr(challenge_mod, "DockerCell", _FakeDockerCell)
    monkeypatch.setattr(challenge_mod, "docker_available", lambda: (True, "ok"))
    monkeypatch.setattr(
        challenge_mod,
        "worker_image_fingerprint",
        lambda: ImageFingerprint(image_id="sha256:fake-test-worker", created="2026-07-31T01:25:11Z"),
    )
    real_run = challenge_mod.subprocess.run

    def _run(*args: Any, **kwargs: Any) -> subprocess.CompletedProcess[str]:
        cmd = args[0] if args else kwargs.get("args")
        if isinstance(cmd, list) and cmd and cmd[0] == "docker":
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="No such container")
        return real_run(*args, **kwargs)

    monkeypatch.setattr(challenge_mod.subprocess, "run", _run)

    class _FakeServeClient:
        def __init__(self, base_url: str, **kwargs: Any) -> None:
            self.base_url = base_url

        def create_session(self, title: str | None = None) -> str:
            return "ses_hermetic"

        def get_messages(self, session_id: str) -> list[dict[str, Any]]:
            return []

        def assistant_texts_since(self, session_id: str, watermark: int) -> list[str]:
            return [challenge_mod.CHUNK_MARKER]

    monkeypatch.setattr(challenge_mod, "ServeClient", _FakeServeClient)


def _gate_sequence(max_attempts: int):
    """A gate that FAILs the first max_attempts-1 times, then PASSes."""
    calls = {"count": 0}

    def _fake_gate(**kwargs: Any) -> dict[str, Any]:
        calls["count"] += 1
        if calls["count"] >= max_attempts:
            return {"verdict": "PASS", "conformed": True, "problems": [], "failed_gates": []}
        return {
            "verdict": "FAIL",
            "conformed": True,
            "problems": [{"check": REAL_CHECK}],
            "failed_gates": [REAL_CHECK],
        }

    return _fake_gate


def _drive(runner: ChallengeRunner, monkeypatch: pytest.MonkeyPatch, max_attempts: int):
    """Wire the fake gate + fake serve drive; return the delivered prompts."""
    monkeypatch.setattr(
        runner, "_load_chunk_prompts", lambda *args, **kwargs: ["INITIAL PROMPT"]
    )
    monkeypatch.setattr(runner, "_run_gate_report", _gate_sequence(max_attempts))
    delivered: list[str | None] = []

    def _fake_opencode(**kwargs: Any) -> _OpencodeRunStats:
        delivered.append(kwargs.get("prompt"))
        return _stats(session_id="sess-1", exit_code=0, cost_usd=0.0)

    monkeypatch.setattr(runner, "_run_opencode_serve", _fake_opencode)
    return delivered


def test_round_pause_happens_after_told_lines_and_before_next_drive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """(a) The round pause fires after the told lines are on disk (user-events
    has the feedback) and before the next drive runs."""
    runner = _make_runner(tmp_path, max_attempts=3)
    _patch_fake_docker(monkeypatch)
    delivered = _drive(runner, monkeypatch, max_attempts=3)

    run_dir = tmp_path / "run-a"
    events_path = Path(f"{run_dir}/worktree.user-events.jsonl")
    pauses: list[dict[str, Any]] = []

    def _fake_pause(**kwargs: Any) -> float:
        # Snapshot, at the moment of the pause, what is on disk and what the
        # model has been sent.
        rows = (
            [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            if events_path.exists()
            else []
        )
        feedback_rows = [r for r in rows if r.get("kind") == "feedback"]
        pauses.append(
            {
                "kind": kwargs.get("kind"),
                "attempt": kwargs.get("attempt"),
                "told_text": kwargs.get("told_text"),
                "feedback_on_disk": [r.get("text") for r in feedback_rows],
                "drives_sent": len(delivered),
            }
        )
        return 0.0

    monkeypatch.setattr(runner, "_run_operator_pause", _fake_pause)

    result = runner._run_cell_impl(
        run_label="pause-ordering",
        run_dir=run_dir,
        task_id="backgammon",
    )

    # Two round pauses (attempts 1, 2) + one final.
    assert [p["kind"] for p in pauses] == ["round", "round", "final"]
    assert [p["attempt"] for p in pauses] == [1, 2, 3]
    assert result.verdict == "PASS"

    for n, pause in enumerate(pauses[:2], start=1):
        # The told lines for grade n were already on disk ...
        assert len(pause["feedback_on_disk"]) == n, pause
        # ... and the pause shows exactly the lines about to be sent ...
        assert pause["told_text"] == pause["feedback_on_disk"][-1]
        # ... which had NOT been sent yet: only the initial drive plus the
        # n-1 earlier feedback drives had reached the model.
        assert pause["drives_sent"] == n, pause
        # The next drive carries exactly the text the operator was shown.
        assert delivered[n] == pause["told_text"]

    # The final pause comes after every drive and has nothing left to send.
    assert pauses[2]["told_text"] is None
    assert pauses[2]["drives_sent"] == 3, "initial + 2 feedback drives"


def test_one_pause_per_grade_and_exactly_one_final_pause(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """(b) No round pause on the final graded attempt; exactly one final."""
    runner = _make_runner(tmp_path, max_attempts=3)
    _patch_fake_docker(monkeypatch)
    _drive(runner, monkeypatch, max_attempts=3)

    pauses: list[tuple[str, int | None]] = []

    def _fake_pause(**kwargs: Any) -> float:
        pauses.append((kwargs.get("kind"), kwargs.get("attempt")))
        return 0.0

    monkeypatch.setattr(runner, "_run_operator_pause", _fake_pause)

    result = runner._run_cell_impl(
        run_label="one-per-grade",
        run_dir=tmp_path / "run-b",
        task_id="backgammon",
    )

    assert result.verdict == "PASS"
    assert pauses == [("round", 1), ("round", 2), ("final", 3)]


def test_flag_off_means_no_hold_and_no_wait(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """(c) With the flag off the loop never calls the pause — no hold, no wait."""
    runner = _make_runner(tmp_path, max_attempts=3, pause_after_grade=False)
    _patch_fake_docker(monkeypatch)
    _drive(runner, monkeypatch, max_attempts=3)

    pause_calls: list[Any] = []

    def _fake_pause(**kwargs: Any) -> float:
        pause_calls.append(kwargs)
        return 0.0

    monkeypatch.setattr(runner, "_run_operator_pause", _fake_pause)

    run_dir = tmp_path / "run-c"
    result = runner._run_cell_impl(
        run_label="flag-off",
        run_dir=run_dir,
        task_id="backgammon",
    )

    assert result.verdict == "PASS"
    assert pause_calls == [], "with the flag off no pause may fire"
    assert result.paused_seconds == 0.0
    assert not (run_dir / "hold-ui.json").exists(), "no hold file when flag off"


def test_wall_seconds_excludes_paused_time_and_paused_seconds_recorded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """(d) wall_seconds excludes the held time; paused_seconds records it."""
    runner = _make_runner(tmp_path, max_attempts=2)
    _patch_fake_docker(monkeypatch)
    _drive(runner, monkeypatch, max_attempts=2)

    # 2.5s per pause (one round + one final).
    def _fake_pause(**kwargs: Any) -> float:
        return 2.5

    monkeypatch.setattr(runner, "_run_operator_pause", _fake_pause)

    result = runner._run_cell_impl(
        run_label="paused-time",
        run_dir=tmp_path / "run-d",
        task_id="backgammon",
    )

    # Two pauses, 2.5s each -> 5.0s of paused time.
    assert result.paused_seconds == 5.0
    # The wall it measured was short (the fake drive is instantaneous), and it
    # is strictly less than the paused total would have inflated it to.
    assert result.wall_seconds < 5.0, (
        f"wall_seconds must exclude paused time, got {result.wall_seconds}"
    )
    # The cell could not have "run" for longer than it was paused here.
    assert result.wall_seconds < 1.0


def test_keyboard_interrupt_during_round_pause_ends_cell_as_stopped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """(e) A KeyboardInterrupt during a round pause surfaces as 'stopped'."""
    runner = _make_runner(tmp_path, max_attempts=3)
    _patch_fake_docker(monkeypatch)
    _drive(runner, monkeypatch, max_attempts=3)

    def _interrupt_pause(**kwargs: Any) -> float:
        if kwargs.get("kind") == "round":
            raise KeyboardInterrupt
        return 0.0

    monkeypatch.setattr(runner, "_run_operator_pause", _interrupt_pause)

    # `_run_cell_impl` does not swallow KeyboardInterrupt; the terminal_state
    # mapping ("stopped") happens in `run_cell`. Assert the interrupt propagates
    # so the outer run_cell can classify it as stopped.
    with pytest.raises(KeyboardInterrupt):
        runner._run_cell_impl(
            run_label="interrupt",
            run_dir=tmp_path / "run-e",
            task_id="backgammon",
        )

def test_each_pause_reports_its_own_length_boot_included(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`_run_operator_pause` times the whole hold (the artifact boot included)
    and its `pause.end` event carries THIS pause's length, not a running total."""
    import harness.adapters.challenge.runner as runner_mod

    runner = _make_runner(tmp_path, max_attempts=3)
    holds = iter([0.15, 0.05])

    def _slow_hold(**kwargs: Any) -> None:
        time.sleep(next(holds))

    monkeypatch.setattr(runner_mod, "_hold_for_operator", _slow_hold)

    events: list[tuple[str, dict[str, Any]]] = []

    class _Live:
        # Same signature as harness.live_stream.LiveStream.emit, so a field
        # named like the event's own `kind` parameter fails here as it would
        # in a real run.
        def emit(self, kind: str, **fields: Any) -> bool:
            events.append((kind, fields))
            return True

    runner._live = _Live()

    class _Cell:
        container_name = "bench-cell-test"

    common = dict(
        run_label="pause-timing",
        run_dir=tmp_path,
        worktree=tmp_path / "worktree",
        active_cell=_Cell(),
        session_id="sess-1",
        told_text=None,
        grade=None,
    )
    first = runner._run_operator_pause(kind="round", attempt=1, **common)
    second = runner._run_operator_pause(kind="final", attempt=2, **common)

    assert first >= 0.15
    assert 0.05 <= second < first, "the second pause is shorter, so not cumulative"
    ends = [fields for kind, fields in events if kind == "pause.end"]
    assert [e["held_s"] for e in ends] == [round(first, 3), round(second, 3)]
    assert [kind for kind, _ in events] == ["pause.start", "pause.end"] * 2
    assert [fields["pause_kind"] for _, fields in events] == ["round", "round", "final", "final"]
