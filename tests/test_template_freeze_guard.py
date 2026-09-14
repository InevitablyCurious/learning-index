"""WO-FREEZE-1 template-freeze guard tests.

Covers:
  (a) the live `task/backgammon/scaffold/` hash equals FROZEN_TASK_TEMPLATE_HASH;
  (b) compute_task_template_hash over a DELIBERATELY ALTERED temp copy differs
      from the frozen hash and verify_task_template_frozen RAISES naming the
      expected vs actual hashes;
  (c) the guard is wired into prepare_fixture (fail-closed propagates out of the
      run path against altered bytes).

The altered copy is a pytest ``tmp_path`` directory only — the real
``task/backgammon/scaffold/`` files are never modified (verified by (a), which
asserts the live hash still equals the frozen value).
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path
from typing import Any

import pytest


# LI-14: run_cumulative is now a package (scripts/run_cumulative/) fronted by a
# thin scripts/run_cumulative.py entrypoint. Import the PACKAGE. The freeze guard
# (verify_task_template_frozen) and compute_task_template_hash both live in
# run_cumulative.template, so the monkeypatch below targets THAT submodule —
# patching the facade's re-export would not reach the guard's __globals__ (the
# same reason the run-artifacts test patches run_cumulative.runner.load_snapshot).
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import run_cumulative  # noqa: E402

MODULE = run_cumulative

# Re-frozen 2026-09-10 (WO-CONTRACT-CHUNK-12: REQ-INIT's literal opening array,
# REQ-PIP's "167", and REQ-WINCLASS's boundary cut from the published surface —
# derivable from the retained board convention, so they were transcription, not
# capability). Previously (WO-PORT-ASSIGNABLE: `src/server.ts` reads
# `Number(process.env.PORT ?? 8002)` so a built game can be run a second time,
# on another port, without colliding with a grading pass); see
# run_cumulative.py for why. The default is unchanged, so a grading run still
# binds 8002 and stays comparable with runs taken against the prior freeze.
# Prior: ad3c992a6d371b68b48ff376e50e32beec6f4f925143ad27782a30a4d6b7feeb
#        (2026-09-10, WO-PORT-ASSIGNABLE)
# Prior: e0a14bdba4294caa42cab090dfc0edfba79ad399e331e95a705df71b678b001c
#        (2026-09-07, frontend origin seam / REQ-SAME-ORIGIN)
FROZEN = "e1628129a751556e43cd5e700b3ebcec969af14f9797ded5cf77cd5f0dd94f29"
REPO_ROOT = Path(__file__).resolve().parents[1]
LIVE_SCAFFOLD = REPO_ROOT / "task" / "backgammon" / "scaffold"


def _altered_scaffold_copy(tmp_path: Path) -> Path:
    """Copy the real scaffold into a temp dir and alter one file's bytes."""
    copy = tmp_path / "altered-scaffold"
    shutil.copytree(LIVE_SCAFFOLD, copy)
    target = copy / "src" / "game.ts"
    target.write_bytes(target.read_bytes() + b"// WO-FREEZE-1 altered bytes\n")
    return copy


def test_live_scaffold_hash_matches_frozen() -> None:
    """(a) The live scaffold bytes still produce the frozen WO-FREEZE-1 hash."""
    live_hash = MODULE.compute_task_template_hash(LIVE_SCAFFOLD)
    assert live_hash is not None, "live scaffold must be present"
    assert live_hash == MODULE.FROZEN_TASK_TEMPLATE_HASH
    assert MODULE.FROZEN_TASK_TEMPLATE_HASH == FROZEN


def test_altered_copy_differs_and_guard_raises_with_mismatch_named(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """(b) Altered bytes change the hash and the guard fails closed naming both."""
    altered = _altered_scaffold_copy(tmp_path)
    altered_hash = MODULE.compute_task_template_hash(altered)
    assert altered_hash is not None
    assert altered_hash != MODULE.FROZEN_TASK_TEMPLATE_HASH

    # Drive the real guard's comparison against the altered hash by feeding it
    # the altered copy's digest. verify_task_template_frozen is module-level and
    # hashes the repo scaffold; monkeypatching its hash dependency lets the
    # genuine mismatch-naming raise fire without touching the real scaffold.
    monkeypatch.setattr(
        run_cumulative.template,
        "compute_task_template_hash",
        lambda _scaffold: altered_hash,
    )
    with pytest.raises(RuntimeError) as exc:
        MODULE.verify_task_template_frozen()
    message = str(exc.value)
    assert MODULE.FROZEN_TASK_TEMPLATE_HASH in message
    assert altered_hash in message
    assert "scaffold" in message


def test_guard_wired_into_prepare_fixture(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """(c) prepare_fixture invokes the fail-closed guard against altered bytes.

    The guard is the first statement in prepare_fixture, so it raises before any
    scaffold copy or cell run. We point the guard's hash computation at the
    altered copy's digest (real mismatch) and assert the RuntimeError propagates
    out of prepare_fixture with the mismatch named.
    """
    altered = _altered_scaffold_copy(tmp_path)
    altered_hash = MODULE.compute_task_template_hash(altered)
    assert altered_hash != MODULE.FROZEN_TASK_TEMPLATE_HASH

    runner = MODULE.RealSessionRunner.__new__(MODULE.RealSessionRunner)
    # _task_dir is set so the runner mirrors the real construction shape; the
    # guard raises before _state_for_session / _copy_tree_contents are reached.
    runner._task_dir = tmp_path / "task"

    monkeypatch.setattr(
        run_cumulative.template,
        "compute_task_template_hash",
        lambda _scaffold: altered_hash,
    )
    with pytest.raises(RuntimeError) as exc:
        runner.prepare_fixture(_session())
    message = str(exc.value)
    assert MODULE.FROZEN_TASK_TEMPLATE_HASH in message
    assert altered_hash in message


def _session() -> Any:
    from harness.cumulative.types import PhaseGroup, SessionRecord

    return SessionRecord(
        sequence_index=1,
        model="local-llm-proxy/x",
        provider_pin="local",
        memory_mode="off",
        phase_group=PhaseGroup.OFF_BASELINE.value,
        phase="RUN_SESSION",
    )
