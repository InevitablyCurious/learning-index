"""Cell-telemetry scan/export leaves for the backgammon adapter.

Extracted verbatim from harness/adapters/backgammon/__init__.py
(WO-LI15-I1B STAGE 1B) and re-exported there, so every name stays
resolvable as harness.adapters.backgammon.<name>.

_LOG is this module's own logger -- importing the package-level one would
be circular. The logger name changes from harness.adapters.backgammon to
harness.adapters.backgammon.telemetry; the consumers are the fail-open
warnings in _export_cell_telemetry and in the TelemetryMixin scan methods.

STAGE 2B (WO-LI15-I2B) adds TelemetryMixin: the in-cell telemetry method
group moved out of BackgammonRunner, which inherits the mixin, so every
self./cls. cross-call resolves through the MRO. DECLARED_TEST_COMMANDS moved
here with its consumer (_extract_event_counts) -- the same pattern as
_MODEL_PRICING_USD_PER_1M moving to pricing.py in STAGE 2A -- and is
re-exported by the package __init__, so
harness.adapters.backgammon.DECLARED_TEST_COMMANDS stays resolvable. This
module must not import from the package __init__.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import re
import shutil
import sqlite3
import time

from harness.outcomes.predicate_emitter import walk_manifest

from .constants import _REPO_ROOT
from .models import RecallFunnelScan

_LOG = logging.getLogger(__name__)


def _snapshot_state_hash(worktree: Path) -> str | None:
    """Fingerprint the graded code for ONE attempt, at the moment it was graded.

    A cell keeps only its final worktree on disk, so a later reader cannot
    recover what the code looked like at attempt 1 or 2. Captured here, while
    that state still exists, each attempt's gate results stay bound to the code
    they actually ran against.

    Returns None on any failure: an unhashable worktree is recorded as having
    no snapshot, never as some other attempt's hash.
    """
    try:
        return walk_manifest(worktree)[1]
    except Exception:
        return None


def _worktree_has_injection_record(worktree: Path) -> bool:
    return (Path(worktree) / ".okp" / "org.json").is_file()


def _scan_cell_delivery(worktree: Path) -> str | None:
    plugin_log = worktree / ".okp" / "logs" / "okp-plugin-errors.log"
    try:
        payload = plugin_log.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return None

    matches = re.findall(r"\[inject\] injected count=(\d+)", payload)
    if not matches:
        return None
    if any(int(count) >= 1 for count in matches):
        return "YES"
    return "NO"


def _scan_injected_block_chars(worktree: Path) -> int | None:
    plugin_log = worktree / ".okp" / "logs" / "okp-plugin-errors.log"
    try:
        payload = plugin_log.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return None

    block_matches = re.findall(r"\[inject\] injected[^\n]*\bblock_chars=(\d+)", payload)
    if block_matches:
        return sum(int(chars) for chars in block_matches)

    legacy_matches = re.findall(r"\[inject\] injected[^\n]*\bchars=(\d+)", payload)
    if legacy_matches:
        return sum(int(chars) for chars in legacy_matches)

    return None


def _scan_recall_funnel(worktree: Path) -> RecallFunnelScan | None:
    plugin_log = worktree / ".okp" / "logs" / "okp-plugin-errors.log"
    try:
        payload = plugin_log.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return None

    fired_matches = re.findall(r"\brecall_fired\s+trigger=repeat_failure\b", payload)

    returned_matches = re.findall(
        r"\brecall_returned\s+status=\S+\s+count=(\d+)\s+reason_code=(\S+)\s+dur_ms=\d+\s+error=",
        payload,
    )
    recall_returned_count_sum = sum(
        int(count) for count, _reason_code in returned_matches
    )
    no_keywords_count = sum(
        1 for _count, reason_code in returned_matches if reason_code == "no_keywords"
    )

    injected_matches = re.findall(r"\[inject\]\s+injected\s+count=(\d+)", payload)
    injected_count = sum(int(count) for count in injected_matches)

    served_attempted = len(re.findall(r"\[serve\]\s+upsert\s+cid=", payload))
    served_failed = len(re.findall(r"\[serve\]\s+receipt\s+failed\b", payload))

    return RecallFunnelScan(
        recall_fired_total=len(fired_matches),
        recall_returned_total=len(returned_matches),
        recall_returned_count_sum=recall_returned_count_sum,
        no_keywords_count=no_keywords_count,
        injected_count=injected_count,
        served_attempted=served_attempted,
        served_failed=served_failed,
        served_confirmed=served_attempted - served_failed,
    )


def _export_cell_telemetry(
    worktree: Path, run_label: str, memory_mode: str = "on"
) -> Path | None:
    """Copy the plugin's observable recall surface host-side before teardown.

    ON cells write their plugin state INSIDE the cell worktree under
    ``.okp/state``; OFF cells write to a dedicated blind mount OUTSIDE the
    worktree at ``<cell>/extraction-state`` (container ``/okp-state``), so the
    OFF cell's extraction state never lands inside the worktree its model reads.
    This copies the funnel snapshot, plugin error log, and the in-session
    extraction tree (``insession/``: ``master.json`` + ``changed-lines.json``)
    host-side into ``data/cells/<unix_ts>-<run_label>/`` so they survive teardown.

    FAIL-OPEN by contract: telemetry export must never fail a cell. Any error is
    logged and swallowed, and the function returns None. ``data/`` is a
    telemetry/retention layer only -- ``runs/`` (RC-5) stays authoritative, and
    this never writes there.
    """
    if memory_mode.strip().lower() == "off":
        state_root = worktree.parent / "extraction-state"
    else:
        state_root = worktree / ".okp" / "state"
    sources = {
        "funnel-snapshot.json": state_root / "funnel-snapshot.json",
        "plugin-errors.log": worktree / ".okp" / "logs" / "okp-plugin-errors.log",
    }
    insession_src = state_root / "insession"
    present = {name: path for name, path in sources.items() if path.is_file()}
    has_insession = insession_src.is_dir()
    if not present and not has_insession:
        return None

    try:
        override = os.environ.get("BENCH_DATA_DIR", "").strip()
        data_dir = (
            Path(override) if override else _REPO_ROOT / "data"
        )
        dest = data_dir / "cells" / f"{int(time.time())}-{run_label}"
        dest.mkdir(parents=True, exist_ok=True)
        for name, path in present.items():
            shutil.copy2(path, dest / name)
        if has_insession:
            shutil.copytree(insession_src, dest / "insession")
        return dest
    except (OSError, shutil.Error) as exc:
        _LOG.warning("telemetry export failed for run_label=%s: %s", run_label, exc)
        return None


def _scan_funnel_snapshot(worktree: Path) -> dict[str, dict[str, int | None]] | None:
    """Read the plugin's per-session funnel counters from funnel-snapshot.json.

    The plugin writes this file into its state dir (``{worktree}/.okp/state``)
    periodically and on ``session.idle``. Content is a flat JSON object mapping
    sessionId -> counter dict (all numeric; ``gate_decision_ms`` is int|null).

    Mirrors the tolerant style of ``_scan_recall_funnel``: an absent or
    unreadable/corrupt file yields None (never a raise); a file that exists but
    carries no sessions yields ``{}``.
    """
    snapshot_path = worktree / ".okp" / "state" / "funnel-snapshot.json"
    try:
        payload = snapshot_path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return None

    try:
        parsed = json.loads(payload)
    except (ValueError, TypeError):
        return None

    if not isinstance(parsed, dict):
        return None

    sessions: dict[str, dict[str, int | None]] = {}
    for session_id, counters in parsed.items():
        if not isinstance(counters, dict):
            continue
        sessions[str(session_id)] = dict(counters)
    return sessions


# Harness-declared verification/test commands for the backgammon task.
# Gate runner = `node report.mjs` (grader/). Worker-invoked
# test commands are observed via bash tool_use events. test_invocations counts
# bash tool_use events whose command contains any declared string.
DECLARED_TEST_COMMANDS: tuple[str, ...] = (
    "node report.mjs",
    "npx vitest",
    "npx playwright",
    "npm test",
    "npm run test",
    "vitest",
    "playwright test",
)


class TelemetryMixin:
    def _emit_cost_target_warning_if_reached(
        self,
        *,
        run_label: str,
        phase: str,
        cumulative_cost_usd: float,
    ) -> None:
        if self.cost_target_usd is None:
            return
        if cumulative_cost_usd < self.cost_target_usd:
            return
        self._progress(
            f"WARNING run_label={run_label} step=cost-target phase={phase} "
            f"reason=cost_target_reached cumulative_cost_usd={cumulative_cost_usd:.4f} "
            f"target_usd={self.cost_target_usd:.4f}"
        )

    def _append_user_event(
        self,
        *,
        run_label: str,
        sidecar_path: Path,
        attempt: int,
        text: str,
        kind: str = "feedback",
    ) -> None:
        """Record, VERBATIM, every message the model is told a user sent.

        THIS FILE IS THE TRUTH (WO-FEEDBACK-1). It is the only place the exact
        bytes handed to the model are preserved — the PROGRESS log carries a
        length and a fingerprint but not the text, and the worker's own event
        stream shows the message only as it was consumed. The control plane
        serves this file so the TUI and the event feed show the operator what
        the model was actually told, not a reconstruction of it.

        `kind` distinguishes the three voices: `chunk` (the task itself),
        `pass_verdict` ("that fixed it"), `feedback` ("still failing"). The UI
        needs that separation — a chunk prompt and a failure report are not the
        same kind of message and must not render identically.

        Append-only, one JSON object per line: a run that dies mid-write leaves
        every earlier message intact and parseable.
        """
        payload = {
            "type": "user",
            "kind": str(kind),
            "timestamp": int(time.time() * 1000),
            "attempt": int(attempt),
            "chars": len(str(text)),
            "text_fp": self._fingerprint_text(text),
            "text": str(text),
        }
        sidecar_path.parent.mkdir(parents=True, exist_ok=True)
        with sidecar_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, separators=(",", ":")) + "\n")
        # The marker stays a fingerprint + length, never the body: this text is
        # multi-line and a single-line log record cannot carry it without
        # corrupting either the text or the log.
        self._progress(
            f"PROGRESS run_label={run_label} step=user-event-sidecar attempt={attempt} "
            f"kind={kind} chars={len(text)} text_fp={self._fingerprint_text(text)} "
            f"path={sidecar_path}"
        )

    def _extract_event_counts(
        self, session_db_path: Path
    ) -> tuple[int | None, int | None]:
        """Return (tool_calls, test_invocations) from the exported session DB.

        RE-POINTED 2026-09-04. This read the stdout transport's
        ``<worktree>.events.jsonl``, whose writer was deleted in the serve-only
        migration — so it returned ``(None, None)`` on every real cell and both
        numbers were permanently blank. The same facts survive in the per-cell
        session DB, which teardown exports BEFORE this runs: one ``part`` row
        per tool call, carrying the tool name and its input.

        ``test_invocations`` counts ``bash`` tool parts whose
        ``state.input.command`` contains any DECLARED_TEST_COMMANDS entry
        (plain case-sensitive substring match), unchanged from the old shape.

        ABSENCE IS STILL ABSENCE: a missing or unreadable DB returns
        ``(None, None)`` with a warning, never ``(0, 0)``. Zero tool calls is a
        real and different fact from "the source could not be read".
        """
        if not session_db_path.is_file():
            _LOG.warning(
                "backgammon tool telemetry unavailable path=%s reason=absent",
                session_db_path,
            )
            return None, None

        malformed_rows = 0
        tool_calls = 0
        test_invocations = 0

        # READ-ONLY, AND NEVER THE LIVE FILE. `mode=ro` on a file: URI so the
        # connection cannot create or modify the DB, and cannot recover a hot
        # journal — this is the exported copy of a quiesced database, not the
        # one a container is writing.
        try:
            conn = sqlite3.connect(
                f"file:{session_db_path}?mode=ro", uri=True, timeout=5.0
            )
        except sqlite3.Error as exc:
            _LOG.warning(
                "backgammon tool telemetry unavailable path=%s error_class=%s",
                session_db_path,
                exc.__class__.__name__,
            )
            return None, None

        try:
            rows = conn.execute("SELECT data FROM part").fetchall()
        except sqlite3.Error as exc:
            _LOG.warning(
                "backgammon tool telemetry unreadable path=%s error_class=%s",
                session_db_path,
                exc.__class__.__name__,
            )
            return None, None
        finally:
            conn.close()

        for (raw,) in rows:
            try:
                payload = json.loads(raw)
            except (TypeError, json.JSONDecodeError):
                malformed_rows += 1
                continue

            if not isinstance(payload, dict):
                malformed_rows += 1
                continue

            if payload.get("type") != "tool":
                continue

            tool_calls += 1
            if payload.get("tool") != "bash":
                continue

            state = (
                payload.get("state")
                if isinstance(payload.get("state"), dict)
                else {}
            )
            tool_input = (
                state.get("input") if isinstance(state.get("input"), dict) else {}
            )
            command = tool_input.get("command")
            if not isinstance(command, str):
                continue

            if any(declared in command for declared in DECLARED_TEST_COMMANDS):
                test_invocations += 1

        if malformed_rows > 0:
            _LOG.warning(
                "backgammon tool telemetry malformed_rows=%d path=%s",
                malformed_rows,
                session_db_path,
            )

        return tool_calls, test_invocations

    def _extract_agentic_cycles(self, user_events_path: Path) -> int | None:
        """Return number of context-submission cycles from user-events jsonl.

        One cycle equals one user context submission (initial prompt plus each
        feedback injection). When attempt fields exist, cycles are counted as
        distinct attempt values; if parsed user lines have no attempt fields,
        fallback is the number of parsed user lines.
        """
        malformed_lines = 0
        user_line_count = 0
        attempts: set[int] = set()
        saw_attempt_field = False

        try:
            with user_events_path.open("r", encoding="utf-8") as fh:
                for raw_line in fh:
                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        payload = json.loads(line)
                    except json.JSONDecodeError:
                        malformed_lines += 1
                        continue

                    if not isinstance(payload, dict):
                        malformed_lines += 1
                        continue
                    if payload.get("type") != "user":
                        continue

                    user_line_count += 1
                    if "attempt" not in payload:
                        continue

                    attempt = payload.get("attempt")
                    try:
                        attempts.add(int(attempt))
                        saw_attempt_field = True
                    except (TypeError, ValueError):
                        continue
        except OSError as exc:
            _LOG.warning(
                "backgammon user-event telemetry unavailable path=%s error_class=%s",
                user_events_path,
                exc.__class__.__name__,
            )
            return None

        if malformed_lines > 0:
            _LOG.warning(
                "backgammon user-event telemetry malformed_lines=%d path=%s",
                malformed_lines,
                user_events_path,
            )

        if saw_attempt_field:
            return len(attempts)
        return user_line_count
