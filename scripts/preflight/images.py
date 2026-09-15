"""Worker / grader image currency and wiring checks."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys

from preflight.core import REBUILD_CMD, REPO, Check


def check_image(c: Check) -> None:
    """Is the worker image built from the source on disk?

    ASKED AS A CONTENT QUESTION, not a timestamp one. This check used to compare
    the newest mtime under images/worker against the image's .Created, and it
    could not be cleared: re-saving a file without changing a byte bumps its
    mtime, the rebuild is a full cache hit, the image id and its creation time
    never move, and the check stays red through every rebuild. The operator
    presses REBUILD, a real build succeeds, and nothing changes — indistinguish-
    able from a dead button.

    So the build bakes a digest of its own source (harness/worker_image.py) and
    this reads it back. The vendored opencode plugin is baked in at build time,
    so a genuinely stale image runs stale plugin code with nothing to say so.
    """
    if shutil.which("docker") is None:
        c.add("worker image", False, "docker not on PATH")
        return

    # Function-local: the remedy id is a literal in the entry (regex-pinned by
    # control/control.test.mjs); a top-level import here would be circular.
    from bench_preflight import TOOL_WORKER_REBUILD

    if str(REPO) not in sys.path:
        sys.path.insert(0, str(REPO))
    from harness.worker_image import (
        IMAGE,
        configured_plugin_dir,
        image_digest,
        source_digest,
    )

    baked = image_digest(IMAGE)
    if baked is None:
        c.add(
            "worker image",
            False,
            f"{IMAGE} MISSING -> {REBUILD_CMD}",
            remedy=TOOL_WORKER_REBUILD,
        )
        return

    # THE QUESTION IS "would this installation build this image", not "would a
    # vanilla build produce it". The plugin is baked in at build time and is part
    # of the source digest, so a checker that ignores the seam flags every
    # plugin-bearing image as stale — which it did, on every dev build, blocking
    # a preflight that had nothing actually wrong with it. Unset seam (a bare
    # clone) still asks the vanilla question, unchanged.
    plugin_dir = configured_plugin_dir()
    want = source_digest(REPO / "images" / "worker", plugin_dir=plugin_dir)
    if not baked:
        # Built by a bare `docker build`, which records nothing about its source.
        # Reported as its own case: "we cannot tell" is not "it is current".
        c.add(
            "worker image",
            False,
            f"{IMAGE} carries no source digest — it was not built by the rebuild "
            f"path, so nothing recorded what it was built from -> {REBUILD_CMD}",
            remedy=TOOL_WORKER_REBUILD,
        )
        return

    ok = baked == want
    # NAME WHICH BUILD WAS COMPARED. "Stale" against the wrong question is the
    # failure this check just had, and an operator reading it could not tell.
    flavour = "with the configured plugin" if plugin_dir else "vanilla (no plugin configured)"
    c.add(
        "worker image",
        ok,
        f"built from source {baked[:12]}"
        + (
            f" but images/worker {flavour} is now {want[:12]} -> {REBUILD_CMD}"
            if not ok
            else f" — matches images/worker byte for byte, {flavour}"
        ),
        remedy=TOOL_WORKER_REBUILD,
    )


def check_grader_image(c: Check) -> None:
    """Is the grading image built, and current with the gates on disk?

    Grading runs ONLY in this image — same digest-pinned Node the candidate is
    built against, toolchain installed from the lockfile. A missing image aborts
    the run rather than falling back to the host, so catching it here turns a
    mid-campaign abort into a line the operator can act on before starting.

    Staleness is a content question, exactly as it is for the worker image: a
    digest of the source is baked in at build time and read back. A stale image
    grades against gate code that is not the code on disk, and nothing in the
    report would say so.
    """
    if shutil.which("docker") is None:
        c.add("grader image", False, "docker not on PATH")
        return
    if str(REPO) not in sys.path:
        sys.path.insert(0, str(REPO))
    from harness.grader_image import IMAGE, image_digest, source_digest

    gates = REPO / "grader"
    dockerfile = REPO / "images" / "grader" / "Dockerfile"
    baked = image_digest(IMAGE)
    if baked is None:
        c.add(
            "grader image",
            False,
            f"{IMAGE} is not built (or carries no source digest). "
            "Build: python3 scripts/rebuild_grader_image.py",
        )
        return
    live = source_digest(gates, dockerfile)
    if baked != live:
        c.add(
            "grader image",
            False,
            f"{IMAGE} is STALE — built from {baked[:12]}, gates on disk are {live[:12]}. "
            "It would grade against gate code that is not the code on disk. "
            "Rebuild: python3 scripts/rebuild_grader_image.py",
        )
        return
    c.add("grader image", True, f"{IMAGE} current ({live[:12]})")


def check_grader_resources(c: Check) -> None:
    """Can grading actually fit on this machine right now?

    ASKED OF THE CONTAINER, never of this host: only the container knows what it
    has been given, and the answer changes with whatever else is running. It is
    sized against FREE cpu and memory, not total — the operator may already have
    containers up, and a worker count derived from the total would start
    browsers into memory that is already spoken for.

    Caught HERE because the alternative is an OOM kill part-way through a
    grading pass, and an OOM kill is recorded as gates failing: a machine that
    was busy, certified as a candidate that was wrong.
    """
    if shutil.which("docker") is None:
        c.add("grader resources", False, "docker not on PATH")
        return
    if str(REPO) not in sys.path:
        sys.path.insert(0, str(REPO))
    from harness.grader_image import IMAGE, image_digest

    if image_digest(IMAGE) is None:
        # The image row above already says this, in the words that fix it.
        c.add("grader resources", False, "not asked — the grading image is not built")
        return
    try:
        out = subprocess.run(  # noqa: S603 - fixed argv
            ["docker", "run", "--rm", IMAGE, "--resources"],
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        c.add("grader resources", False, f"could not ask the grading image: {exc}")
        return

    detail = (out.stdout or "").strip().splitlines()
    summary = detail[-1] if detail else "no answer"
    if out.returncode != 0:
        reason = (out.stderr or "").strip().splitlines()
        c.add("grader resources", False, reason[-1] if reason else summary)
        return
    c.add("grader resources", True, summary)


def check_self_compact_tool(c: Check, args) -> None:
    """Prove the worker image ACTUALLY wires the self-compact plugin.

    WHY THIS NEEDS PROVING (2026-09-03). opencode SWALLOWS PLUGIN LOAD ERRORS: a
    deliberately corrupted `plugin.ts` produces no output at all — the serve
    starts, answers health, and simply has no plugin. So every negative signal
    an operator would look for is absent by construction, and a stale or broken
    image would run a whole cell with the plugin missing and nothing to say so.
    Every chunk boundary would then abort the cell on no_compaction_evidence
    with nothing anywhere saying the plugin was the reason.

    Liveness is not wiring (AGENTS.md 2.1). The restored mechanism is the
    worker-side self-fire plugin (self-compact.ts), loaded via the opencode
    `config.plugin` array baked into the image — so this asserts that wiring
    BY NAME from the image's own baked config, plus that the file exists at
    the wired path, rather than inferring it from a clean startup.

    Only meaningful when the run will actually ask for compaction — checked when
    `--compact` is passed, skipped otherwise with that stated.
    """
    if not getattr(args, "compact", False):
        c.add(
            "self-compact wiring",
            True,
            "not checked — this run does not use compaction (--compact absent)",
        )
        return
    if shutil.which("docker") is None:
        c.add("self-compact wiring", False, "docker not on PATH")
        return

    # Function-local: remedy id is a literal in the entry (see check_image).
    from bench_preflight import TOOL_WORKER_REBUILD

    # Read the image's own baked opencode config and ask it — no serve, no
    # env: wiring is a property of the image, not of a runtime session.
    probe = (
        "const fs=require('fs');"
        "const cfg=JSON.parse(fs.readFileSync("
        "'/etc/xdg/opencode/opencode.json','utf8'));"
        "const plugs=(cfg.plugin||[]).filter(function(p){"
        "return /self-compact\\.ts$/.test(String(p))});"
        "const ok=plugs.length>0&&plugs.every(function(p){"
        "return fs.existsSync(String(p))});"
        # A2: the wired file must be the PHASE-GATED arm. A stale image can be
        # correctly wired to the OLD plugin, which fires on the marker alone and
        # leaks a compaction into the repair phase — the exact defect this
        # check now has to be able to see. Grep the baked source for the
        # sentinel env name; wiring alone was never proof of behaviour.
        "const gated=ok&&plugs.every(function(p){"
        "return fs.readFileSync(String(p),'utf8')"
        ".indexOf('BENCH_COMPACT_PHASE_FILE')>=0});"
        "console.log(JSON.stringify({wired:plugs,exist:ok,gated:gated}))"
    )
    proc = subprocess.run(
        [
            "docker", "run", "--rm",
            "--entrypoint", "node", "bench-worker:v1", "-e", probe,
        ],
        capture_output=True, text=True, check=False, timeout=180,
    )
    tail = (proc.stdout or "").strip().splitlines()
    wired: list = []
    exist = False
    gated = False
    if tail:
        try:
            verdict = json.loads(tail[-1])
            wired = verdict.get("wired") or []
            exist = bool(verdict.get("exist"))
            gated = bool(verdict.get("gated"))
        except (ValueError, AttributeError):
            pass
    present = bool(wired) and exist
    c.add(
        "self-compact wiring",
        present,
        f"self-compact.ts is wired in the image's opencode config ({wired[0]})"
        if present
        else (
            "self-compact.ts is NOT wired in the image's baked opencode config "
            "(or the file is missing at the wired path) -> the --compact flag "
            "arms a plugin that is not loaded, and every chunk boundary will "
            "abort the cell on no_compaction_evidence. " + REBUILD_CMD
        ),
        remedy=TOOL_WORKER_REBUILD,
    )
    c.add(
        "self-compact phase gate",
        present and gated,
        "the baked plugin reads the harness phase sentinel "
        "(BENCH_COMPACT_PHASE_FILE) — repair rounds cannot compact"
        if (present and gated)
        else (
            "the baked self-compact.ts does NOT read BENCH_COMPACT_PHASE_FILE -> "
            "this image predates the benchmark's current phase-gated compaction "
            "arm (an older arm leaked a compaction into the repair phase, run "
            "1788462647). " + REBUILD_CMD
        ),
        remedy=TOOL_WORKER_REBUILD,
    )


def check_serve_drive_image(c: Check) -> None:
    """Prove the worker image can serve the :4096 live-view data path.

    The live view (opencode serve over host :4096) is carried by the egress
    sidecar's ingress forward, which the cell reaches over the --internal net
    (WO-25). A worker image built BEFORE that fix bakes an egress-sidecar.js
    WITHOUT the ingress forward, so host :4096 silently serves nothing and the
    harness quietly falls back to the deadlock-prone stdout drive. Liveness is
    not wiring (AGENTS.md §2.1): instead of trusting the image timestamp, read
    the baked sidecar and assert the ingress-forward capability is present.
    """
    if shutil.which("docker") is None:
        c.add("serve-drive image", False, "docker not on PATH")
        return

    # Function-local: remedy id is a literal in the entry (see check_image).
    from bench_preflight import TOOL_WORKER_REBUILD

    proc = subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--entrypoint",
            "cat",
            "bench-worker:v1",
            "/opt/okp/egress-sidecar.js",
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        c.add(
            "serve-drive image",
            False,
            "cannot read baked egress-sidecar.js: "
            + (detail[-1][:160] if detail else f"exit {proc.returncode}"),
            remedy=TOOL_WORKER_REBUILD,
        )
        return
    if "OKP_INGRESS_CELL_HOST" in proc.stdout:
        c.add(
            "serve-drive image",
            True,
            "baked egress-sidecar.js carries the :4096 ingress forward "
            "(OKP_INGRESS_CELL_HOST present)",
        )
    else:
        c.add(
            "serve-drive image",
            False,
            "baked egress-sidecar.js LACKS the :4096 ingress forward — image "
            "predates the sidecar-ingress fix (137b025); " + REBUILD_CMD,
            remedy=TOOL_WORKER_REBUILD,
        )
