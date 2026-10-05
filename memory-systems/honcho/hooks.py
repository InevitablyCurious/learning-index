#!/usr/bin/env python3
"""The benchmark's ready and cost commands for a local Honcho (harness/memory_hooks.py).

    BENCH_MEMORY_READY_CMD="python3 memory-systems/honcho/hooks.py ready"
    BENCH_MEMORY_COST_CMD="python3 memory-systems/honcho/hooks.py cost"

ready  exits 0 once Honcho's queue for the plugin's workspace holds no pending
       or in-progress work: every message the cells sent has been turned into
       memory, summaries and dreams included. Exits 1 otherwise, or when Honcho
       cannot be reached.
cost   prints the telemetry sink's running totals of Honcho's own model use
       (telemetry_sink.py), after waiting out Honcho's telemetry flush so the
       last call is in them.

Both read the workspace from the plugin's settings file (BENCH_MEMORY_ENV) the
way the plugin does, so they always watch the workspace the cells write to.
Run from the repository root; stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from harness.memory_slot import ENV_MEMORY_ENV, REPO_ROOT, parse_settings

#: opencode-honcho's own default when no workspace is set.
PLUGIN_DEFAULT_WORKSPACE = "opencode"
DEFAULT_API_URL = "http://localhost:8000"
DEFAULT_SINK_URL = "http://localhost:8795"
#: Honcho flushes telemetry every second (TELEMETRY_FLUSH_INTERVAL_SECONDS);
#: three covers a flush plus a retry.
DEFAULT_SETTLE_S = 3.0


def workspace(env: Mapping[str, str] | None = None) -> str:
    """The workspace the plugin writes to: HONCHO_WORKSPACE, then _ID, then its default."""
    raw = (env if env is not None else os.environ).get(ENV_MEMORY_ENV, "").strip()
    path = REPO_ROOT / Path(raw).expanduser()  # as the harness reads it
    settings = parse_settings(path.read_text(encoding="utf-8")) if raw else {}
    return (
        settings.get("HONCHO_WORKSPACE")
        or settings.get("HONCHO_WORKSPACE_ID")
        or PLUGIN_DEFAULT_WORKSPACE
    )


def _get_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.loads(response.read())


def queue_state(api_url: str, ws: str) -> tuple[bool, str]:
    """Whether the workspace's queue is empty, and a one-line account of it."""
    url = f"{api_url.rstrip('/')}/v3/workspaces/{urllib.parse.quote(ws, safe='')}/queue/status"
    status = _get_json(url)
    pending = int(status.get("pending_work_units", 0))
    in_progress = int(status.get("in_progress_work_units", 0))
    said = f"workspace={ws} pending={pending} in_progress={in_progress}"
    return pending == 0 and in_progress == 0, said


def totals(sink_url: str, settle_s: float) -> dict[str, Any]:
    time.sleep(settle_s)
    return _get_json(f"{sink_url.rstrip('/')}/totals")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    ready = sub.add_parser("ready", help="exit 0 when Honcho's queue is empty")
    ready.add_argument("--api-url", default=DEFAULT_API_URL)
    cost = sub.add_parser("cost", help="print Honcho's running model-use totals")
    cost.add_argument("--sink-url", default=DEFAULT_SINK_URL)
    cost.add_argument("--settle-s", type=float, default=DEFAULT_SETTLE_S)
    args = parser.parse_args(argv)

    try:
        if args.command == "ready":
            is_ready, said = queue_state(args.api_url, workspace())
            print(said)
            return 0 if is_ready else 1
        print(json.dumps(totals(args.sink_url, args.settle_s), sort_keys=True))
        return 0
    except (OSError, ValueError) as exc:  # URLError is an OSError
        print(f"honcho {args.command}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
