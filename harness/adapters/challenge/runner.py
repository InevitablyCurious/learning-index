"""G0/G1 base of the challenge runner.

Extracted VERBATIM from harness/adapters/challenge/__init__.py
(WO-LI15-I3B STAGE 3B): the ChallengeRunner class statement -- its
class-level attributes and the G0/G1 base methods (__init__,
build_need_card, _capture_attempt_one_snapshot, _record_checkpoint,
run_cell, _mark_harness_resume, _run_cell_impl,
_run_cell_attempt) -- now lives here; the package __init__ is a thin
re-export shim. The role mixins (utils, pricing, feedback, telemetry,
transport, bootstrap, grading, serve) are imported for the bases, so
every self./cls. cross-call still resolves through the MRO with zero
call-site changes. This module must not import from the package __init__
at module level -- the package __init__ imports this module.

SEAM NOTES. Six names stay PACKAGE globals that tests monkeypatch
(monkeypatch.setattr(challenge_mod, NAME, fake)): capture_snapshot and
compute_grader_hash (consumed in _capture_attempt_one_snapshot), and
DockerCell, docker_available, ServeClient and worker_image_fingerprint
(consumed in _run_cell_impl). Each consuming method binds them as
call-time LOCALS -- one read of the package attribute per call
(`import harness.adapters.challenge as _pkg` at the top of the
method) -- so the patch seam stays exactly where the tests set it and
this module never imports them at module level. subprocess is
dual-safe (the tests patch challenge_mod.subprocess.run -- an
attribute of the shared module object this module also imports
normally). Annotation-only names (ImageFingerprint, and the late-bound
DockerCell/ServeClient where they annotate signatures) are PEP 563
strings under `from __future__ import annotations`, never evaluated at
runtime. Every other name below is not monkeypatched anywhere, so
importing it directly is correct -- same rationale as serve.py
(STAGE 3A) and transport.py.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from contextlib import nullcontext
from pathlib import Path
from typing import Any, Callable

from harness.backends.base import NeedCard
from harness.checkpoint import checkpoint_root, record_checkpoint
from harness.context_budget import CONTEXT_EXHAUSTED
from harness.egress import egress_container_name
from harness.live_stream import Heartbeat, LiveStream
from harness.outcomes.predicate_emitter import STATE_ALG
from harness.runner import AgentRunner
from harness.serve_client import (
    REASON_STREAM_FINALIZE_TIMEOUT,
    ServeClientError,
    founder_attach_command,
)

from ...cell_isolation import (
    assert_clean_worktree,
    assert_no_docker_residue,
    assert_seeded_from_snapshot,
)
from ..docker_worker import (
    WORKER_IMAGE,
    ImageFingerprint,
    image_plugin_present,
)
from ..mapping import write_session_mapping
from ..transcript import write_session_transcript
from .bootstrap import BootstrapMixin
from .constants import (
    _GRADER_DIR,
    _HARNESS_LIMIT_REASONS,
    _NO_CHANGE_NOTE,
    _REASONING_EFFORT_ENV,
    _REPO_ROOT,
    _RESERVATION_SAFETY_FACTOR,
    _SPEC,
    _WORKER_AGENTS_MD,
    DEFAULT_ATTEMPT_HARD_CEILING,
    DEFAULT_GATE_TIMEOUT_S,
    DEFAULT_RUN_TIMEOUT_S,
    TURN_TERMINAL_GUARD_ABORT,
    TURN_TERMINAL_OBSERVATION_LOST,
    TURN_TERMINAL_STALLED,
    TURN_TERMINAL_TRANSPORT_ERROR,
)
from .exceptions import (
    GateTimeoutError,
    GraderReportUnreadableError,
    IncompleteBuildError,
    ServeTransportError,
)
from .feedback import (
    FeedbackMixin,
    _default_progress,
    build_chunk_completion,
)
from .grading import GradingMixin
from .hold_ui import _hold_for_ui_review
from .models import (
    ChallengeCellResult,
    _OpencodeRunStats,
)
from .pricing import PricingMixin
from .serve import ServeMixin
from .telemetry import (
    TelemetryMixin,
    _export_cell_telemetry,
    _scan_cell_delivery,
    _scan_funnel_snapshot,
    _scan_injected_block_chars,
    _scan_recall_funnel,
    _snapshot_state_hash,
    _worktree_has_injection_record,
)
from .transport import (
    TransportMixin,
    _is_unrecovered_anomaly,
)
from .utils import UtilsMixin
from .worker_config import bench_session_title

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



def _code_unchanged_since_last_round(attempt_reports: list[dict[str, Any]]) -> bool:
    """True when the last two graded rounds ran against identical code."""
    if len(attempt_reports) < 2:
        return False
    before = attempt_reports[-2].get("state_hash")
    after = attempt_reports[-1].get("state_hash")
    return before is not None and before == after

class ChallengeRunner(UtilsMixin, PricingMixin, FeedbackMixin, TelemetryMixin, TransportMixin, BootstrapMixin, GradingMixin, ServeMixin, AgentRunner):
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
            os.environ.get("BENCH_SERVE_HOST_PORT") or "8719"
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
        self._repo_root = _REPO_ROOT

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
        # The challenge says what it is; the adapter only says what kind of
        # work this cell is doing.
        return NeedCard(
            intent=intent,
            task=_SPEC.summary,
            language=_SPEC.language,
            stack=list(_SPEC.stack),
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
        # WO-LI15-I3B STAGE 3B: late-bound patch seams. Tests monkeypatch
        # capture_snapshot/compute_grader_hash on the PACKAGE
        # (harness.adapters.challenge), so bind them as call-time locals --
        # one read of the package attr per call -- and the patched object is
        # what runs. Never a module-top import here.
        import harness.adapters.challenge as _pkg

        capture_snapshot = _pkg.capture_snapshot
        compute_grader_hash = _pkg.compute_grader_hash

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
                "grader_hash": compute_grader_hash(_GRADER_DIR),
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
        self, run_label: str, run_dir: Path, task_id: str | None = None
    ) -> ChallengeCellResult:
        # The challenge names itself: its directory is its id, so a second
        # challenge does not report under the example's name.
        task_id = task_id or self.task_dir.name
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
            # which ChallengeCellResult does not have and never had, so the
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
    ) -> ChallengeCellResult:
        # WO-LI15-I3B STAGE 3B: late-bound patch seams. Tests monkeypatch
        # DockerCell/docker_available/ServeClient/worker_image_fingerprint on
        # the PACKAGE (harness.adapters.challenge), so bind them as call-time
        # locals -- one read of the package attr per call -- and the patched
        # object is what runs. Never a module-top import here.
        import harness.adapters.challenge as _pkg

        DockerCell = _pkg.DockerCell
        docker_available = _pkg.docker_available
        ServeClient = _pkg.ServeClient
        worker_image_fingerprint = _pkg.worker_image_fingerprint

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
        # in tests/test_challenge_zero_tool_resume.py indexes on it verbatim.
        if self._seed_snapshot_tree is not None:
            self._copy_tree_contents(self._seed_snapshot_tree, worktree)
        else:
            self._copy_tree_contents(self.task_dir / "scaffold", worktree)
        # No runtime/model block: naming the model back to itself is a tell
        # that something is driving it, and nothing downstream reads this.
        (worktree / "AGENTS.md").write_text(_WORKER_AGENTS_MD, encoding="utf-8")
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
        # CONTEXT EXHAUSTED ends the cell where it happens: during the build
        # nothing is graded; during a repair round the last graded round stands.
        context_stop = False
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
            # the ordering guard in test_challenge_zero_tool_resume.py indexes
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
                    # where the compactions happen, so
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

                    if first_run.context_exhausted:
                        verdict = "FAIL"
                        attempts_to_green = "CONTEXT_EXHAUSTED"
                        termination_reason = CONTEXT_EXHAUSTED
                        context_stop = True
                    elif first_run.budget_stop_detected:
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
                and not first_run.context_exhausted
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
                if context_stop:
                    # Out of room during the build: stop the run, grade nothing.
                    self._progress(
                        f"PROGRESS run_label={run_label} step=context-exhausted-stop "
                        f"phase=build graded=0"
                    )
                    break
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
                # A ROUND THAT CHANGED NOTHING: the graded code is byte-identical
                # to the round before. Said first, before anything else the
                # player reports. Unknown hashes (None) never count as unchanged,
                # and a round where something newly passed is never called
                # unchanged — "nothing changed" beside "that fixed it" would
                # contradict itself (identical code can only pass differently
                # through a flaky check, which is not the model's news).
                code_unchanged = not pass_verdict and _code_unchanged_since_last_round(
                    attempt_reports
                )
                if code_unchanged:
                    feedback = f"{_NO_CHANGE_NOTE}\n\n{feedback}"
                    self._progress(
                        f"PROGRESS run_label={run_label} step=feedback-code-unchanged attempt={attempt}"
                    )
                self._progress(
                    f"PROGRESS run_label={run_label} step=feedback-problems-only-built attempt={attempt} "
                    f"checks={len(feedback_checks)} repeats={len(repeat_checks)}"
                )
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
                if feedback_run.context_exhausted:
                    # Out of room mid-repair: stop the run. The round graded
                    # before this one is the cell's result.
                    verdict = "FAIL"
                    attempts_to_green = "CONTEXT_EXHAUSTED"
                    termination_reason = CONTEXT_EXHAUSTED
                    self._progress(
                        f"PROGRESS run_label={run_label} step=context-exhausted-stop "
                        f"phase=feedback-{attempt} graded={len(attempt_reports)}"
                    )
                    break
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

        return ChallengeCellResult(
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
