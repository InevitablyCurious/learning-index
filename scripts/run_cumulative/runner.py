"""Per-session runtime seam: RealSessionRunner + runner construction.

Split out of ``scripts/run_cumulative.py`` (LI-14). ``load_snapshot`` is
imported at the TOP here so ``RealSessionRunner._resolve_seed_snapshot``'s
bare-name call resolves in this module's namespace — the monkeypatch target
``run_cumulative.runner.load_snapshot``.
"""

from __future__ import annotations

from harness.challenge_spec import default_spec
from harness.prompt_pack import default_task_dir

import argparse
import json
import logging
import os
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

from harness import config
from harness.benv import load_bench_env
from harness.live_stream import run_notice
from harness.cumulative.progress import progress_from_cell_result
from harness.cumulative.run_artifacts import (
    RunManifest,
    StatusStream,
    default_run_manifest_path,
    default_status_stream_path,
    write_run_manifest,
    write_scorecard,
)
from harness.cumulative.types import SessionRecord
from harness.egress import worker_model_base_url
from harness.preflight import verify_worker_model_acceptance
from harness.proxy_meter import SpendMeter
from harness.snapshot import (
    LoadedSnapshot,
    load_snapshot,
    validate_snapshot_for_seed,
)
from harness.spend_key import (
    key_fingerprint,
    resolve_local_llm_proxy_api_key,
    resolve_spend_db_dsn,
    resolve_worker_spend_proxy_base_url,
)

from .paths import (
    DEFAULT_ORG_ID,
    DEFAULT_PROXY_RUNS_DIR,
    GATE_ROSTER_TIMEOUT_S,
    PROMPTS_DIR,
    REPO_ROOT,
    PathLayout,
    _mode_dir,
    _utc_now_iso,
)
from .roster import _apply_model_override, _normalize_model_slug
from .template import compute_task_template_hash, verify_task_template_frozen

_LOG = logging.getLogger("run_cumulative")


def _read_proxy_served_identity(proxy_runs_dir: Path | None = None) -> str | None:
    """Read the API-reported served model identity from the relay proxy run logs.

    The local relay proxy writes per-day JSONL run logs carrying ``type:
    "request"`` rows. A genuine served identity is such a row whose
    ``upstreamModel`` is a non-empty string and differs from ``requestedModel``
    (alias-echo rows are rejected). Returns the latest genuine ``upstreamModel``
    across today's file and, for runs crossing midnight, the previous day's file
    (when the current UTC hour is < 6). Never raises; missing/unparseable input
    degrades to ``None``.
    """
    if proxy_runs_dir is None:
        proxy_runs_dir = Path(
            os.environ.get("OKP_PROXY_RUNS_DIR", str(DEFAULT_PROXY_RUNS_DIR))
        )
    now_utc = datetime.now(timezone.utc)
    candidate_dates = [now_utc]
    if now_utc.hour < 6:
        candidate_dates.append(now_utc - timedelta(days=1))

    latest_served: str | None = None
    latest_ts: str = ""
    for candidate in candidate_dates:
        run_log = proxy_runs_dir / f"{candidate.strftime('%Y-%m-%d')}.jsonl"
        try:
            with open(run_log, "r", encoding="utf-8") as fh:
                for line in fh:
                    stripped = line.strip()
                    if not stripped:
                        continue
                    try:
                        row = json.loads(stripped)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(row, dict) or row.get("type") != "request":
                        continue
                    requested = row.get("requestedModel")
                    upstream = row.get("upstreamModel")
                    if not isinstance(upstream, str) or not upstream.strip():
                        continue
                    if upstream.strip() == requested:
                        continue
                    ts = row.get("ts")
                    if not isinstance(ts, str):
                        continue
                    if latest_served is None or ts > latest_ts:
                        latest_served = upstream.strip()
                        latest_ts = ts
        except OSError:
            continue
    return latest_served


class _SessionRunState:
    def __init__(
        self, *, run_label: str, run_dir: Path, last_session_id: str | None = None
    ) -> None:
        self.run_label = run_label
        self.run_dir = run_dir
        self.last_session_id = last_session_id


def _resolve_positive_int_env(
    name: str,
    *,
    optional: bool,
) -> tuple[int | None, str]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return (None if optional else config.RunConfig().max_attempts), "default"
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a positive integer") from exc
    if value <= 0:
        raise RuntimeError(f"{name} must be a positive integer")
    return value, "env"


class _NoopSessionRunner:
    """Coordinator-only session runner used for no-service subcommands."""

    def prepare_fixture(self, session: SessionRecord) -> None:
        raise RuntimeError(
            f"prepare_fixture not available for coordinator-only command (sequence_index={session.sequence_index})"
        )

    def run_session(self, session: SessionRecord) -> object:
        raise RuntimeError(
            f"run_session not available for coordinator-only command (sequence_index={session.sequence_index})"
        )


