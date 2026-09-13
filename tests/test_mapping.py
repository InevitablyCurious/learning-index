"""Session mapping (harness.adapters.mapping).

Contract under test:
  - (a) phase entry ranges agree with the transcript: for a synthetic
    session DB with two feedback boundaries, write_session_mapping emits
    one phase per check-point whose inclusive [start, end] entry ranges
    exactly partition the transcript's 1..N sequence numbers, and each
    feedback phase starts at the User entry carrying its feedback text
  - (b) missing inputs are fail-open and honest: an absent session DB
    returns "absent-db" with per-phase entries null plus a "session db
    absent" notice; an absent check-point index returns "absent-index"
    with phases [] plus a "checkpoint index absent" notice — never raises
  - a trailing feedback phase with no check-point gets checkpoint null
    and still receives its entry range
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

from harness.adapters.mapping import write_session_mapping
from harness.adapters.transcript import write_session_transcript

_HEADING = re.compile(r"^## (\d+)\. (.+)$")


def _make_session_db(db_path: Path, turns: list[tuple[str, list[dict]]]) -> None:
    """Build a synthetic session DB on the REAL projection schema.

    turns: list of (role, [part_dict, ...]) in time order. The projection
    queries `part JOIN message` ordered by message time/rowid then part
    time/rowid, so all three tables with their ordering columns must exist.
    """
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "CREATE TABLE session ("
            "id TEXT PRIMARY KEY, time_created INTEGER, directory TEXT)"
        )
        conn.execute(
            "CREATE TABLE message ("
            "id TEXT PRIMARY KEY, session_id TEXT, "
            "time_created INTEGER, data TEXT)"
        )
        conn.execute(
            "CREATE TABLE part ("
            "id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, "
            "time_created INTEGER, time_updated INTEGER, data TEXT)"
        )
        conn.execute(
            "INSERT INTO session (id, time_created, directory) "
            "VALUES ('ses-1', 1, '/synthetic')"
        )
        mtime = 100
        ptime = 100
        mid = 0
        pid = 0
        for role, parts in turns:
            mid += 1
            mtime += 100
            conn.execute(
                "INSERT INTO message (id, session_id, time_created, data) "
                "VALUES (?,?,?,?)",
                (f"m{mid}", "ses-1", mtime, json.dumps({"role": role})),
            )
            for part in parts:
                pid += 1
                ptime += 10
                conn.execute(
                    "INSERT INTO part (id, message_id, session_id, "
                    "time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
                    (f"p{pid}", f"m{mid}", "ses-1", ptime, ptime,
                     json.dumps(part)),
                )
        conn.commit()
    finally:
        conn.close()


def _cp(attempt: int, phase: str, id: str) -> dict:
    """One check-point index entry."""
    return {
        "id": id,
        "attempt": attempt,
        "phase": phase,
        "state_hash": "h",
        "wall_ts": attempt,
        "tree_path": f"checkpoints/{id}/tree",
    }


def _write_index(path: Path, run_id: str, checkpoints: list[dict]) -> None:
    path.write_text(
        json.dumps(
            {"run_id": run_id, "checkpoints": checkpoints, "diffs": []}
        ),
        encoding="utf-8",
    )


def _event(kind: str, attempt: int, text: str) -> dict:
    """One user-events sidecar record."""
    return {
        "type": "user",
        "kind": kind,
        "timestamp": attempt,
        "attempt": attempt,
        "chars": len(text),
        "text_fp": text[:8],
        "text": text,
    }


def _write_sidecar(path: Path, events: list[dict]) -> None:
    lines = [json.dumps(event, separators=(",", ":")) for event in events]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _transcript_headings(text: str) -> list[tuple[int, str]]:
    headings = []
    for line in text.splitlines():
        match = _HEADING.match(line)
        if match:
            headings.append((int(match.group(1)), match.group(2)))
    return headings


def test_mapping_ranges_agree_with_transcript(tmp_path: Path) -> None:
    """(a) phase ranges are the transcript's own sequence numbers."""
    db = tmp_path / "opencode.db"
    _make_session_db(
        db,
        [
            ("user", [{"type": "text", "text": "chunk-1 prompt text"}]),
            (
                "assistant",
                [
                    {"type": "reasoning", "text": "thinking about chunk 1"},
                    {"type": "step-start"},
                    {
                        "type": "tool",
                        "tool": "bash",
                        "state": {
                            "input": {"command": "ls"},
                            "output": "x",
                            "metadata": {"exit": 0},
                        },
                    },
                ],
            ),
            ("user", [{"type": "text", "text": "chunk-2 prompt text"}]),
            ("assistant", [{"type": "text", "text": "assistant response"}]),
            ("user", [{"type": "text", "text": "FEEDBACK1"}]),
            (
                "assistant",
                [
                    {
                        "type": "tool",
                        "tool": "edit",
                        "state": {
                            "input": {"filePath": "a.py"},
                            "output": "",
                            "metadata": {"exit": 0},
                        },
                    },
                    {"type": "text", "text": "fixed it"},
                ],
            ),
            ("user", [{"type": "text", "text": "FEEDBACK2"}]),
            (
                "assistant",
                [
                    {
                        "type": "tool",
                        "tool": "write",
                        "state": {
                            "input": {"filePath": "b.py"},
                            "output": "",
                            "metadata": {"exit": 0},
                        },
                    },
                    {"type": "text", "text": "done"},
                ],
            ),
        ],
    )
    index = tmp_path / "index.json"
    _write_index(
        index,
        "run-synth",
        [
            _cp(1, "initial", "cp-01"),
            _cp(2, "feedback-1", "cp-02"),
            _cp(3, "feedback-2", "cp-03"),
        ],
    )
    sidecar = tmp_path / "user-events.jsonl"
    _write_sidecar(
        sidecar,
        [
            _event("chunk", 1, "CHUNK-JOINED"),
            _event("feedback", 2, "FEEDBACK1"),
            _event("feedback", 3, "FEEDBACK2"),
        ],
    )

    transcript = tmp_path / "transcript.md"
    assert write_session_transcript(db, transcript) == "ok"
    headings = _transcript_headings(transcript.read_text(encoding="utf-8"))
    assert [n for n, _ in headings] == list(range(1, 12))

    out = tmp_path / "mapping.json"
    status = write_session_mapping(
        session_db_path=db,
        checkpoint_index_path=index,
        mapping_path=out,
        user_events_path=sidecar,
    )
    assert status == "ok"
    mapping = json.loads(out.read_text(encoding="utf-8"))
    assert mapping["run_id"] == "run-synth"
    assert mapping["phases"] == [
        {
            "phase": "initial",
            "attempt": 1,
            "checkpoint": "cp-01",
            "entries": [1, 5],
        },
        {
            "phase": "feedback-1",
            "attempt": 2,
            "checkpoint": "cp-02",
            "entries": [6, 8],
        },
        {
            "phase": "feedback-2",
            "attempt": 3,
            "checkpoint": "cp-03",
            "entries": [9, 11],
        },
    ]

    # each feedback phase starts at its User entry in the transcript
    assert headings[5][0] == 6 and headings[5][1] == "User"
    assert headings[8][0] == 9 and headings[8][1] == "User"

    # the phase ranges exactly partition 1..11
    covered: list[int] = []
    for phase in mapping["phases"]:
        start, end = phase["entries"]
        covered.extend(range(start, end + 1))
    assert covered == list(range(1, 12))


