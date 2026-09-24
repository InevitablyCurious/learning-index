"""HTTP client for driving scoring cells through a running ``opencode serve``.

This module talks to an ``opencode serve`` instance via its HTTP API using ONLY
the standard-library ``urllib`` package (consistent with the rest of the
harness, which uses stdlib urllib exclusively -- no requests/httpx). It lets
the harness enqueue a prompt asynchronously, wait for the session to go idle,
and pull the resulting transcript metrics.

Empirically validated against opencode 1.18.10 (serve at host:port):

- ``POST {base}/session`` body ``{}`` -> 201 ``{"id": "ses_...", ...}``.
  (create_session parses ``id`` from the returned JSON.)
- ``POST {base}/session/{sid}/prompt_async`` body
  ``{"parts":[{"type":"text","text":"<prompt>"}]}`` -> 204. The prompt is
  enqueued and the call returns immediately.
- ``GET {base}/session/status`` -> ``{}`` when idle, or
  ``{"<sid>":{"type":"busy"}}`` while that session is generating. A session
  drops out of the map when it goes idle. This is the completion signal.
- ``GET {base}/session/{sid}/message`` -> a JSON list of message objects, each
  with ``info`` (role, tokens{input,output,reasoning,total,cache}, finish,
  cost, time{created,completed}) and ``parts`` (a list of parts, each with a
  ``type`` of "text" | "reasoning" | "step-start" | "step-finish" | "tool" |
  "error" | ...; a step-finish part carries ``reason`` e.g. "stop" plus
  ``tokens`` and ``cost``).
- ``GET {base}/session/{sid}`` -> the session object with tokens/cost/time.
- ``GET {base}/event`` -> server-sent events; ``message.part.delta``
  (``properties.sessionID``, ``partID``, ``field``, ``delta``) carries every
  streamed token, including thinking the stored transcript does not show until
  its block ends (observed on 1.18.10, 2026-09-24; :class:`DeltaCounter`).

WO LI-13 SPLIT: the transport/classification primitives (HTTP helpers, the
transient-read retry, transcript metrics, anomaly classification) live in
``harness/serve_transport.py``; the loop-kill marker contract lives in
``harness/loop_kill_marker.py``. Both are EXPLICITLY re-exported below, so
every public name still resolves from ``harness.serve_client``. The field
semantics for ``extract_transcript_metrics`` and the transport-anomaly
terminal mapping are documented in ``harness/serve_transport.py``'s module
docstring.
"""

from __future__ import annotations

import http.client
import json
import threading
import time
import urllib.parse

# The remaining code does not call urllib.request directly, but the unit tests
# reach ``sc.urllib.request`` to patch ``urlopen`` (the transport-error wrap
# seam), so the submodule is imported explicitly rather than left to ride in
# transitively on serve_transport's import.
import urllib.request
from typing import Any, Callable

# ── EXPLICIT RE-EXPORTS (never ``import *``) ────────────────────────────────
# Every externally-imported name is listed individually so nothing silently
# drops. THE MONKEYPATCH SEAM: ``tests/test_serve_http.py`` patches
# ``harness.serve_client._http_json`` / ``._http_status`` BY STRING, and the
# ``ServeClient`` method bodies below resolve those names as BARE GLOBALS in
# THIS module's namespace at call time — which is exactly why ``ServeClient``
# stays defined here and why these two bindings are imported here rather than
# referenced through ``serve_transport.`` at the call sites.
from harness.context_budget import CONTEXT_EXHAUSTED, context_exhausted

