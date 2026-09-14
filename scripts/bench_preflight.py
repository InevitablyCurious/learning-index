#!/usr/bin/env python3
"""One-command preflight for a benchmark run (local AND cloud).

WHY THIS EXISTS
---------------
Starting a cell requires ~6 checks that were previously scattered across
RUNBOOK §0/§2.1/§7 and the workspace AGENTS.md. Doing them by hand costs an
operator (or an agent) a long, error-prone discovery pass every single time,
and the most important check — asserting the bench MCP identity at the seam —
was effectively undiscoverable because `/v1/identity/pubkeys` is bearer-gated
and returns `{"status":"error","error":"unauthorized"}` to a plain curl.

Run this instead. It prints a GO / NO-GO verdict and, on GO, the exact
launch command with `< /dev/null` and the flag ordering already correct.

Local cell (default — the resident model behind the :4545 relay proxy;
`--model` is a bench alias from WORKER_MODEL_REGISTRY):

    .venv/bin/python scripts/bench_preflight.py --model qwen3.6-35b-a3b-bench

Cloud cell (direct-to-cloud via OrcaRouter; `--model` is the MODEL HALF of
the '{provider}/{model}' roster key, not a bench alias):

    .venv/bin/python scripts/bench_preflight.py --cloud --provider deepseek --model deepseek-chat

Exit codes: 0 = GO, 1 = NO-GO (a blocking check failed).

This script only READS and reports. It never archives, wipes, launches, or
mutates anything — those stay operator decisions (RUNBOOK §0 step 3a, §2).

STRUCTURE (WO LI-13). This file is the thin runnable entrypoint. Each check
family lives in scripts/preflight/<family>.py and shares scaffolding from
preflight.core. Two things stay physically HERE because they are seams the
outside world pins: ``port_open``/``check_ports`` (tests/test_preflight_remedies.py
rebinds ``pf.port_open``) and the ``TOOL_*`` remedy ids (control/control.test.mjs
regex-pins the literal ``TOOL_X = "…"`` lines in THIS file). The families import
those ids back from here by FUNCTION-LOCAL import, never top-level, to avoid a
circular import.
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil  # noqa: F401 — re-exported: tests monkeypatch pf.shutil.which to drive check_image's docker-less branch
import socket
import sys
from pathlib import Path

# Make the preflight package importable however this file is loaded: run as a
# script, sys.path[0] is already scripts/; loaded BY PATH (the two preflight
# test modules use spec_from_file_location), it is not. The repo root is added
# inside the checks/main that import harness.*.
_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

# When run as a script this module is __main__, but the check families import
# the TOOL_* remedy ids back from "bench_preflight" (function-local, to dodge a
# circular import). Alias the LIVE module under that name so those imports
# resolve to THIS module rather than a second copy loaded from disk.
if __name__ == "__main__":
    sys.modules.setdefault("bench_preflight", sys.modules["__main__"])

from preflight.campaign import check_run_dir  # noqa: E402
from preflight.cloud import (  # noqa: E402
    check_cloud_key,
    check_cloud_model,
    check_local_model,
    check_roster_drift,
)
from preflight.control_plane import (  # noqa: E402
    check_control_plane_freshness,
    control_plane_freshness_verdict,  # noqa: F401 — re-exported for tests/test_preflight_control_plane_freshness.py
)
from preflight.core import REPO, Check  # noqa: E402
from preflight.disk import check_disk  # noqa: E402
from preflight.feedback import check_feedback_completeness  # noqa: E402
from preflight.identity import check_identity  # noqa: E402
from preflight.images import (  # noqa: E402
    check_grader_image,
    check_grader_resources,
    check_image,
    check_self_compact_tool,
    check_serve_drive_image,
)
from preflight.live import check_live_stream  # noqa: E402

# ── WHICH BUTTON FIXES THIS ─────────────────────────────────────────────────
#
# A refusal that names a shell command sends the operator to a terminal, and an
# operator sent to a shell for one thing ends up doing everything there — the
# same reasoning that moved the rebuild onto the board in the first place. So a
# failure that a custom tool repairs says WHICH TOOL, by id, and the board turns
# that into the button.
#
# IDS, NOT NAMES. The tool registry (control/tools.mjs + the dev manifest) is the
# only thing that knows a tool's display name and whether it is registered here
# at all — `bench-ready` and `bench-mcp-restart` are dev-contributed and absent
# from a bare clone of bench/. An id that resolves to nothing degrades to the
# text remedy already in the detail line, which is why every detail below still
# names its own fix in words.
TOOL_WORKER_REBUILD = "worker-image-rebuild"
TOOL_BENCH_READY = "bench-ready"
TOOL_BENCH_MCP_RESTART = "bench-mcp-restart"


def port_open(port: int, host: str = "127.0.0.1", timeout: float = 2.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def check_ports(c: Check) -> None:
    for port, what in ((4545, "local relay"), (4550, "bench MCP"), (4440, "hub")):
        ok = port_open(port)
        hint = "" if ok else "  -> see RUNBOOK §7 for bring-up"
        # Only the bench MCP has a button of its own. The relay and the hub are
        # brought up with the stack, and pointing at Restart MCP for a dead hub
        # would send the operator to press something that cannot help.
        c.add(
            f"port {port} ({what})",
            ok,
            ("open" if ok else "CLOSED") + hint,
            remedy=TOOL_BENCH_MCP_RESTART if port == 4550 else None,
        )


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Preflight for a benchmark cell (local default, or --cloud)."
    )
    ap.add_argument(
        "--model",
        default="qwen3.6-35b-a3b-bench",
        help="local mode: subject bench alias pinned for the run "
        "(WORKER_MODEL_REGISTRY); --cloud mode: the MODEL HALF of the "
        "'{provider}/{model}' roster key (e.g. deepseek-chat with "
        "--provider deepseek), not a bench alias",
    )
    ap.add_argument(
        "--json",
        action="store_true",
        help="emit the checks as JSON instead of the human table (used by the board)",
    )
    ap.add_argument("--mode", default="off", choices=("off", "on"))
    ap.add_argument(
        "--compact",
        action="store_true",
        help=(
            "Check the readiness of chunk-boundary self-compaction too. The "
            "worker image must actually wire the self-compact plugin in its "
            "opencode config — opencode swallows plugin load errors, so a "
            "broken image is otherwise silent."
        ),
    )
    ap.add_argument("--org", default=None, help="org id (ON cells only)")
    ap.add_argument(
        "--cloud",
        action="store_true",
        help="preflight a direct-to-cloud cell (OrcaRouter) instead of "
        "the local relay proxy",
    )
    ap.add_argument(
        "--provider",
        default=None,
        help="cloud vendor id (e.g. deepseek) — the '{provider}/{model}' "
        "key inside the OrcaRouter provider block. Only used with --cloud.",
    )
    ap.add_argument(
        "--router",
        default="orcarouter",
        help="cloud router id for the composed slug {router}/{provider}/{model} "
        "(default: orcarouter). Only used with --cloud.",
    )
    args = ap.parse_args()

    # Keep module loggers silent (spend_key logs key fingerprints at INFO while
    # resolving): the fingerprint belongs in the check row, never on stderr twice.
    logging.basicConfig(level=logging.CRITICAL)

    if not args.json:
        print("\nBENCH PREFLIGHT  (RUNBOOK §0 + AGENTS.md §2.1)\n")
    c = Check()
    check_ports(c)
    check_identity(c)
    check_image(c)
    check_serve_drive_image(c)
    check_grader_image(c)
    check_grader_resources(c)

    bench_config = spend_key = None
    try:
        sys.path.insert(0, str(REPO))
        from harness import config as bench_config
        from harness import spend_key
    except Exception as exc:  # noqa: BLE001
        c.add("bench config", False, f"cannot import harness: {exc}")

    if args.cloud:
        check_cloud_key(c, spend_key)
        check_cloud_model(c, bench_config, args)
    else:
        check_local_model(c, bench_config, args)
    check_roster_drift(c, bench_config)
    check_control_plane_freshness(c)
    check_self_compact_tool(c, args)
    check_feedback_completeness(c)
    check_run_dir(c, args)
    check_live_stream(c)
    check_disk(c)
    if args.json:
        # The verdict is computed the same way for both renderings — the JSON is
        # a projection of this run, never a second implementation of the rules.
        failures_json = c.blocking_failures
        print(
            json.dumps(
                {
                    "ok": True,
                    "verdict": "no-go" if failures_json else "go",
                    "blocking_failures": len(failures_json),
                    "checks": c.as_rows(),
                },
                indent=None,
            )
        )
        return 1 if failures_json else 0

    c.render()

    failures = c.blocking_failures
    if failures:
        print(
            f"\nNO-GO — {len(failures)} blocking check(s) failed. Resolve the above, re-run.\n"
        )
        return 1

    arm = args.mode
    on_flags = (
        f" --mode on --org {args.org or '<org>'}"
        if args.mode == "on"
        else " --mode off"
    )
    default_router = getattr(bench_config, "DEFAULT_CLOUD_ROUTER", "orcarouter")
    print("\nGO — all blocking checks passed. Launch:\n")
    print(
        "  TS=$(date +%Y%m%dT%H%M%S) && nohup .venv/bin/python scripts/run_cumulative.py \\"
    )
    if args.cloud:
        # Main-parser flags BEFORE the `run` subcommand, mirroring run_cumulative.py
        # argparse; --router is printed only when it differs from the default.
        router_flag = (
            "" if args.router == default_router else f" --router {args.router}"
        )
        print(
            f"    --cloud{router_flag} --provider {args.provider} --model {args.model} run{on_flags} \\"
        )
    else:
        print(f"    --model {args.model} run{on_flags} \\")
    print(f'    < /dev/null > "runs/{arm}-cell-$TS.log" 2>&1 & disown')
    print("\n  `< /dev/null` is MANDATORY (zsh suspends the job on stdin touch).")
    print("  Main-parser flags go BEFORE `run` — argparse exits 2 otherwise.")
    print(
        "  --model must match on EVERY later subcommand or you get 'roster hash drift'.\n"
    )
    print(
        f"  Then:  grep -E 'session_id|attach_cmd' runs/{arm}-cell-<ts>.log | tail -3\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
