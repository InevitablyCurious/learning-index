"""Roster composition: model slugs, provider pins, cloud slug, override, build.

Split out of ``scripts/run_cumulative.py`` (LI-14).
"""

from __future__ import annotations

import logging
import re
import sys

from harness import config
from harness.cumulative.manifest import roster_hash as cumulative_roster_hash
from harness.cumulative.types import RosterEntry

_LOG = logging.getLogger("run_cumulative")


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
    for rung in config.scored_ladder_roster():
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
        raise RuntimeError("scored_ladder_roster resolved empty")
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
