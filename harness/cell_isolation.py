"""CELL ISOLATION PREFLIGHT — prove the slate is clean before a cell starts.

WHY A SEPARATE, VERIFYING STEP (2026-08-26)

Three mechanisms already try to isolate a cell:

  1. the worktree is ``shutil.rmtree``'d and re-seeded from ``tasks/*/scaffold``
  2. a stale container of the same name is ``docker rm -f``'d before launch
  3. the session-DB volume is ``docker volume rm -f``'d before create

Each is a REMOVAL, and not one of them CHECKS. `docker rm` can exit 0 while a
container lingers on a wedged daemon; `rmtree` can partially fail on a busy
mount; a scaffold copy can leave a file behind that nobody notices. Every one
of those failures is silent, and the cell runs anyway — on top of whatever
survived.

That is the difference that matters here. A benchmark measures the model, so
any file the model did NOT write in THIS cell is a lie in the measurement, and
back-to-back runs of the SAME model are exactly the case where inherited work
is both most likely and hardest to spot: the leftovers look plausible because
the same model wrote them.

So this module asserts, and fails LOUD before the container exists. A refused
launch costs one restart; a contaminated cell costs the run and is not
detectable after the fact.

WHAT THIS MUST NEVER TOUCH

The memory system is a SEPARATE, SEPARATELY-MANAGED process and its survival
across runs is the point of the experiment — the corpus is what an ON cell
recalls from. Nothing here reads, writes, or removes hub, MCP, Postgres, Qdrant
or any ``okp-server_*`` volume. The docker checks are scoped to two exact
names derived from the cell's own container name, and this module never
enumerates or deletes by wildcard.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
import subprocess


class CellIsolationError(RuntimeError):
    """The slate is not clean. Raised BEFORE a cell starts, never after."""


# Written into the worktree by the harness after seeding, so they are expected
# on top of the scaffold's own files.
HARNESS_SEEDED = frozenset({"AGENTS.md"})


def _relative_files(root: Path, *, skip_dirs: frozenset[str] = frozenset()) -> set[str]:
    """Every file under ``root`` as a POSIX relative path."""
    out: set[str] = set()
    if not root.is_dir():
        return out
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if skip_dirs and rel.parts and rel.parts[0] in skip_dirs:
            continue
        out.add(rel.as_posix())
    return out


def _digest(path: Path) -> str:
    """Content hash of one file; a sentinel when it cannot be read."""
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as exc:
        return f"<unreadable:{exc.__class__.__name__}>"


def worktree_drift(
    *, worktree: Path, scaffold: Path
) -> tuple[set[str], set[str], set[str]]:
    """(unexpected, missing, modified) files in ``worktree`` against ``scaffold``.

    CONTENT, NOT JUST NAMES. The first version of this compared file SETS and
    was useless against the exact hazard it was written for: the scaffold ships
    stub `src/game.ts`, `src/ai.ts`, `src/server.ts` and `public/app.js`, so a
    previous cell's implementation survives IN PLACE, under a filename the
    scaffold already has. A name-only check passes that and reports "clean" —
    verified against the real scaffold, which is why it is hashed now.

    ``modified`` is therefore the load-bearing set: it is what "this model
    inherited the previous model's work" actually looks like on disk.

    ``.git`` is skipped: it does not exist at the check point, and re-running
    the check later must not trip over it.
    """
    scaffold_files = _relative_files(scaffold)
    actual = _relative_files(worktree, skip_dirs=frozenset({".git"}))
    expected = scaffold_files | set(HARNESS_SEEDED)

    unexpected = actual - expected
    missing = expected - actual

    # Only scaffold-owned files can be "modified" — the harness writes
    # AGENTS.md itself, so its content is not the scaffold's business.
    modified = {
        rel
        for rel in (scaffold_files & actual)
        if _digest(scaffold / rel) != _digest(worktree / rel)
    }
    return unexpected, missing, modified


def _assert_drift_free(
    *, worktree: Path, expected_path: Path, expected_label: str
) -> None:
    """Raise unless ``worktree`` matches the expected tree at ``expected_path``.

    Shared message-building for the two preflight assertions. Only the header
    noun+path varies with the declared expected tree; the per-category lines
    are byte-identical, so a failure reads the same whichever tree was
    declared and the check is swapped, never bypassed.
    """
    unexpected, missing, modified = worktree_drift(
        worktree=worktree, scaffold=expected_path
    )
    if not unexpected and not missing and not modified:
        return

    def _list(names: set[str]) -> str:
        shown = sorted(names)[:20]
        return ", ".join(shown) + (" …" if len(names) > len(shown) else "")

    lines = [
        f"CELL ISOLATION FAILED: the seeded worktree at {worktree} does not match "
        f"the {expected_label} at {expected_path}."
    ]
    if modified:
        lines.append(
            f"  {len(modified)} MODIFIED scaffold file(s) — content differs from the "
            f"stub this cell was supposed to start from, i.e. work inherited from a "
            f"previous cell: " + _list(modified)
        )
    if unexpected:
        lines.append(
            f"  {len(unexpected)} UNEXPECTED file(s) — not written by this cell, so "
            f"any measurement over them is inherited work, not a result: "
            + _list(unexpected)
        )
    if missing:
        lines.append(
            f"  {len(missing)} MISSING scaffold file(s) — the cell would fail gates "
            f"for work it was never given: " + _list(missing)
        )
    lines.append(
        "  Nothing was launched. Remove the run directory and start again; if this "
        "repeats, the seed step is failing silently and the removal in "
        "the challenge adapter is not taking effect."
    )
    raise CellIsolationError("\n".join(lines))


def assert_clean_worktree(*, worktree: Path, scaffold: Path) -> None:
    """Raise unless the seeded worktree is byte-identical to the scaffold.

    MODIFIED files are the dangerous direction and the reason this exists: a
    stub the previous cell's model filled in, surviving into this one under the
    same name. UNEXPECTED files are new files it added. MISSING files are
    reported in the same breath because a half-copied scaffold produces gate
    failures that look like capability results.
    """
    _assert_drift_free(
        worktree=worktree, expected_path=scaffold, expected_label="scaffold"
    )


def assert_seeded_from_snapshot(*, worktree: Path, snapshot_tree: Path) -> None:
    """Raise unless the seeded worktree is byte-identical to the DECLARED SNAPSHOT.

    The same check as ``assert_clean_worktree`` with the expected tree SWAPPED,
    never bypassed: ``snapshot_tree`` is a captured snapshot's ``tree/`` —
    ``.git``-free and ``AGENTS.md``-free by construction (``SNAPSHOT_EXCLUDED``
    in snapshot.py) — and ``HARNESS_SEEDED`` still accounts for the harness's
    own AGENTS.md on top of it. A worktree that drifts from the declared
    snapshot means the seed did not produce the slate this cell declared it
    would start from: inherited work, or a half-copied snapshot.
    """
    _assert_drift_free(
        worktree=worktree,
        expected_path=snapshot_tree,
        expected_label="declared snapshot tree",
    )


def _docker_stdout(args: list[str]) -> str | None:
    """Run a read-only docker query. None when docker cannot be consulted."""
    try:
        done = subprocess.run(
            ["docker", *args], capture_output=True, text=True, check=False
        )
    except (FileNotFoundError, OSError):
        return None
    if done.returncode != 0:
        return None
    return done.stdout


def docker_residue(*, container_name: str) -> list[str]:
    """Leftovers for THIS cell only, by exact name. Empty when clean.

    Scoped deliberately: exactly one container name and the one volume derived
    from it. No wildcard, no enumeration — the memory system's containers and
    volumes are never in scope and cannot be caught by accident.
    """
    residue: list[str] = []

    containers = _docker_stdout(
        ["ps", "-a", "--filter", f"name=^{container_name}$", "--format", "{{.Names}}"]
    )
    if containers and container_name in containers.split():
        residue.append(f"container {container_name}")

    volume = f"{container_name}-session-db"
    volumes = _docker_stdout(
        ["volume", "ls", "--filter", f"name=^{volume}$", "--format", "{{.Name}}"]
    )
    if volumes and volume in volumes.split():
        residue.append(f"volume {volume}")

    return residue


def assert_no_docker_residue(*, container_name: str) -> None:
    """Raise if this cell's container or session-DB volume still exists.

    Runs AFTER the harness's own `docker rm -f` / `volume rm -f`, so anything
    found here means a removal reported success without taking effect — the
    silent-failure mode the removals cannot detect on their own.

    A docker daemon that cannot be queried is NOT treated as residue: an
    unavailable daemon is its own loud failure moments later at container
    launch, and inventing an isolation error here would misname it.
    """
    residue = docker_residue(container_name=container_name)
    if not residue:
        return
    raise CellIsolationError(
        "CELL ISOLATION FAILED: state from a previous cell of this name survived "
        "its removal — " + "; ".join(residue) + ".\n"
        "  A session DB or container carried over would let this cell inherit the "
        "previous one's transcript or filesystem, which the measurement cannot "
        "distinguish from work this model did.\n"
        f"  Nothing was launched. Clear it with: docker rm -f {container_name} && "
        f"docker volume rm -f {container_name}-session-db"
    )
