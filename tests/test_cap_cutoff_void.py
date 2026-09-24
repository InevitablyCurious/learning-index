"""WO-CUTOFF Part B: a cap cut-off is SCORED; a provider truncation VOIDS.

A cell whose turns ran into the output cap and were nudged back is a
measurement of model behaviour — the model generated 32k tokens and the
harness asked it to continue. Non-green, it is an honest capability FAIL,
never VOID-INSTRUMENT. A genuine provider truncation (a stream that stopped
short BELOW the cap) is the instrument's failure and still voids, with the
reason naming the provider.

FAIL-BEFORE (git HEAD, pre-WO-CUTOFF): the scorecard's truncation clause
read ``length_truncations`` — a field that counted EVERY ``length`` finish,
cap cut-offs included — and knew nothing of ``provider_truncations``.

- ``test_provider_truncation_cell_is_void_instrument`` FAILS against HEAD:
  a record carrying ``provider_truncations=1`` (and no ``length_truncations``)
  hits no clause there and is scored instead of voided.
- ``test_cap_cutoff_only_cell_is_scored_never_void_instrument`` passes
  against HEAD's ``build_scorecard`` GIVEN the new record shape (HEAD simply
  ignores ``cap_cutoffs``); its fail-before force is the CHAIN: pre-change,
  this same cell arrived as ``length_truncations>0`` (the extractor counted
  length@cap as a truncation) — and an un-nudged cap anomaly counted as
  unrecovered — so the cell WAS voided. The new record shape is only
  producible by the new code, and this pins what the scorecard owes it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from harness.cumulative.run_artifacts import (
    RunManifest,
    StatusStream,
    build_scorecard,
    default_run_manifest_path,
    default_status_stream_path,
    write_run_manifest,
)


def _manifest(tmp_path: Path) -> Path:
    """The write-once run-manifest sibling build_scorecard requires."""
    manifest_path = tmp_path / "manifest.json"
    write_run_manifest(
        default_run_manifest_path(manifest_path),
        RunManifest(
            run_id="run-cap-void",
            created_at="2026-09-24T00:00:00Z",
            served_model=None,
            requested_model="model-a",
            memory_mode="on",
            org_id="org-1",
        ),
    )
    return manifest_path


def _attempt(
    stream: StatusStream, *, full_green: bool, **truncation_fields: Any
) -> None:
    """One terminal attempt record; the truncation/void fields under test are
    passed in by the caller (the progress block mirrors the wiring-test
    fixture shape)."""
    record: dict[str, Any] = {
        "type": "attempt",
        "schema_version": 1,
        "sequence_index": 0,
        "memory_mode": "on",
        "org_id": "org-1",
        "progress": {
            "problems_before": 3,
            "problems_after": 1 if full_green else 2,
            "resolved_count": 2 if full_green else 1,
            "remaining_count": 1,
            "full_green": full_green,
            "attempts_to_green": 1,
            "turns": 2,
            "total_tokens": 1000,
            "wall_seconds": 1.0,
            "wall_cost_usd": 0.0,
        },
        "session_fp": "fp-0",
        "session_id": "s-0",
    }
    record.update(truncation_fields)
    stream.append(record)


def test_cap_cutoff_only_cell_is_scored_never_void_instrument(
    tmp_path: Path,
) -> None:
    manifest_path = _manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))

    # The shape a nudged cap-cut-off cell now writes: cut-offs counted, both
    # recovered by nudge, ZERO provider truncations, ZERO unrecovered
    # anomalies. Non-green because the model's work failed the gates — an
    # honest capability FAIL, and the cap cut-offs are model behaviour, not
    # an instrument fault.
    _attempt(
        stream,
        full_green=False,
        terminal_reason="attempt_ceiling_reached",
        cap_cutoffs=2,
        cap_cutoffs_nudged=2,
        provider_truncations=0,
        truncated_turns=2,
        truncated_turns_retried=2,
        unrecovered_anomaly_turns=0,
        observation_lost_turns=0,
    )

    scorecard = build_scorecard(manifest_path)

    # SCORED — not voided, not delivery-excluded.
    assert scorecard["void_instrument"] == []
    assert scorecard["not_scored"] == []
    assert scorecard["scored_sessions"] == 1
    assert scorecard["scored_pass"] == 0
    assert scorecard["scored_fail"] == 1
    assert scorecard["convergence"]["sessions_completed"] == 1


def test_provider_truncation_cell_is_void_instrument(tmp_path: Path) -> None:
    manifest_path = _manifest(tmp_path)
    stream = StatusStream(default_status_stream_path(manifest_path))

    # A genuine provider truncation (a stream that stopped short BELOW the
    # cap): the instrument failed, so the cell is voided — and the reason
    # names the provider, never the cap. No other void clause applies
    # (neutral terminal_reason, no unrecovered anomalies, no lost
    # observation), so this isolates the provider_truncations>0 leg.
    _attempt(
        stream,
        full_green=False,
        terminal_reason="attempt_ceiling_reached",
        provider_truncations=1,
        cap_cutoffs=0,
    )

    scorecard = build_scorecard(manifest_path)

    assert scorecard["void_instrument"] == [
        {
            "sequence_index": 0,
            "memory_mode": "on",
            "void_reason": "provider_truncation",
        }
    ]
    # EXCLUDED from the scored set entirely.
    assert scorecard["scored_sessions"] == 0
    assert scorecard["scored_pass"] == 0
    assert scorecard["scored_fail"] == 0
    assert scorecard["convergence"]["sessions_completed"] == 0
    assert scorecard["not_scored"] == []
