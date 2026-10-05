from __future__ import annotations

from harness.cumulative.manifest import (
    CumulativeManifest,
    resume_or_create,
    roster_hash,
)
from harness.cumulative.ordering import build_schedule
from harness.cumulative.run_context import compare_run_context
from harness.cumulative.types import RosterEntry


def _roster() -> list[RosterEntry]:
    return [
        RosterEntry(
            model="openrouter/model-a",
            role="assistant",
            provider_pin="openrouter",
            config_identity={"slot": 1},
        )
    ]


def _schedule(roster: list[RosterEntry]):
    computed = roster_hash(roster)
    return build_schedule(roster, seed=17, roster_hash=computed, on_budget=1)


def test_manifest_round_trip_with_and_without_run_context() -> None:
    roster = _roster()
    schedule = _schedule(roster)
    context = {
        "status": "available",
        "levers": {
            "L1_relevance_floor": {"value": "0.55", "source": "documented-default"}
        },
    }
    manifest = CumulativeManifest(
        created_at="2026-07-30T01:00:00Z",
        task="backgammon",
        org_id="org-test",
        roster=roster,
        roster_hash=roster_hash(roster),
        seed=17,
        config_fingerprint="cfg",
        schedule=schedule,
        session_records=[],
        current_index=0,
        updated_at="2026-07-30T01:00:00Z",
        run_context=context,
    )

    assert CumulativeManifest.from_dict(manifest.to_dict()).run_context == context

    payload_without_context = manifest.to_dict()
    payload_without_context.pop("run_context")
    assert CumulativeManifest.from_dict(payload_without_context).run_context is None


def test_resume_keeps_original_run_context(tmp_path) -> None:
    roster = _roster()
    schedule = _schedule(roster)
    path = tmp_path / "manifest.json"
    first_context = {
        "status": "available",
        "levers": {"L8_RETRIEVAL_TEMPERATURE": {"value": "0.7", "source": "bench-env"}},
    }
    second_context = {
        "status": "available",
        "levers": {"L8_RETRIEVAL_TEMPERATURE": {"value": "0.9", "source": "bench-env"}},
    }

    created = resume_or_create(
        path,
        roster=roster,
        seed=17,
        task="backgammon",
        org_id="org-test",
        config_fingerprint="cfg",
        schedule=schedule,
        run_context=first_context,
    )
    resumed = resume_or_create(
        path,
        roster=roster,
        seed=17,
        task="backgammon",
        org_id="org-test",
        config_fingerprint="cfg",
        schedule=schedule,
        run_context=second_context,
    )

    assert created.run_context == first_context
    assert resumed.run_context == first_context


def test_compare_run_context_flags_changed_lever() -> None:
    recorded = {
        "status": "available",
        "levers": {"L8_RETRIEVAL_TEMPERATURE": {"value": "0.7", "source": "bench-env"}},
    }
    current = {
        "status": "available",
        "levers": {"L8_RETRIEVAL_TEMPERATURE": {"value": "0.9", "source": "bench-env"}},
    }

    assert compare_run_context(recorded, current) == ["levers.L8_RETRIEVAL_TEMPERATURE"]
