#!/usr/bin/env python3
"""Preflight for the MEMORY BACKEND — separate from the benchmark's own preflight.

WHY THIS IS A SECOND SCRIPT AND NOT MORE ROWS IN THE FIRST
----------------------------------------------------------
``bench_preflight.py`` answers "can this bench start a cell": ports, images,
identity, disk. Those are properties of the BENCH, and they are the same
questions whoever is plugged in.

This answers a different question — "is the memory system I plugged in actually
wired" — and it is the question a NEW backend has to be able to answer before
anyone spends hours of compute finding out. Folding it into the benchmark
preflight would make every future backend edit the benchmark's own gate, which
is exactly the coupling the plug-in contract exists to prevent.

Both scripts emit the same row shape, so the board renders them through one
component. That is the only thing they share.

WHAT MADE THIS NECESSARY (run 1788848333, 2026-09-08)
-----------------------------------------------------
A run went out with ``BENCH_AGENTS_AUX_FILE`` unset. The seam did exactly what
it promised — an unset variable means "no memory layer", so it seeded the
neutral notes and said nothing — and the cell ran to completion with the model
never told to record anything. Nothing in the tree was broken; nothing was
wired either, and those two look identical from the outside.

An unset variable cannot be an error in the adapter: a bare bench legitimately
runs with no memory layer. It CAN be an error here, because running this script
at all is a declaration that a backend is supposed to be plugged in.

Backends live in ``BACKENDS``. Adding one is adding a function.

    .venv/bin/python scripts/memory_preflight.py --backend tokp
    .venv/bin/python scripts/memory_preflight.py --backend tokp --json

Exit codes: 0 = GO, 1 = NO-GO (a blocking check failed).

This script only READS and reports. It never installs, writes, or launches.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

BENCH_ROOT = Path(__file__).resolve().parents[1]
if str(BENCH_ROOT) not in sys.path:
    sys.path.insert(0, str(BENCH_ROOT))

from bench.blinding import offending_lines  # noqa: E402

# Reuse the benchmark preflight's row recorder rather than defining a second
# one: the board renders both through the same component, so a divergence in
# the row shape would be invisible here and broken there.
sys.path.insert(0, str(BENCH_ROOT / "scripts"))
from bench_preflight import Check, TOOL_WORKER_REBUILD  # noqa: E402

WORKER_IMAGE = "okp-bench-worker:v1"

# The env seam the adapter reads at seed time (backgammon.py `_agents_md_text`).
ENV_AUX = "BENCH_AGENTS_AUX_FILE"
# Where the control plane is told to find the plugin tree.
ENV_PLUGIN_DIR = "OKP_BENCH_PLUGIN_DIR"


# ── shared checks (any backend) ─────────────────────────────────────────────


def check_aux_seam(c: Check) -> str | None:
    """Is a standing directive declared, readable, and blinding-clean?

    Returns the directive text on success so later checks can assert against
    what the model will ACTUALLY read, rather than against a path.

    THE UNSET CASE IS A BLOCKING FAILURE HERE. It is a legitimate configuration
    for the bench and an impossible one for a run that declares a backend — see
    the module docstring.
    """
    raw = (os.environ.get(ENV_AUX) or "").strip()
    if not raw:
        c.add(
            f"{ENV_AUX} set",
            False,
            f"{ENV_AUX} is unset -> the worker's AGENTS.md is seeded with the neutral "
            "notes and the model is never told to record anything. The run completes "
            "and looks clean; nothing in it exercises the memory layer. Export the "
            "variable before launching (this is the exact miss on run 1788848333).",
        )
        return None

    path = Path(raw)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        c.add(f"{ENV_AUX} set", False, f"{ENV_AUX}={path} cannot be read ({exc})")
        return None

    if not text.strip():
        c.add(f"{ENV_AUX} set", False, f"{ENV_AUX}={path} is empty")
        return None

    c.add(f"{ENV_AUX} set", True, f"{path} ({len(text)} chars)")

    offenders = offending_lines(text)
    c.add(
        "directive is blinding-clean",
        not offenders,
        "no evaluation vocabulary — the model cannot tell it is being measured"
        if not offenders
        else (
            "the directive reveals the run is an evaluation and would contaminate "
            "the measurement: " + "; ".join(offenders[:3])
        ),
    )
    return text


def check_seeded_agents_md(c: Check, directive: str | None) -> None:
    """Would the directive ACTUALLY land in the file the model reads?

    The path existing is not the same as the text arriving. This runs the
    adapter's own seeding function — not a copy of its rules — and asserts the
    directive is present in what comes back. It is the one check that would have
    caught run 1788848333 before it cost anything.
    """
    if directive is None:
        c.add("seeded AGENTS.md carries it", False, "skipped — no readable directive above")
        return
    try:
        from bench.adapters.backgammon import BackgammonRunner, _WORKER_AGENTS_MD
    except Exception as exc:  # pragma: no cover - import failure is environmental
        c.add("seeded AGENTS.md carries it", False, f"bench import failed: {exc}")
        return

    try:
        runner = BackgammonRunner(
            task_dir=BENCH_ROOT / "tasks" / "backgammon",
            work_root=BENCH_ROOT / "runs" / "_preflight_probe",
            model="local-llm-proxy/kimi/kimi-k3",
        )
        seeded = runner._agents_md_text("preflight")
    except Exception as exc:
        c.add("seeded AGENTS.md carries it", False, f"seeding refused: {exc}")
        return

    first = directive.strip().splitlines()[0].strip()
    landed = seeded != _WORKER_AGENTS_MD and first and first in seeded
    c.add(
        "seeded AGENTS.md carries it",
        bool(landed),
        f"the worker's AGENTS.md grows to {len(seeded)} chars and carries the directive's "
        "first line — the model reads it for the whole session"
        if landed
        else "the seeded AGENTS.md comes back WITHOUT the directive -> the model would "
        "never see it. This is a wiring failure, not a content one.",
    )


def check_state_dir(c: Check) -> None:
    """Can the harness create the plugin state dir it mounts into the cell?

    NOT "does it exist". ``docker_worker._ensure_plugin_state_dir`` runs
    ``mkdir(parents=True, exist_ok=True)`` before the container is created, so
    an absent directory is the NORMAL state on any machine that has not run a
    cell yet — and the first version of this row warned about it, on every fresh
    install, forever. A check that fires on a condition the harness resolves
    itself teaches an operator to skim past the row, which costs more than the
    row was ever worth.

    What the harness CANNOT recover from is the path being taken by something
    that is not a directory (it raises), or the parent not being writable (mkdir
    fails). Those are the two real failures, so those are what this asks.
    """
    state = Path(os.path.expanduser("~/.okp/state"))

    if state.exists() and not state.is_dir():
        c.add(
            "plugin state dir",
            False,
            f"{state} exists and is NOT a directory -> the cell aborts before it "
            "starts (docker_worker refuses to mount it)",
        )
        return

    if state.is_dir():
        writable = os.access(state, os.W_OK)
        c.add(
            "plugin state dir",
            writable,
            f"{state} exists and is writable"
            if writable
            else f"{state} exists but is NOT writable -> captured records cannot be persisted",
        )
        return

    # Absent is fine; the harness creates it. What matters is whether it CAN.
    parent = next((p for p in [state, *state.parents] if p.exists()), Path("/"))
    creatable = os.access(parent, os.W_OK)
    c.add(
        "plugin state dir",
        creatable,
        f"{state} does not exist yet — the harness creates it at launch "
        f"(nearest existing parent {parent} is writable)"
        if creatable
        else f"{state} does not exist and cannot be created: {parent} is not writable",
    )


# ── tokp ────────────────────────────────────────────────────────────────────


def check_tokp_plugin_tree(c: Check) -> None:
    """Is the plugin tree the control plane was pointed at actually there?"""
    raw = (os.environ.get(ENV_PLUGIN_DIR) or "").strip()
    if not raw:
        c.add(
            f"{ENV_PLUGIN_DIR} set",
            False,
            f"{ENV_PLUGIN_DIR} is unset -> the control plane has no plugin tree to serve",
        )
        return
    root = Path(raw)
    entry = root / "plugins" / "plugin.ts"
    c.add(
        f"{ENV_PLUGIN_DIR} set",
        entry.is_file(),
        f"{root} (plugins/plugin.ts present)"
        if entry.is_file()
        else f"{root} has no plugins/plugin.ts -> the plugin cannot load",
    )
    tool = root / "plugins" / "submit-mark.ts"
    c.add(
        "record tool source present",
        tool.is_file(),
        f"{tool.name} is in the tree" if tool.is_file() else f"{tool} is missing",
    )


def check_tokp_tool_in_image(c: Check) -> None:
    """Prove the WORKER IMAGE wires a plugin that defines the record tool.

    opencode SWALLOWS plugin load errors, so a stale image reports nothing wrong
    right up until the model is told to call a tool that is not there — and a
    tool that is not there produces no error either, just a session with nothing
    recorded. Read the image's own baked opencode config and grep the wired
    sources, exactly as the self-compact wiring check does: wiring is a property
    of the image, not of a runtime session.
    """
    if shutil.which("docker") is None:
        c.add("record tool wired in image", False, "docker not on PATH")
        return
    probe = (
        "const fs=require('fs');"
        "const cfg=JSON.parse(fs.readFileSync("
        "'/etc/xdg/opencode/opencode.json','utf8'));"
        "const plugs=(cfg.plugin||[]).map(String).filter(function(p){"
        "return fs.existsSync(p)});"
        "const hit=plugs.filter(function(p){"
        "return fs.readFileSync(p,'utf8').indexOf('okp_submit_mark')>=0});"
        "console.log(JSON.stringify({wired:plugs.length,tool:hit.length>0}))"
    )
    proc = subprocess.run(
        ["docker", "run", "--rm", "--entrypoint", "node", WORKER_IMAGE, "-e", probe],
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )
    wired = 0
    tool = False
    tail = (proc.stdout or "").strip().splitlines()
    if tail:
        try:
            verdict = json.loads(tail[-1])
            wired = int(verdict.get("wired") or 0)
            tool = bool(verdict.get("tool"))
        except (ValueError, AttributeError, TypeError):
            pass
    c.add(
        "record tool wired in image",
        tool,
        f"a wired plugin in {WORKER_IMAGE} defines okp_submit_mark ({wired} plugin(s) loaded)"
        if tool
        else (
            f"no plugin wired in {WORKER_IMAGE} defines okp_submit_mark -> the model is "
            "told to record and the tool is not there. opencode reports nothing. "
            f"Rebuild: docker build -t {WORKER_IMAGE} docker/worker"
        ),
        remedy=TOOL_WORKER_REBUILD,
    )


def check_tokp_env_arm(c: Check) -> None:
    """The worker gates the capture path on OKP_INSESSION_EXTRACTION=1.

    Armed unconditionally by ``docker_worker.py`` so the cell env is
    deterministic regardless of memory mode. Asserted from source: if that line
    is ever dropped, the plugin loads and the tool silently never registers.
    """
    src = BENCH_ROOT / "bench" / "adapters" / "docker_worker.py"
    try:
        text = src.read_text(encoding="utf-8")
    except OSError as exc:
        c.add("capture env armed", False, f"cannot read {src.name}: {exc}")
        return
    armed = "OKP_INSESSION_EXTRACTION=1" in text
    c.add(
        "capture env armed",
        armed,
        "docker_worker arms OKP_INSESSION_EXTRACTION=1 on every cell"
        if armed
        else "docker_worker no longer arms OKP_INSESSION_EXTRACTION=1 -> the plugin "
        "loads but never registers the record tool",
    )


def preflight_tokp(c: Check) -> None:
    directive = check_aux_seam(c)
    check_seeded_agents_md(c, directive)
    check_tokp_plugin_tree(c)
    check_tokp_env_arm(c)
    check_tokp_tool_in_image(c)
    check_state_dir(c)


# Adding a backend is adding a function and a line here. Nothing else in the
# bench learns its name.
BACKENDS = {
    "tokp": preflight_tokp,
}


def main() -> int:
    ap = argparse.ArgumentParser(description="Preflight the plugged-in memory backend.")
    ap.add_argument(
        "--backend",
        default="tokp",
        choices=sorted(BACKENDS),
        help="which memory backend to verify (default: tokp)",
    )
    ap.add_argument("--json", action="store_true", help="emit the rows as JSON")
    args = ap.parse_args()

    c = Check()
    BACKENDS[args.backend](c)

    failures = c.blocking_failures
    if args.json:
        print(
            json.dumps(
                {
                    "ok": True,
                    "backend": args.backend,
                    "verdict": "no-go" if failures else "go",
                    "blocking_failures": len(failures),
                    "checks": c.as_rows(),
                },
                indent=None,
            )
        )
        return 1 if failures else 0

    print(f"\nMEMORY BACKEND: {args.backend}\n")
    c.render()
    if failures:
        print(f"\nNO-GO — {len(failures)} blocking check(s) failed.\n")
        return 1
    print("\nGO — the backend is wired and the model will be told to record.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
