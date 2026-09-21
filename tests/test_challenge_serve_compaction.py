"""Chunk-boundary compaction + A2 phase-sentinel tests (WO-LI18 split).

The harness OBSERVES compaction (the worker plugin fires it): it holds the
next prompt until the session settles, fails fast on guard-killed or
unsettled compactions, and publishes the build/repair phase sentinel around
every drive. Shared fakes: tests/_serve_drive_fakes.py.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from harness.adapters.challenge import (
    ServeTransportError,
    compact_phase_for,
)
from tests._serve_drive_fakes import (
    _LOOP_METRICS,
    _LOOP_SIG,
    _ZERO_METRICS,
    TASK_DIR,
    _FakeCell,
    _FakeServeClient,
    _make_feedback_attempt_kwargs,
    _make_runner,
    _metrics,
)

# ── CHUNK-BOUNDARY COMPACTION ───────────────────────────────────────────────
#
# The cadence is: build a chunk, see its marker, compact — six times — and then
# leave the repair loop entirely alone. Build narration is spent context; the
# model has already committed that work to files. Repair transcript is not:
# there the transcript IS the working memory, and compacting it away costs the
# model the record of what it has already tried.


def test_the_harness_waits_for_the_agents_compaction_and_continues(
    tmp_path: Path,
) -> None:
    """The harness OBSERVES compaction; it does not issue it.

    The plugin sees the build phase sentinel on session.idle and fires its
    own summarize, and all the harness does at the chunk boundary is hold the
    next prompt back until the session settles and require a completed
    compaction part. A settled wait with a landed compaction part is the
    fail-closed success condition — the drive continues, and the totals meter
    the build turns only (the settle observes, it does not meter).
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.compaction_on_idle = "ok"
    client.metrics_script = [
        dict(_ZERO_METRICS),  # chunk baseline
        _metrics(2, 10, 5),  # chunk end
    ]

    stats = runner._run_opencode_serve_chunked(
        active_cell=_FakeCell(),
        serve_client=client,
        session_id="ses_cc",
        prompts=["ONLY CHUNK"],
        run_label="cell-cc",
    )

    assert stats.exit_code == 0
    # Totals carry the build turns; the settle's wait landed without raising.
    assert stats.turns == 2
    assert stats.input_tokens == 10
    assert stats.output_tokens == 5


def test_a_compaction_that_completed_during_the_drive_is_still_detected(
    tmp_path: Path,
) -> None:
    """REGRESSION (run 1788450605): the plugin fires on the marker's session.idle
    DURING the drive, so the compaction completes before the drive returns and
    its message is already in the transcript when the settle runs. A settle
    that takes a FRESH watermark (post-drive) sits past that compaction and
    reads zero, aborting a cell whose compaction actually worked. Detection
    must use the PRE-DRIVE watermark.
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.compaction_on_idle = "ok"
    client.compaction_during_drive = True
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _metrics(2, 10, 5),
    ]

    stats = runner._run_opencode_serve_chunked(
        active_cell=_FakeCell(),
        serve_client=client,
        session_id="ses_during_drive",
        prompts=["ONLY CHUNK"],
        run_label="cell-during-drive",
    )

    assert stats.exit_code == 0
    assert stats.turns == 2


def test_a_guard_killed_compaction_during_the_drive_fails_fast(
    tmp_path: Path,
) -> None:
    """FAIL-FAST (run 1788451466): the worker's own compaction was loop-killed by
    the relay, and opencode AUTO-RETRIES it (compaction_restores). The harness
    must abort named (compaction_loop_killed), NOT nudge around opencode's
    retry storm — the harness does not drive compaction, so a recovery nudge is
    meaningless there, and nudging is exactly the 10-minute hang.
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.compaction_on_idle = "killed"
    client.compaction_during_drive = True
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _metrics(2, 10, 5),
    ]

    stats = runner._run_opencode_serve_chunked(
        active_cell=_FakeCell(),
        serve_client=client,
        session_id="ses_loopkill",
        prompts=["ONLY CHUNK"],
        run_label="cell-loopkill",
    )

    assert stats.exit_code == 1
    assert stats.killed_reason == "compaction_loop_killed"
    # The build-turn nudge path must NOT have been consulted for the compaction
    # kill: no recovery nudge was issued.
    assert stats.recovery_nudges == 0


