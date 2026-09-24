"""Backgammon worker-runner adapter for the benchmark harness.

This adapter drives a single backgammon cell end-to-end:
- seed a fresh worktree from scaffold
- run either a mock worker (golden/scaffold copy) or headless opencode
- evaluate with the backgammon gate report runner
- apply budget-bounded rounds of *problems-only* feedback in the same session

WO-LI15-I3B STAGE 3B: this package is a THIN SHIM. ChallengeRunner --
the class attributes plus the G0/G1 base methods -- lives in .runner;
the role mixins live in .utils / .pricing / .feedback / .telemetry /
.transport / .bootstrap / .grading / .serve, and the function leaves in
.constants / .exceptions / .models / .hold_ui / .worker_config. What
stays here is (1) the re-export surface, so every name stays resolvable
as harness.adapters.challenge.<name>, and (2) the PATCH SEAMS: the
names tests monkeypatch ON THIS PACKAGE, read at call time by the
consumers (.runner late-binds capture_snapshot / compute_grader_hash /
DockerCell / docker_available / ServeClient / worker_image_fingerprint;
.bootstrap late-binds DockerCellConfig; .hold_ui late-binds _HOLD_UI_PORT).
"""

import logging

# PATCH SEAM (dual-safe): tests setattr(challenge_mod.subprocess, "run", ...)
# -- an attribute of the shared module object, so every importer sees it.
import subprocess  # noqa: F401

