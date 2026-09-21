"""Chunked-build serve-drive tests (WO-LI18 split).

Six-chunk ordering and delta metering, one sidecar entry per chunk,
compaction-off behaviour, zero-delta loudness, and the prompt-corpus guards
(write-chunking directive present, completion marker absent).
Shared fakes: tests/_serve_drive_fakes.py.
"""

from __future__ import annotations

import json
from pathlib import Path

from tests._serve_drive_fakes import (
    _ZERO_METRICS,
    TASK_DIR,
    _FakeCell,
    _FakeServeClient,
    _make_runner,
    _metrics,
)


def test_chunked_pass_sends_all_chunks_in_order_and_meters_deltas(
    tmp_path: Path,
) -> None:
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    # Per chunk: baseline (pre-send) then end-of-phase metrics. Baseline for
    # chunk 2 is the cumulative after chunk 1 (session metrics are cumulative).
    client.metrics_script = [
        dict(_ZERO_METRICS),  # chunk-1 baseline
        _metrics(2, 10, 5),  # chunk-1 end
        _metrics(2, 10, 5),  # chunk-2 baseline
        _metrics(5, 40, 15),  # chunk-2 end
    ]
    cell = _FakeCell()

    stats = runner._run_opencode_serve_chunked(
        active_cell=cell,
        serve_client=client,
        session_id="ses_chunks",
        prompts=["CHUNK ONE", "CHUNK TWO"],
        run_label="cell-chunks",
    )

    assert [text for _, text in client.sent_prompts] == ["CHUNK ONE", "CHUNK TWO"]
    assert stats.exit_code == 0
    assert stats.turns == 5  # 2 + 3, deltas summed across chunks
    assert stats.input_tokens == 40  # 10 + 30
    assert stats.output_tokens == 15  # 5 + 10
    assert len(stats.chunk_reports) == 2
    # Each chunk is ONE prompt: a clean drive advances, and nothing re-reads
    # what the model wrote to decide that (WO-MARKER-RIP).
    assert all(r["exit_code"] == 0 for r in stats.chunk_reports)
    assert all(r["recovery_nudges"] == 0 for r in stats.chunk_reports)
    assert all("marker" not in r for r in stats.chunk_reports)


