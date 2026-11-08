"""Per-turn token arithmetic for the live stream (WO-LIVE-02).

Pure functions only -- no IO, no clock, no client -- so the ``turn.tokens``
contract the dashboard draws can be pinned by unit tests without a serve.

THE TWO NUMBERS MEAN DIFFERENT THINGS. ``serve_client.metrics()`` is
session-CUMULATIVE for the whole session (``input_tokens`` a max, the other
three sums; see :mod:`harness.serve_transport`). The live bar needs the spend
this turn actually added, which is the delta against the previous completed
turn of the SAME session -- normally the delta since the previous turn's snapshot.
"""

from __future__ import annotations

from typing import Any

#: The token categories, in the canonical order every ``turn.tokens`` record
#: writes them. ``total`` is always the sum of exactly these five.
TOKEN_FIELDS: tuple[str, ...] = (
    "input",
    "output",
    "reasoning",
    "cache_read",
    "cache_write",
)

#: Category -> the ``serve_client.metrics()`` key it is read from.
METRIC_KEYS: dict[str, str] = {field: f"{field}_tokens" for field in TOKEN_FIELDS}


def _as_int(value: Any) -> int:
    """Token counts are ints; a missing/None field is 0, never a guess."""
    return int(value or 0)


def has_token_data(metrics: dict | None) -> bool:
    """Whether ``metrics`` actually observed token counts.

    A dict that carries none of the five token keys as a non-None value is an
    unobservable read, not a zero-spend turn: the caller must emit NOTHING
    rather than fabricate a zero bar.
    """
    if not isinstance(metrics, dict):
        return False
    return any(metrics.get(key) is not None for key in METRIC_KEYS.values())


def metrics_to_cumulative(metrics: dict | None) -> dict:
    """Map a ``serve_client.metrics()`` dict onto the five categories + total."""
    if not isinstance(metrics, dict):
        metrics = {}
    out = {field: _as_int(metrics.get(METRIC_KEYS[field])) for field in TOKEN_FIELDS}
    out["total"] = sum(out[field] for field in TOKEN_FIELDS)
    return out


def compute_delta(prev: dict | None, cur: dict) -> dict:
    """Per-field ``cur - prev`` clamped at >= 0, plus the sum of the clamps.

    A negative delta is physically meaningless for a spend bill. It means the
    counter went BACKWARDS -- in practice a serve-side reset after a
    compaction -- and the honest reading is "nothing new to bill", not a
    negative bar. ``prev is None`` (the session's first turn) makes the delta
    the cumulative reading itself.
    """
    prev = prev if isinstance(prev, dict) else {}
    out: dict[str, int] = {}
    for field in TOKEN_FIELDS:
        delta = _as_int(cur.get(field)) - _as_int(prev.get(field))
        out[field] = max(0, delta)
    out["total"] = sum(out[field] for field in TOKEN_FIELDS)
    return out