# WO-LI15-I1A STAGE 1A: the pure class leaves live in .exceptions / .models,
# re-exported here so every name stays resolvable as
# harness.adapters.challenge.<Name>.
from .exceptions import (
    GateTimeoutError,
    GraderReportUnreadableError,
    InstrumentFaultError,
    MissingFeedbackOverrideError,
    IncompleteBuildError,
    ServeTransportError,
    ErrorCapExceeded,
)
from .models import (
    RecallFunnelScan,
    _OpencodeRunStats,
    ChallengeCellResult,
)
# WO-LI15-I1B STAGE 1B: the module-level constants and the clean function
# leaves live in .constants / .feedback / .telemetry / .transport,
# re-exported here so every name stays resolvable as
# harness.adapters.challenge.<name> -- tests read/monkeypatch them here.
from .constants import (
    DEFAULT_ATTEMPT_HARD_CEILING,
    DEFAULT_GATE_TIMEOUT_S,
    DEFAULT_MAX_STEPS_PER_ATTEMPT,
    DEFAULT_RUN_TIMEOUT_S,
    DEFAULT_TURN_STALL_TIMEOUT_S,
    ERROR_CAP_PER_TYPE,
    PROVIDER_BACKOFF_SCHEDULE_S,
    REASON_TOOL_CALL_TIMEOUT,
    TRUNCATED_STEP_FINISH_REASONS,
    TURN_TERMINAL_GUARD_ABORT,
    TURN_TERMINAL_OBSERVATION_LOST,
    TURN_TERMINAL_STALLED,
    TURN_TERMINAL_TRANSPORT_ERROR,
    TURN_TERMINAL_TRUNCATED,
    _CHUNK_STUB_FILE,
    _COMPACT_PHASE_BUILD,
    _COMPACT_PHASE_FILENAME,
    _COMPACT_PHASE_REPAIR,
    _EXCUSE_ELIMINATOR,
    _FINALIZE_RECOVERY_NUDGE,
    _HARNESS_LIMIT_REASONS,
    _HOLD_UI_ENV,
    _HOLD_UI_HEALTH_TIMEOUT_S,
    _HOLD_UI_HEARTBEAT_S,
    _HOLD_UI_POLL_S,
    _HOLD_UI_PORT,
    _HOLD_UI_RELEASE_FILE,
    _HOLD_UI_SERVER_LOG,
    _HOLD_UI_STATE_FILE,
    _LOOP_RECOVERY_NUDGE,
    _MAX_SERVE_RECOVERY_NUDGES,
    _PASS_VERDICT_MAX_LISTED,
    _PROVIDER_RECOVERY_NUDGE,
    _PROXY_CHECKPOINT_ENV,
    _REASONING_EFFORT_ENV,
    _RESERVATION_SAFETY_FACTOR,
    _STALL_RECOVERY_NUDGE,
    _STUB_SENTINEL,
    _WORKER_AGENTS_MD,
    _WRITE_CHUNKING_DIRECTIVE,
)
# WO-LI15-I2B STAGE 2B: the feedback, telemetry and transport function
# leaves live in .feedback / .telemetry / .transport beside their mixin
# method groups (the mixins are imported by .runner for the bases).
# DECLARED_TEST_COMMANDS lives in .telemetry with its consumer and is
# re-exported here so harness.adapters.challenge.DECLARED_TEST_COMMANDS
# stays resolvable.
from .feedback import (
    build_chunk_completion,
    count_stub_sentinels,
    gate_tokens_in_suite,
    load_feedback_overrides,
    load_feedback_overrides_from_failures,
    missing_feedback_overrides,
    _default_progress,
    _died_reason,
)
from .telemetry import (
    DECLARED_TEST_COMMANDS,
    _export_cell_telemetry,
    _scan_cell_delivery,
    _scan_funnel_snapshot,
    _scan_injected_block_chars,
    _scan_recall_funnel,
    _snapshot_state_hash,
    _worktree_has_injection_record,
)
from .transport import (
    compact_phase_for,
    _build_truncation_evidence,
    _is_instrument_anomaly,
    _is_unrecovered_anomaly,
    _iso_utc,
    _provider_backoff_seconds,
)
# WO-LI15-I1C STAGE 1C: the hold-UI and worker-config function leaves live in
# .hold_ui / .worker_config, re-exported here so every name stays resolvable as
# harness.adapters.challenge.<name>. _HOLD_UI_PORT stays a PACKAGE global (from
# .constants above) that tests monkeypatch; hold_ui late-binds it at CALL time
# (a local read of the package attribute inside _hold_for_ui_review) instead
# of importing it.
from .hold_ui import (
    _resolve_hold_ui_entrypoint,
    _hold_ui_port_listeners,
    _hold_ui_healthy,
    _hold_ui_lan_exposed,
    _hold_for_ui_review,
)
from .worker_config import (
    build_worker_opencode_config,
    _safe_title_org_component,
    bench_session_title,
)
# PATCH SEAMS from ..docker_worker: tests monkeypatch DockerCell /
# DockerCellConfig / docker_available / worker_image_fingerprint ON THIS
# PACKAGE; .runner (_run_cell_impl) and .bootstrap (_build_cell_config)
# late-bind them at CALL time (a local read of the package attribute)
# instead of importing them. LOOP_KILL_MARKER_DIRNAME is a plain
# re-export (tests import it from this package).
from ..docker_worker import (
    DockerCell,
    DockerCellConfig,
    LOOP_KILL_MARKER_DIRNAME,
    docker_available,
    worker_image_fingerprint,
)
# PATCH SEAM: tests monkeypatch ServeClient ON THIS PACKAGE; .runner
# (_run_cell_impl) late-binds it at CALL time. serve.py references it ONLY
# as a PEP 563 string annotation and consumes the serve_client INSTANCE
# passed in, so the patch seam stays exactly where the tests set it.
# ServeClientError is a plain re-export (tests read it from this package).
from harness.serve_client import ServeClient, ServeClientError
# PATCH SEAMS: tests monkeypatch capture_snapshot / compute_grader_hash ON
# THIS PACKAGE; .runner (_capture_attempt_one_snapshot) late-binds them at
# CALL time.
from harness.snapshot import capture_snapshot, compute_grader_hash

# WO-LI15-I3B STAGE 3B: the runner itself -- class attributes + the G0/G1
# base methods, mixin bases resolved through the MRO.
from .runner import ChallengeRunner


_LOG = logging.getLogger(__name__)
