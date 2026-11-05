"""Cumulative phase-machine sequencer for benchmark session orchestration.

Sequences the measurement-only campaign ONE CLICK AT A TIME: a launch appends
exactly one cell to the campaign's log and walks it PREPARE_FIXTURE ->
RUN_SESSION -> DONE. Recall during ON cells is auto-injected by the worker
plugin; there are no extract, coordinator-review, or leader-commit stages.

THERE IS NO CURSOR AND NO "NEXT". The cell a launch runs is the cell that
launch appended, and a campaign's identity is the log of cells it recorded —
never a position in a plan. A precomputed schedule made the arm and the order a
function of the launching arguments, and it put a mutable counter in the
manifest that a restart re-seeded and an explicit-index run never advanced, so
horizontal cells could claim an address that had already run.

This module owns *only* deterministic sequencing + checkpointing.
All side effects are injected through ``SessionRunner``.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
import logging
import os
from typing import Any, Literal, Protocol, TypedDict, runtime_checkable

from .convergence import build_convergence_trend
from ..live_stream import run_notice
from .manifest import atomic_write, resume_or_create
from .ordering import append_session
from .progress import progress_from_cell_result
from .run_artifacts import build_scorecard
from .types import (
    RosterEntry,
    SessionPhase,
    SessionRecord,
    WalkGateVerdict,
    WalkGateVerdictRecord,
)

_LOG = logging.getLogger(__name__)


class DoneState(TypedDict):
    status: Literal["done"]
    convergence: dict[str, Any]


class HaltedOnGate(TypedDict):
    status: Literal["halted_on_gate"]
    phase: Literal["HALTED_ON_GATE"]
    sequence_index: int
    ordinal: int
    model: str
    gate: str
    verdict: str
    evidence: dict[str, Any]
    expected_producer_model_ids: list[str]
    observed_producer_model_ids: list[str]


StepUntilDoneResult = HaltedOnGate | DoneState


@runtime_checkable
class SessionRunner(Protocol):
    """Injected runtime seam for all side-effecting per-session operations."""

    def prepare_fixture(self, session: SessionRecord) -> None:
        """Reset the per-session coding fixture (never the cumulative corpus)."""

    def run_session(self, session: SessionRecord) -> object:
        """Execute one coding session and return telemetry (ChallengeCellResult-shaped)."""


class CumulativeSequencer:
    def __init__(
        self,
        manifest_path: str | os.PathLike[str],
        *,
        runner: SessionRunner,
        roster: list[RosterEntry],
        task: str,
        org_id: str,
        config_fingerprint: str,
        run_context: Mapping[str, Any] | None = None,
        chunk_plan_hash: str = "",
    ) -> None:
        if not isinstance(runner, SessionRunner):
            raise ValueError("runner must implement SessionRunner")

        normalized_manifest_path = os.path.abspath(os.fspath(manifest_path))
        if not normalized_manifest_path:
            raise ValueError("manifest_path must be a non-empty path")

        manifest = resume_or_create(
            normalized_manifest_path,
            roster=roster,
            task=task,
            org_id=org_id,
            config_fingerprint=config_fingerprint,
            run_context=run_context,
            chunk_plan_hash=chunk_plan_hash,
        )

        if manifest.org_id != org_id:
            raise ValueError(
                "cannot resume: org_id drift detected "
                f"(manifest={manifest.org_id!r} expected={org_id!r})"
            )
        if manifest.config_fingerprint != config_fingerprint:
            raise ValueError(
                "cannot resume: config_fingerprint drift detected "
                f"(manifest={manifest.config_fingerprint!r} expected={config_fingerprint!r})"
            )

        self._manifest_path = normalized_manifest_path
        self._runner = runner
        self._manifest = manifest

        # The log is the authority; session_records are its materialized cells.
        if not self._manifest.session_records and self._manifest.schedule:
            self._manifest.session_records = [
                SessionRecord(
                    sequence_index=session.sequence_index,
                    model=session.model,
                    provider_pin=session.provider_pin,
                    memory_mode=session.memory_mode,
                    phase_group=session.phase_group,
                    phase=SessionPhase.PREPARE_FIXTURE.value,
                    org_id=org_id,
                )
                for session in self._manifest.schedule
            ]
            self._checkpoint()

    def append_cell(self, memory_mode: str) -> SessionRecord:
        """Append ONE cell of ``memory_mode`` to the campaign log, then checkpoint.

        The ordinal is the length of the existing log — never a stored counter.
        A counter can be re-seeded by a restart and cannot be recovered without
        trusting whoever wrote it last; the log's own length cannot disagree
        with the log.
        """
        entry = append_session(
            self._manifest.roster,
            existing=self._manifest.schedule,
            memory_mode=memory_mode,
        )
        record = SessionRecord(
            sequence_index=entry.sequence_index,
            model=entry.model,
            provider_pin=entry.provider_pin,
            memory_mode=entry.memory_mode,
            phase_group=entry.phase_group,
            phase=SessionPhase.PREPARE_FIXTURE.value,
            org_id=self._manifest.org_id,
        )
        self._manifest.schedule.append(entry)
        self._manifest.session_records.append(record)
        self._checkpoint()
        return record

    def current_session(self) -> SessionRecord | None:
        """This launch's cell: the last one appended to the log, if any."""
        if not self._manifest.session_records:
            return None
        return self._manifest.session_records[-1]

    def state(self) -> dict[str, Any]:
        records = self._manifest.session_records
        session = self.current_session()
        completed = sum(
            1 for record in records if self._phase_of(record) == SessionPhase.DONE
        )
        phase = (
            SessionPhase.DONE.value
            if session is None
            else self._phase_of(session).value
        )
        return {
            "phase": phase,
            "totals": {
                "sessions": len(records),
                "completed": completed,
                "remaining": len(records) - completed,
            },
        }

    def step_until_done(self) -> StepUntilDoneResult:
        """Walk this launch's appended cell to DONE and return the done state.

        Each cell (an OFF baseline point or an ON measurement) walks
        PREPARE_FIXTURE -> RUN_SESSION; the worker plugin auto-injects recall
        during ON cells. There is no advance afterwards: the next cell is the
        next click's append, never this process's business. A failing walk gate
        that stops the walk checkpoints the session in the HALTED_ON_GATE
        side-state and returns its halted descriptor instead of continuing.
        """
        while True:
            session = self.current_session()
            if session is None:
                return self._done_state()

            phase = self._phase_of(session)

            if phase == SessionPhase.HALTED_ON_GATE:
                return self._halted_descriptor(session)

            if phase == SessionPhase.DONE:
                return self._done_state()

            if phase == SessionPhase.PREPARE_FIXTURE:
                _LOG.info(
                    "cumulative.sequencer.prepare_fixture sequence_index=%d memory_mode=%s",
                    session.sequence_index,
                    session.memory_mode,
                )
                session.org_id = self._manifest.org_id
                self._runner.prepare_fixture(session)
                session.set_phase(SessionPhase.RUN_SESSION)
                self._checkpoint()
                continue

            if phase == SessionPhase.RUN_SESSION:
                if session.started_at is None:
                    session.started_at = self._utc_now_iso()

                _LOG.info(
                    "cumulative.sequencer.run_session sequence_index=%d memory_mode=%s",
                    session.sequence_index,
                    session.memory_mode,
                )
                telemetry = self._runner.run_session(session)
                session.progress = progress_from_cell_result(telemetry).to_dict()
                halt_gate = self._first_stopping_walk_gate(session)
                if halt_gate is not None:
                    session.set_phase(SessionPhase.HALTED_ON_GATE)
                    self._checkpoint()
                    halted = self._halted_descriptor(session)
                    _LOG.info(
                        "cumulative.sequencer.halted_on_gate sequence_index=%d ordinal=%d model=%s gate=%s expected_producers=%s observed_producers=%s",
                        session.sequence_index,
                        halted["ordinal"],
                        halted["model"],
                        halted["gate"],
                        ",".join(halted["expected_producer_model_ids"]),
                        ",".join(halted["observed_producer_model_ids"]),
                    )
                    return halted
                session.complete_gate = True
                session.set_phase(SessionPhase.DONE)
                self._checkpoint()
                continue

            raise ValueError(
                f"unsupported session phase for step_until_done: {phase.value!r}"
            )

    def _checkpoint(self) -> None:
        self._manifest.updated_at = self._utc_now_iso()
        atomic_write(self._manifest_path, self._manifest)

    @staticmethod
    def _first_stopping_walk_gate(
        session: SessionRecord,
    ) -> WalkGateVerdictRecord | None:
        for gate in session.walk_gates:
            if gate.verdict == WalkGateVerdict.FAIL.value and gate.stops_walk:
                return gate
        return None

    def _phase_of(self, session: SessionRecord) -> SessionPhase:
        try:
            return SessionPhase(session.phase)
        except ValueError as exc:
            raise ValueError(
                f"session[{session.sequence_index}] has unknown phase {session.phase!r}"
            ) from exc

    def _halted_descriptor(self, session: SessionRecord) -> HaltedOnGate:
        halt_gate = self._first_stopping_walk_gate(session)
        if halt_gate is None:
            raise ValueError(
                "cannot describe gate halt: no failing walk gate with stops_walk=True"
            )

        return {
            "status": "halted_on_gate",
            "phase": SessionPhase.HALTED_ON_GATE.value,
            "sequence_index": session.sequence_index,
            "ordinal": int(halt_gate.ordinal),
            "model": session.model,
            "gate": halt_gate.gate,
            "verdict": halt_gate.verdict,
            "evidence": dict(halt_gate.evidence),
            "expected_producer_model_ids": list(halt_gate.expected_producer_model_ids),
            "observed_producer_model_ids": list(halt_gate.observed_producer_model_ids),
        }

    def _done_state(self) -> DoneState:
        convergence = self._convergence_for_done_state()
        _LOG.info(
            "cumulative.sequencer.done sessions_completed=%d sessions_green=%d trend_hash=%s",
            int(convergence.get("sessions_completed", 0)),
            int(convergence.get("sessions_green", 0)),
            str(convergence.get("trend_hash", "none")),
        )
        return {
            "status": "done",
            "convergence": convergence,
        }

    def _convergence_for_done_state(self) -> dict[str, Any]:
        """Source done-state standings from the scorecard (run-manifest + status
        stream only), falling back to the mutable manifest when the artifacts
        are missing so behaviour is never broken by missing artifacts."""
        try:
            scorecard = build_scorecard(self._manifest_path)
            return dict(scorecard["convergence"])
        except FileNotFoundError as exc:
            _LOG.error(
                "cumulative.sequencer.scorecard_missing falling_back_to_manifest reason=%s",
                exc,
            )
            self._notice_scorecard_fallback("scorecard_missing", exc)
            return build_convergence_trend(self._manifest.session_records).to_dict()
        except OSError as exc:
            _LOG.error(
                "cumulative.sequencer.scorecard_unreadable falling_back_to_manifest reason=%s",
                exc,
            )
            self._notice_scorecard_fallback("scorecard_unreadable", exc)
            return build_convergence_trend(self._manifest.session_records).to_dict()

    @staticmethod
    def _notice_scorecard_fallback(event: str, exc: BaseException) -> None:
        """Report that the done state came from the WRONG AUTHORITY.

        THE TWO PATHS DO NOT AGREE, and only one of them scores. The scorecard
        applies the VOID-INSTRUMENT gate; the mutable-manifest fallback does
        not. A cell whose terminal attempt was truncated is correctly dropped by
        the first and counted as a data point by the second -- and the mutable
        manifest holds a complete ``session_records[0]`` for exactly such a cell,
        so the fallback does not look degraded, it looks like a result.

        The fallback itself is deliberate: behaviour must never break because an
        artifact is missing. What was missing is anyone SAYING the standings just
        came from the path that cannot void anything. ``error``, because the
        number it produces can be wrong in the direction that flatters the run.
        """
        run_notice(
            "sequencer",
            event,
            level="error",
            detail={
                "fell_back_to": "mutable_manifest",
                "void_gate_applied": False,
                "error_type": type(exc).__name__,
            },
        )

    @staticmethod
    def _utc_now_iso() -> str:
        return (
            datetime.now(timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        )


__all__ = [
    "SessionRunner",
    "CumulativeSequencer",
]
