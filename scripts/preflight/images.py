"""Worker / grader image currency and wiring checks."""

from __future__ import annotations

import shutil
import subprocess
import sys

from harness.challenge_spec import default_spec
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
            f"{IMAGE} is not built — {REBUILD_CMD}",
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
            f"path, so nothing recorded what it was built from — {REBUILD_CMD}",
            remedy=TOOL_WORKER_REBUILD,
        )
        return

    ok = baked == want
    # NAME WHICH BUILD WAS COMPARED. "Stale" against the wrong question is the
    # failure this check just had, and an operator reading it could not tell.
    flavour = (
        "with the configured plugin" if plugin_dir else "vanilla (no plugin configured)"
    )
    c.add(
        "worker image",
        ok,
        (
            f"needs a refresh: the worker source changed since it was built "
            f"({baked[:12]} → {want[:12]}, {flavour}) — {REBUILD_CMD}"
            if not ok
            else f"built from source {baked[:12]} — matches images/worker byte for byte, {flavour}"
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
    # Function-local, like the worker's (see check_image): the id is a literal
    # in bench_preflight.py, regex-pinned by the control-plane seam test.
    from bench_preflight import TOOL_GRADER_REBUILD

    from harness.grader_image import IMAGE, image_digest, source_digest

    gates = default_spec().grader_dir
    dockerfile = REPO / "images" / "grader" / "Dockerfile"
    baked = image_digest(IMAGE)
    if baked is None:
        c.add(
            "grader image",
            False,
            f"{IMAGE} is not built (or carries no source digest) — "
            "press Refresh grader in the ☰ menu",
            remedy=TOOL_GRADER_REBUILD,
        )
        return
    live = source_digest(gates, dockerfile)
    if baked != live:
        c.add(
            "grader image",
            False,
            f"needs a refresh: grader/ changed since {IMAGE} was built "
            f"({baked[:12]} → {live[:12]}) — press Refresh grader in the ☰ menu",
            remedy=TOOL_GRADER_REBUILD,
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
        from bench_preflight import TOOL_GRADER_REBUILD

        c.add(
            "grader resources",
            False,
            "not asked — the grading image is not built",
            remedy=TOOL_GRADER_REBUILD,
        )
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
    """Prove the HARNESS owns chunk-boundary compaction, and counts it honestly.

    THE CHECK MOVED BECAUSE THE MECHANISM MOVED (2026-11). Compaction used to be
    fired by a worker-side plugin baked into the image (images/worker/
    self-compact.ts) and armed by a phase sentinel, and this check proved that
    wiring BY NAME from the image's own baked config — because opencode SWALLOWS
    plugin load errors, so a missing plugin was silent by construction. The
    plugin, its BENCH_SELF_COMPACT switch and the sentinel are gone: the harness
    asks the serve API to compact the session itself, and opencode's own
    auto-compaction is left at its DEFAULT in troubleshooting instead of being
    forced off. So the question is no longer "is the plugin wired in the image".
    It is "does the harness still own compaction, does it count only compactions
    that FINISHED, and is nothing still forcing auto-compaction off in the worker
    config". All of that is a property of REPO SOURCE, so it is answered from
    source — no docker, and no built image to be stale.

    The counting half is the half that has already lied for real. Of 73
    compaction-agent messages on run 1788415430, 68 were killed mid-stream by the
    relay's loop guard and ALL 68 still carried `summary: true`; a flag-keyed
    count reported 68 compactions where none landed (harness/serve_client.py
    carries the measurement). A predicate that loses the `finish` receipt reports
    a cell that compacted when it did not, and nothing in the report can say so.

    Only meaningful when the run will actually ask for compaction — checked when
    `--compact` is passed, skipped otherwise with that stated.
    """
    if not getattr(args, "compact", False):
        c.add(
            "compaction wiring",
            True,
            "not checked — this run does not use compaction (--compact absent)",
        )
        return

    # (a) AUTO-COMPACTION IS NOT FORCED OFF. Asked of the BUILDER, not of the
    # file's text: the built config is what the worker reads, and a text scan
    # cannot see a key an early-returning branch would never add. The model is a
    # synthetic cloud shape because the compaction decision is made at the TOP of
    # the builder, before any model-specific branch returns — and the run's own
    # --model may be a bench alias the worker registry does not know.
    try:
        if str(REPO) not in sys.path:
            sys.path.insert(0, str(REPO))
        from harness.adapters.challenge.worker_config import (
            build_worker_opencode_config,
        )

        built = build_worker_opencode_config(
            model="orcarouter/compaction-probe",
            reasoning_effort=None,
            proxy_base_url=None,
            gates_dir="/gates",
            golden_dir="/golden",
        )
    except Exception as exc:  # noqa: BLE001
        c.add(
            "compaction wiring",
            False,
            f"could not build the worker opencode config: {exc}",
        )
    else:
        compaction = built.get("compaction")
        forced_off = isinstance(compaction, dict) and (compaction.get("auto") is False)
        c.add(
            "compaction wiring",
            not forced_off,
            "the worker config leaves auto-compaction at opencode's default"
            if not forced_off
            else (
                "the worker config still FORCES auto-compaction off "
                "(compaction.auto: false) -> a troubleshooting session that fills "
                "its context stalls where it used to compact and continue; leave "
                "the key out and let the default stand"
            ),
        )

    # (b) THE TRIGGER AND ITS RECEIPT PREDICATE. Bounded parse, the way
    # control/cloud.mjs is read in preflight/cloud.py: from the method to the next
    # same-indent `def`, so these assertions cannot be satisfied by prose
    # elsewhere in the file — the docstring and the guard-kill counter next door
    # both name `summary`, and only the COUNTING ARM may key on `finish` alone.
    try:
        source = (REPO / "harness" / "serve_client.py").read_text(encoding="utf-8")
        start = source.index("def completed_compactions_since(")
        stop = source.find("\n    def ", start)
        counting_arm = source[start : stop if stop != -1 else len(source)]
    except Exception as exc:  # noqa: BLE001
        c.add(
            "harness compaction",
            False,
            f"could not parse harness/serve_client.py: {exc}",
        )
        return

    triggers = "def summarize(" in source
    keys_on_finish = 'info.get("finish")' in counting_arm
    keys_on_agent = 'info.get("agent")' in counting_arm
    ok = triggers and keys_on_finish and not keys_on_agent
    if ok:
        detail = (
            "ServeClient.summarize is the harness's compaction trigger, and the "
            "count keys only on compactions that FINISHED — a non-empty `finish`, "
            "never the `summary` flag and never `agent`"
        )
    else:
        missing = []
        if not triggers:
            missing.append(
                "ServeClient.summarize is gone -> nothing can trigger a "
                "build-chunk compaction"
            )
        if not keys_on_finish:
            missing.append(
                "completed_compactions_since no longer requires a non-empty "
                "`finish` -> a compaction killed mid-stream counts as one that "
                "landed (run 1788415430 reported 68 of those)"
            )
        if keys_on_agent:
            missing.append(
                "completed_compactions_since still counts on `agent` -> the flag "
                "marks the rewrite, the finish proves it landed"
            )
        detail = "; ".join(missing)
    c.add("harness compaction", ok, detail)


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


def check_attach_client(c: Check) -> None:
    """Does the board's terminal mirror have an attach client of the worker's version?

    The mirror runs `opencode attach` on the host. The host's own opencode is the
    operator's (2.x dropped `attach`), so the bench installs its own. Not
    blocking: the mirror is a view; the run and its measurement never use it.
    """
    if str(REPO) not in sys.path:
        sys.path.insert(0, str(REPO))
    from harness.worker_image import ATTACH_CLIENT_BIN, pinned_opencode_version

    want = pinned_opencode_version(REPO / "images" / "worker")
    fix = ".venv/bin/python scripts/install_attach_client.py"
    if not ATTACH_CLIENT_BIN.exists():
        c.add(
            "attach client",
            False,
            f"not installed — the terminal mirror cannot attach — {fix}",
            blocking=False,
        )
        return
    proc = subprocess.run(
        [str(ATTACH_CLIENT_BIN), "--version"],
        capture_output=True,
        text=True,
        check=False,
    )
    got = proc.stdout.strip()
    ok = proc.returncode == 0 and got == want
    c.add(
        "attach client",
        ok,
        f"opencode {got}, the worker's version"
        if ok
        else f"opencode {got or '?'} but the worker pins {want} — {fix}",
        blocking=False,
    )
