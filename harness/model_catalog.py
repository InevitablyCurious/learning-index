"""Local worker models, resolved from the model proxy's own list.

The benchmark used to carry a hand-written copy of every local model it could
run (alias, display name, context window, output budget) and a second copy of
the context windows in the control plane. Both drifted from the proxy that
actually serves the models. The list now comes from one place: the proxy's
``GET /v1/models``, which reports each alias with ``purpose``, ``name``,
``context_length`` and ``max_output_tokens`` taken live from the runtime.

A model is a local worker model when its ``purpose`` is ``BENCH_PURPOSE``.
Retired aliases are still refused by ``harness.rosters.RETIRED_MODEL_ALIASES``.

THE PROXY BEING DOWN IS A HARD ERROR. There is no built-in fallback list: a
cell whose context window is guessed cannot tell when it is out of room, and a
list that silently disagrees with the proxy is exactly what this replaces.

The result is cached for the life of the process, so one run keeps one set of
limits even if the runtime's settings change while it is running.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from functools import lru_cache
from typing import Any

# Must match control/contract.mjs BENCH_PURPOSE and the proxy's bench profiles.
BENCH_PURPOSE = "okp-bench"

DEFAULT_PROXY_URL = "http://127.0.0.1:4545"


class ModelCatalogUnavailable(RuntimeError):
    """The proxy's model list could not be read or was not usable."""


def proxy_url() -> str:
    """Host-side proxy root. Same variable the control plane reads."""
    return (os.environ.get("OKP_CONTROL_PROXY_URL") or DEFAULT_PROXY_URL).rstrip("/")


def fetch_proxy_models(url: str | None = None, timeout_s: float = 5.0) -> list[dict[str, Any]]:
    """Raw ``data`` rows of the proxy's ``/v1/models``."""
    root = (url or proxy_url()).rstrip("/")
    target = f"{root}/v1/models"
    try:
        with urllib.request.urlopen(target, timeout=timeout_s) as response:
            body = json.load(response)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise ModelCatalogUnavailable(
            f"cannot read the local model list from {target} ({exc}). "
            "Start the model proxy, or point OKP_CONTROL_PROXY_URL at it."
        ) from exc
    rows = body.get("data") if isinstance(body, dict) else None
    if not isinstance(rows, list):
        raise ModelCatalogUnavailable(f"{target} returned no 'data' list")
    return rows


def model_block(row: dict[str, Any]) -> dict[str, Any]:
    """An opencode model block for one proxy row.

    Name and limits come from the proxy. Modalities are fixed to text on
    purpose: the task gives the worker no images, and keeping every bench model
    on the same input contract keeps cells comparable.
    """
    context = row.get("context_length")
    output = row.get("max_output_tokens")
    if not isinstance(context, int) or context <= 0 or not isinstance(output, int) or output <= 0:
        raise ModelCatalogUnavailable(
            f"proxy model {row.get('id')!r} reports no usable context_length/max_output_tokens"
        )
    return {
        "name": str(row.get("name") or row.get("id")),
        "reasoning": bool(row.get("reasoning", True)),
        "tool_call": True,
        "temperature": True,
        "attachment": False,
        "modalities": {"input": ["text"], "output": ["text"]},
        "limit": {"context": context, "output": output},
    }


def build_registry(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Worker model blocks keyed by alias, for every row with the bench purpose."""
    return {
        str(row["id"]): model_block(row)
        for row in rows
        if isinstance(row, dict) and row.get("purpose") == BENCH_PURPOSE and row.get("id")
    }


@lru_cache(maxsize=1)
def worker_model_registry() -> dict[str, dict[str, Any]]:
    """The local worker models this process may run, keyed by proxy alias."""
    return build_registry(fetch_proxy_models())
