"""Transport-anomaly and truncation-evidence leaves for the challenge adapter.

Extracted verbatim from harness/adapters/challenge/__init__.py
(WO-LI15-I1B STAGE 1B) and re-exported there, so every name stays
resolvable as harness.adapters.challenge.<name>. The serve_client names
_is_unrecovered_anomaly reads (REASON_PROVIDER_UNAVAILABLE,
RECOVERABLE_STREAM_DEATH_REASONS) are not monkeypatched anywhere, so
importing them directly here is correct; the same holds for
LOOP_GUARD_SIGNATURES, read by TransportMixin._classify_transport_error.

STAGE 2B (WO-LI15-I2B) adds TransportMixin: the transport-classification
method group moved out of ChallengeRunner, which inherits the mixin, so
every self./cls. cross-call resolves through the MRO. This module must not
import from the package __init__. _LOG is this module's own logger (same
rationale as telemetry.py); the logger name changes to
harness.adapters.challenge.transport and the sole consumer is the
fail-open warning in _write_truncation_evidence.
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
from pathlib import Path
from typing import Any

from harness.serve_client import (
    LOOP_GUARD_SIGNATURES,
    REASON_MODEL_SILENT,
    REASON_PROVIDER_UNAVAILABLE,
    RECOVERABLE_STREAM_DEATH_REASONS,
)

from .constants import (
    PROVIDER_BACKOFF_SCHEDULE_S,
    TRUNCATED_STEP_FINISH_REASONS,
    TURN_TERMINAL_CAP_CUTOFF,
    TURN_TERMINAL_GUARD_ABORT,
    TURN_TERMINAL_STALLED,
    TURN_TERMINAL_TRANSPORT_ERROR,
    TURN_TERMINAL_TRUNCATED,
    _COMPACT_PHASE_BUILD,
    _COMPACT_PHASE_REPAIR,
    _TRANSPORT_ERROR_SIGNATURES,
)
from .models import _OpencodeRunStats

_LOG = logging.getLogger(__name__)


def _provider_backoff_seconds(attempt_index: int) -> float:
    """Backoff for the Nth consecutive provider-unavailable recovery."""
    if attempt_index < 1:
        attempt_index = 1
    idx = min(attempt_index, len(PROVIDER_BACKOFF_SCHEDULE_S)) - 1
    return PROVIDER_BACKOFF_SCHEDULE_S[idx]


# The harness catching MODEL behaviour, not a broken instrument: the loop guard
# (looping), the stall watchdog (a turn that stopped moving), a cap cut-off
# (running into the fixed per-response output cap).
_MODEL_BEHAVIOUR_TERMINALS = frozenset(
    {TURN_TERMINAL_GUARD_ABORT, TURN_TERMINAL_STALLED, TURN_TERMINAL_CAP_CUTOFF}
)


def _is_instrument_anomaly(record: dict[str, Any]) -> bool:
    """True when an anomaly record is the instrument's, not the model's.

    Every terminal except :data:`_MODEL_BEHAVIOUR_TERMINALS`. A cap cut-off
    used to count here: run 1790258326's three cut-offs read as three stream
    (instrument) errors on the board beside the same three CUT-OFFS.
    """
    return record.get("terminal") not in _MODEL_BEHAVIOUR_TERMINALS


def _is_unrecovered_anomaly(record: dict[str, Any]) -> bool:
    """True when an anomaly record is an instrument failure the harness did
    NOT recover (it ended the phase and was graded).

    Mirrors the recoverability gate in the phase-drive loop: ``guard_abort``,
    ``turn_stalled``, and the recoverable ``transport_error`` reasons
    (``provider_unavailable``, ``model_silent`` plus both relay stream deaths)
    are excluded REGARDLESS of retry status.
    """
    terminal = record.get("terminal")
    if terminal == TURN_TERMINAL_GUARD_ABORT:
        return False
    if terminal == TURN_TERMINAL_STALLED:
        return False
    if terminal == TURN_TERMINAL_TRANSPORT_ERROR and str(
        record.get("reason") or ""
    ) in ({REASON_PROVIDER_UNAVAILABLE, REASON_MODEL_SILENT} | RECOVERABLE_STREAM_DEATH_REASONS):
        return False
    if terminal == TURN_TERMINAL_CAP_CUTOFF:
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


def compact_phase_for(phase: str) -> str:
    """Map a drive phase name onto the sentinel value the plugin reads.

    Each chunk drive is its chunk's one boundary — see the block above.
    """
    is_build_leg = phase == "initial" or phase.startswith("initial-chunk")
    return _COMPACT_PHASE_BUILD if is_build_leg else _COMPACT_PHASE_REPAIR


class TransportMixin:
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
