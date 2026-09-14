"""Backgammon worker-runner adapter for the benchmark harness.

This adapter drives a single backgammon cell end-to-end:
- seed a fresh worktree from scaffold
- run either a mock worker (golden/scaffold copy) or headless opencode
- evaluate with the backgammon gate report runner
- apply budget-bounded rounds of *problems-only* feedback in the same session
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from contextlib import nullcontext
from dataclasses import dataclass
import datetime as _dt
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
from typing import Any, Callable
import urllib.error
import urllib.request
import uuid

from harness.checkpoint import checkpoint_root, record_checkpoint
from harness.grader_run import (
    GraderImageMissing,
    assert_image_available as assert_grader_image_available,
    container_name as grading_container_name,
    gate_argv,
    kill_container as kill_grading_container,
)
from harness.config import CLOUD_ORCAROUTER_PROVIDER, WORKER_MODEL_REGISTRY
from harness.contention import ContentionCovariates
from harness.egress import egress_container_name
from harness.outcomes.predicate_emitter import STATE_ALG, walk_manifest
from harness.live_stream import Heartbeat, LiveStream
from ..cell_isolation import (
    assert_clean_worktree,
    assert_no_docker_residue,
    assert_seeded_from_snapshot,
)
from .docker_worker import (
    DockerCell,
    DockerCellConfig,
    ImageFingerprint,
    LOOP_KILL_MARKER_DIRNAME,
    WORKER_IMAGE,
    docker_available,
    image_plugin_present,
    worker_image_fingerprint,
)
from .mapping import write_session_mapping
from .transcript import write_session_transcript
from harness.backends.base import NeedCard
from harness.runner import AgentRunner
from harness.serve_client import (
    LOOP_GUARD_SIGNATURES,
    LOOP_KILL_WAIT_REASON,
    REASON_LOOP_GUARD,
    REASON_STREAM_FINALIZE_TIMEOUT,
    REASON_PROVIDER_UNAVAILABLE,
    RECOVERABLE_STREAM_DEATH_REASONS,
    TERMINAL_GUARD_ABORT,
    ServeClient,
    ServeClientError,
    classify_transport_anomaly,
    founder_attach_command,
    set_read_retry_observer,
)
from harness.snapshot import capture_snapshot, compute_grader_hash


_LOG = logging.getLogger(__name__)


# WO-77: the first pass is a sequence of chunk prompts (task/backgammon/prompts/
# chunk-NN.md), driven one per user message over the one serve session.
#
# ── HOW A CHUNK ENDS (WO-MARKER-RIP, 2026-09-09) ────────────────────────────
#
# A chunk is over when the SESSION GOES IDLE. Nothing else.
#
# It used to be over when the model printed the literal string `CHUNK FINISHED`,
# which every chunk prompt instructed it to emit; a chunk that went idle without
# it was re-driven with a nudge, up to ten times, and failed the attempt on
# exhaustion. That machinery is DELETED — the prompts no longer ask for the
# string, the harness no longer looks for it, and the nudging protocol no longer
# owns any trigger of its own.
#
# WHY. The marker was a SELF-REPORT standing in for an event the harness
# already observes directly. It could be printed by a model that had written
# nothing, it was withheld by a model that had finished, and — because the
# instruction lives only in the six build prompts while repair rounds run in the
# SAME session — the model kept printing it out of habit while fixing gate
# failures, firing compactions in the middle of the phase the measurement is
# actually about (run 1788462647). Idle is a fact the transport reports; the
# marker was prose the model chose to emit.
#
# WHAT THE NUDGING PROTOCOL IS NOW. Exactly three upstream conditions, all of
# them raised by the proxy and none of them by the model: a relay LOOP kill, a
# relay STREAM DEATH, and a provider outage the relay is relaying. See the
# recovery-nudge block below.

# ── BUILD-CHUNK COMPLETION: OPERATOR TELEMETRY, NEVER A GATE ────────────────
#
# WO-CHUNKVIS-1 (2026-08-26). `chunk_reports` has always been assembled per
# chunk and then dropped — populated here, asserted in tests, read by nothing.
# This turns it into something the operator can see.
#
# READ-ONLY BY CONSTRUCTION, EXCEPT FOR WO-ABORT. Nothing here reaches the
# model and nothing here nudges: a chunk row is telemetry, plus the one
# all-or-nothing build gate that refuses to grade a build with a chunk missing.
#
# THE CLAIM AND THE FILE, SIDE BY SIDE. A chunk that ran to completion while
# the file it owns still holds its scaffold stubs did not do its work, so the
# FILE is reported beside the outcome — `state: complete` next to
# `stubs_remaining: 5` is a visible discrepancy rather than a silent one.
_STUB_SENTINEL = 'throw new Error("not implemented")'
# Chunk -> the scaffold file that chunk is responsible for emptying of stubs.
# Chunks 1, 5 and 6 own no stub file: 1 is structure/types, 5 is the frontend
# (whose scaffold carries no sentinels), 6 is a verification pass.
_CHUNK_STUB_FILE = {2: "src/game.ts", 3: "src/ai.ts", 4: "src/server.ts"}


_DEFAULT_TASK_DIR = Path(__file__).resolve().parents[2] / "task" / "backgammon"


def load_feedback_overrides(path: Path) -> dict[str, dict[str, str]]:
    """Load `gates/feedback.json` — the human-written symptom line per gate.

    THE CONTRACT. Keys are a gate's bracket token (`"E08"`, `"F12"`), a
    conformance sub-check key (`"REQ-STATE/state.pip"`), or the exact raw check
    string. Values are ONE sentence in the voice of a person playing the game
    who has noticed something wrong — the SYMPTOM, never the cause and never
    the fix. A token key covers every test sharing that token, which is the
    normal case and is deliberately coarse: a coarser report reveals less.

    WHY A FILE AND NOT DERIVED TEXT. The derived string is the test title, and a
    test title states the RULE ("a checker on the bar counts a full 25 pips").
    Handing that to the model after a failure answers the question the gate
    exists to ask. A human writes these once; the grader never generates them.

    SINGLE-SYSTEM (WO-FEEDBACK-VOICE-3, 2026-08-30). This file is the ONLY source
    of what the model hears. There is NO title-derived fallback: a gate with no
    override RAISES `MissingFeedbackOverrideError` when humanised. Completeness
    is enforced before a run starts (bench preflight) and pinned by a test, so
    a missing key is a misconfiguration, not a graceful degradation.

    TWO LINES PER GATE (schema 2, 2026-09-02). Each value is an object with
    `first` (the player's first report) and `repeat` (the same fault seen again
    on a replay, after a failed fix). The returned mapping is
    ``{gate: {"first": ..., "repeat": ...}}``.

    WHY TWO. Byte-identical text across attempts returns zero new information —
    a failed fix reads exactly like a fix never attempted. WO-FEEDBACK-1 solved
    that by appending the grader's own assertion text on a repeat, which worked
    and LEAKED: an assertion states the rule, the one thing this file exists to
    withhold. A second human line carries the gradient without the leak.

    LOADER TOLERANCE. The loader itself still returns `{}` on a missing or
    unreadable file rather than raising, so a broken file surfaces as a
    completeness failure at the preflight/test boundary with a clear name —
    not as an opaque exception mid-load. The hard-fail lives at the humanise
    call, not in the loader. A gate whose entry is malformed or is missing
    either line is DROPPED rather than half-loaded, so it reports as missing at
    that same boundary instead of failing later with a partial record.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    gates = raw.get("gates") if isinstance(raw, dict) else None
    if not isinstance(gates, dict):
        return {}
    loaded: dict[str, dict[str, str]] = {}
    for key, value in gates.items():
        if not isinstance(value, dict):
            continue
        first = " ".join(str(value.get("first", "")).split())
        repeat = " ".join(str(value.get("repeat", "")).split())
        if not first or not repeat:
            continue
        loaded[str(key)] = {"first": first, "repeat": repeat}
    return loaded


def gate_tokens_in_suite(gates_dir: Path) -> set[str]:
    """Every `[XXX]` gate token declared by a graded gate file.

    Scanned from the source files rather than from a roster so this needs no
    `npx` and cannot go stale against a roster captured for some other run.
    The graded surface is `backend/`, `frontend/` and `conformance/` — `meta/`
    grades the grader, not the candidate, and is deliberately excluded.
    """
    pattern = re.compile(r'["\'`]\s*\[([A-Z]+[0-9]*)\]')
    found: set[str] = set()
    for directory in ("backend", "conformance", "frontend"):
        root = gates_dir / directory
        if not root.is_dir():
            continue
        for path in root.rglob("*.ts"):
            found.update(pattern.findall(path.read_text(encoding="utf-8")))
    return found


def missing_feedback_overrides(gates_dir: Path) -> set[str]:
    """Gate tokens in the graded suite that have NO human-written symptom line.

    WO-FEEDBACK-VOICE-3: completeness is mandatory. Any token returned here is a
    gate that — absent an override — would have fallen back to its LEAKY
    title-derived text. The old fallback is deleted, so every returned token is
    a gate whose repair-loop message cannot be built: preflight refuses to start
    a run that returns non-empty, and the test suite refuses to go green.
    """
    tokens = gate_tokens_in_suite(gates_dir)
    overrides = load_feedback_overrides(gates_dir / "feedback.json")
    return {t for t in tokens if t not in overrides}


def count_stub_sentinels(path: Path) -> int | None:
    """Occurrences of the scaffold stub sentinel in ``path``; None if unreadable."""
    try:
        return path.read_text(encoding="utf-8").count(_STUB_SENTINEL)
    except OSError:
        return None


def build_chunk_completion(
    *,
    chunk_reports: Sequence[Mapping[str, Any]],
    expected: int,
    worktree: Path | None = None,
) -> list[dict[str, Any]]:
    """Fold ``chunk_reports`` into one operator-facing row per build chunk.

    THREE STATES, NOT TWO. `chunk_reports.append(report)` runs BEFORE the
    chunked driver's `exit_code != 0` early return, so a chunk that died still
    carries an entry while every chunk after it carries none:

      complete     entry, exit_code 0    - the drive ran to a clean idle
      died         entry, exit_code != 0 - it ran and the drive ended badly
      not_reached  no entry at all       - it never got a turn

    THE STATE IS THE TRANSPORT'S VERDICT, NOT THE MODEL'S (WO-MARKER-RIP,
    2026-09-09). `complete` used to mean "the model printed CHUNK FINISHED",
    which a model could print having written nothing and withhold having
    written everything. It now means the drive reached idle without a
    transport failure — an event the harness observes rather than a claim it
    is handed. `stubs_remaining` beside it is what says whether the work was
    actually done.

    Collapsing the last two into one "incomplete" list is what makes an
    operator read "4, 5, 6 are broken" when the truth is "4 broke, and 5 and 6
    never started because of it". Naming the culprit is the whole value.
    """
    by_index: dict[int, Mapping[str, Any]] = {}
    for report in chunk_reports or ():
        idx = report.get("chunk")
        if isinstance(idx, int):
            by_index[idx] = report

    rows: list[dict[str, Any]] = []
    for index in range(1, max(0, int(expected)) + 1):
        report = by_index.get(index)
        stub_file = _CHUNK_STUB_FILE.get(index)
        stubs = None
        if stub_file is not None and worktree is not None:
            stubs = count_stub_sentinels(worktree / stub_file)

        if report is None:
            rows.append(
                {
                    "chunk": index,
                    "state": "not_reached",
                    "nudges": 0,
                    "reason": None,
                    "stub_file": stub_file,
                    "stubs_remaining": stubs,
                }
            )
            continue

        clean = int(report.get("exit_code", 0) or 0) == 0
        rows.append(
            {
                "chunk": index,
                "state": "complete" if clean else "died",
                # Recovery pressure on this chunk: how many times the harness
                # re-drove it after an upstream proxy terminal. Zero on a chunk
                # that ran straight through.
                "nudges": int(report.get("recovery_nudges", 0) or 0),
                # Why the drive ended badly. `killed_reason` names the real
                # cause (run_timeout / turn_stalled); exit_code alone would say
                # only "not zero", which tells an operator nothing actionable.
                "reason": None
                if clean
                else (report.get("killed_reason") or _died_reason(report)),
                "stub_file": stub_file,
                "stubs_remaining": stubs,
            }
        )
    return rows


def _died_reason(report: Mapping[str, Any]) -> str:
    """Best available explanation for a chunk whose drive ended badly."""
    exit_code = report.get("exit_code")
    if isinstance(exit_code, int) and exit_code != 0:
        return f"exit_code={exit_code}"
    return "no_exit_signal"


# Harness-declared verification/test commands for the backgammon task.
# Gate runner = `node report.mjs` (grader/). Worker-invoked
# test commands are observed via bash tool_use events. test_invocations counts
# bash tool_use events whose command contains any declared string.
DECLARED_TEST_COMMANDS: tuple[str, ...] = (
    "node report.mjs",
    "npx vitest",
    "npx playwright",
    "npm test",
    "npm run test",
    "vitest",
    "playwright test",
)

# Source: published provider pricing cards (USD per 1M tokens), including:
# - https://www.orcarouter.ai/api/pricing
#   (pricing_version c58e194db3f6a20e7d41b8c9e2f05a17, fetched 2026-07-24T12:45Z;
#   input USD/Mtok = model_ratio × $2 × group_ratio(=1), output = input × completion_ratio)
# - https://openrouter.ai/anthropic/claude-opus-4.8 (snapshot used in bench guard reports)
# - https://opencode.ai/docs/zen-models (Zen free/free row for big-pickle)
# Walter-pinned: keep the free/free big-pickle row at truthful zero pricing.
_MODEL_PRICING_USD_PER_1M: dict[str, dict[str, float]] = {
    "z-ai/glm-5.2": {
        "input": 1.4,
        "output": 4.4,
        "cache_read": 0.26,
        "cache_write": 1.4,  # OrcaRouter has no cache-write field; use input rate.
    },
    "kimi/kimi-k3": {
        # OrcaRouter pricing_version c58e194db3f6a20e7d41b8c9e2f05a17
        # fetched 2026-07-27 (model_ratio=1.5, completion_ratio=5, cache_ratio=0.1).
        "input": 3.0,
        "output": 15.0,
        "cache_read": 0.3,
        "cache_write": 3.0,  # OrcaRouter has no cache-write field; use input rate.
    },
    "kimi/kimi-k2.7-code": {
        "input": 0.95,
        "output": 4.0,
        "cache_read": 0.19,
        "cache_write": 0.95,  # OrcaRouter has no cache-write field; use input rate.
    },
    "tencent/hy3": {
        "input": 0.18,
        "output": 0.59,
        "cache_read": 0.059,
        "cache_write": 0.18,  # OrcaRouter has no cache-write field; use input rate.
    },
    "anthropic/claude-opus-4.8": {
        "input": 5.0,
        "output": 25.0,
        "cache_read": 0.5,
        "cache_write": 6.25,
    },
    "opencode/big-pickle": {
        "input": 0.0,
        "output": 0.0,
    },
}

_RESERVATION_SAFETY_FACTOR = 1.10
# A STALLED TURN IS NOT A CAPABILITY RESULT. `turn_stalled` joins the harness
# limits so a wedged tool call is never scored as the model failing.
_HARNESS_LIMIT_REASONS = {
    "run_timeout",
    "max_steps_per_attempt",
    "token_cap",
    "turn_stalled",
}

# How long a turn may make NO transcript progress before the harness ends it.
#
# Bounded separately from the run budget because `session_busy` cannot tell
# "working hard" from "wedged" — a hung tool call stays busy forever, and the
# drive passes the whole-run budget as its idle timeout, so one wedged command
# used to burn the entire cell (2026-08-24: 40 minutes of silence, on course
# for the full 90).
#
# 10 minutes is deliberately generous. This task has ZERO external runtime
# dependencies, so there is no `npm install` leg — a legitimate single tool
# call here is a file write or a short node run, orders of magnitude under the
# bound. Streaming generation advances the progress token continuously and is
# never mistaken for a stall.
DEFAULT_TURN_STALL_TIMEOUT_S = float(
    os.environ.get("BENCH_TURN_STALL_TIMEOUT_S", "600")
)
_PROXY_CHECKPOINT_ENV = "BENCH_PROXY_CHECKPOINT"
_REASONING_EFFORT_ENV = "BENCH_REASONING_EFFORT"

# WO-HOLD-UI-1: opt-in post-cell observation window. When BENCH_HOLD_UI=1,
# the cell's stack (container + worktree) is NOT torn down at benchmark end; the
# artifact's UI server is booted host-side from the bind-mounted worktree on
# :8002 — the exact bytes the model wrote, the same boot the gates perform
# (grader/lib/harness.ts). The port MUST equal PORT there.
# Release is operator-explicit: `touch <run_dir>/RELEASE_HOLD`. Teardown then
# proceeds through the normal unconditional path (RC-6 is preserved — the hold
# sits INSIDE the cell context, so every abort/interrupt still tears down).
_HOLD_UI_ENV = "BENCH_HOLD_UI"
_HOLD_UI_PORT = 8002
_HOLD_UI_RELEASE_FILE = "RELEASE_HOLD"
_HOLD_UI_STATE_FILE = "hold-ui.json"
_HOLD_UI_SERVER_LOG = "hold-ui-server.log"
_HOLD_UI_HEALTH_TIMEOUT_S = 15.0
_HOLD_UI_POLL_S = 2.0
_HOLD_UI_HEARTBEAT_S = 30.0

# ── THE NUDGING PROTOCOL — ITS ENTIRE TRIGGER SET ──────────────────────────
#
# THE PROTOCOL FIRES ON UPSTREAM PROXY TERMINALS AND NOTHING ELSE
# (WO-MARKER-RIP, 2026-09-09). Three conditions, all of them raised by the
# relay, none of them by the model:
#
#   relay LOOP kill      -> _LOOP_RECOVERY_NUDGE      (anti-repetition)
#   relay STREAM DEATH   -> _FINALIZE_RECOVERY_NUDGE  (resume; covers both
#                           relay_stream_finalize_timeout and
#                           relay_stream_incomplete)
#   provider outage      -> _PROVIDER_RECOVERY_NUDGE  (resume, after a backoff;
#                           the relay is relaying someone else's outage)
#
# There is NO fourth trigger and there must never be one derived from what the
# model wrote. The deleted one — a missing `CHUNK FINISHED` string — is the
# reason this list is now stated as a closed set: a nudge keyed on model prose
# re-drives a model that is not stuck, and re-drives it into a context it just
# filled. The relay's terminals are facts about the transport; everything else
# the harness observes is either a measurement (recorded, never acted on) or a
# hard failure (abort, never nudged).
#
# HISTORY. WO-LOOPREC-1: a relay StreamLoopGuard kill used to meter as
# completed work (2026-08-10 live cell: a loop kill on the repair leg metered
# as a turn, no recovery, gates ran on an unrepaired worktree).
# WO-FINALIZE-REC-1 (Walter 2026-08-10) gave the relay's 30s stream-finalize
# watchdog the same recovery with a resume-style nudge (the turn was cut off,
# not looping). WO-NUDGE-INF-1 (Walter 2026-08-11) made recovery UNBOUNDED;
# the 2026-09-02 compaction-looping incident (126+ recovery events, no exit)
# ended that era — recovery is now BOUNDED by _MAX_SERVE_RECOVERY_NUDGES and
# fails closed on exhaustion.
#
# Stalls, loops, and oversized generations are still NORMAL agentic behaviour
# under measurement: a nudged phase is never voided for having been nudged
# within the budget. Nudge turns are excluded from scoring turns (see
# scoring_turns in _run_opencode_serve) so recovery cannot inflate the
# measurement; their tokens stay fully metered — real burn is never hidden.
#
# No nudge restates the original prompt — for a loop kill, the same prompt into
# the same context is the loop's fuel.
#
# Applies to every serve-driven phase (chunked building leg AND repair leg
# alike — RC-4: no mode branch). The proxy guard itself is never reconfigured.
#
# The chunking reminder (Walter 2026-08-10): the finalize kills that day were
# oversized single generations (one 32000-token write; ~4900-token writes) —
# the model tried to emit whole files in one call. All three nudges carry the
# write-in-chunks directive so a re-driven turn retries at safe granularity
# (~150 lines ≈ 1.5K output tokens; every observed sub-1K-token generation
# finalized cleanly, the killed ones were ~4.9K+). ONE NUMBER, EVERYWHERE:
# ~150 lines is also what the six chunk prompts and AGENTS.md say, so the model
# is never handed two different limits by two different voices.
_WRITE_CHUNKING_DIRECTIVE = (
    "Keep each write to around 150 lines or less — the big ones keep getting "
    "truncated on me. Build the long files up across a few passes instead of "
    "one huge write."
)
_LOOP_RECOVERY_NUDGE = (
    "You started going in circles there and repeating yourself, so I stopped "
    "it. Don't rewrite anything you've already done — just pick up from the "
    "next thing that still needs doing. "
    + _WRITE_CHUNKING_DIRECTIVE
    + " No recap, just carry on."
)
_FINALIZE_RECOVERY_NUDGE = (
    "Your last message got cut off partway through on my end. Carry on from "
    "where it stopped — no need to redo the parts that already came through. "
    + _WRITE_CHUNKING_DIRECTIVE
    + " No recap, just carry on."
)

# STALLED TOOL CALL RECOVERY (2026-09-11).
#
# A wedged tool call used to END THE CELL. The stall watchdog caught it — that
# part always worked — but catching was all it did: `killed_reason` was set,
# the drive died, the chunk was marked `died`, and the build aborted with
# `IncompleteBuildError`. Three hours of work lost to one command that did not
# exit.
#
# The un-wedging machinery was already right there. A loop kill is the same
# shape — a turn wedged by something the model did — and it rides a recovery
# nudge back into the drive. A stall now does too.
#
# WHAT THIS SAYS THE MODEL IS OWED. Not a second chance at a wrong answer: the
# command is CANCELLED and the model is told, which is what a colleague sharing
# a terminal would do. Whether it then adapts is a capability observation, and
# one of the more interesting ones — it is certainly more informative than the
# cell dying with no verdict at all.
_STALL_RECOVERY_NUDGE = (
    "Your tool call was running for ten minutes, so I cancelled it. "
    "Try a different approach. "
    + _WRITE_CHUNKING_DIRECTIVE
    + " No recap, just carry on."
)

# PROVIDER OUTAGE RECOVERY (2026-08-24). A live cell lost 8 turns to stream
# deaths, two of them the provider answering "The upstream provider is
# temporarily unavailable"; only 2 of the 8 were ever retried, because the
# recoverable set covered loop kills and finalize timeouts and nothing else.
#
# The same reasoning that put guard kills and finalize timeouts in the
# recoverable set applies with more force here: a provider being down is not
# agentic behaviour at all, and scoring a cell lower because the provider
# blipped is a straightforward false negative. The model is told nothing
# about providers — from its side a message simply did not go through.
_PROVIDER_RECOVERY_NUDGE = (
    "Sorry — that cut out on my end, my connection dropped for a second. "
    "Nothing to do with what you were doing. Carry on from where you stopped; "
    "no need to redo anything that already came through. "
    + _WRITE_CHUNKING_DIRECTIVE
    + " No recap, just carry on."
)

# Wait before re-prompting a provider that just said it was unavailable —
# retrying instantly just spends another turn to be told the same thing. The
# schedule escalates and then holds; within the recovery budget an outage
# longer than the schedule is ridden out at the cap rather than giving up.
PROVIDER_BACKOFF_SCHEDULE_S = (15.0, 30.0, 60.0, 120.0)


def _provider_backoff_seconds(attempt_index: int) -> float:
    """Backoff for the Nth consecutive provider-unavailable recovery."""
    if attempt_index < 1:
        attempt_index = 1
    idx = min(attempt_index, len(PROVIDER_BACKOFF_SCHEDULE_S)) - 1
    return PROVIDER_BACKOFF_SCHEDULE_S[idx]


# ── TERMINATING RECOVERY BUDGET (WO-COMPACTION-RESTORE C5A, 2026-09-03) ────
#
# WO-NUDGE-INF-1 (Walter 2026-08-11) made recovery UNBOUNDED: a repeating kill
# was re-nudged for as long as it repeated. The 2026-09-02 compaction-looping
# failure showed the cost of that design: one wedged session rode the loop to
# 126+ recovery events with no exit. It is now BOUNDED and fails closed on
# exhaustion. Nothing else changed: the recoverable classification, the nudge
# texts, the watermark windowing and the metering discipline (recovered turns
# excluded from scoring turns, burned tokens fully metered) are all intact.
#
# ONE BUDGET, NOT TWO (WO-MARKER-RIP, 2026-09-09). There used to be a second,
# per-chunk budget (`_MAX_MARKER_NUDGES = 10`) governing re-drives of a chunk
# whose `CHUNK FINISHED` string had not landed. That trigger is deleted, so its
# budget is deleted with it — there is exactly one recovery budget, and it
# governs the only thing that can now cause a re-drive: an upstream proxy
# terminal.
#
# Budget value (judgment call, 2026-09-03): normal runs see ~6-16 guard aborts
# PER CELL, spread across the ~6 build chunks plus repair phases; the worst
# observed SINGLE-PHASE burst is 3 consecutive finalize kills (the 2026-08-11
# incident). 20 recoveries in ONE phase absorbs even a fully concentrated
# normal worst case with margin, and stays ~6x below the 126-event storm scale.
#
# Exhaustion semantics (fail-closed): a recovery-budget exhaustion ends the
# drive exactly like a NON-recoverable terminal — the anomaly stays unretried,
# the loop breaks, the drive returns, and the unretried anomaly climbs the cell
# ledger.
_MAX_SERVE_RECOVERY_NUDGES = 20


# Turn-terminal taxonomy (WO-TRUNC-1). A turn is one model generation step,
# delimited by step_start/step_finish on the worker's JSON event stream.
# step_finish reasons that mean "the provider stream ended without a finish
# reason" — the turn's content and usage frame were lost in transit.
TRUNCATED_STEP_FINISH_REASONS = frozenset({"unknown", "stream-incomplete"})
# Substring signatures in `error`-event payloads that classify a turn aborted
# by transport/guard rather than by the model. Guard trips and upstream drops
# both surface to the client as terminal error events (see the loopguard
# diagnostic report); the open step they interrupt never gets a step_finish.
# The loop-guard shapes (live + legacy) live in serve_client.LOOP_GUARD_SIGNATURES.
# The relay finalize-watchdog shape leads this list (RC-4 taxonomy parity:
# every observation point names it exactly as the serve path does).
_TRANSPORT_ERROR_SIGNATURES = (
    ("stream_finalize_timeout", "did not finalize"),
    ("stream_incomplete", "stream incomplete"),
    ("idle_timeout", "idle timeout"),
    ("provider_error", "provider returned error"),
    ("unexpected_server_error", "unexpected server error"),
    ("corrupted_thought_signature", "corrupted thought signature"),
)
# Anomaly terminal classes recorded on turn_terminal records.
TURN_TERMINAL_TRUNCATED = "truncated_no_signal"
TURN_TERMINAL_GUARD_ABORT = "guard_abort"
TURN_TERMINAL_TRANSPORT_ERROR = "transport_error"
# D-SERVE-MESSAGE-500: the transcript read failed past every transient retry,
# so the harness lost its window onto a session that may still be alive. The
# phase carries no trustworthy measurement — an instrument failure, never a
# capability FAIL (RUNBOOK rule 5.10).
TURN_TERMINAL_OBSERVATION_LOST = "observation_lost"
# A TOOL CALL THAT NEVER RETURNED. The model ran something that does not exit —
# measured 2026-09-11: `node -e "import './src/server.ts'"`, which STARTS the
# server, so the command hung and took the whole cell with it after 10 minutes
# of silence.
TURN_TERMINAL_STALLED = "turn_stalled"
REASON_TOOL_CALL_TIMEOUT = "tool_call_exceeded_stall_timeout"
REASON_OBSERVATION_LOST = "transcript_read_failed_past_retries"
# WO-WATCH-1E evidence file name, written next to the cell's events file under
# the run dir (``<worktree>.events.jsonl`` -> ``<worktree>.parent/...``). Lazily
# created: only a real truncation/transport anomaly ever opens it.
TRUNCATION_EVIDENCE_FILENAME = "truncation-evidence.jsonl"


def _is_unrecovered_anomaly(record: dict[str, Any]) -> bool:
    """True when an anomaly record is an instrument failure the harness did
    NOT recover (it ended the phase and was graded).

    Mirrors the recoverability gate in the phase-drive loop: ``guard_abort``,
    ``turn_stalled``, and the recoverable ``transport_error`` reasons
    (``provider_unavailable`` plus both relay stream deaths) are excluded
    REGARDLESS of retry status.
    """
    terminal = record.get("terminal")
    if terminal == TURN_TERMINAL_GUARD_ABORT:
        return False
    if terminal == TURN_TERMINAL_STALLED:
        return False
    if terminal == TURN_TERMINAL_TRANSPORT_ERROR and str(
        record.get("reason") or ""
    ) in ({REASON_PROVIDER_UNAVAILABLE} | RECOVERABLE_STREAM_DEATH_REASONS):
        return False
    return True


def _iso_utc(epoch_ms: int) -> str:
    """Format an epoch-ms timestamp as an RFC3339 UTC string (evidence window)."""
    return _dt.datetime.fromtimestamp(
        float(epoch_ms) / 1000.0, tz=_dt.timezone.utc
    ).isoformat()


def _build_truncation_evidence(
    *,
    attempt_id: str | None,
    run_label: str,
    phase: str,
    terminal: str,
    reason: str,
    ts_start_epoch_ms: int | None,
    ts_end_epoch_ms: int,
    wall_seconds: float | None,
    session_id: Any,
    received_bytes: int | None,
    received_lines: int | None,
    last_event_type: Any,
    last_event_ts: Any,
    finish_reason: Any,
    output_tokens_received: int,
    input_tokens_received: int,
    reasoning_tokens_received: int,
    truncations_seen: int,
) -> dict[str, Any]:
    """Build one WO-WATCH-1E truncation/transport evidence record (pure).

    Captures, at the moment a truncation/transport-error is detected, a
    correlation-ready snapshot that a human or future step matches against the
    local proxy's own ``runs/{YYYY-MM-DD}.jsonl`` log by ``ts`` within the
    recorded ``ts_window_utc``. The harness cannot see the proxy's internal
    trace id at capture time, so it records a timestamp window + attempt id +
    session id (READ-ONLY against the proxy — never reads the proxy log, and
    the proxy itself is never touched).
    """
    ts_start = int(ts_start_epoch_ms) if ts_start_epoch_ms is not None else None
    ts_end = int(ts_end_epoch_ms)
    sess = str(session_id) if isinstance(session_id, str) else None
    attempt = str(attempt_id) if attempt_id else None
    return {
        "attempt_id": attempt,
        "run_label": str(run_label),
        "phase": str(phase),
        "terminal": str(terminal),
        "reason": str(reason),
        "ts_start_epoch_ms": ts_start,
        "ts_end_epoch_ms": ts_end,
        "wall_seconds": float(wall_seconds) if wall_seconds is not None else None,
        "session_id": sess,
        "received_bytes": received_bytes,
        "received_lines": received_lines,
        "last_event_type": last_event_type if last_event_type is not None else None,
        "last_event_ts": last_event_ts,
        "finish_reason": finish_reason,
        "output_tokens_received": int(output_tokens_received or 0),
        "input_tokens_received": int(input_tokens_received or 0),
        "reasoning_tokens_received": int(reasoning_tokens_received or 0),
        "truncations_seen": int(truncations_seen or 0),
        "correlation": {
            "proxy_log_dir": "runs",
            "ts_window_utc": [
                _iso_utc(ts_start) if ts_start is not None else None,
                _iso_utc(ts_end),
            ],
            "match_key": f"{run_label}|{attempt or 'none'}|{sess or 'none'}",
        },
    }


# Canonical attempt ceiling. Raised 8 -> 10 (WO-BENCH-ATTEMPTS-3-TO-10): the
# commissioned solve-attempt count is now 5 (config.py max_attempts), so the
# hard ceiling must be >= 10 or the clamp at `min(requested, ceiling)` silently
# caps a 10-attempt request at 8. 10 == the default; the ceiling stays a single
# knob with no hidden cap below the commissioned count.
DEFAULT_ATTEMPT_HARD_CEILING = 10

# Canonical per-attempt step cap (runaway-loop guard, NOT a budget instrument).
# Budget enforcement is the accrued usage.cost kill plus the proxy's hard-cap
# reservation; this cap exists only to stop a fast runaway tool-call loop.
# Evidence for 100: the healthy 15-07 un-clamped baseline used 77 turns across a
# full run (~25-40 per attempt; 19b initial attempt = 37), while the clamp-era
# value of 40 killed smoke 19c at turn 41 mid-work, UNGRADED. 100 = baseline +
# margin. Programmatic `max_steps_per_attempt=None` still means "no cap"; the
# CLI driver defaults to this constant.
DEFAULT_MAX_STEPS_PER_ATTEMPT = 100

# Canonical per-attempt wall-clock timeout (guard, NOT a scoring signal).
# Evidence for 5400: smoke 19d observed ~3060s wall on a healthy 68-turn Opus
# PASS. Stage-4 at the old 1800s default killed converging near-pass runs
# (kimi-k2.7-code: 52 turns with 26/29 gates green; mimo-v2.5-pro: 35 turns).
# int4/fp8 pins run slower than Opus, so the canonical default carries ~1.75x
# headroom over the slowest healthy observed wall (3060 * 1.75 ~= 5355 -> 5400).
DEFAULT_RUN_TIMEOUT_S = 5400

# Canonical gate-oracle wall-clock timeout (harness guard, NOT a scoring signal).
# The gate is graded work, not model work: a healthy grade is fast. Measured
# 2026-08-12 on the backgammon task: 45s and 113s for two clean attempts, and
# 1918s for one starved by an orphaned gate tree competing for CPU. 3600s is
# ~1.9x the worst OBSERVED (already-pathological) wall and ~32x the healthy
# baseline, so it can only fire on a genuine hang, never on a slow-but-working
# grade. A gate that exceeds it fails its attempt WITH evidence (the streamed
# log is already on disk) instead of hanging the campaign indefinitely, which is
# what happened before this existed.
#
# NOT the same threshold as the board's stall ALARM: the alarm is a visual
# signal that must fire early (minutes) so an operator can look; this is a
# destructive kill that must fire late. Alarm << timeout, by construction.
DEFAULT_GATE_TIMEOUT_S = 3600

# Ceiling on the bounded wait for the WORKER'S OWN compaction at a chunk
# boundary. The harness only observes — it never fires a substitute — so a
# compaction that does not land within this window is no_compaction_evidence
# and the cell aborts (fail-closed); the bound exists so that abort happens
# in bounded time rather than hanging.
_COMPACT_SETTLE_TIMEOUT_S = 300.0
# How long to wait for it to START. The plugin fires on idle, so there is a gap
# between this drive returning and the generation appearing. Short: if nothing
# has begun in this window the plugin did not fire, and the parts check at the
# end of the wait decides the outcome.
_COMPACT_SETTLE_GRACE_S = 20.0

