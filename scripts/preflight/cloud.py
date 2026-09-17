"""Cloud / local model roster checks.

These mirror the harness's own gates so preflight fails with the SAME words
run_cumulative.py would exit 2 with, instead of letting the operator discover
them after a launch: `_compose_cloud_slug` (cloud roster membership) and
`_apply_model_override` (local registry + retired aliases).
"""

from __future__ import annotations

import os
import re

from preflight.core import REPO, Check


def check_cloud_key(c: Check, spend_key) -> None:
    """Blocking when --cloud. Mirrors spend_key.resolve_cloud_api_key: env
    ORCAROUTER_API_KEY wins, else the dotenv key file (config/cloud.env,
    override BENCH_CLOUD_KEY_FILE). Reports present + source +
    fingerprint ONLY — the key value is never printed (R-37). Never creates
    the file."""
    if spend_key is None:
        c.add("cloud key", False, "skipped — harness import failed")
        return
    try:
        token = spend_key.resolve_cloud_api_key()
    except Exception as exc:  # noqa: BLE001 — SpendKeyError names the checked paths
        c.add("cloud key", False, f"ABSENT — {exc}")
        return
    # Source label follows the module's documented precedence (env export wins).
    if os.environ.get(spend_key.CLOUD_API_KEY_ENV, "").strip():
        source = f"env:{spend_key.CLOUD_API_KEY_ENV}"
    else:
        source = f"file:{spend_key.resolve_cloud_key_file()}"
    fp = spend_key.key_fingerprint(token)
    c.add(
        "cloud key", True, f"present source={source} fp={fp} (key value never printed)"
    )


def check_cloud_model(c: Check, bench_config, args) -> None:
    """Blocking when --cloud. Mirrors `_compose_cloud_slug`: `{provider}/{model}`
    must be a key of CLOUD_ORCAROUTER_PROVIDER['models'] (the harness ACCEPT
    list); the composed slug is `{router}/{provider}/{model}`."""
    if bench_config is None:
        c.add("cloud model", False, "skipped — harness import failed")
        return
    provider = str(args.provider or "").strip()
    model = str(args.model or "").strip()
    if not provider or not model:
        c.add(
            "cloud model",
            False,
            "--cloud requires --provider <vendor> and --model <model> "
            "(run_cumulative.py exits 2)",
        )
        return
    router = str(args.router or bench_config.DEFAULT_CLOUD_ROUTER).strip()
    model_key = f"{provider}/{model}"
    cloud_models = bench_config.CLOUD_ORCAROUTER_PROVIDER.get("models", {})
    if model_key not in cloud_models:
        available = sorted(cloud_models)
        sample = ", ".join(available[:8])
        c.add(
            "cloud model",
            False,
            f"--cloud model {model_key!r} is not in the OrcaRouter provider block "
            f"({len(available)} accepted keys; e.g. {sample}, … — full list: "
            "harness/config.py CLOUD_ORCAROUTER_PROVIDER). "
            "run_cumulative.py exits 2 for this.",
        )
        return
    entry = cloud_models[model_key]
    limit = entry.get("limit", {}) if isinstance(entry, dict) else {}
    c.add(
        "cloud model",
        True,
        f"slug={router}/{model_key} name={entry.get('name', '?')!r} "
        f"context={limit.get('context')} output={limit.get('output')}",
    )


def check_local_model(c: Check, bench_config, args) -> None:
    """Blocking in local mode. Mirrors `_apply_model_override`: the alias must be
    served by the model proxy (harness.model_catalog), and RETIRED_MODEL_ALIASES are refused by their
    RETIREMENT reason, not as 'unknown' (a spelled-right name is not a typo)."""
    if bench_config is None:
        c.add("local model", False, "skipped — harness import failed")
        return
    from harness.model_catalog import ModelCatalogUnavailable, worker_model_registry

    try:
        registry = worker_model_registry()
    except ModelCatalogUnavailable as exc:
        c.add("local model", False, str(exc))
        return
    retired = getattr(bench_config, "RETIRED_MODEL_ALIASES", {})
    available = ", ".join(sorted(k for k in registry if k not in retired)) or "none"
    alias = str(args.model or "").strip()
    if alias.startswith("local-llm-proxy/"):
        alias = alias[len("local-llm-proxy/") :]
    if not alias:
        c.add(
            "local model",
            False,
            "--model is required — the auto-resident roster rung is retired. "
            f"available aliases: {available}",
        )
        return
    if alias in retired:
        c.add(
            "local model",
            False,
            f"--model {args.model!r} — {retired[alias]} available aliases: {available}",
        )
        return
    if alias not in registry:
        c.add(
            "local model",
            False,
            f"--model {args.model!r} is not a known worker model alias. "
            f"available aliases: {available}",
        )
        return
    limit = registry[alias].get("limit", {})
    c.add(
        "local model",
        True,
        f"alias={alias} ({registry[alias].get('name', '?')}) "
        f"context={limit.get('context')} output={limit.get('output')}",
    )


_MJS_KEY_RE = re.compile(r'^\s*"([^"]+/[^"]+)":\s*\{', re.M)


def _read_mirror_keys() -> set[str]:
    """Keys of control/cloud.mjs CLOUD_MODELS, bounded by the object's closing
    `};` so nothing else in the file can match."""
    text = (REPO / "control" / "cloud.mjs").read_text(encoding="utf-8")
    start = text.index("export const CLOUD_MODELS = {")
    end = text.index("\n};", start)
    return set(_MJS_KEY_RE.findall(text[start:end]))


def check_roster_drift(c: Check, bench_config) -> None:
    """NON-BLOCKING in both modes: config.py CLOUD_ORCAROUTER_PROVIDER['models']
    is CANONICAL; control/cloud.mjs CLOUD_MODELS is a deliberate mirror the
    control plane serves. The mirror is known to lag — drift is a surfaced
    defect, not a gate on launching."""
    if bench_config is None:
        c.add("roster drift", False, "skipped — harness import failed", blocking=False)
        return
    config_keys = set(bench_config.CLOUD_ORCAROUTER_PROVIDER.get("models", {}))
    try:
        mirror_keys = _read_mirror_keys()
    except Exception as exc:  # noqa: BLE001
        c.add(
            "roster drift",
            False,
            f"could not parse control/cloud.mjs CLOUD_MODELS: {exc}",
            blocking=False,
        )
        return
    if config_keys == mirror_keys:
        c.add(
            "roster drift",
            True,
            f"config.py and control/cloud.mjs agree ({len(config_keys)} keys)",
        )
        return
    parts = [
        f"config.py has {len(config_keys)} keys, control/cloud.mjs mirrors {len(mirror_keys)}"
    ]
    for label, diff in (
        ("missing in mirror", config_keys - mirror_keys),
        ("missing in config", mirror_keys - config_keys),
    ):
        if not diff:
            continue
        shown = sorted(diff)
        extra = f" +{len(shown) - 6} more" if len(shown) > 6 else ""
        parts.append(f"{label}: {', '.join(shown[:6])}{extra}")
    parts.append("config.py is canonical; mirror lag is a surfaced defect, not a gate")
    c.add("roster drift", False, " — ".join(parts), blocking=False)
