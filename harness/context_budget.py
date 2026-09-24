"""CONTEXT EXHAUSTED — the point a session has no room left to keep working.

WHY THIS EXISTS (runs 1789474325, 1789536879, 1789580246). Repair rounds run
in ONE session, and its context only grows. opencode compacts on its own when
the context reaches its limit, so three of four Learning-Index runs had their
repair rounds summarised mid-round — silently, by a mechanism the benchmark
never chose. The rule has always been that repair never compacts (bench's
phase sentinel); the old benchmark only kept it because its runs stayed
11–48k tokens under the line. Nothing enforced it.

Now it is enforced: the worker's opencode.json turns opencode's automatic
compaction off (the plugin's own build-boundary compaction goes through
`/summarize`, which that setting does not touch — verified in bench-worker:v1),
and reaching the limit ENDS THE CELL as ``context_exhausted``.

THE LIMIT IS OPENCODE'S OWN. opencode compacts when a finished turn's tokens
reach ``context - min(output limit, output cap)``, with the cap 32,000 unless
OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX sets it. Measured on run 1789580246
(context 262,144, output 32,768): a turn at 229,535 did not compact, the next
at 230,340 did — 230,144 sits between them. Using the same line means a cell is
called exhausted exactly where opencode would otherwise have summarised it.

TWO SIGNALS, EITHER IS ENOUGH:
  - the newest assistant message's tokens reach the limit;
  - an assistant message carries ``ContextOverflowError`` (the request itself
    went over; with automatic compaction off opencode records this and goes
    idle instead of compacting — verified in bench-worker:v1).
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
        for v in (tokens.get("input"), tokens.get("output"), cache.get("read"), cache.get("write"))
    )


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


def context_exhausted(messages: list[Any], limit_tokens: int | None) -> tuple[bool, int]:
    """(exhausted, newest size) for a message list against a limit."""
    size = latest_context_tokens(messages)
    if has_context_overflow(messages):
        return True, size
    return (limit_tokens is not None and size >= limit_tokens), size