WORKER_DIED = "worker_died"
from harness.loop_kill_marker import (
    LOOP_KILL_WAIT_REASON,
    loop_kill_marker_name,
    read_loop_kill_marker,
)
from harness.serve_transport import (
    LOOP_GUARD_SIGNATURES,
    REASON_ERROR_EVENT,
    REASON_LOOP_GUARD,
    REASON_MODEL_SILENT,
    REASON_PROVIDER_UNAVAILABLE,
    REASON_RELAY_STREAM_INCOMPLETE,
    REASON_STREAM_FINALIZE_TIMEOUT,
    REASON_STREAM_INCOMPLETE,
    RECOVERABLE_STREAM_DEATH_REASONS,
    STREAM_DEATH_SIGNATURES,
    TERMINAL_GUARD_ABORT,
    TERMINAL_TRANSPORT_ERROR,
    TERMINAL_TRUNCATED,
    TRUNCATED_STEP_FINISH_REASONS,
    ServeClientError,
    _as_list,
    _http_json,
    _http_status,
    _retry_read,
    build_prompt_body,
    classify_step_finish_reason,
    classify_transport_anomaly,
    extract_transcript_metrics,
    parse_busy_status,
    set_read_retry_observer,
)


def progress_token_of(messages: list) -> tuple[int, int]:
    """``(messages, parts)`` for an already-read message list."""
    parts = 0
    for msg in messages:
        if isinstance(msg, dict):
            parts += len(_as_list(msg.get("parts")))
    return (len(messages), parts)


def tool_call_running(messages: list) -> bool:
    """Is a tool call in flight in the newest assistant message?

    A tool part's ``state.status`` is pending/running until it returns. This
    is what tells a wedged command (the stall bound's reason to exist) apart
    from a model server that sent nothing at all.
    """
    for msg in reversed(messages):
        if not isinstance(msg, dict) or (msg.get("info") or {}).get("role") != "assistant":
            continue
        return any(
            isinstance(part, dict)
            and part.get("type") == "tool"
            and ((part.get("state") or {}).get("status") in ("pending", "running"))
            for part in _as_list(msg.get("parts"))
        )
    return False


class DeltaCounter:
    """Counts ONE session's streamed deltas on the serve's ``GET /event`` stream.

    The stored transcript does not move while the model thinks: a reasoning
    part is created with empty text and its text lands only when the block
    completes. Measured 2026-09-24 (run 1790258326, ~225k context): the
    part read back with 0 chars for minutes of live streaming, so
    ``(messages, parts)`` sat still through 10 minutes of generation and the
    stall bound killed a thinking model mid-sentence. The serve publishes every
    streamed token as a ``message.part.delta`` event; counting this session's
    makes generation progress, while a wedged tool call or a silent model
    still counts nothing.

    The stream is opened in the constructor and fails loud (ServeClientError):
    without it every long thought would read as a stall again. After that a
    daemon thread reads it, reconnecting after a read timeout (a quiet stream,
    e.g. a long prefill) or a drop. ``close()`` only signals: the reader closes
    its own response at its next line or read timeout, because closing it from
    another thread races http.client's readline.
    """

    def __init__(self, url: str, session_id: str, *, read_timeout_s: float = 30.0) -> None:
        self._url = url
        self._session_id = session_id
        self._read_timeout_s = read_timeout_s
        self._count = 0
        self._stop = threading.Event()
        first = self._open()
        self._thread = threading.Thread(
            target=self._run, args=(first,), name="serve-delta-counter", daemon=True
        )
        self._thread.start()

    def count(self) -> int:
        return self._count

    def close(self) -> None:
        self._stop.set()

    def _open(self) -> Any:
        try:
            return urllib.request.urlopen(self._url, timeout=self._read_timeout_s)
        except (OSError, http.client.HTTPException) as exc:
            raise ServeClientError(f"GET {self._url}: {exc}") from exc

    def _run(self, first: Any) -> None:
        resp = first
        while not self._stop.is_set():
            try:
                if resp is None:
                    resp = self._open()
                with resp:
                    for raw in resp:
                        if self._stop.is_set():
                            return
                        self._take(raw)
            except (ServeClientError, OSError, http.client.HTTPException, ValueError):
                pass
            resp = None
            # Reconnect after a timeout or a drop; stop promptly when closed.
            if self._stop.wait(1.0):
                return

    def _take(self, raw: bytes) -> None:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            return
        try:
            event = json.loads(line[len("data:"):])
        except ValueError:
            return
        if (
            isinstance(event, dict)
            and event.get("type") == "message.part.delta"
            and (event.get("properties") or {}).get("sessionID") == self._session_id
        ):
            self._count += 1

