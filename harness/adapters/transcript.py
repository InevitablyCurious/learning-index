"""Stream-lined Markdown session transcripts from the exported session DB.

At cell teardown the harness exports the container's opencode session DB
(``<cell>/session-db/opencode.db``). This module reads that export READ-ONLY
and renders a stream-lined Markdown transcript: user/assistant text verbatim,
reasoning verbatim, and tool calls reduced to name + input (or edited file
path) + output size and exit code — tool output bodies are never emitted.

Fail-open contract: :func:`write_session_transcript` NEVER raises. On missing,
unreadable, or empty input it writes an honest one-line notice instead of a
transcript and returns the matching status label (``"absent"``,
``"unreadable"``, ``"empty"``); ``"ok"`` means a transcript with at least one
emitted entry was written.

Read path: reuses the canonical part-join projection from
``client/packages/core/src/session-db-substrate.ts`` (``part JOIN message``
ordered by message time/rowid then part time/rowid) and the read-only
``file:...?mode=ro`` URI connection precedent from
``harness/adapters/backgammon.py``. Pure stdlib and self-contained; deliberately
does NOT import from backgammon.py (that would be circular once the teardown
caller lives there).
"""

import json
import logging
import sqlite3
from pathlib import Path

_LOG = logging.getLogger(__name__)

_HEADER = "# Session transcript"

_NOTICE = f"{_HEADER}\n\n_No session transcript available._\n"

_SESSION_IDS_SQL = "SELECT id FROM session ORDER BY time_created ASC, rowid ASC"

_PARTS_SQL = (
    "SELECT p.data AS pdata, m.data AS mdata "
    "FROM part p JOIN message m ON m.id = p.message_id "
    "WHERE p.session_id = ? "
    "ORDER BY m.time_created ASC, m.rowid ASC, p.time_created ASC, p.rowid ASC"
)

_EDIT_TOOLS = frozenset({"edit", "write", "patch", "multiedit", "apply_patch"})

_FILE_INPUT_KEYS = ("filePath", "path", "file", "filepath", "file_path", "targetPath")

_INPUT_LIMIT = 200

_TRUNCATION_NOTE = " … (truncated)"


def write_session_transcript(session_db_path: Path, transcript_path: Path) -> str:
    """Write the stream-lined Markdown session transcript to `transcript_path`.

    Reads the exported session DB at `session_db_path` READ-ONLY and writes the
    transcript. Fail-open: NEVER raises. On missing/unreadable/not-a-database/
    empty input, writes an honest one-line notice instead of a transcript.

    Returns a short status label in {"ok", "absent", "unreadable", "empty"}.
    """
    try:
        if not session_db_path.is_file():
            _write_notice(transcript_path)
            return "absent"
        try:
            rows = _read_part_rows(session_db_path)
        except sqlite3.Error as exc:
            _LOG.warning(
                "session transcript db unreadable path=%s error_class=%s",
                session_db_path,
                exc.__class__.__name__,
            )
            _write_notice(transcript_path)
            return "unreadable"
        entries = _render_entries(rows)
        if not entries:
            _write_notice(transcript_path)
            return "empty"
        transcript_path.write_text(
            _HEADER + "\n\n" + "".join(entries), encoding="utf-8"
        )
        return "ok"
    except Exception as exc:
        _LOG.warning(
            "session transcript failed path=%s error_class=%s",
            session_db_path,
            exc.__class__.__name__,
        )
        try:
            _write_notice(transcript_path)
        except OSError:
            _LOG.warning(
                "session transcript notice unwritable path=%s", transcript_path
            )
        return "unreadable"


def read_kept_entries(session_db_path: Path) -> list[dict]:
    """ordered kept entries shared with the renderer; same skip rule as
    write_session_transcript; [] on missing/unreadable"""
    if not session_db_path.is_file():
        return []
    try:
        rows = _read_part_rows(session_db_path)
    except Exception:
        return []
    return _select_entries(rows)


def _write_notice(transcript_path: Path) -> None:
    transcript_path.write_text(_NOTICE, encoding="utf-8")


def _read_part_rows(session_db_path: Path) -> list[tuple[str, str]]:
    """Return (pdata, mdata) rows for every session, in canonical order."""
    conn = sqlite3.connect(
        f"file:{session_db_path}?mode=ro", uri=True, timeout=5.0
    )
    try:
        session_ids = [row[0] for row in conn.execute(_SESSION_IDS_SQL)]
        rows: list[tuple[str, str]] = []
        for session_id in session_ids:
            rows.extend(conn.execute(_PARTS_SQL, (session_id,)))
        return rows
    finally:
        conn.close()


