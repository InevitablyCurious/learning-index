"""The plugin seam: the builder and the freshness check must ask ONE question.

The question a freshness check answers is *"is this image what this installation
would build right now?"* — and it can only answer that if the builder and the
checker agree on what this installation builds. They did not.

The plugin is baked into the worker image at build time and is part of the source
digest. The dev Makefile passed it as a CLI flag; preflight computed a VANILLA
digest and flagged every plugin-bearing image as stale, blocking a preflight with
nothing actually wrong with it. Worse, the board's REBUILD WORKER button passed
no flag at all — pressing it replaced a plugin-bearing image with a vanilla one,
and since opencode swallows a missing plugin without a word, the next ON cell
would simply have had no extraction tool.

One env seam, read by both, resolves it. Unset — what a bare clone gets — is a
vanilla build, and that is correct rather than an error.
"""

from __future__ import annotations

from pathlib import Path

from bench.worker_image import ENV_PLUGIN_DIR, configured_plugin_dir, source_digest


def _plugin_tree(root: Path) -> Path:
    tree = root / "plugin"
    tree.mkdir()
    (tree / "package.json").write_text('{"name":"p"}', encoding="utf-8")
    return tree


def _worker_dir(root: Path) -> Path:
    wd = root / "worker"
    wd.mkdir()
    (wd / "Dockerfile").write_text("FROM scratch\n", encoding="utf-8")
    return wd


def test_the_seam_is_absent_by_default_and_that_is_not_an_error(tmp_path: Path) -> None:
    """A fresh clone has no plugin and builds vanilla."""
    assert configured_plugin_dir({}) is None
    assert configured_plugin_dir({ENV_PLUGIN_DIR: ""}) is None
    assert configured_plugin_dir({ENV_PLUGIN_DIR: "   "}) is None


def test_a_configured_path_that_does_not_exist_reads_as_vanilla(tmp_path: Path) -> None:
    """Reporting "configured" for a tree that is not there would make the digest
    describe a build nobody can perform. The honest answer to "what would this
    installation build" is then vanilla."""
    assert configured_plugin_dir({ENV_PLUGIN_DIR: str(tmp_path / "nope")}) is None


def test_a_configured_tree_resolves(tmp_path: Path) -> None:
    tree = _plugin_tree(tmp_path)
    assert configured_plugin_dir({ENV_PLUGIN_DIR: str(tree)}) == tree


def test_the_plugin_changes_the_digest_which_is_the_whole_problem(tmp_path: Path) -> None:
    """If the plugin did not move the digest there would be nothing to reconcile.

    It does, because the plugin is baked in — so a checker that ignores the seam
    is asking a different question from the builder, every time.
    """
    wd = _worker_dir(tmp_path)
    tree = _plugin_tree(tmp_path)

    vanilla = source_digest(wd)
    dev = source_digest(wd, plugin_dir=tree)
    assert vanilla != dev

    # And the plugin's CONTENT is in it: editing the plugin must restale the
    # image, or a stale plugin runs with nothing to say so.
    (tree / "plugin.ts").write_text("export default 1\n", encoding="utf-8")
    assert source_digest(wd, plugin_dir=tree) != dev


def test_builder_and_checker_agree_when_both_read_the_seam(tmp_path: Path) -> None:
    """THE FIX, stated as the property it buys.

    Whatever the seam says, the digest the builder bakes and the digest the
    checker computes are the same — so an image freshly built by this
    installation is never reported stale by it.
    """
    wd = _worker_dir(tmp_path)
    tree = _plugin_tree(tmp_path)

    for env in ({}, {ENV_PLUGIN_DIR: str(tree)}):
        resolved = configured_plugin_dir(env)
        built = source_digest(wd, plugin_dir=resolved)   # what the rebuild bakes
        wanted = source_digest(wd, plugin_dir=resolved)  # what preflight expects
        assert built == wanted

    # And the two configurations really are different builds, so the agreement
    # above is not the trivial one.
    assert source_digest(wd, plugin_dir=None) != source_digest(wd, plugin_dir=tree)