def test_a_guard_killed_compaction_is_no_compaction_evidence_and_aborts(
    tmp_path: Path,
) -> None:
    """THE BUG THIS RECEIPT REPLACED (run 1788415430, 2026-09-03), now fail-closed.

    68 of 73 compactions were killed mid-stream by the relay's loop guard, and
    every one still carried `summary: true`. A receipt that trusted that flag
    reported 68 successful compactions where none had occurred. The receipt
    keys on the ERROR, which is the only thing that separates the 5 that
    completed from the 68 that did not — and a killed compaction lands zero
    completed parts, which is no_compaction_evidence: the cell ABORTS. The
    harness never fires a substitute summarize and never continues uncompacted.
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.compaction_on_idle = "killed"
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _metrics(2, 10, 5),
    ]

    with pytest.raises(ServeTransportError) as excinfo:
        runner._run_opencode_serve_chunked(
            active_cell=_FakeCell(),
            serve_client=client,
            session_id="ses_killed",
            prompts=["ONLY CHUNK"],
            run_label="cell-killed",
        )

    assert "no_compaction_evidence" in str(excinfo.value)


def test_a_compaction_that_does_not_settle_aborts_the_cell(
    tmp_path: Path,
) -> None:
    """Fail-closed: the bounded wait is a ceiling, not a fallback.

    The plugin fired, but the session never settled idle within the bounded
    wait — the next chunk would queue behind a generation still running.
    That is no_compaction_evidence: the cell aborts rather than sending the
    next prompt into it.
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.compaction_on_idle = "ok"
    client.settle_wait_result = False  # the settle's wait never sees idle
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _metrics(2, 10, 5),
    ]

    with pytest.raises(ServeTransportError) as excinfo:
        runner._run_opencode_serve_chunked(
            active_cell=_FakeCell(),
            serve_client=client,
            session_id="ses_nosettle",
            prompts=["ONLY CHUNK"],
            run_label="cell-nosettle",
        )

    assert "no_compaction_evidence" in str(excinfo.value)


