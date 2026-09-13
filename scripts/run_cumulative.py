#!/usr/bin/env python3
"""Canonical primary scored cumulative benchmark CLI.

This script is **THE** canonical primary scored cumulative path for Okp.
`scripts/run_aider_solve.py` (Path C) and `scripts/backgammon_scored_ladder.py`
are diagnostic/historical paths and are **not** the active primary path.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Any, Callable, Mapping, NamedTuple

from harness import config
from harness.benv import load_bench_env
from harness.live_stream import run_notice
from harness.cumulative.manifest import roster_hash as cumulative_roster_hash
from harness.cumulative.progress import progress_from_cell_result
from harness.cumulative.results_ledger import append_run_records, read_tree_id
from harness.cumulative.run_artifacts import (
    RunManifest,
    StatusStream,
    build_scorecard,
    default_run_manifest_path,
    default_status_stream_path,
    write_run_manifest,
    write_scorecard,
)
from harness.cumulative.run_context import collect_run_context, compare_run_context
from harness.cumulative.sequencer import CumulativeSequencer
from harness.cumulative.types import (
    RosterEntry,
    SessionRecord,
)
from harness.egress import worker_model_base_url
from harness.preflight import verify_worker_model_acceptance
from harness.process_reaper import (
    ProcessReaper,
    run_reaper_unconditional,
)
from harness.proxy_meter import SpendMeter
from harness.snapshot import (
    LoadedSnapshot,
    SnapshotError,
    load_snapshot,
    validate_snapshot_for_seed,
)
from harness.spend_key import (
    key_fingerprint,
    resolve_local_llm_proxy_api_key,
    resolve_spend_db_dsn,
    resolve_worker_spend_proxy_base_url,
)

IS_PRIMARY_SCORED_PATH = True
_LOG = logging.getLogger("run_cumulative")

DEFAULT_MANIFEST_PATH = Path("runs") / "cumulative" / "manifest.json"
DEFAULT_ORG_ID = "okp-org-0"
DEFAULT_PROXY_RUNS_DIR = Path(
    os.environ.get("OKP_PROXY_RUNS_DIR", str(Path.home() / ".okp" / "proxy-runs"))
)
DEFAULT_TASK_LABEL = "backgammon-cumulative-primary"
# Gate enumeration shells out to `vitest list` + `playwright --list` twice. Cold,
# that is tens of seconds; the bound exists so a wedged enumerator can never
# hold a campaign's first cell hostage — it is instrumentation, not grading.
GATE_ROSTER_TIMEOUT_S = 300
DEFAULT_SEED = config.RunConfig().rng_seed
DEFAULT_ON_BUDGET = 0

# FROZEN_TASK_TEMPLATE_HASH — WO-FREEZE-1 template freeze.
#
# SHA-256 over the live `task/backgammon/scaffold/` directory using the EXACT
# algorithm `compute_task_template_hash` applies at runtime (sorted relative
# path + raw bytes per file). Frozen at WO-FREEZE-1 (2026-08-06). Any change to
# the scaffold invalidates the hash and therefore every previously scored cell
# that ran against the old bytes — the run path fails closed until the freeze is
# re-baselined deliberately.
# Re-baselined 2026-08-10 (Walter, WO-FEEDBACK-CONTRACT): CONTRACT.md moved into
# the scaffold so the published requirements seed every worker worktree.
# RE-FROZEN 2026-08-24 (blinding pass). The scaffold was rewritten so nothing the
# model can read reveals that it is being measured: CONTRACT.md is now an ordinary
# specification rather than a document about "the hidden gate suite", the package
# is named `backgammon` rather than `benchmark-backgammon` (it printed on every
# npm command), and the debug env var is DEBUG_API rather than BENCH_DEBUG.
# Requirements are unchanged in substance — only the framing around them.
#
# Prior hash: 1ed04db22f0c3bcc27e457f71b0c818a21c46d60dc6489bd8d46d183c21dbc8a
# Re-frozen 2026-08-30 by WO-39 ease-of-use calibration: style.css cut to placeholder,
# package.json start + CONTRACT.md Node clause now use --experimental-strip-types.
# Prior hash: 9391d77d0a4f6ba6d92f769aceb31a5e4c30807d426f4a8ecb13cb88c83936b6
# RE-FROZEN 2026-08-30 (spec-completeness pass). CONTRACT.md now publishes
# `allSequences` and REQ-SEQ-DEDUP. Gate E08 graded that function and that rule
# while NO prompt and no section of CONTRACT.md declared either — the model met
# it first as an unexplained scaffold stub. On run 1788099503 the model failed
# E08 on attempt 1 and passed on attempt 2, having been told the rule by the
# repair-loop message. A gate answered by its own failure text measures attempt
# count, not capability. Requirements are unchanged in substance: the golden
# already behaved this way and the gate already asserted it — only the spec was
# silent. Guarded going forward by
# tests/test_instruction_surface_consistency.py::
#   test_every_graded_function_is_published_in_the_contract
# Prior hash: d2d2f0b798f586101bb34a698235eb1dea691b1ed760f66a316a53fd6ae42928
# RE-FROZEN 2026-09-07 (frontend origin seam). CONTRACT.md now publishes
# REQ-SAME-ORIGIN — the page must call the API with root-relative paths — and
# states the server must be reachable at BOTH `localhost:8002` and
# `127.0.0.1:8002`. Nothing in the corpus had ever said which origin the
# frontend should target, while chunk-01 mandated a loopback bind in the
# server; a model that carried `127.0.0.1` into its fetch base produced a page
# the grader (which loads `localhost`) could not use at all — every call became
# a cross-origin request the server never allowed. Measured on run 1788804359:
# 95/117 with the absolute base, 107/117 with one character changed, and the
# SAME model on run 1788777140 wrote a relative base and scored 112 with a live
# repair curve. A 17-gate swing on an unpublished, ungraded coin flip. The
# golden was never exposed to it — it has always used relative paths — so the
# control could not catch it. Requirements are unchanged in substance for the
# golden; the corpus now states what the golden always did. Graded going
# forward by gate F15 (REQ-SAME-ORIGIN), which loads the app at both host
# names. The unmeasurable loopback-bind mandate was dropped from chunk-01: the
# golden itself binds every interface, so no gate could ever have asserted it.
# Re-frozen 2026-09-10 (WO-PORT-ASSIGNABLE): `src/server.ts` now reads
# `Number(process.env.PORT ?? 8002)` instead of a literal 8002. The default is
# unchanged, so a grading run binds 8002 exactly as before and stays comparable
# with every run taken against the previous freeze. What it buys is that the
# built artifact can be run a SECOND time, on another port, without colliding
# with a grading pass — which is what makes a candidate playable from the board
# at all. The port line was already shipped in the scaffold as working code, so
# the model inherits the behaviour and this widens the required surface by one
# published clause, not by any new work.
# Re-frozen 2026-09-10 (WO-CONTRACT-CHUNK-12): three DERIVABLE facts were cut
# from the published surface — REQ-INIT's literal 26-element opening array,
# REQ-PIP's "167 each at the opening", and REQ-WINCLASS's single/gammon/
# backgammon boundary. The board CONVENTION stays (which end is white's home,
# the points[p] sign rule, array length): no model could guess it and the gates
# assert it literally. What went is what follows from that convention plus
# knowing backgammon — i.e. the part that was capability being handed over as
# transcription. Gates at risk: G01, G02, G10 (and only those). Each already
# carried a human symptom line that could never fire while the answer was in
# the prompt.
FROZEN_TASK_TEMPLATE_HASH = (
    "e1628129a751556e43cd5e700b3ebcec969af14f9797ded5cf77cd5f0dd94f29"
)


def compute_task_template_hash(scaffold: Path) -> str | None:
    """Stable SHA-256 over task scaffold files (sorted relative paths + bytes).

    Pure function: no instance state, no model endpoints. Returns the hexdigest
    over the concatenation of each file's utf-8-encoded relative path (sorted by
    ``str(path)``) followed by its raw bytes. Returns ``None`` when the scaffold
    directory is unavailable (mirrors the instance method's best-effort
    contract) and never raises for missing/unreadable files.
    """
    if scaffold is None or not scaffold.is_dir():
        return None
    digest = hashlib.sha256()
    files = sorted(
        (p for p in scaffold.rglob("*") if p.is_file()), key=lambda p: str(p)
    )
    for path in files:
        try:
            rel = str(path.relative_to(scaffold))
            digest.update(rel.encode("utf-8"))
            digest.update(path.read_bytes())
        except OSError:
            continue
    return digest.hexdigest()


def verify_task_template_frozen() -> None:
    """Fail-closed template-freeze guard for the benchmark run path.

    Computes the live scaffold hash (via ``compute_task_template_hash`` over
    ``task/backgammon/scaffold``) and raises a RuntimeError naming BOTH the
    expected (frozen) and actual (live) hashes plus the scaffold path whenever
    they differ OR the live hash cannot be computed. Purposely touches no model
    endpoint/proxy. Must be called before any scaffold copy or cell scoring.
    """
    repo_root = Path(__file__).resolve().parent.parent
    scaffold = repo_root / "task" / "backgammon" / "scaffold"
    live_hash = compute_task_template_hash(scaffold)
    if live_hash is None:
        raise RuntimeError(
            "task template freeze FAILED: scaffold unavailable at "
            f"{scaffold}; expected frozen hash {FROZEN_TASK_TEMPLATE_HASH}, "
            "could not compute live hash"
        )
    if live_hash != FROZEN_TASK_TEMPLATE_HASH:
        raise RuntimeError(
            "task template freeze FAILED: scaffold mismatch at "
            f"{scaffold}; expected (frozen) {FROZEN_TASK_TEMPLATE_HASH}, "
            f"actual (live) {live_hash}"
        )


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


class PathLayout(NamedTuple):
    manifest_path: Path
    runs_dir: Path


class _SessionRunState:
    def __init__(
        self, *, run_label: str, run_dir: Path, last_session_id: str | None = None
    ) -> None:
        self.run_label = run_label
        self.run_dir = run_dir
        self.last_session_id = last_session_id


class CliContext(NamedTuple):
    sequencer: CumulativeSequencer


def _utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _resolve_manifest_layout(manifest_arg: str) -> PathLayout:
    manifest_path = Path(manifest_arg).expanduser().resolve()
    runs_dir = manifest_path.parent
    return PathLayout(
        manifest_path=manifest_path,
        runs_dir=runs_dir,
    )


def _runs_root_from_args(args: argparse.Namespace) -> Path:
    """Where this run's launch logs accumulate — the retention prune's root.

    ``parent.parent`` was correct while campaigns were flat under ``runs/``. Under
    the benchmark tree a manifest sits at
    ``runs/<tree>/<substrate>/<router>/<provider>/<model>/manifest.json``, so the
    same expression lands on the PROVIDER directory: the prune would then glob a
    directory that holds no logs, silently retaining every launch log forever.

    Resolved by walking up to the tree — the one ancestor whose name is a unix
    timestamp — because that is where the control plane writes launch logs, and
    because it is the boundary a reset retires. Falls back to the legacy
    ``parent.parent`` when no tree is in the path.
    """
    manifest = Path(str(getattr(args, "manifest", None) or DEFAULT_MANIFEST_PATH))
    resolved = manifest.expanduser().resolve()
    for ancestor in resolved.parents:
        if re.fullmatch(r"\d{9,11}", ancestor.name):
            return ancestor
    return resolved.parent.parent


def _prune_runs_retention(runs_root: Path, *, keep: int = 2) -> dict[str, Any]:
    """Prune accumulated launch logs under ``runs/``.

    Retention controls LOG FILES ONLY. Session DBs and archived run directories
    are extraction substrate and are never deleted by this policy, including for
    failed runs. A failed run may have its old top-level launch log pruned, but
    its ``session-db/opencode.db`` must persist so the operator can extract from
    any cell that later receives a complete gate.
    """
    summary: dict[str, Any] = {"kept": [], "deleted": [], "skipped_root": None}
    try:
        if not runs_root.is_dir():
            summary["skipped_root"] = str(runs_root)
            return summary
        entries = sorted(
            [p for p in runs_root.glob("*-cell-*.log") if p.is_file()],
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for idx, path in enumerate(entries):
            if idx < keep:
                summary["kept"].append(path.name)
                continue
            path.unlink()
            summary["deleted"].append(path.name)
    except Exception as exc:
        summary["error"] = f"{type(exc).__name__}: {exc}"
    return summary


def _mode_dir(memory_mode: str) -> str:
    """The cell container for a memory mode.

    Cells used to sit flat under ``<campaign>/sessions/``, which meant the ONE
    fact an operator most wants to see on disk — was this the control arm or the
    memory arm — was legible only by parsing a run label. Under the benchmark
    tree they are split at the directory level, so an OFF baseline and its ON
    phase are two folders a human can point at.

    The campaign home stays ABOVE this split, and deliberately: one manifest
    carries the whole schedule (OFF baseline then seeded ON phase, see
    ``cumulative/ordering.py:build_schedule``), so hoisting the mode any higher
    would split one manifest across two directories.
    """
    mode = str(memory_mode or "").strip().lower()
    if mode == "on":
        return "memoryON"
    if mode == "off":
        return "memoryOFF"
    # Never silently folded into one of the two real arms: a cell whose mode did
    # not resolve is a cell whose arm is unknown, and filing it under an arm it
    # may not belong to would corrupt the contrast this bench exists to measure.
    return "memoryUNKNOWN"


def _normalize_model_slug(model: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_.-]+", "-", model).strip("-")
    return slug or "model"


def _provider_pin_from_model(model: str) -> str:
    parts = [part for part in model.split("/") if part]
    if not parts:
        raise ValueError("model slug must be non-empty")
    if len(parts) >= 2 and parts[0] == "local-llm-proxy":
        return parts[1]
    return parts[0]


def _compose_cloud_slug(args) -> str | None:
    """Compose the full cloud model slug {router}/{provider}/{model}, or None if not cloud mode."""
    if not getattr(args, "cloud", False):
        return None
    router = str(getattr(args, "router", None) or config.DEFAULT_CLOUD_ROUTER).strip()
    provider = str(getattr(args, "provider", "") or "").strip()
    model = str(getattr(args, "model", "") or "").strip()
    if not provider or not model:
        print(
            "error: --cloud requires --provider <vendor> and --model <model>",
            file=sys.stderr,
        )
        raise SystemExit(2)
    model_key = f"{provider}/{model}"
    cloud_models = config.CLOUD_ORCAROUTER_PROVIDER.get("models", {})
    if model_key not in cloud_models:
        available = ", ".join(sorted(cloud_models))
        print(
            f"error: --cloud model {model_key!r} is not in the OrcaRouter provider block. "
            f"available: {available}",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return f"{router}/{model_key}"


def _apply_model_override(
    slugs: list[str],
    *,
    model_override: str | None,
    cloud_slug: str | None = None,
) -> list[str]:
    """Apply the operator's --model selection to the roster slug list.

    The override names a proxy bench alias present in WORKER_MODEL_REGISTRY
    (e.g. ``qwen3.6-35b-a3b-bench``); the resulting roster slug is
    ``local-llm-proxy/<alias>``. The proxy makes that exact model resident on
    the first request (exclusive load on call). Valid only against the
    single-subject roster — a multi-rung roster has no defined override
    semantics, so it errors rather than guessing. Identity is still observed
    from API responses and recorded (RC-7); this flag selects, it does not
    gate. Changing the model changes the roster hash, which invalidates an
    existing manifest by design (archive + rerun, RUNBOOK §0).

    THE OVERRIDE IS REQUIRED (2026-08-14). Without one the roster resolved to
    ``local-llm-proxy/okp-bench-worker`` — the retired auto-resident rung,
    which measures whichever model happened to be loaded and records no
    identity. This is the single point every roster path passes through
    (``_build_roster`` and the worker-acceptance preflight both call it), so
    refusing here is what makes the retired design unreachable rather than
    merely discouraged.

    It is not a new obstacle in practice: the board has always launched with
    ``--model``, and a bare CLI invocation ALREADY failed a step later with
    ``roster hash drift detected`` — the manifest froze a named alias and the
    auto rung does not hash to it. This turns that confusing failure into a
    stated one. The rung itself stays in config.py; deleting it would change the
    ladder fingerprint and invalidate the live campaign (see the note there).
    """
    if cloud_slug is not None:
        if len(slugs) != 1:
            print(
                "error: --cloud override requires a single-subject roster "
                f"(resolved {len(slugs)} slugs: {', '.join(slugs)})",
                file=sys.stderr,
            )
            raise SystemExit(2)
        return [cloud_slug]
    override = str(model_override or "").strip()
    registry = getattr(config, "WORKER_MODEL_REGISTRY", {})
    retired = getattr(config, "RETIRED_MODEL_ALIASES", {})
    available = (
        ", ".join(sorted(str(k) for k in registry if k not in retired)) or "none"
    )

    if not override:
        print(
            "error: --model is required. The auto-resident roster rung is retired — a cell "
            "run on it measures whichever model is loaded and records no identity. "
            f"name the bench alias to measure. available aliases: {available}",
            file=sys.stderr,
        )
        raise SystemExit(2)

    alias = override
    if alias.startswith("local-llm-proxy/"):
        alias = alias[len("local-llm-proxy/") :]
    if alias in retired:
        # Refused by its RETIREMENT, not as an unknown alias: "unknown" would
        # send the operator hunting for a typo in a name that is spelled right.
        print(
            f"error: --model {model_override!r} — {retired[alias]} "
            f"available aliases: {available}",
            file=sys.stderr,
        )
        raise SystemExit(2)
    if alias not in registry:
        print(
            f"error: --model {model_override!r} is not a known worker model alias. "
            f"available aliases: {available}",
            file=sys.stderr,
        )
        raise SystemExit(2)
    if len(slugs) != 1:
        print(
            "error: --model override requires a single-subject roster "
            f"(resolved {len(slugs)} slugs: {', '.join(slugs)})",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return [f"local-llm-proxy/{alias}"]


def _build_roster(
    *,
    roster_model: str | None = None,
    model_override: str | None = None,
    cloud_slug: str | None = None,
) -> tuple[list[RosterEntry], str]:
    roster: list[RosterEntry] = []
    for rung in config.backgammon_scored_ladder_roster():
        model = str(rung.model)
        roster.append(
            RosterEntry(
                model=model,
                role=str(rung.role),
                provider_pin=_provider_pin_from_model(model),
                config_identity={
                    "memory_modes": [str(mode) for mode in rung.memory_modes],
                    "recorded_class": rung.recorded_class,
                },
            )
        )
    roster_model_filter = str(roster_model or "").strip()
    if roster_model_filter:
        marker = roster_model_filter.casefold()
        filtered = [entry for entry in roster if marker in entry.model.casefold()]
        if not filtered:
            available = ", ".join(entry.model for entry in roster)
            print(
                "error: --roster-model filter matched zero roster entries "
                f"({roster_model_filter!r}). available models: {available}",
                file=sys.stderr,
            )
            raise SystemExit(2)
        roster = filtered
        _LOG.info(
            "run_cumulative.roster_filter filter=%s matched=%d models=%s",
            roster_model_filter,
            len(roster),
            ",".join(entry.model for entry in roster),
        )
    if not roster:
        raise RuntimeError("backgammon_scored_ladder_roster resolved empty")
    override_slugs = _apply_model_override(
        [entry.model for entry in roster],
        model_override=model_override,
        cloud_slug=cloud_slug,
    )
    if override_slugs != [entry.model for entry in roster]:
        roster = [
            RosterEntry(
                model=slug,
                role=entry.role,
                provider_pin=_provider_pin_from_model(slug),
                config_identity=entry.config_identity,
            )
            for entry, slug in zip(roster, override_slugs)
        ]
        _LOG.info(
            "run_cumulative.model_override models=%s",
            ",".join(entry.model for entry in roster),
        )
    return roster, cumulative_roster_hash(roster)


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
    """Real per-session runtime seam composed from BackgammonRunner."""

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
        record_at_chunk_end: bool = False,
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
        # Campaign-wide like compaction: arms that disagree would measure the
        # recording turn, not memory.
        self._record_at_chunk_end = bool(record_at_chunk_end)
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

        self._task_dir = self._repo_root / "task" / "backgammon"
        if not self._task_dir.is_dir():
            raise RuntimeError(f"backgammon task directory missing: {self._task_dir}")

        self._max_attempts, self._max_attempts_source = _resolve_positive_int_env(
            "OKP_BENCH_MAX_ATTEMPTS",
            optional=False,
        )
        self._max_steps_per_attempt, self._max_steps_per_attempt_source = (
            _resolve_positive_int_env(
                "OKP_BENCH_MAX_STEPS_PER_ATTEMPT",
                optional=True,
            )
        )
        self._run_timeout_s, self._run_timeout_s_source = _resolve_positive_int_env(
            "OKP_BENCH_RUN_TIMEOUT_S",
            optional=True,
        )
        self._spend_meter = SpendMeter(resolve_spend_db_dsn())
        self._session_states: dict[int, _SessionRunState] = {}

        # WO-ERRDATA: per-benchmark error-type totals. One RealSessionRunner
        # spans a whole campaign (per-cell BackgammonRunner is rebuilt each
        # cell), so THIS is the only object that can hold cross-cell totals.
        self._error_totals: dict[str, int] = {
            "guard_aborted_turns": 0,
            "finalize_timeout_turns": 0,
            "stalled_turns": 0,
        }

        from harness.adapters.backgammon import BackgammonRunner

        self._runner_cls = BackgammonRunner

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
        (adapters/backgammon.py: OKP_BENCH_RUNS_DIR, else <repo>/runs) — and
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
                os.environ.get("OKP_BENCH_RUNS_DIR") or (self._repo_root / "runs")
            )
            snap = load_snapshot(str(seed_id), runs_root)
            self._seed_snapshot = snap
        self._seed_snapshot_drift = validate_snapshot_for_seed(
            snap,
            model=session.model,
            chunk_plan_hash=compute_task_template_hash(
                Path(__file__).resolve().parents[1] / "task" / "backgammon" / "prompts"
            ),
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
                roster_fingerprint=None,
                compact=bool(getattr(self, "_compact", False)),
                require_todos=bool(getattr(self, "_require_todos", False)),
                record_at_chunk_end=bool(getattr(self, "_record_at_chunk_end", False)),
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
            # it (adapters/backgammon.py accumulates output+reasoning). This
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
            # adapters/backgammon.py.
            "instrument_anomaly_turns": int(
                getattr(result, "instrument_anomaly_turns", 0) or 0
            ),
            # WO-I1: the UNRECOVERED complement of the recoverability gate —
            # instrument anomalies the harness did NOT recover (recoverable
            # classes excluded regardless of retry status). Carried so
            # downstream void-consumers read the producer's statement instead
            # of re-deriving the gate. See the field's definition in
            # adapters/backgammon.py.
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
            # `BackgammonCellResult`, so emitting it here would silently write a
            # constant 0 and fabricate the appearance of a measurement. The
            # nudge count stays observable on the PROGRESS line until it is
            # plumbed through the cell result properly.
            "finalize_timeout_turns": int(
                getattr(result, "finalize_timeout_turns", 0) or 0
            ),
            # Stalled turns: harness-side progress-token freezes that never enter
            # the transcript, so they have no serve-metric or ledger counter —
            # counted on BackgammonCellResult from killed_reason == "turn_stalled".
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
            # session(s) (okp-bench-<org>-<arm>-<cell_ts>); joins exported
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

        script = self._repo_root / "grader" / "roster.mjs"
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
            # (okp-bench-<org>-<arm>-<cell_ts>) for prod-dashboard
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
            "record_at_chunk_end": bool(getattr(self, "_record_at_chunk_end", False)),
            "grader_worker_target": getattr(self, "_grader_worker_target", None),
            # WO-SNAP-02: corpus identity for snapshot provenance. The
            # producer states these; the runner/snapshot consumer must never
            # re-derive them. Raw values — None is honest producer-absence
            # and must not be rewritten to "" (unlike the sequencer's
            # chunk_plan_hash, whose manifest field is str-typed).
            "chunk_plan_hash": compute_task_template_hash(
                Path(__file__).resolve().parents[1] / "task" / "backgammon" / "prompts"
            ),
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
        result = runner.run_cell(state.run_label, state.run_dir, task_id="backgammon")
        state.last_session_id = result.session_id or state.last_session_id

        # WO-ERRDATA-20-CAP: accumulate per-cell error counts into the
        # per-benchmark totals and fast-fail the WHOLE benchmark (uncaught, no
        # scorecard) the moment any one type exceeds the cap. Mirrors
        # ServeTransportError: raised uncaught, propagates out of run_session
        # -> step_until_done -> CLI abort.
        from harness.adapters.backgammon import ERROR_CAP_PER_TYPE, ErrorCapExceeded

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

    repo_root = Path(__file__).resolve().parents[1]
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
        record_at_chunk_end=bool(getattr(args, "record_at_chunk_end", False)),
        grader_worker_target=getattr(args, "grader_worker_target", None),
        # WO-SNAP-04: declared on the MAIN parser (every subcommand parses it;
        # only `run` builds a real runner). Absent/empty means no seeding —
        # the normal scaffold+build run.
        seed_snapshot=str(getattr(args, "seed_snapshot", "") or "").strip() or None,
    )


def _build_context(args: argparse.Namespace, *, require_runtime: bool) -> CliContext:
    # Card §2: --org is first-class; when omitted, every command falls back to
    # the campaign default org. Centralised here so all subcommands (run,
    # state, ...) resolve identically — previously str(None) reached
    # the sequencer and `state` without --org died on a false org-drift error
    # (2026-08-09). The ON-cell requirement (--mode on requires an explicit
    # --org) is enforced in _handle_run BEFORE this fallback is applied.
    if not str(getattr(args, "org", "") or "").strip():
        args.org = DEFAULT_ORG_ID
    layout = _resolve_manifest_layout(str(args.manifest))
    layout.runs_dir.mkdir(parents=True, exist_ok=True)

    roster_model_filter = str(getattr(args, "roster_model", "") or "").strip() or None
    model_override = str(getattr(args, "model", "") or "").strip() or None
    cloud_slug = _compose_cloud_slug(args)
    roster, _ = _build_roster(
        roster_model=roster_model_filter,
        model_override=model_override,
        cloud_slug=cloud_slug,
    )
    config_fingerprint = config.backgammon_ladder_roster_fingerprint()

    if require_runtime:
        runner = _build_real_runner(args, layout, cloud_slug=cloud_slug)
    else:
        runner = _NoopSessionRunner()

    # THE ROSTER FOR THE LIVE STREAM'S `run.start`, stamped where the roster
    # actually is. The adapter grades ONE cell and has no idea what campaign it
    # belongs to — same reason `_cell_seq` is stamped rather than constructed.
    # An attribute, so a runner that predates the live stream still works, and
    # `_NoopSessionRunner` takes it just as happily.
    runner._campaign_roster = [
        str(getattr(entry, "model", "") or "") for entry in (roster or [])
    ] or None

    current_run_context = collect_run_context()

    sequencer = CumulativeSequencer(
        manifest_path=str(layout.manifest_path),
        runner=runner,
        roster=roster,
        seed=int(args.seed),
        task=str(args.task),
        org_id=str(args.org),
        config_fingerprint=config_fingerprint,
        on_budget=int(args.on_budget),
        run_context=current_run_context,
        chunk_plan_hash=compute_task_template_hash(
            Path(__file__).resolve().parents[1] / "task" / "backgammon" / "prompts"
        )
        or "",
    )
    recorded_run_context = getattr(getattr(sequencer, "_manifest"), "run_context", None)
    drift = compare_run_context(recorded_run_context, current_run_context)
    if drift:
        _LOG.warning("op=run_context.drift differing_keys=%s", ",".join(drift))
    return CliContext(
        sequencer=sequencer,
    )


def _current_session_or_raise(sequencer: CumulativeSequencer) -> SessionRecord:
    session = sequencer.current_session()
    if session is None:
        raise RuntimeError("sequencer is done; no current session")
    return session


def _handle_run(args: argparse.Namespace) -> int:
    # Fail-open telemetry retention (data/ is a retention layer, never a source
    # of truth; a cleanup failure must never stop a run). Skip with
    # OKP_BENCH_SKIP_CLEANUP=1.
    try:
        if os.environ.get("OKP_BENCH_SKIP_CLEANUP", "") != "1":
            from cleanup_data import run_cleanup  # noqa: PLC0415 -- fail-open

            _removed = run_cleanup()
            _LOG.info("run_cumulative telemetry cleanup done; removed=%s", _removed)
    except Exception as _cleanup_exc:  # noqa: BLE001 -- fail-open, never break a run
        _LOG.warning(
            "run_cumulative telemetry cleanup failed (fail-open): %r", _cleanup_exc
        )

    validated_mode = str(getattr(args, "mode", "") or "").strip().lower() or None
    validated_org = str(getattr(args, "org", "") or "").strip()
    if validated_mode == "on" and not validated_org:
        raise RuntimeError(
            "--mode on requires --org <org>: an ON cell needs a target org. "
            "Pass --org <org> (provisioned by the production dashboard) or use --mode off."
        )

    context = _build_context(args, require_runtime=True)
    session = _current_session_or_raise(context.sequencer)
    mode_arg = str(getattr(args, "mode", "") or "").strip().lower() or None
    if mode_arg is not None and mode_arg != str(session.memory_mode):
        raise RuntimeError(
            f"--mode {mode_arg} requested but current cell is memory_mode={session.memory_mode}"
        )

    try:
        result = context.sequencer.step_until_done()
    except SnapshotError as exc:
        # WO-SNAP-04: an operator-facing refusal, not a bug. A refused seed
        # snapshot (absent, unreadable, model mismatch) ABORTS the run — it
        # never falls back to a scaffold build — and the operator gets one
        # clean line on stderr instead of a traceback. (Corpus-provenance
        # drift is not a refusal: D-SNAP-DEVMODE-EXCEPTIONS demoted it to a
        # reported warning.)
        # Exit 2 distinguishes the clean refusal from a crash (1). The
        # reaper/predicate/retention finally in main() runs on this path too.
        print(f"SEED SNAPSHOT REFUSED: {exc}", file=sys.stderr)
        return 2
    # step_until_done returns status:done (with convergence) or
    # status:halted_on_gate (measurement gate descriptor); gate failures
    # raise. Print the descriptor as-is.
    _print_json(result)
    # WO-43a: recompute the manifest layout for the ledger append — CliContext
    # carries only the sequencer, so `layout` is not in this scope. Pure
    # path resolution (mkdir lives in _build_context), so recomputing is safe.
    layout = _resolve_manifest_layout(
        str(getattr(args, "manifest", None) or DEFAULT_MANIFEST_PATH)
    )
    if result.get("status") == "done":
        # WO-43a: append the completed run's scored-cell records to the
        # HOST-side results ledger. The printed `result` carries only
        # {status, convergence}; the schema fields come from the scorecard
        # (run-manifest + status stream — the same authoritative seam the
        # done state itself sources from) and `runs/active-tree.json`.
        _append_results_ledger(args, layout)
    return 0


def _append_results_ledger(args: argparse.Namespace, layout: PathLayout) -> None:
    """Fail-open host-side ledger append for one terminal-complete run.

    The ledger is instrumentation. A failure appends no records and logs —
    it never breaks a finished run.
    """
    bench_root = Path(__file__).resolve().parents[1]
    try:
        scorecard = build_scorecard(str(layout.manifest_path))
        count = len(
            append_run_records(
                bench_root=bench_root,
                tree_id=read_tree_id(bench_root),
                task=str(args.task),
                scorecard=scorecard,
                status_stream_path=default_status_stream_path(
                    str(layout.manifest_path)
                ),
            )
        )
    except Exception as exc:  # noqa: BLE001 -- fail-open, never break a finished run
        _LOG.error(
            "run_cumulative.results_ledger_append_failed error_type=%s",
            type(exc).__name__,
        )
        return
    _LOG.info(
        "run_cumulative.results_ledger_appended records=%d run_id=%s",
        count,
        str((scorecard.get("manifest") or {}).get("run_id") if scorecard else ""),
    )


def _handle_state(args: argparse.Namespace) -> int:
    context = _build_context(args, require_runtime=False)
    _print_json(context.sequencer.state())
    return 0


def assert_primary_path() -> None:
    """Raise if this module is not marked as the canonical primary path."""

    if IS_PRIMARY_SCORED_PATH is not True:
        raise AssertionError("run_cumulative.py lost primary-path marker")

    primary_recall_mode = str(config.RunConfig().primary_recall_mode).strip().lower()
    if primary_recall_mode != "prod":
        raise AssertionError(
            "run_cumulative.py primary scored path requires RunConfig.primary_recall_mode='prod' "
            "(declared consumer policy; no hidden env auto-accept)"
        )


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run/state coordinator CLI for cumulative benchmark sequencing.",
    )
    parser.add_argument(
        "--manifest",
        default=str(DEFAULT_MANIFEST_PATH),
        help=(
            "Path to cumulative manifest JSON "
            f"(default: {DEFAULT_MANIFEST_PATH.as_posix()})."
        ),
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=DEFAULT_SEED,
        help=f"Deterministic schedule seed (default: {DEFAULT_SEED}).",
    )
    parser.add_argument(
        "--on-budget",
        type=int,
        default=DEFAULT_ON_BUDGET,
        help=f"ON-phase session budget (default: {DEFAULT_ON_BUDGET}).",
    )
    parser.add_argument(
        "--task",
        default=DEFAULT_TASK_LABEL,
        help="Logical task label used in manifest validation.",
    )
    parser.add_argument(
        "--org",
        default=None,
        help=(
            "Org id for the run; the org is provisioned by the "
            "production dashboard, not the bench. Required for ON cells "
            "(--mode on), no default."
        ),
    )
    parser.add_argument(
        "--roster-model",
        default=None,
        help=(
            "Optional case-insensitive model substring filter for roster selection "
            "(smoke/diagnostic aid; canonical benchmark runs unfiltered)."
        ),
    )
    parser.add_argument(
        "--model",
        default=None,
        help=(
            "Pin the run's subject to a named proxy bench alias present in "
            "WORKER_MODEL_REGISTRY (e.g. qwen3.6-35b-a3b-bench). The proxy makes "
            "that exact model resident on the first request (exclusive load on "
            "call); identity is still observed from API responses and recorded "
            "(RC-7). Omit to keep the neutral auto-resident slug. Changing the "
            "model changes the roster hash, which invalidates an existing "
            "manifest by design: archive runs/cumulative and rerun (RUNBOOK §0)."
        ),
    )
    parser.add_argument(
        "--seed-snapshot",
        dest="seed_snapshot",
        default=None,
        help=(
            "DEV-MODE seeding flag: start every cell from the captured "
            "snapshot <id> (under <runs>/snapshots/, runs root resolved via "
            "OKP_BENCH_RUNS_DIR else the repo's runs/) instead of the task "
            "scaffold, skipping the chunked build. The snapshot must have "
            "been authored by this run's model; a model mismatch (or an "
            "absent or unreadable snapshot) refuses the run outright (exit 2, "
            "'SEED SNAPSHOT REFUSED') and never falls back to a scaffold "
            "build. Corpus-identity drift does NOT refuse: the seed proceeds "
            "and the drift is reported as a warning. Seeded cells are "
            "recorded with dev_mode=true and are not comparable to unseeded "
            "floors."
        ),
    )
    parser.add_argument(
        "--cloud",
        action="store_true",
        default=False,
        help="Route the cell directly to a cloud provider (OrcaRouter) instead of the local relay proxy.",
    )
    parser.add_argument(
        "--router",
        default=None,
        help="Cloud router id for the composed model slug (default: orcarouter). Only used with --cloud.",
    )
    parser.add_argument(
        "--provider",
        default=None,
        help="Cloud vendor id (e.g. deepseek) — the '{provider}/{model}' key inside the OrcaRouter provider block. Only used with --cloud.",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser(
        "run",
        help="Build/resume manifest and step every scheduled session to done.",
    )
    run_parser.add_argument(
        "--mode",
        choices=["on", "off"],
        default=None,
        help=(
            "Validate the current cell's memory_mode matches on/off; errors if "
            "it does not. Does NOT restructure the schedule."
        ),
    )
    run_parser.add_argument(
        "--proxy-base-url",
        default=None,
        help=(
            "Explicit model base URL baked into worker container opencode.json "
            "(local mode only; cloud mode always uses the egress sidecar). "
            "Default resolves via OKP_BENCH_WORKER_SPEND_PROXY_BASE_URL "
            "env/.env, else the cell's per-run egress sidecar "
            "http://okp-egress-<hash>:4545/v1 derived from the run label."
        ),
    )
    run_parser.add_argument("--proxy-token-file", default=None)
    # ── CHUNK-BOUNDARY COMPACTION ───────────────────────────────────────────
    #
    # EXPLICIT ON BOTH SIDES, WITH NO DEFAULT HERE. The default belongs to the
    # control plane, which knows the model's context window and states its
    # choice in the confirmation the operator reads before START. If this flag
    # carried a default of its own there would be two rules deciding the same
    # thing, and the one the operator confirmed would not necessarily be the one
    # that ran. Omitting both flags leaves compaction OFF — the pre-2026-09-02
    # behaviour — so a hand-typed CLI invocation never acquires six extra model
    # turns it did not ask for.
    compact_group = run_parser.add_mutually_exclusive_group()
    compact_group.add_argument(
        "--compact",
        dest="compact",
        action="store_true",
        default=False,
        help=(
            "Compact the session at each chunk boundary (after every CHUNK "
            "FINISHED, including the last) and never during the repair phase. "
            "Trades spent build narration for room the troubleshooting phase "
            "needs. Costs one model turn per chunk, metered into the cell "
            "totals and reported separately."
        ),
    )
    compact_group.add_argument(
        "--no-compact",
        dest="compact",
        action="store_false",
        help="Run the build with no compaction at any boundary.",
    )

    # PLAN BEFORE WORK — a benchmark run-condition, off by default.
    #
    # OFF is the honest default because turning it on CHANGES WHAT THE AGENT
    # DOES: an agent made to plan before it edits may simply perform better, for
    # reasons that have nothing to do with memory. A run with it and a run
    # without it are not comparable, and the OFF floor has to be re-established
    # after a change. Nothing enforces it harness-side — a plugin honours the
    # exported REQUIRE_TODOS, or nothing happens.
    todos_group = run_parser.add_mutually_exclusive_group()
    todos_group.add_argument(
        "--require-todos",
        dest="require_todos",
        action="store_true",
        default=False,
        help=(
            "Refuse mutating tools until the agent has written a todo list "
            "(reading stays open). Requires a memory plugin that honours "
            "REQUIRE_TODOS; the harness only declares the condition."
        ),
    )
    todos_group.add_argument(
        "--no-require-todos",
        dest="require_todos",
        action="store_false",
        help="Let the agent work without planning first (the default).",
    )

    # THE RECORDING TURN — one extra turn per chunk boundary, asking for a
    # record. This is the golden run's own shape (`pilot-driver.py` asked on all
    # 111 of its chunks; the model could answer empty), restored after run
    # 1788976174 lost all 13 of its boundaries: the model formed the intent in a
    # reasoning block, emitted the chunk marker, the turn ended, and compaction
    # fired into the gap. Zero records from 26 completed todos.
    #
    # OFF by default: it costs a model turn per chunk and therefore changes the
    # token and turn totals, which makes it a measurement variable like
    # compaction. Turning it on re-bases the floor.
    # ── MACHINE SHARE FOR GRADING ──────────────────────────────────────────
    #
    # NOT a measurement variable, unlike everything around it: it changes how
    # many test workers the GRADING container starts once the model is done,
    # and the gates and verdicts are identical either way. Held to that by
    # scripts/verify_worker_parity.py, which grades the golden at one worker
    # and at the maximum and requires them to agree gate for gate.
    #
    # A FRACTION, not a count: the container reads its own limits and works the
    # count out, so the same value fits any machine and nobody's hardware ends
    # up written into the code. The share is of what is FREE at grading time.
    run_parser.add_argument(
        "--grader-worker-target",
        dest="grader_worker_target",
        type=float,
        default=None,
        metavar="FRACTION",
        help=(
            "Share (0-1] of the grading container's FREE cpu and memory to use "
            "for test workers. Unset leaves the container's own default."
        ),
    )

    record_group = run_parser.add_mutually_exclusive_group()
    record_group.add_argument(
        "--record-at-chunk-end",
        dest="record_at_chunk_end",
        action="store_true",
        default=False,
        help=(
            "After each chunk marker and before compaction, spend one turn "
            "asking the model to record what it learned. The model stays free "
            "to record nothing; only the question is unskippable."
        ),
    )
    record_group.add_argument(
        "--no-record-at-chunk-end",
        dest="record_at_chunk_end",
        action="store_false",
        help="Do not ask at chunk boundaries (the default).",
    )

    subparsers.add_parser("state", help="Print cumulative sequencer state summary.")

    return parser


def _print_json(payload: Any) -> None:
    print(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    )


def _discover_bench_ports() -> list[int]:
    """Ports the BENCH itself publishes and must clear at teardown.

    Only the live-view serve host port qualifies (RunConfig.serve_host_port,
    default 4096) — one persistent `opencode serve` per cell (WO-WATCH-1E),
    asserted clear so a leaked serve is caught. The hub (:4440) and MCP recall
    client (:4550) are STANDING infra owned outside the bench (card §7: the
    hub is the ONE hub, normally already running); asserting them clear was a
    guaranteed false alarm on every run (2026-08-09).
    """
    rc = config.RunConfig()
    if rc.serve_host_port > 0:
        return [rc.serve_host_port]
    return []


def _emit_predicate_outcomes(args: argparse.Namespace) -> str:
    """Publish this run's graded gates as predicate outcome records.

    Rides the same unconditional exit path as the reaper and the retention
    prune, so a run that dies halfway still publishes the gates it DID grade.
    Non-fatal by construction: emission failing must never change a run's
    outcome, and a run that produced no graded gates simply has nothing to say.
    """
    try:
        from harness.outcomes.predicate_emitter import emit_for_run

        manifest = Path(str(getattr(args, "manifest", None) or DEFAULT_MANIFEST_PATH))
        run_dir = manifest.expanduser().resolve().parent
        if not (run_dir / "manifest.status.jsonl").is_file():
            return f"skipped: no status stream under {run_dir}"
        summary = emit_for_run(run_dir)
        return (
            f"wrote={summary['records_written']} "
            f"counts={summary['counts']} "
            f"binding={summary['state_binding_counts']} "
            f"out={summary['out_path']}"
        )
    except Exception as exc:  # noqa: BLE001 - never fail a run over telemetry
        return f"failed: {type(exc).__name__}: {exc}"


def main() -> int:
    assert_primary_path()
    parser = _build_arg_parser()
    args = parser.parse_args()

    # R-37 no-silent-ops: configure root logging so harness PROGRESS lines are
    # actually emitted on the run/resume paths. Without this, no basicConfig
    # exists, so every _LOG.info (including the adapter's worker-nonzero
    # stderr_tail diagnostics) was silently dropped. Logs go to stderr;
    # machine-readable results stay on stdout (_print_json).
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    handlers: dict[str, Callable[[argparse.Namespace], int]] = {
        "run": _handle_run,
        "state": _handle_state,
    }
    handler = handlers.get(str(args.command))
    if handler is None:
        raise RuntimeError(f"unsupported command: {args.command!r}")

    # RC-6 / D-NO-REAPER: the reaper runs UNCONDITIONALLY on every exit path of
    # a MUTATING command — normal return, exception (failure), and
    # KeyboardInterrupt (operator interrupt). A silent reaper is not a reaper.
    # It is a safety net wrapper only: it must not alter the handler's return
    # value or exit code. Read-only commands (state) spawn no workers and are
    # never reaped — a read-only `state` must not tear anything down
    # (2026-08-09: it ran a compose down against an unrelated project).
    mutating = {"run"}
    if str(args.command) not in mutating:
        return handler(args)
    try:
        run_label = getattr(args, "task", None) or "bench"
        bench_ports = _discover_bench_ports()
        reaper = ProcessReaper(run_label=run_label, bench_ports=bench_ports)
        return handler(args)
    finally:
        _LOG.info("process_reaper: unconditional reap entering finally")
        report = run_reaper_unconditional(reaper)
        _LOG.info(
            "process_reaper: run_label=%s killed_count=%d ports=%s "
            "cell_containers_removed=%s ok=%s",
            report.run_label,
            report.killed_count,
            report.ports,
            report.cell_containers_removed,
            report.ok,
        )
        _LOG.info("predicate_outcomes: %s", _emit_predicate_outcomes(args))
        # Runs/ retention prune (Walter 2026-08-10): rides the same
        # unconditional exit path as the reaper, so every early-cancelled
        # run's predecessor debris is bounded at latest+1 while the failed
        # run's own logs survive for post-mortem. Non-fatal by construction.
        _LOG.info(
            "runs_retention: %s", _prune_runs_retention(_runs_root_from_args(args))
        )


if __name__ == "__main__":
    raise SystemExit(main())
