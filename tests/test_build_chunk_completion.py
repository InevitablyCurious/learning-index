"""WO-CHUNKVIS-1 — build-chunk completion rows.

The rows must distinguish a chunk that DIED from one that NEVER RAN. Flattening
both into "incomplete" makes an operator read "4, 5 and 6 are broken" when the
truth is "4 broke, and 5 and 6 never started because of it".

WO-MARKER-RIP (2026-09-09): `complete` is the TRANSPORT's verdict — the drive
reached idle with exit code 0 — not the model's. It used to mean "the model
printed CHUNK FINISHED", a self-report a model could give having written
nothing and withhold having written everything.
"""

from pathlib import Path

from bench.adapters.backgammon import build_chunk_completion, count_stub_sentinels


# The live 2026-08-26 build: chunks 1-3 ran clean, chunk 4 hung on a tool call
# and died `run_timeout`, chunks 5-6 never got a turn.
INCIDENT = [
    {"chunk": 1, "exit_code": 0, "recovery_nudges": 0},
    {"chunk": 2, "exit_code": 0, "recovery_nudges": 1},
    {"chunk": 3, "exit_code": 0, "recovery_nudges": 0},
    {
        "chunk": 4,
        "exit_code": 1,
        "recovery_nudges": 0,
        "killed_reason": "run_timeout",
    },
]


def test_three_states_are_distinguished() -> None:
    rows = build_chunk_completion(chunk_reports=INCIDENT, expected=6)

    assert [r["state"] for r in rows] == [
        "complete",
        "complete",
        "complete",
        "died",
        "not_reached",
        "not_reached",
    ]
    # The culprit is NAMED, not reduced to "exit_code=1".
    assert rows[3]["reason"] == "run_timeout"
    # A chunk that never ran carries no reason — it did not fail, it never went.
    assert rows[4]["reason"] is None


def test_nudges_column_carries_recovery_pressure() -> None:
    """The count is UPSTREAM RECOVERIES, the only re-drives that still exist.

    It used to count marker nudges — re-drives asking the model to print a
    string. Those are gone, so the column reports the number of times the
    harness re-drove the chunk after a relay terminal.
    """
    rows = build_chunk_completion(chunk_reports=INCIDENT, expected=6)
    assert [r["nudges"] for r in rows] == [0, 1, 0, 0, 0, 0]


def test_reason_falls_back_to_exit_code_when_unnamed() -> None:
    rows = build_chunk_completion(
        chunk_reports=[{"chunk": 1, "exit_code": 3}], expected=1
    )
    assert rows[0]["reason"] == "exit_code=3"


def test_a_clean_exit_is_complete_whatever_the_model_wrote() -> None:
    """Exit 0 IS completion. There is no second condition to satisfy."""
    rows = build_chunk_completion(
        chunk_reports=[{"chunk": 1, "exit_code": 0}], expected=1
    )
    assert rows[0]["state"] == "complete"
    assert rows[0]["reason"] is None


def test_a_report_with_no_exit_code_reads_as_complete() -> None:
    """A report the driver never stamped an exit code onto ran to idle.

    `exit_code` is written into the report immediately after the drive returns,
    so its absence means the drive did not fail — not that its outcome is
    unknown.
    """
    rows = build_chunk_completion(chunk_reports=[{"chunk": 1}], expected=1)
    assert rows[0]["state"] == "complete"


def test_empty_reports_are_all_not_reached_never_complete() -> None:
    rows = build_chunk_completion(chunk_reports=[], expected=6)
    assert {r["state"] for r in rows} == {"not_reached"}


def test_stub_counts_expose_a_completed_but_unbuilt_chunk(tmp_path: Path) -> None:
    """A clean drive is not proof of work. The file it owns is what says so."""
    (tmp_path / "src").mkdir()
    # chunk 3 owns src/ai.ts; leave it at its full scaffold stub count.
    (tmp_path / "src" / "ai.ts").write_text(
        'throw new Error("not implemented")\n' * 5, encoding="utf-8"
    )
    (tmp_path / "src" / "game.ts").write_text(
        "// fully implemented\n", encoding="utf-8"
    )

    rows = build_chunk_completion(
        chunk_reports=[
            {"chunk": 2, "exit_code": 0},
            {"chunk": 3, "exit_code": 0},
        ],
        expected=3,
        worktree=tmp_path,
    )

    game = next(r for r in rows if r["chunk"] == 2)
    ai = next(r for r in rows if r["chunk"] == 3)
    assert game["stubs_remaining"] == 0  # ran clean and actually built
    assert ai["state"] == "complete" and ai["stubs_remaining"] == 5  # ran, NOT built


def test_rows_carry_no_marker_field(tmp_path: Path) -> None:
    """The self-report is gone from the surface, not merely ignored on it."""
    rows = build_chunk_completion(
        chunk_reports=[{"chunk": 1, "exit_code": 0}], expected=2
    )
    assert all("marker" not in row for row in rows)


def test_chunks_without_a_stub_file_report_none(tmp_path: Path) -> None:
    """Chunks 1, 5, 6 own no stub file — absent must not read as zero."""
    rows = build_chunk_completion(
        chunk_reports=[{"chunk": 1, "exit_code": 0}], expected=6, worktree=tmp_path
    )
    assert rows[0]["stub_file"] is None
    assert rows[0]["stubs_remaining"] is None


def test_count_stub_sentinels_on_missing_file_is_none_not_zero(tmp_path: Path) -> None:
    """Unreadable is not 'fully implemented'."""
    assert count_stub_sentinels(tmp_path / "nope.ts") is None