def test_a_chunk_boundary_with_no_compaction_fire_aborts_the_cell(
    tmp_path: Path,
) -> None:
    """Fail-closed: the flag arms the worker's self-fire; if nothing fires,
    the boundary has no compaction evidence and the cell aborts.

    The session never goes busy in the grace window (the plugin did not
    fire), so zero compaction parts land — no_compaction_evidence. The
    harness never fires a substitute summarize.
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.compaction_on_idle = None  # the plugin never fired
    client.busy_result = False        # session never goes busy
    # busy_result=False also takes the drive through the never-busy raced-turn
    # path, which reads an extra `early` metrics snapshot — hence three entries.
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _metrics(2, 10, 5),
        _metrics(2, 10, 5),
    ]

    with pytest.raises(ServeTransportError) as excinfo:
        runner._run_opencode_serve_chunked(
            active_cell=_FakeCell(),
            serve_client=client,
            session_id="ses_nofire",
            prompts=["ONLY CHUNK"],
            run_label="cell-nofire",
        )

    assert "no_compaction_evidence" in str(excinfo.value)


def test_the_compact_flag_leaves_the_chunk_prompts_untouched(
    tmp_path: Path,
) -> None:
    """The driver-fired arm is gone: compact=True arms only the worker plugin.

    The chunk prompts carry no compaction instruction and no tool-call
    scripting whatever the flag. Since WO-MARKER-RIP they ask the model for
    nothing about compaction at all — not even indirectly: the plugin arms off
    the harness's phase sentinel, which the model never sees.

    The on-disk FILE is unchanged by the flag. The harness appends nothing to a
    build chunk (2026-09-08 reversal: the do-not-capture note and its splice are
    gone), so the assertion is file-only, and no compaction instruction is
    injected below.
    """
    runner = _make_runner(tmp_path, compact=True)
    chunks = runner._load_chunk_prompts()
    assert len(chunks) == 5
    for index, chunk in enumerate(chunks, start=1):
        on_disk = (TASK_DIR / "prompts" / f"chunk-{index:02d}.md").read_text(
            encoding="utf-8"
        )
        assert chunk == on_disk
        assert "okp_compact_session" not in chunk


def test_repair_attempts_never_compact(tmp_path: Path) -> None:
    """THE OTHER HALF OF THE CADENCE, and the one worth guarding.

    Compaction lives in the chunked BUILD driver only. The repair loop drives
    through `_run_cell_attempt`, which must never compact however the flag is
    set — the troubleshooting transcript is the model's record of what it has
    already tried, and compacting it away is the failure this whole change
    exists to prevent."""
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    runner._serve_client = client
    runner._cell_session_id = "ses_repair"
    # Two reads per phase (baseline, then end-of-phase), two phases.
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _metrics(1, 5, 2),
        _metrics(1, 5, 2),
        _metrics(2, 9, 4),
    ]

    cell = _FakeCell()
    for phase in ("feedback-1", "feedback-2"):
        runner._run_cell_attempt(
            **_make_feedback_attempt_kwargs(
                feedback_text=f"repair text for {phase}",
                phase=phase,
                kill_hook=cell.kill_worker_processes,
                active_cell=cell,
            )
        )
        # A2: the sentinel is what holds the line. It used to be paired with
        # a prompt-text guard that was necessary but never sufficient, because
        # the model printed the arming string on its own during repair.
        assert cell.compact_phase() == "repair", (
            f"phase {phase} left the worker's compaction arm reading "
            f"{cell.compact_phase()!r} — a repair round must never be armed"
        )

    # No prompt carries a compaction instruction any more — the driver-fired
    # suffix is deleted, and the worker plugin arms only off the harness's
    # phase sentinel. The guard stays: a repair prompt must never ask for
    # compaction, whatever the flag says.
    for _, text in client.sent_prompts:
        assert "okp_compact_session" not in text, (
            "the repair phase must never ask for compaction, whatever the flag says"
        )
        assert "CHUNK FINISHED" not in text, (
            "the deleted completion marker must not reappear in any prompt"
        )


# ── A2 PHASE SENTINEL — NOW THE WHOLE COMPACTION GATE ───────────────────────
#
# Run 1788462647 fired a self-compaction ~80s before the end of `feedback-2`.
# The arm keyed off CHUNK FINISHED, which the MODEL emits — the instruction
# lived only in the chunk prompts, but repair runs in the same session and the
# convention survived every compaction, so the model kept printing it while
# fixing gate failures. Nothing in the scoring path could see it.
#
# WO-MARKER-RIP deleted that condition outright, so the sentinel is no longer
# one gate of two: it is the only thing standing between an idle and a
# compaction, and these tests pin it as such. The HARNESS declares the phase,
# and it declares it before every prompt.


def test_compact_phase_classification_covers_every_phase_the_harness_drives() -> None:
    """Build is the initial pass and its chunks; everything else is repair."""
    for build_phase in ("initial", "initial-chunk-1", "initial-chunk-6"):
        assert compact_phase_for(build_phase) == "build", build_phase

    for repair_phase in ("feedback-1", "feedback-2"):
        assert compact_phase_for(repair_phase) == "repair", repair_phase


def test_exactly_one_drive_per_chunk_is_flagged_build() -> None:
    """The plugin's six-fire budget assumes six qualifying idles. This is it.

    A recovery nudge re-drive is held CONDITIONALLY (WO-25): it is published
    `repair` only when this chunk has already had its compaction, so the nudge
    can never spend a second fire; when the chunk has NOT compacted (the
    plugin gated the death), the normal phase is republished — `build` for a
    chunk — so the re-drive's completion can serve as the chunk's one real
    boundary. Either way a chunk spends at most one qualifying idle.
    """
    assert compact_phase_for("initial-chunk-3") == "build"


def test_an_unknown_phase_name_is_treated_as_repair() -> None:
    """Fail-closed on classification too.

    A phase nobody has reasoned about is not a proven-safe compaction point,
    and the cost of the two mistakes is not symmetric: refusing to compact at a
    real boundary aborts the cell loudly on no_compaction_evidence, while
    compacting at a phantom one corrupts a cell that still scores.
    """
    assert compact_phase_for("some-future-phase") == "repair"
    assert compact_phase_for("") == "repair"


def test_build_chunks_publish_the_build_phase_before_each_prompt(
    tmp_path: Path,
) -> None:
    """The chunked driver leaves the arm ENABLED — the other half of the pin.

    Without this, a fix that simply never publishes `build` would satisfy every
    repair-side assertion above while silently disarming compaction entirely.
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.metrics_script = [dict(_ZERO_METRICS), _metrics(1, 5, 2)]
    cell = _FakeCell()

    # The sentinel must be readable as `build` at the moment each prompt is
    # sent, not merely at the end of the drive.
    seen: list[str | None] = []
    original_send = client.send_prompt

    def _recording_send(*args: Any, **kwargs: Any) -> Any:
        seen.append(cell.compact_phase())
        return original_send(*args, **kwargs)

    client.send_prompt = _recording_send  # type: ignore[method-assign]

    runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_build",
        prompt="chunk one",
        run_label="cell-build",
        phase="initial-chunk-1",
    )

    assert seen == ["build"]
    assert cell.compact_phase() == "build"


