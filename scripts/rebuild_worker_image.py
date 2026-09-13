#!/usr/bin/env python3
"""Rebuild okp-bench-worker:v1 from images/worker — the one sanctioned way.

A bare ``docker build`` still produces a working image, but it records nothing
about what it was built from, and preflight then has to report the image as
unverifiable. This computes the source digest (harness/worker_image.py) and bakes
it in, so the freshness check has something CONTENT-based to compare against
instead of a timestamp docker never moves on a cache hit.

Output is docker's own, streamed through unchanged: the build log is the only
evidence of what happened, and rewriting it would hide which layer failed.

The plugin tree to bake in comes from ``OKP_BENCH_PLUGIN_DIR`` (the seam every
consumer reads, so the builder and the freshness check agree on what this
installation builds), and ``--plugin-dir <path>`` overrides it for a one-off
build. With neither, the build is vanilla — which is what a bare clone gets.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from harness.worker_image import (  # noqa: E402
    ENV_PLUGIN_DIR,
    IMAGE,
    build_argv,
    configured_plugin_dir,
    source_digest,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=f"Rebuild {IMAGE} from images/worker.")
    parser.add_argument(
        "--plugin-dir",
        type=Path,
        default=None,
        help="plugin tree (must contain package.json) to inject as the okp-plugin build context",
    )
    plugin_dir: Path | None = parser.parse_args().plugin_dir

    # ── THE SEAM IS THE DEFAULT; THE FLAG IS AN OVERRIDE ────────────────────
    #
    # The board's REBUILD WORKER button invokes this script with NO arguments,
    # so before the seam existed, pressing it replaced a plugin-bearing image
    # with a vanilla one. Nothing said so: the label flipped to
    # `plugin_present=0`, and opencode swallows a missing plugin without a word,
    # so the next ON cell would simply have no extraction tool and no error.
    #
    # Reading the seam here means the button, the dev Makefile and preflight all
    # answer the same question — "what does this installation build?" — and a
    # bare clone with the seam unset still builds vanilla, which is correct.
    from_seam = False
    if plugin_dir is None:
        plugin_dir = configured_plugin_dir()
        from_seam = plugin_dir is not None

    if plugin_dir is not None and not (plugin_dir / "package.json").is_file():
        where = f"{ENV_PLUGIN_DIR}={plugin_dir}" if from_seam else f"--plugin-dir {plugin_dir}"
        print(f"{where} has no package.json — not a plugin tree", file=sys.stderr)
        return 2

    if shutil.which("docker") is None:
        print("docker is not on PATH — cannot build the worker image", file=sys.stderr)
        return 2

    worker_dir = REPO / "images" / "worker"
    if not (worker_dir / "Dockerfile").is_file():
        print(f"no Dockerfile at {worker_dir / 'Dockerfile'}", file=sys.stderr)
        return 2

    digest = source_digest(worker_dir, plugin_dir)
    print(f"building {IMAGE} from {worker_dir}")
    if plugin_dir is not None:
        print(f"injecting plugin context from {plugin_dir}" + (f" (via {ENV_PLUGIN_DIR})" if from_seam else ""))
    else:
        # SAY WHEN A BUILD IS VANILLA. A dev machine that has lost the seam
        # builds a plugin-less image that looks identical from the outside, and
        # the failure only surfaces as a cell with no extraction tool.
        print(f"no plugin configured ({ENV_PLUGIN_DIR} unset) — building vanilla")
    print(f"source digest {digest[:12]}" + (" (plugin-inclusive)" if plugin_dir is not None else ""))
    sys.stdout.flush()

    code = subprocess.run(build_argv(worker_dir, plugin_dir=plugin_dir), cwd=REPO, check=False).returncode
    if code != 0:
        print(f"\ndocker build exited {code} — the image was NOT replaced", file=sys.stderr)
        return code

    print(f"\n{IMAGE} now carries source digest {digest[:12]} — preflight will read it back")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
