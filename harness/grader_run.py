"""Build the command that grades one attempt — always in the grading container.

WHY THERE IS NO HOST MODE
-------------------------
Grading used to run on the operator's machine with whatever was installed there.
That is the defect `images/grader/Dockerfile` exists to remove, and an
``if host: ...`` escape hatch would preserve it — the path that hides the
problem is the path people fall back to when the container is inconvenient, and
then a result exists that nobody can reproduce.

A missing or stale image is therefore an ABORT with an instruction, never a
quiet fall back to the host. Same rule as the rest of the harness (`07` (c)): a
degraded run must be loud.

WHAT THE CONTAINER CAN SEE
--------------------------
Exactly three things, and only one of them writable:

  /candidate   the model's worktree, READ-ONLY — grading must not be able to
               edit the thing it is measuring
  /roster.json the gate roster, read-only
  /out         the cell directory, where the one report is written

A caller may OPTIONALLY pass ``gates_dir`` to overlay the grader source over
``/gates``, file by file and READ-ONLY. That exists for one situation: the
image is stale (built before the source on disk) and must not be rebuilt —
overlaying the current source makes the grade measure with today's grader
instead of the baked one. The file list is ``baked_paths``, the same
"what is baked" definition the builder hashes, so the overlay cannot drift
from the image by a hard-coded list. It never covers ``node_modules``: the
image's copy is the linux build the container runs, and a host copy would
shadow it. Absent ``gates_dir`` nothing changes — grading runs the baked
source, which is the normal case.

No network (``--network none``): every server the gates start is local to the
container, so nothing legitimate needs egress, and a candidate that tries to
reach the outside during grading should fail rather than succeed quietly.
"""

from __future__ import annotations

from pathlib import Path

from harness.grader_image import IMAGE, baked_paths, image_digest

#: Mount points inside the container. Fixed by the image, so no caller has to
#: agree with them separately.
CANDIDATE = "/candidate"
ROSTER = "/roster.json"
OUT = "/out"
GATES = "/gates"


class GraderImageMissing(RuntimeError):
    """The grading image is absent. Grading cannot proceed and must not degrade."""


def assert_image_available(image: str = IMAGE) -> None:
    """Abort with the fix, rather than grading in some other environment."""
    if image_digest(image) is None:
        raise GraderImageMissing(
            f"the grading image {image} is not built (or was not built by the "
            "sanctioned builder, so it carries no source digest). Grading runs "
            "only in that image — the toolchain and the Node version have to be "
            "the ones the candidate was built against, not whatever this host "
            "happens to have. Build it with:\n"
            "    python3 scripts/rebuild_grader_image.py"
        )


def container_name(report_path: Path, *, run_identity: str | None = None) -> str:
    """A deterministic name for the grading container.

    ── WHY IT NEEDS ONE ────────────────────────────────────────────────────────

    The harness's gate watchdog kills the PROCESS GROUP it spawned. That group
    contains the `docker` CLI, not the container: the container is a child of
    the daemon and would keep running, still holding the candidate's mount and
    still burning CPU, with nothing left that knows its id.

    A name the caller can compute without the client makes it killable. Derived
    from the report path, so it identifies the cell and the attempt rather than
    being a random id nobody can trace back. When ``run_identity`` is given it
    rides FIRST in the derived part, so the ``[:120]`` clip takes the tail and
    never the id — concurrent run-instances cannot collide on this name.
    """
    cell = report_path.parent.name or "cell"
    stem = report_path.stem  # attempt-N-report
    identity = f"{run_identity}-" if run_identity else ""
    safe = "".join(
        ch if ch.isalnum() or ch in "-_" else "-" for ch in f"{identity}{cell}-{stem}"
    )
    return f"bench-grade-{safe.strip('-').lower()}"[:120]


def kill_container(name: str) -> None:
    """Stop a grading container by name. Never raises; absence is the goal state."""
    import subprocess

    try:
        subprocess.run(  # noqa: S603 - fixed argv
            ["docker", "kill", name],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        # Docker unreachable, or it is already gone. Either way nothing to stop.
        pass


def gate_argv(
    *,
    worktree: Path,
    report_path: Path,
    roster_path: Path | None,
    attempt: int | None,
    worker_target: float | None = None,
    workers: int | None = None,
    image: str = IMAGE,
    run_identity: str | None = None,
    layer: int | None = None,
    gates_dir: Path | None = None,
) -> list[str]:
    """`docker run ...` for one grading pass.

    ``report_path`` must sit inside the cell directory: its PARENT is mounted as
    the only writable path, and the report is written by name inside it.

    ``gates_dir`` is the optional source overlay: when given, every file
    ``baked_paths`` says the image bakes is mounted read-only over its
    ``/gates`` path, so a stale image still grades with the source on disk. It
    is for a stale image that must NOT be rebuilt — the normal case passes
    nothing and grades the baked source. ``node_modules`` is never overlaid:
    the image's is the linux build the container runs, and a host copy mounted
    over it would shadow it.
    """
    out_dir = report_path.parent.resolve()
    argv = [
        "docker",
        "run",
        "--rm",
        # Named so the watchdog can reach it: killing the CLI leaves the
        # container running, because it belongs to the daemon and not to the
        # process group the harness spawned. See `container_name`.
        "--name",
        container_name(report_path, run_identity=run_identity),
        "--network",
        "none",
        "-v",
        f"{worktree.resolve()}:{CANDIDATE}:ro",
        "-v",
        f"{out_dir}:{OUT}",
    ]
    if roster_path is not None and roster_path.is_file():
        argv += ["-v", f"{roster_path.resolve()}:{ROSTER}:ro"]
    # The operator's knob, passed through rather than read from the host: the
    # container resolves worker count from its OWN limits and this only scales
    # the fraction of them it uses.
    if worker_target is not None:
        argv += ["-e", f"BENCH_WORKER_TARGET={worker_target}"]
    if workers is not None:
        argv += ["-e", f"BENCH_WORKERS={int(workers)}"]

    # ── OPTIONAL SOURCE OVERLAY (stale image, no rebuild) ──────────────────
    #
    # Read-only, one mount per baked file, so the container's /gates is the
    # source on disk. The list comes from `baked_paths` — the builder's own
    # definition of what is baked — never a hand-maintained list here: two
    # definitions of "the grader source" would drift and the overlay would
    # silently stop covering a new file. `node_modules` is excluded by that
    # same definition, and it must stay excluded: the image's copy is the
    # linux build, and a host copy would shadow it.
    if gates_dir is not None:
        for path in baked_paths(gates_dir):
            argv += [
                "-v",
                f"{path.resolve()}:{GATES}/{path.relative_to(gates_dir).as_posix()}:ro",
            ]

    argv += [image, "--target", CANDIDATE, "--out", f"{OUT}/{report_path.name}"]
    if roster_path is not None and roster_path.is_file():
        argv += ["--roster", ROSTER]
    if attempt is not None:
        argv += ["--attempt", str(attempt)]
    # Which pass to grade, as an argument of the grading run itself. Never an
    # env var: the note above keeps the operator's knobs and the run's scope
    # apart, and the container must not inherit a layer from its environment.
    if layer is not None:
        argv += ["--layer", str(layer)]
    return argv
