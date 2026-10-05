"""Worker-image freshness is a CONTENT question, not a timestamp one.

THE MEASURED DEFECT (2026-09-03). Preflight compared the newest mtime under
images/worker against the image's ``.Created`` and blocked when the source was
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

THE SIDECAR SPLIT (WO-LI2). The sidecar files (egress-sidecar.js,
loop-kill-scanner.cjs, supervised-shell.js) moved out of the worker context
into ``images/sidecar/`` and ride into the build as the named ``sidecar``
build context — the same seam shape as the plugin. The worker context bakes
only its root whitelist (Dockerfile + .dockerignore); the sidecar tree is
hashed INTERNALLY from ``worker_dir.parent / "sidecar"`` (the ``images/sidecar/``
dir) whenever it exists — there is no explicit parameter — so the digest
covers the sidecar exactly when the build will see it.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from harness.worker_image import (  # noqa: E402
    BAKED_FILES,
    baked_paths,
    build_argv,
    plugin_entry,
    plugin_identity,
    source_digest,
)

#: The real worker context, not a fixture — the coupling guard reads it.
REPO_WORKER_DIR = Path(__file__).resolve().parent.parent / "images" / "worker"


def _worker_tree(root: Path) -> Path:
    """The baked worker context: exactly the whitelisted root files, nothing else.

    Since the sidecar split the worker context bakes ONLY Dockerfile and
    .dockerignore — the sidecar files live in images/sidecar/ and are hashed
    internally from ``worker_dir.parent / "sidecar"`` (see _sidecar_tree).
    """
    worker = root / "images" / "worker"
    worker.mkdir(parents=True)
    (worker / "Dockerfile").write_text("FROM scratch\n")
    (worker / ".dockerignore").write_text("*\n!Dockerfile\n!.dockerignore\n")
    return worker


def _sidecar_tree(root: Path) -> Path:
    """The sidecar context: files that ride in via the ``sidecar`` build context.

    Created as a SIBLING of the worker tree (``root/images/sidecar``) — exactly
    where ``source_digest`` looks for it: ``worker_dir.parent / "sidecar"``.
    """
    sidecar = root / "images" / "sidecar"
    sidecar.mkdir(parents=True)
    (sidecar / "egress-sidecar.js").write_text("// sidecar\n")
    (sidecar / "loop-kill-scanner.cjs").write_text("// scanner\n")
    (sidecar / "supervised-shell.js").write_text("#!/usr/bin/env node\n")
    return sidecar


def _plugin_tree(root: Path, manifest: dict | None = None) -> Path:
    """A plugin package for the ``plugin_dir`` arm: like any opencode plugin
    package, it names its entry file in package.json."""
    plugin = root / "opencode-plugin"
    (plugin / "dist").mkdir(parents=True)
    (plugin / "dist" / "index.js").write_text("export const x = 1\n")
    if manifest is None:
        manifest = {
            "name": "memory-plugin",
            "version": "1.0.0",
            "exports": {
                ".": {"types": "./dist/index.d.ts", "import": "./dist/index.js"}
            },
        }
    (plugin / "package.json").write_text(json.dumps(manifest))
    return plugin


@pytest.mark.parametrize(
    "manifest",
    [
        {"exports": {".": {"import": "./dist/index.js"}}},
        {"exports": {".": "./dist/index.js"}},
        {"exports": "./dist/index.js"},
        {"exports": {".": {"import": {"default": "./dist/index.js"}}}},
        {"module": "dist/index.js"},
        {"main": "./dist/index.js"},
    ],
)
def test_the_plugin_entry_is_the_file_its_package_exports(
    tmp_path: Path, manifest: dict
) -> None:
    assert plugin_entry(_plugin_tree(tmp_path, manifest)) == "dist/index.js"


def test_a_plugin_package_that_names_no_loadable_file_is_refused(
    tmp_path: Path,
) -> None:
    """opencode drops a plugin that fails to load without a word, so the build
    must refuse rather than bake one."""
    with pytest.raises(ValueError, match="declares no entry"):
        plugin_entry(_plugin_tree(tmp_path, {"name": "x"}))
    with pytest.raises(ValueError, match="is not there"):
        plugin_entry(_plugin_tree(tmp_path / "b", {"main": "./dist/missing.js"}))


def test_the_plugin_identity_is_name_at_version(tmp_path: Path) -> None:
    assert plugin_identity(_plugin_tree(tmp_path)) == "memory-plugin@1.0.0"


def test_a_touched_but_unchanged_file_does_not_read_as_stale(tmp_path: Path) -> None:
    """The deadlock, reproduced. Same bytes, newer mtime -> same digest."""
    worker = _worker_tree(tmp_path)
    sidecar_dir = _sidecar_tree(tmp_path)
    before = source_digest(worker)

    sidecar = sidecar_dir / "egress-sidecar.js"
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
    (plugin / "dist" / "index.js").write_text("export const x = 2\n")
    assert source_digest(worker, plugin_dir=plugin) != before_plugin, (
        "an edited plugin file must read as stale in the plugin-inclusive digest"
    )


def test_an_edited_loop_kill_scanner_reads_as_stale(tmp_path: Path) -> None:
    """REGRESSION (2026-09-08). The scanner bakes, so editing it must move the digest.

    It was whitelisted in .dockerignore and cp'd to /opt/okp/ by WO-SEAM-FIX but
    left out of BAKED_FILES, so a scanner-only change shipped an image whose
    scanner was the old one, with preflight reporting the image current. Since
    the sidecar split the scanner rides via the ``sidecar`` build context,
    and the digest covers it internally from ``worker_dir.parent / "sidecar"``.
    """
    worker = _worker_tree(tmp_path)
    sidecar_dir = _sidecar_tree(tmp_path)
    before = source_digest(worker)
    (sidecar_dir / "loop-kill-scanner.cjs").write_text("// scanner, edited\n")
    assert source_digest(worker) != before, (
        "loop-kill-scanner.cjs bakes into the image — an edit to it must read as stale"
    )


def test_the_digest_covers_the_files_the_image_actually_bakes(tmp_path: Path) -> None:
    """The worker arm is the whitelisted root files; sidecar and plugin ride via their dirs.

    Since the sidecar split the worker context bakes ONLY Dockerfile and
    .dockerignore; the sidecar tree is hashed INTERNALLY from
    ``worker_dir.parent / "sidecar"`` (the ``images/sidecar/`` dir, injected as
    the named ``sidecar`` build context) — there is no explicit parameter.
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
    }, f"unexpected baked set: {sorted(baked)}"

    # Worker-ONLY digest, computed BEFORE the sidecar tree exists: the internal
    # derivation (worker.parent / "sidecar") has nothing to hash yet.
    worker_only = source_digest(worker)

    sidecar_dir = _sidecar_tree(tmp_path)  # now worker.parent/"sidecar" exists
    with_sidecar = source_digest(worker)
    assert with_sidecar != worker_only, (
        "the sidecar-inclusive digest must differ from the worker-only digest — "
        "otherwise the sidecar dir is not covered at all"
    )
    (sidecar_dir / "supervised-shell.js").write_text("#!/usr/bin/env node\n# edited\n")
    assert source_digest(worker) != with_sidecar, (
        "an edited sidecar file must read as stale in the sidecar-inclusive digest"
    )

    with_plugin = source_digest(worker, plugin_dir=plugin)
    assert with_plugin != worker_only, (
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


def test_the_build_carries_the_digest_it_will_be_checked_against(
    tmp_path: Path,
) -> None:
    """Write and read are the same value, or the check can never pass.

    Order-independent by design: ``build_argv`` prepends the ALWAYS-present
    ``sidecar`` build context before any plugin context, so both seams are
    pinned by VALUE, never by position (``index("--build-context")+1`` found
    the sidecar first and misread the plugin seam as absent).
    """
    worker = _worker_tree(tmp_path)
    argv = build_argv(worker)
    assert f"OKP_WORKER_SOURCE_DIGEST={source_digest(worker)}" in argv
    assert "-t" in argv and "bench-worker:v1" in argv
    # The sidecar seam rides in EVERY build, vanilla included.
    assert f"sidecar={worker.parent / 'sidecar'}" in argv
    assert "SIDECAR_CONTEXT=sidecar" in argv

    # Dev-side arm: the plugin tree rides as the named okp-plugin build
    # context, and the digest baked in is the plugin-inclusive one preflight
    # will recompute.
    plugin = _plugin_tree(tmp_path)
    dev_argv = build_argv(worker, plugin_dir=plugin)
    assert "--build-context" in dev_argv
    assert f"okp-plugin={plugin}" in dev_argv
    assert "OKP_PLUGIN_CONTEXT=okp-plugin" in dev_argv
    assert "OKP_PLUGIN_PRESENT=1" in dev_argv
    # The file opencode loads and the package identity ride as build args.
    assert "BENCH_PLUGIN_ENTRY=dist/index.js" in dev_argv
    assert "BENCH_PLUGIN_ID=memory-plugin@1.0.0" in dev_argv
    # The sidecar seam survives alongside the plugin seam in the dev build.
    assert f"sidecar={worker.parent / 'sidecar'}" in dev_argv
    assert (
        f"OKP_WORKER_SOURCE_DIGEST={source_digest(worker, plugin_dir=plugin)}"
        in dev_argv
    )


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

    BAKED_FILES is hand-maintained against images/worker/.dockerignore. When a
    file is whitelisted there but missed here, the image bakes it and the digest
    does not cover it — a stale image that preflight calls current, which is
    exactly how the loop-kill scanner shipped uncovered. Add to BOTH or neither.
    """
    whitelist = _dockerignore_whitelist(REPO_WORKER_DIR / ".dockerignore")
    assert set(BAKED_FILES) == whitelist, (
        "BAKED_FILES and images/worker/.dockerignore disagree — "
        f"only in .dockerignore: {sorted(whitelist - set(BAKED_FILES))}; "
        f"only in BAKED_FILES: {sorted(set(BAKED_FILES) - whitelist)}"
    )


def test_every_baked_file_exists_in_the_repo_worker_context() -> None:
    """A BAKED_FILES entry naming nothing on disk hashes nothing and hides drift."""
    missing = [name for name in BAKED_FILES if not (REPO_WORKER_DIR / name).is_file()]
    assert not missing, f"BAKED_FILES names files that do not exist: {missing}"