class RealSessionRunner:
    """Real per-session runtime seam composed from ChallengeRunner."""

    def __init__(
        self,
        *,
        task: str,
        org_id: str,
        runs_dir: Path,
        repo_root: Path,
        proxy_base_url: str | None = None,
        proxy_token: str | None = None,
        run_manifest_base_path: str | None = None,
        seed: int | None = None,
        cloud_slug: str | None = None,
        compact: bool = False,
        require_todos: bool = False,
        grader_worker_target: float | None = None,
        seed_snapshot: str | None = None,
    ) -> None:
        self._task = task
        self._org_id = org_id
        self._runs_dir = runs_dir
        self._repo_root = repo_root
        # WO-BENCH-WORKER-SANDBOX-HARDENING: ``proxy_base_url`` is ONLY the
        # operator's explicit --proxy-base-url override (local mode). The
        # worker-facing model URL is otherwise resolved per-session in
        # run_session to the cell's egress sidecar, because the sidecar name
        # derives from the cell's run_label. ``cloud_slug`` (None = local)
        # selects the sidecar port at that seam.
        self._proxy_base_url = proxy_base_url
        self._proxy_token = proxy_token
        self._cloud_slug = cloud_slug
        # Chunk-boundary compaction, as declared at launch. Campaign-wide: every
        # cell in a campaign compacts or none does, because a campaign whose
        # arms disagree about this measures compaction, not memory.
        self._compact = bool(compact)
        # PLAN BEFORE WORK, declared at launch and campaign-wide for the same
        # reason as compaction: a campaign whose arms disagree about it measures
        # the planning change, not memory.
        self._require_todos = bool(require_todos)
        self._grader_worker_target = (
            None if grader_worker_target is None else float(grader_worker_target)
        )
        # WO-SNAP-04: dev-mode seed snapshot id (--seed-snapshot), declared at
        # launch like ``compact``. Resolved against the runs root and validated
        # per session in run_session (_resolve_seed_snapshot); a refusal ABORTS
        # the run — it never degrades to a scaffold build. The loaded snapshot
        # is cached on _seed_snapshot so a multi-session campaign reads disk
        # once, but validation is per-session because each session carries its
        # own model.
        self._seed_snapshot_id = seed_snapshot
        self._seed_snapshot: LoadedSnapshot | None = None
        # WO-SNAP-04B (D-SNAP-DEVMODE-EXCEPTIONS): corpus-provenance drift
        # found by the per-session validation — reported, never refused.
        # Refreshed by every _resolve_seed_snapshot call and threaded to the
        # adapter in run_session as seed_snapshot_drift.
        self._seed_snapshot_drift: list[dict[str, str | None]] = []

        # THE CHALLENGE, NOT THE EXAMPLE. Backgammon is what ships; a challenge
        # is its own repo, selected with BENCH_TASK_DIR (harness/prompt_pack.py).
        self._task_dir = default_task_dir()
        if not self._task_dir.is_dir():
            raise RuntimeError(f"challenge directory missing: {self._task_dir}")

        self._max_attempts, self._max_attempts_source = _resolve_positive_int_env(
            "BENCH_MAX_ATTEMPTS",
            optional=False,
        )
        self._max_steps_per_attempt, self._max_steps_per_attempt_source = (
            _resolve_positive_int_env(
                "BENCH_MAX_STEPS_PER_ATTEMPT",
                optional=True,
            )
        )
        self._run_timeout_s, self._run_timeout_s_source = _resolve_positive_int_env(
            "BENCH_RUN_TIMEOUT_S",
            optional=True,
        )
        self._spend_meter = SpendMeter(resolve_spend_db_dsn())
        self._session_states: dict[int, _SessionRunState] = {}

        # WO-ERRDATA: per-benchmark error-type totals. One RealSessionRunner
        # spans a whole campaign (per-cell ChallengeRunner is rebuilt each
        # cell), so THIS is the only object that can hold cross-cell totals.
        self._error_totals: dict[str, int] = {
            "guard_aborted_turns": 0,
            "finalize_timeout_turns": 0,
            "stalled_turns": 0,
        }

        from harness.adapters.challenge import ChallengeRunner

        self._runner_cls = ChallengeRunner

        # Write-once run-manifest + append-only status stream sit as siblings of
        # the MUTABLE cumulative manifest. ``run_manifest_base_path`` is the
        # mutable manifest path; when None it falls back to
        # ``<runs_dir>/manifest.json``. The manifest is written exactly once
        # per run, guarded so subsequent sessions never attempt a rewrite.
        self._run_manifest_base_path = (
            str(run_manifest_base_path)
            if run_manifest_base_path is not None
            else str(Path(self._runs_dir) / "manifest.json")
        )
        self._run_manifest_written = False
        self._seed = seed

    def _progress(self, message: str) -> None:
        _LOG.info("run_cumulative.progress %s", message)

    @staticmethod
    def _wall_near_timeout(wall_seconds: Any, run_timeout_s: int | None) -> bool:
        if run_timeout_s is None:
            return False
        try:
            return float(wall_seconds) >= 0.98 * float(run_timeout_s)
        except (TypeError, ValueError):
            return False

    def _populate_contention_covariates(self, result: Any) -> None:
        from harness.contention import ContentionCovariates

        retry_count = int(getattr(result, "zero_tool_resumes", 0) or 0)
        wall_seconds_raw = getattr(result, "wall_seconds", None)
        wall_seconds = float(wall_seconds_raw) if wall_seconds_raw is not None else None
        wall_near_timeout = self._wall_near_timeout(
            wall_seconds,
            getattr(self, "_run_timeout_s", None),
        )
        spend_meter = getattr(self, "_spend_meter", None)
        if spend_meter is None:
            spend_meter = SpendMeter(resolve_spend_db_dsn())
            self._spend_meter = spend_meter

        try:
            contention = spend_meter.contention_covariates(
                getattr(result, "session_id", None),
                retry_count=retry_count,
                wall_seconds=wall_seconds,
                wall_near_timeout=wall_near_timeout,
            )
        except (
            Exception
        ) as exc:  # observability failure must not discard an expensive cell
            _LOG.exception(
                "run_cumulative.contention_covariates_failed session_fp=%s error_type=%s",
                SessionRecord.session_fp_of(result.session_id)
                if isinstance(getattr(result, "session_id", None), str)
                and result.session_id.strip()
                else "none",
                type(exc).__name__,
            )
            contention = ContentionCovariates.empty(
                retry_count=retry_count,
                wall_seconds=wall_seconds,
                wall_near_timeout=wall_near_timeout,
            )

        result.contention = contention

    @staticmethod
    def _current_git_head(repo_root: Path | None) -> str | None:
        """Best-effort source git commit; None on any failure. Never raises."""
        if repo_root is None:
            return None
        try:
            completed = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=str(repo_root),
                capture_output=True,
                text=True,
                timeout=10,
            )
        except Exception as exc:
            _LOG.warning(
                "run_cumulative.git_head_failed error_type=%s",
                type(exc).__name__,
            )
            return None
        if completed.returncode != 0:
            return None
        commit = str(completed.stdout).strip()
        return commit or None

    def _compute_task_template_hash(self) -> str | None:
        """Stable SHA-256 over task scaffold files (sorted relative paths + bytes).

        Best-effort; None when the scaffold directory is unavailable. Never
        raises. Delegates to the pure module function ``compute_task_template_hash``.
        """
        task_dir = getattr(self, "_task_dir", None)
        if task_dir is None:
            return None
        scaffold = Path(task_dir) / "scaffold"
        return compute_task_template_hash(scaffold)

    def _resolve_seed_snapshot(self, session: SessionRecord) -> LoadedSnapshot | None:
        """Resolve + validate the --seed-snapshot tree for this session, or None.

        WO-SNAP-04 dev-mode seeding. Returns None when no snapshot was declared
        (the normal scaffold+build run). Otherwise loads the snapshot from the
        runs root — the SAME env-or-repo rule the capture side uses
        (adapters/challenge.py: BENCH_RUNS_DIR, else <repo>/runs) — and
        validates it against this session's model and the running corpus
        identity. The corpus derivations MIRROR run_session's runner_kwargs
        exactly (chunk_plan_hash over task/backgammon/prompts, template_hash
        over the scaffold, source_commit from git HEAD): a number computed by
        a different formula is a different number, and a snapshot validated
        against it would be validated against nothing.

        The disk load is cached on ``self._seed_snapshot``; the validation is
        NOT cached, because each session carries its own model and a model
        mismatch is a refusal. Refusals raise SnapshotError subclasses
        (not-found, unreadable, model mismatch) which abort the run at the top
        level — a refused snapshot never falls back to a scaffold build.
        Corpus-provenance drift is NOT a refusal (D-SNAP-DEVMODE-EXCEPTIONS):
        it is REPORTED — stored on ``self._seed_snapshot_drift`` and threaded
        to the adapter by run_session.
        """
        seed_id = getattr(self, "_seed_snapshot_id", None)
        if seed_id is None:
            return None
        snap = getattr(self, "_seed_snapshot", None)
        if snap is None:
            runs_root = Path(
                os.environ.get("BENCH_RUNS_DIR") or (self._repo_root / "runs")
            )
            snap = load_snapshot(str(seed_id), runs_root)
            self._seed_snapshot = snap
        self._seed_snapshot_drift = validate_snapshot_for_seed(
            snap,
            model=session.model,
            chunk_plan_hash=compute_task_template_hash(PROMPTS_DIR),
            template_hash=self._compute_task_template_hash(),
            source_commit=self._current_git_head(getattr(self, "_repo_root", None)),
        )
        return snap

    @staticmethod
    def _serialize_worker_fingerprint(result: Any) -> dict | str | None:
        """Serialize an ImageFingerprint (image_id/created) as dict, or str."""
        fingerprint = getattr(result, "worker_image_fingerprint", None)
        if fingerprint is None:
            return None
        if isinstance(fingerprint, Mapping):
            return dict(fingerprint)
        to_dict = getattr(fingerprint, "to_dict", None)
        if callable(to_dict):
            try:
                rendered = to_dict()
                if isinstance(rendered, Mapping):
                    return dict(rendered)
            except Exception:
                pass
        return str(fingerprint)

    def _observe_served_model(
        self,
        session_id: Any,
        requested_model: str,
    ) -> tuple[str | None, dict | None]:
        """Observe the API-reported served model; never aborts the run.

        Returns ``(upstream_str, served_dict)`` where ``served_dict`` has the
        ``{"model": requested, "upstream_model": served|None}`` shape. Both are
        None on failure or when the spend DB records nothing (local pivot).
        """
        session_id_str = (
            str(session_id).strip()
            if isinstance(session_id, str) and str(session_id).strip()
            else None
        )
        if session_id_str is None:
            return None, None
        proxy_served = _read_proxy_served_identity()
        if proxy_served:
            served_dict = {
                "model": str(requested_model),
                "upstream_model": proxy_served,
            }
            return proxy_served, served_dict
        spend_meter = getattr(self, "_spend_meter", None)
        if spend_meter is None:
            return None, None
        try:
            identities = spend_meter.model_identity(session_id_str)
        except Exception as exc:
            _LOG.exception(
                "run_cumulative.model_identity_failed session_fp=%s error_type=%s",
                SessionRecord.session_fp_of(session_id_str),
                type(exc).__name__,
            )
            return None, None
        if not identities:
            return None, None
        first = identities[0]
        upstream = getattr(first, "upstream_model", None)
        model = getattr(first, "model", None)
        served_upstream = str(upstream).strip() if upstream is not None else None
        if not served_upstream:
            model_str = str(model).strip() if model is not None else ""
            served_upstream = model_str or None
        served_dict = {
            "model": str(requested_model),
            "upstream_model": served_upstream,
        }
        return served_upstream, served_dict

    def _publish_scorecard(self) -> None:
        """Republish the derived scorecard after a cell's artifacts have grown.

        The base path is resolved exactly as ``_write_run_manifest_once`` and
        ``_append_status_records`` resolve it -- a third spelling of the same
        path is how two of them come to point at different files.

        Instrumentation-only: ``write_scorecard`` never raises, so this cannot
        abort a run. It logs its own failure and returns None.
        """
        base = getattr(self, "_run_manifest_base_path", None) or str(
            Path(self._runs_dir) / "manifest.json"
        )
        write_scorecard(base)

    def _write_run_manifest_once(
        self,
        *,
        session: SessionRecord,
        served_model: str | None,
        result: Any,
    ) -> None:
        """Write the write-once run manifest after the first served-model observation.

        Instrumentation-only: must never alter run behaviour or abort the run.
        """
        if getattr(self, "_run_manifest_written", False):
            return
        run_manifest_base_path = getattr(self, "_run_manifest_base_path", None) or str(
            Path(self._runs_dir) / "manifest.json"
        )
        try:
            manifest = RunManifest(
                run_id=Path(self._runs_dir).name,
                created_at=_utc_now_iso(),
                served_model=served_model,
                requested_model=str(session.model),
                memory_mode=str(session.memory_mode),
                org_id=str(getattr(self, "_org_id", None) or ""),
                source_commit=self._current_git_head(getattr(self, "_repo_root", None)),
                worker_image_fingerprint=self._serialize_worker_fingerprint(result),
                seed=getattr(self, "_seed", None),
                template_hash=self._compute_task_template_hash(),
                challenge=default_spec().name,
                roster_fingerprint=None,
                compact=bool(getattr(self, "_compact", False)),
                require_todos=bool(getattr(self, "_require_todos", False)),
                grader_worker_target=getattr(self, "_grader_worker_target", None),
            )
            write_run_manifest(
                default_run_manifest_path(run_manifest_base_path),
                manifest,
            )
            self._run_manifest_written = True
        except FileExistsError:
            # Already written by an earlier session — write-once invariant.
            self._run_manifest_written = True
        except Exception as exc:
            _LOG.exception(
                "run_cumulative.run_manifest_write_failed run_id=%s error_type=%s",
                Path(self._runs_dir).name,
                type(exc).__name__,
            )
            # WITHOUT THE RUN MANIFEST THERE IS NO SCORECARD. `build_scorecard`
            # reads it and raises FileNotFoundError without it, and the
            # sequencer then falls back to the mutable manifest — the path that
            # does NOT apply the VOID-INSTRUMENT gate. So this failure does not
            # merely lose an artifact: it silently routes the campaign's
            # standings through the authority that cannot void anything.
            run_notice(
                "harness",
                "run_manifest_write_failed",
                level="error",
                detail={
                    "run_id": Path(self._runs_dir).name,
                    "error_type": type(exc).__name__,
                    "consequence": "scorecard_unbuildable",
                },
            )

    def _append_status_records(
        self,
        *,
        session: SessionRecord,
        result: Any,
        served_model: dict | None,
    ) -> None:
        """Append per-attempt status records to the append-only stream.

        Instrumentation-only: must never alter run behaviour or abort the run.
        """
        try:
            progress_dict = progress_from_cell_result(result).to_dict()
        except Exception as exc:
            _LOG.exception(
                "run_cumulative.status_progress_failed sequence_index=%s error_type=%s",
                session.sequence_index,
                type(exc).__name__,
            )
            # THE CELL DISAPPEARS FROM THE SCORED SET. Nothing is appended to
            # the status stream, so `build_scorecard` never sees this cell at
            # all — it is not voided, not failed, simply absent. A cell that ran
            # its full course and contributed nothing, with no record saying so,
            # is the exact shape of the incident this instrumentation exists for.
            run_notice(
                "harness",
                "status_progress_failed",
                level="error",
                detail={
                    "sequence_index": session.sequence_index,
                    "error_type": type(exc).__name__,
                    "consequence": "cell_absent_from_scored_set",
                },
            )
            return

        input_tokens = int(getattr(result, "input_tokens", 0) or 0)
        output_tokens = int(getattr(result, "output_tokens", 0) or 0)
        # ADDITIVE ONLY (WO-TOKENS-ALL). `input_tokens` / `output_tokens` above
        # and the three `work_*` fields they feed are UNCHANGED, so every cell
        # already scored stays comparable to every cell scored after this. The
        # new fields sit alongside them; a record written before this change
        # simply lacks them and the board renders it as such rather than
        # assuming a zero.
        reasoning_tokens = int(getattr(result, "reasoning_tokens", 0) or 0)
        cache_read_tokens = int(getattr(result, "cache_read_tokens", 0) or 0)
        cache_write_tokens = int(getattr(result, "cache_write_tokens", 0) or 0)
        progress_injected_est = progress_dict.get("injected_block_est_tokens")
        progress_consumer_injected = progress_dict.get("consumer_injected_count")

        session_id = getattr(result, "session_id", None)
        session_fp = (
            SessionRecord.session_fp_of(session_id)
            if isinstance(session_id, str) and session_id.strip()
            else None
        )

        verdict_str = str(getattr(result, "verdict", "") or "")
        base: dict[str, Any] = {
            "type": "attempt",
            "schema_version": 1,
            "sequence_index": session.sequence_index,
            "memory_mode": str(session.memory_mode),
            "org_id": str(getattr(self, "_org_id", None) or ""),
            "served_model": served_model,
            "progress": progress_dict,
            "work_input_tokens": input_tokens,
            "work_output_tokens": output_tokens,
            # EVERY token the provider processed and billed for this cell.
            #
            # Was `input + output`, kept that way "for comparability" while
            # `work_processed_tokens` carried the honest figure beside it. Two
            # names for what should be one number, and the one the benchmark
            # SCORED on was the understated one — by ~100x on a cached run
            # (measured: 178,120 reported against 9,977,856 cache reads).
            #
            # Collapsed to one honest number. There is no comparability to
            # protect: pre-conformity data is throwaway and nothing has shipped.
            "work_total_tokens": (
                input_tokens + output_tokens + cache_read_tokens + cache_write_tokens
            ),
            # `work_output_tokens` has ALWAYS carried reasoning folded inside
            # it (adapters/challenge.py accumulates output+reasoning). This
            # names the reasoning share so the split is recoverable:
            #   generation-only = work_output_tokens - work_reasoning_tokens
            "work_reasoning_tokens": reasoning_tokens,
            "work_cache_read_tokens": cache_read_tokens,
            "work_cache_write_tokens": cache_write_tokens,
            "injected_block_est_tokens": progress_injected_est,
            "injected_count": getattr(result, "injected_count", None),
            "injected_block_chars": getattr(result, "injected_block_chars", None),
            "consumer_injected_count": progress_consumer_injected,
            "extraction_state": "unknown",
            "extraction_candidate_count": None,
            # WO-TRUNC-1: the terminal outcome is now recorded, not placeholder-
            # null. True = the cell resolved (verdict PASS); False = every other
            # ending. terminal_reason carries the machine reason so a scorecard
            # can tell "the model failed" (attempt_ceiling_reached) from "the
            # stream died" (transport_incomplete / harness_error).
            "terminal_outcome": verdict_str == "PASS",
            "terminal_reason": str(getattr(result, "termination_reason", "") or ""),
            # Truncated-turn accounting (WO-TRUNC-1): anomalous turn endings are
            # first-class. length_truncations is the metered finish_reason=
            # length class; the truncated_* fields are the no-signal classes
            # whose upstream token burn is unmetered client-side (never
            # synthesized) but whose wall-clock is measured and real.
            "length_truncations": int(getattr(result, "truncations", 0) or 0),
            "truncated_turns": int(getattr(result, "truncated_turns", 0) or 0),
            "truncated_turns_retried": int(
                getattr(result, "truncated_turns_retried", 0) or 0
            ),
            # THE VOID SIGNAL. Anomalous turns that are instrument failures —
            # every kind except `guard_abort`. Carried because the VOID-
            # INSTRUMENT rule reads it and `truncated_turns` (which is ALL
            # anomalies) was voiding cells over a looping model the harness had
            # already caught and recovered. See the field's definition in
            # adapters/challenge.py.
            "instrument_anomaly_turns": int(
                getattr(result, "instrument_anomaly_turns", 0) or 0
            ),
            # WO-I1: the UNRECOVERED complement of the recoverability gate —
            # instrument anomalies the harness did NOT recover (recoverable
            # classes excluded regardless of retry status). Carried so
            # downstream void-consumers read the producer's statement instead
            # of re-deriving the gate. See the field's definition in
            # adapters/challenge.py.
            "unrecovered_anomaly_turns": int(
                getattr(result, "unrecovered_anomaly_turns", 0) or 0
            ),
            # Guard-killed turns excluded from scoring turns (WO-TURNACCT-1) —
            # carried so the exclusion is visible in the ledger, never silent.
            "guard_aborted_turns": int(getattr(result, "guard_aborted_turns", 0) or 0),
            # Finalize-killed turns, excluded from scoring turns on the same
            # grounds (WO-NUDGE-INF-1). Scoring turns are
            # `turns - guard_aborted_turns - finalize_timeout_turns`, so a
            # scorecard that cannot read this subtrahend cannot reconstruct the
            # measurement. RC-5 makes the manifest plus this status stream the
            # ONLY sources a scorecard may use, so a value carried solely on a
            # PROGRESS log line is invisible to it — which is why this is here
            # and not left to the log.
            #
            # NOTE: `recovery_nudges` is deliberately NOT emitted. It exists on
            # the internal per-phase `_OpencodeRunStats` only and never reaches
            # `ChallengeCellResult`, so emitting it here would silently write a
            # constant 0 and fabricate the appearance of a measurement. The
            # nudge count stays observable on the PROGRESS line until it is
            # plumbed through the cell result properly.
            "finalize_timeout_turns": int(
                getattr(result, "finalize_timeout_turns", 0) or 0
            ),
            # Stalled turns: harness-side progress-token freezes that never enter
            # the transcript, so they have no serve-metric or ledger counter —
            # counted on ChallengeCellResult from killed_reason == "turn_stalled".
            "stalled_turns": int(getattr(result, "stalled_turns", 0) or 0),
            # D-SERVE-MESSAGE-500: non-zero gates the cell VOID-INSTRUMENT in
            # run_artifacts — the harness lost sight of the session, so nothing
            # the gates then measured is a capability signal.
            "observation_lost_turns": int(
                getattr(result, "observation_lost_turns", 0) or 0
            ),
            "unmetered_turns": int(getattr(result, "unmetered_turns", 0) or 0),
            "unmetered_turn_wall_s": float(
                getattr(result, "unmetered_turn_wall_s", 0.0) or 0.0
            ),
            "session_fp": session_fp,
            "session_id": session_id,
            # WO-STRIP-2b: the deterministic title the cell gave its OpenCode
            # session(s) (bench-<org>-<arm>-<cell_ts>); joins exported
            # session-DB rows to bench cells on the prod dashboard.
            "session_title": str(getattr(result, "session_title", None) or ""),
            # WO-SNAP-04 honesty fields. Written onto the session by
            # run_session (the single writer seam WO-SNAP-03 declared on
            # SessionRecord) and mirrored here verbatim — build_scorecard and
            # the convergence trend read them back from THIS stream, so a
            # seeded cell is dev-mode, ran no build, and carries the build
            # cost it skipped, while a normal cell states build_phase_ran=True.
            # This stream does not drop None values (StatusStream.append writes
            # the record as-is, like extraction_candidate_count above), so
            # unseeded records carry explicit nulls; readers (.get) treat null
            # and absent identically.
            "seeded_from_snapshot": session.seeded_from_snapshot,
            "build_phase_ran": bool(session.build_phase_ran),
            "skipped_build_cost": (
                dict(session.skipped_build_cost)
                if isinstance(session.skipped_build_cost, Mapping)
                else None
            ),
            "dev_mode": bool(session.dev_mode),
        }

        stream = StatusStream(
            default_status_stream_path(
                getattr(self, "_run_manifest_base_path", None)
                or str(Path(self._runs_dir) / "manifest.json")
            )
        )
        attempt_reports = getattr(result, "attempt_reports", None)
        if isinstance(attempt_reports, list) and attempt_reports:
            for idx, attempt in enumerate(attempt_reports, start=1):
                attempt_record = dict(base)
                if isinstance(attempt, Mapping):
                    attempt_record["attempt"] = attempt.get("attempt", idx)
                    attempt_record["verdict"] = attempt.get("verdict", result.verdict)
                    attempt_record["n_problems"] = attempt.get("n_problems")
                    attempt_record["failed_gates"] = list(
                        attempt.get("failed_gates", []) or []
                    )
                    # WO-GATE-ROSTER: per-gate outcomes alongside the legacy
                    # failing-only list. `failed_gates` keeps its exact prior
                    # shape and meaning for every existing consumer; these carry
                    # the facts it structurally cannot — which gates PASSED, and
                    # which never ran at all.
                    #
                    # `gate_results` is None (not []) when the gate runner did
                    # not publish it — an older report, or a run with no roster.
                    # An empty list would claim "the suite ran and contained
                    # nothing", which is the absent-reads-as-pass defect this
                    # exists to remove (invariants I-2, I-4).
                    attempt_record["gate_results"] = attempt.get("gate_results")
                    attempt_record["gate_totals"] = attempt.get("gate_totals")
                    # The code this attempt was graded against, fingerprinted at
                    # grading time. None when it could not be captured — an
                    # attempt with no snapshot is never silently given another
                    # attempt's, because a result bound to the wrong code is the
                    # false-fix defect wearing a receipt.
                    attempt_record["state_hash"] = attempt.get("state_hash")
                    attempt_record["state_alg"] = attempt.get("state_alg")
                    attempt_record["conformed"] = attempt.get("conformed")
                    # IS THIS ATTEMPT A MEASUREMENT AT ALL?
                    #
                    # A gate runner that aborts leaves gates unmeasured for
                    # HARNESS reasons, and the pass count that survives is a
                    # lower bound on an unknown rather than a score. Carried
                    # through verbatim so a reader can refuse the number instead
                    # of averaging it into a comparison.
                    #
                    # `None` (not True) when the report predates the field: an
                    # older attempt is of UNKNOWN gradability, and defaulting it
                    # to gradable would silently vouch for runs nothing checked.
                    attempt_record["gradable"] = attempt.get("gradable")
                    attempt_record["ungradable_reason"] = attempt.get(
                        "ungradable_reason"
                    )
                    attempt_record["aborted_runners"] = list(
                        attempt.get("aborted_runners", []) or []
                    )
                    attempt_record["attempt_cost_usd"] = attempt.get("attempt_cost_usd")
                    # PLAYER ORDER: the stage this round reached and how many
                    # failing checks lay past it — where a model gets stuck.
                    attempt_record["player_stage"] = attempt.get("player_stage")
                    attempt_record["player_stage_name"] = attempt.get("player_stage_name")
                    attempt_record["withheld_checks"] = attempt.get("withheld_checks")
                else:
                    attempt_record["attempt"] = idx
                    attempt_record["verdict"] = result.verdict
                attempt_record["termination_reason"] = getattr(
                    result, "termination_reason", ""
                )
                attempt_record["attempts_to_green"] = getattr(
                    result, "attempts_to_green", None
                )
                stream.append(attempt_record)
        else:
            record = dict(base)
            record["attempt"] = 1
            record["verdict"] = getattr(result, "verdict", "")
            record["termination_reason"] = getattr(result, "termination_reason", "")
            record["attempts_to_green"] = getattr(result, "attempts_to_green", None)
            stream.append(record)

        # WO-TRUNC-1: one turn_terminal record per anomalously-ended turn. These
        # are records, never rewrites — the stream stays append-only, and a run
        # that died mid-cell simply has fewer of them. `terminal` +
        # `reason` distinguish truncated_no_signal / guard_abort /
        # transport_error / stream_died_open / unclassified_finish from every
        # other way a turn can end; `retried`/`retry_kind` make the
        # burned-then-retried pair attributable.
        turn_anomalies = getattr(result, "turn_anomalies", None)
        if isinstance(turn_anomalies, list):
            for anomaly in turn_anomalies:
                if not isinstance(anomaly, Mapping):
                    continue
                turn_record = {
                    "type": "turn_terminal",
                    "schema_version": 1,
                    "sequence_index": session.sequence_index,
                    "memory_mode": str(session.memory_mode),
                    "org_id": str(getattr(self, "_org_id", None) or ""),
                    "session_fp": session_fp,
                    "session_id": session_id,
                    "phase": str(anomaly.get("phase", "")),
                    "turn_index": anomaly.get("turn_index"),
                    "terminal": str(anomaly.get("terminal", "")),
                    "reason": str(anomaly.get("reason", "")),
                    "tool_uses": anomaly.get("tool_uses"),
                    "file_writes": anomaly.get("file_writes"),
                    "input_tokens": anomaly.get("input_tokens"),
                    "output_tokens": anomaly.get("output_tokens"),
                    "reasoning_tokens": anomaly.get("reasoning_tokens"),
                    "cost_usd": anomaly.get("cost_usd"),
                    "tokens_unmetered": bool(anomaly.get("tokens_unmetered")),
                    "wall_seconds": anomaly.get("wall_seconds"),
                    "retried": bool(anomaly.get("retried")),
                    "retry_kind": anomaly.get("retry_kind"),
                }
                stream.append(turn_record)

    def _state_for_session(self, session: SessionRecord) -> _SessionRunState:
        state = self._session_states.get(session.sequence_index)
        if state is not None:
            return state

        model_slug = _normalize_model_slug(session.model)
        # THE LABEL IS UNCHANGED. It is an identifier that the board, the status
        # stream and the gate roster all key on; only the DIRECTORY moves.
        run_label = f"cumulative-{session.sequence_index:04d}-{session.memory_mode}-{model_slug}"
        run_dir = (
            self._runs_dir
            / _mode_dir(session.memory_mode)
            / f"cell-{session.sequence_index:04d}"
        )
        state = _SessionRunState(run_label=run_label, run_dir=run_dir)
        self._session_states[session.sequence_index] = state
        return state

    @property
    def _gate_roster_path(self) -> Path | None:
        """Where the gate roster lives: beside the manifest and status stream.

        The roster describes the CAMPAIGN's gate suite, not one cell's, so it
        sits at the run root next to ``manifest.json`` /
        ``manifest.status.jsonl`` rather than inside a per-cell session dir.

        Resolved defensively, mirroring ``_append_status_records``: partially
        constructed runners (the wiring tests build one without going through
        ``__init__``) must not crash a run path over an instrumentation
        artifact. Returns None when no run root can be resolved at all, and the
        caller then grades without a roster rather than aborting.
        """
        base = getattr(self, "_run_manifest_base_path", None)
        if base is None:
            runs_dir = getattr(self, "_runs_dir", None)
            if runs_dir is None:
                return None
            base = str(Path(runs_dir) / "manifest.json")
        return Path(base).parent / "gate-roster.json"

    def _write_gate_roster(self) -> None:
        """Publish the full enumerable gate suite once, at first cell start.

        WHY (WO-GATE-ROSTER). ``report.mjs`` emits only ``failed_gates``, which
        gives a board no denominator and no way to tell a gate that passed from
        one that never ran. The roster is that denominator: every enumerable
        test, captured BEFORE the agent runs so it describes the suite the run
        was actually graded against.

        WRITE-ONCE (RC-5 / invariant I-6). A roster rewritten mid-campaign would
        silently re-baseline every gate comparison already made against it, so
        an existing file is left exactly as it is — ``roster.mjs`` refuses the
        overwrite itself, and this skips the subprocess entirely.

        EXECUTION-FREE (invariant I-5). ``roster.mjs`` shells out only to
        ``vitest list`` and ``playwright test --list``; neither executes a test
        nor binds :8002, so this is safe beside a live cell and adds no
        benchmark cost beyond one enumeration per campaign.

        INSTRUMENTATION-ONLY. A roster that cannot be written must never abort a
        benchmark run: the failure is logged, the artifact is absent, and
        ``/api/wall`` reports it as unwired rather than inventing a suite.
        """
        roster_path = self._gate_roster_path
        if roster_path is None or roster_path.exists():
            return

        script = default_spec().grader_dir / "roster.mjs"
        if not script.is_file():
            _LOG.warning("run_cumulative.gate_roster_missing_script path=%s", script)
            return

        try:
            roster_path.parent.mkdir(parents=True, exist_ok=True)
            completed = subprocess.run(  # noqa: S603 - fixed argv, host-only enumerator
                [
                    "node",
                    str(script),
                    "--out",
                    str(roster_path),
                    "--task",
                    str(self._task),
                ],
                cwd=str(script.parent),
                capture_output=True,
                text=True,
                timeout=GATE_ROSTER_TIMEOUT_S,
                check=False,
            )
        except Exception as exc:
            _LOG.exception(
                "run_cumulative.gate_roster_failed error_type=%s", type(exc).__name__
            )
            # NO ROSTER MEANS NO DENOMINATOR. The wall falls back to enumerating
            # the live suite, which serves a TRUE gate count with nothing
            # measured against it — indistinguishable on screen from a run that
            # genuinely passed nothing. That reading went unnoticed for three
            # days once: `0/71 passing` over a run whose own artifacts recorded
            # 16 passing and 2 failing.
            run_notice(
                "harness",
                "gate_roster_failed",
                level="error",
                detail={
                    "error_type": type(exc).__name__,
                    "consequence": "wall_denominator_unpinned",
                },
            )
            return

        if not roster_path.is_file():
            # Exit code 2 means "enumerated, but a phase could not be listed".
            # Either way the absence is reported, never papered over.
            _LOG.warning(
                "run_cumulative.gate_roster_not_written exit=%s stderr=%s",
                completed.returncode,
                (completed.stderr or "").strip()[:400],
            )
            return

        _LOG.info(
            "run_cumulative.gate_roster_written path=%s exit=%s detail=%s",
            roster_path,
            completed.returncode,
            (completed.stderr or "").strip()[:200],
        )
        self._progress(
            f"PROGRESS step=gate-roster path={roster_path} exit={completed.returncode}"
        )

    def prepare_fixture(self, session: SessionRecord) -> None:
        verify_task_template_frozen()
        state = self._state_for_session(session)
        worktree = state.run_dir / "worktree"
        state.run_dir.mkdir(parents=True, exist_ok=True)
        if worktree.exists():
            shutil.rmtree(worktree)
        worktree.mkdir(parents=True, exist_ok=True)
        self._runner_cls._copy_tree_contents(self._task_dir / "scaffold", worktree)

        # Cell start, before the agent runs — the roster must describe the suite
        # as it stood when grading began, not as it stands when someone asks.
        self._write_gate_roster()

        _LOG.info(
            "run_cumulative.prepare_fixture sequence_index=%d memory_mode=%s run_label=%s",
            session.sequence_index,
            session.memory_mode,
            state.run_label,
        )

    def run_session(self, session: SessionRecord) -> object:
        state = self._state_for_session(session)
        state.run_dir.mkdir(parents=True, exist_ok=True)
        session.run_label = state.run_label
        if not isinstance(session.run_id, str) or not session.run_id.strip():
            session.run_id = state.run_label

        max_steps_per_attempt = getattr(self, "_max_steps_per_attempt", None)
        run_timeout_s = getattr(self, "_run_timeout_s", None)
        max_attempts_source = getattr(self, "_max_attempts_source", "default")
        max_steps_source = getattr(self, "_max_steps_per_attempt_source", "default")
        run_timeout_source = getattr(self, "_run_timeout_s_source", "default")

        # WO-BENCH-WORKER-SANDBOX-HARDENING: the worker-facing model URL is
        # ALWAYS the cell's egress sidecar — the cell sits on an --internal
        # network with zero internet route, so both modes route through the
        # sidecar (cloud port 8443, local port 4545). The sidecar name derives
        # from THIS cell's run_label, so resolution happens here per-session,
        # not once per campaign. Local mode honors the operator's explicit
        # --proxy-base-url override first; cloud mode never does.
        # ``getattr`` (not attribute access): the wiring tests build partially
        # constructed runners via __new__ that predate _cloud_slug — same
        # convention as the pacing knobs above.
        cloud_slug = getattr(self, "_cloud_slug", None)
        if cloud_slug is not None:
            worker_proxy_base_url = worker_model_base_url(state.run_label, cloud=True)
        elif self._proxy_base_url is not None:
            worker_proxy_base_url = self._proxy_base_url
        else:
            worker_proxy_base_url = resolve_worker_spend_proxy_base_url(
                run_label=state.run_label
            )

        # WO-SNAP-04: dev-mode seeding, resolved and validated BEFORE the
        # runner exists — a refusal (SnapshotError) aborts the run here and
        # never reaches a scaffold build. The four honesty fields WO-SNAP-03
        # declared on SessionRecord are WRITTEN here, on the session, by this
        # single writer: the sequencer's manifest checkpoint (to_dict) and the
        # status stream (_append_status_records) both carry the same values
        # from the same seam.
        seed_snapshot = self._resolve_seed_snapshot(session)
        session.seeded_from_snapshot = (
            seed_snapshot.snapshot_id if seed_snapshot is not None else None
        )
        # build_phase_ran's whole point: did the chunked build run? A seeded
        # cell skips it (the snapshot IS the build work product); a normal
        # cell runs it, so its honest value is True — not the declared
        # default False, which would claim the build was skipped when it ran.
        session.build_phase_ran = seed_snapshot is None
        session.skipped_build_cost = (
            dict(seed_snapshot.build_cost)
            if seed_snapshot is not None and seed_snapshot.build_cost is not None
            else None
        )
        # Seeding is a dev-mode act, and on this path --seed-snapshot IS the
        # dev-mode signal: derived strictly from it, never a silent global.
        # (The control plane's dev-mode toggle is JS-only today; there is no
        # server→argv plumbing for it — flagged in the WO-SNAP-04 hand-up.)
        session.dev_mode = seed_snapshot is not None

        runner_kwargs: dict[str, Any] = {
            "task_dir": self._task_dir,
            "work_root": state.run_dir,
            "model": session.model,
            "memory_mode": session.memory_mode,
            # WO-STRIP-2b: titles the cell's OpenCode session
            # (bench-<org>-<arm>-<cell_ts>) for prod-dashboard
            # identification. self._org_id is the authoritative source here —
            # same seam the per-cell status record's org_id uses.
            "org_id": str(getattr(self, "_org_id", None) or ""),
            "max_attempts": self._max_attempts,
            "proxy_base_url": worker_proxy_base_url,
            "proxy_token": self._proxy_token,
            "logger": _LOG,
            "progress": self._progress,
            # WO-GATE-ROSTER: lets the gate runner report which gates did NOT
            # run. Passed unconditionally; the runner itself checks existence,
            # so a campaign whose enumeration failed simply grades without it.
            "gate_roster_path": self._gate_roster_path,
            # Declared by whoever launched this campaign; the adapter never
            # re-derives it. See the flag definition for why there is exactly
            # one place this decision is made.
            "compact": bool(getattr(self, "_compact", False)),
            "require_todos": bool(getattr(self, "_require_todos", False)),
            "grader_worker_target": getattr(self, "_grader_worker_target", None),
            # WO-SNAP-02: corpus identity for snapshot provenance. The
            # producer states these; the runner/snapshot consumer must never
            # re-derive them. Raw values — None is honest producer-absence
            # and must not be rewritten to "" (unlike the sequencer's
            # chunk_plan_hash, whose manifest field is str-typed).
            "chunk_plan_hash": compute_task_template_hash(PROMPTS_DIR),
            "template_hash": self._compute_task_template_hash(),
            "source_commit": self._current_git_head(getattr(self, "_repo_root", None)),
        }
        if seed_snapshot is not None:
            # The RESOLVED snapshot tree/ directory. The adapter seeds the
            # worktree from it instead of the scaffold, asserts isolation
            # against it (swapped, never bypassed), skips the chunked build
            # and suppresses the attempt-1 capture (a snapshot-of-a-snapshot
            # would be a degenerate corpus row).
            runner_kwargs["seed_snapshot_tree"] = seed_snapshot.tree
            # WO-SNAP-04B: the corpus-provenance drift this session's
            # validation reported (D-SNAP-DEVMODE-EXCEPTIONS — demoted from a
            # refusal). Threaded to the adapter, which emits it as a notice;
            # a copy so later sessions' revalidation cannot mutate what an
            # already-constructed runner holds.
            runner_kwargs["seed_snapshot_drift"] = list(self._seed_snapshot_drift)
            runner_kwargs["seed_snapshot_depth"] = seed_snapshot.snapshot_depth
        if max_steps_per_attempt is not None:
            runner_kwargs["max_steps_per_attempt"] = max_steps_per_attempt
        if run_timeout_s is not None:
            runner_kwargs["run_timeout_s"] = run_timeout_s

        _LOG.info(
            "run_cumulative.pacing max_attempts=%s max_steps_per_attempt=%s run_timeout_s=%s "
            "max_attempts_source=%s max_steps_per_attempt_source=%s run_timeout_s_source=%s",
            self._max_attempts,
            max_steps_per_attempt,
            run_timeout_s,
            max_attempts_source,
            max_steps_source,
            run_timeout_source,
        )

        runner = self._runner_cls(
            **runner_kwargs,
        )
        # The adapter grades one cell and has no idea which cell in the campaign
        # it is — the schedule lives out here. Stamped so every live-stream
        # record carries `cell_seq` and a reader can group a run's cells without
        # parsing the run label. Set as an attribute rather than a constructor
        # argument so an adapter that predates the live stream still works.
        runner._cell_seq = int(session.sequence_index)
        result = runner.run_cell(state.run_label, state.run_dir)
        session.produced_snapshot_id = getattr(result, "produced_snapshot_id", None)
        state.last_session_id = result.session_id or state.last_session_id

        # WO-ERRDATA-20-CAP: accumulate per-cell error counts into the
        # per-benchmark totals and fast-fail the WHOLE benchmark (uncaught, no
        # scorecard) the moment any one type exceeds the cap. Mirrors
        # ServeTransportError: raised uncaught, propagates out of run_session
        # -> step_until_done -> CLI abort.
        from harness.adapters.challenge import ERROR_CAP_PER_TYPE, ErrorCapExceeded

        self._error_totals["guard_aborted_turns"] += int(
            getattr(result, "guard_aborted_turns", 0) or 0
        )
        self._error_totals["finalize_timeout_turns"] += int(
            getattr(result, "finalize_timeout_turns", 0) or 0
        )
        self._error_totals["stalled_turns"] += int(
            getattr(result, "stalled_turns", 0) or 0
        )
        for _kind, _total in self._error_totals.items():
            if _total > ERROR_CAP_PER_TYPE:
                raise ErrorCapExceeded(
                    f"{_kind} total {_total} exceeds per-benchmark cap "
                    f"{ERROR_CAP_PER_TYPE} (sequence_index={session.sequence_index})"
                )
        self._populate_contention_covariates(result)

        # Instrumentation-only run artifacts (write-once manifest + append-only
        # status stream). Must never alter scoring/extraction/gates/feedback or
        # abort the run; served_model is only known after the first run_cell.
        served_upstream, served_dict = self._observe_served_model(
            getattr(result, "session_id", None),
            str(session.model),
        )
        self._write_run_manifest_once(
            session=session,
            served_model=served_upstream,
            result=result,
        )
        self._append_status_records(
            session=session,
            result=result,
            served_model=served_dict,
        )
        # PUBLISH THE SCORECARD AFTER EVERY CELL, not once at the end.
        #
        # The scorecard is derived from the two artifacts written just above, so
        # this is the first moment this cell's outcome can be classified as
        # scored, not-scored or VOID-INSTRUMENT. Publishing here is what lets the
        # board state whether a finished cell contributed a data point -- before
        # this, `void_instrument` existed only inside a process that was about to
        # exit, and a voided cell was indistinguishable on screen from one still
        # running.
        #
        # Instrumentation-only, exactly like the two calls above: `write_scorecard`
        # never raises, and a failure costs the board its numbers, never the run.
        self._publish_scorecard()

        _LOG.info(
            "run_cumulative.run_session sequence_index=%d memory_mode=%s verdict=%s session_fp=%s",
            session.sequence_index,
            session.memory_mode,
            result.verdict,
            SessionRecord.session_fp_of(result.session_id)
            if isinstance(result.session_id, str) and result.session_id.strip()
            else "none",
        )
        return result


