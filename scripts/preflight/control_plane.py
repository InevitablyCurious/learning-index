"""Are the two long-running processes running the code on disk?

The control plane (control/) and the board (dashboard/) read their code once,
when they start. An edit after that sits inert until the matching refresh
button is pressed, and a launch from old code measures something other than
what was configured (2026-09-02: a compaction flag present on disk was absent
from the running control plane, and the run looked entirely normal).

Down is not stale: a process that is not running is not running old code.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import urllib.request

from preflight.core import REPO, Check

CONTROL_FIX = "press Refresh control plane in the ☰ menu"
BOARD_FIX = "press Refresh board in the ☰ menu"


def _health(port: int) -> dict | None:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/health", timeout=3
        ) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 - any failure to reach it means it is down
        return None


def check_control_plane_freshness(c: Check) -> None:
    from bench_preflight import TOOL_CONTROL_RESTART

    control_dir = REPO / "control"
    if not control_dir.is_dir():
        c.add("control plane", True, "no control/ directory — CLI-only bench")
        return

    newest = 0.0
    newest_path = ""
    for path in control_dir.rglob("*.mjs"):
        if not path.is_file() or path.name.endswith(".test.mjs"):
            continue
        mtime = path.stat().st_mtime
        if mtime > newest:
            newest, newest_path = mtime, str(path.relative_to(REPO))

    health = _health(8718)
    if health is None:
        c.add(
            "control plane", True, "not running on :8718 — board launches unavailable"
        )
        return
    ok, detail = control_plane_freshness_verdict(
        started_at=str(health.get("started_at") or ""),
        newest_mtime=newest,
        newest_path=newest_path,
    )
    c.add("control plane", ok, detail, remedy=TOOL_CONTROL_RESTART)


def control_plane_freshness_verdict(
    *, started_at: str, newest_mtime: float, newest_path: str
) -> tuple[bool, str]:
    """(ok, detail). A process with no started_at predates the field, so it is
    older than the source that added it."""
    if not started_at:
        return (
            False,
            f"needs a refresh: it is older than its own start-time report — {CONTROL_FIX}",
        )
    started_ts = dt.datetime.fromisoformat(
        started_at.replace("Z", "+00:00")
    ).timestamp()
    if newest_mtime > started_ts:
        return (
            False,
            f"needs a refresh: {newest_path} changed after it started ({started_at[:19]}) — {CONTROL_FIX}",
        )
    return True, f"started {started_at[:19]}, after the last change to control/"


def check_board_freshness(c: Check) -> None:
    from bench_preflight import TOOL_BOARD_REBUILD

    health = _health(8717)
    if health is None:
        c.add("board", True, "not running on :8717")
        return
    c.add(
        "board",
        *board_freshness_verdict(health.get("files"), REPO / "dashboard"),
        remedy=TOOL_BOARD_REBUILD,
    )


def board_freshness_verdict(files, dashboard_dir) -> tuple[bool, str]:
    """Compare the board's own file fingerprints with dashboard/ on disk."""
    if not isinstance(files, dict) or not files:
        return (
            False,
            f"needs a refresh: it is older than its own file report — {BOARD_FIX}",
        )
    changed = []
    for rel, served in sorted(files.items()):
        path = dashboard_dir / rel
        on_disk = (
            hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
        )
        if on_disk != served:
            changed.append(rel)
    if changed:
        more = f" and {len(changed) - 1} more" if len(changed) > 1 else ""
        return (
            False,
            f"needs a refresh: dashboard/{changed[0]}{more} changed since it was built — {BOARD_FIX}",
        )
    return True, f"serving the dashboard/ on disk ({len(files)} files)"