# ── A2 PHASE SENTINEL — THE ONLY COMPACTION TRIGGER ─────────────────────────
#
# The worker plugin fires its own compaction on `session.idle`. WHICH idles it
# may fire on is decided HERE, by the harness, and published as one file on a
# read-only bind mount that the plugin re-reads on every idle. The cell env is
# written once at `docker run` and cannot carry something that changes between
# phases, so a file is the transport.
#
# WHY THE HARNESS OWNS THIS (WO-MARKER-RIP, 2026-09-09). The arm used to ALSO
# require the model to have printed `CHUNK FINISHED` on the turn that just
# ended. That was a model-emitted string standing in for a harness-known fact,
# and it leaked: the instruction lives only in the six build prompts, but repair
# rounds run in the SAME session, so the convention survived every compaction
# and the model kept printing it while fixing gate failures — in run 1788462647
# that fired a compaction ~80s before the end of `feedback-2`. The marker is
# gone. The sentinel is now the WHOLE gate, which means it has to be exact.
#
# EXACTLY ONE BUILD-FLAGGED DRIVE PER CHUNK. The plugin fires at most once per
# flagged idle and is hard-capped at six fires per session, so the sentinel's
# job is to make sure the six idles it flags are the six CHUNK BOUNDARIES:
#
#   record turn ON  -> the chunk drive is HELD (repair) and the trailing
#                      `-record-N` turn is flagged build. Compaction then lands
#                      AFTER the recording and BEFORE the next chunk, which is
#                      the ordering the recording turn exists to protect: the
#                      material must still be in context when it is recorded.
#   record turn OFF -> there is no trailing turn, so the chunk drive itself is
#                      flagged build and its idle is the boundary.
#
# Recovery nudge re-drives are ALWAYS HELD (repair): a nudge is not a chunk
# boundary — the boundary idle already fired at the abort that triggered the
# nudge — so holding the re-drive is what keeps it from double-firing the
# plugin's six-fire budget.
#
# FAIL-CLOSED IN BOTH DIRECTIONS. Everything not named here is repair, and
# repair is the measurement — it never compacts. An unknown phase name resolves
# to repair, not build: a phase this function has never heard of is not one that
# has been shown to be a safe compaction point.
_COMPACT_PHASE_BUILD = "build"
_COMPACT_PHASE_REPAIR = "repair"
_COMPACT_PHASE_FILENAME = "phase"

# Phase-name suffix of the per-chunk recording turn (`initial-chunk-3-record-3`).
_RECORD_PHASE_MARKER = "-record-"


def compact_phase_for(phase: str, *, record_turn_enabled: bool = False) -> str:
    """Map a drive phase name onto the sentinel value the plugin reads.

    ``record_turn_enabled`` says whether every chunk is followed by a recording
    turn. It moves WHICH drive in a chunk is the boundary — see the block above
    — and nothing else. Both arms flag exactly one drive per chunk.
    """
    is_build_leg = phase == "initial" or phase.startswith("initial-chunk")
    if not is_build_leg:
        return _COMPACT_PHASE_REPAIR
    if not record_turn_enabled:
        return _COMPACT_PHASE_BUILD
    # The recording turn is the boundary; the chunk drive that precedes it (and
    # any recovery nudge inside that drive) is held.
    return (
        _COMPACT_PHASE_BUILD
        if _RECORD_PHASE_MARKER in phase
        else _COMPACT_PHASE_REPAIR
    )


# How many fixed complaints the pass verdict names before it summarises the
# rest. Naming them is what stops the model undoing its own working changes;
# the cap is only there so a mass pass cannot turn one message into a wall.
_PASS_VERDICT_MAX_LISTED = 10

# THE EXCUSE ELIMINATOR (2026-09-04). Measured on OFF-cell run 1788499216
# (qwen3.6-35b-a3b, memoryOFF): after 456 turns across five flat-failing
# attempts, the model's terminal deflection was that the still-failing frontend
# gates were a stale page on the grader's side — "the user needs to hard-refresh
# (Ctrl+Shift+R) to clear browser cache" — for a defect none of the 10 remaining
# failures had any relation to browser caching. Every failure verdict therefore
# opens with the harness-side freshness FACT, in the player's voice, so the
# stale-page / hard-refresh / saved-session excuse class is pre-empted before
# the model can reach for it. It is present BYTE-IDENTICAL on the first report
# and on every repeat: it is a constant of how grading happens, not a sighting,
# so it carries no gradient by design. It is absent from the pass verdict,
# which lists no problems to excuse.
_EXCUSE_ELIMINATOR = (
    "One thing before the list: I check in a clean browser every time. I load "
    "your latest code with the cache cleared and no saved session carried over "
    "(the equivalent of a hard refresh), and I always start from a brand-new "
    "game. So none of what follows is a stale page or leftover files on my end "
    "— if it's still there, it's in the code you changed."
)

# ── THE SECOND DEFLECTION, CLOSED BEFORE IT IS USED ─────────────────────────
#
# Introducing the software team (see `_build_feedback_prompt`) hands the model a
# new party to blame, and the excuses write themselves: they're calling it
# wrong, they're on an old build, that field is optional, their selector is
# wrong. `_EXCUSE_ELIMINATOR` above closes exactly one deflection — the stale
# page — because that is the one that was measured (run 1788499216, ten
# failures deflected onto "the user needs to hard-refresh").
#
# CONSTANT, LIKE THE FIRST. It is a fact about how the checking happens, not a
# sighting, so it carries no gradient and is identical on every pass.
#
# ⚠ WATCH THIS AFTER IT SHIPS. The excuse class is only knowable from
# transcripts. Read the first two repair rounds of the next few cells: if the
# model argues with the team instead of changing the code, this wording is the
# lever, not the routing.
_TEAM_EXCUSE_ELIMINATOR = (
    "They work from the written spec for this app, against the code exactly as "
    "it is right now, on a clean checkout — so if they can't find something, "
    "it isn't there to find."
)

# The team's opener. DELIBERATELY NOT "conformance checks" — that is the
# grader's word for the gate, a team integrating an app would never say it, and
# it tells the model it is being measured. Same class of tell as the `FAILING`
# label that was removed from the old bullet list.
_TEAM_HEADER = (
    "Also, my software team is trying to integrate your app into their own "
    "software and they hit some problems on their side:"
)


class GateTimeoutError(RuntimeError):
    """The gate oracle exceeded its wall-clock limit and was killed.

    Distinct from a gate FAIL: the model's work was never graded, so this is a
    harness/instrument failure and must never be scored as a capability FAIL
    (RUNBOOK rule 5.10 reasoning). It carries the partial log path so the stall
    is diagnosable from the artifact rather than from a live process.
    """


class GraderReportUnreadableError(RuntimeError):
    """The gate oracle produced no readable report.

    The grader container ran (or failed to) but its report is missing,
    truncated, or not valid JSON — so nothing was measured. Like
    GateTimeoutError, this is an instrument failure, never a capability FAIL,
    and must not abort the campaign: it is recorded as a named terminal state.
    """


class MissingFeedbackOverrideError(RuntimeError):
    """A gate reached the repair loop with no human-written symptom line.

    WO-FEEDBACK-VOICE-3 (2026-08-30): the feedback voice is SINGLE-SYSTEM —
    the ONLY sentence a gate may carry is the human-written line in
    `gates/feedback.json`. The old title-derived fallback is gone: a test title
    states the RULE, so a gate with no override would leak its answer and the
    repair loop would measure attempt count, not capability. This is raised, not
    silently papered over, because a gate the model cannot be told about in the
    right voice is a misconfigured benchmark, not a thing to route around.

    Completeness is guaranteed BEFORE a run starts (preflight) and pinned by a
    test, so reaching this during a run means a gate was added or a key was
    mistyped after preflight passed — a real defect, worth stopping for.
    """


class IncompleteBuildError(RuntimeError):
    """The build phase did not deliver every chunk, so there is nothing to grade.

    THE BUILD IS ALL-OR-NOTHING (2026-09-08 ruling). The six chunks ARE the
    corpus. The chunked driver returns early the moment a chunk exits non-zero,
    so a chunk that stalls does not merely lose its own work — every chunk after
    it is never sent. The model is then asked to repair a product it was never
    asked to build.

    WHAT THIS REPLACED, AND WHY IT HAD TO GO. Run 1788842999: chunk 2 of 6
    emitted 177 tokens and went silent; the 600s stall watchdog aborted the turn
    with ``killed_reason="turn_stalled"``. Because ``turn_stalled`` is a HARNESS
    LIMIT reason, the post-attempt decision was ``continue_if_budget`` — correct
    for a repair round, where a stalled turn only means that attempt did less,
    and wrong for the build, where it means chunks 3-6 do not exist. The cell
    graded a two-sixths build at 44/118, then spent 23,355 tokens in feedback-1
    reverse-engineering an API contract it had never been given, and reported
    66/118. Those numbers are not a capability signal and are not comparable to
    anything, yet nothing in the artifact distinguishes them from a real result.

    ``build_chunk_completion`` already knew: it tracks complete / died /
    not_reached precisely so an operator can read "2 died, 3-6 never started".
    The accounting existed and gated nothing. It gates the grader now.

    A partial build is the same trade ``ServeTransportError`` refuses: a cell
    salvaged by a lesser method is worth less than no cell. This aborts.
    """


class ServeTransportError(RuntimeError):
    """The one transport the benchmark runs on became unusable.

    THE BENCHMARK RUNS EXACTLY ONE WAY (2026-09-02 ruling). Every scored turn is
    delivered over the persistent ``opencode serve`` session, and when that
    session cannot be created or cannot carry a turn, the cell ABORTS. It does
    not quietly re-run the work down the stdout subprocess path.

    WHAT THIS REPLACED, AND WHY IT HAD TO GO. Four sites used to catch a
    transport fault and continue by a different method: the chunked build (which
    restarted the whole build as ONE joined six-chunk prompt, erasing the chunk
    boundaries), the per-attempt drive, cell start when ``create_session``
    failed, and the phase metrics baseline (which degraded per-phase deltas to
    session CUMULATIVE totals — a corrupted measurement, not merely a different
    route). Each logged a single PROGRESS line and carried on, so a cell that ran
    a materially different experiment was indistinguishable in the ledger from
    one that did not. The operator had to be watching the TUI to know, which is
    the definition of a surface that does not report itself.

    A cell salvaged by a lesser method is worth less than no cell: it produces
    numbers that look comparable and are not. Aborting turns hours of
    uninterpretable output into one named failure.
    """


# WO-ERRDATA-C1: the max per-error-type total allowed per benchmark before
# fast-fail abort — the 21st instance of any one type aborts the run.
ERROR_CAP_PER_TYPE = 20


class ErrorCapExceeded(RuntimeError):
    """One error type exceeded ``ERROR_CAP_PER_TYPE`` across the benchmark.

    PER-BENCHMARK FAST-FAIL (WO-ERRDATA-C1 ruling). When any of
    ``guard_aborted_turns`` / ``finalize_timeout_turns`` / ``stalled_turns``
    exceeds ``ERROR_CAP_PER_TYPE`` across the whole benchmark, the run aborts
    loudly — uncaught, with no scorecard — because a benchmark that produced
    that many harness-caught error turns is not a comparable capability
    signal. The same trade ``ServeTransportError`` refuses: numbers that look
    comparable and are not are worth less than no numbers.
    """


def _snapshot_state_hash(worktree: Path) -> str | None:
    """Fingerprint the graded code for ONE attempt, at the moment it was graded.

    A cell keeps only its final worktree on disk, so a later reader cannot
    recover what the code looked like at attempt 1 or 2. Captured here, while
    that state still exists, each attempt's gate results stay bound to the code
    they actually ran against.

    Returns None on any failure: an unhashable worktree is recorded as having
    no snapshot, never as some other attempt's hash.
    """
    try:
        return walk_manifest(worktree)[1]
    except Exception:
        return None


def _worktree_has_injection_record(worktree: Path) -> bool:
    return (Path(worktree) / ".okp" / "org.json").is_file()


def _scan_cell_delivery(worktree: Path) -> str | None:
    plugin_log = worktree / ".okp" / "logs" / "okp-plugin-errors.log"
    try:
        payload = plugin_log.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return None

    matches = re.findall(r"\[inject\] injected count=(\d+)", payload)
    if not matches:
        return None
    if any(int(count) >= 1 for count in matches):
        return "YES"
    return "NO"


def _scan_injected_block_chars(worktree: Path) -> int | None:
    plugin_log = worktree / ".okp" / "logs" / "okp-plugin-errors.log"
    try:
        payload = plugin_log.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return None

    block_matches = re.findall(r"\[inject\] injected[^\n]*\bblock_chars=(\d+)", payload)
    if block_matches:
        return sum(int(chars) for chars in block_matches)

    legacy_matches = re.findall(r"\[inject\] injected[^\n]*\bchars=(\d+)", payload)
    if legacy_matches:
        return sum(int(chars) for chars in legacy_matches)

    return None


@dataclass(frozen=True)
class RecallFunnelScan:
    recall_fired_total: int = 0
    recall_returned_total: int = 0
    recall_returned_count_sum: int = 0
    no_keywords_count: int = 0
    injected_count: int = 0
    served_attempted: int = 0
    served_failed: int = 0
    served_confirmed: int = 0


def _scan_recall_funnel(worktree: Path) -> RecallFunnelScan | None:
    plugin_log = worktree / ".okp" / "logs" / "okp-plugin-errors.log"
    try:
        payload = plugin_log.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return None

    fired_matches = re.findall(r"\brecall_fired\s+trigger=repeat_failure\b", payload)

    returned_matches = re.findall(
        r"\brecall_returned\s+status=\S+\s+count=(\d+)\s+reason_code=(\S+)\s+dur_ms=\d+\s+error=",
        payload,
    )
    recall_returned_count_sum = sum(
        int(count) for count, _reason_code in returned_matches
    )
    no_keywords_count = sum(
        1 for _count, reason_code in returned_matches if reason_code == "no_keywords"
    )

    injected_matches = re.findall(r"\[inject\]\s+injected\s+count=(\d+)", payload)
    injected_count = sum(int(count) for count in injected_matches)

    served_attempted = len(re.findall(r"\[serve\]\s+upsert\s+cid=", payload))
    served_failed = len(re.findall(r"\[serve\]\s+receipt\s+failed\b", payload))

    return RecallFunnelScan(
        recall_fired_total=len(fired_matches),
        recall_returned_total=len(returned_matches),
        recall_returned_count_sum=recall_returned_count_sum,
        no_keywords_count=no_keywords_count,
        injected_count=injected_count,
        served_attempted=served_attempted,
        served_failed=served_failed,
        served_confirmed=served_attempted - served_failed,
    )


def _export_cell_telemetry(
    worktree: Path, run_label: str, memory_mode: str = "on"
) -> Path | None:
    """Copy the plugin's observable recall surface host-side before teardown.

    ON cells write their plugin state INSIDE the cell worktree under
    ``.okp/state``; OFF cells write to a dedicated blind mount OUTSIDE the
    worktree at ``<cell>/extraction-state`` (container ``/okp-state``), so the
    OFF cell's extraction state never lands inside the worktree its model reads.
    This copies the funnel snapshot, plugin error log, and the in-session
    extraction tree (``insession/``: ``master.json`` + ``changed-lines.json``)
    host-side into ``data/cells/<unix_ts>-<run_label>/`` so they survive teardown.

    FAIL-OPEN by contract: telemetry export must never fail a cell. Any error is
    logged and swallowed, and the function returns None. ``data/`` is a
    telemetry/retention layer only -- ``runs/`` (RC-5) stays authoritative, and
    this never writes there.
    """
    if memory_mode.strip().lower() == "off":
        state_root = worktree.parent / "extraction-state"
    else:
        state_root = worktree / ".okp" / "state"
    sources = {
        "funnel-snapshot.json": state_root / "funnel-snapshot.json",
        "plugin-errors.log": worktree / ".okp" / "logs" / "okp-plugin-errors.log",
    }
    insession_src = state_root / "insession"
    present = {name: path for name, path in sources.items() if path.is_file()}
    has_insession = insession_src.is_dir()
    if not present and not has_insession:
        return None

    try:
        override = os.environ.get("BENCH_DATA_DIR", "").strip()
        data_dir = (
            Path(override) if override else Path(__file__).resolve().parents[2] / "data"
        )
        dest = data_dir / "cells" / f"{int(time.time())}-{run_label}"
        dest.mkdir(parents=True, exist_ok=True)
        for name, path in present.items():
            shutil.copy2(path, dest / name)
        if has_insession:
            shutil.copytree(insession_src, dest / "insession")
        return dest
    except (OSError, shutil.Error) as exc:
        _LOG.warning("telemetry export failed for run_label=%s: %s", run_label, exc)
        return None


def _scan_funnel_snapshot(worktree: Path) -> dict[str, dict[str, int | None]] | None:
    """Read the plugin's per-session funnel counters from funnel-snapshot.json.

    The plugin writes this file into its state dir (``{worktree}/.okp/state``)
    periodically and on ``session.idle``. Content is a flat JSON object mapping
    sessionId -> counter dict (all numeric; ``gate_decision_ms`` is int|null).

    Mirrors the tolerant style of ``_scan_recall_funnel``: an absent or
    unreadable/corrupt file yields None (never a raise); a file that exists but
    carries no sessions yields ``{}``.
    """
    snapshot_path = worktree / ".okp" / "state" / "funnel-snapshot.json"
    try:
        payload = snapshot_path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return None

    try:
        parsed = json.loads(payload)
    except (ValueError, TypeError):
        return None

    if not isinstance(parsed, dict):
        return None

    sessions: dict[str, dict[str, int | None]] = {}
    for session_id, counters in parsed.items():
        if not isinstance(counters, dict):
            continue
        sessions[str(session_id)] = dict(counters)
    return sessions


@dataclass(frozen=True)
class _OpencodeRunStats:
    input_tokens: int
    output_tokens: int
    reasoning_tokens: int
    turns: int
    session_id: str | None
    killed_reason: str | None
    exit_code: int | None
    cost_usd: float
    # PROMPT-CACHE ACCOUNTING (WO-TOKENS-ALL). Defaulted so every existing
    # construction site stays valid: a path that cannot observe cache reports 0
    # rather than forcing a guess. Summed across turns, never maxed — each turn
    # is billed for its own cache read.
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    budget_stop_detected: bool = False
    budget_stop_signature: str | None = None
    truncations: int = 0
    zero_tool_turns: int = 0
    terminal_zero_tool_turn: bool = False
    zero_tool_resumes: int = 0
    zero_tool_turn_honest_fail: bool = False
    resume_count: int = 0
    # WO-TRUNC-1: per-anomalous-turn terminal records (truncated/guard/transport
    # endings and their retries). Normal stop/tool-calls/length turns stay
    # aggregate-only. Each dict is a turn_terminal payload ready for the
    # append-only status stream.
    turn_anomalies: tuple[dict[str, Any], ...] = ()
    # WO-77 chunked first pass: one record per chunk (index, delta tokens,
    # exit code, recovery pressure). Empty for single-prompt phases.
    chunk_reports: tuple[dict[str, Any], ...] = ()
    # Turns whose usage frame never survived the stream drop: their true
    # upstream token burn is unmetered client-side (never synthesized), but
    # their measured wall-clock is real cost and lands here.
    unmetered_turns: int = 0
    unmetered_turn_wall_s: float = 0.0
    # WO-LOOPREC-1/FINALIZE-REC-1: recovery nudges this invocation fired after
    # relay loop-guard kills or finalize-watchdog kills (serve path only; see
    # _LOOP_RECOVERY_NUDGE/_FINALIZE_RECOVERY_NUDGE), bounded by
    # _MAX_SERVE_RECOVERY_NUDGES per phase.
    recovery_nudges: int = 0
    # WO-TURNACCT-1 (Walter 2026-08-10): guard-killed turns NEVER count toward
    # scoring turns. ``turns`` already excludes them; their count is carried
    # here so the exclusion is reported, never silent. Tokens stay metered.
    guard_aborted_turns: int = 0
    # WO-NUDGE-INF-1 (Walter 2026-08-11): finalize-killed turns are excluded
    # from scoring turns on the same grounds and counted here for the same
    # reason — the exclusion is reported, never silent. Tokens stay metered.
    finalize_timeout_turns: int = 0
    # D-SERVE-MESSAGE-500: phases whose transcript read failed past every
    # transient retry. Non-zero means the cell was measured blind and must be
    # gated VOID-INSTRUMENT rather than scored.
    observation_lost_turns: int = 0


@dataclass(frozen=True)
class _ProxyBudgetSnapshot:
    hard_cap_usd: float
    accrued_actual_usd: float
    accrued_derived_usd: float
    committed_unproven_usd: float
    remaining_usd: float
    checkpoint_path: str


@dataclass
class BackgammonCellResult:
    verdict: str
    attempts_to_green: int | str
    termination_reason: str
    conformed: bool
    input_tokens: int
    output_tokens: int
    turns: int
    wall_seconds: float
    delivery: str
    failed_gates: list[str]
    problems_final: list[dict[str, Any]]
    attempt_reports: list[dict[str, Any]]
    worktree: str
    session_id: str | None
    memory_mode: str
    model: str
    wall_cost_usd: float = 0.0
    # WO-TOKENS-ALL. Additive: `input_tokens`/`output_tokens` above are
    # UNCHANGED (output still carries reasoning inside it, as it always has).
    # These break the cell down by real category so the board can stack it, and
    # carry the cache figures the record has never held.
    reasoning_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    tool_calls: int | None = None
    test_invocations: int | None = None
    agentic_cycles: int | None = None
    problems_before: int | None = None
    injected_block_chars: int | None = None
    injected_block_est_tokens: int | None = None
    recall_fired_total: int | None = None
    recall_returned_total: int | None = None
    recall_returned_count_sum: int | None = None
    no_keywords_count: int | None = None
    injected_count: int | None = None
    served_attempted: int | None = None
    served_failed: int | None = None
    served_confirmed: int | None = None
    funnel_snapshot: dict[str, dict[str, int | None]] | None = None
    truncations: int = 0
    zero_tool_turns: int = 0
    zero_tool_resumes: int = 0
    zero_tool_turn_honest_fails: int = 0
    transport_resume_count: int = 0
    # WO-CHUNKVIS-1: one operator-facing row per build chunk (complete / died /
    # not_reached, with the stub count of the file that chunk owns). Display
    # only — nothing branches on it. None when the cell ran no chunked build.
    build_chunks: list[dict[str, Any]] | None = None
    # WO-TRUNC-1: ledger of anomalously-ended turns across every worker
    # invocation of the cell (truncated_no_signal / guard_abort /
    # transport_error / stream_died_open / unclassified_finish), each with its
    # retry linkage. truncated_turns counts them; truncated_turns_retried counts
    # those a later step or resume picked up.
    turn_anomalies: list[dict[str, Any]] | None = None
    truncated_turns: int = 0
    truncated_turns_retried: int = 0
    # ── THE VOID SIGNAL, STATED BY THE PRODUCER (2026-09-05) ──────────────
    #
    # Anomalous turns that are INSTRUMENT failures — every kind except
    # ``guard_abort``. This exists because ``truncated_turns`` is
    # ``len(turn_anomalies)``, i.e. ALL anomalies, and three separate consumers
    # were reading it as "a provider-side truncation signal" and voiding the
    # cell on it. A loop-guard abort is not a truncation and not an instrument
    # failure: the harness fired it, on purpose, at a model that was looping,
    # and then recovered the turn.
    #
    # Jerry's ruling, 2026-09-05: "nudging on a loop should be considered model
    # behaviour and not a void classifier." A model that loops is a CAPABILITY
    # observation and one of the more interesting ones this bench can make;
    # voiding the cell deletes it.
    #
    # Stated here rather than subtracted by each consumer — there are three of
    # them (run_artifacts.py, control/baselines.mjs,
    # dashboard/sources/stack-ledger.mjs) and three subtractions are three
    # chances to disagree about whether a cell is a measurement.
    instrument_anomaly_turns: int = 0
    # ── WO-I1 (2026-09-07): THE UNRECOVERED COMPLEMENT, STATED BY THE
    # PRODUCER ─────────────────────────────────────────────────────────────
    #
    # Instrument anomalies the harness did NOT recover — the anomalies that
    # ended a phase / were graded. Computed from the recoverability gate in
    # ``_run_opencode_serve``: the RECOVERABLE classes (``guard_abort``,
    # ``transport_error``+``provider_unavailable``,
    # ``transport_error``+``stream_finalize_timeout``) NEVER count into this
    # field, REGARDLESS of whether the anomaly was actually retried — a
    # budget-exhausted recoverable kill does not count either. Every
    # non-recoverable class (``truncated_no_signal``,
    # ``transport_error``/``error_event`` or other reasons,
    # ``observation_lost``, ``compaction_loop_killed``, ``silent_phase``)
    # DOES count. This is ``instrument_anomaly_turns`` minus the recoverable
    # transport_error classes, stated here rather than re-derived by each
    # downstream void-consumer — the gate's complement computed once, so
    # consumers cannot disagree about which anomalies the harness owns.
    unrecovered_anomaly_turns: int = 0
    # WO-TURNACCT-1 (Walter 2026-08-10): relay guard-killed turns, excluded
    # from ``turns`` (scoring) but never silently dropped — counted here.
    guard_aborted_turns: int = 0
    # WO-NUDGE-INF-1 (Walter 2026-08-11): relay finalize-killed turns, excluded
    # from ``turns`` (scoring) on the same grounds and counted here for the same
    # reason. These are the turns recovery re-drove; the count is what proves
    # the nudges did not inflate the measurement.
    finalize_timeout_turns: int = 0
    # WO-ERRDATA-C1: turns the stall watchdog killed. WO-21 made a stall ride
    # the recoverable path like a loop kill, so it now enters the anomaly ledger
    # (terminal="turn_stalled") and is recomputed from turn_anomalies_all at the
    # aggregation site — the same way guard_aborted_turns is.
    stalled_turns: int = 0
    # D-SERVE-MESSAGE-500: phases that lost transcript observation entirely.
    observation_lost_turns: int = 0
    unmetered_turns: int = 0
    unmetered_turn_wall_s: float = 0.0
    contention: ContentionCovariates | None = None
    worker_image_fingerprint: ImageFingerprint | None = None
    # WO-STRIP-2b: deterministic title the cell gave its OpenCode session(s),
    # surfaced to the run-manifest status stream so the prod dashboard can
    # join exported session-DB rows to bench cells.
    session_title: str | None = None


def _resolve_hold_ui_entrypoint(worktree: Path) -> Path:
    """Artifact-driven entrypoint resolution — the Python port of
    grader/lib/harness.ts resolveEntrypoint: package.json
    scripts.start first, then src/server.{ts,js,mjs,cjs}, else a loud throw
    (a distinct failure class, never a silent skip)."""
    pkg_path = worktree / "package.json"
    if pkg_path.is_file():
        try:
            pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pkg = None
        scripts = pkg.get("scripts") if isinstance(pkg, dict) else None
        start_cmd = scripts.get("start") if isinstance(scripts, dict) else None
        if isinstance(start_cmd, str) and start_cmd.strip():
            parts = start_cmd.split()
            for idx, part in enumerate(parts):
                if part in {"node", "tsx", "deno", "bun", "next", "ts-node", "esrun"}:
                    if idx + 1 < len(parts) and re.search(
                        r"\.(ts|js|mjs|cjs|tsx|jsx)$", parts[idx + 1], re.IGNORECASE
                    ):
                        resolved = (worktree / parts[idx + 1]).resolve()
                        if resolved.is_file():
                            return resolved
    for name in ("server.ts", "server.js", "server.mjs", "server.cjs"):
        candidate = worktree / "src" / name
        if candidate.is_file():
            return candidate
    raise RuntimeError(
        "hold-ui: no entrypoint resolved — searched package.json scripts.start and "
        f"src/server.{{ts,js,mjs,cjs}} in {worktree}"
    )


def _hold_ui_port_listeners(port: int) -> list[int]:
    try:
        out = subprocess.run(
            ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return []
    return [int(tok) for tok in (out.stdout or "").split() if tok.strip().isdigit()]


def _hold_ui_healthy(port: int) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/health", timeout=1.0
        ) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError):
        return False


def _hold_ui_lan_exposed(port: int) -> str | None:
    """Is the held UI reachable from OFF this machine? Returns the reachable
    address, or None when it is loopback-only.

    The prompt REQUIRES the artifact to bind 127.0.0.1, but the agent wrote
    that server and an agent can ignore an instruction — `listen(8002)` with no
    host binds `::` (verified), publishing the game to every device on the
    operator's network. So this is checked, never assumed: bind the machine's
    own LAN address and see whether the port is already taken there by the
    artifact.

    A failure to determine it returns None (treated as not-exposed) — this is a
    warning surface on an operator-local review feature, and it must never fail
    a finished cell.
    """
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            # No packet is sent; this just selects the default-route interface.
            probe.connect(("192.0.2.1", 9))  # TEST-NET-1, RFC 5737
            lan_ip = probe.getsockname()[0]
        finally:
            probe.close()
    except OSError:
        return None
    if not lan_ip or lan_ip.startswith("127."):
        return None
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.5)
            if sock.connect_ex((lan_ip, port)) == 0:
                return f"{lan_ip}:{port}"
    except OSError:
        return None
    return None


def _hold_for_ui_review(
    *,
    run_label: str,
    run_dir: Path,
    worktree: Path,
    container_name: str,
    live_view_url: str,
    progress: Callable[[str], None],
) -> None:
    """Hold the cell stack for operator UI review until released.

    No-op unless BENCH_HOLD_UI=1. Boots the artifact's server host-side
    from the worktree on :8002 (the gate boot, minus Playwright), then waits on
    the RELEASE_HOLD sentinel. Never fails the cell: boot problems are logged
    and the hold still proceeds (container + worktree stay inspectable). The
    UI server is killed in a finally — the ProcessReaper does not watch 8002.
    """
    if (os.environ.get(_HOLD_UI_ENV) or "").strip() != "1":
        return

    release_path = run_dir / _HOLD_UI_RELEASE_FILE
    state_path = run_dir / _HOLD_UI_STATE_FILE
    server_log_path = run_dir / _HOLD_UI_SERVER_LOG
    url = f"http://localhost:{_HOLD_UI_PORT}"

    proc: subprocess.Popen[str] | None = None
    log_handle: Any = None
    ui_healthy = False
    boot_detail = "not_attempted"

    # A stale listener here is the audit's leaked-gate-server class; the gates
    # themselves SIGKILL it on every boot (harness.ts freePort). Mirrored.
    for pid in _hold_ui_port_listeners(_HOLD_UI_PORT):
        try:
            os.kill(pid, signal.SIGKILL)
            progress(
                f"PROGRESS run_label={run_label} step=hold-ui killed_stale_listener pid={pid}"
            )
        except OSError as exc:
            progress(
                f"PROGRESS run_label={run_label} step=hold-ui kill_stale_listener_failed pid={pid} detail={exc}"
            )

    try:
        entrypoint = _resolve_hold_ui_entrypoint(worktree)
    except RuntimeError as exc:
        boot_detail = f"entrypoint_unresolved detail={exc}"
        progress(f"PROGRESS run_label={run_label} step=hold-ui boot=fail {boot_detail}")
    else:
        try:
            log_handle = server_log_path.open("w", encoding="utf-8")
            proc = subprocess.Popen(
                ["node", str(entrypoint)],
                cwd=str(worktree),
                env={**os.environ, "DEBUG_API": "1"},
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                text=True,
                start_new_session=True,
            )
        except OSError as exc:
            boot_detail = f"spawn_failed detail={exc}"
            progress(
                f"PROGRESS run_label={run_label} step=hold-ui boot=fail {boot_detail}"
            )
            proc = None
        else:
            deadline = time.monotonic() + _HOLD_UI_HEALTH_TIMEOUT_S
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    break
                if _hold_ui_healthy(_HOLD_UI_PORT):
                    ui_healthy = True
                    break
                time.sleep(0.25)
            if ui_healthy:
                boot_detail = f"healthy pid={proc.pid} entrypoint={entrypoint}"
            elif proc.poll() is not None:
                boot_detail = (
                    f"server_exited exit={proc.returncode} log={server_log_path}"
                )
            else:
                boot_detail = f"health_timeout log={server_log_path}"
            progress(
                f"PROGRESS run_label={run_label} step=hold-ui "
                f"boot={'ok' if ui_healthy else 'fail'} {boot_detail}"
            )

    # Consume any stale sentinel from a prior hold in this run_dir BEFORE waiting.
    try:
        release_path.unlink(missing_ok=True)
    except OSError:
        pass

    # Did the artifact actually bind loopback-only, as the prompt requires?
    lan_exposure = _hold_ui_lan_exposed(_HOLD_UI_PORT) if ui_healthy else None
    if lan_exposure is not None:
        progress(
            f"PROGRESS run_label={run_label} step=hold-ui bind=LAN_EXPOSED "
            f"address={lan_exposure} detail=artifact_ignored_loopback_requirement"
        )

    state = {
        "url": url,
        "ui_healthy": ui_healthy,
        "boot_detail": boot_detail,
        "ui_pid": proc.pid if (proc is not None and proc.poll() is None) else None,
        "container_name": container_name,
        "worktree": str(worktree),
        "live_view_url": live_view_url,
        "release_cmd": f"touch {release_path}",
        "server_log": str(server_log_path),
        "started_at": _dt.datetime.now(tz=_dt.timezone.utc).isoformat(),
        # ── CONSUMABLE RELEASE CONTRACT (for the dashboard/control plane) ────
        # Deliberately NOT wired into the dashboard here — a separate agent owns
        # that. This is the stable surface it consumes.
        #
        # Release is a FILE TOUCH, not an HTTP endpoint, on purpose: the holding
        # process is a plain blocking loop with no server of its own, and giving
        # it a listening socket would add a second network surface (and a second
        # thing to secure) to a feature whose whole point is a human looking at
        # one page. A file works from the dashboard, a script, or a shell, needs
        # no auth story, and cannot be reached from off-box at all.
        "status": "held",
        "schema_version": 1,
        "release": {
            "method": "touch_file",
            "path": str(release_path),
            "poll_interval_s": _HOLD_UI_POLL_S,
            # A consumer releases the hold by creating this file. The loop polls
            # for it and tears the stack down on the next tick.
            "example_python": f"open({str(release_path)!r}, 'w').close()",
            "example_shell": f"touch {release_path}",
        },
        "bind": {
            # MEASURED, not asserted: the agent wrote the server, so whether it
            # honoured the loopback-only requirement is a fact to check.
            "expected_host": "127.0.0.1",
            "lan_reachable": lan_exposure is not None,
            "lan_address": lan_exposure,
        },
    }
    try:
        state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        progress(
            f"PROGRESS run_label={run_label} step=hold-ui state_write_failed detail={exc}"
        )

    hold_banner = (
        f"HOLD-UI ACTIVE run_label={run_label} url={url} "
        f"ui={'live' if ui_healthy else f'UNAVAILABLE ({boot_detail})'} "
        f"container={container_name} live_view={live_view_url} "
        f"release='touch {release_path}'"
    )
    progress(f"PROGRESS run_label={run_label} step=hold-ui waiting {hold_banner}")

    # The operator-facing close-out. The machine-readable banner above is for
    # the log; this is the line a human reads at the end of a run, so it leads
    # with a clickable URL and states plainly that the session is waiting on
    # them. Printed only when the UI actually booted — offering a link to a
    # server that is not listening is worse than saying nothing.
    if ui_healthy:
        if lan_exposure is None:
            reach_lines = (
                "  The page is served on loopback only — reachable from this\n"
                "  machine, not from anything else on your network.\n"
            )
        else:
            reach_lines = (
                f"  WARNING: this server is ALSO reachable at {lan_exposure}\n"
                "  — every device on your network can open it. The artifact did\n"
                "  not honour the loopback-only requirement in its prompt.\n"
            )
        operator_message = (
            f"\n{'=' * 72}\n"
            f"  game is finished — you can view it here: {url}\n"
            f"{'=' * 72}\n"
            f"  This session is now HELD and will wait until you release it.\n"
            f"{reach_lines}\n"
            f"  When you are done looking, release it with:\n"
            f"      touch {release_path}\n"
            f"{'=' * 72}\n"
        )
    else:
        operator_message = (
            f"\n{'=' * 72}\n"
            f"  game is finished, but the UI did NOT boot: {boot_detail}\n"
            f"{'=' * 72}\n"
            f"  No URL is offered because nothing is listening on {url}.\n"
            f"  Server log: {server_log_path}\n"
            f"  The container and worktree are still up for inspection.\n\n"
            f"  Release the hold with:\n"
            f"      touch {release_path}\n"
            f"{'=' * 72}\n"
        )
    print(operator_message, flush=True)

    held_at = time.monotonic()
    last_heartbeat = 0.0
    try:
        while not release_path.exists():
            now = time.monotonic()
            if now - last_heartbeat >= _HOLD_UI_HEARTBEAT_S:
                last_heartbeat = now
                server_alive = proc is not None and proc.poll() is None
                progress(
                    f"PROGRESS run_label={run_label} step=hold-ui heartbeat "
                    f"held_s={now - held_at:.0f} url={url} healthy={_hold_ui_healthy(_HOLD_UI_PORT)} "
                    f"server_alive={server_alive}"
                )
            time.sleep(_HOLD_UI_POLL_S)
    finally:
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=1.5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=1.5)
            except OSError:
                pass
        if log_handle is not None:
            try:
                log_handle.close()
            except OSError:
                pass
        remaining = _hold_ui_port_listeners(_HOLD_UI_PORT)
        if remaining:
            progress(
                f"PROGRESS run_label={run_label} step=hold-ui "
                f"port_still_occupied port={_HOLD_UI_PORT} pids={remaining} "
                "detail=not-our-server; left running"
            )
        try:
            release_path.unlink(missing_ok=True)
            state_path.unlink(missing_ok=True)
        except OSError:
            pass
        progress(
            f"PROGRESS run_label={run_label} step=hold-ui released "
            f"held_s={time.monotonic() - held_at:.0f} action=proceed-to-teardown"
        )
        print(
            f"HOLD-UI RELEASED run_label={run_label} — teardown proceeding\n",
            flush=True,
        )


