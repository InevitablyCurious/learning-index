"""Run-start context capture for cumulative benchmark comparability.

Exploration serves are excluded from downstream lift computation because they are
deliberately degraded. Exploration serves are included in downstream
feedback-divergence measurement because measuring that divergence is their
purpose.
"""

from __future__ import annotations

from datetime import datetime, timezone
import logging
import os
from typing import Any, Mapping

_LOG = logging.getLogger(__name__)

ALLOW_MISSING_ENV = "BENCH_ALLOW_MISSING_RUN_CONTEXT"


def _utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _lever(value: Any, source: str) -> dict[str, Any]:
    return {"value": value, "source": source}


def _env_lever_with_default(
    env: Mapping[str, str], key: str, default: str
) -> dict[str, Any]:
    value = str(env.get(key, "")).strip()
    if value:
        return _lever(value, "bench-env")
    return _lever(default, "documented-default")


def _validate_fraction_lever(lever_id: str, lever: Mapping[str, Any]) -> None:
    raw_value = str(lever.get("value", ""))
    try:
        value = float(raw_value)
    except ValueError as exc:
        raise RuntimeError(
            f"{lever_id} must be a float in [0.0, 1.0], got {raw_value!r}"
        ) from exc
    if not 0.0 <= value <= 1.0:
        raise RuntimeError(
            f"{lever_id} must be a float in [0.0, 1.0], got {raw_value!r}"
        )


def _collect_available() -> dict[str, Any]:
    # BENCH-ONLY rate, never a production default: production exploration is
    # 1–5%, but at bench query volume 1% yields about zero exploration serves.
    # 0.10 is the smallest round fraction that yields a usable count while
    # staying an order of magnitude below a level unacceptable in production.
    bench_exploration_fraction = _env_lever_with_default(
        os.environ, "BENCH_EXPLORATION_FRACTION", "0.10"
    )
    _validate_fraction_lever(
        "L14_BENCH_EXPLORATION_FRACTION", bench_exploration_fraction
    )

    levers = {
        "L1_relevance_floor": _lever("0.55", "documented-default"),
        "L2_surface_budget": _lever("3", "documented-default"),
        "L3_recall_limit": _lever("3", "documented-default"),
        "L4_OKP_RECALL_MODE": _env_lever_with_default(
            os.environ, "BENCH_RECALL_MODE", "prod"
        ),
        "L6_gamma": _lever("0.1", "compiled-const"),
        "L7_delta": _lever("0.15", "compiled-const"),
        "L8_RETRIEVAL_TEMPERATURE": _env_lever_with_default(
            os.environ, "BENCH_RETRIEVAL_TEMPERATURE", "0.7"
        ),
        "L9_RETRIEVAL_NEW_MEM_BOOST_MULT": _env_lever_with_default(
            os.environ, "BENCH_RETRIEVAL_NEW_MEM_BOOST_MULT", "0.5"
        ),
        "L10_RETRIEVAL_NEW_MEM_BOOST_WINDOW": _env_lever_with_default(
            os.environ, "BENCH_RETRIEVAL_NEW_MEM_BOOST_WINDOW", "30"
        ),
        "L11_contestedThreshold": _lever("0.20", "compiled-const"),
        "L12_RETRIEVAL_OPEN_LOOP_FRACTION": _env_lever_with_default(
            os.environ, "BENCH_RETRIEVAL_OPEN_LOOP_FRACTION", "0.0"
        ),
        "L13_RETRIEVAL_COUNTERFACTUAL_LOGGING": _env_lever_with_default(
            os.environ, "BENCH_RETRIEVAL_COUNTERFACTUAL_LOGGING", "false"
        ),
        # Distinct from L12: L12 is the hub production open-loop fraction; L14 is the bench's own exploration rate.
        "L14_BENCH_EXPLORATION_FRACTION": bench_exploration_fraction,
        # New primary endpoint replay arms: shipped policy versus the same policy with E3 outcome events ignored.
        "L15_PAIRED_CONTRAST_ARMS": _lever(
            "shipped:edge-policy-v1|counterfactual:edge-policy-v1-outcomes-ignored",
            "compiled-const",
        ),
    }

    return {
        "status": "available",
        "collected_at": _utc_now_iso(),
        "levers": levers,
        "edge_policy": None,
    }


def collect_run_context() -> dict[str, Any]:
    """Collect the frozen-by-record recall/policy context for a bench run."""

    _LOG.info("op=run_context.collect_start")
    try:
        context = _collect_available()
    except Exception as exc:
        _LOG.error("op=run_context.collect_failed error=%r", exc)
        if os.environ.get(ALLOW_MISSING_ENV) == "1":
            _LOG.warning(
                "op=run_context.missing_allowed env=%s status=unavailable error=%r",
                ALLOW_MISSING_ENV,
                exc,
            )
            return {
                "status": "unavailable",
                "collected_at": _utc_now_iso(),
                "error": str(exc),
                "levers": {},
                "edge_policy": None,
            }
        raise

    _LOG.info(
        "op=run_context.collect_ok lever_count=%d",
        len(context.get("levers", {})),
    )
    return context


def compare_run_context(
    recorded: Mapping[str, Any] | None, current: Mapping[str, Any]
) -> list[str]:
    """Return dotted keys whose recorded run context differs from current context."""

    if not recorded:
        return ["run_context"]

    drift: list[str] = []
    for key in ("status", "levers", "edge_policy"):
        if recorded.get(key) != current.get(key):
            if (
                key == "levers"
                and isinstance(recorded.get(key), Mapping)
                and isinstance(current.get(key), Mapping)
            ):
                names = sorted(set(recorded[key]) | set(current[key]))
                for name in names:
                    if recorded[key].get(name) != current[key].get(name):
                        drift.append(f"levers.{name}")
            elif (
                key == "edge_policy"
                and isinstance(recorded.get(key), Mapping)
                and isinstance(current.get(key), Mapping)
            ):
                names = sorted(set(recorded[key]) | set(current[key]))
                for name in names:
                    if name == "observed_at":
                        continue
                    if recorded[key].get(name) != current[key].get(name):
                        drift.append(f"edge_policy.{name}")
            else:
                drift.append(key)
    return drift


__all__ = [
    "collect_run_context",
    "compare_run_context",
]