class ServeClient:
    """Thin stdlib-urllib client for a running ``opencode serve``.

    Real IO only; no retries on transient errors (the harness decides).
    """

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 5.0,
        poll_interval: float = 2.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.poll_interval = poll_interval

    def _url(self, path: str) -> str:
        return self.base_url + path

    def create_session(self, title: str | None = None) -> str:
        """POST /session -> return the created session id.

        ``title`` (when given) seeds the opencode session DB ``session.title``
        so the prod dashboard can identify bench sessions; omitted, the body
        stays ``{}`` and opencode assigns its default title.
        """
        body: dict[str, Any] = {"title": title} if title is not None else {}
        payload = _http_json(
            "POST", self._url("/session"), body=body, timeout=self.timeout
        )
        if not isinstance(payload, dict) or not payload.get("id"):
            raise ServeClientError(f"create_session: no 'id' in response: {payload!r}")
        return payload["id"]

    def send_prompt(self, session_id: str, prompt: str) -> None:
        """POST prompt_async; raise :class:`ServeClientError` on non-204."""
        url = self._url(
            f"/session/{urllib.parse.quote(session_id, safe='')}/prompt_async"
        )
        status = _http_status(
            "POST", url, body=build_prompt_body(prompt), timeout=self.timeout
        )
        if status != 204:
            raise ServeClientError(f"send_prompt: expected 204, got {status}")

    def completed_compactions_since(self, session_id: str, watermark: int) -> int:
        """Count compactions at index >= ``watermark`` that ACTUALLY COMPLETED.

        THE RECEIPT, AND THE TRAP IT AVOIDS. `AssistantMessage` carries a boolean
        `summary` flag, and the obvious reading — "a message flagged summary is a
        summary" — is WRONG. Measured on run 1788415430 (2026-09-03): of 73
        compaction-agent messages, 68 were killed mid-stream by the relay's loop
        guard, and ALL 68 still carried `summary: true`. A check that trusted the
        flag reported 68 successful compactions where none had occurred.

        The flag says what the message WAS FOR, not what it achieved. So this
        counts a compaction only when the message is from the `compaction` agent
        AND carries no `info.error` — the same pair the session DB shows for the
        five that genuinely completed (`finish: stop`, real token counts).

        Read-only by design: this reports, and the caller records. Nothing acts
        on a zero — a cell that did not compact is a cell that did not compact.
        """
        found = 0
        for msg in self.get_messages(session_id)[watermark:]:
            if not isinstance(msg, dict):
                continue
            info = msg.get("info")
            if not isinstance(info, dict):
                continue
            if info.get("role") != "assistant":
                continue
            is_compaction = info.get("agent") == "compaction" or info.get("summary") is True
            if is_compaction and not info.get("error"):
                found += 1
        return found

    def guard_killed_compactions_since(self, session_id: str, watermark: int) -> int:
        """Count compactions at index >= ``watermark`` KILLED by the relay loop
        guard.

        The worker's own compaction (``agent=compaction``) is fired by the
        plugin, never the harness. When the relay's loop guard kills it,
        opencode AUTO-RETRIES it (``compaction_restores``) — a self-sustaining
        storm the harness must FAIL FAST on, not nudge around (the harness does
        not drive compaction, so a recovery nudge is meaningless there). This
        counts exactly those killed compactions and is DISJOINT from the
        build-turn guard-abort path: build turns carry ``agent=build``, never
        ``agent=compaction``, so a build kill is never counted here.
        """
        found = 0
        for msg in self.get_messages(session_id)[watermark:]:
            if not isinstance(msg, dict):
                continue
            info = msg.get("info")
            if not isinstance(info, dict):
                continue
            if info.get("role") != "assistant":
                continue
            is_compaction = info.get("agent") == "compaction" or info.get("summary") is True
            if not is_compaction:
                continue
            err = info.get("error")
            if not isinstance(err, dict):
                continue
            err_data = err.get("data") if isinstance(err.get("data"), dict) else {}
            err_text = str(err_data.get("message") or err.get("message") or "").lower()
            if any(sig in err_text for sig in LOOP_GUARD_SIGNATURES):
                found += 1
        return found

    def abort(self, session_id: str) -> None:
        """POST /session/{sid}/abort to stop serve-side generation.

        Returns None on any 2xx; raises :class:`ServeClientError` on a non-2xx
        status or on any HTTP/URLError/OSError (wrapped by :func:`_http_status`).
        """
        url = self._url(f"/session/{urllib.parse.quote(session_id, safe='')}/abort")
        status = _http_status("POST", url, body=None, timeout=self.timeout)
        if status < 200 or status >= 300:
            raise ServeClientError(f"abort: expected 2xx, got {status}")

    def session_busy(self, session_id: str) -> bool:
        """GET /session/status -> parse_busy_status for ``session_id``.

        Retried: this is the completion signal polled by :meth:`wait_idle` and
        :meth:`wait_busy`. A transient fault here must not read as "idle".
        """
        payload = _retry_read(
            lambda: _http_json(
                "GET", self._url("/session/status"), body=None, timeout=self.timeout
            ),
            what="session_busy",
        )
        if not isinstance(payload, dict):
            return False
        return parse_busy_status(payload, session_id)

    def get_messages(self, session_id: str) -> list:
        """GET /session/{sid}/message -> parsed JSON message list.

        Retries transient observation faults (:func:`_retry_read`): this is the
        endpoint D-SERVE-MESSAGE-500 intermittently 500s on, and it is also the
        harness's only window onto the session — a single unretried failure
        here previously voided a 32-minute cell.
        """
        url = self._url(f"/session/{urllib.parse.quote(session_id, safe='')}/message")
        payload = _retry_read(
            lambda: _http_json("GET", url, body=None, timeout=self.timeout),
            what=f"get_messages({session_id})",
        )
        return _as_list(payload)

    def session_progress_token(self, session_id: str) -> tuple[int, int]:
        """A cheap-to-compare marker of how far the STORED transcript has got.

        ``(messages, parts)``: new messages, steps and tool calls. It does NOT
        move while one block of thinking or text streams (the part's text is
        stored only when the block ends) — :meth:`wait_idle_detailed` adds the
        streamed-delta count from :meth:`open_delta_counter` for that.
        """
        return progress_token_of(_as_list(self.get_messages(session_id)))

    def open_delta_counter(self, session_id: str) -> DeltaCounter:
        """Start counting this session's streamed deltas (``GET /event``)."""
        return DeltaCounter(self._url("/event"), session_id)

    def session_tool_running(self, session_id: str) -> bool:
        """:func:`tool_call_running` over the session's stored messages."""
        return tool_call_running(_as_list(self.get_messages(session_id)))

    def wait_idle(self, session_id: str, *, timeout_s: float = 600.0, **kwargs) -> bool:
        """Poll :meth:`session_busy` until idle or timeout.

        Returns True if the session reached idle, False otherwise. See
        :meth:`wait_idle_detailed` when the caller needs to tell a stalled turn
        apart from an exhausted budget.
        """
        reached, _ = self.wait_idle_detailed(session_id, timeout_s=timeout_s, **kwargs)
        return reached

    def wait_idle_detailed(
        self,
        session_id: str,
        *,
        timeout_s: float = 600.0,
        stall_timeout_s: float | None = None,
        progress_interval_s: float = 30.0,
        loop_kill_marker_dir: str | None = None,
        turn_start_ts_ms: int | None = None,
        context_limit_tokens: int | None = None,
        worker_alive: Callable[[], bool] | None = None,
    ) -> tuple[bool, str]:
        """Poll until idle, the budget runs out, or the turn stops progressing.

        Returns ``(reached_idle, reason)`` where reason is one of ``idle``,
        ``timeout``, ``stalled`` (a tool call never returned), ``model_silent``
        (no tool call running and the model server sent nothing for the whole
        stall bound), ``loop_killed``, ``context_exhausted`` or ``worker_died``.

        CONTEXT EXHAUSTED (harness/context_budget.py). A turn is one agent loop
        and can run for many model calls, so the size check rides the same
        infrequent progress probe as the stall bound: when the newest assistant
        message reaches ``context_limit_tokens``, or a request overflowed, the
        wait ends with ``context_exhausted`` instead of letting the turn run on.

        WORKER DIED. A failed busy probe counts as busy (above) — right for a
        blip, wrong when the worker container itself has stopped: run 1789712833
        waited out the whole 90-minute budget on a container the model had
        killed. So on a failed probe ``worker_alive`` is asked, and a dead worker
        ends the wait at once with ``worker_died``.

        A probe that fails even after retries is treated as STILL BUSY, never
        as idle. Reading "idle" from a failed probe is the dangerous direction:
        it releases the harness to gate a worktree the worker is still writing
        (the 2026-08-09 turns=0/gates-race void). Waiting costs only time; a
        sustained outage still ends at ``timeout_s``.

        WHY A STALL BOUND EXISTS (2026-08-24). ``session_busy`` cannot tell
        "working hard" from "wedged": a hung tool call leaves the session BUSY
        forever. A live cell ran `timeout 3 npm start &` followed by
        `pkill -f "npm start"`, which killed npm but not the node server npm had
        spawned; the orphan held the tool call's stdout pipe open, the tool call
        never returned, and the session stayed busy. Because the caller passes
        the WHOLE-RUN budget as ``timeout_s``, one wedged command burned the
        entire cell. Progress is therefore sampled independently of busyness,
        and a turn that stops progressing is ended in ``stall_timeout_s``
        instead of ``timeout_s``.

        Sampling is deliberately infrequent (``progress_interval_s``): the probe
        reads the whole message list, which is far too heavy for the busy-poll
        cadence.

        LOOP-KILL MARKER (fast path). The guard signature is only observable in
        the transcript after the turn ends, so a loop-killed turn otherwise
        sits busy until the stall bound or the whole budget expires. When
        ``loop_kill_marker_dir`` is given, each poll also checks for THIS
        session's marker (``loop-kill-<session_id>.json``) at least as new as
        ``turn_start_ts_ms`` (epoch ms; None means any timestamp counts) and
        ends the wait immediately with ``loop_killed``. The marker is CONSUMED
        on the way out, so it can end this turn and no other. With the default
        ``loop_kill_marker_dir=None`` the check never runs and behaviour is
        unchanged.
        """
        deadline = time.monotonic() + timeout_s
        stall_deadline: float | None = None
        last_token: tuple[int, ...] | None = None
        next_progress_check = time.monotonic()
        # Streamed tokens are progress the stored transcript cannot show.
        deltas = self.open_delta_counter(session_id) if stall_timeout_s is not None else None
        try:
            while time.monotonic() < deadline:
                if loop_kill_marker_dir is not None and read_loop_kill_marker(
                    loop_kill_marker_dir,
                    turn_start_ts_ms,
                    session_id=session_id,
                    consume=True,
                ):
                    return False, LOOP_KILL_WAIT_REASON
                try:
                    busy = self.session_busy(session_id)
                except ServeClientError:
                    busy = True
                    if worker_alive is not None and not worker_alive():
                        return False, WORKER_DIED
                if not busy:
                    return True, "idle"

                now = time.monotonic()
                if (
                    stall_timeout_s is not None or context_limit_tokens is not None
                ) and now >= next_progress_check:
                    next_progress_check = now + progress_interval_s
                    if context_limit_tokens is not None:
                        try:
                            exhausted, _size = context_exhausted(
                                _as_list(self.get_messages(session_id)), context_limit_tokens
                            )
                        except ServeClientError:
                            exhausted = False  # a failed read is not evidence of anything
                        if exhausted:
                            return False, CONTEXT_EXHAUSTED
                    try:
                        token = self.session_progress_token(session_id)
                    except ServeClientError:
                        # A probe outage is not evidence of a stall. Leave the
                        # existing deadline alone rather than start counting down
                        # against a session we simply cannot see.
                        token = None
                    if token is not None and deltas is not None:
                        token = (*token, deltas.count())
                    if token is not None and stall_timeout_s is not None:
                        if token != last_token:
                            last_token = token
                            stall_deadline = now + stall_timeout_s
                        elif stall_deadline is None:
                            stall_deadline = now + stall_timeout_s
                        elif now >= stall_deadline:
                            # A command that never returned is the model's turn
                            # wedging; silence with no command running is the
                            # model server's. An unreadable session decides
                            # nothing — the next probe asks again.
                            try:
                                running = self.session_tool_running(session_id)
                            except ServeClientError:
                                running = None
                            if running is True:
                                return False, "stalled"
                            if running is False:
                                return False, REASON_MODEL_SILENT

                time.sleep(self.poll_interval)
            return False, "timeout"
        finally:
            if deltas is not None:
                deltas.close()

    def wait_busy(self, session_id: str, *, timeout_s: float = 60.0) -> bool:
        """Poll :meth:`session_busy` until busy or timeout.

        ``prompt_async`` is fire-and-forget: the serve marks the session busy
        only when it picks the prompt up. A bare ``wait_idle`` started in that
        window sees a false idle and returns instantly (the 2026-08-09
        turns=0/gates-race-the-worktree void). Always confirm busy first.
        Returns True if the session went busy, False on timeout.

        A failed probe is treated as NOT-yet-busy so the wait continues: the
        conservative direction here is to keep waiting for confirmation rather
        than declare a pickup that was never observed.
        """
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            try:
                if self.session_busy(session_id):
                    return True
            except ServeClientError:
                pass
            time.sleep(self.poll_interval)
        return False

    def metrics(self, session_id: str, *, since: int | None = None) -> dict:
        """Return :func:`extract_transcript_metrics` for the session messages.

        ``since`` windows the scan to messages at index >= ``since``. A killed
        turn's ``info.error`` persists in the transcript FOREVER, so a caller
        that classifies transport anomalies must scan only what the current
        drive produced — a cumulative read re-matches the same kill on every
        later phase (the 2026-08-10 chunk-2 defect: a drive that had already
        recovered was reclassified ``guard_abort`` on each later read until the
        recovery budget was exhausted and the cell voided).
        """
        messages = self.get_messages(session_id)
        if since is not None:
            messages = messages[since:]
        return extract_transcript_metrics(messages)


