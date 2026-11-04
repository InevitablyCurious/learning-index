"""CONTEXT BUDGET — the token line a session compacts at, and the one error
that still ends a cell.

WHY THIS EXISTS (runs 1789474325, 1789536879, 1789580246). Repair rounds run
in ONE session, and its context only grows. opencode compacts on its own when
the context reaches its limit, so three of four Learning-Index runs had their
repair rounds summarised mid-round — silently, by a mechanism the benchmark
never chose. The old benchmark only kept repair rounds uncompacted because its
runs stayed 11–48k tokens under the line; nothing enforced it.

WHAT A FULL CONTEXT MEANS NOW. Automatic compaction is ON, and the harness
drives its own compaction at the boundaries it chooses through
``/session/{id}/summarize``. So reaching the token threshold is NOT an ending
of its own: the context gets compacted — by opencode, or by the harness at a
chunk boundary — and the session continues.

THE ONE GENUINE ENDING IS ``ContextOverflowError``: the request was too large
to compact at all, so there is nothing left to continue with. That alone ends
the cell (``context_exhausted``).

THE LIMIT IS STILL OPENCODE'S OWN. opencode compacts when a finished turn's
tokens reach ``context - min(output limit, output cap)``, with the cap 32,000
unless OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX sets it. Measured on run
1789580246 (context 262,144, output 32,768): a turn at 229,535 did not compact,
the next at 230,340 did — 230,144 sits between them. :func:`context_limit_tokens`
still reports that line (it is recorded on the run's stats and shown to the
operator); it no longer gates a turn.
"""

from __future__ import annotations

from typing import Any

from harness.config import CLOUD_ORCAROUTER_PROVIDER
from harness.model_catalog import worker_model_registry

CONTEXT_EXHAUSTED = "context_exhausted"
CONTEXT_OVERFLOW_ERROR_NAME = "ContextOverflowError"
OPENCODE_OUTPUT_TOKEN_CAP = 32_000


def output_cap(output_token_max: int | None = None) -> int:
    """The effective per-response output cap for this run.

    ``RunConfig.max_output_tokens`` is inert in production (None → the Docker
    env ``OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`` is never set) and opencode
    then applies its own built-in default, modeled here as
    ``OPENCODE_OUTPUT_TOKEN_CAP``.
    """
    if output_token_max is None:
        return OPENCODE_OUTPUT_TOKEN_CAP
    cap = int(output_token_max)
    if cap <= 0:
        raise ValueError(f"output token cap must be positive, got {output_token_max!r}")
    return cap


def model_limits(model: str) -> dict[str, int]:
    """The context and output limits the worker's opencode.json declares."""
    provider_id, _, model_id = str(model).partition("/")
    if provider_id == "local-llm-proxy":
        entry = worker_model_registry().get(model_id)
    else:
        entry = CLOUD_ORCAROUTER_PROVIDER.get("models", {}).get(model)
        if entry is None:
            entry = CLOUD_ORCAROUTER_PROVIDER.get("models", {}).get(model_id)
    limit = (entry or {}).get("limit") or {}
    context, output = limit.get("context"), limit.get("output")
    if not isinstance(context, int) or not isinstance(output, int) or context <= 0:
        # No silent fallback: a cell whose limit is unknown cannot tell when it
        # is out of room, and would drift back to unenforced compaction.
        raise ValueError(f"no context/output limit declared for model {model!r}")
    return {"context": context, "output": output}


def context_limit_tokens(model: str, *, output_token_max: int | None = None) -> int:
    """The token count at which this model's session is out of room."""
    limits = model_limits(model)
    cap = output_cap(output_token_max)
    return limits["context"] - min(limits["output"], cap)


def _info(message: Any) -> dict[str, Any]:
    if not isinstance(message, dict):
        return {}
    info = message.get("info")
    return info if isinstance(info, dict) else message


def message_context_tokens(message: Any) -> int:
    """Tokens a finished assistant message occupied, counted as opencode does."""
    tokens = _info(message).get("tokens")
    if not isinstance(tokens, dict):
        return 0
    total = tokens.get("total")
    if isinstance(total, int) and total > 0:
        return total
    cache = tokens.get("cache") if isinstance(tokens.get("cache"), dict) else {}
    return sum(
        int(v or 0)
        for v in (
            tokens.get("input"),
            tokens.get("output"),
            cache.get("read"),
            cache.get("write"),
        )
    )


def max_context_tokens(messages: list[Any]) -> int | None:
    """The largest context an assistant message occupied, counted as opencode
    counts it (:func:`message_context_tokens`: prompt + output — the size the
    out-of-room check compares and opencode's own TUI shows). None when no
    message reported tokens (absent, never 0); an aborted turn reports none.
    """
    sizes = [
        message_context_tokens(m)
        for m in messages or []
        if _info(m).get("role") == "assistant"
    ]
    return max((s for s in sizes if s > 0), default=None)


def latest_context_tokens(messages: list[Any]) -> int:
    """The newest assistant message's size; 0 when none has reported tokens."""
    for message in reversed(messages or []):
        info = _info(message)
        if info.get("role") != "assistant":
            continue
        size = message_context_tokens(message)
        if size > 0:
            return size
    return 0


def has_context_overflow(messages: list[Any]) -> bool:
    """True when any assistant message in ``messages`` hit ContextOverflowError."""
    for message in messages or []:
        error = _info(message).get("error")
        if isinstance(error, dict) and error.get("name") == CONTEXT_OVERFLOW_ERROR_NAME:
            return True
    return False


def context_exhausted(
    messages: list[Any], limit_tokens: int | None = None
) -> tuple[bool, int]:
    """(overflowed, newest size): True only on a genuine ContextOverflowError.

    ``limit_tokens`` is no longer consulted: with auto-compaction on, hitting
    the token threshold is not an ending of its own — opencode compacts and the
    session continues. The one genuine residual is ContextOverflowError (the
    conversation is too large to compact at all), which alone still ends the
    cell.
    """
    size = latest_context_tokens(messages)
    return has_context_overflow(messages), size
