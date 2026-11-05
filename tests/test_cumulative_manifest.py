from dataclasses import replace

import pytest

from harness.cumulative.manifest import (
    CumulativeManifest,
    atomic_write,
    load,
    resume_or_create,
    roster_hash,
    validate_or_fail,
)
from harness.cumulative.ordering import append_session
from harness.cumulative.types import RosterEntry, SessionRecord


def _sample_roster() -> list[RosterEntry]:
    return [
        RosterEntry(
            model="model-alpha",
            role="assistant",
            provider_pin="provider-a",
            config_identity={"tier": "baseline", "slot": 1},
        ),
        RosterEntry(
            model="model-beta",
            role="assistant",
            provider_pin="provider-b",
            config_identity={"tier": "candidate", "slot": 2},
        ),
        RosterEntry(
            model="model-gamma",
            role="assistant",
            provider_pin="provider-c",
            config_identity={"tier": "candidate", "slot": 3},
        ),
    ]


def _sample_manifest() -> CumulativeManifest:
    roster = _sample_roster()
    computed_roster_hash = roster_hash(roster)
    schedule = []
    for arm in ("off", "on"):
        schedule.append(append_session(roster, existing=schedule, memory_mode=arm))
    records = [
        SessionRecord(
            sequence_index=entry.sequence_index,
            model=entry.model,
            provider_pin=entry.provider_pin,
            memory_mode=entry.memory_mode,
            phase_group=entry.phase_group,
            phase="DONE",
            org_id="org-test",
        )
        for entry in schedule
    ]

    return CumulativeManifest(
        created_at="2026-07-23T12:00:00Z",
        task="backgammon",
        org_id="org-test",
        roster=roster,
        roster_hash=computed_roster_hash,
        config_fingerprint="cfg-12345",
        schedule=schedule,
        session_records=records,
        updated_at="2026-07-23T12:30:00Z",
    )


def test_roster_hash_is_deterministic_and_order_sensitive() -> None:
    roster = _sample_roster()

    first = roster_hash(roster)
    second = roster_hash(roster)
    reordered = roster_hash(list(reversed(roster)))

    assert first == second
    assert first != reordered


def test_cumulative_manifest_dict_round_trip() -> None:
    manifest = _sample_manifest()

    reconstructed = CumulativeManifest.from_dict(manifest.to_dict())

    assert reconstructed == manifest


def test_atomic_write_then_load_round_trip(tmp_path) -> None:
    manifest = _sample_manifest()
    manifest_path = tmp_path / "manifest.json"

    atomic_write(manifest_path, manifest)
    loaded_manifest = load(manifest_path)

    assert loaded_manifest == manifest


def test_validate_or_fail_accepts_match_and_rejects_each_drift() -> None:
    manifest = _sample_manifest()

    validate_or_fail(
        manifest,
        expected_roster=manifest.roster,
        expected_task=manifest.task,
    )

    with pytest.raises(ValueError, match="schema mismatch"):
        validate_or_fail(
            replace(manifest, schema_version=manifest.schema_version + 1),
            expected_roster=manifest.roster,
            expected_task=manifest.task,
        )

    with pytest.raises(ValueError, match="roster hash drift"):
        validate_or_fail(
            manifest,
            expected_roster=list(reversed(manifest.roster)),
            expected_task=manifest.task,
        )

    with pytest.raises(ValueError, match="task drift"):
        validate_or_fail(
            manifest,
            expected_roster=manifest.roster,
            expected_task=f"{manifest.task}-other",
        )

    with pytest.raises(ValueError, match="chunk-plan hash drift"):
        validate_or_fail(
            replace(manifest, chunk_plan_hash="stale-hash"),
            expected_roster=manifest.roster,
            expected_task=manifest.task,
            expected_chunk_plan_hash="fresh-hash",
        )

    # A manifest written before the chunk-plan field existed loads with an
    # empty hash and then fails drift validation loudly (never silently
    # resumes against a chunked prompt plan).
    legacy = CumulativeManifest.from_dict(
        {k: v for k, v in manifest.to_dict().items() if k != "chunk_plan_hash"}
    )
    assert legacy.chunk_plan_hash == ""
    with pytest.raises(ValueError, match="chunk-plan hash drift"):
        validate_or_fail(
            legacy,
            expected_roster=legacy.roster,
            expected_task=legacy.task,
            expected_chunk_plan_hash="fresh-hash",
        )


def test_a_manifest_carrying_retired_keys_still_loads() -> None:
    """No migration is written: a cursor and a seed are simply dropped.

    Both belonged to the precomputed-schedule design (a plan needed a seed, a
    cursor selected from it), and neither is read any more. Asserting the drop
    here is what makes "delete the fields" safe for manifests on disk.
    """
    payload = _sample_manifest().to_dict()
    payload["seed"] = 12345
    payload["current_index"] = 2

    loaded = CumulativeManifest.from_dict(payload)

    assert not hasattr(loaded, "seed")
    assert not hasattr(loaded, "current_index")
    assert loaded.schedule == _sample_manifest().schedule
    assert "seed" not in loaded.to_dict()
    assert "current_index" not in loaded.to_dict()


def test_resume_or_create_creates_an_empty_log_then_resumes_without_clobber(
    tmp_path,
) -> None:
    manifest_path = tmp_path / "manifest.json"
    roster = _sample_roster()
    task = "backgammon"
    org_id = "org-resume"
    config_fingerprint = "cfg-resume"

    created = resume_or_create(
        manifest_path,
        roster=roster,
        task=task,
        org_id=org_id,
        config_fingerprint=config_fingerprint,
    )

    assert manifest_path.exists()
    # Nothing is planned at creation: the log starts empty and the first click
    # appends into it, so the append ordinal starts at len([]) == 0.
    assert created.schedule == []
    assert created.session_records == []

    appended = append_session(roster, existing=created.schedule, memory_mode="off")
    created.schedule.append(appended)
    created.session_records.append(
        SessionRecord(
            sequence_index=appended.sequence_index,
            model=appended.model,
            provider_pin=appended.provider_pin,
            memory_mode=appended.memory_mode,
            phase_group=appended.phase_group,
            phase="DONE",
            org_id=org_id,
        )
    )
    created.updated_at = "2026-07-23T13:00:00Z"
    atomic_write(manifest_path, created)

    resumed = resume_or_create(
        manifest_path,
        roster=roster,
        task=task,
        org_id=org_id,
        config_fingerprint=config_fingerprint,
    )

    assert resumed == created
    # The append ordinal is the log's length — never a stored cursor.
    assert resumed.session_records[-1].sequence_index == len(resumed.schedule) - 1
    assert load(manifest_path) == created

    with pytest.raises(ValueError, match="roster hash drift"):
        resume_or_create(
            manifest_path,
            roster=list(reversed(roster)),
            task=task,
            org_id=org_id,
            config_fingerprint=config_fingerprint,
        )
