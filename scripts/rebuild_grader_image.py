#!/usr/bin/env python3
"""Rebuild okp-bench-grader:v1 from tasks/backgammon/gates — the one sanctioned way.

A bare ``docker build`` produces a working image that records nothing about
what it was built from, so the freshness check can only report it as
unverifiable. This computes the source digest (bench/grader_image.py) and bakes
it in as a label, giving the instrument the same kind of content-addressed
identity the corpus already has.

Output is docker's own, streamed through unchanged: the build log is the only
evidence of what happened, and rewriting it would hide which layer failed.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from bench.grader_image import (  # noqa: E402
    IMAGE,
    build_argv,
    source_digest,
)

GATES = REPO / "tasks" / "backgammon" / "gates"
DOCKERFILE = REPO / "docker" / "grader" / "Dockerfile"


def main() -> int:
    if not GATES.is_dir():
        print(f"gates directory not found: {GATES}", file=sys.stderr)
        return 2
    if not DOCKERFILE.is_file():
        print(f"grader Dockerfile not found: {DOCKERFILE}", file=sys.stderr)
        return 2

    digest = source_digest(GATES, DOCKERFILE)
    argv = build_argv(GATES, DOCKERFILE)
    print(f"building {IMAGE}")
    print(f"  source digest: {digest}")
    print(f"  $ {' '.join(argv)}\n", flush=True)

    code = subprocess.run(argv, cwd=REPO, check=False).returncode  # noqa: S603
    if code != 0:
        print(f"\ndocker build exited {code} — the image was NOT replaced", file=sys.stderr)
        return code

    print(f"\n{IMAGE} built — source digest {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
