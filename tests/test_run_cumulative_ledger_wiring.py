"""WO-43a regression guard: `_handle_run` must resolve `layout` in its own scope.

The bug: `_handle_run` called `_append_results_ledger(args, layout)` with
`layout` never bound in that function (it was only a local of `_build_context`),
so a completed `status=="done"` run raised NameError at the call site — before
the fail-open try/except inside `_append_results_ledger` could apply — crashing
`_handle_run` after the result was already printed.

This test monkeypatches `_build_context` and `_append_results_ledger` so the
handler runs without any runtime, then asserts the `layout` argument reaching
the ledger append is a `PathLayout` resolved from the handler's `--manifest`.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import run_cumulative  # noqa: E402


class _StubSequencer:
    def current_session(self) -> Any:
        class _Session:
            memory_mode = "off"

        return _Session()

    def step_until_done(self) -> dict[str, Any]:
        return {"status": "done", "convergence": {}}


def test_handle_run_resolves_layout_for_ledger_append(
    tmp_path: Path, monkeypatch: Any
) -> None:
    monkeypatch.setenv("BENCH_SKIP_CLEANUP", "1")

    manifest = tmp_path / "campaign" / "manifest.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text("{}", encoding="utf-8")

    monkeypatch.setattr(
        run_cumulative,
        "_build_context",
        lambda args, require_runtime: run_cumulative.CliContext(
            sequencer=_StubSequencer()
        ),
    )

    captured: dict[str, Any] = {}

    def _capture_ledger(args: argparse.Namespace, layout: Any) -> None:
        captured["args"] = args
        captured["layout"] = layout

    monkeypatch.setattr(run_cumulative, "_append_results_ledger", _capture_ledger)

    args = argparse.Namespace(manifest=str(manifest), mode="off", org=None, seed=1)

    rc = run_cumulative._handle_run(args)

    assert rc == 0
    layout = captured["layout"]
    assert isinstance(layout, run_cumulative.PathLayout)
    assert layout.manifest_path == manifest.resolve()
    assert captured["args"] is args
