"""Worker-image freshness is a CONTENT question, not a timestamp one.

THE MEASURED DEFECT (2026-09-03). Preflight compared the newest mtime under
docker/worker against the image's ``.Created`` and blocked when the source was
newer. Docker is content-addressed: re-saving a file without changing a byte
bumps its mtime, the rebuild is a full cache hit, the image id and its creation
time never move — so the check stayed red through every successful rebuild.

Observed on the board: the operator pressed REBUILD WORKER twice, two real
docker builds ran and completed (10.7s and 12.3s), and preflight kept reporting
the image stale. A working button was indistinguishable from a dead one, and
there was no sequence of clicks that could have cleared it.

The first test below is that exact scenario. It fails against an mtime rule and
passes against a content rule, which is the whole point of the change.

Since the plugin rehome (WO-SEP-02) the worker context bakes only its root
whitelist; the plugin tree lives dev-side and rides into the build as the
named ``okp-plugin`` build context, so the digest covers it exactly when
``plugin_dir`` is passed. The tests below exercise both arms.

THE SECOND DEFECT (2026-09-08). A content digest is only as good as its file
set. ``loop-kill-scanner.cjs`` was whitelisted in .dockerignore and cp'd into
the image by WO-SEAM-FIX, but never added to ``BAKED_FILES`` — so editing the
loop-kill scanner alone left the digest unmoved and preflight waved a stale
image through without a word. The last test below is the standing guard: the
baked set and the real .dockerignore whitelist must agree.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bench.worker_image import (  # noqa: E402
    BAKED_FILES,
    baked_paths,
    build_argv,
    source_digest,
)

#: The real worker context, not a fixture — the coupling guard reads it.
REPO_WORKER_DIR = Path(__file__).resolve().parent.parent / "docker" / "worker"


def _worker_tree(root: Path) -> Path:
    """The baked worker context: exactly the whitelisted root files, nothing else."""
    worker = root / "docker" / "worker"
    worker.mkdir(parents=True)
    (worker / "Dockerfile").write_text("FROM scratch\n")
    (worker / ".dockerignore").write_text("*\n!Dockerfile\n")
    (worker / "egress-sidecar.js").write_text("// sidecar\n")
    (worker / "loop-kill-scanner.cjs").write_text("// scanner\n")
    (worker / "supervised-shell.js").write_text("#!/usr/bin/env node\n")
    return worker


def _plugin_tree(root: Path) -> Path:
    """A dev-side plugin fixture for the ``plugin_dir`` arm."""
    plugin = root / "opencode-plugin"
    (plugin / "plugins").mkdir(parents=True)
    (plugin / "plugins" / "plugin.ts").write_text("export const x = 1\n")
    return plugin


def test_a_touched_but_unchanged_file_does_not_read_as_stale(tmp_path: Path) -> None:
    """The deadlock, reproduced. Same bytes, newer mtime -> same digest."""
    worker = _worker_tree(tmp_path)
    before = source_digest(worker)

    sidecar = worker / "egress-sidecar.js"
    content = sidecar.read_text()
    sidecar.write_text(content)  # re-saved, identical
    os.utime(sidecar, (2_000_000_000, 2_000_000_000))  # far in the future

    assert source_digest(worker) == before, (
        "an mtime bump with no content change must not read as a new source — "
        "docker would cache-hit the rebuild and nothing could ever clear the check"
    )


def test_a_changed_byte_does_read_as_stale(tmp_path: Path) -> None:
    """The check still has to catch what it exists to catch — in both arms."""
    worker = _worker_tree(tmp_path)
    plugin = _plugin_tree(tmp_path)

    before_worker = source_digest(worker)
    (worker / "Dockerfile").write_text("FROM scratch\n# changed\n")
    assert source_digest(worker) != before_worker, (
        "an edited baked root file must read as stale"
    )

    before_plugin = source_digest(worker, plugin_dir=plugin)
    (plugin / "plugins" / "plugin.ts").write_text("export const x = 2\n")
    assert source_digest(worker, plugin_dir=plugin) != before_plugin, (
        "an edited plugin file must read as stale in the plugin-inclusive digest"
    )


def test_an_edited_loop_kill_scanner_reads_as_stale(tmp_path: Path) -> None:
    """REGRESSION (2026-09-08). The scanner bakes, so editing it must move the digest.

    It was whitelisted in .dockerignore and cp'd to /opt/okp/ by WO-SEAM-FIX but
    left out of BAKED_FILES, so a scanner-only change shipped an image whose
    scanner was the old one, with preflight reporting the image current.
    """
    worker = _worker_tree(tmp_path)
    before = source_digest(worker)
    (worker / "loop-kill-scanner.cjs").write_text("// scanner, edited\n")
    assert source_digest(worker) != before, (
        "loop-kill-scanner.cjs bakes into the image — an edit to it must read as stale"
    )


def test_the_digest_covers_the_files_the_image_actually_bakes(tmp_path: Path) -> None:
    """The worker arm is the whitelisted root files; the plugin arm adds the tree.

    Nothing under ``vendor/`` bakes from the worker context anymore — the
    plugin dir is covered only via ``plugin_dir``, and its excluded entries
    (``node_modules/``, ``.git/``, ``.DS_Store``) are invisible to the digest,
    mirroring the plugin context's own .dockerignore semantics.
    """
    worker = _worker_tree(tmp_path)
    plugin = _plugin_tree(tmp_path)

    baked = {p.relative_to(worker).as_posix() for p in baked_paths(worker)}
    assert baked == {
        "Dockerfile",
        ".dockerignore",
        "egress-sidecar.js",
        "loop-kill-scanner.cjs",
        "supervised-shell.js",
    }, f"unexpected baked set: {sorted(baked)}"

    vanilla = source_digest(worker)
    with_plugin = source_digest(worker, plugin_dir=plugin)
    assert with_plugin != vanilla, (
        "the plugin-inclusive digest must differ from the worker-only digest — "
        "otherwise the plugin dir is not covered at all"
    )

    (plugin / "node_modules").mkdir()
    (plugin / "node_modules" / "dep.js").write_text("x\n")
    (plugin / ".git").mkdir()
    (plugin / ".git" / "config").write_text("[core]\n")
    (plugin / ".DS_Store").write_text("junk\n")
    assert source_digest(worker, plugin_dir=plugin) == with_plugin, (
        "excluded plugin entries must not move the plugin-inclusive digest"
    )


def test_the_build_carries_the_digest_it_will_be_checked_against(tmp_path: Path) -> None:
    """Write and read are the same value, or the check can never pass."""
    worker = _worker_tree(tmp_path)
    argv = build_argv(worker)
    assert f"OKP_WORKER_SOURCE_DIGEST={source_digest(worker)}" in argv
    assert "-t" in argv and "okp-bench-worker:v1" in argv

    # Dev-side arm: the plugin tree rides as the named okp-plugin build
    # context, and the digest baked in is the plugin-inclusive one preflight
    # will recompute.
    plugin = _plugin_tree(tmp_path)
    dev_argv = build_argv(worker, plugin_dir=plugin)
    assert "--build-context" in dev_argv
    assert dev_argv[dev_argv.index("--build-context") + 1] == f"okp-plugin={plugin}"
    assert "OKP_PLUGIN_CONTEXT=okp-plugin" in dev_argv
    assert "OKP_PLUGIN_PRESENT=1" in dev_argv
    assert f"OKP_WORKER_SOURCE_DIGEST={source_digest(worker, plugin_dir=plugin)}" in dev_argv


def _dockerignore_whitelist(path: Path) -> set[str]:
    """The names a ``*``-then-``!name`` .dockerignore lets through.

    Deliberately narrow: it asserts the exclude-all is present rather than
    implementing docker's full pattern semantics. A .dockerignore that stops
    being "exclude everything, re-include a whitelist" invalidates the premise
    that the whitelist IS the baked set, and must fail here rather than be
    silently reinterpreted.
    """
    lines = [
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    assert lines and lines[0] == "*", (
        f"{path} no longer starts by excluding everything ({lines[:1]}); the "
        "whitelist premise below does not hold and BAKED_FILES must be re-derived"
    )
    rest = lines[1:]
    assert all(entry.startswith("!") for entry in rest), (
        f"{path} carries non-whitelist patterns {[e for e in rest if not e.startswith('!')]}"
    )
    return {entry[1:] for entry in rest}


def test_baked_files_mirrors_the_real_dockerignore() -> None:
    """The digest's file set and the build context's must not drift apart.

    BAKED_FILES is hand-maintained against docker/worker/.dockerignore. When a
    file is whitelisted there but missed here, the image bakes it and the digest
    does not cover it — a stale image that preflight calls current, which is
    exactly how the loop-kill scanner shipped uncovered. Add to BOTH or neither.
    """
    whitelist = _dockerignore_whitelist(REPO_WORKER_DIR / ".dockerignore")
    assert set(BAKED_FILES) == whitelist, (
        "BAKED_FILES and docker/worker/.dockerignore disagree — "
        f"only in .dockerignore: {sorted(whitelist - set(BAKED_FILES))}; "
        f"only in BAKED_FILES: {sorted(set(BAKED_FILES) - whitelist)}"
    )


def test_every_baked_file_exists_in_the_repo_worker_context() -> None:
    """A BAKED_FILES entry naming nothing on disk hashes nothing and hides drift."""
    missing = [name for name in BAKED_FILES if not (REPO_WORKER_DIR / name).is_file()]
    assert not missing, f"BAKED_FILES names files that do not exist: {missing}"
