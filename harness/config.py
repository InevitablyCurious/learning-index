"""Benchmark run configuration for Okp memory ablation.

Recall-mode launch behavior is process-scoped on the MCP/plugin side (not request-body
fields), so benchmark reproducibility requires explicit config for both primary scored
and diagnostic paths.

Per D-BENCH-CONTRACT-2026-07: the benchmark measures pattern/quantity resilience and
capability-direction safety across ordered waves; it is NOT a fixed strong→weak
distillation script. The schedule schema below is the single active path.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Arbitrary schedule schema (replaces old fixed model_ladder)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BenchmarkWave:
    """One wave of the benchmark schedule.

    A wave groups models that run in parallel (or sequentially within the wave).
    After a wave completes, extraction/commit happens, then the next wave starts.

    ``tier`` is UNKNOWN/UNORDERED until registry evidence establishes bands;
    never invent a tier or ordering. ``models`` are the model slugs in this
    wave (arbitrary interleaving supported). ``memory_modes`` specifies which
    recall modes this wave exercises.
    """

    wave_id: str
    models: tuple[str, ...]
    tier: str = "UNKNOWN"  # UNKNOWN/UNORDERED until registry evidence (D-BENCH-CONTRACT-2026-07 §10)
    memory_modes: tuple[str, ...] = ("off", "on")

    def validate(self) -> None:
        """Validate this wave's structure. Raises RuntimeError on violation."""
        if not str(self.wave_id).strip():
            raise RuntimeError(f"wave_id must be non-empty: {self.wave_id!r}")
        if not self.models:
            raise RuntimeError(f"wave {self.wave_id!r} has no models")
        for model in self.models:
            if not str(model).strip():
                raise RuntimeError(f"wave {self.wave_id!r} has blank model")
        valid_tiers = {"UNKNOWN", "UNORDERED"} | {
            "CEILING",
            "BRACKET",
            "FLOOR",
        }  # CEILING/BRACKET/FLOOR from variance policy
        if str(self.tier) not in valid_tiers:
            raise RuntimeError(
                f"wave {self.wave_id!r} tier {self.tier!r} not in "
                f"{{UNKNOWN, UNORDERED, CEILING, BRACKET, FLOOR}}"
            )
        for mode in self.memory_modes:
            if mode not in ("off", "on"):
                raise RuntimeError(
                    f"wave {self.wave_id!r} has unknown memory_mode {mode!r}"
                )


@dataclass(frozen=True)
class BenchmarkSchedule:
    """General pattern/quantity-resilience schedule (replaces old fixed model_ladder).

    Supports arbitrary model-capability interleavings and run lengths per
    D-BENCH-CONTRACT-2026-07. Waves are ordered; within each wave, models
    may run in any order (interleaving supported).

    ``waves`` is the ordered list of waves. ``schema_version`` bumps on
    structural changes.
    """

    waves: tuple[BenchmarkWave, ...] = ()
    schema_version: int = 1  # bump when structure/interpretation changes

    def validate(self) -> None:
        """Validate the entire schedule. Raises RuntimeError on violation."""
        if not self.waves:
            raise RuntimeError("benchmark schedule has no waves")
        seen_wave_ids: set[str] = set()
        for wave in self.waves:
            wave.validate()
            if wave.wave_id in seen_wave_ids:
                raise RuntimeError(f"duplicate wave_id {wave.wave_id!r} in schedule")
            seen_wave_ids.add(wave.wave_id)
        # Ensure at least one wave with "off" mode (baseline required)
        has_off = any("off" in w.memory_modes for w in self.waves)
        if not has_off:
            raise RuntimeError(
                "benchmark schedule must include at least one wave with 'off' memory_mode"
            )

    def all_models(self) -> tuple[str, ...]:
        """Return all model slugs across all waves, deduplicated, preserving first-seen order."""
        seen: set[str] = set()
        models: list[str] = []
        for wave in self.waves:
            for model in wave.models:
                if model not in seen:
                    seen.add(model)
                    models.append(str(model))
        return tuple(models)

    def to_dict(self) -> dict[str, Any]:
        """Serialize to JSON-serializable dict for manifest."""
        return {
            "schema_version": self.schema_version,
            "waves": [
                {
                    "wave_id": w.wave_id,
                    "models": list(w.models),
                    "tier": w.tier,
                    "memory_modes": list(w.memory_modes),
                }
                for w in self.waves
            ],
        }


