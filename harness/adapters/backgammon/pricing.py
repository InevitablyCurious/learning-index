"""Pricing and proxy-budget methods for the backgammon runner.

Extracted VERBATIM from harness/adapters/backgammon/__init__.py
(WO-LI15-I2A STAGE 2A) into a role mixin, together with the module-level
pricing data the methods read (_MODEL_PRICING_USD_PER_1M, which travels
with its source comment). BackgammonRunner inherits PricingMixin, so every
self./cls. cross-call resolves through the MRO with zero call-site changes.
This module must not import from the package __init__ -- the package
__init__ imports this module.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import time

from .constants import _PROXY_CHECKPOINT_ENV
from .models import _ProxyBudgetSnapshot

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


class PricingMixin:
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