def test_recovery_nudge_holds_ONLY_when_this_chunk_already_compacted(
    tmp_path: Path,
) -> None:
    """The hold is evidence-based, because both blanket answers are wrong.

    IT USED TO HOLD UNCONDITIONALLY, on the reasoning that "the boundary idle
    already fired at the loop-kill abort that triggered the nudge". That was
    true ONLY BECAUSE OF A DEFECT: the worker plugin fired its summarize on the
    idle a DYING stream emits, which is not a boundary at all.

    That defect is fixed in the plugin (it now refuses to summarize a turn a
    `session.error` killed), so on a gated death NOTHING fires — and holding
    then left the sentinel on `repair` through the chunk's real boundary, so
    `_settle_after_chunk` aborted the cell with `no_compaction_evidence`.
    Measured: run 1789127719, chunk 5, two nudges, cell dead.

    Never holding is equally wrong: the plugin's gate keys on `session.error`,
    and a turn that simply stops with no signal does not emit one. That death
    DOES compact, and an unheld re-drive would spend a second fire — the
    chunk-4 double-fire that exhausted the six-per-session budget by chunk 6.

    So the harness asks: has this chunk already had its compaction?
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.assistant_terminal_script = [{"info_error": _LOOP_SIG}]
    client.metrics_script = [
        dict(_ZERO_METRICS),  # phase baseline
        dict(_LOOP_METRICS),  # loop-killed read
        _metrics(8, 160, 70, guard_aborted=1),  # post-nudge read
    ]
    cell = _FakeCell()

    seen: list[str | None] = []
    original_send = client.send_prompt

    def _recording_send(*args: Any, **kwargs: Any) -> Any:
        seen.append(cell.compact_phase())
        result = original_send(*args, **kwargs)
        # THE DEATH COMPACTED — an ungated death, the case the hold exists for.
        # Appended DURING the first drive, because "already compacted" is
        # measured from the drive's own baseline: a message present before the
        # drive started is not this chunk's compaction.
        if len(seen) == 1:
            client._messages.append(
                {"info": {"role": "assistant", "agent": "compaction", "summary": True}}
            )
        return result

    client.send_prompt = _recording_send  # type: ignore[method-assign]

    runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_nudge_hold",
        prompt="chunk three",
        run_label="cell-nudge-hold",
        phase="initial-chunk-3",
    )

    assert seen[0] == "build", "the chunk's first drive is the boundary candidate"
    assert seen[1] == "repair", (
        "this chunk already compacted, so the re-drive must be HELD — an "
        "unheld one spends a second fire against the six-per-session budget"
    )


def test_recovery_nudge_is_NOT_held_when_nothing_compacted(tmp_path: Path) -> None:
    """A gated death leaves the re-drive free to be the chunk's real boundary.

    This is the case that killed run 1789127719. The plugin correctly refused to
    summarize the turn the stream killed, so no compaction landed — and the old
    unconditional hold then made the genuine boundary unable to compact either,
    which `_settle_after_chunk` turns into a cell abort.

    WO-25 makes this a REAL regression, not an absence-of-write: in the live
    system the loop-kill sidecar writes `repair` over the sentinel at its kill,
    so a harness that merely SKIPPED the hold would still leave the boundary
    disarmed — the restore has to be an ACTIVE republish of `build`. The
    injection below simulates the sidecar (literal `repair` into the sentinel
    file, after the kill lands and before the recovery probe), and the drive
    runs through the chunked path so the boundary is real: the plugin fires
    once at the settle (`compaction_on_idle="ok"`) and the settle's evidence
    check is what makes exit_code 0 mean "the boundary compacted".
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.assistant_terminal_script = [{"info_error": _LOOP_SIG}]
    client.compaction_on_idle = "ok"
    client.metrics_script = [
        dict(_ZERO_METRICS),
        dict(_LOOP_METRICS),
        _metrics(8, 160, 70, guard_aborted=1),
    ]
    # No compaction message DURING the drive: the plugin gated the death, as it
    # now does. The only compaction lands at the boundary settle, below.
    cell = _FakeCell()
    sentinel = Path(cell.config.compact_phase_host_path) / "phase"

    seen: list[str | None] = []
    original_send = client.send_prompt

    def _recording_send(*args: Any, **kwargs: Any) -> Any:
        seen.append(cell.compact_phase())
        result = original_send(*args, **kwargs)
        if len(seen) == 1:
            # THE SIDECAR, SIMULATED: the loop-kill sidecar writes `repair` at
            # its kill so the dying stream's own idle cannot fire a compaction.
            # Written AFTER the kill message landed (inside the first drive)
            # and BEFORE the recovery probe re-drives — the exact window in
            # which the harness must actively restore `build`.
            sentinel.write_text("repair\n", encoding="utf-8")
        return result

    client.send_prompt = _recording_send  # type: ignore[method-assign]

    # The hold probe reads `completed_compactions_since` immediately before it
    # republishes; the boundary settle reads it again after the fire. Recording
    # (sentinel, count) at each call pins BOTH ends: the probe must see the
    # sidecar's `repair` with zero compactions (fail open -> republish build),
    # and the settle must see `build` with exactly one compaction landed.
    probe_views: list[tuple[str | None, int]] = []
    original_count = client.completed_compactions_since

    def _recording_count(session_id: str, watermark: int) -> int:
        count = original_count(session_id, watermark)
        probe_views.append((cell.compact_phase(), count))
        return count

    client.completed_compactions_since = _recording_count  # type: ignore[method-assign]

    stats = runner._run_opencode_serve_chunked(
        active_cell=cell,
        serve_client=client,
        session_id="ses_nudge_free",
        prompts=["chunk three"],
        run_label="cell-nudge-free",
    )

    assert seen[0] == "build", "the chunk's first drive is the boundary candidate"
    assert seen[1] == "build", (
        "the sidecar wrote `repair` at the kill and nothing compacted, so the "
        "probe must ACTIVELY republish `build` — the re-drive's completion IS "
        "this chunk's one real boundary. Holding (or merely skipping the write "
        "and leaving the sidecar's `repair` in place) is what aborted run "
        "1789127719 with no_compaction_evidence"
    )
    # NO PREMATURE FIRE: at the probe the sentinel still reads the sidecar's
    # `repair` and zero compactions have landed. BOUNDARY FIRE: at the settle
    # the sentinel reads `build` and exactly one compaction has landed.
    assert probe_views == [("repair", 0), ("build", 1)]
    # The settle counted the fire (>=1 compaction) and the chunk spent exactly
    # one of the six-per-session budget — never two.
    assert stats.exit_code == 0
    assert stats.recovery_nudges == 1
    assert client.completed_compactions_since("ses_nudge_free", 0) == 1