def test_mapping_missing_db_honest_notice(tmp_path: Path) -> None:
    """(b) absent session DB: fail-open, entries null, honest notice."""
    index = tmp_path / "index.json"
    _write_index(
        index,
        "run-synth",
        [_cp(1, "initial", "cp-01"), _cp(2, "feedback-1", "cp-02")],
    )
    out = tmp_path / "mapping.json"
    status = write_session_mapping(
        session_db_path=tmp_path / "missing.db",
        checkpoint_index_path=index,
        mapping_path=out,
        user_events_path=None,
    )
    assert status == "absent-db"
    mapping = json.loads(out.read_text(encoding="utf-8"))
    assert len(mapping["phases"]) == 2
    for phase, cp_id in zip(mapping["phases"], ["cp-01", "cp-02"]):
        assert phase["entries"] is None
        assert phase["checkpoint"] == cp_id
    assert "session db absent" in mapping["notice"]


def test_mapping_missing_index_honest_notice(tmp_path: Path) -> None:
    """Absent check-point index: fail-open, phases [], honest notice."""
    db = tmp_path / "opencode.db"
    _make_session_db(db, [("user", [{"type": "text", "text": "hi"}])])
    out = tmp_path / "mapping.json"
    status = write_session_mapping(
        session_db_path=db,
        checkpoint_index_path=tmp_path / "missing-index.json",
        mapping_path=out,
    )
    assert status == "absent-index"
    mapping = json.loads(out.read_text(encoding="utf-8"))
    assert mapping["phases"] == []
    assert "checkpoint index absent" in mapping["notice"]


def test_mapping_trailing_feedback_checkpoint_null(tmp_path: Path) -> None:
    """A trailing feedback phase with no check-point gets checkpoint null."""
    db = tmp_path / "opencode.db"
    _make_session_db(
        db,
        [
            ("user", [{"type": "text", "text": "chunk-1 prompt text"}]),
            ("assistant", [{"type": "text", "text": "work"}]),
            ("user", [{"type": "text", "text": "FEEDBACK1"}]),
            ("assistant", [{"type": "text", "text": "work"}]),
            ("user", [{"type": "text", "text": "FEEDBACK2"}]),
            ("assistant", [{"type": "text", "text": "work"}]),
        ],
    )
    index = tmp_path / "index.json"
    _write_index(
        index,
        "run-synth",
        [_cp(1, "initial", "cp-01"), _cp(2, "feedback-1", "cp-02")],
    )
    sidecar = tmp_path / "user-events.jsonl"
    _write_sidecar(
        sidecar,
        [
            _event("feedback", 2, "FEEDBACK1"),
            _event("feedback", 3, "FEEDBACK2"),
        ],
    )
    out = tmp_path / "mapping.json"
    status = write_session_mapping(
        session_db_path=db,
        checkpoint_index_path=index,
        mapping_path=out,
        user_events_path=sidecar,
    )
    assert status == "ok"
    mapping = json.loads(out.read_text(encoding="utf-8"))
    assert mapping["phases"] == [
        {
            "phase": "initial",
            "attempt": 1,
            "checkpoint": "cp-01",
            "entries": [1, 2],
        },
        {
            "phase": "feedback-1",
            "attempt": 2,
            "checkpoint": "cp-02",
            "entries": [3, 4],
        },
        {
            "phase": "feedback-2",
            "attempt": 3,
            "checkpoint": None,
            "entries": [5, 6],
        },
    ]
