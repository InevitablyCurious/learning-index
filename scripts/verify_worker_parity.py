#!/usr/bin/env python3
"""Parallelism must change how LONG grading takes, never WHAT it reports.

THE RISK THIS EXISTS TO CATCH
-----------------------------
Workers compete for the machine. A starved worker can blow a wait it would
otherwise have met — and the gate then fails because the host was busy, not
because the candidate was wrong. That is a false failure whose value depends on
the hardware, which is the one thing a benchmark cannot have.

So the claim "parallelism is safe" is not argued, it is checked: grade the
GOLDEN at one worker and at the maximum, and require the two reports to agree
gate for gate. The golden is the subject because it is the measurement standard
and is expected to be deterministic — a candidate would fold its own flakiness
into the answer (see G15 in `02`, which flips on byte-identical code).

Exit 0 when they agree, 1 when they do not, 2 when the check could not run —
never a pass on absence of evidence.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from harness.challenge_spec import default_spec

REPO = Path(__file__).resolve().parent.parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from harness.grader_image import IMAGE  # noqa: E402

GOLDEN = REPO / "task" / "backgammon" / "golden"
GATES = default_spec().grader_dir


def grade(workers: int, out_dir: Path, roster: Path) -> dict:
    out = out_dir / f"w{workers}.json"
    argv = [
        "docker",
        "run",
        "--rm",
        "-e",
        f"BENCH_WORKERS={workers}",
        "-v",
        f"{GOLDEN}:/candidate:ro",
        "-v",
        f"{out_dir}:/out",
        IMAGE,
        "--target",
        "/candidate",
        "--roster",
        f"/out/{roster.name}",
        "--out",
        f"/out/{out.name}",
    ]
    proc = subprocess.run(argv, capture_output=True, text=True, check=False)  # noqa: S603
    if not out.is_file():
        print(f"grading at {workers} worker(s) produced no report", file=sys.stderr)
        print(proc.stdout[-2000:], file=sys.stderr)
        print(proc.stderr[-2000:], file=sys.stderr)
        raise SystemExit(2)
    return json.loads(out.read_text())


def main() -> int:
    max_workers = int(sys.argv[1]) if len(sys.argv) > 1 else 8

    with tempfile.TemporaryDirectory() as tmp:
        out_dir = Path(tmp)
        roster = out_dir / "roster.json"
        subprocess.run(  # noqa: S603
            ["node", "roster.mjs", "--out", str(roster)],
            cwd=GATES,
            check=True,
            capture_output=True,
        )

        print(f"grading the golden at 1 worker and at {max_workers} ...", flush=True)
        one = grade(1, out_dir, roster)
        many = grade(max_workers, out_dir, roster)

    a = {g["id"]: g["status"] for g in one.get("gate_results", [])}
    b = {g["id"]: g["status"] for g in many.get("gate_results", [])}
    disagree = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))

    print(f"  1 worker  : {one['verdict']} {one['gate_totals']}")
    print(f"  {max_workers} workers: {many['verdict']} {many['gate_totals']}")
    print(f"  gates compared: {len(set(a) | set(b))}")

    if disagree:
        print(f"\nPARITY BROKEN — {len(disagree)} gate(s) differ:", file=sys.stderr)
        for k in disagree:
            print(
                f"  {k}\n    1 worker={a.get(k)}  {max_workers} workers={b.get(k)}",
                file=sys.stderr,
            )
        print(
            "\nParallelism is changing what the grader reports. Until this is "
            "fixed, grade with BENCH_WORKERS=1.",
            file=sys.stderr,
        )
        return 1

    # A pass count that matches by accident is not parity. The golden must also
    # actually be green, or "they agree" could mean "both broken the same way".
    if one["gate_totals"]["pass"] != one["gate_totals"]["total"]:
        print(
            "\nthe golden did not grade clean — parity is meaningless", file=sys.stderr
        )
        return 1

    print("\nparity holds: identical gate-for-gate, and the golden is green")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