def test_stall_writes_repair_before_its_abort_and_restores_build_at_the_boundary(
    tmp_path: Path,
) -> None:
    """WO-25 stall regression, BOTH halves in one drive.

    (a) NO PREMATURE FIRE. A stall has no sidecar — unlike the loop kill,
        nothing outside the harness disarms the fault's own idle. The abort
        that un-sticks the turn publishes a session.idle the worker plugin
        sees, so the harness must write `repair` BEFORE the abort/kill: with
        the sentinel still on `build`, that idle would fire a mid-stall
        compaction — a truncated turn's summarize the six-fire budget cannot
        spare.
    (b) RESTORE. The recovery probe then finds zero compactions since the
        drive's own watermark and must fail open — republish `build` — so the
        nudged re-drive's completion, this chunk's one real boundary, can
        fire. Evidenced end-to-end through the chunked settle: the plugin
        fires once (`compaction_on_idle="ok"`), the settle counts it
        (exit_code == 0), and exactly one compaction lands.
    """
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    # Stall ONCE, then the nudged re-drive goes idle.
    client.wait_script = [(False, "stalled"), (True, "idle")]
    client.compaction_on_idle = "ok"
    client.metrics_script = [
        dict(_ZERO_METRICS),  # phase baseline
        _metrics(5, 100, 40),  # stalled turn read (transcript clean — no signature)
        _metrics(8, 160, 70),  # post-nudge read (session-cumulative)
    ]
    cell = _FakeCell()

    seen: list[str | None] = []
    original_send = client.send_prompt

    def _recording_send(*args: Any, **kwargs: Any) -> Any:
        seen.append(cell.compact_phase())
        return original_send(*args, **kwargs)

    client.send_prompt = _recording_send  # type: ignore[method-assign]

    # The sentinel AS THE PLUGIN SEES IT at the stall's own abort idle: the
    # production order is publish-repair -> abort -> kill, so reading inside a
    # wrapped abort observes the exact moment the dying turn goes idle.
    at_abort: list[tuple[str | None, int]] = []
    original_abort = client.abort

    def _recording_abort(session_id: str) -> None:
        at_abort.append(
            (cell.compact_phase(), client.completed_compactions_since(session_id, 0))
        )
        return original_abort(session_id)

    client.abort = _recording_abort  # type: ignore[method-assign]

    stats = runner._run_opencode_serve_chunked(
        active_cell=cell,
        serve_client=client,
        session_id="ses_stall_boundary",
        prompts=["ONLY CHUNK"],
        run_label="cell-stall-boundary",
    )

    # (a) No premature fire: the abort idle reads `repair` — never `build` —
    #     and nothing had compacted at that point.
    assert at_abort == [("repair", 0)], (
        "the stall's abort publishes its own session.idle; the harness must "
        "write `repair` BEFORE the abort/kill so the plugin cannot fire a "
        "mid-stall compaction on it (a stall has no sidecar to do this)"
    )
    # (b) Restore: the first drive is the boundary candidate, and the recovery
    #     probe republishes `build` over the stall hold for the re-drive.
    assert seen == ["build", "build"], (
        "nothing compacted before the nudge, so the probe must fail open and "
        "restore `build` — holding the re-drive on `repair` strands the real "
        "boundary and _settle_after_chunk aborts with no_compaction_evidence"
    )
    # The boundary fired, the settle counted it (>=1 compaction), and the chunk
    # spent EXACTLY one fire of the six-per-session budget.
    assert stats.exit_code == 0
    assert stats.recovery_nudges == 1
    assert client.completed_compactions_since("ses_stall_boundary", 0) == 1
    # The stall was genuinely un-stuck (kill hook ran), not merely relabelled.
    assert cell.kill_calls == 1


