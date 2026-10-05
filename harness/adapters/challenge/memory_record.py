"""One record per cell of what memory did, measured from outside the memory system.

Written to ``<run_dir>/memory.json`` for every real cell, in BOTH arms, so an
ON cell is always read against OFF cells measured the same way:

- ``first_prompt_tokens``: the size of the cell's first model request (input +
  cache read + cache write of the first assistant message, as opencode counts
  it). Both arms send the same task, so what an ON cell's first request carries
  beyond the OFF range is what memory put in front of the model.
- ``tool_calls``: tool calls by name, so a memory tool the model chose to call
  shows up beside the work tools.

And for a memory-ON cell only:

- ``plugin``: the baked plugin's name@version; ``memory_config``: where it was
  pointed (settings redacted — harness/memory_slot.py).
- ``memory_route``: the sidecar's count of the plugin's requests to its server
  and how they ended (images/sidecar/egress-sidecar.js). No requests, or none
  answered, means the cell ran without the memory it was labelled with.
- ``ready_before`` / ``ready_after``: the waits for the memory system to finish
  its background work (harness/memory_hooks.py), outside the cell's wall time.
- ``cost_before`` / ``cost_after`` / ``cost``: the memory system's own running
  counters around the cell, and what they grew by.

None of it changes how a cell runs or is graded; a value that could not be
read is null, never zero.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from collections import Counter
from pathlib import Path
from typing import Any

from harness.memory_hooks import cost_delta, read_cost, wait_until_ready

from ..docker_worker import LOOP_KILL_MARKER_DIRNAME

_LOG = logging.getLogger(__name__)

MEMORY_RECORD_FILENAME = "memory.json"
#: Written by the egress sidecar into the cell's marker dir.
MEMORY_ROUTE_FILENAME = "memory-route.json"


def _rows(session_db: Path, sql: str) -> list[tuple[Any, ...]] | None:
    """Rows from the exported session DB, read-only; None if it cannot be read."""
    if not session_db.is_file():
        return None
    try:
        conn = sqlite3.connect(f"file:{session_db}?mode=ro", uri=True, timeout=5.0)
    except sqlite3.Error:
        return None
    try:
        return conn.execute(sql).fetchall()
    except sqlite3.Error as exc:
        _LOG.warning(
            "memory_record session db unreadable path=%s error_class=%s",
            session_db,
            exc.__class__.__name__,
        )
        return None
    finally:
        conn.close()


def _json(raw: Any) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def first_prompt_tokens(session_db: Path) -> int | None:
    """Tokens in the cell's first model request; None if none was recorded."""
    rows = _rows(
        session_db, "SELECT data FROM message ORDER BY time_created ASC, rowid ASC"
    )
    if rows is None:
        return None
    for (raw,) in rows:
        message = _json(raw)
        tokens = message.get("tokens")
        if message.get("role") != "assistant" or not isinstance(tokens, dict):
            continue
        cache = tokens.get("cache") if isinstance(tokens.get("cache"), dict) else {}
        prompt = sum(
            int(v or 0)
            for v in (tokens.get("input"), cache.get("read"), cache.get("write"))
        )
        if prompt > 0:  # an aborted request reports no tokens
            return prompt
    return None


def tool_calls_by_name(session_db: Path) -> dict[str, int] | None:
    """Tool calls in the cell, by tool name; None if the DB cannot be read."""
    rows = _rows(session_db, "SELECT data FROM part")
    if rows is None:
        return None
    counts: Counter[str] = Counter()
    for (raw,) in rows:
        part = _json(raw)
        if part.get("type") == "tool":
            counts[str(part.get("tool") or "unknown")] += 1
    return dict(sorted(counts.items()))


def read_memory_route(run_dir: Path) -> dict[str, Any] | None:
    """The sidecar's memory-route traffic count; None when it wrote none."""
    path = run_dir / LOOP_KILL_MARKER_DIRNAME / MEMORY_ROUTE_FILENAME
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _said(ready: dict[str, Any] | None) -> str:
    if ready is None:
        return "check=none"
    return f"ready={str(ready['ready']).lower()} waited_s={ready['waited_s']}"


class MemoryRecordMixin:
    """Brackets a cell (ChallengeRunner.run_cell) with the memory measurements."""

    def _memory_begin(self, *, run_label: str) -> None:
        """Before the cell: wait for memory to be ready, read its counters.

        Raises MemoryNotReady (harness/memory_hooks.py) when the memory system
        is still busy after the timeout: the cell would otherwise start against
        memory that has not finished digesting the cells before it.
        """
        self._memory_record: dict[str, Any] | None = None
        self._memory_config: dict[str, Any] | None = None
        if self.mock is not None:
            return
        record: dict[str, Any] = {"memory_mode": self.memory_mode}
        if self.memory_mode == "on":
            record["ready_before"] = wait_until_ready()
            record["cost_before"] = read_cost()
            self._progress(
                f"PROGRESS run_label={run_label} step=memory-ready when=before "
                f"{_said(record['ready_before'])}"
            )
        self._memory_record = record

    def _memory_finish(self, *, run_label: str, run_dir: Path) -> None:
        """After the cell: measure delivery, wait for memory, take the cost."""
        record = getattr(self, "_memory_record", None)
        if record is None:
            return
        run_dir = Path(run_dir).expanduser().resolve()
        session_db = run_dir / "session-db" / "opencode.db"
        record["first_prompt_tokens"] = first_prompt_tokens(session_db)
        record["tool_calls"] = tool_calls_by_name(session_db)
        if self.memory_mode == "on":
            baked = getattr(self, "_baked_plugin", None)
            record["plugin"] = baked.identity if baked else None
            record["memory_config"] = getattr(self, "_memory_config", None)
            record["memory_route"] = read_memory_route(run_dir)
            # Not raised here: the cell already ran and was graded. A memory
            # system still busy now stops the NEXT cell, in _memory_begin.
            record["ready_after"] = wait_until_ready(raise_on_timeout=False)
            record["cost_after"] = read_cost()
            record["cost"] = cost_delta(record.get("cost_before"), record["cost_after"])
        try:
            (run_dir / MEMORY_RECORD_FILENAME).write_text(
                json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
        except OSError as exc:
            # The cell already ran and was graded; a lost record is reported,
            # never turned into a failed cell.
            self._progress(
                f"PROGRESS run_label={run_label} step=memory-record "
                f"error=write-failed detail={exc.__class__.__name__}"
            )
            return
        route = record.get("memory_route") or {}
        self._progress(
            f"PROGRESS run_label={run_label} step=memory-record "
            f"memory_mode={self.memory_mode} "
            f"first_prompt_tokens={record['first_prompt_tokens']} "
            + (
                f"route_requests={route.get('requests', 0)} "
                f"route_unreachable={route.get('unreachable', 0)} "
                f"{_said(record['ready_after'])}"
                if self.memory_mode == "on"
                else "route=none"
            )
        )
