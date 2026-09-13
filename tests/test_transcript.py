"""Stream-lined Markdown session transcripts (harness.adapters.transcript).

Contract under test:
  - a synthetic session DB built on the REAL projection schema
    (session/message/part) renders a transcript with user text verbatim,
    reasoning verbatim, and tool calls named with their input — while tool
    OUTPUT BODIES are stripped down to char count + exit code
  - non-transcriptable parts (step-start) are skipped silently
  - a missing DB is fail-open: returns "absent", never raises, and writes
    the honest one-line notice `_No session transcript available._`
  - the emitted transcript is valid Markdown: it starts with
    `# Session transcript` and every entry heading is `## <n>. <label>`
    with sequential numbering (no gaps)
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

from harness.adapters.transcript import write_session_transcript

USER_VERBATIM = "USER-SENTINEL-7f3a please fix the login bug before Friday"
REASONING_VERBATIM = (
    "REASONING-SENTINEL-b21c the token expires at midnight UTC, "
    "so the refresh must happen first"
)
LONG_OUTPUT_BODY = "OUTPUT-SENTINEL-9d4e " * 300  # 6300 chars, never emitted
SHOULD_BE_SKIPPED = "STEPSTART-SENTINEL-c8d2 must never reach the transcript"

_ENTRY_HEADING = re.compile(r"^## (\d+)\. ")


def _make_session_db(db_path: Path) -> None:
    """Build a synthetic session DB with the REAL projection schema.

    The projection queries `part JOIN message ON m.id = p.message_id
    WHERE p.session_id = ?` ordered by message time/rowid then part
    time/rowid, so all three tables (session, message, part) with their
    ordering columns must exist — the flat 2-column part helper used
    elsewhere in the suite is not sufficient here.
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
            "INSERT INTO session VALUES (?, ?, ?)",
            ("ses_synth", 1, "/synthetic"),
        )
        messages = [
            ("msg_user", 100, {"role": "user"}),
            ("msg_reasoning", 200, {"role": "assistant"}),
            ("msg_tool", 300, {"role": "assistant"}),
        ]
        for msg_id, created, data in messages:
            conn.execute(
                "INSERT INTO message VALUES (?, ?, ?, ?)",
                (msg_id, "ses_synth", created, json.dumps(data)),
            )
        parts = [
            (
                "part_user_text",
                "msg_user",
                101,
                {"type": "text", "text": USER_VERBATIM},
            ),
            (
                "part_reasoning",
                "msg_reasoning",
                201,
                {"type": "reasoning", "text": REASONING_VERBATIM},
            ),
            (
                "part_step_start",
                "msg_tool",
                300,
                {"type": "step-start", "text": SHOULD_BE_SKIPPED},
            ),
            (
                "part_tool",
                "msg_tool",
                301,
                {
                    "type": "tool",
                    "tool": "bash",
                    "state": {
                        "input": {"command": "echo hi"},
                        "output": LONG_OUTPUT_BODY,
                        "metadata": {"exit": 0},
                    },
                },
            ),
        ]
        for part_id, msg_id, created, data in parts:
            conn.execute(
                "INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)",
                (part_id, msg_id, "ses_synth", created, created, json.dumps(data)),
            )
        conn.commit()
    finally:
        conn.close()


def test_synthetic_db_verbatim_named_stripped(tmp_path: Path) -> None:
    """(a) user/reasoning verbatim, tool named, tool output stripped."""
    db_path = tmp_path / "opencode.db"
    transcript_path = tmp_path / "transcript.md"
    _make_session_db(db_path)

    status = write_session_transcript(db_path, transcript_path)

    assert status == "ok"
    content = transcript_path.read_text(encoding="utf-8")
    # user text and reasoning survive verbatim, correctly labeled
    assert USER_VERBATIM in content
    assert REASONING_VERBATIM in content
    assert "## 1. User" in content
    assert "## 2. Reasoning" in content
    # the tool call is named and its input shown
    assert "tool: bash" in content
    assert '**input:** `{"command":"echo hi"}`' in content
    # the tool OUTPUT BODY is stripped: only size + exit code survive
    assert LONG_OUTPUT_BODY not in content
    assert "OUTPUT-SENTINEL-9d4e" not in content
    expected_output_line = f"**output:** {len(LONG_OUTPUT_BODY)} chars, exit 0"
    assert expected_output_line in content
    # non-transcriptable parts are skipped silently
    assert SHOULD_BE_SKIPPED not in content


def test_missing_db_writes_honest_notice(tmp_path: Path) -> None:
    """(b) missing DB -> "absent", does not raise, honest one-line notice."""
    transcript_path = tmp_path / "transcript.md"

    # fail-open: this call must NOT raise
    status = write_session_transcript(
        tmp_path / "nope" / "opencode.db", transcript_path
    )

    assert status == "absent"
    content = transcript_path.read_text(encoding="utf-8")
    assert "_No session transcript available._" in content


def test_transcript_is_valid_markdown(tmp_path: Path) -> None:
    """(c) header present, entry headings `## <n>. ` sequential, non-empty."""
    db_path = tmp_path / "opencode.db"
    transcript_path = tmp_path / "transcript.md"
    _make_session_db(db_path)

    status = write_session_transcript(db_path, transcript_path)
    assert status == "ok"

    content = transcript_path.read_text(encoding="utf-8")
    assert content  # non-empty
    assert content.startswith("# Session transcript")

    numbers: list[int] = []
    for line in content.splitlines():
        if line.startswith("## "):
            match = _ENTRY_HEADING.match(line)
            assert match is not None, f"malformed entry heading: {line!r}"
            numbers.append(int(match.group(1)))
    # sequential renumbering, no gaps: user, reasoning, tool (step-start
    # is skipped and does not consume a number)
    assert numbers == list(range(1, len(numbers) + 1))
    assert numbers == [1, 2, 3]