def parse_benchmark_schedule(payload: dict[str, Any]) -> BenchmarkSchedule:
    """Parse and validate a benchmark schedule from a dict.

    Accepts the output of BenchmarkSchedule.to_dict() or a manual dict.
    Raises RuntimeError on validation failure.
    """
    waves_raw = payload.get("waves")
    if not isinstance(waves_raw, list):
        raise RuntimeError("benchmark schedule 'waves' must be an array")

    waves: list[BenchmarkWave] = []
    for w_raw in waves_raw:
        if not isinstance(w_raw, dict):
            raise RuntimeError("each wave must be an object")
        wave = BenchmarkWave(
            wave_id=str(w_raw.get("wave_id", "")).strip(),
            models=tuple(str(m) for m in w_raw.get("models", [])),
            tier=str(w_raw.get("tier", "UNKNOWN")) if w_raw.get("tier") else "UNKNOWN",
            memory_modes=tuple(
                str(m) for m in w_raw.get("memory_modes", ("off", "on"))
            ),
        )
        wave.validate()  # validates in-place
        waves.append(wave)

    return BenchmarkSchedule(
        waves=tuple(waves),
        schema_version=int(payload.get("schema_version", 1)),
    )


def benchmark_schedule_fingerprint(
    schedule: BenchmarkSchedule | None = None,
) -> str:
    """Return a deterministic fingerprint of the schedule.

    Covers wave_ids, model slugs, tiers, and memory_modes.
    """
    resolved = schedule if schedule is not None else _default_benchmark_schedule()
    canonical_payload = [
        {
            "wave_id": wave.wave_id,
            "models": [str(model) for model in wave.models],
            "tier": wave.tier,
            "memory_modes": [str(mode) for mode in wave.memory_modes],
        }
        for wave in resolved.waves
    ]
    canonical = json.dumps(
        canonical_payload,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _default_benchmark_schedule() -> BenchmarkSchedule:
    """Return the canonical default benchmark schedule."""
    from harness.rosters import _DEFAULT_SCHEDULE

    return _DEFAULT_SCHEDULE


def _default_served_memories_host_path() -> str:
    """Resolved host path for the shared served-memories store JSON."""

    return str(Path("~/.okp/served-memories.json").expanduser().resolve())


# ---------------------------------------------------------------------------
# RunConfig — schedule is the single active path (no model_ladder shim)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RunConfig:
    """Immutable benchmark manifest enforcing reproducibility and one-org MC-1 symmetry invariants.

    The single active path is ``schedule`` (a BenchmarkSchedule). There is no
    backward-compat fallback to a fixed model_ladder. New runs must provide an
    explicit schedule; the default schedule uses the current canon roster with
    UNKNOWN/UNORDERED tiers (D-BENCH-CONTRACT-2026-07).
    """

    # Schedule is the single active path (replaces old model_ladder).
    schedule: BenchmarkSchedule = field(default_factory=_default_benchmark_schedule)

    tau: float = 0.68  # relevance floor on COMBINED score (ratified). Sent as relevance_floor on the wire.
    rng_seed: int = 20260709  # FIXED — the live D-9.4 sampler seeds from wall-clock; pin it or Recall@k>1 wobbles.
    surface_budget: int = 3  # prod surface budget / max-k
    max_attempts: int = 5  # max solve attempts per task
    deterministic_topn: bool = True  # client-side reproducible top-N by combined_score
    deterministic_recall_limit: int = (
        64  # wire limit when deterministic_topn (hub returns full candidate set)
    )
    run_label: str = ""  # threaded for per-cell session ids
    # Per DECISIONS.md D-BENCH-CONTRACT §b, primary scored ON path must not rely on
    # hidden test-mode auto-accept. Primary path runs recall in prod mode and uses a
    # declared governor policy (relevance floor + injection budget) via plugin-config.
    primary_recall_mode: str = "prod"
    primary_recall_relevance_floor: float = 0.0
    primary_recall_max_injected: int = 1000
    served_memories_host_path: str = field(
        default_factory=_default_served_memories_host_path
    )
    served_memories_container_path: str = "/home/worker/.okp/served-memories.json"
    org_id: str = ""  # D5a: org MUST be pinned explicitly by the run driver; okp-org-0 is never a valid arm target.
    # orchestrator._resolve_owned_org handles empty/None gracefully; do NOT make this required (tests build RunConfig() bare).
    mc_version: int = 1  # MC-1
    hub_url: str = field(
        default_factory=lambda: (
            os.environ.get("BENCH_HUB_URL") or "http://127.0.0.1:4440"
        )
    )  # hub Docker container `hub`; health GET /health (public, no auth). The ONE hub. NOT the mcp.
    mcp_recall_url: str = field(
        default_factory=lambda: (
            os.environ.get("BENCH_MCP_RECALL_URL") or "http://127.0.0.1:4550"
        )
    )  # okp-mcp recall CLIENT; health GET /v1/health (bearer-gated). :4550 = the bench MCP slot (commissioned prod MCP); :4450 = the operator host MCP (forbidden for bench recall). NOT the hub.
    # Live-view topology: ONE persistent `opencode serve` per cell, published on a fixed
    # host port bound to the container-side serve port. The founder attaches a TUI via
    # `opencode attach http://127.0.0.1:<serve_host_port>`. 4096 is opencode serve's default.
    serve_host_port: int = field(
        default_factory=lambda: int(
            os.environ.get("BENCH_SERVE_HOST_PORT") or "4096"
        )
    )  # host-published port for the per-cell opencode serve
    session_token_path: str = "~/.okp/mcp-session-token"  # Bearer token source (seam)
    harness_version: str = "0.1.0"
    cost_limit_usd: float | None = None
    cost_target_usd: float | None = None
    max_output_tokens: int | None = None
    max_steps_per_attempt: int | None = None
    output_price_per_1m: float | None = None
    reasoning_effort: str | None = None

    def relevance_floor(self) -> float:
        """Return the ratified relevance floor sent as `relevance_floor` on the wire."""

        return self.tau

    def to_dict(self) -> dict:
        """Return all fields as a JSON-serializable manifest for scorecard reproducibility."""

        return {
            "schedule": self.schedule.to_dict(),
            "tau": self.tau,
            "rng_seed": self.rng_seed,
            "surface_budget": self.surface_budget,
            "max_attempts": self.max_attempts,
            "deterministic_topn": self.deterministic_topn,
            "deterministic_recall_limit": self.deterministic_recall_limit,
            "run_label": self.run_label,
            "primary_recall_mode": self.primary_recall_mode,
            "primary_recall_relevance_floor": self.primary_recall_relevance_floor,
            "primary_recall_max_injected": self.primary_recall_max_injected,
            "served_memories_host_path": self.served_memories_host_path,
            "served_memories_container_path": self.served_memories_container_path,
            "org_id": self.org_id,
            "mc_version": self.mc_version,
            "hub_url": self.hub_url,
            "mcp_recall_url": self.mcp_recall_url,
            "serve_host_port": self.serve_host_port,
            "session_token_path": self.session_token_path,
            "harness_version": self.harness_version,
            "cost_limit_usd": self.cost_limit_usd,
            "cost_target_usd": self.cost_target_usd,
            "max_output_tokens": self.max_output_tokens,
            "max_steps_per_attempt": self.max_steps_per_attempt,
            "output_price_per_1m": self.output_price_per_1m,
            "reasoning_effort": self.reasoning_effort,
        }


@dataclass(frozen=True)
class LadderRung:
    """One rung of the scored backgammon ladder (single source of truth).

    ``role`` is ``"source"`` (knowledge source: session runs feed self-extraction
    into the org pool; not scored for lift) or ``"measure"`` (scored OFF/ON cells;
    consumes the accumulated pool, does NOT extract). ``recorded_class`` is the
    rung's previously recorded CEILING/BRACKET/FLOOR classification used by the
    variance policy's T4 trigger (None = no prior classification on record).
    """

    model: str
    role: str
    memory_modes: tuple[str, ...]
    recorded_class: str | None = None


# Worker opencode model declarations mirror manager session provider blocks
# (name/reasoning/tool_call/limit shape). Any worker-only additions
# (interleaved + optional headers) are layered by
# adapters.backgammon.build_worker_opencode_config.
WORKER_MODEL_REGISTRY: dict[str, dict[str, Any]] = {
    # Local proxy declarations. These are opencode MODEL BLOCKS used by
    # build_worker_opencode_config — NOT scored-roster rungs (the roster is now a
    # single subject under D4). Model ids are the bench aliases served by the
    # Local LLM Proxy (its config/models.yaml, bench aliases); the worker reaches
    # it via BENCH_WORKER_SPEND_PROXY_BASE_URL=http://host.docker.internal:4545/v1
    # (or --proxy-base-url). Shape mirrors Walter's daily opencode model block
    # for the oMLX alias (2026-08-09 directive): no options block (no
    # temperature pin, no reasoning effort) so the worker puts the same
    # request shape on the wire as the daily driver that never stalls.
    # Context is 262144 (256K, 2026-08-10 directive) matching the proxy bench
    # alias's contextLength; output 16384 mirrors the daily block.
    # RETIRED (2026-08-14) — see RETIRED_MODEL_ALIASES below. Kept as a block so
    # `--model okp-bench-worker` is refused with the RETIREMENT reason rather
    # than "unknown alias", which would send the operator looking for a typo.
    # The proxy still advertises this alias; the bench refuses it regardless.
    "okp-bench-worker": {
        # Display name only — deliberately NOT a model identity (RC-7): the
        # alias serves whichever model is resident behind the proxy.
        "name": "Local LLM Proxy (auto-resident)",
        "reasoning": True,
        "tool_call": True,
        "temperature": True,
        "attachment": False,
        "modalities": {"input": ["text"], "output": ["text"]},
        "limit": {
            "context": 262_144,
            "output": 16_384,
        },
    },
    # Pinned bench alias (2026-08-10, WO model-flag): selecting this model via
    # `run_cumulative.py run --model qwen3.6-35b-a3b-bench` makes the proxy
    # load exactly Qwen3.6-35B-A3B-MLX-8bit (exclusive load on call). The block
    # mirrors Walter's daily opencode.json `qwen3.6-35b-a3b (Local LLM Proxy -
    # oMLX)` entry; the ONE deliberate difference is limit.output 32768 (the
    # bench-alias output budget — reasoning must never be able to eat the
    # whole completion, RUNBOOK §6), where the daily block declares 16384.
    "qwen3.6-35b-a3b-bench": {
        "name": "Qwen3.6 35B-A3B 8bit via Proxy (bench)",
        "reasoning": True,
        "tool_call": True,
        "temperature": True,
        "attachment": False,
        "modalities": {"input": ["text"], "output": ["text"]},
        "limit": {
            "context": 262_144,
            "output": 32_768,
        },
    },
    # Pinned bench aliases (2026-08-13, WO roster-sync): one per additional
    # model served through the Local LLM Proxy and added to the bench roster.
    # Each mirrors the qwen3.6-35b-a3b-bench shape (bench output budget 32768
    # so reasoning can never eat the whole completion, RUNBOOK §6). Selected
    # via `run_cumulative.py run --model <alias>` (exclusive load on call).
    "deepseek-v4-flash-bench": {
        "name": "DeepSeek V4 Flash 0731 MXFP4 via Proxy (bench)",
        "reasoning": True,
        "tool_call": True,
        "temperature": True,
        "attachment": False,
        "modalities": {"input": ["text"], "output": ["text"]},
        "limit": {
            # 256512, NOT 262144 — DSV4F's real oMLX ceiling
            # (max_context_window on /v1/models/status). Must match the proxy's
            # deepseek-v4-flash-bench profile exactly; overstating the window
            # spends tokens the model will refuse at the far end of a
            # multi-hour cell.
            "context": 256_512,
            "output": 32_768,
        },
    },
    "nemotron-3-nano-30b-bench": {
        "name": "Nemotron-3 Nano 30B-A3B 4bit via Proxy (bench)",
        "reasoning": True,
        "tool_call": True,
        "temperature": True,
        "attachment": False,
        "modalities": {"input": ["text"], "output": ["text"]},
        "limit": {
            "context": 262_144,
            "output": 32_768,
        },
    },
    "gemma-4-26b-a4b-bench": {
        "name": "Gemma 4 26B-A4B QAT 4bit VLM via Proxy (bench)",
        "reasoning": True,
        "tool_call": True,
        "temperature": True,
        "attachment": False,
        "modalities": {"input": ["text"], "output": ["text"]},
        "limit": {
            "context": 262_144,
            "output": 32_768,
        },
    },
}


def backgammon_scored_ladder_roster() -> tuple[LadderRung, ...]:
    """Return the canonical ordered scored-ladder roster."""
    from harness.rosters import BACKGAMMON_SCORED_LADDER_ROSTER

    return BACKGAMMON_SCORED_LADDER_ROSTER


def backgammon_ladder_roster_fingerprint(
    rungs: tuple[LadderRung, ...] | None = None,
) -> str:
    """Return a deterministic fingerprint of the ordered ladder roster.

    The fingerprint covers the resolved model ids, their order, each rung's role,
    its memory modes, and its recorded classification, so that a later change to
    the roster is detectable when validating a run manifest that was frozen
    before the change.
    """
    from harness.rosters import BACKGAMMON_SCORED_LADDER_ROSTER

    resolved = tuple(rungs) if rungs is not None else BACKGAMMON_SCORED_LADDER_ROSTER
    canonical = json.dumps(
        [
            [
                str(rung.model),
                str(rung.role),
                [str(mode) for mode in rung.memory_modes],
                rung.recorded_class,
            ]
            for rung in resolved
        ],
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# PEP 562 lazy re-export of the roster/catalogue data that now lives in
# harness/rosters.py.
#
# config.py must NOT import rosters at module top level: rosters imports the
# dataclasses (BenchmarkWave/BenchmarkSchedule/LadderRung) from here, so a
# top-level import either way would be circular. Instead the moved names are
# resolved on first attribute access. Both `from harness.config import X` and
# `config.X` route through this, so the pre-split import surface is unchanged
# for run_cumulative.py, bench_preflight.py, adapters/backgammon.py,
# sync_cloud_roster.py and the tests.
# ---------------------------------------------------------------------------

_ROSTER_REEXPORTS = frozenset(
    {
        "_DEFAULT_SCHEDULE",
        "BACKGAMMON_SCORED_LADDER_ROSTER",
        "BACKGAMMON_LADDER_SCHEMA_VERSION",
        "DEFAULT_CLOUD_ROUTER",
        "CLOUD_ORCAROUTER_PROVIDER",
        "RETIRED_MODEL_ALIASES",
    }
)


def __getattr__(name: str) -> Any:
    """Lazily re-export the roster data that moved to harness/rosters.py."""

    if name in _ROSTER_REEXPORTS:
        from harness import rosters

        return getattr(rosters, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
