#!/usr/bin/env python3
"""Freeze a challenge's starting files, so two runs of it are comparable.

The hash covers every file the model starts from. Changing any of them makes
previously scored cells incomparable, which is why the run path refuses to start
until the challenge's manifest names the hash it expects.

    python3 scripts/freeze_challenge.py            # print the live hash
    python3 scripts/freeze_challenge.py --write    # record it in challenge.json

`BENCH_TASK_DIR` selects the challenge; unset means the bundled example.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))
if str(REPO / "scripts") not in sys.path:
    sys.path.insert(0, str(REPO / "scripts"))

from run_cumulative.template import compute_task_template_hash  # noqa: E402

from harness.challenge_spec import default_spec  # noqa: E402


def main() -> int:
    spec = default_spec()
    live = compute_task_template_hash(spec.scaffold_dir)
    if live is None:
        print(f"no starting files to freeze at {spec.scaffold_dir}", file=sys.stderr)
        return 2

    manifest = spec.dir / "challenge.json"
    print(f"challenge: {spec.name}")
    print(f"  starting files: {spec.scaffold_dir}")
    print(f"  live hash:      {live}")
    print(f"  declared:       {spec.scaffold_hash or '(none yet)'}")

    if "--write" not in sys.argv[1:]:
        if spec.scaffold_hash == live:
            print("\nalready frozen at this hash — nothing to do")
        else:
            print(f"\nto record it:   python3 {Path(__file__).name} --write")
        return 0

    raw = json.loads(manifest.read_text(encoding="utf-8"))
    raw["scaffold_hash"] = live
    manifest.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\nwrote scaffold_hash to {manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
