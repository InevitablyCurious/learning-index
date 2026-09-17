"""Worker-config and session-title leaves for the challenge adapter.

Extracted verbatim from harness/adapters/challenge/__init__.py
(WO-LI15-I1C STAGE 1C) and re-exported there, so every name stays
resolvable as harness.adapters.challenge.<name>. None of the names
these functions read (CLOUD_ORCAROUTER_PROVIDER, WORKER_MODEL_REGISTRY)
is monkeypatched anywhere — tests and scripts read them from
harness.config directly — so importing them here is correct and no
late-binding seam is needed. worker_image_fingerprint is NOT called
here; that call lives in the runner methods left in __init__.py.
"""

from __future__ import annotations

import re
from typing import Any

from harness.config import CLOUD_ORCAROUTER_PROVIDER, WORKER_MODEL_REGISTRY


def build_worker_opencode_config(
    *,
    model: str,
    reasoning_effort: str | None,
    proxy_base_url: str | None,
    gates_dir: str,
    golden_dir: str,
    session_id: str | None = None,
    plugin_present: bool = True,
) -> dict[str, Any]:
    config: dict[str, Any] = {
        "$schema": "https://opencode.ai/config.json",
        "model": model,
        "small_model": model,
        "shell": "/opt/okp/supervised-shell.js",
    }
    # Paths stay in lockstep with images/worker/Dockerfile. Self-compaction is the
    # benchmark's own (/opt/bench/self-compact.ts), baked into EVERY image and
    # self-gated on BENCH_SELF_COMPACT=1, so it is listed for both arms. The memory
    # plugin is listed ONLY when the image actually baked it (label
    # okp.worker.plugin_present="1", read by docker_worker.image_plugin_present):
    # a vanilla image has no plugin file there, and an opencode.json pointing at
    # an absent plugin kills the worker at boot.
    config["plugin"] = ["/opt/bench/self-compact.ts"]
    if plugin_present:
        config["plugin"] = [
            "/opt/bench-plugin/plugins/plugin.ts",
            "/opt/bench/self-compact.ts",
        ]
        config["mcp"] = {
            "okp": {
                "//": "disabled by design: the plugin supplies its own MCP transport, do not auto-spawn local MCP",
                "enabled": False,
            }
        }
    # REPAIR NEVER COMPACTS, AND NOW NOTHING SLIPS PAST THAT. opencode compacts
    # by itself when a session nears the model's limit; three of four
    # Learning-Index runs had repair rounds summarised that way. Off here, the
    # session instead stops at the limit and the harness ends the cell as
    # CONTEXT EXHAUSTED (harness/context_budget.py). The plugin's own build-
    # boundary compaction calls /summarize, which this setting does not gate —
    # verified in bench-worker:v1.
    config["compaction"] = {"auto": False}
    config["permission"] = {
        "*": "allow",
        "external_directory": {"*": "deny"},
        "bash": {
            "*": "allow",
            f"*{gates_dir}*": "deny",
            f"*{golden_dir}*": "deny",
            "*report.mjs*": "deny",
            "*run.mjs*": "deny",
        },
        "edit": {"*": "allow", "*opencode.json": "deny"},
        "doom_loop": "deny",
        "question": "deny",
        "task": "deny",
    }
    provider_id, _, model_id = model.partition("/")
    if not provider_id or not model_id:
        return config

    if provider_id != "local-llm-proxy":
        # Cloud (OrcaRouter) branch: write the full provider block from the contract.
        # The ONLY deviation from the operator's daily block is apiKey = {env:ORCAROUTER_API_KEY}.
        options = dict(CLOUD_ORCAROUTER_PROVIDER["options"])
        if proxy_base_url is not None:
            options["baseURL"] = proxy_base_url
        config["provider"] = {
            provider_id: {
                "npm": CLOUD_ORCAROUTER_PROVIDER["npm"],
                "name": CLOUD_ORCAROUTER_PROVIDER["name"],
                "options": options,
                "models": CLOUD_ORCAROUTER_PROVIDER["models"],
            }
        }
        return config

    model_registry = WORKER_MODEL_REGISTRY.get(model_id)
    if model_registry is None:
        raise ValueError(
            f"unsupported worker model_id for opencode config: {model_id!r}"
        )

    provider_options: dict[str, Any] = {
        "apiKey": "{env:LOCAL_LLM_PROXY_API_KEY}",
    }
    if proxy_base_url is not None:
        provider_options["baseURL"] = proxy_base_url

    model_block: dict[str, Any] = dict(model_registry)
    # NOTE: Never force tool_choice="required" here. Moonshot/kimi rejects it (hard 400),
    # and harness policy is to allow normal tool autonomy.
    model_block["interleaved"] = {"field": "reasoning_content"}
    if session_id:
        model_block["headers"] = {"X-Session-Id": session_id}
    if reasoning_effort is not None:
        options = model_block.setdefault("options", {})
        options["reasoning"] = {"effort": reasoning_effort}

    provider_config: dict[str, Any] = {
        provider_id: {
            "options": provider_options,
            "models": {
                model_id: model_block,
            },
        }
    }

    if provider_config:
        config["provider"] = provider_config
    return config


def _safe_title_org_component(org_id: str | None) -> str:
    """Fold ``org_id`` to ``[A-Za-z0-9-]`` for embedding in a session title."""
    folded = re.sub(r"[^A-Za-z0-9-]+", "-", str(org_id or "")).strip("-")
    return folded or "org"


def bench_session_title(org_id: str | None, memory_mode: str, cell_ts: int) -> str:
    """Deterministic, identifiable OpenCode session title for a bench cell.

    Format: ``bench-<org_id>-<arm on|off>-<cell_ts>``. ``cell_ts`` is
    the epoch second captured ONCE at cell start, so the title is stable
    across every attempt and resume of that cell and lands verbatim in the
    exported session DB (``session.title``) for the prod dashboard.
    """
    return f"bench-{_safe_title_org_component(org_id)}-{memory_mode}-{int(cell_ts)}"
