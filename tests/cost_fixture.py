"""Builders for the on-disk artifacts ``derive_cost_from_disk`` reads.

WHY BUILD AT TEST TIME AND NOT COMMIT A FIXTURE. The cost record is derived
from three artifacts produced by three different components — an exported
sqlite session DB (the adapter), ``live.jsonl`` (the live streamer) and
``attempt-N-report.json`` (the grader). Committing a binary DB would pin today's
schema with nothing readable stating what a column means, so the DB is built
here the way ``tests/test_memory_record.py`` builds its own.

DELETE JOURNAL MODE IS PART OF THE FIXTURE, not an accident. ``cost_from_disk``
opens the DB ``mode=ro`` through a URI so a real export's last writes (still in
its WAL tail) are visible. A fixture that left its rows in a ``-wal`` sidecar
would pass only because this process still had the file open; committing in
DELETE mode puts every row in the main file, so the test proves the reader works
on a DB it did not write.

ANONYMIZED ON PURPOSE. Session id, directory, task and model are placeholders.
The wall anchors of the stopped-while-paused fixture are the real values
measured on run 1793876536, because the paused/wall arithmetic is the thing
those numbers exist to test.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

#: Placeholder session id — never a real one.
SESSION_ID = "ses_anon"

#: Wall anchors of the real cell stopped inside an operator pause (run
#: 1793876536). ``BOUNDARY_MS`` is attempt 1's ``attempt.end`` — the moment the
#: build phase ended — and ``PAUSE_START_MS`` is a ``pause.start`` that never
#: got its ``pause.end`` because the operator killed the cell 140.793s later.
CELL_START_MS = 1_793_876_565_499
BOUNDARY_MS = 1_793_882_346_476
PAUSE_START_MS = 1_793_882_346_528
CELL_END_MS = 1_793_882_487_321

#: Context peak the whole stopped-while-paused fixture reports (its largest
#: assistant message), mirrored onto the live stream's own peak rows.
STOPPED_PEAK_TOKENS = 4_000


def tokens(
    *,
    input_: int,
    output: int,
    reasoning: int,
    cache_read: int,
    cache_write: int,
) -> dict[str, Any]:
    """A full ``tokens`` object whose ``total`` is the sum of its parts.

    The identity is not decoration: ``message_context_tokens`` prefers ``total``
    while the phase sums add the parts, so a fixture whose total disagreed with
    its parts would have peak and sums silently describing different messages.
    """
    return {
        "total": input_ + output + reasoning + cache_read + cache_write,
        "input": input_,
        "output": output,
        "reasoning": reasoning,
        "cache": {"read": cache_read, "write": cache_write},
    }


def write_session_db(run_dir: Path, messages: Sequence[dict[str, Any]]) -> Path:
    """Write ``session-db/opencode.db`` in opencode's ``message``/``part`` schema.

    Each message dict carries ``time_created``, ``mode``, ``tokens`` and
    optionally ``summary`` / ``finish`` / ``error`` — the fields of the real
    assistant row this derivation reads. A compaction gets its ``part`` row too,
    because that is what a real completed compaction leaves behind.
    """
    db = run_dir / "session-db" / "opencode.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db)
    try:
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.execute(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, "
            "time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL)"
        )
        conn.execute(
            "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, "
            "session_id TEXT, data TEXT)"
        )
        for index, message in enumerate(messages):
            stamp = int(message["time_created"])
            data: dict[str, Any] = {
                "role": "assistant",
                "mode": message["mode"],
                "finish": message.get("finish", "stop"),
                "tokens": message["tokens"],
            }
            if message.get("summary"):
                data["summary"] = True
            if "error" in message:
                data["error"] = message["error"]
            message_id = f"msg_{index:03d}"
            conn.execute(
                "INSERT INTO message VALUES (?, ?, ?, ?, ?)",
                (message_id, SESSION_ID, stamp, stamp, json.dumps(data)),
            )
            if message.get("summary"):
                conn.execute(
                    "INSERT INTO part VALUES (?, ?, ?, ?)",
                    (
                        f"part_{index:03d}",
                        message_id,
                        SESSION_ID,
                        json.dumps({"type": "compaction"}),
                    ),
                )
        conn.commit()
    finally:
        conn.close()
    return db


def write_live(run_dir: Path, events: Iterable[dict[str, Any]]) -> Path:
    """Write ``live.jsonl``, one compact JSON record per line."""
    path = run_dir / "live.jsonl"
    run_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(event) + "\n" for event in events), encoding="utf-8"
    )
    return path


def write_report(run_dir: Path, attempt: int, statuses: list[str]) -> Path:
    """Publish ``attempt-N-report.json`` whose gate rows carry ``statuses``."""
    run_dir.mkdir(parents=True, exist_ok=True)
    rows = [
        {"gate": f"g{index}", "status": status} for index, status in enumerate(statuses)
    ]
    path = run_dir / f"attempt-{attempt}-report.json"
    path.write_text(
        json.dumps({"gate_results": rows}),
        encoding="utf-8",
    )
    return path


# ── THE STOPPED-WHILE-PAUSED CELL ────────────────────────────────────────────
#
# Three build turns and five completed compactions, all at or before the
# boundary. Chosen so every figure the record asserts is small enough to read
# off the fixture: token totals 1000/2000/500/4000/600/700/800/900.

STOPPED_WHILE_PAUSED_MESSAGES: tuple[dict[str, Any], ...] = (
    {
        "time_created": 1_793_876_600_000,
        "mode": "build",
        "tokens": tokens(
            input_=600, output=200, reasoning=100, cache_read=90, cache_write=10
        ),
    },
    {
        "time_created": 1_793_876_700_000,
        "mode": "build",
        "tokens": tokens(
            input_=1_200, output=400, reasoning=200, cache_read=180, cache_write=20
        ),
    },
    {
        "time_created": 1_793_876_800_000,
        "mode": "compaction",
        "summary": True,
        "tokens": tokens(
            input_=300, output=100, reasoning=60, cache_read=30, cache_write=10
        ),
    },
    {
        "time_created": 1_793_877_000_000,
        "mode": "build",
        "tokens": tokens(
            input_=2_400, output=800, reasoning=400, cache_read=360, cache_write=40
        ),
    },
    {
        "time_created": 1_793_877_100_000,
        "mode": "compaction",
        "summary": True,
        "tokens": tokens(
            input_=360, output=120, reasoning=72, cache_read=36, cache_write=12
        ),
    },
    {
        "time_created": 1_793_877_300_000,
        "mode": "compaction",
        "summary": True,
        "tokens": tokens(
            input_=420, output=140, reasoning=84, cache_read=42, cache_write=14
        ),
    },
    {
        "time_created": 1_793_877_500_000,
        "mode": "compaction",
        "summary": True,
        "tokens": tokens(
            input_=480, output=160, reasoning=96, cache_read=48, cache_write=16
        ),
    },
    {
        "time_created": 1_793_878_000_000,
        "mode": "compaction",
        "summary": True,
        "tokens": tokens(
            input_=540, output=180, reasoning=108, cache_read=54, cache_write=18
        ),
    },
)


def write_stopped_while_paused(run_dir: Path) -> None:
    """The cell that published everything it had, then was stopped in a pause.

    Exactly the shape that used to lose its cost entirely: the session DB, the
    live stream and attempt 1's report all landed, then the operator killed the
    cell before any troubleshooting round and before the pause was released.
    """
    write_session_db(run_dir, STOPPED_WHILE_PAUSED_MESSAGES)
    write_live(
        run_dir,
        [
            {
                "v": 1,
                "ts": 1_793_876_560_032,
                "kind": "run.start",
                "task": "backgammon",
            },
            {
                "v": 1,
                "ts": CELL_START_MS,
                "kind": "cell.start",
                "session_id": SESSION_ID,
                "cell_seq": 0,
            },
            *(
                {
                    "v": 1,
                    "ts": 1_793_876_565_502 + index * 1_000_000,
                    "kind": "phase.start",
                    "phase": f"initial-chunk-{index + 1}",
                }
                for index in range(5)
            ),
            {
                "v": 1,
                "ts": BOUNDARY_MS,
                "kind": "attempt.end",
                "attempt": 1,
                "verdict": "FAIL",
                "context_peak": STOPPED_PEAK_TOKENS,
            },
            {
                "v": 1,
                "ts": PAUSE_START_MS,
                "kind": "pause.start",
                "pause_kind": "round",
                "attempt": 1,
            },
            {
                "v": 1,
                "ts": CELL_END_MS,
                "kind": "cell.end",
                "terminal_reason": "stopped",
                "terminal_exception": "KeyboardInterrupt",
                "context_peak": STOPPED_PEAK_TOKENS,
            },
        ],
    )
    write_report(run_dir, 1, ["pass", "fail", "not_run"])


# ── A CELL THAT GOT THROUGH ITS BUILD AND INTO TROUBLESHOOTING ───────────────
#
# Messages on BOTH sides of the boundary: two build turns and a build
# compaction, then a troubleshooting turn and a troubleshooting compaction, with
# one report per phase. Walls are round numbers (100s build, 60s troubleshooting)
# so a wrong fold shows up as an obviously wrong number.

PARTITION_START_MS = 1_793_000_000_000
PARTITION_BOUNDARY_MS = 1_793_000_100_000
PARTITION_END_MS = 1_793_000_160_000

PARTITION_MESSAGES: tuple[dict[str, Any], ...] = (
    {
        "time_created": PARTITION_START_MS + 10_000,
        "mode": "build",
        "tokens": tokens(
            input_=600, output=200, reasoning=100, cache_read=90, cache_write=10
        ),
    },
    {
        "time_created": PARTITION_START_MS + 20_000,
        "mode": "build",
        "tokens": tokens(
            input_=1_200, output=400, reasoning=200, cache_read=180, cache_write=20
        ),
    },
    {
        "time_created": PARTITION_START_MS + 30_000,
        "mode": "compaction",
        "summary": True,
        "tokens": tokens(
            input_=300, output=100, reasoning=60, cache_read=30, cache_write=10
        ),
    },
    {
        "time_created": PARTITION_BOUNDARY_MS + 10_000,
        "mode": "build",
        "tokens": tokens(
            input_=1_800, output=600, reasoning=300, cache_read=270, cache_write=30
        ),
    },
    {
        "time_created": PARTITION_BOUNDARY_MS + 20_000,
        "mode": "compaction",
        "summary": True,
        "tokens": tokens(
            input_=420, output=140, reasoning=84, cache_read=42, cache_write=14
        ),
    },
)


def write_partitioned(run_dir: Path) -> None:
    """A cell with a graded build and a graded troubleshooting round."""
    write_session_db(run_dir, PARTITION_MESSAGES)
    write_live(
        run_dir,
        [
            {
                "v": 1,
                "ts": PARTITION_START_MS,
                "kind": "cell.start",
                "session_id": SESSION_ID,
                "cell_seq": 0,
            },
            {
                "v": 1,
                "ts": PARTITION_BOUNDARY_MS,
                "kind": "attempt.end",
                "attempt": 1,
                "verdict": "FAIL",
                "context_peak": 2_000,
            },
            {
                "v": 1,
                "ts": PARTITION_END_MS,
                "kind": "cell.end",
                "terminal_reason": "gates_green",
                "context_peak": 2_000,
            },
        ],
    )
    write_report(run_dir, 1, ["pass", "fail", "not_run"])
    write_report(run_dir, 2, ["pass", "pass"])
