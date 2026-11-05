"""Append-per-click session ordering for cumulative benchmark runs.

ONE CLICK APPENDS ONE CELL. Nothing is precomputed: there is no seeded ON
order, no OFF budget, no cursor. A run's identity is its own cell — arm, model,
config fingerprint — not a position in a schedule someone planned before the
work existed.

That is a correction, not a simplification. A precomputed schedule had to be
rebuilt on every launch (the OFF prefix, then the seeded ON band), so the plan
was a function of the OPERATOR'S LAUNCH ARGUMENTS rather than of what the
campaign had recorded, and a control-plane restart re-seeded a cursor into the
past — handing out indices that had already run. Appending cannot drift that
way: the next cell's index is the length of the log that already exists.

``sequence_index`` stays a monotonic contiguous 0-based counter (the append
ordinal). It is the cell's address everywhere — ``cell-<seq4>`` directories,
the status stream, the results ledger — so it must never be anything else.
"""

from __future__ import annotations

from collections.abc import Sequence

from .types import PhaseGroup, RosterEntry, ScheduledSession

MEMORY_MODES: tuple[str, ...] = ("off", "on")


def _require_non_empty_roster(roster: list[RosterEntry]) -> None:
    if not roster:
        raise ValueError("roster must not be empty")


def append_session(
    roster: list[RosterEntry],
    *,
    existing: Sequence[ScheduledSession],
    memory_mode: str,
) -> ScheduledSession:
    """Return the ONE session this click appends to the campaign's log.

    One manifest carries one model (``--model`` replaces the whole roster and
    ``roster_hash`` guards resume), so the appended cell takes ``roster[0]``'s
    model and provider pin. The pin is the roster entry's, never inferred from
    the model slug, so the cell records the provider the campaign was pinned to.

    The arm is the operator's choice at click time: an OFF cell is a point of
    the baseline floor, an ON cell is one measurement against it. Neither arm
    replicates here — N of a configuration is N clicks, and the log records each
    one as its own cell.
    """
    _require_non_empty_roster(roster)
    mode = str(memory_mode or "").strip().lower()
    if mode not in MEMORY_MODES:
        raise ValueError(
            f"memory_mode must be one of {MEMORY_MODES}, got {memory_mode!r}"
        )

    entry = roster[0]
    return ScheduledSession(
        sequence_index=len(existing),
        model=entry.model,
        provider_pin=entry.provider_pin,
        memory_mode=mode,
        phase_group=(
            PhaseGroup.OFF_BASELINE.value if mode == "off" else PhaseGroup.ON.value
        ),
        roster_index=0,
    )


__all__ = ["append_session"]
