"""Is `bench-grader:v1` built from the gates on disk?

WHY THIS MODULE EXISTS
----------------------
The candidate is BUILT inside the worker image (node:22.12.0, digest-pinned)
and used to be GRADED on whatever the operator had installed. Four things
differed — Node, Playwright, Chromium, and vitest, the last of which was
declared as a RANGE (``^2.1.0``) and so could change itself on a reinstall.
``compute_grader_hash`` excludes ``node_modules``, so nothing recorded which
toolchain actually ran.

The corpus is frozen byte-for-byte and a cell ABORTS on a mismatch. The
instrument measuring it was not pinned at all. This module is half of closing
that: the image is the instrument, and this gives it a content-addressed
identity so "is the grader current?" has the same kind of answer as "is the
scaffold frozen?".

Deliberately mirrors ``harness/worker_image.py`` — same digest shape, same label
mechanism, same one-sanctioned-builder rule. A second convention for the same
question is how two checks drift into disagreeing.
"""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

from harness.challenge_spec import default_spec

# ONE IMAGE PER CHALLENGE. The image bakes the challenge's gate suite, so a
# shared tag would let one challenge's instrument grade another's candidate.
IMAGE = f"bench-grader:{default_spec().name}"
LABEL = "okp.grader.source_digest"

#: Never baked, and never hashed. ``node_modules`` is the point: the toolchain
#: is installed inside the image from the lockfile, so including a host copy
#: would make the identity depend on the machine that built it.
BAKED_EXCLUDED = frozenset({"node_modules", "test-results", ".git"})


def baked_paths(gates_dir: Path) -> list[Path]:
    """Every file that goes into the image, in no particular order."""
    out: list[Path] = []
    for path in gates_dir.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        rel = path.relative_to(gates_dir)
        if rel.name == ".DS_Store" or any(part in BAKED_EXCLUDED for part in rel.parts):
            continue
        out.append(path)
    return out


def source_digest(gates_dir: Path, dockerfile: Path) -> str:
    """sha256 over the baked file set — path AND content, in a stable order.

    The Dockerfile is included under ``Dockerfile``: it pins the base image
    digest and the install commands, so a change to it is a change to the
    instrument even when no gate moved.
    """
    entries: list[tuple[str, Path]] = [
        (p.relative_to(gates_dir).as_posix(), p) for p in baked_paths(gates_dir)
    ]
    entries.append(("Dockerfile", dockerfile))
    h = hashlib.sha256()
    for rel, path in sorted(entries, key=lambda e: e[0]):
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(hashlib.sha256(path.read_bytes()).digest())
    return h.hexdigest()


def image_digest(image: str = IMAGE) -> str | None:
    """The digest baked into the built image, or None when it is absent.

    None means "no image" or "an image built by something other than the
    sanctioned builder" — both of which preflight reports as unverifiable
    rather than guessing.
    """
    try:
        out = subprocess.run(  # noqa: S603 - fixed argv
            ["docker", "image", "inspect", image, "--format", f"{{{{ index .Config.Labels \"{LABEL}\" }}}}"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    if out.returncode != 0:
        return None
    value = (out.stdout or "").strip()
    return value or None


def is_current(gates_dir: Path, dockerfile: Path, image: str = IMAGE) -> bool:
    """Same bytes in the image as on disk."""
    baked = image_digest(image)
    return baked is not None and baked == source_digest(gates_dir, dockerfile)


def build_argv(gates_dir: Path, dockerfile: Path, image: str = IMAGE) -> list[str]:
    """The ONE sanctioned build command.

    The context is the gates directory, not the Dockerfile's directory: the
    image installs the lockfile and copies the gates, and both live there.
    """
    return [
        "docker",
        "build",
        "-f",
        str(dockerfile),
        "-t",
        image,
        "--build-arg",
        f"OKP_GRADER_SOURCE_DIGEST={source_digest(gates_dir, dockerfile)}",
        str(gates_dir),
    ]