def _select_entries(rows: list[tuple[str, str]]) -> list[dict]:
    """Select the transcriptable rows into structured entries, in order.

    Entries are numbered sequentially (``seq``) with a running counter across
    all sessions; non-transcriptable part types (step-start, step-finish,
    compaction, patch, anything else) are skipped silently.
    """
    kept: list[dict] = []
    for pdata, mdata in rows:
        try:
            part = json.loads(pdata)
            message = json.loads(mdata)
        except (TypeError, ValueError) as exc:
            _LOG.warning(
                "session transcript malformed row skipped error_class=%s",
                exc.__class__.__name__,
            )
            continue
        if not isinstance(part, dict) or not isinstance(message, dict):
            _LOG.warning("session transcript non-object row skipped")
            continue
        part_type = part.get("type")
        if part_type in ("text", "reasoning"):
            text = part.get("text")
            if not isinstance(text, str) or not text:
                continue
            if part_type == "reasoning":
                label = "Reasoning"
                role = None
            else:
                role = message.get("role") or None
                label = "User" if role == "user" else "Assistant"
            kept.append(
                {
                    "seq": len(kept) + 1,
                    "role": role,
                    "type": part_type,
                    "label": label,
                    "text": text,
                }
            )
        elif part_type == "tool":
            kept.append(
                {
                    "seq": len(kept) + 1,
                    "role": None,
                    "type": "tool",
                    "label": None,
                    "text": None,
                    "part": part,
                }
            )
    return kept


def _render_entries(rows: list[tuple[str, str]]) -> list[str]:
    """Render each selected entry into a numbered Markdown entry block."""
    entries: list[str] = []
    for entry in _select_entries(rows):
        if entry["type"] == "tool":
            entries.append(_render_tool_entry(entry["part"], entry["seq"]))
        else:
            entries.append(
                f"## {entry['seq']}. {entry['label']}\n\n{entry['text']}\n\n"
            )
    return entries


def _render_tool_entry(part: dict, number: int) -> str:
    name = part.get("tool")
    if not isinstance(name, str) or not name:
        name = "tool"
    state = part.get("state")
    if not isinstance(state, dict):
        state = {}
    output_line = f"**output:** {_output_chars(state.get('output'))} chars"
    exit_value = _find_exit(state)
    if exit_value is not None:
        output_line += f", exit {exit_value}"
    if name.lower() in _EDIT_TOOLS:
        file_path = _find_file_path(state)
        detail_line = f"**file:** `{file_path}`" if file_path else "**file:** (unknown)"
    else:
        detail_line = f"**input:** `{_input_snippet(state.get('input'))}`"
    return f"## {number}. tool: {name}\n\n{detail_line}\n{output_line}\n\n"


def _find_exit(state: dict):
    """First found of state.exit / state.exit_code / state.exitCode /
    state.metadata.exit, else None."""
    for key in ("exit", "exit_code", "exitCode"):
        value = state.get(key)
        if value is not None:
            return value
    metadata = state.get("metadata")
    if isinstance(metadata, dict):
        value = metadata.get("exit")
        if value is not None:
            return value
    return None


def _output_chars(output) -> int:
    if isinstance(output, str):
        return len(output)
    if output is None:
        return 0
    return len(json.dumps(output))


def _input_snippet(value) -> str:
    snippet = (
        value
        if isinstance(value, str)
        else json.dumps(value, separators=(",", ":"))
    )
    if len(snippet) > _INPUT_LIMIT:
        snippet = snippet[:_INPUT_LIMIT] + _TRUNCATION_NOTE
    return snippet


def _find_file_path(state: dict) -> str:
    """First non-empty file-path candidate from state.input then
    state.metadata; empty string when none is found."""
    inputs = state.get("input")
    if isinstance(inputs, dict):
        for key in _FILE_INPUT_KEYS:
            value = inputs.get(key)
            if isinstance(value, str) and value:
                return value
    metadata = state.get("metadata")
    if isinstance(metadata, dict):
        for key in ("filepath", "path"):
            value = metadata.get(key)
            if isinstance(value, str) and value:
                return value
    return ""
