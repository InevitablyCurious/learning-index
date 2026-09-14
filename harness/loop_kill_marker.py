"""Loop-kill marker contract shared with the relay's sidecar scanner.

The sidecar (``loop-kill-scanner.cjs`` ``writeLoopKillMarker``) writes a marker
file when the relay's loop guard kills a generation. The harness waiter
(:meth:`harness.serve_client.ServeClient.wait_idle_detailed`) polls for THIS
session's marker so a marker-backed stall ends in one poll instead of burning
the stall bound or the whole budget.

Marker contract: a file named ``loop-kill-<session_id>.json`` containing JSON
``{"session_id": ..., "timestamp": <epoch_ms int>, "signature": ...}``.
Correlation is BOTH identity (the file name and the recorded ``session_id``
must match the waiting session) and freshness (epoch MILLISECONDS), and the
marker is consumed when honoured — see :func:`read_loop_kill_marker`.

Split out of ``harness/serve_client.py`` (WO LI-13) and re-exported there, so
every name still resolves from ``harness.serve_client``.
"""

from __future__ import annotations

import json
import os
import re

# Wait reason returned by :meth:`ServeClient.wait_idle_detailed` when a FRESH
# loop-kill marker file is present in the caller-supplied marker directory.
# The guard signature (``LOOP_GUARD_SIGNATURES`` in ``harness.serve_transport``)
# is only visible in the transcript AFTER the turn ends; a marker lets the
# waiter end a marker-backed stall in one poll instead of burning the full
# budget. Marker contract: a file named ``loop-kill-<session_id>.json``
# containing JSON ``{"session_id": ..., "timestamp": <epoch_ms int>,
# "signature": ...}``. Correlation is BOTH identity (the file name and the
# recorded ``session_id`` must match the waiting session) and freshness (epoch
# MILLISECONDS), and the marker is consumed when honoured — see
# :func:`read_loop_kill_marker`.
LOOP_KILL_WAIT_REASON = "loop_killed"


def loop_kill_marker_name(session_id: str) -> str:
    """Return the marker filename this session's kills are written to.

    Mirrors the sidecar's sanitizer EXACTLY (``loop-kill-scanner.cjs``
    ``writeLoopKillMarker``): every character outside ``[A-Za-z0-9_-]`` becomes
    ``_``. The two sides must agree byte-for-byte or the reader looks at a file
    the writer never writes.
    """
    return f"loop-kill-{re.sub(r'[^A-Za-z0-9_-]', '_', str(session_id))}.json"


def read_loop_kill_marker(
    marker_dir,
    since_ts_ms=None,
    *,
    session_id: str,
    consume: bool = False,
) -> bool:
    """Return True iff ``marker_dir`` holds a fresh marker FOR ``session_id``.

    ``marker_dir`` is a directory path (or None). The marker file is JSON:
    ``{"session_id": ..., "timestamp": <epoch_ms int>, "signature": ...}``.
    A marker counts when ALL of the following hold:

    * it is at ``loop_kill_marker_name(session_id)`` — no globbing;
    * its recorded ``session_id`` equals ``session_id`` EXACTLY;
    * its ``timestamp`` is present and, if ``since_ts_ms`` is given,
      ``timestamp >= since_ts_ms`` (both epoch MILLISECONDS — no unit
      conversion happens here).

    Unreadable or malformed markers are skipped, not raised: a half-written
    file must never wedge the waiter.

    WHY THE SESSION GATE IS EXACT (2026-09-08, run 1788883142). This used to
    glob ``loop-kill-*.json`` and check only the timestamp. The sidecar writes
    ``loop-kill-unknown.json`` whenever a request carries no ``X-Session-Id``
    header — which is every request that is not the model provider's. One real
    loop kill, replayed forever out of opencode's persisted message list,
    refreshed that file on every harness poll and killed 62 healthy turns. A
    marker with no session identity is not evidence about THIS session, so
    ``loop-kill-unknown.json`` can never be honoured: the name gate excludes it
    (``session_id`` is required, so the reader never asks for "unknown"), and
    the payload check excludes it again.

    ``consume=True`` deletes the marker once it has been honoured, so ONE
    marker can end at most ONE turn. Without it a marker that stops being
    refreshed still kills every later turn whose start precedes it. The
    delete races a same-instant sidecar rewrite; losing that write is the safe
    direction, because a still-looping session simply kills again on the next
    turn, whereas a retained marker wedges the cell.
    """
    if marker_dir is None or not os.path.isdir(marker_dir):
        return False
    path = os.path.join(marker_dir, loop_kill_marker_name(session_id))
    try:
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, ValueError):
        return False
    if not isinstance(payload, dict):
        return False
    if payload.get("session_id") != session_id:
        return False
    timestamp = payload.get("timestamp")
    if timestamp is None:
        return False
    if since_ts_ms is not None and timestamp < since_ts_ms:
        return False
    if consume:
        try:
            os.unlink(path)
        except OSError:
            # Best-effort: a marker we cannot delete still ended this turn.
            pass
    return True