# Worker-facing AGENTS.md, written into every cell worktree at seed time. The
# only .md files that reach the isolated docker worker are this one (opencode
# auto-loads /work/AGENTS.md as project instructions) and CONTRACT.md (seeded
# from the scaffold, WO-FEEDBACK-CONTRACT 2026-08-10); the repo-level AGENTS.md
# never enters the container.
#
# THERE IS NO ANTI-CHEAT RULE IN THIS FILE, and there must never be one. This
# comment used to call the two scope lines below "the explicit anti-cheat rule
# (WO-ANTICHEAT-1)", which was stale and actively misleading: the words were
# stripped long ago because `tests/test_blinding.py` FORBIDS "cheat", "grader",
# "oracle" and the rest from anything the model can read — a model that knows it
# is being measured is not the model this run is measuring. What survives reads
# as ordinary onboarding ("take a denial at face value", "stick to this
# directory") and earns its place as working guidance, not as a deterrent.
#
# Cheating is prevented STRUCTURALLY, never by instruction: the gates, the
# golden tree and the gate runner are not on the container's filesystem at all,
# the worktree is the only mount, and the container has no internet route
# (`egress.py`, four allowlisted upstreams). You cannot read what is not there.
# Do not add a "do not cheat" line here to shore that up — it would weaken the
# measurement and fail the blinding test.
#
# The other rule this file carries is the chunked-write rule, which exists
# because the model writes code in very large single generations, and one
# oversized stream can be killed mid-flight by the transport — losing the whole
# write (2026-08-09).
_WORKER_AGENTS_MD = """\
# Notes for whoever picks this up

## Scope
- CONTRACT.md in this folder is the spec. Build what it describes — it is
  complete, so you should not need anything outside this folder to finish.
- If a tool call is denied, take the denial at face value and find another way
  to do the work; don't try to route around it.
- Stick to this project directory. Nothing you need lives outside it.

## Chunk large writes — always
- Never write a large file in a single tool call. A single-shot massive write
  can be cut off mid-stream by the transport, and the entire write is lost.
- Keep every write and edit to around 150 lines or less. Start each new file
  with a bounded initial write, then grow it with successive append or edit
  calls — each its own small generation.
- The same for big rewrites: several small, targeted edits — never one giant
  replacement.
- If a write call fails or the result looks truncated, re-apply only the
  missing chunk; do not restart the file from zero unless it is corrupt.

## Long-running commands
- Start a long-lived server by launching it from a small Node launcher that
  discards its output and detaches the process, e.g.
  `node -e "const {spawn}=require('node:child_process'); spawn('node',['src/server.ts'],{stdio:'ignore',detached:true}).unref()"`.
  A bare `nohup node src/server.ts > /tmp/server.log 2>&1 &` leaves the pipe
  open, so the shell keeps waiting and the command hangs until its timeout.
- Stop what you started by PID (`kill <pid>`), not by pattern-matching on a
  wrapper name — killing `npm start` does not kill the `node` process it
  spawned, and the orphan will hold the terminal open.

## Dependencies — use what is installed
- The packages this project needs are already installed, including Playwright
  and Chromium for browser testing. Use what is present rather than adding more.
- Playwright is installed GLOBALLY, not in this project's node_modules. Load it
  with CommonJS `require('playwright')` — never `import` from 'playwright' (an
  ESM import cannot resolve the global install). Run the bare `playwright`
  command, not `npx playwright`.
- NEVER run `playwright install` or any package install — this machine has no
  network, so an install hangs and wastes the whole run.

## Tests and servers — keep them bounded
- Always run a test or a dev server with an explicit timeout; never leave
  anything running with no bound.
- Stay within this machine's compute and memory limits. An unbounded test or an
  orphaned background process can exhaust the machine and stall everything else."""

# ── PHASE SIGNALS ONLY. THE MEMORY LAYER OWNS EVERYTHING ELSE. ──────────────
#
# This is a PUBLIC benchmark: anyone plugs their own memory system in, so nothing
# here may name one. These three blocks used to carry a specific vendor's capture
# protocol — its tool name, its argument list, its fragment schema — hardcoded
# into the adapter. That is a violation of the plug-in contract and it is gone.
#
# What survives is the one thing the tree legitimately knows and a memory layer
# cannot: WHICH PHASE THE RUN IS IN. The split is now:
#
#   the tree (here)        the EVENT — "not yet", "now", "still now"
#   AGENTS.md (imported)   the memory layer's standing cadence, from
#                          BENCH_AGENTS_AUX_FILE — see _agents_md_text()
#   the tool description   the memory layer's own rules, reissued every turn
#
# So these blocks say WHEN and never HOW, and they name no tool. A memory layer
# with no notion of phases can ignore them; one that has such a notion reads them
# as the cue its own directive told the model to wait for.
#
# ── BUILD-PHASE CAPTURE REINSTATED (Jerry, 2026-09-08 — reversal) ────────────
#
# The 2026-09-04 decision to exclude capture during the build phase has been
# REVERSED. Capture during build is allowed and expected — the golden run carried
# no such exclusion. The build chunks therefore carry ONLY the chunk body (plus the
# memory-blob prepend on chunk 1): the "## Not yet / do not record" block and its
# splice are removed.
#
# The AUX cadence directive (tokp-record-mandate.md, injected via
# BENCH_AGENTS_AUX_FILE) already reaches build chunks through the standing
# AGENTS.md, so the model is told to capture during build by the memory layer's own
# mandate — never by a hardcoded adapter splice. As before, nothing is written INTO
# task/backgammon/prompts/: those six chunk files stay the fixed, certified corpus
# (dev-benchmark.md §1b), and editing them would change chunk_plan_hash and put
# memory-layer vocabulary inside the tree test_blinding.py scans.

_REPAIR_CAPTURE_REMINDER_MD = """\
## Recording

Still the time to record what you learn. When you have finished working through \
the problems above, record it the way your notes describe — same limits, same \
evidence rules."""


# ── THE RECORDING TURN ──────────────────────────────────────────────────────
#
# Sent once per chunk, AFTER the chunk drive reaches idle and BEFORE
# compaction. Since WO-MARKER-RIP it is also the drive the phase sentinel flags
# as the chunk boundary, so the compaction fires on ITS idle — the recording
# always precedes the summarize it would otherwise be summarized away by.
#
# ── WHY IT EXISTS (run 1788976174) ─────────────────────────────────────────
#
# 148 tool calls, 26 completed todos, 13 chunk boundaries, ZERO records. The
# transcript shows the model forming the intent and losing it:
#
#   [reasoning]  "Let me now record the knowledge and finish. Actually wait —
#                 I should record this chunk's learnings. Let me do that now."
#   [text]       "CHUNK FINISHED"       <- the sign-off string, since deleted
#   [step-finish] reason: "stop"
#   [compaction]  auto: true
#
# The intent lived in a reasoning block; the sign-off ended the turn; compaction
# fired into the gap. Thirteen boundaries, zero preceded by a record. The model
# was not disobeying — it had no turn left to act in. (The string is gone now,
# but the shape is not: a turn that ends is a turn with no room left in it, so
# the recording still needs a turn of its own.)
#
# ── WHY A TURN AND NOT A STRONGER INSTRUCTION ──────────────────────────────
#
# This is the golden run's own shape. `pilot-driver.py` did not ask the model to
# remember to extract; it ASKED, on every one of its 111 chunks, and the model
# could answer with an empty fragment. The forcing was in the QUESTION being
# unskippable — never in the answer being mandatory.
#
# So the flexibility is preserved exactly: the model decides what, or whether,
# to record. It just no longer has to find a moment to do it in, because the
# moment is given.
#
# ── WHY THE HARNESS SAYS NOTHING ABOUT HOW ─────────────────────────────────
#
# Same rule as every other capture surface here: `harness/` says WHEN, the memory
# layer says HOW. This names no tool and describes no shape — a plugged-in
# memory layer supplies both through its own directive. A cell with no memory
# layer reads this as a moment to reflect and moves on, which costs one turn and
# breaks nothing.
_RECORD_NOW_MD = """\
This chunk is closed. Before moving on, record what you learned from it, the way \
your notes describe.

If this chunk produced nothing worth recording, say so and move on — an empty \
stretch is an honest result, and inventing something to fill the space is worse \
than recording nothing."""


_SESSION_EXTRACTION_MD = """\
## Recording

You have moved past building and into fixing. The standing instruction in your \
notes applies here exactly as it did during the build: when you have finished \
working through the problems above, record what you learned, the way those \
notes describe.

Solving the problems above is still the job. Recording is what you do once you \
have.
"""


def _recorded_claim_count(state_dir: Path | None, session_id: str) -> int | None:
    """Claims the memory layer has persisted for this session, or None.

    Reads the plugin's own artifact rather than asking the model whether it
    recorded — the model's account of its own compliance is exactly the kind of
    self-report this project does not accept anywhere else.

    None means UNREADABLE (no layer, not written yet, malformed), which is a
    third answer and never folded into zero: "no memory layer" and "a memory
    layer that recorded nothing" are different facts.
    """
    if state_dir is None:
        return None
    master = Path(state_dir) / "insession" / session_id / "master.json"
    try:
        data = json.loads(master.read_text())
    except (OSError, ValueError):
        return None
    trajectories = data.get("trajectories")
    if not isinstance(trajectories, list):
        return None
    total = 0
    for traj in trajectories:
        knowledge = traj.get("knowledge") if isinstance(traj, dict) else None
        if isinstance(knowledge, list):
            total += len(knowledge)
    return total


def _default_progress(message: str) -> None:
    stamp = _dt.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    print(f"[bg] {stamp} {message}", flush=True)


def build_worker_opencode_config(
    *,
    model: str,
    reasoning_effort: str | None,
    proxy_base_url: str | None,
    gates_dir: str,
    golden_dir: str,
    session_id: str | None = None,
    plugin_present: bool = True,
) -> dict[str, Any]:
    config: dict[str, Any] = {
        "$schema": "https://opencode.ai/config.json",
        "model": model,
        "small_model": model,
        "shell": "/opt/okp/supervised-shell.js",
    }
    if plugin_present:
        # Plugin paths must stay in lockstep with the image-baked paths computed in
        # images/worker/Dockerfile ($(npm root -g)/@morfascolabs/opencode-plugin/plugins/*.ts).
        # self-compact.ts self-gates on OKP_SELF_COMPACT=1, so it is safe to load
        # unconditionally (a no-op in the control arm) — mirroring the Dockerfile.
        # Written ONLY when the image actually baked the plugin (label
        # okp.worker.plugin_present="1", read by docker_worker.image_plugin_present):
        # a vanilla image has no plugin files at these paths, and an opencode.json
        # pointing at absent plugins kills the worker at boot.
        config["plugin"] = [
            "/usr/local/lib/node_modules/@morfascolabs/opencode-plugin/plugins/plugin.ts",
            "/usr/local/lib/node_modules/@morfascolabs/opencode-plugin/plugins/self-compact.ts",
        ]
        config["mcp"] = {
            "okp": {
                "//": "disabled by design: use external OKP_MCP_HTTP_URL, do not auto-spawn local MCP",
                "enabled": False,
            }
        }
    config["permission"] = {
        "*": "allow",
        "external_directory": {"*": "deny"},
        "bash": {
            "*": "allow",
            f"*{gates_dir}*": "deny",
            f"*{golden_dir}*": "deny",
            "*report.mjs*": "deny",
            "*run.mjs*": "deny",
        },
        "edit": {"*": "allow", "*opencode.json": "deny"},
        "doom_loop": "deny",
        "question": "deny",
        "task": "deny",
    }
    provider_id, _, model_id = model.partition("/")
    if not provider_id or not model_id:
        return config

    if provider_id != "local-llm-proxy":
        # Cloud (OrcaRouter) branch: write the full provider block from the contract.
        # The ONLY deviation from the operator's daily block is apiKey = {env:ORCAROUTER_API_KEY}.
        options = dict(CLOUD_ORCAROUTER_PROVIDER["options"])
        if proxy_base_url is not None:
            options["baseURL"] = proxy_base_url
        config["provider"] = {
            provider_id: {
                "npm": CLOUD_ORCAROUTER_PROVIDER["npm"],
                "name": CLOUD_ORCAROUTER_PROVIDER["name"],
                "options": options,
                "models": CLOUD_ORCAROUTER_PROVIDER["models"],
            }
        }
        return config

    model_registry = WORKER_MODEL_REGISTRY.get(model_id)
    if model_registry is None:
        raise ValueError(
            f"unsupported worker model_id for opencode config: {model_id!r}"
        )

    provider_options: dict[str, Any] = {
        "apiKey": "{env:LOCAL_LLM_PROXY_API_KEY}",
    }
    if proxy_base_url is not None:
        provider_options["baseURL"] = proxy_base_url

    model_block: dict[str, Any] = dict(model_registry)
    # NOTE: Never force tool_choice="required" here. Moonshot/kimi rejects it (hard 400),
    # and harness policy is to allow normal tool autonomy.
    model_block["interleaved"] = {"field": "reasoning_content"}
    if session_id:
        model_block["headers"] = {"X-Session-Id": session_id}
    if reasoning_effort is not None:
        options = model_block.setdefault("options", {})
        options["reasoning"] = {"effort": reasoning_effort}

    provider_config: dict[str, Any] = {
        provider_id: {
            "options": provider_options,
            "models": {
                model_id: model_block,
            },
        }
    }

    if provider_config:
        config["provider"] = provider_config
    return config


def _safe_title_org_component(org_id: str | None) -> str:
    """Fold ``org_id`` to ``[A-Za-z0-9-]`` for embedding in a session title."""
    folded = re.sub(r"[^A-Za-z0-9-]+", "-", str(org_id or "")).strip("-")
    return folded or "org"


def bench_session_title(org_id: str | None, memory_mode: str, cell_ts: int) -> str:
    """Deterministic, identifiable OpenCode session title for a bench cell.

    Format: ``bench-<org_id>-<arm on|off>-<cell_ts>``. ``cell_ts`` is
    the epoch second captured ONCE at cell start, so the title is stable
    across every attempt and resume of that cell and lands verbatim in the
    exported session DB (``session.title``) for the prod dashboard.
    """
    return f"bench-{_safe_title_org_component(org_id)}-{memory_mode}-{int(cell_ts)}"


