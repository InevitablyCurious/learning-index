"""WO-CUTOFF Parts C/D: context_peak_tokens — the phase's context peak.

``context_peak_tokens`` is the LARGEST context an assistant message held,
counted as opencode counts it (prompt + output: input + cache read + cache
write + output — the out-of-room check's measure), across the phase's
assistant messages, measured from the phase-start watermark — which NEVER advances, so the peak spans recovery
re-drives. It is None (ABSENT, never 0) when the phase produced no assistant
messages. The ledger writer copies the per-attempt figures onto the status
record ONLY when present: None writes no key, never a null and never a 0.

FAIL-BEFORE: against the pre-WO-CUTOFF code ``_OpencodeRunStats`` had no
``context_peak_tokens`` field (AttributeError), and the ledger writer had no
``context_peak``/``context_window`` copy at all (KeyError on the carried
half of the ledger test).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import run_cumulative  # noqa: E402

from tests._serve_drive_fakes import (  # noqa: E402
    _FakeServeClient,
    _ZERO_METRICS,
    _make_runner,
)
from tests.test_cap_cutoff_nudge import (  # noqa: E402
    _cum_read,
    _cut_tokens,
    _drive,
    _length_at_cap,
)
from tests.test_run_cumulative_run_artifacts import (  # noqa: E402
    _FakeRunner,
    _build_runner,
    _cell_result,
    _read_status_records,
    _session,
)

# ── 1. the peak is the LARGEST held context, spanning recovery re-drives ──


def test_context_peak_is_the_largest_context_of_the_phase(
    tmp_path: Path,
) -> None:
    """Two turns, driven through a cap cut-off nudge: the CUT turn held the
    larger context, counted as opencode counts it — prompt + output (5,000
    input + 1,000 cache read + 500 cache write + 32,000 output = 38,500); the
    clean re-drive the smaller (100 + 50 + 25 + 200 = 375). The peak is the
    larger — and because the larger sits BEFORE the classification watermark
    the nudge advanced, this also pins that the peak watermark never
    advances: the measurement spans the WHOLE phase, re-drives included.
    (It was the request side alone, 6,500; run 1790258326's card read
    192,334 against a TUI showing 256,688.)"""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    client.assistant_terminal_script = [
        # Turn 1: cut at the cap, the big context.
        _length_at_cap(inp=5_000, cache_read=1_000, cache_write=500),
        # Turn 2 (the nudge re-drive): clean, a small context.
        {"tokens": _cut_tokens(inp=100, out=200, cache_read=50, cache_write=25)},
    ]
    client.metrics_script = [
        dict(_ZERO_METRICS),  # phase baseline
        _cum_read(turns=1, out=32_000, cap_cutoffs=1, inp=5_000),
        _cum_read(turns=2, out=32_200, cap_cutoffs=1, inp=5_000),
    ]

    stats, _ = _drive(runner, client, tmp_path)

    # The drive really did span two turns via the cap nudge.
    assert stats.cap_cutoffs == 1
    assert stats.cap_cutoffs_nudged == 1
    # THE PEAK: the largest held context, not the last, not the sum.
    assert stats.context_peak_tokens == 38_500


# ── 2. no assistant messages -> absent, never 0 ─────────────────────────────


def test_context_peak_absent_when_the_phase_has_no_assistant_messages(
    tmp_path: Path,
) -> None:
    """A phase whose send produced NO assistant message (the silent-phase
    shape) reports context_peak_tokens None — absence is a state; 0 would
    claim a measured request of size zero."""
    runner = _make_runner(tmp_path)
    client = _FakeServeClient()
    # An empty batch: send_prompt appends the user message and NO assistant
    # message, so the phase transcript has nothing request-sized in it.
    client.assistant_texts = [[]]
    client.metrics_script = [dict(_ZERO_METRICS), dict(_ZERO_METRICS)]

    stats, _ = _drive(runner, client, tmp_path)

    # The silent phase is the pre-existing loud failure (context, not the
    # assertion under test): zero new turns and tokens -> exit 1.
    assert stats.exit_code == 1
    assert stats.context_peak_tokens is None


# ── 3. the ledger copies the figures ONLY when present ──────────────────────


class _NoPeakRunner:
    """The _FakeRunner double whose cell result recorded NO context figures
    (context_peak/context_window None — a run that predates the measurement
    or a phase that never captured one)."""

    def __init__(self, **kwargs: Any) -> None:
        self._kwargs = kwargs

    def run_cell(
        self,
        run_label: str,
        run_dir: Path,
        task_id: str = "backgammon",
        run_identity: str | None = None,
    ) -> Any:
        result = _cell_result()
        result.attempt_reports = [
            dict(report, context_peak=None, context_window=None)
            for report in result.attempt_reports
        ]
        return result


def test_ledger_writes_context_figures_only_when_present(
    tmp_path: Path, monkeypatch
) -> None:
    """None = NOT RECORDED: the status record OMITS the keys entirely (a null
    on the wire is indistinguishable from "this producer does not set that
    field", and 0 would be a measurement that never happened). A present
    figure rides through verbatim. The carried half is what makes this
    fail-before: pre-WO-CUTOFF the writer copied neither key.

    (The carried half is also asserted by the ledger-wiring test at
    tests/test_run_cumulative_run_artifacts.py:229; it repeats HERE because
    the omission contract is only half a contract without it.)"""
    # The proxy-run-log source must be deterministic (the ledger module's own
    # autouse fixture does not reach this file): point it at an empty dir.
    empty = tmp_path / "empty-proxy-runs"
    empty.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("OKP_PROXY_RUNS_DIR", str(empty))

    runs_dir = tmp_path / "runs"
    runner = _build_runner(run_cumulative, tmp_path, runs_dir=runs_dir)

    # Session 0: no context figures recorded. Session 1: figures present
    # (the _FakeRunner's cell result carries context_peak=1234,
    # context_window=200000).
    runner._runner_cls = _NoPeakRunner
    runner.run_session(_session(0))
    runner._runner_cls = _FakeRunner
    runner.run_session(_session(1))

    omitted, carried = _read_status_records(runs_dir)
    assert "context_peak" not in omitted
    assert "context_window" not in omitted
    assert carried["context_peak"] == 1234
    assert carried["context_window"] == 200000
