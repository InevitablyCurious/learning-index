#!/usr/bin/env python3
"""Rebuild bench-grader:v1 from grader/ — the one sanctioned way.

A bare ``docker build`` produces a working image that records nothing about
what it was built from, so the freshness check can only report it as
unverifiable. This computes the source digest (harness/grader_image.py) and bakes
it in as a label, giving the instrument the same kind of content-addressed
identity the corpus already has.

Output is docker's own, streamed through unchanged: the build log is the only
evidence of what happened, and rewriting it would hide which layer failed.

PROVEN AGAINST THE REFERENCE BEFORE IT SHIPS (2026-09-17). A grader change
once made two checks (F10, F14) unpassable by any game, the reference solution
included, and two runs were graded on them. So the build goes to a CANDIDATE
tag first, the challenge's reference solution (`<challenge>/golden`) is graded
with it, and the real tag moves only when every check passes. A failure leaves
the previous image in place and lists the checks the reference failed.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from harness.challenge_spec import default_spec

REPO = Path(__file__).resolve().parent.parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from harness.grader_image import (  # noqa: E402
    IMAGE,
    build_argv,
    source_digest,
)
from harness.grader_run import gate_argv  # noqa: E402

# ONE CANDIDATE TAG PER RUN. A shared name let two overlapping rebuilds delete
# each other's candidate: one promoted and removed it, and the other's promote
# then failed with "No such image" (2026-09-17) although its own proof passed.
CANDIDATE = f"{IMAGE}-candidate-{os.getpid()}"
GOLDEN = default_spec().golden_dir
GATES = default_spec().grader_dir
DOCKERFILE = REPO / "images" / "grader" / "Dockerfile"


def main() -> int:
    if not GATES.is_dir():
        print(f"gates directory not found: {GATES}", file=sys.stderr)
        return 2
    if not DOCKERFILE.is_file():
        print(f"grader Dockerfile not found: {DOCKERFILE}", file=sys.stderr)
        return 2

    if not GOLDEN.is_dir():
        print(
            f"reference solution not found: {GOLDEN} — a grader cannot ship without "
            "being proven against one",
            file=sys.stderr,
        )
        return 2

    digest = source_digest(GATES, DOCKERFILE)
    argv = build_argv(GATES, DOCKERFILE, image=CANDIDATE)
    print(f"building {CANDIDATE}")
    print(f"  source digest: {digest}")
    print(f"  $ {' '.join(argv)}\n", flush=True)

    code = subprocess.run(argv, cwd=REPO, check=False).returncode  # noqa: S603
    if code != 0:
        print(f"\ndocker build exited {code} — {IMAGE} was NOT replaced", file=sys.stderr)
        return code

    print(f"\ngrading the reference solution ({GOLDEN}) with {CANDIDATE}", flush=True)
    with tempfile.TemporaryDirectory(prefix="grader-proof-") as out:
        report_path = Path(out) / "reference-report.json"
        grade = gate_argv(
            worktree=GOLDEN, report_path=report_path, roster_path=None, attempt=None, image=CANDIDATE
        )
        subprocess.run(grade, cwd=REPO, check=False)  # noqa: S603
        try:
            report = json.loads(report_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"\nno readable report from the reference grade ({exc}) — {IMAGE} was NOT replaced", file=sys.stderr)
            return 1
    failed = [str(p.get("check", "?")) for p in report.get("problems") or []]
    if report.get("verdict") != "PASS" or failed:
        print(f"\nthe reference solution FAILS this grader — {IMAGE} was NOT replaced:", file=sys.stderr)
        for check in failed:
            print(f"  - {check}", file=sys.stderr)
        return 1

    code = subprocess.run(["docker", "tag", CANDIDATE, IMAGE], check=False).returncode  # noqa: S603, S607
    if code != 0:
        print(f"\ndocker tag exited {code} — {IMAGE} was NOT replaced", file=sys.stderr)
        return code
    subprocess.run(["docker", "rmi", CANDIDATE], check=False, capture_output=True)  # noqa: S603, S607
    print(f"\n{IMAGE} built and proven — the reference solution passes every check — source digest {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