class BackgammonRunner(AgentRunner):
    def __init__(
        self,
        *,
        task_dir: Path,
        work_root: Path,
        model: str,
        memory_mode: str = "off",
        org_id: str = "",
        mock: str | None = None,
        max_attempts: int = DEFAULT_ATTEMPT_HARD_CEILING,
        resume_budget: int = 2,
        token_cap: int = 200000,
        run_timeout_s: int = DEFAULT_RUN_TIMEOUT_S,
        gate_timeout_s: int = DEFAULT_GATE_TIMEOUT_S,
        #: Fraction of the GRADING CONTAINER's own resources to use for test
        #: workers. None leaves the container's default (lib/workers.mjs).
        grader_worker_target: float | None = None,
        completion_grace_s: int = 30,
        cost_limit_usd: float | None = None,
        cost_target_usd: float | None = None,
        max_output_tokens: int | None = None,
        max_steps_per_attempt: int | None = None,
        output_price_per_1m: float | None = None,
        reasoning_effort: str | None = None,
        proxy_base_url: str | None = None,
        proxy_token: str | None = None,
        session_id: str | None = None,
        agent: str = "build",
        logger: Any = None,
        progress: Callable[[str], None] | None = None,
        gate_roster_path: Path | str | None = None,
        compact: bool = False,
        require_todos: bool = False,
        record_at_chunk_end: bool = False,
        chunk_plan_hash: str | None = None,
        template_hash: str | None = None,
        source_commit: str | None = None,
        seed_snapshot_tree: Path | None = None,
        seed_snapshot_drift: list[dict[str, str | None]] | None = None,
    ) -> None:
        # WO-GATE-ROSTER: the campaign's gate roster, written once at cell start
        # by the sequencer. Passed to `report.mjs` so it can report which gates
        # did NOT run. None is legitimate (a run predating the artifact); the
        # gate report then says so rather than inferring an empty suite.
        self.gate_roster_path = (
            Path(gate_roster_path).expanduser().resolve()
            if gate_roster_path is not None
            else None
        )
        self.task_dir = Path(task_dir).expanduser().resolve()
        self.work_root = Path(work_root).expanduser().resolve()
        self.work_root.mkdir(parents=True, exist_ok=True)

        self.model = str(model)
        # Cloud mode is DERIVED from the model slug's provider id (no separate
        # flag to drift): local slugs are `local-llm-proxy/<alias>`, cloud slugs
        # are `<router>/<provider>/<model>` (e.g. orcarouter/deepseek/...).
        self.cloud = self.model.partition("/")[0] != "local-llm-proxy"
        # ── CHUNK-BOUNDARY COMPACTION ───────────────────────────────────────
        #
        # DECLARED BY THE OPERATOR, NEVER INFERRED HERE. The control plane
        # computes the default from the model's context window and puts it in
        # the confirmation the operator reads; the adapter is told the answer.
        # Deriving it here from `self.cloud` or from a context number would be a
        # SECOND definition of the rule, free to disagree with the one the
        # operator confirmed — and the arm they confirmed is the arm that has to
        # run. Defaults False so every existing construction site (tests, mock
        # callers) keeps today's behaviour rather than silently acquiring six
        # extra model turns.
        self.compact = bool(compact)
        # Benchmark run-condition, off unless the operator asked for it.
        self.require_todos = bool(require_todos)
        # Ask for a record at every chunk boundary — the golden run's own shape.
        # See _RECORD_NOW_MD for why this is a turn rather than a stronger
        # instruction, and for the run that made it necessary.
        self.record_at_chunk_end = bool(record_at_chunk_end)
        self.memory_mode = str(memory_mode)
        # Bench identity for session titling (WO-STRIP-2b). Empty is legitimate
        # (mock/unit callers); the title then uses the "org" fallback component.
        self.org_id = str(org_id or "")
        # Set once at cell start in _run_cell_impl (stable across attempts and
        # resumes); read by the serve-session create call and the first-run argv.
        self._cell_ts: int | None = None
        self._session_title: str | None = None
        self.mock = mock
        # Corpus-identity provenance for the attempt-1 snapshot. Produced by the
        # campaign layer and threaded in — never re-derived here: a number
        # computed twice is two numbers that can disagree.
        self._chunk_plan_hash = chunk_plan_hash
        self._template_hash = template_hash
        self._source_commit = source_commit
        # WO-SNAP-04 seed branch: a resolved snapshot `tree/` directory to seed
        # the worktree from INSTEAD of the scaffold. Resolved and validated by
        # the caller (threaded from run_cumulative.py) — never re-derived here.
        # None keeps the normal scaffold seed and the normal build. When set:
        # the worktree is seeded from it, the isolation preflight asserts
        # against it (swapped, never bypassed), the chunked build is skipped
        # (the snapshot IS the build work product), and the attempt-1 snapshot
        # capture is suppressed (a seeded cell has no build of its own to
        # capture — a snapshot-of-a-snapshot would be a degenerate corpus row).
        self._seed_snapshot_tree = seed_snapshot_tree
        # WO-SNAP-04B (D-SNAP-DEVMODE-EXCEPTIONS): seed-time corpus-provenance
        # drift REPORTED by the snapshot resolver and threaded here from
        # run_cumulative.py — entries are {"field", "snapshot", "running"}.
        # Empty when the running corpus matches the snapshot's.
        self._seed_snapshot_drift = (
            list(seed_snapshot_drift) if seed_snapshot_drift else []
        )
        requested_max_attempts = int(max_attempts)
        if requested_max_attempts < 1:
            raise ValueError("max_attempts must be >= 1")
        self.max_attempts = min(requested_max_attempts, DEFAULT_ATTEMPT_HARD_CEILING)
        self.resume_budget = int(resume_budget)
        if self.resume_budget < 0:
            raise ValueError("resume_budget must be >= 0")
        self.run_timeout_s = int(run_timeout_s)
        self.gate_timeout_s = int(gate_timeout_s)
        if self.gate_timeout_s <= 0:
            raise ValueError("gate_timeout_s must be > 0")
        # ── HOW MUCH OF THE MACHINE GRADING MAY USE ────────────────────────
        #
        # Passed INTO the container, never read from this host: the container
        # resolves its worker count from its own cgroup limits and this only
        # scales the fraction of them it takes. So the same setting means the
        # same thing on a laptop and on a build server, and no host's numbers
        # appear anywhere in the code.
        #
        # The operator sets it in the board's hamburger drawer. It changes how
        # LONG grading takes and must never change what it reports — the guard
        # for that is scripts/verify_worker_parity.py.
        self.grader_worker_target = (
            None if grader_worker_target is None else float(grader_worker_target)
        )
        if self.grader_worker_target is not None and not (
            0 < self.grader_worker_target <= 1
        ):
            raise ValueError("grader_worker_target must be in (0, 1]")
        self.cost_limit_usd = None if cost_limit_usd is None else float(cost_limit_usd)
        self.cost_target_usd = (
            None if cost_target_usd is None else float(cost_target_usd)
        )
        self.max_output_tokens = (
            None if max_output_tokens is None else int(max_output_tokens)
        )
        self.max_steps_per_attempt = (
            None if max_steps_per_attempt is None else int(max_steps_per_attempt)
        )
        self.output_price_per_1m = (
            None if output_price_per_1m is None else float(output_price_per_1m)
        )
        resolved_reasoning_effort: str | None
        if reasoning_effort is not None:
            resolved_reasoning_effort = str(reasoning_effort)
        else:
            # No default effort (2026-08-09 directive): the worker request
            # shape must match the daily opencode driver, which sends no
            # reasoning field. Opt-in only via arg or BENCH_REASONING_EFFORT.
            env_reasoning_effort = os.getenv(_REASONING_EFFORT_ENV)
            if env_reasoning_effort is not None and env_reasoning_effort.strip():
                resolved_reasoning_effort = env_reasoning_effort.strip()
            else:
                resolved_reasoning_effort = None
        self.reasoning_effort = resolved_reasoning_effort
        self.proxy_base_url = None if proxy_base_url is None else str(proxy_base_url)
        self.proxy_token = None if proxy_token is None else str(proxy_token)
        # Live-view topology: fixed serve ports for the persistent per-cell opencode
        # serve, defaulted from env consistent with config.RunConfig (mirror of the
        # hub_url/mcp_recall_url env-override seam).
        self.serve_host_port = int(
            os.environ.get("BENCH_SERVE_HOST_PORT") or "4096"
        )
        self.serve_container_port = int(
            os.environ.get("BENCH_SERVE_CONTAINER_PORT") or "4096"
        )
        self.session_id = None if session_id is None else str(session_id)

        # Serve-drive wiring (WO-WATCH-1E): the persistent per-cell opencode serve
        # client and its cell-scoped session id, created at cell open when a live
        # serve is up. None until/unless a serve session is established.
        self._serve_client: ServeClient | None = None
        self._cell_session_id: str | None = None

        self._effective_output_price_per_1m = 0.0
        self._cache_write_allowance_usd = 0.0
        self._fallback_attempt_estimate_usd = 0.0

        self.logger = logger
        self._progress_cb = progress or _default_progress
        self._repo_root = Path(__file__).resolve().parents[2]

        if self.memory_mode not in {"off", "on"}:
            raise ValueError("memory_mode must be 'off' or 'on'")
        if self.mock not in {None, "golden", "scaffold"}:
            raise ValueError("mock must be one of: None, 'golden', 'scaffold'")
        if int(token_cap) < 1:
            raise ValueError("token_cap must be >= 1")
        if self.run_timeout_s < 1:
            raise ValueError("run_timeout_s must be >= 1")
        if int(completion_grace_s) < 1:
            raise ValueError("completion_grace_s must be >= 1")
        if self.cost_limit_usd is not None and self.cost_limit_usd <= 0:
            raise ValueError("cost_limit_usd must be > 0")
        if self.cost_target_usd is not None and self.cost_target_usd <= 0:
            raise ValueError("cost_target_usd must be > 0")
        if self.max_output_tokens is not None and self.max_output_tokens <= 0:
            raise ValueError("max_output_tokens must be > 0")
        if self.max_steps_per_attempt is not None and self.max_steps_per_attempt <= 0:
            raise ValueError("max_steps_per_attempt must be > 0")
        if self.output_price_per_1m is not None and self.output_price_per_1m <= 0:
            raise ValueError("output_price_per_1m must be > 0")
        if self.cost_limit_usd is not None and self.cost_target_usd is not None:
            if self.cost_target_usd >= self.cost_limit_usd:
                raise ValueError("cost_target_usd must be < cost_limit_usd")

        # Single-meter budget design: proxy ledger is authoritative. The adapter keeps
        # only a conservative fallback *estimate* for attempt-cost forecasting.
        if (
            self.cost_limit_usd is not None
            and self.max_output_tokens is not None
            and self.max_steps_per_attempt is not None
        ):
            self._effective_output_price_per_1m = self._resolve_output_price_per_1m(
                model=self.model,
                explicit_output_price_per_1m=self.output_price_per_1m,
            )
            cache_write_price_per_1m = self._resolve_cache_write_price_per_1m(
                model=self.model,
                fallback_price_per_1m=self._effective_output_price_per_1m,
            )
            self._cache_write_allowance_usd = (
                float(self.max_output_tokens) * cache_write_price_per_1m / 1_000_000.0
            )
            self._fallback_attempt_estimate_usd = self._worst_case_reservation_usd(
                max_steps=self.max_steps_per_attempt,
                max_output_tokens=self.max_output_tokens,
                output_price_per_1m=self._effective_output_price_per_1m,
                safety_factor=_RESERVATION_SAFETY_FACTOR,
                cache_write_allowance_usd=self._cache_write_allowance_usd,
            )

        allowed_reasoning_efforts = {
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "none",
        }
        if (
            self.reasoning_effort is not None
            and self.reasoning_effort not in allowed_reasoning_efforts
        ):
            allowed = ", ".join(sorted(allowed_reasoning_efforts))
            raise ValueError(f"reasoning_effort must be one of: {allowed}")

    def build_need_card(self, task_id: str) -> NeedCard:
        intent = "debug" if "debug" in task_id.lower() else "build"
        return NeedCard(
            intent=intent,
            task="build a complete playable backgammon game with Node + TypeScript and backend APIs",
            language="typescript",
            stack=["backgammon", "node", "typescript"],
        )

    def _capture_attempt_one_snapshot(
        self,
        *,
        worktree: Path,
        state_hash: str | None,
        gate_totals: dict | None,
        failed_gates: list[str],
        first_run: Any,
        build_started: float | None,
        build_chunk_expected: int,
        worker_image_identity: Any,
        run_label: str,
        session_id: str | None,
        report: dict[str, Any] | None = None,
    ) -> None:
        """Copy the attempt-1 graded tree beside its gate record, or say why not.

        The attempt record carries the state hash; this carries the STATE: the
        tree the gates actually graded, plus the producer-stated provenance
        (corpus identity, worker image, build cost, void flags) that a later
        reader cannot reconstruct. Every value is stated by its producer, never
        re-derived here.

        Capture is instrumentation: it NEVER raises and never fails a cell. Any
        failure degrades to "no snapshot" plus exactly one live notice, so the
        absence is reported on the surface built to show it rather than silent.
        """
        try:
            # Same resolution as the harness's runs root (lconfig.py): env
            # override first, repo-local `runs/` otherwise.
            runs_root = Path(
                os.environ.get("BENCH_RUNS_DIR") or (self._repo_root / "runs")
            )
            snapshot_root = runs_root / "snapshots"
            snapshot_id = str(int(time.time() * 1000))
            # A cell the harness limited is not a capability result; the flag
            # travels with the snapshot so the tree is never read as one.
            cell_void = bool(
                first_run is not None
                and (
                    first_run.killed_reason in _HARNESS_LIMIT_REASONS
                    or first_run.budget_stop_detected
                    or first_run.zero_tool_turn_honest_fail
                )
            )
            provenance: dict[str, Any] = {
                "chunk_plan_hash": self._chunk_plan_hash,
                "template_hash": self._template_hash,
                "source_commit": self._source_commit,
                # Grader identity: the hash of the gate code that produced
                # this grade. A later seeded cell reuses the stored grade
                # ONLY when this hash still matches (dev-mode grade cache).
                "grader_hash": compute_grader_hash(self.task_dir / "gates"),
                "worker_image_fingerprint": (
                    worker_image_identity.to_dict()
                    if worker_image_identity is not None
                    else None
                ),
                "author_model": self.model,
                "provider": self.model.partition("/")[0],
                "memory_mode": self.memory_mode,
                "run_id": run_label,
                "cell_seq": getattr(self, "_cell_seq", None),
                "gate_totals": gate_totals,
                "failed_gates": failed_gates,
                "build_chunks": (
                    build_chunk_completion(
                        chunk_reports=first_run.chunk_reports,
                        expected=build_chunk_expected,
                        worktree=worktree,
                    )
                    if first_run is not None
                    else []
                ),
                "build_cost": {
                    "turns": first_run.turns if first_run is not None else None,
                    "total_tokens": (
                        first_run.input_tokens
                        + first_run.output_tokens
                        + first_run.reasoning_tokens
                        if first_run is not None
                        else None
                    ),
                    "wall_seconds": (
                        (time.monotonic() - build_started)
                        if build_started is not None
                        else None
                    ),
                    "wall_cost_usd": first_run.cost_usd if first_run is not None else None,
                },
                "cell_void": cell_void,
            }
            captured = capture_snapshot(
                worktree=worktree,
                snapshot_root=snapshot_root,
                snapshot_id=snapshot_id,
                state_hash=state_hash,
                state_alg=STATE_ALG,
                provenance=provenance,
            )
            if captured is not None and report is not None:
                # The grade travels with the tree: a seeded cell can reuse it
                # iff the grader is byte-identical (grader_hash above). Any
                # write failure is swallowed by the surrounding except — a
                # snapshot without its grade is simply never cache-reused.
                (captured / "grade-report.json").write_text(
                    json.dumps(report, indent=2) + "\n", encoding="utf-8"
                )
            if captured is None:
                # Failure OR a null state hash (structurally ineligible). One
                # notice, warn level: the run continues either way.
                live = getattr(self, "_live", None)
                if live is not None:
                    live.notice(
                        "harness",
                        "snapshot_capture_failed",
                        level="warn",
                        cell_seq=getattr(self, "_cell_seq", None),
                        session_id=session_id,
                        detail={"snapshot_id": snapshot_id, "attempt": 1},
                    )
        except Exception:
            # Instrumentation never kills a run: swallow, the cell carries on.
            pass

    def _record_checkpoint(
        self,
        *,
        run_dir,
        worktree,
        attempt,
        phase,
        state_hash,
        run_label,
    ):
        entry = record_checkpoint(
            run_dir=run_dir,
            worktree=worktree,
            attempt=attempt,
            phase=phase,
            state_hash=state_hash,
            run_id=str(run_label),
        )
        if entry is None:
            live = getattr(self, "_live", None)
            if live is not None:
                live.notice(
                    "harness",
                    "checkpoint_capture_failed",
                    level="warn",
                    cell_seq=getattr(self, "_cell_seq", None),
                    detail={"attempt": attempt, "phase": phase},
                )
        return entry

    def run_cell(
        self, run_label: str, run_dir: Path, task_id: str = "backgammon"
    ) -> BackgammonCellResult:
        # THE LIVE STREAM OPENS HERE, before any work, so `cell.start` (and the
        # session id on it) reaches a reader while the cell is still running
        # rather than after it ends. See LIVE-STREAM.md. Best-effort by
        # construction: a stream that cannot be written drops silently and the
        # cell is unaffected.
        self._live = LiveStream.for_run(run_dir, run_id=str(run_label))
        cell_seq = getattr(self, "_cell_seq", None)

        # WO-SNAP-04B / D-SNAP-DEVMODE-EXCEPTIONS: seed-time provenance drift
        # RELAXES snapshot validity to a warning — the ruling demotes it to a
        # reported fact, so the cell proceeds on the running corpus and is
        # never refused. Emitted at the top of the stream, before any cell
        # work can bury it; silent when the corpus matches (empty list).
        for d in self._seed_snapshot_drift:
            self._live.notice(
                "harness",
                "snapshot_validity_relaxed",
                level="warn",
                cell_seq=cell_seq,
                detail={
                    "field": d["field"],
                    "snapshot": d["snapshot"],
                    "running": d["running"],
                },
            )

        # `run.start` FIRST, so a reader that opens only this cell's stream has
        # the campaign context without going to the manifest. The roster is
        # stamped on by the sequencer (see run_cumulative.py) the same way
        # `_cell_seq` is — an adapter that predates it still works.
        self._live.emit(
            "run.start",
            task=str(task_id),
            roster=getattr(self, "_campaign_roster", None),
        )

        # ── THE CELL'S LIVENESS SIGNAL ──────────────────────────────────────
        #
        # Started before any work and stopped in a `finally`, so the stream
        # carries a beat for exactly as long as the cell is running and stops
        # the instant it is not. Everything downstream — the board's status
        # header included — derives "is this alive" from these beats and from
        # nothing else. See LIVE-STREAM.md.
        #
        # It cannot fail the cell: daemon thread, wrapped ticks, and `emit`
        # never raises. A beat that cannot be written stops the SIGNAL, which
        # correctly reads as a stall, not the RUN.
        self._heartbeat = Heartbeat(self._live, cell_seq=cell_seq)
        self._heartbeat.start()
        verdict = None
        terminal_reason = None
        terminal_exception = None
        try:
            result = self._run_cell_impl(
                run_label=run_label,
                run_dir=run_dir,
                task_id=task_id,
            )
            verdict = str(getattr(result, "verdict", "") or "") or None
            # THE FIELD IS `termination_reason`. This read `terminal_reason`,
            # which BackgammonCellResult does not have and never had, so the
            # getattr default won every time: `cell.end` carried NO terminal
            # reason for any cell that ended normally, and null values are
            # dropped from the stream by design, so the field was simply absent.
            # The one record that says WHY a cell ended was empty exactly when
            # the cell ended cleanly.
            terminal_reason = (
                str(getattr(result, "termination_reason", "") or "") or None
            )
            return result
        except BaseException as exc:  # noqa: BLE001 - re-raised below
            # SIGINT lands here too (the board's Stop sends it), and a stopped
            # cell is a terminal state a reader must be able to see. Recorded,
            # never swallowed.
            #
            # A PYTHON CLASS NAME IS NOT IN THE TERMINATION VOCABULARY, so it is
            # not written into the same field as one. `terminal_reason` keeps the
            # vocabulary's own word for "the harness itself broke"; the class name
            # travels beside it as `terminal_exception`, where a reader can see it
            # is a different kind of fact. Writing `KeyboardInterrupt` into a
            # field whose other values are `gates_green` and
            # `attempt_ceiling_reached` is how a vocabulary stops being one.
            terminal_reason = "harness_error"
            terminal_exception = type(exc).__name__
            raise
        finally:
            # THE BEAT STOPS BEFORE `cell.end` IS WRITTEN, so the last record in
            # the stream is the terminal one and no beat can arrive after it to
            # suggest the cell is still going.
            self._heartbeat.stop()
            self._live.emit(
                "cell.end",
                cell_seq=cell_seq,
                verdict=verdict,
                terminal_reason=terminal_reason,
                # Dropped when None, like every other null on this stream — so a
                # clean cell carries no exception field at all rather than an
                # empty one a reader has to interpret.
                terminal_exception=terminal_exception,
            )

    def _agents_md_text(self, run_label: str) -> str:
        """The seeded AGENTS.md: the neutral notes, plus an imported directive.

        A plugged-in memory layer needs ONE standing instruction the model can
        see for the whole session — when to record what it has learned. That
        cannot be hardcoded here: this is a public benchmark and the tree must
        know nothing about any particular memory system. So the text is IMPORTED
        at seed time from the path in ``BENCH_AGENTS_AUX_FILE``.

        Contract:

        - Env unset, or set to empty -> returns ``_WORKER_AGENTS_MD`` unchanged,
          byte for byte. This is the default, and it is what makes the repo
          clone and run with no memory layer wired at all.
        - Path set but missing/unreadable -> ABORT. A memory layer that asked
          for a directive and silently did not get one would run a whole cell
          whose model was never told to record anything, and the empty result
          would read as a finding about the memory system rather than as a
          misconfiguration.

        The directive is appended under a neutral heading — the notes are
        written in the voice of a colleague leaving handover notes, and a
        section break keeps the imported text in that voice rather than reading
        as a second document stapled on.
        """
        raw = (os.environ.get("BENCH_AGENTS_AUX_FILE") or "").strip()
        if not raw:
            return _WORKER_AGENTS_MD

        path = Path(raw)
        try:
            directive = path.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise RuntimeError(
                f"BENCH_AGENTS_AUX_FILE={path} could not be read ({exc}). "
                "A declared directive that does not arrive is a misconfiguration, "
                "never a silent no-op: the cell would run with the model never "
                "told to record anything."
            ) from exc

        if not directive:
            raise RuntimeError(
                f"BENCH_AGENTS_AUX_FILE={path} is empty. Unset the variable to "
                "run with no directive; an empty file is ambiguous."
            )

        self._progress(
            f"PROGRESS run_label={run_label} step=agents-md-aux "
            f"src={path} chars={len(directive)}"
        )
        return f"{_WORKER_AGENTS_MD}\n\n## Recording what you learn\n\n{directive}"

    @staticmethod
    def _mark_harness_resume(prev: _OpencodeRunStats | None) -> None:
        """Mark the previous invocation's last burned turn as harness-resumed.

        A follow-up ``opencode run --session <id>`` invocation (pass-injection
        or feedback) on the same session IS the retry of a turn the transport
        burned at the tail of the previous invocation. Mutates the shared
        anomaly dict so the cell ledger sees the linkage.
        """
        if prev is None or not prev.turn_anomalies:
            return
        last = prev.turn_anomalies[-1]
        if not last.get("retried"):
            last["retried"] = True
            last["retry_kind"] = "harness_resume"

    def _run_cell_impl(
        self,
        *,
        run_label: str,
        run_dir: Path,
        task_id: str,
    ) -> BackgammonCellResult:
        started = time.monotonic()
        # WO-STRIP-2b: capture the cell epoch ONCE so every surface of this
        # cell (serve session, first-run argv, result, status stream) carries
        # the identical deterministic title, stable across attempts/resumes.
        self._cell_ts = int(time.time())
        self._session_title = bench_session_title(
            self.org_id, self.memory_mode, self._cell_ts
        )
        cell_cost_usd = 0.0
        run_dir = Path(run_dir).expanduser().resolve()
        run_dir.mkdir(parents=True, exist_ok=True)

        worktree = run_dir / "worktree"
        if worktree.exists():
            shutil.rmtree(worktree)
        worktree.mkdir(parents=True, exist_ok=True)

        # WO-SNAP-04: a seeded cell starts from the declared snapshot tree; an
        # unseeded cell starts from the scaffold. Same copy, same AGENTS.md,
        # same preflight below — only the declared expected tree swaps. The
        # scaffold-copy literal is LOAD-BEARING: the AGENTS.md ordering guard
        # in tests/test_backgammon_zero_tool_resume.py indexes on it verbatim.
        if self._seed_snapshot_tree is not None:
            self._copy_tree_contents(self._seed_snapshot_tree, worktree)
        else:
            self._copy_tree_contents(self.task_dir / "scaffold", worktree)
        # No runtime/model block: naming the model back to itself is a tell
        # that something is driving it, and nothing downstream reads this.
        #
        # A STANDING DIRECTIVE IS BACK HERE (2026-09-07), and the earlier
        # objection has been answered rather than ignored. It was moved out on
        # 2026-09-04 because this file loads for the whole session, so a capture
        # instruction here sat in front of the model throughout the build; it
        # was phase-scoped onto the prompts instead. That is now the WRONG
        # shape: a memory layer that captures at work boundaries needs its
        # cadence standing for the whole session, and a prompt splice cannot
        # provide that — it decays with every compaction.
        #
        # What is different is WHERE the text comes from. This is a public
        # benchmark: anyone plugs their own memory system in, so nothing about
        # any particular one may be hardcoded here. The directive is IMPORTED at
        # seed time from BENCH_AGENTS_AUX_FILE and appended.
        # Unset -> the file is exactly _WORKER_AGENTS_MD, byte for byte, and the
        # tree clones and runs with no memory layer at all.
        (worktree / "AGENTS.md").write_text(
            self._agents_md_text(run_label), encoding="utf-8"
        )
        self._progress(
            f"PROGRESS run_label={run_label} step=worktree-seed "
            f"src={self._seed_snapshot_tree if self._seed_snapshot_tree is not None else self.task_dir / 'scaffold'} "
            f"dst={worktree}"
        )
        # ── ISOLATION PREFLIGHT (1/2): the tree the model will edit ──────────
        #
        # The rmtree + re-seed above is a REMOVAL, not a check, and a partial
        # copy or a failed delete is silent. Assert here, while the worktree is
        # exactly scaffold + AGENTS.md and before `git init` or any container
        # exists, that not one file survives from a previous cell. Back-to-back
        # runs of the SAME model are the case where inherited work is both most
        # likely and least visible — the leftovers look plausible because the
        # same model wrote them.
        # WO-SNAP-04: the expected tree SWAPS with the seed source, it is never
        # bypassed — a seeded cell asserts against its declared snapshot exactly
        # as a scaffold cell asserts against the scaffold.
        if self._seed_snapshot_tree is not None:
            assert_seeded_from_snapshot(
                worktree=worktree, snapshot_tree=self._seed_snapshot_tree
            )
        else:
            assert_clean_worktree(worktree=worktree, scaffold=self.task_dir / "scaffold")
        self._progress(
            f"PROGRESS run_label={run_label} step=isolation-worktree result=clean dst={worktree}"
        )

        pure = self._prepare_memory_mode(worktree=worktree)

        session_id: str | None = None
        input_tokens_total = 0
        output_tokens_total = 0
        # KEPT SEPARATE FROM output_tokens_total ON PURPOSE. `output_tokens_total`
        # has folded reasoning into itself since this adapter was written, so the
        # persisted `work_output_tokens` is really output+reasoning and no record
        # ever carried the split. These three exist so the board can stack a bar
        # by real category. NOTHING is subtracted from the existing totals — the
        # scored numbers are byte-identical to before.
        reasoning_tokens_total = 0
        cache_read_total = 0
        cache_write_total = 0
        turns_total = 0
        truncations_total = 0
        zero_tool_turns_total = 0
        zero_tool_resumes_total = 0
        zero_tool_turn_honest_fails_total = 0
        turn_anomalies_all: list[dict[str, Any]] = []
        unmetered_turns_total = 0
        unmetered_turn_wall_total = 0.0
        prev_run_stats: _OpencodeRunStats | None = None
        # Set once the capture protocol has been delivered on a troubleshooting
        # round. One session throughout, so it only needs sending once.
        sent_capture_protocol = False

        # `<worktree>.events.jsonl` USED TO BE DECLARED HERE and is gone: the
        # stdout transport that wrote it was deleted in the serve-only
        # migration, and its three readers have all been re-pointed or removed
        # (2026-09-04). `.user-events.jsonl` below is a DIFFERENT file with a
        # live writer (`_append_user_event`) — do not confuse the two.
        user_events_path = Path(f"{worktree}.user-events.jsonl")

        attempt_reports: list[dict[str, Any]] = []
        final_report: dict[str, Any] = {}
        verdict = "FAIL"
        attempts_to_green: int | str = "FAIL"
        termination_reason = "pending"
        _worker_exit_annot: str | None = None
        first_run: _OpencodeRunStats | None = None
        # Monotonic clock start of the chunked build, for the attempt-1
        # snapshot's build wall time. Stays None in mock mode (honest absence:
        # no build ran, so no build wall exists to report).
        build_started: float | None = None
        # How many chunks the build SHOULD have run, for the completion rows
        # below: a chunk that never got a turn has no report to count.
        build_chunk_expected: int = 0

        worker_killed_reason: str | None = None
        observed_attempt_costs: list[float] = []
        attempt_costs_usd: dict[int, float] = {}
        active_cell: DockerCell | None = None
        cell_context: Any = nullcontext()
        worker_image_identity: ImageFingerprint | None = None

        if self.mock in {"golden", "scaffold"}:
            mock_src = self.task_dir / str(self.mock)
            self._copy_tree_contents(mock_src, worktree)
            self._progress(
                f"PROGRESS run_label={run_label} step=worker-launch mode=mock mock={self.mock}"
            )
        else:
            docker_ok, docker_detail = docker_available()
            if not docker_ok:
                raise RuntimeError(
                    "Docker required for isolated worker; "
                    f"docker preflight failed: {docker_detail}"
                )
            worker_image_identity = worker_image_fingerprint()
            if worker_image_identity is None:
                raise RuntimeError(
                    "Docker worker image missing. "
                    "Build it with: .venv/bin/python scripts/rebuild_worker_image.py"
                )
            # WO-SEP-02 phase 3: read the image-baked plugin label ONCE per cell,
            # next to the image identity probe, and stash it on self. The
            # per-cell opencode.json plugin/mcp paths are gated on it. The flag
            # travels via self because all three call sites must keep the exact
            # spelling `_write_worker_permission_config(worktree=worktree)` —
            # the ordering guard in test_backgammon_zero_tool_resume.py indexes
            # on that literal.
            self._plugin_present = image_plugin_present()

            sanitized_label = re.sub(r"[^a-zA-Z0-9_.-]", "-", run_label)
            container_name = f"bench-cell-{sanitized_label}"
            stale_rm = subprocess.run(
                ["docker", "rm", "-f", container_name],
                capture_output=True,
                text=True,
                check=False,
            )
            stale_detail = (stale_rm.stderr or stale_rm.stdout or "").strip()
            if stale_rm.returncode == 0:
                self._progress(
                    "PROGRESS run_label="
                    f"{run_label} step=docker-stale-remove name={container_name} detail={stale_detail or 'removed'}"
                )
            elif "no such container" in stale_detail.lower():
                self._progress(
                    f"PROGRESS run_label={run_label} step=docker-stale-remove name={container_name} detail=already-absent"
                )
            else:
                raise RuntimeError(
                    f"failed to remove stale docker container name={container_name}: "
                    f"{stale_detail or f'exit={stale_rm.returncode}'}"
                )

            # ── ISOLATION PREFLIGHT (2/2): no container or session DB survives ──
            #
            # The `docker rm -f` above can exit 0 while a container lingers on a
            # wedged daemon, and the session-DB volume is removed later still.
            # Verify by asking docker what actually exists, by EXACT name only:
            # the memory system is a separately-managed process whose survival
            # across runs is the experiment, and nothing here may enumerate or
            # delete beyond this one cell's two names.
            assert_no_docker_residue(container_name=container_name)
            self._progress(
                f"PROGRESS run_label={run_label} step=isolation-docker result=clean "
                f"container={container_name}"
            )
            self._progress(
                f"PROGRESS run_label={run_label} step=worker-isolation isolation=docker "
                f"image={WORKER_IMAGE} image_id={worker_image_identity.image_id} "
                f"image_created={worker_image_identity.created} memory_mode={self.memory_mode} "
                f"container={container_name}"
            )
            self._init_worktree_git(worktree=worktree)
            cell_config = self._build_cell_config(
                worktree=worktree,
                container_name=container_name,
                # Egress contract (harness/egress.py): the sidecar name is
                # derived from the RAW run label (sha256, DNS-safe by
                # construction) — NOT the sanitized container label — so it
                # matches the URL run_cumulative/spend_key point the worker at.
                egress_host=egress_container_name(run_label),
            )
            cell_context = DockerCell(
                cell_config,
                progress=self._progress,
            )

        with cell_context as managed_cell:
            if self.mock is None:
                if not isinstance(managed_cell, DockerCell):
                    raise RuntimeError(
                        "docker worker context did not yield a DockerCell"
                    )
                active_cell = managed_cell
                self._write_worker_permission_config(worktree=worktree)

                # Live-view topology: start the persistent opencode serve for this
                # cell immediately after the container is entered, before the first
                # scored `opencode run`. Unconditional for both memory arms.
                active_cell.start_serve()
                self._progress(
                    "PROGRESS step=live-view "
                    f"serve=http://127.0.0.1:{self.serve_host_port} "
                    f"attach_cmd='opencode attach http://127.0.0.1:{self.serve_host_port}'"
                )

                # WO-WATCH-1E: establish the serve-drive session and surface it so
                # the founder can attach without hunting.
                #
                # A FAILURE HERE IS A SCORED-CELL ABORT. It used to be survivable:
                # the session id stayed None and the entire cell ran down the
                # stdout subprocess path instead, producing a cell that had never
                # touched the transport every other cell uses. There is one
                # transport now, so no session means no cell.
                serve_base = f"http://127.0.0.1:{self.serve_host_port}"
                self._serve_client = ServeClient(serve_base)
                try:
                    cell_session_id = self._serve_client.create_session(
                        title=self._session_title
                    )
                except ServeClientError as exc:
                    self._progress(
                        f"PROGRESS run_label={run_label} step=live-view "
                        f"status=abort reason=session_create_failed detail={exc}"
                    )
                    raise ServeTransportError(
                        f"could not create the serve session at {serve_base} "
                        f"({exc}) — the benchmark has one transport and this cell "
                        "cannot run without it"
                    ) from exc
                self._cell_session_id = cell_session_id
                # ── LIVE: THE JOIN KEY, PUBLISHED AT THE MOMENT IT EXISTS ───
                # Every consumer keys on session_id. Until this record existed
                # the only place it appeared was predicate-outcomes.jsonl,
                # written after the whole campaign exits — so the learning panel
                # resolved `unresolved` for entire runs. This is that fix: the
                # id is on the stream before the model takes a single turn.
                if getattr(self, "_live", None) is not None:
                    self._live.emit(
                        "cell.start",
                        cell_seq=getattr(self, "_cell_seq", None),
                        session_id=cell_session_id,
                        arm=str(getattr(self, "memory_mode", "") or "") or None,
                        model=str(getattr(self, "model", "") or "") or None,
                    )
                self._progress(
                    "PROGRESS step=live-view "
                    f"session_id={cell_session_id or 'none'} serve={serve_base} "
                    f"attach_cmd='{founder_attach_command(self.serve_host_port, cell_session_id)}'"
                )
                if cell_session_id is not None:
                    try:
                        marker = worktree.parent / "live-view.txt"
                        marker.write_text(
                            f"session_id={cell_session_id}\n"
                            f"attach_cmd={founder_attach_command(self.serve_host_port, cell_session_id)}\n"
                            f"serve=http://127.0.0.1:{self.serve_host_port}\n",
                            encoding="utf-8",
                        )
                        self._progress(f"PROGRESS step=live-view marker={marker}")
                    except OSError as exc:
                        self._progress(
                            f"PROGRESS step=live-view marker_write_failed detail={exc}"
                        )

                chunk_prompts = self._load_chunk_prompts()
                build_chunk_expected = len(chunk_prompts)
                task_prompt = self._joined_chunk_prompt(chunk_prompts)
                self._progress(
                    f"PROGRESS run_label={run_label} step=worker-launch-start mode=real model={self.model} "
                    f"pure={pure} prompt_chars={len(task_prompt)} prompt_chunks={len(chunk_prompts)} "
                    "prompt_delivery=stdin"
                )
                self._emit_cost_target_warning_if_reached(
                    run_label=run_label,
                    phase="initial",
                    cumulative_cost_usd=cell_cost_usd,
                )

                budget_decision = self._budget_decision_for_attempt(
                    run_label=run_label,
                    attempt=1,
                    observed_attempt_costs=observed_attempt_costs,
                )
                if budget_decision == "harness_error":
                    verdict = "FAIL"
                    attempts_to_green = "FAIL"
                    termination_reason = "harness_error"
                elif budget_decision == "budget_stop":
                    verdict = "BUDGET_STOP"
                    attempts_to_green = "BUDGET_STOP"
                    termination_reason = "attempts_exhausted_by_budget"
                elif self._seed_snapshot_tree is not None:
                    # ── WO-SNAP-04 SEED BRANCH: THE BUILD ALREADY HAPPENED ──
                    #
                    # The worktree was seeded from a captured snapshot of a
                    # prior cell's graded tree, so there is no build to drive:
                    # no chunk prompt is delivered, no build cost is incurred,
                    # no build chunk exists to report. What the attempt loop
                    # and the feedback path read is this minimal post-build
                    # state:
                    #
                    # - attempt_costs_usd[1] = 0.0 mirrors the mock arm's skip
                    #   precedent below, so budget accounting stays consistent.
                    # - session_id binds the cell's serve session. It is
                    #   otherwise bound ONLY from first_run.session_id inside
                    #   the build block below — and first_run.session_id IS
                    #   this same id (the chunked build drives
                    #   session_id=self._cell_session_id), which is also what
                    #   _run_cell_attempt delivers every feedback round over.
                    #   Left None, the pre-feedback guard would abort the cell
                    #   with harness_error before ANY troubleshooting round.
                    # - build_started / first_run stay None: honest absence,
                    #   exactly as the mock path — downstream reads already
                    #   tolerate None (build_chunks falls through to None,
                    #   transport_resume_count to 0).
                    # - build_chunk_expected = 0: a seeded cell ran zero build
                    #   chunks, so the result records no build-chunk rows, the
                    #   same shape the mock arm records.
                    attempt_costs_usd[1] = 0.0
                    session_id = self._cell_session_id
                    build_chunk_expected = 0
                    self._progress(
                        f"PROGRESS run_label={run_label} step=worker-launch-start mode=seeded "
                        f"seed_snapshot_tree={self._seed_snapshot_tree} build=skipped "
                        f"session_id={session_id or 'none'}"
                    )
                else:
                    # ── THE CHUNKED BUILD IS THE ONLY BUILD ─────────────────
                    #
                    # A transport fault here used to restart the entire build on
                    # the stdout path with all six chunks JOINED INTO ONE PROMPT.
                    # That is not the same experiment: the chunk boundaries are
                    # where the recording turns and the compactions happen, so
                    # the salvaged cell measured a different thing under the same
                    # name. It aborts instead.
                    if self._serve_client is None or self._cell_session_id is None:
                        raise ServeTransportError(
                            "no serve session for the chunked build — the "
                            "benchmark has one transport and there is no second "
                            "way to run this cell"
                        )
                    build_started = time.monotonic()
                    try:
                        first_run = self._run_opencode_serve_chunked(
                            active_cell=active_cell,
                            serve_client=self._serve_client,
                            session_id=self._cell_session_id,
                            prompts=chunk_prompts,
                            run_label=run_label,
                            sidecar_path=user_events_path,
                            prior_cost_usd=cell_cost_usd,
                            timeout_s=self.run_timeout_s,
                            kill_hook=active_cell.kill_worker_processes,
                            # Where the memory layer persists its master — the
                            # harness reads it to MEASURE whether the recording
                            # turn landed, rather than trusting a self-report.
                            extraction_state_dir=active_cell.config.extraction_state_host_path,
                        )
                    except ServeTransportError:
                        raise
                    except Exception as exc:
                        self._progress(
                            f"PROGRESS run_label={run_label} step=serve-drive "
                            f"phase=initial status=abort reason=exception detail={exc}"
                        )
                        raise ServeTransportError(
                            f"the chunked build failed on the serve transport ({exc}) "
                            "— aborting rather than salvaging it by another route"
                        ) from exc
                    self._progress(
                        f"PROGRESS run_label={run_label} step=serve-drive "
                        f"phase=initial status=used"
                    )
                    attempt_costs_usd[1] = first_run.cost_usd
                    observed_attempt_costs.append(first_run.cost_usd)
                    cell_cost_usd += first_run.cost_usd
                    session_id = first_run.session_id
                    input_tokens_total += first_run.input_tokens
                    output_tokens_total += (
                        first_run.output_tokens + first_run.reasoning_tokens
                    )
                    reasoning_tokens_total += first_run.reasoning_tokens
                    cache_read_total += first_run.cache_read_tokens
                    cache_write_total += first_run.cache_write_tokens
                    turns_total += first_run.turns
                    truncations_total += first_run.truncations
                    zero_tool_turns_total += first_run.zero_tool_turns
                    zero_tool_resumes_total += first_run.zero_tool_resumes
                    if first_run.zero_tool_turn_honest_fail:
                        zero_tool_turn_honest_fails_total += 1
                    turn_anomalies_all.extend(first_run.turn_anomalies)
                    unmetered_turns_total += first_run.unmetered_turns
                    unmetered_turn_wall_total += first_run.unmetered_turn_wall_s
                    prev_run_stats = first_run
                    worker_killed_reason = first_run.killed_reason
                    self._progress(
                        f"PROGRESS run_label={run_label} step=worker-launch-end mode=real "
                        f"exit={first_run.exit_code} killed={first_run.killed_reason or 'none'} "
                        f"turns={first_run.turns} input={first_run.input_tokens} "
                        f"output={first_run.output_tokens} reasoning={first_run.reasoning_tokens} "
                        f"session_id={session_id or 'none'} cost_usd={first_run.cost_usd:.4f} "
                        f"cell_cost_usd={cell_cost_usd:.4f}"
                    )

                    if first_run.budget_stop_detected:
                        verdict = "BUDGET_STOP"
                        attempts_to_green = "BUDGET_STOP"
                        termination_reason = "budget_stop_mid_attempt"
                    elif first_run.zero_tool_turn_honest_fail:
                        verdict = "FAIL"
                        attempts_to_green = "FAIL"
                        termination_reason = "zero_tool_turn_honest_fail"
                    elif (
                        first_run.exit_code not in (0, None)
                        and first_run.killed_reason not in _HARNESS_LIMIT_REASONS
                    ):
                        # D-EXIT1-TERMINAL: stream-incomplete is transport, not terminal.
                        # Resume from checkpoint; keep _can_feedback=True.
                        if first_run.exit_code == 1 and self._detect_stream_incomplete(
                            first_run
                        ):
                            self._progress(
                                f"PROGRESS run_label={run_label} step=transport-stoppage "
                                f"phase=initial exit_code=1 finish_reason=stream-incomplete "
                                f"resume_budget={self.resume_budget} session_id={first_run.session_id or 'none'}"
                            )
                            first_run = _OpencodeRunStats(
                                input_tokens=first_run.input_tokens,
                                output_tokens=first_run.output_tokens,
                                reasoning_tokens=first_run.reasoning_tokens,
                                turns=first_run.turns,
                                session_id=first_run.session_id,
                                killed_reason=None,
                                exit_code=None,
                                cost_usd=first_run.cost_usd,
                                budget_stop_detected=first_run.budget_stop_detected,
                                budget_stop_signature=first_run.budget_stop_signature,
                                truncations=first_run.truncations,
                                zero_tool_turns=first_run.zero_tool_turns,
                                terminal_zero_tool_turn=first_run.terminal_zero_tool_turn,
                                zero_tool_resumes=first_run.zero_tool_resumes,
                                zero_tool_turn_honest_fail=first_run.zero_tool_turn_honest_fail,
                                resume_count=1,
                                turn_anomalies=first_run.turn_anomalies,
                                unmetered_turns=first_run.unmetered_turns,
                                unmetered_turn_wall_s=first_run.unmetered_turn_wall_s,
                            )
                            if self.resume_budget > 0:
                                self._progress(
                                    f"PROGRESS run_label={run_label} step=transport-resume-allowed "
                                    f"phase=initial resume_count=1 budget={self.resume_budget}"
                                )
                            # _can_feedback stays True (_worker_exit_annot is still None)
                        else:
                            verdict = "FAIL"
                            attempts_to_green = "FAIL"
                            termination_reason = "harness_error"
                            _worker_exit_annot = "harness_error"
            else:
                attempt_costs_usd[1] = 0.0

            # WO-ABORT: a build that fell through every recovery branch with a
            # chunk missing is an incomplete build — abort, never grade. The
            # branches above (budget_stop, zero-tool honest fail,
            # stream-incomplete resume, harness_error) each already made their
            # own terminal/resume decision for a partial build; this fires only
            # on the case none of them claimed (e.g. a chunk stalled on a
            # HARNESS-LIMIT reason and the driver early-returned).
            if (
                first_run is not None
                and build_chunk_expected
                and not first_run.budget_stop_detected
                and not first_run.zero_tool_turn_honest_fail
                and first_run.resume_count == 0
                and _worker_exit_annot is None
            ):
                completion = build_chunk_completion(
                    chunk_reports=first_run.chunk_reports,
                    expected=build_chunk_expected,
                )
                incomplete = [
                    row for row in completion if row["state"] != "complete"
                ]
                if incomplete:
                    detail = ", ".join(
                        f"chunk {row['chunk']} {row['state']}" for row in incomplete
                    )
                    raise IncompleteBuildError(
                        f"chunked build incomplete: {detail} "
                        f"(expected {build_chunk_expected} chunks)"
                    )

            # D-GATE-COUPLE: gates run regardless of termination_reason.
            # harness_error is an ANNOTATION on the cell, not a skip.
            _can_feedback = _worker_exit_annot is None
            for attempt in range(1, self.max_attempts + 1):
                report_json = run_dir / f"attempt-{attempt}-report.json"
                gate_log = run_dir / f"attempt-{attempt}-gate.log"
                self._progress(
                    f"PROGRESS run_label={run_label} step=gate-attempt-start attempt={attempt} target={worktree}"
                )
                # Dev-mode grade cache: a seeded attempt 1 reuses the grade
                # stored beside its snapshot tree ONLY when the grader is
                # byte-identical; a miss (or any other arm) grades for real
                # below, exactly as before.
                report = None
                if (
                    attempt == 1
                    and self._seed_snapshot_tree is not None
                    and self.mock is None
                ):
                    report = self._load_cached_grade(
                        Path(self._seed_snapshot_tree).parent
                    )
                if report is None:
                    try:
                        report = self._run_gate_report(
                            worktree=worktree,
                            report_path=report_json,
                            log_path=gate_log,
                            attempt=attempt,
                        )
                    except GateTimeoutError as exc:
                        # A STALL IS NOT A VERDICT (WO-FEEDBACK-1).
                        #
                        # This exception was raised and never caught anywhere in the
                        # repo, so a timed-out gate propagated out of run_cell and
                        # ABORTED THE CAMPAIGN. The evidence existed (gate log,
                        # `step=gate-timeout`) but never reached the scored
                        # artifacts, so the canonical impractical-not-impossible
                        # event was the one outcome the record could not express.
                        #
                        # The gate was KILLED: nothing was measured. That is not the
                        # model failing, and it must never be recorded as such —
                        # hence its own termination_reason, and an
                        # `attempts_to_green` that says so in words rather than
                        # borrowing FAIL.
                        verdict = "FAIL"
                        attempts_to_green = "GATE_TIMEOUT"
                        termination_reason = "gate_timeout"
                        self._progress(
                            f"PROGRESS run_label={run_label} step=gate-timeout-recorded "
                            f"attempt={attempt} termination_reason=gate_timeout detail={exc}"
                        )
                        if _worker_exit_annot != "harness_error":
                            # Computed once inside the guard for both consumers:
                            # the attempt record and the check-point. A
                            # harness_error-annotated gate-timeout gets neither,
                            # matching the normal-path hook's guard.
                            attempt_state_hash = _snapshot_state_hash(worktree)
                            attempt_reports.append(
                                {
                                    "attempt": attempt,
                                    "verdict": "FAIL",
                                    "conformed": False,
                                    "n_problems": 0,
                                    # Empty, NOT populated with the suite: no gate
                                    # failed, the runner was killed before it could
                                    # say. Inventing failures here would attribute a
                                    # harness death to the model.
                                    "failed_gates": [],
                                    # None, not [] — "not published" rather than
                                    # "published and empty" (invariants I-2 / I-4).
                                    "gate_results": None,
                                    "gate_totals": None,
                                    "state_hash": attempt_state_hash,
                                    "state_alg": STATE_ALG,
                                    "gate_timeout": True,
                                    "attempt_cost_usd": float(
                                        attempt_costs_usd.get(attempt, 0.0)
                                    ),
                                    "parity_pending": True,
                                }
                            )
                            self._record_checkpoint(
                                run_dir=run_dir,
                                worktree=worktree,
                                attempt=attempt,
                                phase=(
                                    "initial" if attempt == 1 else f"feedback-{attempt - 1}"
                                ),
                                state_hash=attempt_state_hash,
                                run_label=run_label,
                            )
                        break
                    except GraderReportUnreadableError as exc:
                        # NO REPORT MEANS NOTHING WAS MEASURED (WO-34-A).
                        #
                        # The gate oracle produced no readable report: missing,
                        # truncated, or not valid JSON. No verdict ever existed,
                        # so this is an instrument failure — it must never be
                        # scored as a model failure, and must never abort the
                        # campaign. Hence its own termination_reason, and an
                        # `attempts_to_green` that says so in words rather than
                        # borrowing FAIL.
                        verdict = "FAIL"
                        attempts_to_green = "GRADER_REPORT_UNREADABLE"
                        termination_reason = "grader_report_unreadable"
                        self._progress(
                            f"PROGRESS run_label={run_label} step=grader-report-unreadable-recorded "
                            f"attempt={attempt} termination_reason=grader_report_unreadable detail={exc}"
                        )
                        if _worker_exit_annot != "harness_error":
                            # Computed once inside the guard for both consumers:
                            # the attempt record and the check-point. A
                            # harness_error-annotated gate-timeout gets neither,
                            # matching the normal-path hook's guard.
                            attempt_state_hash = _snapshot_state_hash(worktree)
                            attempt_reports.append(
                                {
                                    "attempt": attempt,
                                    "verdict": "FAIL",
                                    "conformed": False,
                                    "n_problems": 0,
                                    # Empty, NOT populated with the suite: no gate
                                    # failed, the runner was killed before it could
                                    # say. Inventing failures here would attribute a
                                    # harness death to the model.
                                    "failed_gates": [],
                                    # None, not [] — "not published" rather than
                                    # "published and empty" (invariants I-2 / I-4).
                                    "gate_results": None,
                                    "gate_totals": None,
                                    "state_hash": attempt_state_hash,
                                    "state_alg": STATE_ALG,
                                    "grader_report_unreadable": True,
                                    "attempt_cost_usd": float(
                                        attempt_costs_usd.get(attempt, 0.0)
                                    ),
                                    "parity_pending": True,
                                }
                            )
                            self._record_checkpoint(
                                run_dir=run_dir,
                                worktree=worktree,
                                attempt=attempt,
                                phase=(
                                    "initial" if attempt == 1 else f"feedback-{attempt - 1}"
                                ),
                                state_hash=attempt_state_hash,
                                run_label=run_label,
                            )
                        break
                final_report = report

                attempt_verdict = str(report.get("verdict", "FAIL"))
                conformed = bool(report.get("conformed", False))
                problems = (
                    report.get("problems")
                    if isinstance(report.get("problems"), list)
                    else []
                )
                failed_gates_raw = report.get("failed_gates")
                failed_gates = (
                    [str(item) for item in failed_gates_raw]
                    if isinstance(failed_gates_raw, list)
                    else []
                )
                # WO-GATE-ROSTER. Carried through as-published, or None when the
                # gate runner did not emit them (no roster, or an older report).
                # None and [] mean different things here and must stay distinct:
                # [] would assert "the suite ran and held no gates".
                gate_results_raw = report.get("gate_results")
                gate_results = (
                    gate_results_raw if isinstance(gate_results_raw, list) else None
                )
                gate_totals_raw = report.get("gate_totals")
                gate_totals = (
                    gate_totals_raw if isinstance(gate_totals_raw, dict) else None
                )

                # ── LIVE: ONE RECORD PER GATE, AS THE VERDICT LANDS ─────────
                # `attempt_reports` below is written to manifest.status.jsonl
                # only when the whole CELL finishes, so a wall fed from that
                # file snaps from empty to final and shows nothing across the
                # four verdict-passes in between. These records are the same
                # facts, emitted at the moment they become true.
                #
                # This is NOT a second derivation of gate state: the payload is
                # the runner's own published `gate_results` rows, passed through
                # untouched. There is no in-flight or provisional square — a
                # gate appears only once it has a real recorded verdict.
                live = getattr(self, "_live", None)
                if live is not None:
                    # No `phase.start` here: this site is where an attempt
                    # ENDS. Each gate row carries its own `phase` from the
                    # runner, which is the phase fact the wall actually needs.
                    for row in gate_results or []:
                        if not isinstance(row, dict):
                            continue
                        live.emit(
                            "gate.result",
                            cell_seq=getattr(self, "_cell_seq", None),
                            session_id=session_id,
                            attempt=attempt,
                            id=row.get("id"),
                            status=row.get("status"),
                            phase=row.get("phase"),
                            duration_ms=row.get("duration_ms"),
                        )
                    live.emit(
                        "attempt.end",
                        cell_seq=getattr(self, "_cell_seq", None),
                        session_id=session_id,
                        attempt=attempt,
                        verdict=attempt_verdict,
                        conformed=conformed,
                        failed=len(failed_gates),
                    )

                if _worker_exit_annot != "harness_error":
                    attempt_state_hash = _snapshot_state_hash(worktree)
                    attempt_reports.append(
                        {
                            "attempt": attempt,
                            "verdict": attempt_verdict,
                            "conformed": conformed,
                            "n_problems": len(problems),
                            "failed_gates": failed_gates,
                            "gate_results": gate_results,
                            "gate_totals": gate_totals,
                            # Captured NOW, not reconstructed later: this is the
                            # only moment this attempt's code exists on disk.
                            "state_hash": attempt_state_hash,
                            "state_alg": STATE_ALG,
                            "attempt_cost_usd": float(
                                attempt_costs_usd.get(attempt, 0.0)
                            ),
                            # Scored cell whose metering awaits parity confirmation against the
                            # first scored cell / the proxy log before it is treated as data.
                            "parity_pending": True,
                        }
                    )
                    self._record_checkpoint(
                        run_dir=run_dir,
                        worktree=worktree,
                        attempt=attempt,
                        phase=(
                            "initial" if attempt == 1 else f"feedback-{attempt - 1}"
                        ),
                        state_hash=attempt_state_hash,
                        run_label=run_label,
                    )
                    # WO-SNAP-04 (F3): a seeded cell captures NOTHING at
                    # attempt 1. Its tree is a prior cell's snapshot, and it
                    # has no build work product of its own (first_run/build
                    # cost are honest absences) — capturing would write a
                    # degenerate snapshot-of-a-snapshot with a null build_cost
                    # into the corpus. The attempt-1 gate report above already
                    # grades the seeded tree; that grade is the record.
                    if attempt == 1 and self._seed_snapshot_tree is None:
                        self._capture_attempt_one_snapshot(
                            worktree=worktree,
                            state_hash=attempt_state_hash,
                            gate_totals=gate_totals,
                            failed_gates=failed_gates,
                            first_run=first_run,
                            build_started=build_started,
                            build_chunk_expected=build_chunk_expected,
                            worker_image_identity=worker_image_identity,
                            run_label=run_label,
                            session_id=session_id,
                            report=report,
                        )
                self._progress(
                    f"PROGRESS gate attempt={attempt} verdict={attempt_verdict} "
                    f"conformed={conformed} problems={len(problems)}"
                )

                if attempt_verdict == "PASS":
                    verdict = "PASS"
                    attempts_to_green = attempt - 1
                    termination_reason = "gates_green"
                    break

                if attempt >= self.max_attempts:
                    verdict = "FAIL"
                    attempts_to_green = "DID_NOT_CONFORM" if not conformed else "FAIL"
                    if _worker_exit_annot == "harness_error":
                        termination_reason = "harness_error"
                    elif _worker_exit_annot is not None:
                        termination_reason = "transport_incomplete"
                    else:
                        termination_reason = "attempt_ceiling_reached"
                    break

                if worker_killed_reason in _HARNESS_LIMIT_REASONS:
                    self._progress(
                        f"PROGRESS run_label={run_label} step=attempt-harness-limit attempt={attempt} "
                        f"reason={worker_killed_reason} decision=continue_if_budget"
                    )
                elif worker_killed_reason is not None:
                    self._progress(
                        f"PROGRESS run_label={run_label} step=attempt-harness-limit attempt={attempt} "
                        f"reason={worker_killed_reason} decision=stop"
                    )
                    verdict = "FAIL"
                    attempts_to_green = "DID_NOT_CONFORM" if not conformed else "FAIL"
                    termination_reason = "harness_error"
                    break

                if _can_feedback is False:
                    self._progress(
                        f"PROGRESS run_label={run_label} step=feedback-skip attempt={attempt} "
                        f"reason={_worker_exit_annot} no_working_session"
                    )
                    if _worker_exit_annot == "harness_error":
                        termination_reason = "harness_error"
                    elif _worker_exit_annot is not None:
                        termination_reason = "transport_incomplete"
                    else:
                        termination_reason = "gates_failed"
                    break

                if self.mock is not None:
                    self._progress(
                        f"PROGRESS run_label={run_label} step=feedback-skip attempt={attempt} reason=mock_mode"
                    )
                    continue

                if active_cell is None:
                    self._progress(
                        f"PROGRESS run_label={run_label} step=feedback-stop attempt={attempt} "
                        "reason=active_cell_missing"
                    )
                    verdict = "FAIL"
                    attempts_to_green = "DID_NOT_CONFORM" if not conformed else "FAIL"
                    termination_reason = "harness_error"
                    break

                if not session_id:
                    self._progress(
                        f"PROGRESS run_label={run_label} step=feedback-stop attempt={attempt} "
                        "reason=session_id_missing"
                    )
                    verdict = "FAIL"
                    attempts_to_green = "DID_NOT_CONFORM" if not conformed else "FAIL"
                    termination_reason = "harness_error"
                    break

                next_attempt = attempt + 1
                budget_decision = self._budget_decision_for_attempt(
                    run_label=run_label,
                    attempt=next_attempt,
                    observed_attempt_costs=observed_attempt_costs,
                )
                if budget_decision == "harness_error":
                    verdict = "FAIL"
                    attempts_to_green = "DID_NOT_CONFORM" if not conformed else "FAIL"
                    termination_reason = "harness_error"
                    break
                if budget_decision == "budget_stop":
                    verdict = "BUDGET_STOP"
                    attempts_to_green = "BUDGET_STOP"
                    termination_reason = "attempts_exhausted_by_budget"
                    break

                # D-EXIT1-TERMINAL: check transport resume budget
                if self.resume_budget <= 0:
                    self._progress(
                        f"PROGRESS run_label={run_label} step=transport-resume-exhausted "
                        f"attempt={attempt} resume_budget=0"
                    )
                    verdict = "FAIL"
                    attempts_to_green = "FAIL"
                    termination_reason = "transport_incomplete"
                    break

                # Never pass tool_choice="required" via worker config/CLI for these
                # runs; provider path rejects it and the harness guard test enforces this.

                newly_passing = (
                    sorted(
                        set(attempt_reports[-2]["failed_gates"])
                        - set(attempt_reports[-1]["failed_gates"])
                    )
                    if len(attempt_reports) >= 2
                    else []
                )
                still_failing = sorted(set(attempt_reports[-1]["failed_gates"]))
                self._progress(
                    f"PROGRESS run_label={run_label} step=feedback-verdict-composed attempt={attempt} "
                    f"newly_passing_count={len(newly_passing)} still_failing_count={len(still_failing)}"
                )

                next_attempt_cost_usd = 0.0
                # WO-FEEDBACK-ONEPHASE: ONE prompt per troubleshooting round.
                # The pass verdict is no longer a separate `_run_cell_attempt`
                # (`verdict-pass-N`); it is folded into the single feedback
                # message below. Empty string when nothing newly passed.
                pass_verdict = self._build_pass_verdict(newly_passing=newly_passing)

                feedback_checks = [
                    str(p.get("check", "")).strip()
                    for p in problems
                    if isinstance(p, dict) and str(p.get("check", "")).strip()
                ]
                # THE GRADIENT (WO-FEEDBACK-1): a gate that ALSO failed last
                # attempt gets one line of observed evidence attached, so the
                # message the model receives actually changes when its fix did
                # not work. Keyed on the raw gate id — the same strings
                # `failed_gates` carries — so the match is exact. Harness-infra
                # check names are excluded on BOTH sides: they are not gates,
                # and a repeat infra failure must not leak into the prompt as
                # if it were model-repairable work.
                infra = {c for c in feedback_checks if self._is_harness_infra_check(c)}
                repeat_checks = (
                    {
                        c
                        for c in set(attempt_reports[-2]["failed_gates"])
                        & set(attempt_reports[-1]["failed_gates"])
                        if c not in infra
                    }
                    if len(attempt_reports) >= 2
                    else set()
                )
                feedback = self._build_feedback_prompt(
                    problems=problems,
                    # TROUBLESHOOTING IS WHERE CAPTURE HAPPENS. The full protocol
                    # rides the FIRST feedback round of the session and later
                    # rounds get a short reminder: it is one opencode session
                    # throughout, so the protocol stays in context once sent, and
                    # repeating 11.6k characters every round would burn tokens on
                    # the phase the measurement is actually about.
                    capture_protocol=not sent_capture_protocol,
                    # WHICH OPENER. "I've checked your resolution for the
                    # problems that were given before" is only true once the
                    # model has actually been given a list before — which is
                    # any attempt past the first. It used to key on whether
                    # something newly PASSED, which is a different fact: a
                    # second round where nothing improved would have re-opened
                    # with "I've checked your work thoroughly", as though the
                    # player had never reported anything.
                    had_prior_feedback=len(attempt_reports) >= 2,
                    repeat_checks=repeat_checks,
                )
                # WO-FEEDBACK-ONEPHASE: fold the pass verdict into the single
                # round message — the player acknowledges what is fixed, then
                # lists what is still broken. One prompt, not two.
                if pass_verdict:
                    feedback = f"{pass_verdict}\n\n{feedback}"
                self._progress(
                    f"PROGRESS run_label={run_label} step=feedback-problems-only-built attempt={attempt} "
                    f"checks={len(feedback_checks)} repeats={len(repeat_checks)} "
                    f"capture_protocol={'full' if not sent_capture_protocol else 'reminder'}"
                )
                sent_capture_protocol = True
                self._progress(
                    f"PROGRESS run_label={run_label} step=feedback-injection attempt={attempt} "
                    f"problem_count={len(problems)} session_id={session_id}"
                )

                self._emit_cost_target_warning_if_reached(
                    run_label=run_label,
                    phase=f"feedback-{attempt}",
                    cumulative_cost_usd=cell_cost_usd,
                )

                self._append_user_event(
                    kind="feedback",
                    run_label=run_label,
                    sidecar_path=user_events_path,
                    attempt=next_attempt,
                    text=feedback,
                )

                self._write_worker_permission_config(worktree=worktree)

                self._mark_harness_resume(prev_run_stats)
                feedback_run = self._run_cell_attempt(
                    active_cell=active_cell,
                    run_label=run_label,
                    phase=f"feedback-{attempt}",
                    prior_cost_usd=cell_cost_usd,
                    kill_hook=active_cell.kill_worker_processes,
                    stdin_text=feedback,
                )
                next_attempt_cost_usd += feedback_run.cost_usd
                attempt_costs_usd[next_attempt] = next_attempt_cost_usd
                observed_attempt_costs.append(next_attempt_cost_usd)
                cell_cost_usd += feedback_run.cost_usd
                if feedback_run.session_id:
                    session_id = feedback_run.session_id

                input_tokens_total += feedback_run.input_tokens
                output_tokens_total += (
                    feedback_run.output_tokens + feedback_run.reasoning_tokens
                )
                turns_total += feedback_run.turns
                truncations_total += feedback_run.truncations
                zero_tool_turns_total += feedback_run.zero_tool_turns
                zero_tool_resumes_total += feedback_run.zero_tool_resumes
                if feedback_run.zero_tool_turn_honest_fail:
                    zero_tool_turn_honest_fails_total += 1
                turn_anomalies_all.extend(feedback_run.turn_anomalies)
                unmetered_turns_total += feedback_run.unmetered_turns
                unmetered_turn_wall_total += feedback_run.unmetered_turn_wall_s
                prev_run_stats = feedback_run
                worker_killed_reason = feedback_run.killed_reason
                self._progress(
                    f"PROGRESS run_label={run_label} step=feedback-injection-done attempt={attempt} "
                    f"exit={feedback_run.exit_code} killed={feedback_run.killed_reason or 'none'} "
                    f"turns={feedback_run.turns} input={feedback_run.input_tokens} "
                    f"output={feedback_run.output_tokens} reasoning={feedback_run.reasoning_tokens} "
                    f"cost_usd={feedback_run.cost_usd:.4f} cell_cost_usd={cell_cost_usd:.4f}"
                )
                if feedback_run.budget_stop_detected:
                    verdict = "BUDGET_STOP"
                    attempts_to_green = "BUDGET_STOP"
                    termination_reason = "budget_stop_mid_attempt"
                    break
                if feedback_run.zero_tool_turn_honest_fail:
                    verdict = "FAIL"
                    attempts_to_green = "DID_NOT_CONFORM" if not conformed else "FAIL"
                    termination_reason = "zero_tool_turn_honest_fail"
                    if attempt_reports:
                        attempt_reports[-1]["zero_tool_turn_honest_fail"] = True
                    break
                if (
                    feedback_run.exit_code not in (0, None)
                    and feedback_run.killed_reason not in _HARNESS_LIMIT_REASONS
                ):
                    verdict = "FAIL"
                    attempts_to_green = "DID_NOT_CONFORM" if not conformed else "FAIL"
                    termination_reason = "harness_error"
                    break

            # WO-HOLD-UI-1: benchmark end, stack held for operator UI review.
            # Every loop-exit path converges here; this is the last statement
            # inside the cell context, so release resumes into the normal
            # unconditional teardown (RC-6). No-op unless BENCH_HOLD_UI=1.
            if active_cell is not None:
                _hold_for_ui_review(
                    run_label=run_label,
                    run_dir=run_dir,
                    worktree=worktree,
                    container_name=active_cell.container_name,
                    live_view_url=f"http://127.0.0.1:{self.serve_host_port}",
                    progress=self._progress,
                )

        if termination_reason == "pending":
            verdict = "FAIL"
            attempts_to_green = "FAIL"
            termination_reason = "harness_error"

        wall_seconds = time.monotonic() - started
        problems_final = self._normalize_problems(final_report.get("problems"))
        failed_gates_final = self._normalize_string_list(
            final_report.get("failed_gates")
        )
        # THE AUTOMATED ANTI-CHEAT SCAN IS REMOVED (Jerry, 2026-09-04). It read
        # `<worktree>.events.jsonl`, whose only writer was the stdout subprocess
        # transport deleted in the serve-only migration — and a missing input
        # returned `cheated=False`, so every cell, honest or not, was stamped
        # "CLEAN: no oracle access detected". A check that cannot run and says
        # nothing is a broken check; one that cannot run and reports an all-clear
        # is the silent-degradation class this benchmark exists to refuse.
        #
        # The prompt-side anti-cheat RULE stays (see WO-ANTICHEAT-1 above, pinned
        # by tests/test_blinding.py), and the operator watching the live session
        # remains the backstop — which has been the standing posture since Walter
        # retired the automated verdict flip on 2026-08-10. What is gone is the
        # scan, the `CHEAT` verdict and the `CHEAT.json` marker, so nothing
        # claims a clean bill of health that was never earned.

        if attempt_reports:
            attempt_reports[-1]["termination_reason"] = termination_reason

        # The session DB is exported by the cell's teardown, which has already
        # run — the cell context closed above. Path mirrors `_cell_config`.
        tool_calls_count, test_invocations_count = self._extract_event_counts(
            worktree.parent / "session-db" / "opencode.db"
        )
        transcript_status = write_session_transcript(
            worktree.parent / "session-db" / "opencode.db",
            worktree.parent / "transcript.md",
        )
        self._progress(
            f"PROGRESS run_label={run_label} step=transcript "
            f"status={transcript_status} path={worktree.parent / 'transcript.md'}"
        )
        mapping_status = write_session_mapping(
            session_db_path=worktree.parent / "session-db" / "opencode.db",
            checkpoint_index_path=checkpoint_root(run_dir) / "index.json",
            mapping_path=worktree.parent / "mapping.json",
            user_events_path=user_events_path,
            run_id=str(run_label),
        )
        self._progress(
            f"PROGRESS run_label={run_label} step=mapping "
            f"status={mapping_status} path={worktree.parent / 'mapping.json'}"
        )
        agentic_cycles_count = self._extract_agentic_cycles(user_events_path)
        problems_before_count: int | None = None
        if attempt_reports:
            first_n_problems = attempt_reports[0].get("n_problems")
            if isinstance(first_n_problems, int):
                problems_before_count = first_n_problems

        if _worktree_has_injection_record(worktree):
            scanned_delivery = _scan_cell_delivery(worktree)
            delivery = (
                scanned_delivery if scanned_delivery is not None else "not_measured"
            )
            injected_block_chars = _scan_injected_block_chars(worktree)
            injected_block_est_tokens = (
                round(injected_block_chars / 4)
                if injected_block_chars is not None
                else None
            )
            funnel = _scan_recall_funnel(worktree)
            funnel_snapshot = _scan_funnel_snapshot(worktree)
            recall_fired_total = (
                funnel.recall_fired_total if funnel is not None else None
            )
            recall_returned_total = (
                funnel.recall_returned_total if funnel is not None else None
            )
            recall_returned_count_sum = (
                funnel.recall_returned_count_sum if funnel is not None else None
            )
            no_keywords_count = funnel.no_keywords_count if funnel is not None else None
            injected_count = funnel.injected_count if funnel is not None else None
            served_attempted = funnel.served_attempted if funnel is not None else None
            served_failed = funnel.served_failed if funnel is not None else None
            served_confirmed = funnel.served_confirmed if funnel is not None else None
        else:
            delivery = "N/A"
            injected_block_chars = None
            injected_block_est_tokens = None
            funnel_snapshot = None
            recall_fired_total = None
            recall_returned_total = None
            recall_returned_count_sum = None
            no_keywords_count = None
            injected_count = None
            served_attempted = None
            served_failed = None
            served_confirmed = None
        # Export the plugin's recall surface host-side for BOTH arms, before the
        # container is torn down. OFF cells strip the recall substrate, so their
        # telemetry is exactly the baseline the ON arm is compared against --
        # exporting only on injection-record cells would rebuild the very blind
        # spot data/ exists to close. Fail-open: never fails a cell.
        exported_to = _export_cell_telemetry(worktree, run_label, self.memory_mode)
        if exported_to is not None:
            self._progress(
                f"PROGRESS run_label={run_label} step=telemetry-export dest={exported_to}"
            )
        self._progress(
            f"PROGRESS run_label={run_label} step=delivery-scan delivery={delivery} "
            f"memory_mode={self.memory_mode}"
        )

        return BackgammonCellResult(
            build_chunks=build_chunk_completion(
                chunk_reports=(first_run.chunk_reports if first_run else ()),
                expected=build_chunk_expected,
                worktree=worktree,
            )
            if build_chunk_expected
            else None,
            verdict=verdict,
            attempts_to_green=attempts_to_green,
            termination_reason=termination_reason,
            conformed=bool(final_report.get("conformed", False)),
            input_tokens=input_tokens_total,
            output_tokens=output_tokens_total,
            reasoning_tokens=reasoning_tokens_total,
            cache_read_tokens=cache_read_total,
            cache_write_tokens=cache_write_total,
            turns=turns_total,
            wall_seconds=wall_seconds,
            delivery=delivery,
            failed_gates=failed_gates_final,
            problems_final=problems_final,
            attempt_reports=attempt_reports,
            worktree=str(worktree),
            session_id=session_id,
            session_title=self._session_title,
            memory_mode=self.memory_mode,
            model=self.model,
            wall_cost_usd=cell_cost_usd,
            tool_calls=tool_calls_count,
            test_invocations=test_invocations_count,
            agentic_cycles=agentic_cycles_count,
            problems_before=problems_before_count,
            injected_block_chars=injected_block_chars,
            injected_block_est_tokens=injected_block_est_tokens,
            recall_fired_total=recall_fired_total,
            recall_returned_total=recall_returned_total,
            recall_returned_count_sum=recall_returned_count_sum,
            no_keywords_count=no_keywords_count,
            injected_count=injected_count,
            served_attempted=served_attempted,
            served_failed=served_failed,
            served_confirmed=served_confirmed,
            funnel_snapshot=funnel_snapshot,
            truncations=truncations_total,
            zero_tool_turns=zero_tool_turns_total,
            zero_tool_resumes=zero_tool_resumes_total,
            zero_tool_turn_honest_fails=zero_tool_turn_honest_fails_total,
            transport_resume_count=first_run.resume_count if first_run else 0,
            turn_anomalies=turn_anomalies_all,
            truncated_turns=len(turn_anomalies_all),
            truncated_turns_retried=sum(
                1 for record in turn_anomalies_all if record.get("retried")
            ),
            guard_aborted_turns=sum(
                1
                for record in turn_anomalies_all
                if record.get("terminal") == TURN_TERMINAL_GUARD_ABORT
            ),
            # Every anomaly EXCEPT the loop guard and the stall watchdog — both
            # are the harness catching the model wedging a turn (looping, or a
            # tool call that never returned): model behaviour, not a broken
            # instrument.
            instrument_anomaly_turns=sum(
                1
                for record in turn_anomalies_all
                if record.get("terminal") not in (
                    TURN_TERMINAL_GUARD_ABORT,
                    TURN_TERMINAL_STALLED,
                )
            ),
            # WO-I1: the UNRECOVERED complement — every anomaly except the
            # recoverability gate's RECOVERABLE set (guard_abort,
            # transport_error+provider_unavailable,
            # transport_error+stream_finalize_timeout), regardless of whether
            # a retry actually happened. See the field's definition.
            unrecovered_anomaly_turns=sum(
                1 for record in turn_anomalies_all if _is_unrecovered_anomaly(record)
            ),
            finalize_timeout_turns=sum(
                1
                for record in turn_anomalies_all
                if record.get("terminal") == TURN_TERMINAL_TRANSPORT_ERROR
                and record.get("reason") == REASON_STREAM_FINALIZE_TIMEOUT
            ),
            stalled_turns=sum(
                1
                for record in turn_anomalies_all
                if record.get("terminal") == TURN_TERMINAL_STALLED
            ),
            observation_lost_turns=sum(
                1
                for record in turn_anomalies_all
                if record.get("terminal") == TURN_TERMINAL_OBSERVATION_LOST
            ),
            unmetered_turns=unmetered_turns_total,
            unmetered_turn_wall_s=unmetered_turn_wall_total,
            worker_image_fingerprint=worker_image_identity,
        )

    def _run_cell_attempt(
        self,
        *,
        active_cell: DockerCell,
        run_label: str,
        phase: str,
        prior_cost_usd: float,
        kill_hook: Callable[[], None] | None,
        stdin_text: str,
    ) -> _OpencodeRunStats:
        """Run ONE cell attempt, delivered over the serve session.

        WO-WATCH-1F transport unification: every scoring attempt (initial,
        feedback, pass-verdict) is delivered to the founder-visible ``opencode
        serve`` session via :meth:`_run_opencode_serve` (``prompt_async`` ->
        ``/session/status`` idle -> persisted-transcript metering) so the founder
        TUI and the transcript advance and truncation capture fires on EVERY
        attempt — not just the first.

        ONE TRANSPORT, NO SECOND ROUTE. There is no stdout fallback: an attempt
        that cannot be delivered over the serve session raises
        :class:`ServeTransportError` and the cell aborts. It used to swap
        silently to the subprocess path on any exception, which meant a single
        cell could deliver some attempts one way and some the other and report
        one set of numbers for both.

        Zero-tool-resume semantics: :func:`serve_client.extract_transcript_metrics`
        does NOT compute ``zero_tool_turns``/``terminal_zero_tool_turn`` from the
        transcript, so a serve-driven attempt cannot detect a terminal zero-tool
        turn. That detection lived only on the removed stdout subprocess
        transport (purged 2026-09-03); no real cell ever took that path once
        serve became the live transport. A serve-driven attempt IS re-driven in
        place by the WO-LOOPREC-1 loop-guard recovery inside
        :meth:`_run_opencode_serve` (bounded anti-repetition nudge on a
        ``relay_loop_detected`` terminal); no other resume nudge fires.
        """
        if self._serve_client is None or self._cell_session_id is None:
            raise ServeTransportError(
                f"no serve session for phase {phase} — the benchmark has one "
                "transport and there is no second way to deliver this attempt"
            )
        try:
            return self._run_opencode_serve(
                active_cell=active_cell,
                serve_client=self._serve_client,
                session_id=self._cell_session_id,
                prompt=stdin_text,
                run_label=run_label,
                phase=phase,
                prior_cost_usd=prior_cost_usd,
                timeout_s=self.run_timeout_s,
                kill_hook=kill_hook,
            )
        except ServeTransportError:
            raise
        except Exception as exc:
            self._progress(
                f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                f"status=abort reason=exception detail={exc}"
            )
            raise ServeTransportError(
                f"phase {phase} failed on the serve transport ({exc}) — aborting "
                "rather than delivering this attempt by another route"
            ) from exc

    def _publish_compact_phase(
        self, *, active_cell: DockerCell, phase: str, held: bool = False
    ) -> None:
        """Write the drive phase the worker's compaction arm is allowed to read.

        Only meaningful when the run is compacting; a no-op otherwise, so a
        non-``--compact`` run neither creates the directory nor pays for it.

        WRITE-THEN-RENAME. The container reads this file on every
        ``session.idle`` and must never see a half-written value; a rename is
        atomic on the host and the mount propagates the directory entry, so a
        reader gets the old phase or the new one and never a truncated one.

        A FAILURE HERE IS AN ABORT. If the sentinel cannot be published, the
        plugin keeps reading the PREVIOUS phase — which, at the build->repair
        transition, is exactly the stale `build` that lets a repair-round
        compaction through. That is the defect this closes, so it must not be
        possible to continue past it with a warning.

        Since WO-MARKER-RIP the sentinel is the WHOLE gate (there is no longer
        a model-emitted marker as a second condition), so a stale value is not
        one signal of two going wrong — it is the only one.
        """
        if not self.compact:
            return
        host_dir = getattr(active_cell.config, "compact_phase_host_path", None)
        if host_dir is None:
            raise ServeTransportError(
                f"phase {phase}: --compact is armed but this cell has no phase "
                "sentinel path — the worker could not be told which phase it is "
                "in, and the sentinel is the ONLY thing that decides whether an "
                "idle may compact"
            )
        value = (
            _COMPACT_PHASE_REPAIR
            if held
            else compact_phase_for(
                phase, record_turn_enabled=self.record_at_chunk_end
            )
        )
        target = Path(host_dir).expanduser().resolve() / _COMPACT_PHASE_FILENAME
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_suffix(".tmp")
            tmp.write_text(f"{value}\n", encoding="utf-8")
            os.replace(tmp, target)
        except OSError as exc:
            raise ServeTransportError(
                f"phase {phase}: could not publish the compaction phase sentinel "
                f"to {target} ({exc}) — the worker would keep reading the "
                "previous phase, which is how a repair-round compaction gets in"
            ) from exc
        if held:
            # A HOLD IS A SENTINEL-VALUE CORRECTION MID-DRIVE, NOT A PHASE
            # TRANSITION. The drive already announced this phase at its
            # boundary publish; re-emitting phase.start (or re-setting the
            # heartbeat's phase) here would falsely announce a restart.
            return
        self._progress(f"PROGRESS step=compact-phase phase={phase} sentinel={value}")
        # THE SAME BOUNDARY, ON THE LIVE STREAM. The log line above is the
        # operator's record; this is the UI's. They are emitted together so
        # they can never disagree about which phase is open.
        #
        # The heartbeat is told too, so every beat from here until the next
        # boundary names this phase — that is what turns "something is alive"
        # into "the build's chunk 5 is alive".
        live = getattr(self, "_live", None)
        if live is not None:
            live.emit(
                "phase.start",
                cell_seq=getattr(self, "_cell_seq", None),
                phase=str(phase),
            )
        heartbeat = getattr(self, "_heartbeat", None)
        if heartbeat is not None:
            heartbeat.set_phase(str(phase))

    def _write_worker_permission_config(self, *, worktree: Path) -> None:
        gates_dir = str((self.task_dir / "gates").resolve())
        golden_dir = str((self.task_dir / "golden").resolve())
        # Stashed by the Docker arm beside the image-identity probe; default
        # True keeps direct/mock callers on the plugin-baked path.
        plugin_present = getattr(self, "_plugin_present", True)
        config = build_worker_opencode_config(
            model=self.model,
            reasoning_effort=self.reasoning_effort,
            proxy_base_url=self.proxy_base_url,
            gates_dir=gates_dir,
            golden_dir=golden_dir,
            session_id=self.session_id,
            plugin_present=plugin_present,
        )
        session_header_set = bool(self.session_id)
        provider_id, _, model_id = self.model.partition("/")
        if provider_id and model_id:
            self._progress(
                "PROGRESS step=worker-permission-config "
                f"model_declared={model_id} provider={provider_id} "
                f"session_header_set={str(session_header_set).lower()}"
            )

        self._progress(
            "PROGRESS step=worker-permission-config-provider "
            f"provider={provider_id or 'none'} model={model_id or 'none'} "
            f"proxy_base_url_set={str(bool(self.proxy_base_url)).lower()} "
            f"session_header_set={str(session_header_set).lower()}"
        )

        # Output token caps are enforced via Docker env
        # OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX, not model `options.max_tokens`
        # in opencode.json.
        if provider_id and model_id and self.reasoning_effort is not None:
            self._progress(
                "PROGRESS step=worker-permission-config "
                f"reasoning_effort={self.reasoning_effort} model={self.model}"
            )
        (worktree / "opencode.json").write_text(
            json.dumps(config, indent=2) + "\n", encoding="utf-8"
        )
        self._progress(
            "PROGRESS step=worker-permission-config external_directory=deny "
            "oracle_bash_deny=active task_deny=active skip_permissions_removed=true"
        )

    def _build_cell_config(
        self,
        *,
        worktree: Path,
        container_name: str,
        egress_host: str = "",
    ) -> DockerCellConfig:
        session_db_dir = worktree.parent / "session-db"
        session_db_dir.mkdir(parents=True, exist_ok=True)
        cell_config = DockerCellConfig(
            worktree=worktree,
            memory_mode=self.memory_mode,
            container_name=container_name,
        )
        cell_config.session_db_host_path = session_db_dir
        cell_config.extraction_state_host_path = worktree.parent / "extraction-state"
        cell_config.plugin_state_host_path = str(worktree / ".okp" / "state")
        # A2 phase sentinel: a sibling of the worktree, never inside it — the
        # model must not see instrument state, and the gates must not score it.
        cell_config.compact_phase_host_path = worktree.parent / "compact-phase"
        cell_config.output_token_max = self.max_output_tokens
        cell_config.proxy_base_url = self.proxy_base_url
        cell_config.proxy_token = self.proxy_token
        cell_config.cloud = self.cloud
        # Arms the worker plugin's self-fire (it resolves the model to compact
        # with from the session itself — the harness passes no model ids).
        cell_config.self_compact = bool(self.compact)
        cell_config.require_todos = bool(self.require_todos)
        # When set, docker_worker runs this cell on the --internal egress
        # network and launches the sidecar of this name; empty = legacy path.
        cell_config.egress_host = egress_host
        cell_config.worker_logs_dir = worktree.parent / "worker-logs"
        cell_config.serve_host_port = self.serve_host_port
        cell_config.serve_container_port = self.serve_container_port
        return cell_config

    def _init_worktree_git(self, *, worktree: Path) -> None:
        # opencode resolves the session worktree by walking up from --dir /work
        # looking for .git; with no .git at/above the bind-mount root it falls
        # back to "/", so the okp plugin reads /.okp/org.json (absent)
        # and the session stays DORMANT. git-init the seeded worktree so the
        # plugin resolves worktree=/work and reads /work/.okp/org.json.
        subprocess.run(
            ["git", "init"],
            cwd=str(worktree),
            capture_output=True,
            text=True,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.email", "bench@okp.local"],
            cwd=str(worktree),
            capture_output=True,
            text=True,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "bench"],
            cwd=str(worktree),
            capture_output=True,
            text=True,
            check=True,
        )
        subprocess.run(
            ["git", "commit", "--allow-empty", "-m", "bench cell seed"],
            cwd=str(worktree),
            capture_output=True,
            text=True,
            check=True,
        )
        self._progress(f"PROGRESS step=worktree-git-init path={worktree}")

    def _prepare_memory_mode(self, *, worktree: Path) -> bool:

        if self.memory_mode == "on":
            source_org = self._repo_root / ".okp" / "org.json"
            if not source_org.is_file():
                raise FileNotFoundError(f"missing required memory marker: {source_org}")

            marker_dir = worktree / ".okp"
            marker_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_org, marker_dir / "org.json")

            # Wire the bench-fixture predicate adapter: the plugin observes the
            # agent's own tool-call output, so the runner is copied into the cell
            # worktree (outside the frozen scaffold hash) and a predicate.json
            # declares the bench-fixture reporter. Missing runner source degrades
            # to a stderr warning while still writing predicate.json so existing
            # cells keep working.
            predicate = {"reporter": "bench-fixture", "command": "node bench-check.mjs"}
            marker_dir.joinpath("predicate.json").write_text(
                json.dumps(predicate), encoding="utf-8"
            )
            runner_source = self.task_dir / "bench" / "bench-check.mjs"
            if runner_source.is_file():
                shutil.copy2(runner_source, worktree / "bench-check.mjs")
            else:
                self._progress(
                    f"PROGRESS step=memory-mode warning=bench-runner-missing "
                    f"path={runner_source}"
                )

            self._progress(
                f"PROGRESS step=memory-mode mode=on marker={marker_dir / 'org.json'} "
                "recall_env_injection=container"
            )
            return False

        shutil.rmtree(worktree / ".okp", ignore_errors=True)
        self._progress("PROGRESS step=memory-mode mode=off pure=true")
        return True

    def _load_chunk_prompts(self) -> list[str]:
        """Load the WO-77 chunked first-pass prompts (task/backgammon/prompts/chunk-*.md).

        The chunked pass IS the initial pass — there is no monolith fallback.
        Missing or empty chunk data is a loud cell-prep error, never a skip.

        NO CAPTURE/COMPLIANCE PROTOCOL (2026-08-26). Chunk 1 used to carry an
        appended 193-line producer prompt (`scaffold/sxe-candidate/
        S-fork-reasoning.md`) instructing the worker to emit `OKP_DISCOVERY`
        blocks in a fixed schema. It is deleted, along with its orphaned E-fork
        pair, for two reasons:

        1. EXTRACTION IS NOT THE BENCHMARK'S JOB ANY MORE. STRIP-2a removed the
           memory-production flow and `scripts/backgammon_sxe.py`; the bench's
           MCP surface is recall-only (plugin auto-inject), and what happens
           inside a session is measured by the plugin substrate rather than by
           asking the model under test to narrate it. The pair was already
           recorded as orphaned and deferred (SESSIONCONTINUANCE, WO-STRIP-2b).

        2. IT WAS ACTIVELY CORRUPTING THE MEASUREMENT. Its "load-bearing
           requirements" told the worker the debug seam was gated by
           `BENCH_DEBUG`. Every other source — CONTRACT.md, chunk-04, chunk-06,
           the golden, the scaffold, and the gate harness that actually launches
           the server — says `DEBUG_API`. A worker that obeyed it renamed the
           seam and then failed every gate that scripts dice: the conformance
           pregate, three backend gate files, and the whole Playwright suite.
           That is a model being penalised for following its instructions.

        Worth knowing for anything that replaces it: the appended text was NEVER
        covered by `chunk_plan_hash`, which hashes only `task/backgammon/
        prompts/`. Edits to it were invisible to drift detection, which is how a
        contradicting env-var name survived in the model's context unnoticed.
        """
        prompts_dir = self.task_dir / "prompts"
        if not prompts_dir.is_dir():
            raise RuntimeError(f"chunked prompts directory missing: {prompts_dir}")
        chunk_paths = sorted(prompts_dir.glob("chunk-*.md"))
        if not chunk_paths:
            raise RuntimeError(f"no chunk prompts (chunk-*.md) found in {prompts_dir}")
        chunks: list[str] = []
        for path in chunk_paths:
            text = path.read_text(encoding="utf-8")
            if not text.strip():
                raise RuntimeError(f"chunk prompt empty: {path}")
            chunks.append(text)

        # SELF-COMPACTION IS WORKER-SIDED, AND INVISIBLE TO THESE PROMPTS.
        # The plugin fires its own summarize on session.idle, gated entirely by
        # the phase sentinel the harness publishes — so the prompts carry no
        # compaction instruction, ask the model for no sign-off string, and are
        # byte-identical whether or not the flag is set. The harness only
        # observes at the boundary (see _settle_after_chunk).
        return chunks

    @staticmethod
    def _joined_chunk_prompt(chunks: list[str]) -> str:
        """Single-text rendering of the chunk plan.

        Used for the launch PROGRESS character count; the cell itself is
        driven chunk-by-chunk over serve.
        """
        return "\n\n---\n\n".join(chunks)

    # ── FEEDBACK VOICE (WO-FEEDBACK-1) ───────────────────────────────────────
    #
    # The benchmark's fiction is that a USER is telling the model what is still
    # broken. Everything the model receives must read that way, because a model
    # that recognises an automated grader loop can optimise toward test names
    # instead of toward the product — which is a different measurement than the
    # one this instrument claims to take.
    #
    # Grader-internal identity (`[G05]`, `[F01]`, `conformance:`, `REQ-*`) is
    # therefore STRIPPED from the delivered text. It is NOT stripped from the
    # artifacts: `failed_gates`, `gate_results` and the roster keep the exact
    # tokens, so the board and every scorecard still address gates precisely.
    # The model hears a human; the record keeps the ids.

    # Absolute paths and stack frames in an assertion message point at the gate
    # files, which the worker cannot read (`external_directory: deny`). Leaving
    # them in only invites turns wasted trying.
    _PATH_RE = re.compile(r"(?:file://)?/\S+")

    # Token as a LOOKUP KEY (anchored, captures the token it matches).
    _GATE_TOKEN_KEY_RE = re.compile(r"^\s*\[([A-Z]+[0-9]*)\]")
    # Conformance sub-checks carry no bracket token; their stable identity is
    # the `REQ-XXX/sub.check` key that `pregate.ts` assigns.
    _CONF_KEY_RE = re.compile(r"^\s*(?:conformance:)?(REQ-[A-Z0-9-]+/\S+)")

    # ── WHICH OF THE TWO PEOPLE REPORTS THIS ─────────────────────────────────
    #
    # The repair message carries two lists from two humans (see
    # `_build_feedback_prompt`). This is the ONE place that decides which, and
    # both the prompt builder and the voice guards read it — two classifiers
    # would let the prompt route a line the guards judged by the other bar.
    #
    #   TESTER   the person playing the game. Reports symptoms. Cannot possibly
    #            observe a JSON field or an automation attribute.
    #   TEAM     a software team integrating the app. Reads API responses and
    #            selects elements. Everything they report is invisible to a
    #            player, which is why forcing it into the tester's mouth
    #            produced "The game doesn't seem to start up correctly at all"
    #            over eleven findings that had nothing to do with starting up.
    #
    # Conformance checks carry a `REQ-*/` key and are split by prefix. Every
    # OTHER gate (`[G05]`, `[F12]`, …) is a played-game symptom and is the
    # tester's by default — the team is an addition, never a reclassification.
    # REQ-RESPONSIVE is a FREEZE — the most player-visible symptom there is, and
    # one an integrator reading API responses would never phrase. Tester, always.
    _TESTER_CONF_PREFIXES = ("REQ-RENDER/", "REQ-HINT/", "REQ-RESPONSIVE/")
    _TESTER_CONF_EXACT = ("REQ-BIND/boot",)

    @classmethod
    def feedback_channel(cls, check: str) -> str:
        """`"tester"` or `"team"` for one check id. Single source of truth."""
        m = cls._CONF_KEY_RE.match(str(check or "").strip())
        if not m:
            return "tester"
        key = m.group(1)
        if key.startswith(cls._TESTER_CONF_PREFIXES):
            return "tester"
        if any(key == exact or key.startswith(f"{exact} ") for exact in cls._TESTER_CONF_EXACT):
            return "tester"
        return "team"
    # HARNESS-INFRA CHECK NAMES (WO-FEEDBACK-VOICE-3 follow-up, 2026-08-30).
    # These are born only when a RUNNER DIES mid-run —
    # `backend:runner backend/gates-13-16.test.ts` (report.mjs abort case),
    # `frontend:boot`, `backend:report-parse <file>` — and no preflight can
    # pin a symptom line for a name that does not exist until a run fails.
    # They are not gates: the roster has no row for them, and the model cannot
    # repair the gate tooling from inside its cell. A check matching this
    # pattern must NEVER reach `_humanize_check`, because the single-system
    # contract (every check maps to a human symptom line) is defined over
    # GATES, and raising here turns a harness/instrument failure into a
    # campaign-ending crash (measured: run 1788122095 attempt 3 — the
    # gates-13-16 runner was killed externally, the abort line reached
    # `_build_feedback_prompt`, MissingFeedbackOverrideError propagated out of
    # run_cell, and the whole run died with a traceback AFTER the graded
    # attempt had already been recorded).
    _HARNESS_INFRA_CHECK_RE = re.compile(
        # `conformance:runner` replaced `conformance:boot` (2026-09-05). The old
        # name was attached to a FABRICATED problem the conformance phase
        # invented whenever it failed unreadably — a fallback in the scored
        # path, and the thing that let a phase with 11 real failings publish as
        # one boot complaint AND as gradable. The phase now reports itself
        # unreadable and the attempt is marked ungradable, exactly as an aborted
        # backend runner already was. The name says the RUNNER could not be
        # read, never that the code failed to boot.
        r"^(?:backend:runner|backend:report-parse|frontend:boot|conformance:runner)\b"
    )

    @classmethod
    def _feedback_overrides(cls) -> dict[str, dict[str, str]]:
        """Human-written symptom lines, keyed by gate token or exact check text.

        Cached on the class; see `_load_feedback_overrides` for the contract.
        """
        cached = getattr(cls, "_FEEDBACK_OVERRIDES_CACHE", None)
        if cached is None:
            cached = load_feedback_overrides(
                _DEFAULT_TASK_DIR / "gates" / "feedback.json"
            )
            cls._FEEDBACK_OVERRIDES_CACHE = cached
        return cached

    @classmethod
    def _humanize_check(cls, check: str, *, pass_kind: str = "first") -> str:
        """Render a gate id as the phrase a person would actually say.

        `pass_kind` selects which of the gate's two lines to use: `"first"` the
        first time the model hears about this gate, `"repeat"` once it has
        already tried to fix it and failed. See `load_feedback_overrides` for
        why there are two.

        SINGLE-SYSTEM (WO-FEEDBACK-VOICE-3, 2026-08-30). The ONLY sentence a gate
        may carry is the human-written line in `gates/feedback.json`. Deriving
        the sentence from the TEST TITLE leaks the fix whenever the title states
        the rule rather than the symptom — measured on the deepseek-chat run
        1788099503: gate E08 failed on attempt 1, the model was told
        "full-turn sequences are distinct by RESULTING BOARD", and it passed on
        attempt 2. That sentence IS the requirement, so the gate stopped
        measuring whether the model could infer it. The title-derived fallback
        is therefore DELETED.

        `feedback.json` maps a gate to what a PERSON PLAYING THE GAME would
        report — the symptom, not the cause. A gate with NO override RAISES
        `MissingFeedbackOverrideError`: it is a misconfigured benchmark, and the
        completeness preflight + test are what guarantee it never happens at
        run time. The raw ids stay in `failed_gates`/`gate_results` untouched.

        `[G05] REQ-HIGHER-DIE — use higher die` becomes whatever `feedback.json`
        says for `G05` (here: the human symptom sentence), never the title.
        """
        raw = str(check or "").strip()
        overrides = cls._feedback_overrides()
        line = "repeat" if pass_kind == "repeat" else "first"

        # Lookup order: exact check text, then bracket token, then a specific
        # conformance sub-check key (a narrower message may override the broad
        # CONF line), then the broad CONF token for any conformance check.
        token_key = m.group(1) if (m := cls._GATE_TOKEN_KEY_RE.match(raw)) else None
        conf_key = m.group(1) if (m := cls._CONF_KEY_RE.match(raw)) else None
        for key in (raw, token_key, conf_key, "CONF"):
            if key and key in overrides:
                # "CONF" must only resolve conformance checks, never a stray use
                # of the literal token in a backend/frontend context.
                if key != "CONF" or conf_key is not None:
                    return overrides[key][line]

        if cls._HARNESS_INFRA_CHECK_RE.match(raw):
            raise MissingFeedbackOverrideError(
                f"harness-infra check {raw!r} reached _humanize_check. These "
                "check names are born only when a gate RUNNER dies mid-run; "
                "they are not gates and must be filtered before feedback "
                "composition, never resolved to a symptom line. See "
                "_HARNESS_INFRA_CHECK_RE."
            )

        token = token_key or conf_key or "??"
        raise MissingFeedbackOverrideError(
            f"no feedback override for gate token {token!r} "
            f"(check: {raw!r}). The feedback voice is single-system: every gate "
            "must carry a human-written symptom line in gates/feedback.json. "
            "Run the bench preflight to list the missing gates."
        )

    @classmethod
    def _is_harness_infra_check(cls, check: str) -> bool:
        """True for runner-death check names that are NOT gates.

        See `_HARNESS_INFRA_CHECK_RE`. They stay in `failed_gates` /
        `problems` (the graded artifacts record the runner death exactly as
        published), but are excluded from feedback composition: the repair
        prompt is for gates the model can fix, and no symptom line can exist
        for a name the preflight has never seen.
        """
        return bool(cls._HARNESS_INFRA_CHECK_RE.match(str(check or "").strip()))

    @staticmethod
    def _build_pass_verdict(*, newly_passing: list[str]) -> str:
        """What the player says about the complaints that are now gone.

        SAME VOICE, SAME SHAPE as the failure message: a short opener, then a
        numbered list of the things they are no longer running into. Each item
        is that gate's FIRST-pass line — the person is referring back to what
        they originally reported, so that is the wording they would use.

        WHAT THIS REPLACED. The old form spliced the symptom into a clause it
        did not fit: "That fixed it — {symptom} works now", which rendered as
        "That fixed it — Sometimes the same die gets used twice in one turn
        works now." A symptom sentence describes the PROBLEM, so appending
        "works now" to one produces a sentence that says the opposite of what
        it means. It was broken before the two-pass rewrite too (it read "also
        the numbers … works now"); the rewrite only made it visible.
        """
        if not newly_passing:
            return ""

        deduped: list[str] = []
        seen: set[str] = set()
        for item in newly_passing:
            first_line = str(item).split("\n", 1)[0]
            if BackgammonRunner._is_harness_infra_check(first_line):
                continue
            sanitized = BackgammonRunner._humanize_check(first_line)
            # Same cap and reasoning as the failure list: a human symptom
            # sentence legitimately runs long, and a cut mid-clause is the tell
            # that no person wrote it.
            if len(sanitized) > 200:
                sanitized = f"{sanitized[:200].rsplit(' ', 1)[0]}…"
            if not sanitized or sanitized in seen:
                continue
            seen.add(sanitized)
            deduped.append(sanitized)

        if not deduped:
            return ""

        opener = (
            "That fixed it — I'm not running into this any more:"
            if len(deduped) == 1
            else "That fixed it — I'm not running into these any more:"
        )
        # Generous, but bounded: naming what got fixed is the signal that stops
        # the model undoing it, and a numbered list holds far more than the old
        # comma-spliced sentence could. The tail keeps a mass pass from turning
        # one message into a wall.
        shown = deduped[:_PASS_VERDICT_MAX_LISTED]
        lines = [opener, ""]
        for index, text in enumerate(shown, start=1):
            lines.append(f"{index}) {text}")
        remaining = len(deduped) - len(shown)
        if remaining:
            noun = "thing" if remaining == 1 else "things"
            lines.append("")
            lines.append(f"({remaining} other {noun} I mentioned look fine now too.)")
        return "\n".join(lines)

    @classmethod
    def _build_feedback_prompt(
        cls,
        *,
        problems: list[dict[str, Any]] | None = None,
        checks: list[str] | None = None,
        had_prior_feedback: bool = False,
        repeat_checks: set[str] | None = None,
        capture_protocol: bool | None = None,
    ) -> str:
        """Compose the message the model receives after a failed attempt.

        THE VOICE (2026-09-02). One person who played the finished game and is
        listing what they hit. Two openers, chosen by whether this gate list is
        their first report or a re-report after the model said it had fixed
        things:

          first  "I've checked your work thoroughly, and I want to list the
                  issues that I've encountered while playing the game:"
          repeat "I've checked your resolution for the problems that were given
                  before, played the game in full again, and I'm still seeing
                  these problems:"

        Then a numbered list, one complaint per line. The old shape was a
        bulleted `- {label}: FAILING`, and every symptom in `feedback.json`
        began with the word "also" so the bullets would read as one continuous
        grumble. Under a real opener that "also" is a tic, and `FAILING` is
        grader vocabulary a player would never use — both are gone.

        THE GRADIENT, AND HOW IT STOPPED LEAKING. Before WO-FEEDBACK-1 this
        listed gate names and nothing else, so a gate failing in attempt 2 and
        again in attempt 3 produced BYTE-IDENTICAL text. A failed fix returned
        zero new information and the model could not tell "closer" from "no
        change" — across a 3-attempt ceiling the loop had no gradient at all.

        WO-FEEDBACK-1 fixed that by appending one sanitised line of the
        grader's own assertion on a repeat failure. It worked, and it leaked:
        an assertion states the RULE, which is precisely what `feedback.json`
        exists to withhold. A gate that answers itself measures attempt count,
        not capability — the same defect the title-derived fallback was deleted
        for.

        So the gradient now comes from a SECOND HUMAN LINE per gate rather than
        from the grader. A repeat failure sends the same person's second
        sighting of the same fault — what they did differently, what they
        watched for — which carries "your fix missed, and I looked again"
        without carrying where to look. `observed` is no longer read here at
        all; it stays in the graded artifacts, unchanged, for the operator.

        Repeats are keyed on the raw gate id (stable), never the rendered
        sentence (lossy).

        CAPTURE RIDES THIS PROMPT, AFTER THE PLAYER'S WORDS (2026-09-04). The
        capture protocol used to live in AGENTS.md, in front of the model for the
        whole session including the build. It is now delivered here, because
        troubleshooting is the phase whose knowledge is worth preserving.

        It is appended as its own trailing section and NEVER folded into the
        complaint list: the message above it is one person describing what they
        hit while playing, and a player does not ask for a tool call. Mixing the
        two would cost the voice, which is load-bearing — a model that can tell
        it is being measured is not the model this run is measuring.

        `capture_protocol=True` sends the full protocol (the first troubleshooting
        round of a session), `False` sends the short reminder, `None` sends
        neither — the default, so every existing caller and test is unchanged.

        THE EXCUSE ELIMINATOR (2026-09-04). Every failure verdict — first or
        repeat — OPENS with `_EXCUSE_ELIMINATOR`: the harness-side fact that
        grading runs in a clean browser (cache cleared, no saved session, a
        brand-new game). It pre-empts the stale-page / hard-refresh /
        saved-session excuse class measured on OFF-cell run 1788499216, where
        the model deflected to "the user needs to hard-refresh" over ten
        failures that had nothing to do with caching. It is constant across the
        gradient on purpose: it is a fact about how grading happens, not a
        sighting, so it carries no new information and only the opener and the
        per-gate lines carry the gradient.
        """
        header = (
            "I've checked your resolution for the problems that were given "
            "before, played the game in full again, and I'm still seeing these "
            "problems:"
            if had_prior_feedback
            else "I've checked your work thoroughly, and I want to list the "
            "issues that I've encountered while playing the game:"
        )

        # Accept either the rich problem records or a bare check list, so older
        # callers and tests keep working unchanged.
        records: list[dict[str, Any]]
        if problems is not None:
            records = [p for p in problems if isinstance(p, dict)]
        else:
            records = [{"check": c} for c in (checks or [])]

        repeats = repeat_checks or set()

        # The excuse eliminator opens the message; then the opener; then the
        # numbered complaints. See the docstring for why it is first.
        # ── TWO PEOPLE, TWO LISTS, ONE MESSAGE ──────────────────────────────
        #
        # A player cannot observe a missing JSON field or an absent automation
        # attribute. There is no honest player sentence for either, and forcing
        # one is exactly how eleven conformance findings became "The game
        # doesn't seem to start up correctly at all" — a sentence contradicted
        # by the fifteen complaints under it and by the 36 gates that passed.
        #
        # The fix is not to abandon prose, it is to stop pretending the only
        # available human is a player. A team integrating against the app is an
        # ordinary person who reads API responses, and everything they report is
        # something they could genuinely have hit.
        #
        # Both lists are numbered from 1: they are two people's accounts, not
        # one list with a divider.
        by_channel: dict[str, list[str]] = {"tester": [], "team": []}
        seen: set[str] = set()

        for record in records:
            raw_check = str(record.get("check", "")).strip()
            if not raw_check:
                continue
            # Harness-infra check names (`backend:runner <file>`,
            # `frontend:boot`, ...) are born when a gate RUNNER dies mid-run.
            # They are not gates: no feedback line can exist for them, the
            # model cannot repair the gate tooling from inside its cell, and
            # routing them into `_humanize_check` would raise and abort the
            # whole campaign after the graded attempt was already recorded
            # (measured: run 1788122095, attempt 3). Recorded in the scored
            # artifacts; excluded from the repair prompt.
            if cls._is_harness_infra_check(raw_check):
                continue
            # THE GRADIENT, chosen per gate: a gate the model has already been
            # told about and failed to fix gets that gate's second-sighting
            # line. Keyed on the raw id because the rendered sentence differs
            # between the two passes and could not key anything.
            pass_kind = "repeat" if raw_check in repeats else "first"
            label = cls._humanize_check(
                raw_check.split("\n", 1)[0], pass_kind=pass_kind
            )
            # 320, not 200 (2026-09-05). The comment below has been right twice
            # over: at 200 it was ALREADY truncating two hand-written tester
            # lines (E04 at 267 characters, E02 at 244), and the software team's
            # lines are legitimately longer still because each one states what
            # the missing thing IS, not merely that it is missing.
            #
            # That length is not padding. The build prompt is not in the model's
            # context when it reads this — a normal run compacts between the six
            # build chunks, and a SEEDED run never ran the build at all — so
            # "there's no winType" is cryptic to a model that no longer knows,
            # or never knew, what winType was supposed to be. The definition has
            # to travel with the complaint.
            #
            # Truncating one mid-clause loses the symptom AND reads like a
            # machine wrote it — the exact tell this voice exists to avoid.
            if len(label) > 320:
                label = f"{label[:320].rsplit(' ', 1)[0]}…"
            if not label or label in seen:
                continue
            seen.add(label)
            by_channel[cls.feedback_channel(raw_check)].append(label)

        lines: list[str] = [_EXCUSE_ELIMINATOR, "", header, ""]
        for n, label in enumerate(by_channel["tester"], start=1):
            lines.append(f"{n}) {label}")

        # The tester always speaks, even with nothing to report: the opener has
        # already promised a list, and an opener with no list under it reads as
        # a truncated message rather than a clean run.
        if not by_channel["tester"]:
            lines.append(
                "1) Something is still broken but I couldn't pin down what it was."
                if not by_channel["team"]
                else "1) Nothing jumped out at me this time while I was playing."
            )

        # The team section appears ONLY when the team has something to say.
        # Announcing an integration attempt and then listing nothing would be a
        # sentence with no content, and it would still hand the model a party to
        # argue with.
        if by_channel["team"]:
            lines += ["", _TEAM_HEADER, ""]
            for n, label in enumerate(by_channel["team"], start=1):
                lines.append(f"{n}) {label}")
            lines += ["", _TEAM_EXCUSE_ELIMINATOR]

        # LAST, AND SEPARATE. Everything above is the player's message; this is
        # the harness speaking to the worker about capture. It is appended, never
        # interleaved — see the docstring.
        if capture_protocol is True:
            lines += ["", _SESSION_EXTRACTION_MD]
        elif capture_protocol is False:
            lines += ["", _REPAIR_CAPTURE_REMINDER_MD]

        return "\n".join(lines)

    def _load_cached_grade(self, snapshot_dir: Path) -> dict[str, Any] | None:
        """Return the stored attempt-1 grade iff the grader is byte-identical.

        DEV-MODE GRADE CACHE, NOT CERTIFICATION. A seeded cell re-runs the
        gates over a tree copied from a prior cell; when the gate code has not
        changed since that cell graded, the outcome is already known — the
        snapshot carries the full attempt-1 grade beside its tree. Reuse it
        ONLY when the stored ``grader_hash`` equals the running gates dir's
        hash. Any miss — absent files, unparseable JSON, absent or mismatched
        hash, non-dict grade — returns ``None`` silently and the cell grades
        for real, exactly as before the cache existed. Never raises.
        """
        try:
            current = compute_grader_hash(self.task_dir / "gates")
            stored = json.loads(
                (snapshot_dir / "snapshot.json").read_text(encoding="utf-8")
            ).get("grader_hash")
            grade = json.loads(
                (snapshot_dir / "grade-report.json").read_text(encoding="utf-8")
            )
            if stored is not None and stored == current and isinstance(grade, dict):
                live = getattr(self, "_live", None)
                if live is not None:
                    live.notice(
                        "harness",
                        "grade_cache_hit",
                        level="info",
                        cell_seq=getattr(self, "_cell_seq", None),
                        session_id=self._cell_session_id,
                        detail={
                            "snapshot_id": snapshot_dir.name,
                            "grader_hash_matched": True,
                        },
                    )
                return grade
            return None
        except Exception:
            # An unreadable cache is a miss, not an error: grade for real.
            return None

    def _run_gate_report(
        self,
        *,
        worktree: Path,
        report_path: Path,
        log_path: Path,
        attempt: int | None = None,
    ) -> dict[str, Any]:
        """Run the gate oracle, STREAMING its output to ``log_path`` as it runs.

        WHY STREAMED AND NOT BUFFERED (WO-GRADE-VIS-1). This previously used
        ``subprocess.run(capture_output=True)`` and wrote the log only AFTER the
        process returned. A slow or hung grade therefore produced ZERO bytes for
        its entire duration: measured 2026-08-12, an attempt-3 gate ran 1918s
        (~32 min) against a 45s/113s baseline while `attempt-3-gate.log` did not
        exist, so "grading" and "wedged" were indistinguishable without
        inspecting process stacks by hand. The gate runner already announces
        every phase on stderr BEFORE spawning it (`report.mjs`:
        ``[report] phase=<name> target=...``); those markers were real and
        simply trapped in a pipe buffer until exit.

        Streaming makes the log an append-only progress record whose MTIME is a
        true liveness signal — which is what the board's stall detection reads.
        Both streams are merged (``stderr=STDOUT``) so phase markers and the
        output they describe stay in causal order in one file, and a single
        reader cannot deadlock on two pipes.

        TIMEOUT (belt-and-suspenders). A gate that never returns must fail its
        attempt with evidence rather than hang the campaign forever. On timeout
        the whole process GROUP is killed: the gate spawns npm -> vitest ->
        workers, and signalling only the direct child leaves those children
        alive (exactly the orphan class that burned 341 CPU-minutes on
        2026-08-12). Partial output is already on disk by construction.
        """
        # ── GRADING RUNS IN ITS OWN IMAGE ──────────────────────────────────
        #
        # It used to run here, on the host, with whatever was installed. Four
        # things differed from the container the candidate was BUILT in — Node,
        # Playwright, Chromium, and vitest (declared as a RANGE, so it could
        # change itself on a reinstall) — and `compute_grader_hash` excludes
        # node_modules, so nothing recorded which toolchain produced a result.
        #
        # The corpus is frozen byte-for-byte and a cell aborts on a mismatch.
        # The instrument measuring it is now pinned the same way.
        #
        # A missing image ABORTS with the build command. There is deliberately
        # no host fallback: the fallback is what people reach for when the
        # container is inconvenient, and then a result exists that nobody can
        # reproduce.
        assert_grader_image_available()
        grade_container = grading_container_name(report_path)
        gate_cmd = gate_argv(
            worktree=worktree,
            report_path=report_path,
            roster_path=self.gate_roster_path,
            attempt=attempt,
            worker_target=self.grader_worker_target,
        )
        # `docker` is invoked from the repo root; the gates travel inside the
        # image, so there is no gates directory for this process to stand in.
        gates_cwd = str(Path(__file__).resolve().parents[2])
        log_path.parent.mkdir(parents=True, exist_ok=True)

        gate_started = time.monotonic()
        timed_out = False  # set by the watchdog below, never inferred
        # Header is written and flushed BEFORE the child starts, so the file
        # exists from t=0 and its absence can never be mistaken for a slow gate.
        with log_path.open("w", encoding="utf-8") as log_file:
            log_file.write(f"cmd: {gate_cmd}\n")
            log_file.write(f"cwd: {gates_cwd}\n")
            log_file.write(f"timeout_seconds: {self.gate_timeout_s}\n")
            log_file.write("--- output (streamed, stdout+stderr merged) ---\n")
            log_file.flush()

            # THE GATE RUNNER JOINS THE LIVE STREAM DIRECTLY.
            #
            # It is a child of this process and already streams its stdout here
            # line by line — so the harness COULD parse its output and relay
            # what it finds. That is exactly the pattern the backend feed exists
            # to replace: `gate-events.mjs` tails a log and regex-parses it, and
            # every fact it recovers that way is one the producer could simply
            # have stated. The runner knows when a worker died; it says so
            # itself.
            #
            # `LiveStream.env()` is the same seam a backend gets. Absent (no
            # stream on this run) the runner writes nothing and carries on —
            # telemetry is never a precondition for grading.
            gate_env = dict(os.environ)
            live = getattr(self, "_live", None)
            if live is not None:
                gate_env.update(live.env())

            proc = subprocess.Popen(  # noqa: S603 - fixed argv, host-only gate oracle
                gate_cmd,
                cwd=gates_cwd,
                env=gate_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,  # line-buffered: a phase marker lands as it is emitted
                start_new_session=True,  # own process group, so timeout kills the tree
            )
            assert proc.stdout is not None
            # WATCHDOG, NOT `wait(timeout=...)`. The reader loop below blocks in
            # `for line in proc.stdout` until the child closes the pipe, so a
            # hung gate never reaches a post-loop wait() — the timeout would be
            # structurally unreachable. (That is precisely the defect class this
            # work exists to fix: vitest's own 60s testTimeout could not fire
            # because a microtask loop starved its timer.) An independent timer
            # thread owns the deadline, kills the process group, and the pipe
            # closes as a consequence, which unblocks the reader.
            timeout_fired = threading.Event()

            def _on_deadline() -> None:
                timeout_fired.set()
                # THE CONTAINER FIRST, then the client. Killing the process
                # group reaches the `docker` CLI only — the container is a child
                # of the DAEMON, so it would survive, keep the candidate mounted
                # and keep burning CPU with nothing left holding its id.
                kill_grading_container(grade_container)
                self._kill_process_group(proc)

            watchdog = threading.Timer(self.gate_timeout_s, _on_deadline)
            watchdog.daemon = True
            watchdog.start()
            try:
                for line in proc.stdout:
                    log_file.write(line)
                    # Flushed per line: an unflushed buffer would reintroduce
                    # exactly the invisibility this change exists to remove.
                    log_file.flush()
                    self._emit_gate_phase_progress(line, log_path=log_path)
                proc.wait()
            finally:
                watchdog.cancel()
                if proc.poll() is None:
                    # Pipe closed while the child still lives. Never leave the
                    # tree running — nor the container behind it.
                    kill_grading_container(grade_container)
                    self._kill_process_group(proc)
                    proc.wait()
            timed_out = timeout_fired.is_set()

            gate_wall = time.monotonic() - gate_started
            returncode = proc.returncode
            if timed_out:
                log_file.write(
                    f"\n[harness] gate TIMED OUT after {gate_wall:.3f}s "
                    f"(limit {self.gate_timeout_s}s); process group killed\n"
                )
            log_file.write(f"\nexit: {returncode}\n")
            log_file.write(f"wall_seconds: {gate_wall:.3f}\n")
            log_file.flush()

        if timed_out:
            self._progress(
                f"PROGRESS step=gate-timeout wall_s={gate_wall:.1f} "
                f"limit_s={self.gate_timeout_s} log={log_path}"
            )
            raise GateTimeoutError(
                f"gate oracle exceeded {self.gate_timeout_s}s "
                f"(ran {gate_wall:.1f}s); partial output at {log_path}"
            )

        if not report_path.is_file():
            raise GraderReportUnreadableError(
                f"gate report missing at {report_path} (exit={returncode})"
            )

        try:
            payload = json.loads(report_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise GraderReportUnreadableError(
                f"gate report unparseable at {report_path}: {exc}"
            ) from exc
        if not isinstance(payload, dict):
            raise GraderReportUnreadableError(
                f"gate report must be an object: {report_path}"
            )
        return payload

    def _emit_gate_phase_progress(self, line: str, *, log_path: Path) -> None:
        """Republish a gate phase marker as a harness PROGRESS line.

        The gate runner's own markers live in the gate log, which the control
        plane does not read. Mirroring them into the run log puts grading into
        the same ``PROGRESS step=`` vocabulary every downstream consumer already
        parses, so grading progress appears in the live event feed instead of
        reading as dead air between attempts.

        Instrumentation only: this must never alter gate behaviour, and a
        malformed line is ignored rather than raised.
        """
        text = line.strip()

        # WO-GATE-ROSTER live signal. The gate runner announces each phase's
        # gate SET before spawning it, so the wall can mark those gates
        # under-test the moment the phase begins instead of waiting ~30 minutes
        # for the attempt record. PER-PHASE-SET, not per-test: `report.mjs`
        # spawns each runner with `spawnSync`, so a child's per-test output is
        # buffered until the phase has already ended and could never be live.
        #
        # The line carries a COUNT, not ids — identity already lives in the
        # roster the board reads, and the count is what makes roster/runner
        # drift detectable.
        if text.startswith("[report] gateset "):
            fields = dict(
                part.split("=", 1)
                for part in text[len("[report] gateset ") :].split()
                if "=" in part
            )
            phase = fields.get("phase")
            if phase:
                self._progress(
                    f"PROGRESS step=gate-phase-gates phase={phase} "
                    f"count={fields.get('count', 'unknown')} log={log_path}"
                )
            return

        if not text.startswith("[report] phase="):
            return
        fields = dict(
            part.split("=", 1)
            for part in text[len("[report] ") :].split()
            if "=" in part
        )
        phase = fields.get("phase")
        if not phase:
            return
        status = fields.get("status")
        if status is None:
            # Phase ANNOUNCED. Emitted before the phase runs, so a stall inside
            # it is attributable to a named phase rather than to "the gate".
            self._progress(
                f"PROGRESS step=gate-phase-start phase={phase} log={log_path}"
            )
        else:
            self._progress(
                f"PROGRESS step=gate-phase-end phase={phase} status={status} "
                f"problems={fields.get('problems', 'unknown')} log={log_path}"
            )

    def _run_opencode_serve(
        self,
        *,
        active_cell: DockerCell,
        serve_client: ServeClient,
        session_id: str,
        prompt: str,
        run_label: str,
        phase: str,
        prior_cost_usd: float = 0.0,
        timeout_s: float = 5400.0,
        kill_hook: Callable[[], None] | None = None,
    ) -> _OpencodeRunStats:
        """Drive ONE scoring attempt through the persistent opencode serve.

        WO-WATCH-1F serve-drive path: enqueue the prompt via
        ``POST /session/{sid}/prompt_async``, wait for the session to go idle
        (``GET /session/status`` busy->idle), then meter from the persisted
        transcript ``GET /session/{sid}/message`` via :func:`serve_client.metrics`.
        The harness's OWN timeout path MAY call ``POST /session/{sid}/abort``
        on ITS OWN session to stop serve-side generation; the never-abort rule
        applies ONLY to the founder's passive viewer, never to the harness's
        own timeout path. The harness never kills the serve itself (the
        per-attempt kill hook is serve-PID-scoped and survives by design).

        This path does NOT re-raise transport failures: a send error returns an
        ``_OpencodeRunStats`` with ``exit_code=1`` so the caller's budget/gating
        logic decides. ``session_id`` here is the serve-side session id
        (persisted on the serve).

        WO-LOOPREC-1: a relay loop-guard kill (``relay_loop_detected`` in the
        persisted assistant ``info.error``) is classified ``guard_abort`` and
        re-driven with the anti-repetition nudge. WO-FINALIZE-REC-1: a relay
        finalize-watchdog kill is classified
        ``transport_error/stream_finalize_timeout`` and re-driven with the
        resume nudge. Both recoveries are BOUNDED by
        ``_MAX_SERVE_RECOVERY_NUDGES`` and fail closed on exhaustion exactly
        like a non-recoverable terminal (the anomaly stays unretried, the
        drive ends). A killed turn never reads as completed work because it
        is subtracted from ``turns`` (scoring), not because the phase is
        failed; its tokens stay metered.
        """
        if kill_hook is None:
            kill_hook = active_cell.kill_worker_processes

        # A2: PUBLISH THE PHASE BEFORE THE PROMPT GOES OUT. This is the single
        # choke point every scoring attempt passes through, so it is the only
        # place the sentinel needs to be written — build chunks, recording
        # turns, recovery nudges and feedback rounds all arrive here with their
        # phase name, and the plugin's next session.idle reads whatever this
        # wrote.
        self._publish_compact_phase(active_cell=active_cell, phase=phase)

        # Surface every transient observation-read retry on the progress
        # stream. A retry nobody can see is indistinguishable from a serve that
        # never faulted, and a rising retry rate is the leading indicator of
        # D-SERVE-MESSAGE-500 degrading underneath a run that still looks green.
        set_read_retry_observer(
            lambda what, attempt, exc: self._progress(
                f"PROGRESS run_label={run_label} step=serve-read-retry "
                f"phase={phase} what={what} attempt={attempt} detail={exc}"
            )
        )

        # WO-WATCH-1E per-attempt evidence correlation id + start timestamp.
        # The evidence file path is
        # derived from the cell's worktree when available (real DockerCell);
        # otherwise it falls back to the system temp dir so the serve-drive
        # path stays hermetic (the only DockerCell surface it depends on is
        # ``kill_worker_processes``) without polluting the source tree.
        attempt_id = f"{run_label}-{phase}-{uuid.uuid4().hex[:12]}"
        ts_start_epoch_ms = int(time.time() * 1000)
        try:
            cell_worktree = Path(active_cell.config.worktree).expanduser().resolve()
        except (AttributeError, TypeError):
            cell_worktree = None
        evidence_dir = (
            cell_worktree.parent
            if cell_worktree is not None
            else Path(tempfile.gettempdir())
        )
        evidence_path = evidence_dir / TRUNCATION_EVIDENCE_FILENAME

        # WO-LOOPKILL-1: loop-kill marker fast-path dir. The egress sidecar's
        # guard writes loop-kill-<sid>.json here the moment it kills a looping
        # request (docker_worker mounts the SAME dir into the sidecar), so the
        # idle waiter can end a wedged turn in seconds instead of riding out
        # the stall bound. Derivation matches docker_worker exactly:
        # <worktree>.parent (the run dir) / LOOP_KILL_MARKER_DIRNAME. With no
        # worktree (hermetic-test fallback) there is no container and no marker
        # writer, so the check stays OFF (None) rather than pointing at the
        # shared temp dir where a stray marker could false-positive. A missing
        # dir is fine — the reader tolerates it.
        loop_kill_marker_dir = (
            str(cell_worktree.parent / LOOP_KILL_MARKER_DIRNAME)
            if cell_worktree is not None
            else None
        )

        # Phase baseline for per-phase delta metering: serve transcript metrics
        # are session-CUMULATIVE, so a phase's true cost is the delta against
        # this snapshot. Without deltas, every phase after the first
        # double-counts session totals, and a fully-dead phase (stream
        # dropped, assistant message discarded) masquerades as success with
        # stale cumulative numbers (2026-08-09 feedback-phase void).
        #
        # A FAILED BASELINE READ IS AN ABORT, NOT A DEGRADATION. It used to set
        # `baseline = None` and let the phase report SESSION-CUMULATIVE totals as
        # its own: a feedback phase that cost 3k tokens would publish the whole
        # session's running total instead, and nothing on the record said so.
        # That is a corrupted measurement wearing the shape of a good one — worse
        # than a missing phase, which at least reads as missing.
        try:
            baseline = serve_client.metrics(session_id)
        except ServeClientError as exc:
            self._progress(
                f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                f"status=abort reason=baseline_metrics_error detail={exc}"
            )
            raise ServeTransportError(
                f"could not read the phase baseline for {phase} ({exc}) — this "
                "phase cannot be metered honestly, and publishing cumulative "
                "session totals in its place would be a false measurement"
            ) from exc

        # Classification watermark (2026-08-10 live-cell defect): a guard- or
        # finalize-killed message keeps its info.error in the transcript
        # FOREVER, and extract_transcript_metrics surfaces it in error_texts on
        # every cumulative read. Classifying on the cumulative read re-trips
        # the SAME kill after a successful recovery — the live chunk-2 drive
        # recovered and finished its work, and was still classified
        # guard_abort twice more, which under the then-current nudge budget
        # exhausted it and voided the cell (the WO-NUDGE-INF-1 era removed
        # the exhaustion kill; WO-COMPACTION-RESTORE C5A re-added a bounded
        # one — but a stale re-classification would still burn recovery
        # budget on a kill that already recovered). The
        # classification surface is therefore WINDOWED to messages at/after
        # this watermark, and the watermark advances past each classified kill
        # before the recovery nudge re-drives. Metering deltas above are
        # unaffected (they diff cumulative reads).
        try:
            class_watermark = len(serve_client.get_messages(session_id))
        except ServeClientError:
            class_watermark = 0

        # A SECOND WATERMARK, TAKEN ONCE AND NEVER MOVED.
        #
        # `class_watermark` advances past each classified kill, which is right
        # for classification and wrong for the question the recovery path has to
        # answer: has THIS CHUNK already had its compaction? That has to be
        # measured from the start of the drive, because a compaction landing
        # anywhere in it is the chunk's one fire. A watermark that advances
        # would sit past it and report none.
        #
        # READ INDEPENDENTLY, FAILING OPEN (WO-25). Copying `class_watermark`
        # would inherit its `0`-on-failure fallback, and a bogus `0` counts the
        # WHOLE session as "since" — any past compaction then reads as this
        # chunk's fire and the hold below never releases. `None` marks the
        # watermark unknown, and the hold probe fails open on it.
        try:
            compact_watermark = len(serve_client.get_messages(session_id))
        except ServeClientError:
            compact_watermark = None

        # WO-LOOPREC-1/FINALIZE-REC-1 transport recovery: a guard-killed or
        # finalize-killed turn is metered (its tokens burned) but must NOT read
        # as completed work. When the terminal classification is recoverable,
        # mark the anomaly retried and re-drive the phase — anti-repetition
        # nudge for a guard kill (never the original prompt: the same prompt
        # into the same context is the loop's fuel), resume nudge for a finalize
        # kill.
        # BOUNDED (WO-COMPACTION-RESTORE C5A): recovery re-drives at most
        # _MAX_SERVE_RECOVERY_NUDGES times per phase, then fails closed the
        # SAME way a non-recoverable terminal does — the anomaly stays
        # unretried, the loop breaks, the drive ends. The measurement
        # protection is unchanged: every recovered turn is subtracted from
        # scoring turns below, so no number of nudges can inflate
        # turns/phases, while the tokens they burn stay fully metered. (The
        # WO-NUDGE-INF-1 unbounded era ended with the 2026-09-02
        # compaction-looping incident, which rode this loop to 126+ recovery
        # events with no exit.)
        recovery_nudges = 0
        provider_outages = 0
        # WO-LOOPKILL-1: count of turns in THIS drive ended by a fresh loop-kill
        # marker (wait_reason == LOOP_KILL_WAIT_REASON). The sidecar kills the
        # request mid-turn, so the transcript may carry NO loop signature and
        # the transcript-driven guard_aborted_turns delta cannot see these
        # kills; the count is carried separately and added to the guard-aborted
        # delta for the scoring exclusion below.
        loop_killed_turns = 0
        prompt_to_send = prompt
        turn_anomaly_list: list[dict[str, Any]] = []
        killed_reason: str | None = None
        exit_code = 0
        # Set when the transcript read fails past serve_client's transient
        # retries: the harness has lost its window onto the session, so the
        # phase carries no trustworthy measurement (D-SERVE-MESSAGE-500).
        observation_lost = False
        m: dict[str, Any] = {}
        while True:
            # 1) Enqueue the prompt asynchronously.
            try:
                serve_client.send_prompt(session_id, prompt_to_send)
            except ServeClientError as exc:
                self._progress(
                    f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                    f"status=send_error detail={exc}"
                )
                return _OpencodeRunStats(
                    input_tokens=0,
                    output_tokens=0,
                    reasoning_tokens=0,
                    turns=0,
                    session_id=session_id,
                    killed_reason=None,
                    exit_code=1,
                    cost_usd=0.0,
                    turn_anomalies=tuple(turn_anomaly_list),
                    recovery_nudges=recovery_nudges,
                )

            # 2) Confirm the serve actually picked the prompt up (busy), THEN wait
            #    for completion (busy->idle). prompt_async is fire-and-forget: a
            #    bare wait_idle races the serve's busy flag and returns a false
            #    idle in milliseconds, metering turns=0 while gates run against a
            #    worktree the model is still writing (2026-08-09 void cell).
            #    A never-busy send is a loud transport failure (exit 1), never a
            #    clean zero-turn "ok" — unless the transcript already shows turns
            #    (a turn that raced past the busy window is metered, not voided).
            busy_grace_s = 60.0
            went_busy = serve_client.wait_busy(session_id, timeout_s=busy_grace_s)
            killed_reason = None
            exit_code = 0
            loop_killed_this_turn = False
            stalled_this_turn = False
            if not went_busy:
                self._progress(
                    f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                    f"status=never_busy grace_s={busy_grace_s:.0f} session_id={session_id}"
                )
                try:
                    early = serve_client.metrics(session_id)
                except ServeClientError:
                    early = None
                dead = True
                if early:
                    # `baseline` is never None now — a failed baseline read
                    # aborts the phase above rather than degrading it.
                    dead = (
                        int(early.get("turns") or 0) - int(baseline.get("turns") or 0)
                        <= 0
                        and int(early.get("output_tokens") or 0)
                        - int(baseline.get("output_tokens") or 0)
                        <= 0
                    )
                if dead:
                    return _OpencodeRunStats(
                        input_tokens=0,
                        output_tokens=0,
                        reasoning_tokens=0,
                        turns=0,
                        session_id=session_id,
                        killed_reason=None,
                        exit_code=1,
                        cost_usd=0.0,
                        turn_anomalies=tuple(turn_anomaly_list),
                        recovery_nudges=recovery_nudges,
                    )
                # The turn completed inside the busy-grace window; fall through to
                # the normal metering path with idle already reached.
                idle = True
                wait_reason = "idle"
            else:
                # The serve-side generation may continue briefly after idle
                # returns; do NOT wait further.
                # WO-LOOPKILL-1: the freshness bound for the marker fast path —
                # only a marker written at/after this instant (epoch ms) counts,
                # so a stale marker from an earlier turn can never kill this one.
                turn_start_ts_ms = int(time.time() * 1000)
                idle, wait_reason = serve_client.wait_idle_detailed(
                    session_id,
                    timeout_s=timeout_s,
                    stall_timeout_s=DEFAULT_TURN_STALL_TIMEOUT_S,
                    loop_kill_marker_dir=loop_kill_marker_dir,
                    turn_start_ts_ms=turn_start_ts_ms,
                )
            if not idle:
                # WO-LOOPKILL-1: a fresh loop-kill marker ended the wait. The
                # turn is wedged exactly like a stall and gets un-stuck the same
                # way (abort + kill hook below), but the kill is the loop
                # guard's: the marker is proof of a kill whose signature may
                # never reach the transcript, so the turn is classified
                # downstream as a RECOVERABLE guard-abort (forced at the
                # classifier) instead of the UNRECOVERABLE turn_stalled.
                # killed_reason/exit_code stay clean so the recovery gate passes.
                loop_killed_this_turn = wait_reason == LOOP_KILL_WAIT_REASON
                stalled_this_turn = wait_reason == "stalled"
                if loop_killed_this_turn:
                    loop_killed_turns += 1
                elif not stalled_this_turn:
                    # Distinguish "the cell's whole budget ran out" from "this
                    # turn stopped progressing". Both end the drive; only the
                    # second says something went wrong with a single command.
                    killed_reason = "run_timeout"
                    exit_code = 1
                # else: stalled_this_turn. WO-21 STALL-RECOVERY (operator ruling
                # 2026-09-11): a stalled turn now rides the SAME recoverable path
                # as a loop kill — killed_reason/exit_code stay clean so the
                # recovery gate passes; the classifier forces TURN_TERMINAL_STALLED
                # below and the stall is counted from its anomaly record.
                # WO-25 STALL-ABORT HOLD: write `repair` BEFORE the abort. The
                # abort's own session.idle is not a boundary. A loop-kill is
                # already covered — the sidecar writes `repair` at its kill —
                # but a stall has no sidecar, so without this the stall's own
                # abort idle could fire the summarizer mid-stall. The recovery
                # probe republishes `build` when the chunk has not compacted.
                if stalled_this_turn:
                    self._publish_compact_phase(
                        active_cell=active_cell, phase=phase, held=True
                    )
                # WO-WATCH-1F: genuinely stop serve-side generation before teardown.
                # An abort failure is logged but must NOT mask the timeout outcome.
                try:
                    serve_client.abort(session_id)
                except Exception as exc:  # noqa: BLE001 - never mask the timeout outcome.
                    self._progress(
                        f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                        f"status=abort_failed reason={exc}"
                    )
                else:
                    self._progress(
                        f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                        f"status=abort_issued session_id={session_id}"
                    )
                try:
                    kill_hook()
                except Exception as exc:  # noqa: BLE001 - never mask the timeout outcome.
                    self._progress(
                        f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                        f"status=kill_hook_error detail={exc}"
                    )
                self._progress(
                    f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                    f"status={'loop_killed' if loop_killed_this_turn else ('turn_stalled' if stalled_this_turn else killed_reason)} "
                    f"wait_reason={wait_reason} "
                    f"timeout_s={timeout_s:.1f} "
                    f"stall_timeout_s={DEFAULT_TURN_STALL_TIMEOUT_S:.0f} "
                    f"session_id={session_id}"
                )

            # 3) Pull metrics from the persisted transcript.
            try:
                m = serve_client.metrics(session_id)
                m_window = serve_client.metrics(session_id, since=class_watermark)
            except ServeClientError as exc:
                # OBSERVATION LOST (D-SERVE-MESSAGE-500). serve_client already
                # retried this read through every transient fault, so reaching
                # here means the harness can no longer see the session at all.
                #
                # This is NOT a capability result and must never be scored as
                # one: the classification window is empty, so the recovery
                # classifier below is blind by construction (it reads only
                # error_texts/truncations/error_parts/info_errors) and would
                # report "no anomaly" for a session that may still be running.
                # That blindness is exactly what voided the 2026-08-11 cell.
                #
                # Record it as a first-class terminal so run_artifacts can gate
                # the cell VOID-INSTRUMENT instead of letting gates run against
                # a half-written worktree and report a false capability FAIL.
                self._progress(
                    f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                    f"status=observation_lost detail={exc}"
                )
                observation_lost = True
                # Baseline is always present (a failed baseline read aborts the
                # phase), so a lost observation reports a ZERO delta against it
                # rather than inventing an empty metrics dict.
                m = dict(baseline)
                m_window = {}
                if exit_code == 0:
                    exit_code = 1

            if observation_lost:
                # The classifier cannot see anything (m_window is empty), so
                # record the lost-observation terminal explicitly rather than
                # letting the blind classifier report a clean phase.
                turn_anomaly_list.append(
                    {
                        "phase": str(phase),
                        "turn_index": int(m.get("turns", 0) or 0),
                        "terminal": TURN_TERMINAL_OBSERVATION_LOST,
                        "reason": REASON_OBSERVATION_LOST,
                        "tool_uses": 0,
                        "file_writes": 0,
                        "input_tokens": int(m.get("input_tokens", 0) or 0),
                        "output_tokens": int(m.get("output_tokens", 0) or 0),
                        "reasoning_tokens": int(m.get("reasoning_tokens", 0) or 0),
                        "cost_usd": float(m.get("cost_usd", 0.0) or 0.0),
                        "tokens_unmetered": True,
                        "wall_seconds": None,
                        "retried": False,
                        "retry_kind": None,
                        "session_id": session_id,
                    }
                )
                break

            # ── FAIL-FAST: the worker's own compaction is loop-killing ──────
            #
            # When self-compaction is armed, the worker plugin (not the harness)
            # fires the summarize. If the relay's loop guard kills that
            # summarize, opencode AUTO-RETRIES it (compaction_restores) — a
            # self-sustaining storm. The harness must NOT nudge around it: it
            # does not drive compaction, so a recovery nudge is meaningless
            # there, and nudging around opencode's retry loop is exactly the
            # 2026-09-03 10-minute hang (run 1788451466: compact-1 ok, compact-2
            # relay_loop_detected xN, nudged to the budget).
            #
            # DISJOINT FROM THE BUILD-TURN NUDGE: this branch keys on
            # ``agent=compaction`` kills only, and runs BEFORE
            # classify_transport_anomaly. A build-turn guard abort
            # (``agent=build``) never matches here and reaches the nudge path
            # below unchanged.
            if (
                self.compact
                and serve_client.guard_killed_compactions_since(
                    session_id, class_watermark
                )
                > 0
            ):
                self._progress(
                    f"PROGRESS run_label={run_label} step=compaction-loop-kill "
                    f"phase={phase} session_id={session_id} action=abort"
                )
                exit_code = 1
                killed_reason = "compaction_loop_killed"
                turn_anomaly_list.append(
                    {
                        "phase": str(phase),
                        "turn_index": int(m.get("turns", 0) or 0),
                        "terminal": "compaction_loop_killed",
                        "reason": REASON_LOOP_GUARD,
                        "tool_uses": 0,
                        "file_writes": 0,
                        "input_tokens": int(m.get("input_tokens", 0) or 0),
                        "output_tokens": int(m.get("output_tokens", 0) or 0),
                        "reasoning_tokens": int(m.get("reasoning_tokens", 0) or 0),
                        "cost_usd": float(m.get("cost_usd", 0.0) or 0.0),
                        "tokens_unmetered": False,
                        "wall_seconds": None,
                        "retried": False,
                        "retry_kind": None,
                        "session_id": session_id,
                    }
                )
                break

            terminal, reason = classify_transport_anomaly(m_window)
            if loop_killed_this_turn:
                # WO-LOOPKILL-1: the marker IS the kill evidence. The sidecar
                # killed the request mid-turn, so the relay's loop signature
                # may never have reached the transcript and the classifier
                # can legitimately find nothing. Force the guard-abort terminal
                # so the turn rides the EXISTING recoverable path (anomaly
                # record, evidence line, nudge, watermark advance, re-drive)
                # exactly like a transcript-visible loop kill.
                terminal, reason = TERMINAL_GUARD_ABORT, REASON_LOOP_GUARD
            elif stalled_this_turn:
                # WO-21 STALL-RECOVERY: mirror the loop-kill force. The stall
                # watchdog is proof the turn wedged, but the transcript carries no
                # signature, so force the stall terminal to ride the existing
                # recoverable path (anomaly record, nudge, watermark, re-drive).
                terminal, reason = TURN_TERMINAL_STALLED, REASON_TOOL_CALL_TIMEOUT
            if terminal is not None:
                if terminal == "truncated":
                    mapped_terminal = TURN_TERMINAL_TRUNCATED
                elif terminal == TERMINAL_GUARD_ABORT:
                    mapped_terminal = TURN_TERMINAL_GUARD_ABORT
                elif terminal == "transport_error":
                    mapped_terminal = TURN_TERMINAL_TRANSPORT_ERROR
                else:
                    mapped_terminal = terminal
                anomaly_record: dict[str, Any] = {
                    "phase": str(phase),
                    "turn_index": int(m.get("turns", 0)),
                    "terminal": str(mapped_terminal),
                    "reason": str(reason or ""),
                    # The step-finish reason this turn ACTUALLY ended on. The
                    # truncated class is wider here than in
                    # TRUNCATED_STEP_FINISH_REASONS — serve_client counts
                    # `length` as a truncation and this file does not — so the
                    # raw reason has to travel for a consumer to tell an output
                    # cap from a dead stream. It already rode into the evidence
                    # file below; it just never rode into the record.
                    "finish_reason": m.get("last_finish"),
                    "tool_uses": 0,
                    "file_writes": 0,
                    "input_tokens": int(m.get("input_tokens", 0) or 0),
                    "output_tokens": int(m.get("output_tokens", 0) or 0),
                    "reasoning_tokens": int(m.get("reasoning_tokens", 0) or 0),
                    "cost_usd": float(m.get("cost_usd", 0.0) or 0.0),
                    "tokens_unmetered": False,
                    "wall_seconds": None,
                    "retried": False,
                    "retry_kind": None,
                    "session_id": session_id,
                }
                turn_anomaly_list.append(anomaly_record)
                self._write_truncation_evidence(
                    record=_build_truncation_evidence(
                        attempt_id=attempt_id,
                        run_label=run_label,
                        phase=phase,
                        terminal=mapped_terminal,
                        reason=str(reason or ""),
                        ts_start_epoch_ms=ts_start_epoch_ms,
                        ts_end_epoch_ms=int(time.time() * 1000),
                        wall_seconds=None,
                        session_id=session_id,
                        received_bytes=None,
                        received_lines=None,
                        last_event_type=None,
                        last_event_ts=None,
                        finish_reason=m.get("last_finish"),
                        output_tokens_received=int(m.get("output_tokens", 0) or 0),
                        input_tokens_received=int(m.get("input_tokens", 0) or 0),
                        reasoning_tokens_received=int(
                            m.get("reasoning_tokens", 0) or 0
                        ),
                        truncations_seen=int(m.get("truncations", 0) or 0),
                    ),
                    evidence_path=evidence_path,
                )
                is_provider_outage = (
                    mapped_terminal == TURN_TERMINAL_TRANSPORT_ERROR
                    and str(reason or "") == REASON_PROVIDER_UNAVAILABLE
                )
                # RELAY STREAM DEATH — both of the relay's shapes, one class,
                # one recovery (the resume nudge). The reason recorded on the
                # anomaly stays the precise one that fired.
                is_stream_death = (
                    mapped_terminal == TURN_TERMINAL_TRANSPORT_ERROR
                    and str(reason or "") in RECOVERABLE_STREAM_DEATH_REASONS
                )
                # THE RECOVERY SET — closed (four members, 2026-09-11). Three are
                # upstream terminals raised by the proxy (guard_abort,
                # provider_outage, stream_death). The fourth, turn_stalled, is the
                # harness's own stall watchdog — a terminal the harness raises over
                # a turn the model wedged, not prose the model wrote. Operator
                # ruling: nudging a stall is "model behaviour, not a void
                # classifier", the same precedent that already admitted guard_abort.
                # Nothing derived from what the model WROTE (its prose) is
                # recoverable, and nothing of that kind may be added here.
                recoverable = (
                    mapped_terminal == TURN_TERMINAL_GUARD_ABORT
                    or mapped_terminal == TURN_TERMINAL_STALLED
                    or is_provider_outage
                    or is_stream_death
                )
                if (
                    recoverable
                    and killed_reason is None
                    and exit_code == 0
                    and recovery_nudges < _MAX_SERVE_RECOVERY_NUDGES
                ):
                    anomaly_record["retried"] = True
                    anomaly_record["retry_kind"] = "harness_resume"
                    recovery_nudges += 1
                    # ── THE EVENT THAT VOIDS CELLS, SAID OUT LOUD ───────────
                    #
                    # Each of these is a TRUNCATED TURN, and `_truncation_signal`
                    # needs only one: a non-green terminal attempt with
                    # `truncated_turns > 0` is dropped from the scored set as an
                    # instrument failure. Ten of these — every one of them a
                    # loop-guard fire later certified FALSE — voided a cell that
                    # had run 3h08m, passed five verdict passes and published
                    # 265 gate verdicts.
                    #
                    # Until now the only trace was a PROGRESS line on stdout,
                    # emitted TWICE (once structured, once bare) and recoverable
                    # only by regex-deduping the log downstream. The board's
                    # loop-guard tile could show the count; nothing could show
                    # WHICH turns, in WHICH phase, or that the cell was quietly
                    # accumulating the thing that would disqualify it.
                    #
                    # `warn`, not `error`: the harness is recovering as designed
                    # and the run continues. Whether this one costs the cell is
                    # not knowable here — it depends on the terminal attempt's
                    # verdict, minutes away and decided elsewhere — so the level
                    # describes the event, never its eventual cost.
                    live = getattr(self, "_live", None)
                    if live is not None:
                        live.notice(
                            "harness",
                            "turn_truncated_retried",
                            level="warn",
                            cell_seq=getattr(self, "_cell_seq", None),
                            session_id=session_id,
                            detail={
                                "phase": phase,
                                "terminal": mapped_terminal,
                                "nudge": recovery_nudges,
                                "budget_remaining": (
                                    _MAX_SERVE_RECOVERY_NUDGES - recovery_nudges
                                ),
                            },
                        )
                    self._progress(
                        f"PROGRESS run_label={run_label} step=transport-recovery "
                        f"phase={phase} terminal={mapped_terminal} action=nudge "
                        f"nudge={recovery_nudges} "
                        f"budget_remaining={_MAX_SERVE_RECOVERY_NUDGES - recovery_nudges} "
                        f"session_id={session_id}"
                    )
                    if mapped_terminal == TURN_TERMINAL_GUARD_ABORT:
                        prompt_to_send = _LOOP_RECOVERY_NUDGE
                    elif mapped_terminal == TURN_TERMINAL_STALLED:
                        prompt_to_send = _STALL_RECOVERY_NUDGE
                    elif is_provider_outage:
                        prompt_to_send = _PROVIDER_RECOVERY_NUDGE
                        # Hold off before asking again. Re-prompting a provider
                        # that just said it was unavailable only spends another
                        # turn to hear the same thing.
                        provider_outages += 1
                        backoff_s = _provider_backoff_seconds(provider_outages)
                        self._progress(
                            f"PROGRESS run_label={run_label} step=transport-recovery "
                            f"phase={phase} terminal={mapped_terminal} "
                            f"reason={REASON_PROVIDER_UNAVAILABLE} "
                            f"outage={provider_outages} backoff_s={backoff_s:.0f} "
                            f"session_id={session_id}"
                        )
                        self._provider_backoff(backoff_s)
                    else:
                        prompt_to_send = _FINALIZE_RECOVERY_NUDGE
                    # Advance the classification window PAST the kill just
                    # classified: the persisted error never leaves the
                    # transcript, so without this the post-nudge read
                    # re-classifies the same kill (see the watermark note
                    # at phase baseline). A failed probe keeps the old
                    # watermark — a stuck window re-trips LOUD, never
                    # silently clean.
                    try:
                        class_watermark = len(serve_client.get_messages(session_id))
                    except ServeClientError:
                        pass
                    # ── THE HOLD IS NOW CONDITIONAL, AND WHY ──────────────
                    #
                    # This used to publish `repair` here, on the reasoning that
                    # "the boundary idle already fired at the loop-kill abort
                    # that triggered this nudge". That was TRUE ONLY BECAUSE OF
                    # A DEFECT: the plugin fired its summarize on the idle that
                    # a DYING stream emits, which is not a boundary at all. It
                    # then diverted the agent into the compaction agent and
                    # stopped the drive (measured, run 1789125594).
                    #
                    # The plugin now gates that itself — it records the turn a
                    # `session.error` killed and refuses to summarize it. So no
                    # compaction fires on a death, and the re-drive's completion
                    # IS this chunk's one boundary.
                    #
                    # Holding here would therefore leave the sentinel on
                    # `repair` for the rest of the drive, the real boundary
                    # could never compact, and `_settle_after_chunk` would abort
                    # the cell with `no_compaction_evidence`. Measured exactly
                    # that way on run 1789127719, chunk 5: two nudges, no
                    # compaction, cell dead.
                    #
                    # ── SO ASK, RATHER THAN ASSUME EITHER WAY ─────────────
                    #
                    # Unconditionally holding breaks the gated case; never
                    # holding breaks the un-gated one. Both are real: the
                    # plugin's gate keys on `session.error`, and not every way a
                    # turn can die is guaranteed to emit one (a turn that simply
                    # stops with no signal does not).
                    #
                    # The harness can just LOOK. `completed_compactions_since`
                    # is the same evidence `_settle_after_chunk` requires at the
                    # boundary, so this asks the one question that decides it:
                    # has this chunk already had its compaction?
                    #
                    #   already fired -> HOLD (`repair`). The re-drive must
                    #                    not spend a second fire (the chunk-4
                    #                    double-fire that exhausted the budget
                    #                    by chunk 6).
                    #   not fired     -> REPUBLISH `build`. The re-drive's
                    #                    completion is this chunk's one real
                    #                    boundary, and holding would make
                    #                    `_settle_after_chunk` abort the cell
                    #                    with no_compaction_evidence (measured,
                    #                    run 1789127719 chunk 5). The republish
                    #                    is active, not a no-op: the loop-kill
                    #                    sidecar writes `repair` at its kill,
                    #                    and the stall-abort hold writes it too
                    #                    — this is the ONLY place that restores
                    #                    `build`, so without it the boundary
                    #                    idle could never summarize.
                    #
                    # A read failure — or a watermark never captured (`None`) —
                    # FAILS OPEN to `build` (WO-25). Holding on a lost read
                    # strands the sentinel on `repair` for the rest of the
                    # drive, which kills the cell at the boundary with
                    # no_compaction_evidence: the exact measured failure above.
                    # The double-fire a wrong open risks instead is the lesser
                    # cost — it burns one budget fire, and every later nudge
                    # re-probes.
                    try:
                        already = (
                            serve_client.completed_compactions_since(
                                session_id, compact_watermark
                            )
                            if compact_watermark is not None
                            else 0
                        )
                    except ServeClientError:
                        already = 0
                    self._publish_compact_phase(
                        active_cell=active_cell, phase=phase, held=bool(already)
                    )
                    continue
                if recoverable and killed_reason is None and exit_code == 0:
                    # BUDGET EXHAUSTED (WO-COMPACTION-RESTORE C5A). The kill is
                    # still classified recoverable, but the drive stops
                    # re-driving: it falls through to the SAME outcome a
                    # NON-recoverable terminal gets — the anomaly stays
                    # unretried, the loop breaks below, the drive ends, and the
                    # unretried anomaly climbs the cell ledger. Fail-closed: a
                    # kill that repeats past the budget is a storm, and the
                    # 2026-09-02 compaction-looping incident (126+ recovery
                    # events) is what an unbounded storm costs.
                    # THE STORM LIMIT. The kill is still classified recoverable
                    # but the drive stops re-driving, so this turn stays
                    # unretried and climbs the cell ledger. `error`: unlike a
                    # nudge, nothing here recovers, and the 2026-09-02 compaction
                    # incident (126+ recovery events) is what the unbounded
                    # version costs.
                    live = getattr(self, "_live", None)
                    if live is not None:
                        live.notice(
                            "harness",
                            "recovery_budget_exhausted",
                            level="error",
                            cell_seq=getattr(self, "_cell_seq", None),
                            session_id=session_id,
                            detail={
                                "phase": phase,
                                "terminal": mapped_terminal,
                                "nudges": recovery_nudges,
                                "budget": _MAX_SERVE_RECOVERY_NUDGES,
                            },
                        )
                    self._progress(
                        f"PROGRESS run_label={run_label} step=transport-recovery "
                        f"phase={phase} terminal={mapped_terminal} "
                        f"action=budget_exhausted nudges={recovery_nudges} "
                        f"budget={_MAX_SERVE_RECOVERY_NUDGES} session_id={session_id}"
                    )
            break

        turn_anomalies: tuple[dict[str, Any], ...] = tuple(turn_anomaly_list)

        def _d(key: str) -> int:
            end_v = int(m.get(key, 0) or 0)
            return end_v - int(baseline.get(key, 0) or 0)

        d_input = _d("input_tokens")
        d_output = _d("output_tokens")
        d_reasoning = _d("reasoning_tokens")
        d_cache_read = _d("cache_read_tokens")
        d_cache_write = _d("cache_write_tokens")
        d_turns = _d("turns")
        # WO-LOOPKILL-1: marker-backed loop kills are guard kills the
        # transcript-driven delta cannot see (the sidecar killed the request
        # before any signature persisted), so the drive's own count is added
        # here. Each is then excluded from scoring turns exactly like a
        # transcript-visible guard abort (WO-TURNACCT-1) and carried on
        # guard_aborted_turns — never silent.
        d_guard_aborted = _d("guard_aborted_turns") + loop_killed_turns
        d_finalize_timeouts = _d("finalize_timeouts")
        # WO-TURNACCT-1 (Walter 2026-08-10): guard-killed turns are EXCLUDED
        # from scoring turns — their tokens stay metered (real burn), the
        # excluded count is carried on guard_aborted_turns (never silent), and
        # the raw session turn_index cursors stay untouched (watermarks key on
        # them). A killed turn never reads as completed work: the subtraction
        # is what keeps the measurement honest (RC-4).
        # WO-NUDGE-INF-1 (Walter 2026-08-11): finalize-killed turns are excluded
        # on exactly the same grounds. This is what keeps recovery from
        # inflating the measurement: a phase that was nudged N times reports
        # the same scoring turns as one that was never nudged, while every
        # burned token stays on the token counters.
        scoring_turns = max(0, d_turns - d_guard_aborted - d_finalize_timeouts)
        d_truncations = _d("truncations")
        d_cost = float(m.get("cost_usd", 0.0) or 0.0) - float(
            baseline.get("cost_usd", 0.0) or 0.0
        )

        if exit_code == 0 and d_turns <= 0 and d_output <= 0 and d_input <= 0:
            # The phase reached idle but produced NOTHING: the final assistant
            # message was discarded (relay stream-finalize defect, 2026-08-09)
            # or the serve never generated. Loud exit 1 — never a clean zero
            # that lets gates run against a stale worktree.
            exit_code = 1
            turn_anomalies = turn_anomalies + (
                {
                    "phase": str(phase),
                    "turn_index": int(m.get("turns", 0)),
                    "terminal": "silent_phase",
                    "reason": "phase produced zero new turns and zero new tokens",
                    "tool_uses": 0,
                },
            )
            self._progress(
                f"PROGRESS run_label={run_label} step=serve-drive phase={phase} "
                f"status=silent_phase session_id={session_id}"
            )

        self._progress(
            f"PROGRESS run_label={run_label} step=serve-drive-end phase={phase} "
            f"turns={scoring_turns} guard_aborted_turns={d_guard_aborted} "
            f"finalize_timeout_turns={d_finalize_timeouts} "
            f"observation_lost={'1' if observation_lost else '0'} "
            f"recovery_nudges={recovery_nudges} "
            f"session_turns={m.get('turns', 0)} "
            f"input={d_input} output={d_output} reasoning={d_reasoning} "
            f"cache_read={d_cache_read} cache_write={d_cache_write} "
            f"session_id={session_id} cost_usd={d_cost:.4f} "
            f"status={'ok' if idle else 'timeout'}"
        )

        return _OpencodeRunStats(
            input_tokens=d_input,
            output_tokens=d_output,
            reasoning_tokens=d_reasoning,
            cache_read_tokens=d_cache_read,
            cache_write_tokens=d_cache_write,
            turns=scoring_turns,
            session_id=session_id,
            killed_reason=killed_reason,
            exit_code=exit_code,
            cost_usd=d_cost,
            budget_stop_detected=False,
            budget_stop_signature=None,
            truncations=d_truncations,
            zero_tool_turns=0,
            terminal_zero_tool_turn=False,
            zero_tool_resumes=0,
            zero_tool_turn_honest_fail=False,
            resume_count=0,
            turn_anomalies=turn_anomalies,
            unmetered_turns=0,
            unmetered_turn_wall_s=0.0,
            recovery_nudges=recovery_nudges,
            guard_aborted_turns=d_guard_aborted,
            finalize_timeout_turns=d_finalize_timeouts,
            observation_lost_turns=1 if observation_lost else 0,
        )

    def _run_opencode_serve_chunked(
        self,
        *,
        active_cell: DockerCell,
        serve_client: ServeClient,
        session_id: str,
        prompts: list[str],
        run_label: str,
        sidecar_path: Path | None = None,
        prior_cost_usd: float = 0.0,
        timeout_s: float = 5400.0,
        kill_hook: Callable[[], None] | None = None,
        extraction_state_dir: Path | None = None,
    ) -> _OpencodeRunStats:
        """WO-77 chunked first pass: drive the chunk prompts IN ORDER through the
        one serve session.

        PER CHUNK: drive -> (optional) recording turn -> settle the worker's own
        compaction -> next chunk. A drive is over when the session goes IDLE;
        a non-zero exit ends the whole build there and every later chunk is
        reported ``not_reached``.

        NOTHING HERE READS WHAT THE MODEL WROTE (WO-MARKER-RIP, 2026-09-09).
        The loop used to scan each chunk's own messages for a `CHUNK FINISHED`
        string and re-drive up to ten times when it was absent. That was a
        self-report gating an event the transport already reports, and it is
        deleted — prompts, scan, nudge, budget and failure reason alike.

        Aggregates are the sum of per-chunk deltas (the per-phase metering in
        :meth:`_run_opencode_serve` is delta-true).
        """
        sum_input = 0
        sum_output = 0
        sum_reasoning = 0
        sum_cache_read = 0
        sum_cache_write = 0
        sum_turns = 0
        sum_cost = 0.0
        sum_truncations = 0
        sum_recovery_nudges = 0
        sum_guard_aborted = 0
        sum_finalize_timeouts = 0
        sum_observation_lost = 0
        anomalies: list[dict[str, Any]] = []
        chunk_reports: list[dict[str, Any]] = []

        def _aggregate(
            *, exit_code: int | None, killed_reason: str | None
        ) -> _OpencodeRunStats:
            return _OpencodeRunStats(
                input_tokens=sum_input,
                output_tokens=sum_output,
                reasoning_tokens=sum_reasoning,
                cache_read_tokens=sum_cache_read,
                cache_write_tokens=sum_cache_write,
                turns=sum_turns,
                session_id=session_id,
                killed_reason=killed_reason,
                exit_code=exit_code,
                cost_usd=sum_cost,
                truncations=sum_truncations,
                turn_anomalies=tuple(anomalies),
                chunk_reports=tuple(chunk_reports),
                recovery_nudges=sum_recovery_nudges,
                guard_aborted_turns=sum_guard_aborted,
                finalize_timeout_turns=sum_finalize_timeouts,
                observation_lost_turns=sum_observation_lost,
            )

        def _drive(phase: str, prompt: str) -> _OpencodeRunStats:
            nonlocal \
                sum_input, \
                sum_output, \
                sum_reasoning, \
                sum_turns, \
                sum_cost, \
                sum_truncations
            nonlocal sum_cache_read, sum_cache_write
            nonlocal sum_recovery_nudges, sum_guard_aborted, sum_finalize_timeouts
            nonlocal sum_observation_lost
            stats = self._run_opencode_serve(
                active_cell=active_cell,
                serve_client=serve_client,
                session_id=session_id,
                prompt=prompt,
                run_label=run_label,
                phase=phase,
                prior_cost_usd=prior_cost_usd + sum_cost,
                timeout_s=timeout_s,
                kill_hook=kill_hook,
            )
            sum_input += stats.input_tokens
            sum_output += stats.output_tokens
            sum_reasoning += stats.reasoning_tokens
            sum_cache_read += stats.cache_read_tokens
            sum_cache_write += stats.cache_write_tokens
            sum_turns += stats.turns
            sum_cost += stats.cost_usd
            sum_truncations += stats.truncations
            sum_recovery_nudges += stats.recovery_nudges
            sum_guard_aborted += stats.guard_aborted_turns
            sum_finalize_timeouts += stats.finalize_timeout_turns
            sum_observation_lost += stats.observation_lost_turns
            anomalies.extend(stats.turn_anomalies)
            return stats

        for index, chunk_prompt in enumerate(prompts, start=1):
            phase = f"initial-chunk-{index}"
            if sidecar_path is not None:
                self._append_user_event(
                    kind="chunk",
                    run_label=run_label,
                    sidecar_path=sidecar_path,
                    attempt=1,
                    text=chunk_prompt,
                )
            report: dict[str, Any] = {
                "chunk": index,
                "recovery_nudges": 0,
                "guard_aborted_turns": 0,
                "finalize_timeout_turns": 0,
            }
            # Watermark BEFORE the drive. `_settle_after_chunk` counts the
            # worker's own compactions since this point, and the fire happens
            # DURING one of the drives below — a watermark taken afterwards
            # sits past it and reads zero.
            watermark = len(serve_client.get_messages(session_id))
            stats = _drive(phase, chunk_prompt)
            report["recovery_nudges"] += stats.recovery_nudges
            report["guard_aborted_turns"] += stats.guard_aborted_turns
            report["finalize_timeout_turns"] += stats.finalize_timeout_turns
            report.update(
                turns=stats.turns,
                input_tokens=stats.input_tokens,
                output_tokens=stats.output_tokens,
                exit_code=stats.exit_code,
                # Named cause, for the operator strip: "died (run_timeout)"
                # rather than "died (exit_code=1)".
                killed_reason=stats.killed_reason,
            )
            chunk_reports.append(report)
            if stats.exit_code != 0:
                return _aggregate(
                    exit_code=stats.exit_code, killed_reason=stats.killed_reason
                )

            # ── THE RECORDING TURN ──────────────────────────────────────────
            #
            # HERE, and nowhere else: after the chunk drive has reached a clean
            # idle (the chunk is closed, so there is something to record) and
            # BEFORE compaction settles (the material is still in context). Run
            # 1788976174 lost all thirteen of its boundaries into the gap
            # between these two points.
            #
            # SINCE WO-MARKER-RIP THIS TURN IS ALSO THE COMPACTION BOUNDARY.
            # When it is enabled the phase sentinel flags THIS drive, not the
            # chunk drive, so the worker's own compaction fires on this turn's
            # idle — after the recording, never before it. See
            # `compact_phase_for`.
            #
            # THE GAP IS MEASURED, NOT ASSUMED. The count comes from the memory
            # layer's own persisted master, never from asking the model whether
            # it complied — a self-report is the one kind of evidence this
            # project rejects everywhere else. `None` means unreadable (no layer,
            # or nothing written yet) and stays distinct from zero.
            if self.record_at_chunk_end:
                before = _recorded_claim_count(extraction_state_dir, session_id)
                rec_stats = _drive(f"{phase}-record-{index}", _RECORD_NOW_MD)
                report["recovery_nudges"] += rec_stats.recovery_nudges
                report["guard_aborted_turns"] += rec_stats.guard_aborted_turns
                report["finalize_timeout_turns"] += rec_stats.finalize_timeout_turns
                after = _recorded_claim_count(extraction_state_dir, session_id)

                report["record_asked"] = True
                if before is None or after is None:
                    report["record_landed"] = None
                    report["claims_added"] = None
                    outcome = "unreadable"
                else:
                    added = after - before
                    report["record_landed"] = added > 0
                    report["claims_added"] = added
                    outcome = "landed" if added > 0 else "MISSED"
                self._progress(
                    f"PROGRESS run_label={run_label} step=chunk-record "
                    f"chunk={index} session_id={session_id} outcome={outcome} "
                    f"claims_before={before} claims_after={after}"
                )
                if rec_stats.exit_code != 0:
                    return _aggregate(
                        exit_code=rec_stats.exit_code,
                        killed_reason=rec_stats.killed_reason,
                    )

            # ── LET THE WORKER'S OWN COMPACTION SETTLE ──────────────────────
            #
            # The chunk is closed. If self-compaction is armed, the plugin saw
            # the phase sentinel read `build` on the boundary drive's
            # session.idle and fired its own summarize — which happens DURING
            # that drive, not after it: the plugin fires the moment idle is
            # published, before the drive's stable-idle wait returns, so the
            # compaction has typically already completed by the time the drive
            # reports serve-drive-end. Detection therefore uses the PRE-DRIVE
            # watermark (captured above), not a fresh one taken now — a
            # post-drive watermark sits PAST the compaction and reports zero.
            #
            # THE HARNESS OBSERVES, IT DOES NOT DRIVE. It waits (bounded) and
            # requires the worker's own summarize to have landed a compaction
            # part since the pre-drive watermark: no part is
            # no_compaction_evidence and aborts the cell. It never triggers,
            # never substitutes, never retries — driver-issued compaction is
            # what turned one killed generation into a 40-minute storm on
            # 2026-09-03 (68 kills, run 1788415430).
            if self.compact:
                self._settle_after_chunk(
                    serve_client=serve_client,
                    session_id=session_id,
                    run_label=run_label,
                    chunk=index,
                    watermark=watermark,
                )

        return _aggregate(exit_code=0, killed_reason=None)

    def _settle_after_chunk(
        self,
        *,
        serve_client: ServeClient,
        session_id: str,
        run_label: str,
        chunk: int,
        watermark: int,
    ) -> None:
        """Bounded wait for the WORKER'S OWN compaction. Fail-closed.

        The worker plugin fires its own summarize on the session.idle of the
        drive the phase sentinel flagged as the chunk boundary — DURING that
        drive, so the compaction has usually already completed by the time this
        is called. The harness only OBSERVES that fire — it never triggers it
        and never substitutes for it. At the chunk boundary it holds the next
        prompt back until the session settles (bounded by
        ``_COMPACT_SETTLE_TIMEOUT_S``, with a short ``_COMPACT_SETTLE_GRACE_S``
        for the generation to start), then requires at least one COMPLETED
        compaction part to have landed since ``watermark`` — which MUST be the
        PRE-DRIVE message count, not a fresh one taken here (a post-drive
        count sits past the already-completed compaction and reads zero).

        FAIL-CLOSED CONTRACT. Success is: the wait settled AND the worker's
        own summarize landed at least one compaction part. Anything else —
        the wait timed out, the plugin never fired, or the generation was
        killed (a guard-killed compaction still carries ``summary: true`` but
        an error, and is not counted) — is ``no_compaction_evidence``: the
        cell ABORTS with :class:`ServeTransportError`. There is no substitute
        summarize and no "continue uncompacted": a cell that was armed to
        compact and did not is a broken measurement, not a cheaper one.
        """
        deadline = time.monotonic() + _COMPACT_SETTLE_TIMEOUT_S
        # The plugin fires on idle, so the session may not be busy YET. Give it a
        # short grace to go busy before concluding nothing is coming.
        went_busy = serve_client.wait_busy(
            session_id, timeout_s=_COMPACT_SETTLE_GRACE_S
        )
        settled = True
        if went_busy:
            remaining = max(1.0, deadline - time.monotonic())
            settled = serve_client.wait_idle(session_id, timeout_s=remaining)

        compactions = serve_client.completed_compactions_since(session_id, watermark)
        if not settled or compactions == 0:
            # FAIL-CLOSED: the worker's own summarize is the only compaction
            # there is. No evidence of it within the bounded wait aborts the
            # cell — never a substitute summarize, never "continue uncompacted".
            self._progress(
                f"PROGRESS run_label={run_label} step=self-compact chunk={chunk} "
                f"status=no_compaction_evidence settled={settled} "
                f"went_busy={went_busy} compactions={compactions} "
                f"budget_s={_COMPACT_SETTLE_TIMEOUT_S:.0f}"
            )
            raise ServeTransportError(
                f"no_compaction_evidence: run_label={run_label} chunk={chunk} — "
                f"the worker's own summarize landed {compactions} compaction "
                f"part(s) within the bounded wait (settled={settled}, "
                f"went_busy={went_busy}, "
                f"budget_s={_COMPACT_SETTLE_TIMEOUT_S:.0f}). The harness "
                "observes only and never fires a substitute, so the cell "
                "aborts instead of continuing uncompacted."
            )
        self._progress(
            f"PROGRESS run_label={run_label} step=self-compact chunk={chunk} "
            f"status=compacted compactions={compactions}"
        )

    def _emit_cost_target_warning_if_reached(
        self,
        *,
        run_label: str,
        phase: str,
        cumulative_cost_usd: float,
    ) -> None:
        if self.cost_target_usd is None:
            return
        if cumulative_cost_usd < self.cost_target_usd:
            return
        self._progress(
            f"WARNING run_label={run_label} step=cost-target phase={phase} "
            f"reason=cost_target_reached cumulative_cost_usd={cumulative_cost_usd:.4f} "
            f"target_usd={self.cost_target_usd:.4f}"
        )

    def _append_user_event(
        self,
        *,
        run_label: str,
        sidecar_path: Path,
        attempt: int,
        text: str,
        kind: str = "feedback",
    ) -> None:
        """Record, VERBATIM, every message the model is told a user sent.

        THIS FILE IS THE TRUTH (WO-FEEDBACK-1). It is the only place the exact
        bytes handed to the model are preserved — the PROGRESS log carries a
        length and a fingerprint but not the text, and the worker's own event
        stream shows the message only as it was consumed. The control plane
        serves this file so the TUI and the event feed show the operator what
        the model was actually told, not a reconstruction of it.

        `kind` distinguishes the three voices: `chunk` (the task itself),
        `pass_verdict` ("that fixed it"), `feedback` ("still failing"). The UI
        needs that separation — a chunk prompt and a failure report are not the
        same kind of message and must not render identically.

        Append-only, one JSON object per line: a run that dies mid-write leaves
        every earlier message intact and parseable.
        """
        payload = {
            "type": "user",
            "kind": str(kind),
            "timestamp": int(time.time() * 1000),
            "attempt": int(attempt),
            "chars": len(str(text)),
            "text_fp": self._fingerprint_text(text),
            "text": str(text),
        }
        sidecar_path.parent.mkdir(parents=True, exist_ok=True)
        with sidecar_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, separators=(",", ":")) + "\n")
        # The marker stays a fingerprint + length, never the body: this text is
        # multi-line and a single-line log record cannot carry it without
        # corrupting either the text or the log.
        self._progress(
            f"PROGRESS run_label={run_label} step=user-event-sidecar attempt={attempt} "
            f"kind={kind} chars={len(text)} text_fp={self._fingerprint_text(text)} "
            f"path={sidecar_path}"
        )

    def _extract_event_counts(
        self, session_db_path: Path
    ) -> tuple[int | None, int | None]:
        """Return (tool_calls, test_invocations) from the exported session DB.

        RE-POINTED 2026-09-04. This read the stdout transport's
        ``<worktree>.events.jsonl``, whose writer was deleted in the serve-only
        migration — so it returned ``(None, None)`` on every real cell and both
        numbers were permanently blank. The same facts survive in the per-cell
        session DB, which teardown exports BEFORE this runs: one ``part`` row
        per tool call, carrying the tool name and its input.

        ``test_invocations`` counts ``bash`` tool parts whose
        ``state.input.command`` contains any DECLARED_TEST_COMMANDS entry
        (plain case-sensitive substring match), unchanged from the old shape.

        ABSENCE IS STILL ABSENCE: a missing or unreadable DB returns
        ``(None, None)`` with a warning, never ``(0, 0)``. Zero tool calls is a
        real and different fact from "the source could not be read".
        """
        if not session_db_path.is_file():
            _LOG.warning(
                "backgammon tool telemetry unavailable path=%s reason=absent",
                session_db_path,
            )
            return None, None

        malformed_rows = 0
        tool_calls = 0
        test_invocations = 0

        # READ-ONLY, AND NEVER THE LIVE FILE. `mode=ro` on a file: URI so the
        # connection cannot create or modify the DB, and cannot recover a hot
        # journal — this is the exported copy of a quiesced database, not the
        # one a container is writing.
        try:
            conn = sqlite3.connect(
                f"file:{session_db_path}?mode=ro", uri=True, timeout=5.0
            )
        except sqlite3.Error as exc:
            _LOG.warning(
                "backgammon tool telemetry unavailable path=%s error_class=%s",
                session_db_path,
                exc.__class__.__name__,
            )
            return None, None

        try:
            rows = conn.execute("SELECT data FROM part").fetchall()
        except sqlite3.Error as exc:
            _LOG.warning(
                "backgammon tool telemetry unreadable path=%s error_class=%s",
                session_db_path,
                exc.__class__.__name__,
            )
            return None, None
        finally:
            conn.close()

        for (raw,) in rows:
            try:
                payload = json.loads(raw)
            except (TypeError, json.JSONDecodeError):
                malformed_rows += 1
                continue

            if not isinstance(payload, dict):
                malformed_rows += 1
                continue

            if payload.get("type") != "tool":
                continue

            tool_calls += 1
            if payload.get("tool") != "bash":
                continue

            state = (
                payload.get("state")
                if isinstance(payload.get("state"), dict)
                else {}
            )
            tool_input = (
                state.get("input") if isinstance(state.get("input"), dict) else {}
            )
            command = tool_input.get("command")
            if not isinstance(command, str):
                continue

            if any(declared in command for declared in DECLARED_TEST_COMMANDS):
                test_invocations += 1

        if malformed_rows > 0:
            _LOG.warning(
                "backgammon tool telemetry malformed_rows=%d path=%s",
                malformed_rows,
                session_db_path,
            )

        return tool_calls, test_invocations

    def _extract_agentic_cycles(self, user_events_path: Path) -> int | None:
        """Return number of context-submission cycles from user-events jsonl.

        One cycle equals one user context submission (initial prompt plus each
        feedback injection). When attempt fields exist, cycles are counted as
        distinct attempt values; if parsed user lines have no attempt fields,
        fallback is the number of parsed user lines.
        """
        malformed_lines = 0
        user_line_count = 0
        attempts: set[int] = set()
        saw_attempt_field = False

        try:
            with user_events_path.open("r", encoding="utf-8") as fh:
                for raw_line in fh:
                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        payload = json.loads(line)
                    except json.JSONDecodeError:
                        malformed_lines += 1
                        continue

                    if not isinstance(payload, dict):
                        malformed_lines += 1
                        continue
                    if payload.get("type") != "user":
                        continue

                    user_line_count += 1
                    if "attempt" not in payload:
                        continue

                    attempt = payload.get("attempt")
                    try:
                        attempts.add(int(attempt))
                        saw_attempt_field = True
                    except (TypeError, ValueError):
                        continue
        except OSError as exc:
            _LOG.warning(
                "backgammon user-event telemetry unavailable path=%s error_class=%s",
                user_events_path,
                exc.__class__.__name__,
            )
            return None

        if malformed_lines > 0:
            _LOG.warning(
                "backgammon user-event telemetry malformed_lines=%d path=%s",
                malformed_lines,
                user_events_path,
            )

        if saw_attempt_field:
            return len(attempts)
        return user_line_count

    def _budget_decision_for_attempt(
        self,
        *,
        run_label: str,
        attempt: int,
        observed_attempt_costs: list[float],
    ) -> str:
        estimate_usd = self._estimate_full_attempt_cost_usd(
            observed_attempt_costs,
            fallback_usd=self._fallback_attempt_estimate_usd,
        )
        checkpoint_path = self._proxy_checkpoint_path()

        if checkpoint_path is None:
            if self.cost_limit_usd is None:
                self._progress(
                    f"PROGRESS run_label={run_label} step=budget-decision attempt={attempt} "
                    f"decision=allow source=unbounded remaining_usd=inf estimate_attempt_usd={estimate_usd:.6f}"
                )
                return "allow"
            self._progress(
                f"PROGRESS run_label={run_label} step=budget-decision attempt={attempt} "
                f"decision=harness_error reason=missing_checkpoint_env env={_PROXY_CHECKPOINT_ENV} "
                f"estimate_attempt_usd={estimate_usd:.6f}"
            )
            return "harness_error"

        try:
            snapshot = self._read_proxy_budget_snapshot(checkpoint_path=checkpoint_path)
        except Exception as exc:  # noqa: BLE001 - classified as harness_error upstream.
            self._progress(
                f"PROGRESS run_label={run_label} step=budget-decision attempt={attempt} "
                f"decision=harness_error reason=checkpoint_read_error checkpoint={checkpoint_path} "
                f"error_fp={self._fingerprint_text(str(exc))}"
            )
            return "harness_error"

        decision = "allow" if snapshot.remaining_usd >= estimate_usd else "budget_stop"
        configured_cap = (
            "none" if self.cost_limit_usd is None else f"{self.cost_limit_usd:.6f}"
        )
        self._progress(
            f"PROGRESS run_label={run_label} step=budget-decision attempt={attempt} decision={decision} "
            f"remaining_usd={snapshot.remaining_usd:.6f} estimate_attempt_usd={estimate_usd:.6f} "
            f"hard_cap_usd={snapshot.hard_cap_usd:.6f} accrued_actual_usd={snapshot.accrued_actual_usd:.6f} "
            f"accrued_derived_usd={snapshot.accrued_derived_usd:.6f} "
            f"committed_unproven_usd={snapshot.committed_unproven_usd:.6f} cost_limit_usd={configured_cap} "
            f"checkpoint={snapshot.checkpoint_path}"
        )
        return decision

    @staticmethod
    def _proxy_checkpoint_path() -> Path | None:
        raw = os.environ.get(_PROXY_CHECKPOINT_ENV, "").strip()
        if not raw:
            return None
        return Path(raw).expanduser().resolve()

    @staticmethod
    def _estimate_full_attempt_cost_usd(
        observed_attempt_costs: list[float], fallback_usd: float = 0.0
    ) -> float:
        observed_max = 0.0
        for value in observed_attempt_costs:
            if isinstance(value, (int, float)):
                observed_max = max(observed_max, float(value))
        return max(observed_max, float(fallback_usd), 0.0)

    def _read_proxy_budget_snapshot(
        self, *, checkpoint_path: Path
    ) -> _ProxyBudgetSnapshot:
        if not checkpoint_path.is_file():
            raise RuntimeError(f"proxy checkpoint missing: {checkpoint_path}")

        last_error: Exception | None = None
        for _ in range(3):
            try:
                payload = json.loads(checkpoint_path.read_text(encoding="utf-8"))
                if not isinstance(payload, dict):
                    raise RuntimeError("proxy checkpoint payload is not an object")
                hard_cap_usd = float(payload["hard_cap_usd"])
                accrued_actual_usd = float(payload["accrued_actual_usd"])
                accrued_derived_usd = float(payload.get("accrued_derived_usd", 0.0))
                committed_unproven_usd = float(payload["committed_unproven_usd"])
                remaining_usd = (
                    hard_cap_usd
                    - accrued_actual_usd
                    - accrued_derived_usd
                    - committed_unproven_usd
                )
                return _ProxyBudgetSnapshot(
                    hard_cap_usd=hard_cap_usd,
                    accrued_actual_usd=accrued_actual_usd,
                    accrued_derived_usd=accrued_derived_usd,
                    committed_unproven_usd=committed_unproven_usd,
                    remaining_usd=remaining_usd,
                    checkpoint_path=str(checkpoint_path),
                )
            except Exception as exc:  # noqa: BLE001 - retries for concurrent writes.
                last_error = exc
                time.sleep(0.1)

        raise RuntimeError(
            f"failed reading proxy checkpoint {checkpoint_path}: {last_error}"
        )

    @staticmethod
    def _detect_stream_incomplete(stats: "_OpencodeRunStats") -> bool:
        """Return True if this phase carries a transport-death signature.

        RE-POINTED 2026-09-04, and it needed no new source. This used to reopen
        the stdout transport's ``<worktree>.events.jsonl`` and re-scan it for two
        signatures. That writer was deleted in the serve-only migration, and the
        read swallowed the missing file and returned False — so a genuine
        transport stoppage was scored as a plain failure instead of being resumed
        from checkpoint, and nothing said so.

        THE SERVE TRANSPORT ALREADY CLASSIFIED THIS TURN. It reads the same
        session, live, and files each anomalous turn onto ``turn_anomalies`` with
        the terminal class and the step-finish reason. Re-deriving that from a
        second copy of the transcript would be a consumer deriving a fact its
        producer already states — so this now reads the record instead.

        The two original signatures map across exactly:

        - a ``step_finish`` whose reason is in TRUNCATED_STEP_FINISH_REASONS
          -> a ``truncated_no_signal`` turn. The class is checked against THIS
          module's reason set, not serve_client's wider one: serve_client counts
          ``length`` as a truncation, and an output cap is the model hitting its
          ceiling, not a dead stream. Resuming on it would widen what counts as
          an instrument failure, which instrumentation does not get to decide.
        - an ``error`` event with a transport or guard signature -> a
          ``transport_error`` or ``guard_abort`` turn.
        """
        for record in stats.turn_anomalies:
            if not isinstance(record, dict):
                continue
            terminal = record.get("terminal")
            if terminal in (TURN_TERMINAL_TRANSPORT_ERROR, TURN_TERMINAL_GUARD_ABORT):
                return True
            if (
                terminal == TURN_TERMINAL_TRUNCATED
                and record.get("finish_reason") in TRUNCATED_STEP_FINISH_REASONS
            ):
                return True
        return False

    @staticmethod
    def _classify_transport_error(event: dict[str, Any]) -> str | None:
        """Classify a non-budget ``error`` event's transport/guard signature.

        Returns a stable reason code (``loop_guard``, ``stream_incomplete``,
        ``idle_timeout``, ``provider_error``, …) or ``generic_error`` when the
        payload matches no known signature. Never returns None: every non-budget
        error event terminates the in-flight turn and must be recorded.
        """
        error_block = event.get("error") if isinstance(event.get("error"), dict) else {}
        data = (
            error_block.get("data") if isinstance(error_block.get("data"), dict) else {}
        )
        message = str(data.get("message", ""))
        haystack = message.lower()
        if any(sig in haystack for sig in LOOP_GUARD_SIGNATURES):
            return "loop_guard"
        for reason_code, signature in _TRANSPORT_ERROR_SIGNATURES:
            if signature in haystack:
                return reason_code
        if message.strip():
            return "generic_error"
        return None

    @staticmethod
    def _write_truncation_evidence(
        *, record: dict[str, Any], evidence_path: Path
    ) -> None:
        """Append one evidence record as a JSON line. Lazy: creates on first call."""
        try:
            evidence_path.parent.mkdir(parents=True, exist_ok=True)
            with evidence_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, default=str) + "\n")
        except Exception as exc:  # noqa: BLE001 - evidence write must never affect scoring.
            _LOG.warning("truncation evidence write failed %s: %s", evidence_path, exc)

    def _budget_stop_signature_from_event(self, event: dict[str, Any]) -> str | None:
        if str(event.get("type", "")).strip().lower() != "error":
            return None
        error_block = event.get("error") if isinstance(event.get("error"), dict) else {}
        data = (
            error_block.get("data") if isinstance(error_block.get("data"), dict) else {}
        )
        status_code = self._to_int(data.get("statusCode"))
        message = str(data.get("message", ""))
        response_body = str(data.get("responseBody", ""))

        error_type = ""
        error_code = ""
        if response_body:
            try:
                body_payload = json.loads(response_body)
            except json.JSONDecodeError:
                body_payload = None
            if isinstance(body_payload, dict):
                body_error = (
                    body_payload.get("error")
                    if isinstance(body_payload.get("error"), dict)
                    else {}
                )
                error_type = str(body_error.get("type", "")).strip()
                error_code = str(body_error.get("code", "")).strip()
                if not message:
                    message = str(body_error.get("message", ""))

        haystack = " ".join((message, response_body, error_type, error_code)).lower()
        if (
            status_code == 402
            or "budget_exceeded" in haystack
            or "insufficient_quota" in haystack
        ):
            return (
                f"status_code={status_code or 'none'} "
                f"error_type={error_type or 'none'} "
                f"error_code={error_code or 'none'} "
                f"message_fp={self._fingerprint_text(message)} "
                f"body_fp={self._fingerprint_text(response_body)}"
            )
        return None

    @staticmethod
    def _fingerprint_text(text: str) -> str:
        return hashlib.sha256(str(text).encode("utf-8")).hexdigest()[:8]

    @staticmethod
    def _model_id_from_selector(model: str) -> str:
        provider_id, sep, model_id = str(model).partition("/")
        if sep and model_id:
            return model_id
        return provider_id

    @classmethod
    def _pricing_row_for_model(cls, model: str) -> dict[str, float] | None:
        selector = str(model)
        return _MODEL_PRICING_USD_PER_1M.get(selector) or _MODEL_PRICING_USD_PER_1M.get(
            cls._model_id_from_selector(selector)
        )

    @classmethod
    def _resolve_output_price_per_1m(
        cls,
        *,
        model: str,
        explicit_output_price_per_1m: float | None,
    ) -> float:
        if explicit_output_price_per_1m is not None:
            return float(explicit_output_price_per_1m)
        pricing = cls._pricing_row_for_model(model)
        if pricing is None:
            model_id = cls._model_id_from_selector(model)
            raise ValueError(
                "missing authoritative output pricing for "
                f"model_id={model_id!r}; set output_price_per_1m override to run with cost_limit_usd"
            )
        return float(pricing["output"])

    @classmethod
    def _resolve_cache_write_price_per_1m(
        cls,
        *,
        model: str,
        fallback_price_per_1m: float,
    ) -> float:
        pricing = cls._pricing_row_for_model(model)
        if pricing is not None and "cache_write" in pricing:
            return float(pricing["cache_write"])
        return float(fallback_price_per_1m)

    @staticmethod
    def _worst_case_reservation_usd(
        max_steps: int,
        max_output_tokens: int,
        output_price_per_1m: float,
        safety_factor: float,
        cache_write_allowance_usd: float,
    ) -> float:
        output_price_per_token = float(output_price_per_1m) / 1_000_000.0
        return float(max_steps) * float(
            max_output_tokens
        ) * output_price_per_token * float(safety_factor) + float(
            cache_write_allowance_usd
        )

    @staticmethod
    def _copy_tree_contents(src_dir: Path, dst_dir: Path) -> None:
        if not src_dir.is_dir():
            raise FileNotFoundError(f"source directory does not exist: {src_dir}")

        dst_dir.mkdir(parents=True, exist_ok=True)
        for item in src_dir.iterdir():
            target = dst_dir / item.name
            if item.is_dir():
                shutil.copytree(item, target, dirs_exist_ok=True)
            else:
                shutil.copy2(item, target)

    @staticmethod
    def _kill_process_group(proc: subprocess.Popen[str]) -> None:
        if proc.poll() is not None:
            return
        try:
            pgid = os.getpgid(proc.pid)
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            return

    def _provider_backoff(self, seconds: float) -> None:
        """Wait out a provider outage before re-prompting.

        Its own method so tests can drive the recovery path without sleeping,
        and so the wait is observable rather than buried in the drive loop.
        """
        if seconds > 0:
            time.sleep(seconds)

    def _progress(self, message: str) -> None:
        self._progress_cb(message)
        if self.logger is None:
            return

        info = getattr(self.logger, "info", None)
        if callable(info):
            info(message)

    @staticmethod
    def _to_int(value: Any) -> int:
        try:
            if value is None:
                return 0
            return int(value)
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _normalize_string_list(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        out: list[str] = []
        for item in value:
            text = str(item).strip()
            if text:
                out.append(text)
        return out

    @staticmethod
    def _normalize_problems(value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        normalized: list[dict[str, Any]] = []
        for item in value:
            if not isinstance(item, dict):
                normalized.append(
                    {"check": "unknown", "expected": "", "observed": str(item)}
                )
                continue
            normalized.append(
                {
                    "check": str(item.get("check", "unknown")),
                    "expected": str(item.get("expected", "")),
                    "observed": str(item.get("observed", "")),
                }
            )
        return normalized
