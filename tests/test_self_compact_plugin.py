"""The benchmark's self-compaction plugin passes its own test suite.

`images/worker/self-compact.ts` is baked into every worker image, and its
behaviour (phase gate, fire budget, debounce, dead-turn guard) is pinned by
`images/worker/self-compact.test.ts`, a node:test suite. This runs that suite as
a real subprocess so the Python test run — the one CI executes — covers it.

`--experimental-strip-types` runs the TypeScript directly: the plugin uses only
erasable type syntax and a type-only import, which is also what lets the plain
worker image load it with no @opencode-ai packages installed.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SUITE = REPO / "images" / "worker" / "self-compact.test.ts"


def test_self_compact_plugin_suite_passes() -> None:
    proc = subprocess.run(
        ["node", "--experimental-strip-types", "--test", str(SUITE)],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=55,
        check=False,
    )
    assert proc.returncode == 0, (
        f"self-compact.test.ts failed (exit {proc.returncode}):\n"
        f"{proc.stdout[-4000:]}\n{proc.stderr[-2000:]}"
    )
