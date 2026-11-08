"""THE LAYERED HARNESS, END TO END, WITH NO MODEL IN THE LOOP.

TWO PROOFS, ON REAL FILES AND THE REAL GRADER
---------------------------------------------
(A) THE GOLDEN TASK PASSES EVERY LAYER IN ORDER. The cell builds the challenge's
    own seven-phase plan, grades each layered phase against ITS layer, and ends
    ``gates_green`` with four attempt reports on
    disk — layers ``[1, 2, 3, 3]``, every one a PASS.

(B) A BROKEN COPY FAILS LAYER 1 AND NEVER BUILDS LAYER 2. The same run over
    ``golden/`` plus ONE inserted line draws the bar at half width. The layer-1
    grade really runs and really fails on both of the bar's geometry gates, the
    model is told the first of them (complaints go out ONE STAGE AT A TIME — the
    second is graded and counted, not lost), and the sequence stays in layer 1:
    phase 5 (Layer 2) is never built and no layer-2 report is written.

WHAT IS REAL AND WHAT IS FAKED
------------------------------
REAL: ``ChallengeRunner.run_cell`` — the phase sequence, the per-phase scoped
grade, the troubleshooting stretch, the live stream, the attempt reports, and
the gate oracle itself. ``_run_gate_report`` is NOT monkeypatched anywhere in
this file: every verdict asserted below came out of a ``docker run`` of
``bench-grader:backgammon``, written by ``grader/report.mjs``.

THE STALE IMAGE IS NOT REBUILT. ``runner.grader_gates_dir`` is set, so
``gate_argv(..., gates_dir=...)`` mounts the WORKING-TREE ``grader/`` source
over ``/gates`` file by file (harness/grader_run.py). That overlay is what lets
today's grader grade inside an image built earlier; without it this file would
be asserting against whatever bytes the image was built from.

FAKED: the MODEL, and nothing downstream of it. ``_run_opencode_serve`` is
WRAPPED, not replaced: the wrapper copies the phase's files into the worktree
and then hands the call to the REAL drive over the shared hermetic serve client
(tests/_serve_drive_fakes.py), so the ``phase.start`` records and the per-phase
label are the production emission sites — see the note beside the wrapper. A
feedback round, whose repair we do not model, returns canned stats instead: the
troubleshooting stretch is ended deliberately rather than by a real repair.

WHY ``slow``: every graded phase is a real grading pass (40-90s here, four of
them in proof A), so these are excluded from the default suite by the repo's
``addopts = -m "not slow"``. Run them explicitly:

    .venv/bin/python -m pytest -q -n 0 -m slow tests/test_end_to_end_layered_proofs.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

import harness.adapters.challenge as challenge_mod
from harness.adapters.challenge import ChallengeRunner, _OpencodeRunStats
from harness.grader_image import IMAGE
from harness.grader_run import GATES, gate_argv
from tests._serve_drive_fakes import (
    TASK_DIR,
    _FakeServeClient,
    _make_runner,
    _metrics,
)
from tests.test_challenge_budget_stop import _patch_fake_docker, _stats

#: The challenge corpus. `GOLDEN_DIR` is the known-good artifact: a failure here
#: is the harness's, never a model's.
GOLDEN_DIR = TASK_DIR / "golden"

#: The grader source the overlay mounts over the image's ``/gates``.
GRADER_DIR = Path(__file__).resolve().parents[1] / "grader"

#: WHICH FILES EACH PHASE OWNS — the fake's model of what a build phase writes.
#:
#: Phases 5 and 6 own NOTHING, and that is the truth about this challenge, not
#: an omission: the frontend is ONE monolithic ``public/app.js``, so "Layer 2 —
#: pieces" and "Layer 3 — gameplay" are incremental edits INSIDE a file phase 4
#: already wrote. There is no per-layer snapshot of that file on disk to copy,
#: so the fake writes each phase's files at their FINAL (golden) state and
#: cannot reproduce the intra-``app.js`` increments a real model makes. What the
#: proof still covers is everything that is not that: which PHASE was built,
#: which LAYER was graded against which tree, and what the grader said.
_PHASE_FILES: dict[int, tuple[str, ...]] = {
    1: ("src/game.ts",),
    2: ("src/ai.ts",),
    3: ("src/server.ts",),
    4: ("public/index.html", "public/style.css", "public/app.js"),
    5: (),
    6: (),
    7: ("src/test.ts",),
}

#: THE BROKEN COPY, BYTE-FOR-BYTE ``li-broken-b-bar-half-width``: golden plus one
#: line drawing the bar at half width, inserted after the one anchor below.
_BROKEN_ANCHOR = '  barDiv.style.gridColumn = "7";\n'
_BROKEN_LINE = (
    '  barDiv.style.width = "50%"; // BROKEN COPY (b): bar drawn at half width\n'
)

#: The repo root: the cost derivation lives under ``scripts/``, not in the
#: installed package, so it is imported by path (see ``_derive_cost``).
_ROOT = Path(__file__).resolve().parents[1]


def _grader_ready() -> tuple[bool, str]:
    """Is a REAL grading pass possible here? ``(ok, why_not)``.

    Both halves are prerequisites of the proof and neither is optional: without
    the docker CLI there is no grading pass to run, and without the image there
    is no instrument to run it in — grading has no host fallback by design
    (harness/grader_run.py). The skip this feeds is LOUD, never silent: a proof
    that quietly did not run must not look like one that passed.
    """
    if shutil.which("docker") is None:
        return False, (
            f"{IMAGE} image not available — the end-to-end proof requires docker "
            "(the docker CLI is not on PATH)"
        )
    inspected = subprocess.run(
        ["docker", "image", "inspect", IMAGE],
        capture_output=True,
        text=True,
        check=False,
    )
    if inspected.returncode != 0:
        return False, (
            f"{IMAGE} image not available — the end-to-end proof requires docker "
            f"(docker image inspect exited {inspected.returncode})"
        )
    return True, ""


_DOCKER_OK, _DOCKER_DETAIL = _grader_ready()
REQUIRES_REAL_GRADING = pytest.mark.skipif(not _DOCKER_OK, reason=_DOCKER_DETAIL)


def _write_phase_files(source: Path, worktree: Path, index: int) -> None:
    """Put phase ``index``'s files into the worktree, at their final state.

    The cell seeds the worktree from the challenge SCAFFOLD before the first
    build (runner.py), so a phase only has to write the files it owns — the rest
    of the tree is already there, which is how the real model meets it.
    """
    for relative in _PHASE_FILES[index]:
        target = worktree / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / relative, target)


class _CellServeClient(_FakeServeClient):
    """The shared drive fake, plus the ONE call the CELL makes itself.

    ``_serve_drive_fakes._FakeServeClient`` is handed a session id by its
    caller; ``_run_cell_impl`` creates the session first, so this adds exactly
    that. Every other surface — send, wait, metrics, summarize — is the shared
    fake, unmodified.
    """

    def create_session(self, title: str | None = None) -> str:
        return "ses_hermetic"


def _growing_metrics(reads: int = 64) -> list[dict[str, Any]]:
    """A strictly-increasing metrics script for the real drive.

    The drive meters each phase as the DELTA between a baseline read and a
    post-drive read, and a phase that adds no turn and no token is the
    ``silent_phase`` ending. A monotone series makes EVERY pair a real
    advancement however many reads a drive happens to take, so the fixture does
    not depend on that count — the sequence, not the arithmetic, is what these
    tests are about.
    """
    return [_metrics(index, index * 1000, index * 10) for index in range(reads)]


def _rows(run_dir: Path) -> list[dict[str, Any]]:
    """Every record the cell wrote to its live stream, in order."""
    return [
        json.loads(line)
        for line in (run_dir / "live.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _check_token(problem: dict[str, Any]) -> str:
    """``[F29] REQ-GEOMETRY — bar between the halves`` -> ``F29``.

    The bracket token is the gate's id; what follows it is the reviewer-facing
    line. Assertions here name the ID, so a reworded line cannot silently move
    which gate a proof is about.
    """
    return str(problem.get("check", "")).split("]", 1)[0].strip("[ ").strip()


def _derive_cost(run_dir: Path) -> dict[str, Any]:
    """``derive_cost_from_disk`` for this cell, read off what it left on disk."""
    scripts = str(_ROOT / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    from run_cumulative.cost_from_disk import derive_cost_from_disk

    return derive_cost_from_disk(run_dir)


def _pair(argv: list[str], flag: str) -> str:
    """The value following ``flag`` on an argv; fails when it is not there."""
    for index, item in enumerate(argv[:-1]):
        if item == flag:
            return argv[index + 1]
    raise AssertionError(f"{flag} is not on the argv: {argv}")


@pytest.fixture(scope="session")
def grader_roster(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """THE REAL GATE ROSTER, enumerated fresh by the grader's own enumerator.

    Generated rather than reused: the roster is what a scoped grade reads to say
    which gates exist and therefore which never ran, and the stamps it carries
    (each gate's layer) are the ones today's ``grader/`` produces. A roster
    captured earlier would let the proof grade against a denominator this tree
    no longer publishes. It enumerates no test, so it costs seconds.
    """
    target = tmp_path_factory.mktemp("grader-roster") / "gate-roster.json"
    subprocess.run(
        [
            "node",
            str(GRADER_DIR / "roster.mjs"),
            "--out",
            str(target),
            "--task",
            "backgammon",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return target


def test_gate_argv_overlays_the_grader_source_when_gates_dir_is_set(
    tmp_path: Path,
) -> None:
    """The stale-image overlay is what makes the two proofs grade TODAY's source.

    Without ``gates_dir`` the container grades the bytes its image was built
    from. With it, every file the builder bakes is mounted READ-ONLY over its
    ``/gates`` path — the same ``baked_paths`` definition the builder hashes, so
    the overlay cannot drift from the image by a hand-kept list.

    ``node_modules`` is never overlaid and must not be: the image's copy is the
    linux build the container runs, and a host copy mounted over it would shadow
    it. No docker here — this is the argv, and it runs in the default suite.
    """
    overlay = GRADER_DIR.resolve()
    report = tmp_path / "cell" / "attempt-2-report.json"
    roster = tmp_path / "gate-roster.json"
    roster.write_text('{"gates": []}\n', encoding="utf-8")

    argv = gate_argv(
        worktree=tmp_path / "worktree",
        report_path=report,
        roster_path=roster,
        attempt=2,
        layer=2,
        gates_dir=GRADER_DIR,
    )

    mounts = [argv[index + 1] for index, item in enumerate(argv[:-1]) if item == "-v"]
    for name in ("report.mjs", "gate-results.mjs", "roster.mjs", "layers.json"):
        expected = f"{overlay / name}:{GATES}/{name}:ro"
        assert expected in mounts, f"the overlay never mounted {name}: {mounts}"
    assert not any(
        "node_modules" in mount.split(f":{GATES}/")[0] for mount in mounts
    ), (
        "node_modules must never be overlaid — the image's copy is the linux "
        f"build the container runs: {mounts}"
    )

    # The pass is still scoped and still told which gates exist: the overlay
    # changes WHERE the grader source comes from, never what is being measured.
    assert _pair(argv, "--layer") == "2"
    assert _pair(argv, "--roster") == "/roster.json"


def _drive_cell(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    source: Path,
    run_label: str,
    roster: Path,
) -> tuple[Any, list[str], dict[str, str], Path]:
    """One whole cell over ``source``: real grader, faked model.

    THE DRIVE IS WRAPPED, NEVER REPLACED, and that is load-bearing: ``phase.start``
    is emitted in exactly one place — the body of ``_run_opencode_serve``
    (harness/adapters/challenge/serve.py) — so replacing that method would leave
    the label assertions in proof A nothing to read. The wrapper writes the
    phase's files and then hands the call to the REAL drive over the shared
    hermetic serve client, which is the same seam ``tests/test_live_labels.py``
    uses for the same reason.

    Returns ``(result, drives, told, run_dir)``: the call's result, the drive
    phases in the order they ran, the prompt each FEEDBACK round carried, and
    the cell's own directory.
    """
    # THE IMAGE PROBE MUST SEE THE TRUTH. `_patch_fake_docker` replaces
    # `subprocess.run` (the module singleton) so the docker CLI looks absent to
    # container management — which would also blind the grader-image preflight
    # and abort every real grading pass. `docker image inspect` is a read-only
    # question, so it goes to the real CLI; everything else keeps the fake.
    real_run = subprocess.run
    _patch_fake_docker(monkeypatch)
    faked_run = subprocess.run

    def _run(argv: Any, *args: Any, **kwargs: Any) -> Any:
        if isinstance(argv, list) and argv[:3] == ["docker", "image", "inspect"]:
            return real_run(argv, *args, **kwargs)
        return faked_run(argv, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", _run)

    client = _CellServeClient()
    client.metrics_script = _growing_metrics()
    monkeypatch.setattr(challenge_mod, "ServeClient", lambda *a, **k: client)

    runner = _make_runner(tmp_path)
    runner.grader_gates_dir = GRADER_DIR
    runner.gate_roster_path = roster

    run_dir = tmp_path / run_label
    worktree = run_dir / "worktree"
    real_drive = runner._run_opencode_serve
    drives: list[str] = []
    told: dict[str, str] = {}

    def _drive(**kwargs: Any) -> _OpencodeRunStats:
        phase = str(kwargs.get("phase") or "")
        drives.append(phase)
        if phase.startswith("initial-chunk-"):
            _write_phase_files(source, worktree, int(phase.rsplit("-", 1)[1]))
            return real_drive(**kwargs)
        # A repair round: the model's work on it is not what these proofs
        # measure, so it reports an exhausted output budget and the
        # troubleshooting stretch ends there — the bounded ending, never a loop.
        told[phase] = str(kwargs.get("prompt") or "")
        return _stats(
            session_id="sess-1",
            exit_code=0,
            cost_usd=0.0,
            budget_stop_detected=True,
        )

    monkeypatch.setattr(runner, "_run_opencode_serve", _drive)

    result = runner.run_cell(run_label, run_dir, task_id="backgammon")
    return result, drives, told, run_dir


@pytest.mark.slow
@REQUIRES_REAL_GRADING
@pytest.mark.timeout(1200)
def test_proof_a_golden_runs_all_phases_and_every_layer_passes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    grader_roster: Path,
) -> None:
    """(A) The golden task walks the whole 7-phase sequence and goes green.

    EVERY VERDICT BELOW CAME OUT OF DOCKER. The golden tree is the known-good
    artifact, so a FAIL here is the harness's or the grader's, never a model's —
    which is exactly why the proof runs on it.

    The plan is the CHALLENGE'S OWN (task/backgammon/prompts/phase-plan.json):
    three backend phases that declare no layer, then 1, 2, 3, 3. Nothing below
    scripts the phases, so the two ``--layer 3`` passes fall out of the data.
    """
    result, drives, _told, run_dir = _drive_cell(
        tmp_path,
        monkeypatch,
        source=GOLDEN_DIR,
        run_label="golden-proof",
        roster=grader_roster,
    )

    # ── THE SEQUENCE ───────────────────────────────────────────────────────
    assert result.verdict == "PASS"
    assert result.termination_reason == "gates_green"
    # No layer needed a repair round: every scoped grade passed the first time.
    assert result.attempts_to_green == 0
    assert drives == [f"initial-chunk-{k}" for k in range(1, 8)], (
        f"the build must run the plan's seven phases in order, got {drives}"
    )

    # ── ONE REAL GRADING PASS PER LAYERED PHASE, EACH ON ITS OWN LAYER ─────
    reports = [
        json.loads((run_dir / f"attempt-{n}-report.json").read_text(encoding="utf-8"))
        for n in range(1, 5)
    ]
    assert [report["layer"] for report in reports] == [1, 2, 3, 3], (
        "the layer is the pass being graded — phase 4 is L1, 5 is L2, and both "
        "6 and 7 are L3"
    )
    assert [report["verdict"] for report in reports] == ["PASS"] * 4
    assert not any((run_dir / f"attempt-{n}-report.json").is_file() for n in (5, 6)), (
        "a green cell grades once per layered phase and never again"
    )

    # ── THE LIVE STREAM CARRIES THE LABELS ─────────────────────────────────
    rows = _rows(run_dir)
    starts = [row["phase"] for row in rows if row["kind"] == "phase.start"]
    assert starts == [f"initial-chunk-{k}" for k in range(1, 8)]

    gate_rows = [row for row in rows if row["kind"] == "gate.result"]
    assert gate_rows, "a graded phase must publish one live row per gate"
    for row in gate_rows:
        for key in ("phase_index", "phase_name", "phase_kind"):
            assert key in row, f"gate.result lost the phase label key {key}"
        # The grader's own grouping is `gate_phase`; `phase` keeps ONE meaning
        # (the drive string) and so is absent here.
        assert row["gate_phase"] in {"conformance", "backend", "frontend"}
        assert "phase" not in row, "gate.result must not carry the phase string"

    ends = [row for row in rows if row["kind"] == "attempt.end"]
    assert [
        (row["phase_index"], row["phase_kind"], row["phase_layer"]) for row in ends
    ] == [(4, "build", 1), (5, "build", 2), (6, "build", 3), (7, "build", 3)], (
        "every attempt.end names the phase it graded, in order"
    )

    # ── THE COST ATTRIBUTION READS THE SAME LABELS ─────────────────────────
    # Structure, not magnitudes: the faked session has no real serve DB to
    # export, so a bucket may carry no token at all (absent, never zero).
    phases = _derive_cost(run_dir)["phases"]
    by_phase = phases["by_phase"]
    assert list(by_phase) == [str(index) for index in range(1, 8)]
    assert [by_phase[str(index)].get("layer") for index in range(1, 8)] == [
        None,
        None,
        None,
        1,
        2,
        3,
        3,
    ]
    for index in range(1, 8):
        assert by_phase[str(index)].get("name"), (
            f"phase {index} must be named by the stream it opened"
        )

    # The roll-ups are the per-phase buckets recombined — summed, never a
    # second derivation, so the two can never disagree.
    graded_per_phase = sum(
        entry[kind]["grades"]["count"]
        for entry in by_phase.values()
        for kind in ("build", "troubleshooting")
        if "grades" in entry.get(kind, {})
    )
    assert graded_per_phase == 4, "one grade per layered phase, in four buckets"
    assert phases["total"]["grades"]["count"] == graded_per_phase
    for field, value in phases["total"].items():
        if field in {"grades", "context_peak"}:
            continue
        per_phase = [
            bucket[field]
            for entry in by_phase.values()
            for bucket in (entry.get("build", {}), entry.get("troubleshooting", {}))
            if field in bucket
        ]
        assert per_phase, f"{field} is in the total but in no bucket"
        assert value == pytest.approx(sum(per_phase)), (
            f"the {field} roll-up is not the sum of its per-phase buckets"
        )


@pytest.mark.slow
@REQUIRES_REAL_GRADING
@pytest.mark.timeout(1200)
def test_proof_b_broken_copy_fails_l1_and_never_builds_layer_two(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    grader_roster: Path,
) -> None:
    """(B) A broken layer-1 tree fails L1 and the sequence stays in L1.

    THE DEFECT IS ONE LINE, and the same one the ``li-broken-b-bar-half-width``
    fixture carries: golden plus ``barDiv.style.width = "50%"`` after the bar
    whose ``gridColumn`` puts it between the halves. The bar is then drawn at
    half width, which is a layer-1 geometry failure — no later layer is
    involved, and no repair happens in this run.

    WHAT THIS PROVES: the L1 grade really RAN (a report exists with a verdict,
    from docker), it really FAILED, its problems are the LAYER-1 ones and not
    the whole suite's, the model was told about them, and layer 2 was never
    built — a layer advances only on a scoped PASS.
    """
    broken_src = tmp_path / "broken-source"
    shutil.copytree(GOLDEN_DIR, broken_src)
    broken_app = broken_src / "public" / "app.js"
    golden_app = broken_app.read_text(encoding="utf-8")
    assert golden_app.count(_BROKEN_ANCHOR) == 1, (
        "the broken copy is golden + exactly one applied edit, so the anchor it "
        "is inserted after must be unique"
    )
    broken_app.write_text(
        golden_app.replace(_BROKEN_ANCHOR, _BROKEN_ANCHOR + _BROKEN_LINE),
        encoding="utf-8",
    )

    result, drives, told, run_dir = _drive_cell(
        tmp_path,
        monkeypatch,
        source=broken_src,
        run_label="broken-proof",
        roster=grader_roster,
    )

    # ── THE L1 GRADE RAN, AND IT FAILED ────────────────────────────────────
    report = json.loads((run_dir / "attempt-1-report.json").read_text(encoding="utf-8"))
    assert report["layer"] == 1, "the first graded phase is layer 1"
    assert report["verdict"] == "FAIL"
    assert report["conformed"] is False
    # SCOPED PROBLEMS, NOT THE SUITE: only gates the model was asked for at
    # layer 1 can be reported as its failures.
    assert sorted(_check_token(problem) for problem in report["problems"]) == [
        "F29",
        "F80",
    ], f"the bar's two layer-1 geometry gates, got {report['problems']}"

    # ── THE MODEL WAS TOLD, IN PLAYER ORDER ────────────────────────────────
    # ONE COMPLAINT THIS ROUND, NOT TWO. The failing gates are told in the
    # order a player meets them (harness/adapters/challenge/stages.py): the
    # round reports the EARLIEST failing stage and counts the rest, so the bar's
    # shape ("just a thin line") is told now and the half-width comparison
    # behind it is graded-but-not-yet-told. Both are in the report's problems;
    # only one is in the message, and the live record says which is which.
    told_lines = {
        _check_token(problem): ChallengeRunner._told_label(problem, pass_kind="first")[
            0
        ]
        for problem in report["problems"]
    }
    prompt = told["feedback-1"]
    assert told_lines["F29"] in prompt, (
        f"the stage-1 complaint never reached the model: {told_lines['F29']!r}"
    )
    assert told_lines["F80"] not in prompt, (
        "the model must be told one stage at a time — F80 is behind F29"
    )
    ends = [row for row in _rows(run_dir) if row["kind"] == "attempt.end"]
    assert len(ends) == 1
    assert ends[0]["phase_index"] == 4 and ends[0]["phase_layer"] == 1
    assert (ends[0]["told"], ends[0]["unevaluated"]) == (1, 1), (
        "one complaint told, one graded and held back — the stream must say so "
        "rather than the second gate vanishing"
    )

    # ── IT STAYED IN LAYER 1 ───────────────────────────────────────────────
    # Phase 5 is "Layer 2 — pieces": it was never built, so no layer-2 tree
    # ever existed to grade.
    assert f"initial-chunk-{5}" not in drives
    assert [d for d in drives if d.startswith("initial-chunk-")] == [
        f"initial-chunk-{k}" for k in (1, 2, 3, 4)
    ], f"only the phases up to L1 were built, got {drives}"
    assert not (run_dir / "attempt-2-report.json").is_file(), (
        "the stretch ended on the repair round's budget stop — there is no "
        "second grade, and in particular none scoped to layer 2"
    )

    # THE ENDING IS THE BUDGET STOP, not a silent infinite loop: the repair
    # round ran out of output budget, which ends the CELL.
    assert result.termination_reason == "budget_stop_mid_attempt"
    assert result.verdict != "PASS"
