"""Deterministic schedule ordering for cumulative benchmark sessions."""

from __future__ import annotations

import hashlib
import random
from collections.abc import Sequence

from .types import PhaseGroup, RosterEntry, ScheduledSession


def _require_non_empty_roster(roster: list[RosterEntry]) -> None:
    if not roster:
        raise ValueError("roster must not be empty")


def _require_non_negative_budget(*, budget: int, field_name: str) -> None:
    if budget < 0:
        raise ValueError(f"{field_name} must be non-negative")


def _seeded_rng(*, seed: int, roster_hash: str) -> random.Random:
    seed_int = int.from_bytes(
        hashlib.sha256(f"{seed}:{roster_hash}".encode()).digest()[:8],
        "big",
    )
    return random.Random(seed_int)


def build_off_order(
    roster: list[RosterEntry], *, replicates: int = 1
) -> list[ScheduledSession]:
    """Build the declared-roster OFF baseline schedule in roster order.

    REPLICATES ARE THE SAME CELL, NOT DIFFERENT SESSIONS. A baseline is the
    MEDIAN of N runs of one configuration, because a single run was never a
    baseline — measured on this task, identical prompts and identical model
    produced 23, 25 and 62 problems. So one roster entry yields N scheduled
    sessions that differ only by sequence index: same model, same arm, same
    everything the fingerprint covers.

    Without this the control plane could allocate indices 0..N-1 while the
    schedule held exactly one session, and every cell after the first died on
    `sequence_index N out of range` seconds after launch.

    Replicates are contiguous per roster entry, so a roster of two models at
    N=3 is [m0, m0, m0, m1, m1, m1]. `sequence_index` stays the position in
    the schedule, which is what `session_records[i].sequence_index == i`
    (relied on by explicit-index mode) requires.
    """
    _require_non_empty_roster(roster)
    if not isinstance(replicates, int) or isinstance(replicates, bool) or replicates < 1:
        raise ValueError(f"replicates must be a positive integer, got {replicates!r}")
    sessions: list[ScheduledSession] = []
    for roster_index, entry in enumerate(roster):
        for _ in range(replicates):
            sessions.append(
                ScheduledSession(
                    sequence_index=len(sessions),
                    model=entry.model,
                    provider_pin=entry.provider_pin,
                    memory_mode="off",
                    phase_group=PhaseGroup.OFF_BASELINE.value,
                    roster_index=roster_index,
                )
            )
    return sessions


def build_on_order(
    roster: list[RosterEntry],
    *,
    seed: int,
    roster_hash: str,
    budget: int,
    start_index: int,
    explicit_order: Sequence[str] | None = None,
) -> list[ScheduledSession]:
    """Build a deterministic ON schedule with possible model repetition."""
    _require_non_empty_roster(roster)
    _require_non_negative_budget(budget=budget, field_name="budget")

    if explicit_order is not None:
        roster_indices_by_model = {
            entry.model: index for index, entry in enumerate(roster)
        }
        valid_models = [entry.model for entry in roster]
        sessions: list[ScheduledSession] = []
        for slot, model in enumerate(explicit_order):
            model_name = str(model)
            if model_name not in roster_indices_by_model:
                raise ValueError(
                    f"explicit_order model {model_name!r} is not in roster; "
                    f"valid roster models: {valid_models}"
                )
            roster_index = roster_indices_by_model[model_name]
            entry = roster[roster_index]
            sessions.append(
                ScheduledSession(
                    sequence_index=start_index + slot,
                    model=entry.model,
                    provider_pin=entry.provider_pin,
                    memory_mode="on",
                    phase_group=PhaseGroup.ON.value,
                    roster_index=roster_index,
                )
            )
        return sessions

    rng = _seeded_rng(seed=seed, roster_hash=roster_hash)
    sessions: list[ScheduledSession] = []
    roster_size = len(roster)
    for slot in range(budget):
        roster_index = rng.randrange(roster_size)
        entry = roster[roster_index]
        sessions.append(
            ScheduledSession(
                sequence_index=start_index + slot,
                model=entry.model,
                provider_pin=entry.provider_pin,
                memory_mode="on",
                phase_group=PhaseGroup.ON.value,
                roster_index=roster_index,
            )
        )
    return sessions


def build_schedule(
    roster: list[RosterEntry],
    *,
    seed: int,
    roster_hash: str,
    on_budget: int,
    off_replicates: int = 1,
) -> list[ScheduledSession]:
    """Build cumulative schedule: full OFF baseline then seeded ON phase.

    ``off_replicates`` applies to the OFF baseline ONLY. An OFF floor is the
    median of N runs; an ON cell is a single measurement taken against that
    floor, every time. Replicating the ON arm would be averaging away the
    thing the benchmark exists to observe.
    """
    _require_non_empty_roster(roster)
    _require_non_negative_budget(budget=on_budget, field_name="on_budget")

    off_order = build_off_order(roster, replicates=off_replicates)
    on_order = build_on_order(
        roster,
        seed=seed,
        roster_hash=roster_hash,
        budget=on_budget,
        start_index=len(off_order),
    )
    return off_order + on_order


__all__ = ["build_off_order", "build_on_order", "build_schedule"]