def founder_attach_command(host_port: int, session_id: str | None = None) -> str:
    """Return the one-line re-attach command for an ``opencode serve``.

    Carries ``--session`` whenever the cell session id is known: without it the
    TUI opens on the attach client's own default project view (a "new session"
    screen) instead of the live worker session (2026-08-09 founder trap).
    """
    cmd = f"opencode attach http://127.0.0.1:{host_port}"
    if session_id:
        cmd += f" --session {session_id}"
    return cmd


# Explicit public surface.
__all__ = [
    "STREAM_DEATH_SIGNATURES",
    "LOOP_GUARD_SIGNATURES",
    "LOOP_KILL_WAIT_REASON",
    "REASON_LOOP_GUARD",
    "REASON_STREAM_FINALIZE_TIMEOUT",
    "REASON_RELAY_STREAM_INCOMPLETE",
    "REASON_PROVIDER_UNAVAILABLE",
    "REASON_STREAM_INCOMPLETE",
    "RECOVERABLE_STREAM_DEATH_REASONS",
    "ServeClient",
    "ServeClientError",
    "TERMINAL_GUARD_ABORT",
    "TERMINAL_TRANSPORT_ERROR",
    "build_prompt_body",
    "classify_step_finish_reason",
    "classify_transport_anomaly",
    "extract_transcript_metrics",
    "founder_attach_command",
    "parse_busy_status",
    "loop_kill_marker_name",
    "read_loop_kill_marker",
    "set_read_retry_observer",
]
