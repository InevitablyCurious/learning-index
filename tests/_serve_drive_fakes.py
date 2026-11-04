"""Shared fakes for the serve-drive test modules (WO-LI18 split).

Moved verbatim out of tests/test_challenge_serve_drive.py so the feature
split shares one fake serve client, one fake cell, one runner factory and
the canned metrics shapes. The dead ``_FakeServeClient.session_busy`` stub
was dropped in the move (zero callers); ``guard_killed_compactions_since``
stays — the harness calls it (harness/adapters/challenge/serve.py).

COMPACTION IS A HARNESS WRITE NOW, so the fake serves it as one. The harness
compacts a build session itself, after each chunk, with
``ServeClient.summarize`` — no worker plugin, no phase sentinel, no settle.
:meth:`_FakeServeClient.summarize` records the call (``summarize_calls``) and
appends the transcript shape a finished compaction actually leaves behind —
an assistant message flagged ``summary`` with a non-empty ``finish`` — which
is exactly what ``completed_compactions_since`` counts. Nothing here models a
worker-plugin fire: that component does not exist, so the fake has no flag for
one — a compaction is visible only as the ``summarize`` write above.

Not a test module: the ``_`` prefix and non-``test_`` name keep pytest
(testpaths=["tests"]) from collecting it.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from harness.adapters.challenge import ChallengeRunner
from harness.serve_client import (
    COMPACTIONS_BEFORE_GRADE_WAIT_REASON,
    LOOP_KILL_WAIT_REASON,
    extract_transcript_metrics,
    read_loop_kill_marker,
)

TASK_DIR = (Path(__file__).resolve().parents[1] / "task" / "backgammon").resolve()


class _FakeCell:
    """Stand-in for a DockerCell on the serve-drive path.

    Carries a bare ``config``. A real cell config has far more, but this path
    touches exactly one thing on it: ``worktree``, which is deliberately ABSENT
    here, so the truncation-evidence fallback to the temp dir stays exercised
    (see the evidence-path test). ``kill_worker_processes`` is the only other
    DockerCell surface the drive depends on.
    """

    def __init__(self) -> None:
        self.kill_calls = 0
        self.config = SimpleNamespace()

    def kill_worker_processes(self) -> None:
        self.kill_calls += 1


class _FakeServeClient:
    """Stub that records calls and serves canned responses."""

    def __init__(self) -> None:
        self.sent_prompts: list[tuple[str, str]] = []
        self.aborted_sessions: list[str] = []
        self.abort_error: Exception | None = None
        self.wait_result: bool = True
        # Per-drive wait shapes for wait_idle_detailed, popped one per call
        # (the same script idiom as metrics_script / assistant_terminal_script):
        # each entry is the (idle, wait_reason) pair the waiter returns, so a
        # test can script "stall ONCE, then recover after the nudge" with
        # [(False, "stalled"), (True, "idle")]. Empty (the default) falls
        # through to wait_result — every existing case unchanged.
        self.wait_script: list[tuple[bool, str]] = []
        self.wait_timeout_s: float | None = None
        # The grade waterline the in-wait compaction count runs from: the real
        # client takes it as a keyword, so a feedback round arms the rule and a
        # build hands it None (never armed). Recorded like the other wait fields,
        # so a test can see the drive armed the rule instead of inferring it from
        # an abort it did not ask for.
        self.compaction_watermark: int | None = None
        self.busy_result: bool = True
        self.busy_grace_s: float | None = None
        self.metrics_result: dict[str, Any] | None = None
        self.metrics_script: list[dict[str, Any]] = []
        self.metrics_baseline: dict[str, Any] = {}
        self._baseline_served: bool = False
        self.assistant_texts: list[str | list[str]] = []
        # Per-drive terminal shapes (popped one per send_prompt, default None):
        # {"info_error": ...}  -> a relay-killed turn as opencode 1.18.x
        #                         persists it (bare step-start, no text, the
        #                         signature in info.error.data.message);
        # {"step_finish": r}   -> the appended assistant message also carries a
        #                         step-finish part with reason r (truncation);
        # {"error_part": ...}  -> the appended assistant message also carries
        #                         an error part (transport error_event).
        # The canned metrics_script drives the CUMULATIVE reads; the windowed
        # classification read (metrics(since=...)) is derived from _messages
        # through the REAL extractor, so anomaly surfaces must exist here.
        self.assistant_terminal_script: list[dict[str, str] | None] = []
        self.send_error: Exception | None = None
        self.metrics_error: Exception | None = None
        # THE HARNESS'S OWN COMPACTION, recorded: one entry per
        # `summarize` call, as (session_id, provider_id, model_id, auto). The
        # chunked driver fires exactly one per build chunk and none anywhere
        # else, so a test states that cadence by counting this list.
        self.summarize_calls: list[tuple[str, str, str, bool]] = []
        # Fails every non-windowed read EXCEPT the phase baseline. The baseline
        # read now aborts the phase outright (there is no degrade-to-cumulative
        # path any more), so a test that needs the POST-drive transcript read to
        # fail — the real D-SERVE-MESSAGE-500 shape — must let the baseline
        # through first.
        self.metrics_error_after_baseline: Exception | None = None
        # A growable message list, read via get_messages. Each send_prompt
        # appends a user message plus one (or a batch of) assistant messages,
        # mirroring the real serve session. The TEXT is incidental — nothing in
        # the harness reads it any more (WO-MARKER-RIP) — but a realistic
        # transcript is what the metrics extractor walks.
        self._messages: list[dict[str, Any]] = []
        self.poll_interval: float = 0.0
        # The model's own auto-compactions DURING a turn, scripted one entry
        # per send (pop idiom, same as assistant_terminal_script): each entry
        # is how many FINISHED compactions that turn appends to the transcript
        # after its user message. Empty (the default) appends none.
        self.compactions_per_send: list[int] = []

    def send_prompt(self, session_id: str, prompt: str) -> None:
        self.sent_prompts.append((session_id, prompt))
        if self.send_error is not None:
            raise self.send_error
        self._messages.append(
            {
                "info": {
                    "role": "user",
                    "model": {
                        "providerID": "local-llm-proxy",
                        "modelID": "kimi/kimi-k3",
                    },
                },
                "parts": [{"type": "text", "text": prompt}],
            }
        )
        # The model's own auto-compactions during this turn, scripted
        # one-entry-per-send (popped like assistant_terminal_script): each
        # entry is the number of FINISHED compactions to append — the shape
        # `completed_compactions_since` counts (assistant + summary + a
        # non-empty finish, no error). Empty (default) appends none. Position
        # in the transcript is irrelevant to the predicate (it filters by
        # role/summary/finish, never by index), so this runs before the
        # terminal shape is applied and is never skipped by the killed-turn
        # early return.
        compactions_this_turn = (
            self.compactions_per_send.pop(0) if self.compactions_per_send else 0
        )
        for _ in range(compactions_this_turn):
            self._messages.append(
                {
                    "info": {"role": "assistant", "summary": True, "finish": "stop"},
                    "parts": [],
                }
            )
        terminal = (
            self.assistant_terminal_script.pop(0)
            if self.assistant_terminal_script
            else None
        )
        if terminal and terminal.get("info_error"):
            # Killed turn: no scripted text is consumed — a real kill persists
            # no assistant text (opencode 1.18.x writes the error, not a part).
            info: dict[str, Any] = {
                "role": "assistant",
                "error": {
                    "name": terminal.get("error_name") or "UnknownError",
                    "data": {"message": terminal["info_error"]},
                },
            }
            self._messages.append({"info": info, "parts": [{"type": "step-start"}]})
            return
        scripted = (
            self.assistant_texts.pop(0) if self.assistant_texts else "chunk work done"
        )
        batch = scripted if isinstance(scripted, list) else [scripted]
        for text in batch:
            parts: list[dict[str, Any]] = [{"type": "text", "text": text}]
            if terminal and terminal.get("step_finish"):
                parts.append({"type": "step-finish", "reason": terminal["step_finish"]})
            if terminal and terminal.get("error_part"):
                parts.append({"type": "error", "message": terminal["error_part"]})
            info_ok: dict[str, Any] = {"role": "assistant"}
            if terminal and terminal.get("tokens"):
                # The size opencode records on a finished message; the
                # CONTEXT EXHAUSTED check reads it (harness/context_budget.py).
                info_ok["tokens"] = terminal["tokens"]
            self._messages.append({"info": info_ok, "parts": parts})

    def get_messages(self, session_id: str) -> list[dict[str, Any]]:
        return list(self._messages)

    def wait_busy(self, session_id: str, *, timeout_s: float) -> bool:
        self.busy_grace_s = timeout_s
        return self.busy_result

    def summarize(
        self,
        session_id: str,
        *,
        provider_id: str,
        model_id: str,
        auto: bool = False,
    ) -> None:
        """The harness's compaction write, recorded — never scripted.

        Mirrors the real POST /session/{sid}/summarize: it BLOCKS and returns
        only when the rewrite is done, so what the session carries afterwards is
        a FINISHED compaction — an assistant message flagged ``summary`` with a
        non-empty ``finish``. That is the shape
        ``completed_compactions_since`` counts, and the reason a killed one
        (no finish, or an error) never counts.
        """
        self.summarize_calls.append((session_id, provider_id, model_id, auto))
        self._messages.append(
            {
                "info": {"role": "assistant", "summary": True, "finish": "stop"},
                "parts": [],
            }
        )

    def completed_compactions_since(self, session_id: str, watermark: int) -> int:
        """Mirror of the real predicate: assistant + summary + finish, no error."""
        found = 0
        for msg in self._messages[watermark:]:
            info = msg.get("info") if isinstance(msg, dict) else None
            if not isinstance(info, dict) or info.get("role") != "assistant":
                continue
            if info.get("summary") is not True:
                continue
            if not isinstance(info.get("finish"), str) or not info.get("finish"):
                continue
            if info.get("error"):
                continue
            found += 1
        return found

    def guard_killed_compactions_since(self, session_id: str, watermark: int) -> int:
        found = 0
        for msg in self._messages[watermark:]:
            info = msg.get("info") if isinstance(msg, dict) else None
            if not isinstance(info, dict) or info.get("role") != "assistant":
                continue
            if not (info.get("agent") == "compaction" or info.get("summary") is True):
                continue
            err = info.get("error") if isinstance(info.get("error"), dict) else None
            if not err:
                continue
            err_data = err.get("data") if isinstance(err.get("data"), dict) else {}
            err_text = str(err_data.get("message") or err.get("message") or "").lower()
            if (
                "relay_loop_detected" in err_text
                or "loop_detected" in err_text
                or "generation loop detected" in err_text
            ):
                found += 1
        return found

    def abort(self, session_id: str) -> None:
        self.aborted_sessions.append(session_id)
        if self.abort_error is not None:
            raise self.abort_error

    def wait_idle(self, session_id: str, *, timeout_s: float, **kwargs) -> bool:
        self.wait_timeout_s = timeout_s
        return self.wait_result

    def wait_idle_detailed(
        self,
        session_id: str,
        *,
        timeout_s: float,
        stall_timeout_s: float | None = None,
        loop_kill_marker_dir: str | None = None,
        turn_start_ts_ms: int | None = None,
        compaction_watermark: int | None = None,
        **kwargs,
    ) -> tuple[bool, str]:
        # Mirrors the real client: the drive needs to tell an exhausted budget
        # apart from a turn that stopped progressing — NOT an exhausted context,
        # which the waiter no longer decides anything about. `wait_script`
        # scripts the per-call shapes (a one-shot stall included); the static
        # fallback keys on wait_result, and a False wait_result stays the
        # original run_timeout behaviour.
        self.stall_timeout_s = stall_timeout_s
        self.wait_timeout_s = timeout_s
        self.loop_kill_marker_dir = loop_kill_marker_dir
        self.turn_start_ts_ms = turn_start_ts_ms
        self.compaction_watermark = compaction_watermark
        # WO-LOOPKILL-1: mirrors the real client's marker fast path (a fresh
        # marker for THIS session ends the wait immediately with loop_killed)
        # through the REAL reader, consume included. Consumption is no longer
        # the fake's job: the reader owns it, so one marker ends one turn here
        # exactly as it does in production.
        if loop_kill_marker_dir is not None and read_loop_kill_marker(
            loop_kill_marker_dir,
            turn_start_ts_ms,
            session_id=session_id,
            consume=True,
        ):
            return False, LOOP_KILL_WAIT_REASON
        # Scripted shapes win over the static flags: one entry per detailed
        # wait, so a one-shot stall followed by a clean re-drive is scriptable
        # (the marker fast path above still comes first, mirroring the real
        # client — a fresh marker ends the wait before any script is consulted).
        if self.wait_script:
            return self.wait_script.pop(0)
        # IN-WAIT COMPACTION COUNT. Mirrors the real client's final count before
        # it releases the harness: two COMPLETED compactions since the grade
        # watermark end the wait with idle=False, whatever the static fallback
        # would have said. The count belongs to the WAIT (the real one samples it
        # on its own poll ticks, so a turn that never goes idle is still judged);
        # a turn-end count here would miss exactly the model this rule exists
        # for. The predicate is `completed_compactions_since` — the mirror of the
        # real one — reused here, never re-implemented. The marker fast path and
        # the script above keep precedence, as they do in the real client.
        # A build passes no watermark, so it never counts.
        if (
            compaction_watermark is not None
            and self.completed_compactions_since(session_id, compaction_watermark) >= 2
        ):
            return False, COMPACTIONS_BEFORE_GRADE_WAIT_REASON
        if self.wait_result:
            return True, "idle"
        return False, "timeout"

    def metrics(self, session_id: str, *, since: int | None = None) -> dict[str, Any]:
        if since is not None:
            # The windowed classification read NEVER consults the canned
            # script: it is derived from the fake transcript through the real
            # extractor, so a persisted kill stays visible (and windowed-out)
            # exactly as the opencode serve transcript behaves.
            return extract_transcript_metrics(self._messages[since:])
        if self.metrics_error is not None:
            raise self.metrics_error
        if self.metrics_error_after_baseline is not None:
            if not self._baseline_served:
                self._baseline_served = True
                return self.metrics_baseline
            raise self.metrics_error_after_baseline
        if self.metrics_script:
            return self.metrics_script.pop(0)
        # The serve-drive captures a baseline BEFORE sending the prompt and
        # meters deltas against it; the default baseline is an empty session
        # (all zeros), so single-phase tests keep absolute-value assertions.
        if not self._baseline_served:
            self._baseline_served = True
            return self.metrics_baseline
        return self.metrics_result


def _make_runner(tmp_path: Path, *, compact: bool = False) -> ChallengeRunner:
    return ChallengeRunner(
        task_dir=TASK_DIR,
        work_root=tmp_path / "work-root",
        # A model the registry declares limits for: the serve drive computes
        # the CONTEXT EXHAUSTED line from them (harness/context_budget.py).
        model="local-llm-proxy/qwen3.6-35b-a3b-bench",
        memory_mode="off",
        run_timeout_s=30,
        completion_grace_s=2,
        compact=compact,
    )


def _make_feedback_attempt_kwargs(
    *,
    feedback_text: str,
    phase: str,
    kill_hook: Any,
    active_cell: Any = None,
    compaction_watermark: int | None = None,
) -> dict[str, Any]:
    """Assemble the dispatch kwargs for ``_run_cell_attempt``.

    Serve is the ONLY transport, so these kwargs carry no worktree, env or
    stdout argv any more — there is nothing left to deliver an attempt with
    except the session. ``compaction_watermark`` is the grade waterline the
    in-drive compactions gate counts from (feedback rounds only)."""
    return {
        "active_cell": active_cell if active_cell is not None else _FakeCell(),
        "run_label": "cell-fb",
        "phase": phase,
        "prior_cost_usd": 0.0,
        "kill_hook": kill_hook,
        "stdin_text": feedback_text,
        "compaction_watermark": compaction_watermark,
    }


_ZERO_METRICS = {
    "turns": 0,
    "input_tokens": 0,
    "output_tokens": 0,
    "reasoning_tokens": 0,
    "cost_usd": 0.0,
    "provider_truncations": 0,
    "error_parts": 0,
}


def _metrics(
    turns: int,
    inp: int,
    out: int,
    guard_aborted: int = 0,
    finalize: int = 0,
) -> dict[str, Any]:
    # Session-CUMULATIVE read: the kill counts persist in the transcript, so a
    # post-recovery read carries them forward (a real session never forgets).
    return {
        "turns": turns,
        "input_tokens": inp,
        "output_tokens": out,
        "reasoning_tokens": 0,
        "cost_usd": 0.0,
        "provider_truncations": 0,
        "error_parts": 0,
        "guard_aborted_turns": guard_aborted,
        "finalize_timeouts": finalize,
    }


_LOOP_SIG = "relay: generation loop detected (<request-id>)"
_FIN_SIG = (
    "relay: upstream completed but the stream did not finalize "
    "within 30000ms (<request-id>)"
)

_LOOP_METRICS = {
    # The guard-killed read as the persisted transcript reports it: the relay
    # loop signature survives in info.error text (opencode 1.18.x writes NO
    # error part), and the looped turn's tokens are metered.
    "turns": 5,
    "input_tokens": 100,
    "output_tokens": 40,
    "reasoning_tokens": 10,
    "cost_usd": 0.0,
    "provider_truncations": 0,
    "error_parts": 0,
    "info_errors": 1,
    "guard_aborted_turns": 1,
    "finalize_timeouts": 0,
    "error_texts": [
        # Live-observed shape (2026-08-10 runs); per-request trace id elided.
        _LOOP_SIG
    ],
}

_FINALIZE_METRICS = {
    # The relay 30s stream-finalize watchdog kill (WO-FINALIZE-REC-1): the
    # turn's tokens burned, the kill text lands in info.error, and the turn is
    # EXCLUDED from scoring turns (WO-NUDGE-INF-1 — same treatment as a guard
    # kill, so recovery can never inflate the measurement).
    "turns": 5,
    "input_tokens": 100,
    "output_tokens": 40,
    "reasoning_tokens": 10,
    "cost_usd": 0.0,
    "provider_truncations": 0,
    "error_parts": 0,
    "info_errors": 1,
    "guard_aborted_turns": 0,
    "finalize_timeouts": 1,
    "error_texts": [_FIN_SIG],
}


def _write_loop_kill_marker(marker_dir: Path, session_id: str, *, ts_ms: int) -> Path:
    """Drop a marker file in the egress sidecar's shape (loop-kill-scanner.cjs):
    ``loop-kill-<sid>.json`` carrying an epoch-MILLISECONDS timestamp."""
    path = marker_dir / f"loop-kill-{session_id}.json"
    path.write_text(
        json.dumps(
            {
                "session_id": session_id,
                "timestamp": ts_ms,
                "signature": _LOOP_SIG,
            }
        ),
        encoding="utf-8",
    )
    return path