def _build_real_runner(
    args: argparse.Namespace,
    layout: PathLayout,
    *,
    cloud_slug: str | None = None,
) -> RealSessionRunner:
    load_bench_env()
    layout.runs_dir.mkdir(parents=True, exist_ok=True)

    repo_root = REPO_ROOT
    # WO-BENCH-WORKER-SANDBOX-HARDENING: the worker-facing model URL is ALWAYS
    # set — in BOTH modes it is the cell's egress sidecar (harness/egress.py),
    # because the cell's --internal network has zero internet route (cloud mode
    # no longer falls through to a direct https://api.orcarouter.ai baseURL).
    # The sidecar name derives from the cell's run_label, which only exists
    # per-session, so the final URL is resolved in RealSessionRunner.run_session;
    # here we resolve only what is campaign-wide: the mode (cloud_slug) and the
    # operator's explicit --proxy-base-url override (local mode only).
    proxy_base_url: str | None = None
    proxy_token: str | None = None
    if cloud_slug is None:
        proxy_base_url_arg = str(getattr(args, "proxy_base_url", "") or "").strip()
        proxy_base_url = proxy_base_url_arg or None
        proxy_token_source = ""
        proxy_token_file = str(getattr(args, "proxy_token_file", "") or "").strip()
        if proxy_token_file:
            proxy_token = (
                Path(proxy_token_file).expanduser().read_text(encoding="utf-8").strip()
            )
            proxy_token_source = (
                f"proxy_token_file:{Path(proxy_token_file).expanduser()}"
            )
            _LOG.info(
                "run_cumulative.proxy_token_loaded file=%s token_sha256_first8=%s",
                str(Path(proxy_token_file).expanduser()),
                key_fingerprint(proxy_token),
            )
        else:
            proxy_token, resolved_source = resolve_local_llm_proxy_api_key()
            proxy_token_source = resolved_source

        _LOG.info(
            "run_cumulative.proxy_source_resolved source=%s base_url_override=%s token_fp=%s",
            proxy_token_source,
            proxy_base_url or "<egress-sidecar-per-cell>",
            key_fingerprint(proxy_token),
        )

    org_id = str(getattr(args, "org", "") or "").strip() or DEFAULT_ORG_ID
    args.org = org_id

    roster_filter = str(getattr(args, "roster_model", "") or "").strip()
    roster_marker = roster_filter.casefold() if roster_filter else None
    accepted_models: list[str] = []
    seen_models: set[str] = set()
    for rung in config.BACKGAMMON_SCORED_LADDER_ROSTER:
        slug = str(rung.model)
        if roster_marker and roster_marker not in slug.casefold():
            continue
        if slug in seen_models:
            continue
        seen_models.add(slug)
        accepted_models.append(slug)
    accepted_models = _apply_model_override(
        accepted_models,
        model_override=str(getattr(args, "model", "") or "").strip() or None,
        cloud_slug=cloud_slug,
    )
    verify_worker_model_acceptance(models=accepted_models, logger=_LOG)

    return RealSessionRunner(
        task=str(args.task),
        org_id=str(args.org),
        # THE CAMPAIGN HOME ITSELF. It was `<campaign>/sessions` — which also made
        # the run manifest's `run_id` the literal string "sessions" on every run,
        # and pointed the manifest-path fallback one directory too deep. Cells now
        # hang off this as `<campaign>/memory{OFF,ON}/cell-NNNN`.
        runs_dir=layout.runs_dir.resolve(),
        repo_root=repo_root,
        proxy_base_url=proxy_base_url,
        proxy_token=proxy_token,
        run_manifest_base_path=str(layout.manifest_path),
        seed=int(args.seed),
        cloud_slug=cloud_slug,
        # Absent on any subcommand that is not `run` (only `run` declares the
        # flag), and absent means OFF — the pre-compaction behaviour.
        compact=bool(getattr(args, "compact", False)),
        require_todos=bool(getattr(args, "require_todos", False)),
        grader_worker_target=getattr(args, "grader_worker_target", None),
        # WO-SNAP-04: declared on the MAIN parser (every subcommand parses it;
        # only `run` builds a real runner). Absent/empty means no seeding —
        # the normal scaffold+build run.
        seed_snapshot=str(getattr(args, "seed_snapshot", "") or "").strip() or None,
    )