def test_a_non_compacting_run_publishes_no_sentinel_at_all(tmp_path: Path) -> None:
    """No flag, no file. The sentinel is compaction's own machinery; a run that
    never compacts must not grow a directory it does not use."""
    runner = _make_runner(tmp_path, compact=False)
    client = _FakeServeClient()
    client.metrics_script = [dict(_ZERO_METRICS), _metrics(1, 5, 2)]
    cell = _FakeCell()

    runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_plain",
        prompt="chunk one",
        run_label="cell-plain",
        phase="initial-chunk-1",
    )

    assert cell.compact_phase() is None


def test_a_compacting_cell_with_no_sentinel_path_aborts_rather_than_drives(
    tmp_path: Path,
) -> None:
    """If the phase cannot be published, the worker keeps reading the PREVIOUS
    phase — at the build->repair transition that is the stale `build` that let
    the repair-round compaction through. Abort instead."""
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    cell = _FakeCell()
    cell.config.compact_phase_host_path = None

    with pytest.raises(ServeTransportError, match="phase sentinel"):
        runner._run_opencode_serve(
            active_cell=cell,
            serve_client=client,
            session_id="ses_nopath",
            prompt="chunk one",
            run_label="cell-nopath",
            phase="initial-chunk-1",
        )


def test_the_sentinel_is_rewritten_on_the_build_to_repair_transition(
    tmp_path: Path,
) -> None:
    """The transition itself, in one cell, through the real drive path."""
    runner = _make_runner(tmp_path, compact=True)
    client = _FakeServeClient()
    client.metrics_script = [
        dict(_ZERO_METRICS),
        _metrics(1, 5, 2),
        _metrics(1, 5, 2),
        _metrics(2, 9, 4),
    ]
    cell = _FakeCell()

    runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_txn",
        prompt="chunk six",
        run_label="cell-txn",
        phase="initial-chunk-6",
    )
    assert cell.compact_phase() == "build"

    runner._run_opencode_serve(
        active_cell=cell,
        serve_client=client,
        session_id="ses_txn",
        prompt="the dice never reroll",
        run_label="cell-txn",
        phase="feedback-1",
    )
    assert cell.compact_phase() == "repair"
