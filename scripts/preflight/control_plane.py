"""Control-plane freshness — is the RUNNING host process older than control/ on
disk? Same discipline as the worker image: code on disk but not in the process."""

from __future__ import annotations

import json
import urllib.request

from preflight.core import REPO, Check


def check_control_plane_freshness(c: Check) -> None:
    """Is the RUNNING control plane older than the control-plane source?

    THE FAILURE THIS EXISTS FOR (2026-09-02). The control plane is a long-lived
    HOST process, and `make control-start` is a deliberate no-op when :8718 is
    already listening — so `make up` never restarts it. A compaction launch ran
    with the flag present in `control/server.mjs` and absent from the argv the
    running process built, because that process had been up since before the
    edit. The run looked completely normal: no error, no warning, just a cell
    that quietly did not compact.

    SAME DISCIPLINE AS THE WORKER IMAGE. That check compares the image's build
    time against the newest file baked into it; this compares the process's
    start time against the newest file it would have parsed. A process cannot
    report which version of a file it read, but it can report when it started,
    and a start that predates the source proves the source is not what is
    running.

    BLOCKING. A stale control plane does not corrupt a run after launch — it
    shapes the argv AT launch and nothing after — but that is precisely the
    damage: the cell runs to completion, looks entirely normal, and measured
    something other than what was configured. The bench fails loud and aborts
    rather than salvaging; a run launched from a process that is not this code
    is exactly the kind of quietly-different experiment that rule exists for.

    This is self-diagnosing by construction: the board asks the control plane
    for preflight, so a stale control plane runs the check that names its own
    staleness and refuses the launch.

    DOWN IS NOT STALE, and is not a failure here — see below.
    """
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

    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:8718/api/health", timeout=3
        ) as resp:
            health = json.loads(resp.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 - any failure to reach it means it is down
        # DOWN IS NOT STALE. A board-launched run cannot start at all without
        # it, and a CLI run does not need it; either way "not running" is a
        # different fact from "running old code" and must not be reported as one.
        c.add(
            "control plane",
            True,
            "not running on :8718 — board launches unavailable "
            "(start it: node control/server.mjs)",
        )
        return

    ok, detail = control_plane_freshness_verdict(
        started_at=str(health.get("started_at") or ""),
        newest_mtime=newest,
        newest_path=newest_path,
    )
    # NO BUTTON. The fix is restarting this long-lived host process, and a
    # process cannot supervise its own replacement; the detail names the fix.
    c.add("control plane", ok, detail)


def control_plane_freshness_verdict(
    *, started_at: str, newest_mtime: float, newest_path: str
) -> tuple[bool, str]:
    """The decision, split out so it can be tested without a live service.

    Returns ``(ok, detail)``. Three cases, and the middle one is the one that
    actually fired: a control plane old enough to have no ``started_at`` field
    cannot be newer than the source that introduced the field, so it is stale by
    definition rather than by comparison.
    """
    if not started_at:
        return (
            False,
            "running, but reports no started_at — it predates the freshness "
            "field entirely, so it is DEFINITELY stale -> restart the control plane (node control/server.mjs)",
        )

    import datetime as _dt

    started_ts = _dt.datetime.fromisoformat(
        started_at.replace("Z", "+00:00")
    ).timestamp()
    stale = newest_mtime > started_ts
    return (
        not stale,
        f"started {started_at[:19]}"
        + (
            f" but {newest_path} is NEWER -> the running process is not this "
            "code; restart the control plane (node control/server.mjs)"
            if stale
            else " (newer than control/ — no restart needed)"
        ),
    )