def test_chunked_build_writes_one_sidecar_entry_per_chunk(tmp_path: Path) -> None:
    """A multi-chunk build must record ONE sidecar entry per chunk (kind="chunk",
    attempt=1, verbatim per-chunk text) — not a single joined entry. Regression
    guard for WO-CHUNK-01: chunks 2..N were previously missing from the sidecar."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    prompts = ["CHUNK ONE", "CHUNK TWO", "CHUNK THREE"]
    # 2 metrics reads per chunk (baseline + end), cumulative across the session.
    client.metrics_script = [
        dict(_ZERO_METRICS),  # chunk-1 baseline
        _metrics(1, 10, 5),  # chunk-1 end
        _metrics(1, 10, 5),  # chunk-2 baseline
        _metrics(2, 20, 10),  # chunk-2 end
        _metrics(2, 20, 10),  # chunk-3 baseline
        _metrics(3, 30, 15),  # chunk-3 end
    ]
    cell = _FakeCell()
    sidecar_path = tmp_path / "worktree.user-events.jsonl"

    stats = runner._run_opencode_serve_chunked(
        active_cell=cell,
        serve_client=client,
        session_id="ses_sidecar_chunks",
        prompts=prompts,
        run_label="cell-sidecar-chunks",
        sidecar_path=sidecar_path,
    )

    rows = [
        json.loads(line)
        for line in sidecar_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert stats.exit_code == 0
    assert len(rows) == 3
    assert [r["kind"] for r in rows] == ["chunk", "chunk", "chunk"]
    assert [r["text"] for r in rows] == prompts
    assert all(r["attempt"] == 1 for r in rows)
    assert [r["chars"] for r in rows] == [len(p) for p in prompts]
    assert all(r["text_fp"] for r in rows)


def test_compaction_off_fires_no_compaction_at_all(tmp_path: Path) -> None:
    """With compaction OFF, nothing compacts — no summarize call, no compaction
    part, no compaction accounting.

    Descended from the W1 acceptance test, which asserted the same thing
    unconditionally because the drive had no compaction of any kind. Chunk-
    boundary compaction (2026-09-02) is opt-in and defaults off, so the
    invariant is now conditional on the flag rather than absolute — and the OFF
    path has to stay exactly what it was, or every cell that declined
    compaction silently changed scale."""
    runner = _make_runner(tmp_path)
    assert runner.compact is False, "compaction must default OFF"
    client = _FakeServeClient()
    client.metrics_script = [
        dict(_ZERO_METRICS),  # chunk-1 baseline
        _metrics(2, 10, 5),  # chunk-1 end
        _metrics(2, 10, 5),  # chunk-2 baseline
        _metrics(5, 40, 15),  # chunk-2 end
    ]
    cell = _FakeCell()

    stats = runner._run_opencode_serve_chunked(
        active_cell=cell,
        serve_client=client,
        session_id="ses_zero_compact",
        prompts=["CHUNK ONE", "CHUNK TWO"],
        run_label="cell-zero-compact",
    )

    assert stats.exit_code == 0
    assert not any(
        part.get("type") == "compaction"
        for msg in client.get_messages("ses_zero_compact")
        for part in (msg.get("parts") or [])
    )
    assert client.compaction_on_idle is None


def test_serve_drive_zero_delta_phase_is_loud_not_clean_zero(tmp_path: Path) -> None:
    """A phase that ends with the SAME cumulative metrics as its baseline
    produced nothing (discarded message / dead stream) — loud exit 1 with a
    silent_phase anomaly, never a clean zero-turn ok (2026-08-09 feedback void).
    """
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    stale = _metrics(6, 23354, 24822)
    client.metrics_baseline = dict(stale)
    client.metrics_result = dict(stale)
    cell = _FakeCell()

    stats = runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_stale",
        prompt="fix the 47 problems",
        run_label="cell-stale",
        phase="feedback-1",
    )

    assert stats.exit_code == 1
    assert stats.turns == 0
    assert stats.input_tokens == 0
    assert any(a["terminal"] == "silent_phase" for a in stats.turn_anomalies)
    assert cell.kill_calls == 0


# ---------------------------------------------------------------------------
# WO-LOOPREC-1: loop-guard recovery on the serve path
# ---------------------------------------------------------------------------
def test_chunk_prompts_carry_the_write_chunking_directive() -> None:
    """Walter 2026-08-10: the finalize kills were oversized single generations
    (whole-file writes); every chunk prompt must carry the write-in-chunks
    directive — a prompt edit that drops it re-opens the
    stream_finalize_exhausted cell death.

    ONE NUMBER, THREE VOICES. The same ~150 lines appears in the chunk prompts,
    in the seeded AGENTS.md and in the recovery nudges. It used to be ~150 in
    two of them and ~200-400 in AGENTS.md, which handed the model two limits
    from two directions and made the standing one dead weight.
    """
    from harness.adapters.challenge import _WORKER_AGENTS_MD, _WRITE_CHUNKING_DIRECTIVE

    for index in range(1, 6):
        text = (TASK_DIR / "prompts" / f"chunk-0{index}.md").read_text(encoding="utf-8")
        assert "~150 lines" in text, f"chunk-0{index}.md lost the chunking directive"
    assert "150 lines" in _WORKER_AGENTS_MD, "AGENTS.md must state the same limit"
    assert "200-400" not in _WORKER_AGENTS_MD, (
        "AGENTS.md must not state a SECOND, larger write limit"
    )
    assert "150 lines" in _WRITE_CHUNKING_DIRECTIVE


def test_no_prompt_asks_the_model_to_print_a_completion_string() -> None:
    """WO-MARKER-RIP. The corpus asks for work, never for a sign-off.

    The string leaked past the phase it was scoped to — repair rounds run in
    the same session and the model kept printing it — and it stood in for an
    event (session idle) the harness already observes directly.
    """
    for index in range(1, 6):
        text = (TASK_DIR / "prompts" / f"chunk-0{index}.md").read_text(encoding="utf-8")
        assert "CHUNK FINISHED" not in text, (
            f"chunk-0{index}.md still asks for the deleted completion marker"
        )
