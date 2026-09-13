"""Is `okp-bench-worker:v1` built from the source on disk?

WHY THIS MODULE EXISTS (2026-09-03)
-----------------------------------
The check used to be ``newest mtime under docker/worker > image .Created``, and
it could not be cleared. Docker is CONTENT-addressed: re-saving a file without
changing a byte bumps its mtime, the build is a full cache hit, the same image
id keeps its original creation time — and the check keeps reporting "stale"
forever. Pressing REBUILD ran a real, successful build and changed nothing the
check could see, which reads exactly like a button that does nothing.

So freshness is now asked the way docker itself answers it: a DIGEST OF THE
SOURCE, computed here, baked into the image as a label at build time, and read
back out. Same bytes in the image as on disk -> current. Different -> stale, and
a rebuild genuinely fixes it.

ONE DEFINITION, TWO CALLERS. Preflight reads the digest; the rebuild writes it.
Both call this module, so they cannot drift into disagreeing about what "the
source" is — the failure that put a permanently-red check on the board.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path

IMAGE = "okp-bench-worker:v1"

#: THE PLUGIN SEAM. Absolute path to a plugin tree to bake into the worker image.
#:
#: WHY AN ENV VAR AND NOT A PATH IN THIS REPO. The plugin is the MEMORY LAYER's,
#: shipped by the memory side and re-homed out of the public bench tree. `bench/`
#: must clone and run out of the box, so it cannot know where anyone's plugin
#: lives -- the same reason `OKP_BENCH_TOOLS_MANIFEST` and
#: `OKP_BENCH_STATS_MANIFEST` exist. Unset, which is what a fresh clone gets, is
#: a VANILLA build: correct, and not an error.
#:
#: WHY BOTH SIDES MUST READ IT. The freshness check asks "is this image what this
#: installation would build right now?" -- and it can only ask that if the
#: builder and the checker agree on what this installation builds. They did not:
#: the rebuild took the plugin from a CLI flag the dev Makefile passed, while
#: preflight computed a vanilla digest and flagged every dev image stale. Worse,
#: the board's REBUILD WORKER button passed no flag at all, so pressing it
#: silently replaced a plugin-bearing image with a vanilla one -- and opencode
#: swallows a missing plugin without a word, so the next ON cell would simply
#: have no extraction tool.
ENV_PLUGIN_DIR = "OKP_BENCH_PLUGIN_DIR"


def configured_plugin_dir(env: dict | None = None) -> Path | None:
    """The plugin tree this installation builds with, or None for vanilla.

    Resolved on every call rather than cached: the control plane is long-lived
    and its environment is set when it starts, so a cached miss would keep a
    whole session building vanilla after the seam was exported.

    A path that does not exist returns None. Reporting "configured" for a tree
    that is not there would make the digest describe a build nobody can do, and
    the honest answer to "what would this installation build" is then vanilla.
    """
    raw = (env if env is not None else os.environ).get(ENV_PLUGIN_DIR, "").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    return path if path.is_dir() else None
DIGEST_LABEL = "okp.worker.source_digest"

#: Files actually BAKED into the image from the worker context. The plugin tree
#: no longer lives under worker_dir — the dev-side build injects it as a named
#: ``okp-plugin`` build context (see build_argv), hashed via source_digest's
#: plugin_dir. Everything else under worker_dir is not baked and must not count.
#:
#: THIS TUPLE MIRRORS ``docker/worker/.dockerignore``. That file excludes ``*``
#: and then re-includes a whitelist; the Dockerfile's ``COPY . `` copies exactly
#: what survives, so the whitelist IS the baked set. The two are kept in step by
#: hand, and that hand slipped once: ``loop-kill-scanner.cjs`` was whitelisted
#: and cp'd into ``/opt/okp/`` by WO-SEAM-FIX but never added here, so an edit to
#: the loop-kill scanner alone did not move the digest and preflight would have
#: passed a stale image through in silence — the exact failure this module
#: exists to prevent. ``test_baked_files_mirrors_the_real_dockerignore`` now
#: fails loudly on that drift; add to BOTH places or neither.
BAKED_FILES = (
    "Dockerfile",
    ".dockerignore",
    "egress-sidecar.js",
    "loop-kill-scanner.cjs",
    "supervised-shell.js",
)

#: Never hashed from the plugin context (mirrors the old vendored-plugin
#: .dockerignore semantics).
BAKED_EXCLUDED = (".git/", ".github/", "node_modules/")


def baked_paths(worker_dir: Path) -> list[Path]:
    """Every file under `worker_dir` that ends up inside the image, sorted."""
    out: list[Path] = []
    for path in worker_dir.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(worker_dir).as_posix()
        if rel in BAKED_FILES:
            out.append(path)
    return sorted(out, key=lambda p: p.relative_to(worker_dir).as_posix())


def source_digest(worker_dir: Path, plugin_dir: Path | None = None) -> str:
    """sha256 over the baked file set — path AND content, in a stable order.

    With `plugin_dir`, every file under it is hashed too, under ``plugin/``-
    prefixed rel paths (BAKED_EXCLUDED dirs and .DS_Store skipped) — so the
    digest covers exactly what the dev-side build injects. Without it, the
    value is identical to the vanilla worker_dir-only digest.
    """
    entries: list[tuple[str, Path]] = [
        (path.relative_to(worker_dir).as_posix(), path) for path in baked_paths(worker_dir)
    ]
    if plugin_dir is not None:
        for path in plugin_dir.rglob("*"):
            if not path.is_file():
                continue
            rel = path.relative_to(plugin_dir).as_posix()
            if rel.endswith(".DS_Store") or any(rel.startswith(x) for x in BAKED_EXCLUDED):
                continue
            entries.append((f"plugin/{rel}", path))
    h = hashlib.sha256()
    for rel, path in sorted(entries, key=lambda e: e[0]):
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(hashlib.sha256(path.read_bytes()).digest())
    return h.hexdigest()


def image_digest(image: str = IMAGE) -> str | None:
    """The digest baked into `image`, or None if the image is absent.

    An empty string means the image exists but carries no digest: it was built
    by a bare ``docker build`` instead of the rebuild path, so nothing recorded
    what it was built from. That is reported as its own case rather than guessed
    at — see preflight.
    """
    proc = subprocess.run(
        ["docker", "image", "inspect", image, "--format", "{{index .Config.Labels \"" + DIGEST_LABEL + "\"}}"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return None
    value = proc.stdout.strip()
    return "" if value in ("", "<no value>", "unset") else value


def build_argv(worker_dir: Path, image: str = IMAGE, plugin_dir: Path | None = None) -> list[str]:
    """The exact build command, digest included. The one sanctioned rebuild.

    With `plugin_dir`, the plugin tree is injected as the named build context
    ``okp-plugin`` plus the ``OKP_PLUGIN_CONTEXT`` / ``OKP_PLUGIN_PRESENT``
    build args — the three literals must match the Dockerfile seam exactly.
    The baked digest always covers the same inputs the build will see: vanilla
    without `plugin_dir`, plugin-inclusive with it.
    """
    argv = ["docker", "build"]
    if plugin_dir is not None:
        argv += [
            "--build-context",
            f"okp-plugin={plugin_dir}",
            "--build-arg",
            "OKP_PLUGIN_CONTEXT=okp-plugin",
            "--build-arg",
            "OKP_PLUGIN_PRESENT=1",
        ]
    argv += [
        "--build-arg",
        f"OKP_WORKER_SOURCE_DIGEST={source_digest(worker_dir, plugin_dir)}",
        "-t",
        image,
        str(worker_dir),
    ]
    return argv
