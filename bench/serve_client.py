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

Field semantics for :func:`extract_transcript_metrics` (defensive -- missing
keys default safely):

- ``turns``: count of assistant messages that carry positive generation
  content (positive output/reasoning tokens, a non-empty text part, or a tool
  part); bare step-finish placeholder rows with no content are NOT counted.
  The served transcript does not reliably carry a ``step-finish`` part per
  assistant message (relay stream-finalize is best-effort), so counting
  step-finish parts undercounts real turns.
- ``input_tokens``: max ``info.tokens.input`` across assistant messages
  (default 0).
- ``output_tokens``: sum ``info.tokens.output`` across assistant messages.
- ``cache_read_tokens`` / ``cache_write_tokens``: sum ``info.tokens.cache.read``
  and ``.write`` across assistant messages. SUMMED, because each turn is billed
  for its own cache read. These are what make ``input_tokens`` legible: on a
  caching provider ``tokens.input`` carries only the uncached remainder.
- ``reasoning_tokens``: sum ``info.tokens.reasoning`` across assistant
  messages.
- ``cost_usd``: sum ``info.cost`` across assistant messages.
- ``truncations``: count of ``step-finish`` parts whose ``reason`` is in
  {length, unknown, stream-incomplete} (truncation signals).
- ``last_finish``: the ``reason`` of the LAST step-finish part seen, else
  ``None``.
- ``error_parts``: count of parts whose ``type`` is "error".
- ``info_errors``: count of assistant messages whose ``info.error`` is set.
  This is where a mid-stream provider/relay failure actually lands: on the
  pinned worker opencode (1.18.1; verified against source
  ``session/processor.ts`` halt path + ``session/message-v2.ts``
  ``fromError``, and against a live 1.18.15 session DB) a stream kill sets
  ``assistantMessage.error = {name, data:{message, ...}}`` and publishes
  ``Session.Event.Error`` — it does NOT write an "error" part. ``error_parts``
  stays for forward/backward shape tolerance; ``info_errors`` is the
  operative count on 1.18.x.
- ``error_texts``: bounded list of bounded error strings (at most
  ``_MAX_ERROR_TEXTS`` entries, each truncated to ``_MAX_ERROR_TEXT_CHARS``),
  collected from both "error" parts (``message``/``text``) and assistant
  ``info.error`` — for the latter the error's TYPE FIELDS (``name``,
  ``data.type``, ``data.code``) are prefixed onto ``data.message`` in one
  entry. This is the classification surface, and the type prefix is what lets
  it key on the relay's own typed codes (``relay_loop_detected``,
  ``relay_stream_finalize_timeout``, ``relay_stream_incomplete``) rather than
  on the prose of a message that can be reworded upstream at any time.
- ``assistant_messages``: count of messages with ``info.role == "assistant"``.
- ``user_messages``: count of messages with ``info.role == "user"``.

Transport-anomaly terminal mapping (mirrors the harness ``TURN_TERMINAL_*``
semantics in ``bench/adapters/backgammon.py``; the exact strings here
are the documented surface of :func:`classify_transport_anomaly`):

- any error text carries the loop-guard signature
                 -> (``"guard_abort"``, ``"loop_guard"``)   [most specific first]
- ... the relay finalize-watchdog signature
                 -> (``"transport_error"``, ``"stream_finalize_timeout"``)
- ... the relay stream-incomplete signature
                 -> (``"transport_error"``, ``"relay_stream_incomplete"``)
- ... a provider-unavailable signature
                 -> (``"transport_error"``, ``"provider_unavailable"``)
- truncations > 0  -> (``"truncated"``, ``"stream-incomplete"``)
- error_parts > 0 or info_errors > 0
                 -> (``"transport_error"``, ``"error_event"``)
- otherwise        -> (``None``, ``None``)
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Optional

# Truncation step-finish reasons (mirrors backgammon.py
# ``TRUNCATED_STEP_FINISH_REASONS = frozenset({"unknown", "stream-incomplete"})``,
# extended with "length").
TRUNCATED_STEP_FINISH_REASONS = frozenset({"unknown", "stream-incomplete", "length"})

# Anomaly terminals returned by :func:`classify_transport_anomaly`.
TERMINAL_TRUNCATED = "truncated"
TERMINAL_TRANSPORT_ERROR = "transport_error"
TERMINAL_GUARD_ABORT = "guard_abort"
REASON_STREAM_INCOMPLETE = "stream-incomplete"
REASON_ERROR_EVENT = "error_event"
REASON_PROVIDER_UNAVAILABLE = "provider_unavailable"
REASON_LOOP_GUARD = "loop_guard"
REASON_STREAM_FINALIZE_TIMEOUT = "stream_finalize_timeout"
REASON_RELAY_STREAM_INCOMPLETE = "relay_stream_incomplete"

# The relay's two stream-death reasons. ONE recovery class (the resume nudge),
# but the reason recorded on the anomaly stays the precise one that fired, so
# an artifact says WHICH terminal ended the turn. Callers deciding
# recoverability test membership here rather than equality against one of them.
RECOVERABLE_STREAM_DEATH_REASONS = frozenset(
    {REASON_STREAM_FINALIZE_TIMEOUT, REASON_RELAY_STREAM_INCOMPLETE}
)

# ── THE TWO UPSTREAM PROXY TERMINALS THE HARNESS RECOVERS FROM ─────────────
#
# The relay raises exactly two classes of terminal that mean "the turn died in
# transit, and nothing about the model caused it": a repetition LOOP kill, and
# a STREAM DEATH. Those two — and, separately, a provider outage the relay is
# merely relaying — are the ONLY things the nudging protocol may act on. It
# used to act on a model-emitted string as well; that machinery is gone.
#
# Each signature list carries the relay's own typed `type`/`code` FIRST and the
# prose of the message second. `extract_transcript_metrics` prefixes the type
# fields onto the message, so the typed code is the primary match and the prose
# is the fallback for an older proxy build that stamped only text.
#
# The relay is a safety instrument of the proxy. It is never reconfigured from
# here — the harness only reads what it says.
LOOP_GUARD_SIGNATURES = (
    "relay_loop_detected",  # typed: error.data.type / legacy message text
    "loop_detected",  # typed: error.data.code
    "generation loop detected",  # prose: relay: generation loop detected (<id>)
)

# STREAM DEATH — the relay's two "the stream did not survive" terminals,
# recovered identically (the resume nudge: the turn was cut off, not looping).
#   relay_stream_finalize_timeout — upstream completed but the stream never
#     closed within the 30s watchdog window.
#   relay_stream_incomplete — the stream ended mid-flight.
# One class, one recovery, one counter (``finalize_timeouts``): both mean the
# bytes stopped arriving, and the turn is resumed rather than scored.
_FINALIZE_TIMEOUT_SIGNATURES = (
    "relay_stream_finalize_timeout",  # typed: error.data.type
    "stream_finalize_timeout",  # typed: error.data.code
    "did not finalize",  # prose
)
_RELAY_STREAM_INCOMPLETE_SIGNATURES = (
    "relay_stream_incomplete",  # typed: error.data.type
    "stream_incomplete",  # typed: error.data.code
    "stream incomplete",  # prose
)
# The union — used for the turn-aligned ``finalize_timeouts`` count, which is
# per-CLASS (a stream death is excluded from scoring turns whichever of the two
# raised it). The classifier below keeps them apart so the RECORD is precise.
STREAM_DEATH_SIGNATURES = (
    _FINALIZE_TIMEOUT_SIGNATURES + _RELAY_STREAM_INCOMPLETE_SIGNATURES
)

# Wait reason returned by :meth:`ServeClient.wait_idle_detailed` when a FRESH
# loop-kill marker file is present in the caller-supplied marker directory.
# The guard signature above is only visible in the transcript AFTER the turn
# ends; a marker lets the waiter end a marker-backed stall in one poll instead
# of burning the full budget. Marker contract: a file named
# ``loop-kill-<session_id>.json`` containing JSON
# ``{"session_id": ..., "timestamp": <epoch_ms int>, "signature": ...}``.
# Correlation is BOTH identity (the file name and the recorded ``session_id``
# must match the waiting session) and freshness (epoch MILLISECONDS), and the
# marker is consumed when honoured — see :func:`read_loop_kill_marker`.
LOOP_KILL_WAIT_REASON = "loop_killed"

# PROVIDER OUTAGE, NOT MODEL BEHAVIOUR (2026-08-24). Observed live from
# orcarouter as an assistant-message error:
#   {"name":"UnknownError","data":{"message":"The upstream provider is
#    temporarily unavailable. Please try again later."}}
#
# Matched only against error_texts — text the TRANSCRIPT recorded as an error,
# never against model output — so a model that happens to write the words
# "temporarily unavailable" cannot trip this.
PROVIDER_UNAVAILABLE_SIGNATURES = (
    "temporarily unavailable",
    "upstream provider",
    "service unavailable",
    "overloaded",
    "502 bad gateway",
    "503 service",
)

# Bounds for the captured error text (enough to classify, never a transcript
# dump): at most this many entries, each truncated to this many chars.
_MAX_ERROR_TEXTS = 8
_MAX_ERROR_TEXT_CHARS = 240

# Transient-read retry (D-SERVE-MESSAGE-500, 2026-08-11). Observation reads are
# idempotent GETs, so a 5xx/429/socket fault is retried rather than allowed to
# kill a cell that is still alive. 4 attempts with linear backoff (0.5/1.0/1.5s)
# spans ~3s — long enough to ride out the observed intermittent Drizzle query
# failure, short enough that a genuinely dead serve still fails fast.
_READ_RETRY_ATTEMPTS = 4
_READ_RETRY_BACKOFF_S = 0.5

# Set by the harness to surface each retry on the progress stream. A retry that
# nobody can see is indistinguishable from a serve that never faulted, and a
# rising retry rate is the leading indicator of the underlying defect.
_READ_RETRY_OBSERVER: Callable[[str, int, Exception], None] = (
    lambda what, attempt, exc: None
)


def set_read_retry_observer(observer: Callable[[str, int, Exception], None]) -> None:
    """Install the callback invoked before each transient-read retry."""
    global _READ_RETRY_OBSERVER
    _READ_RETRY_OBSERVER = observer


class ServeClientError(Exception):
    """Raised for any HTTP/transport failure from :class:`ServeClient`.

    The underlying message is preserved as ``__cause__``-style context via the
    ``reason`` attribute.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def build_prompt_body(prompt: str) -> dict:
    """Return the JSON body for ``POST /session/{sid}/prompt_async``."""
    return {"parts": [{"type": "text", "text": prompt}]}


def parse_busy_status(payload: dict, session_id: str) -> bool:
    """Return True iff ``payload`` (parsed ``GET /session/status``) marks the
    session busy.

    ``payload`` maps session_id -> {"type":"busy"} while generating; the
    session is absent or the map empty once idle.
    """
    entry = payload.get(session_id)
    return bool(entry) and entry.get("type") == "busy"


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


def classify_step_finish_reason(reason: Optional[str]) -> str:
    """Return a normalized terminal reason string for a step-finish reason.

    Maps: "stop"->"stop", "length"->"length", "tool-calls"/"tool_calls" ->
    "tool-calls" (a normal tool-call turn close, NOT a truncation); values in
    {"unknown", "stream-incomplete"} are returned unchanged (truncation
    signals); anything else (including None) -> "unknown".
    """
    if reason == "stop":
        return "stop"
    if reason == "length":
        return "length"
    if reason in {"tool-calls", "tool_calls"}:
        return "tool-calls"
    if reason in {"unknown", "stream-incomplete"}:
        return reason
    return "unknown"


def _as_list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _is_real_assistant_turn(msg: dict) -> bool:
    """Return True iff an assistant message carries positive generation content.

    Defensive: missing/None keys are treated as 0/absent. An assistant message
    counts as a real turn when it has positive output tokens, positive
    reasoning tokens, at least one non-empty ``text`` part, or at least one
    ``tool`` part. A bare ``step-finish`` placeholder row with no such content
    is NOT a real turn.
    """
    info = msg.get("info") if isinstance(msg.get("info"), dict) else {}
    tokens = info.get("tokens") if isinstance(info.get("tokens"), dict) else {}
    if int(tokens.get("output", 0) or 0) > 0:
        return True
    if int(tokens.get("reasoning", 0) or 0) > 0:
        return True
    has_text = False
    has_tool = False
    for part in _as_list(msg.get("parts")):
        if not isinstance(part, dict):
            continue
        ptype = part.get("type")
        if ptype == "text" and str(part.get("text") or "").strip():
            has_text = True
        elif ptype == "tool":
            has_tool = True
    return has_text or has_tool


def extract_transcript_metrics(messages: list) -> dict:
    """Compute transcript metrics from a ``GET /session/{sid}/message`` payload.

    See the module docstring for exact field semantics. Defensive: malformed
    or empty payloads yield safe zeros/None.
    """
    assistant_msgs: list[dict] = []
    user_count = 0
    step_finish_reasons: list[str] = []
    truncations = 0
    error_parts = 0
    info_errors = 0
    guard_aborted_turns = 0
    finalize_timeouts = 0
    error_texts: list[str] = []

    def _capture_error_text(raw: Any) -> None:
        text = str(raw or "").strip()
        if not text or len(error_texts) >= _MAX_ERROR_TEXTS:
            return
        error_texts.append(text[:_MAX_ERROR_TEXT_CHARS])

    for msg in _as_list(messages):
        if not isinstance(msg, dict):
            continue
        info = msg.get("info")
        role = info.get("role") if isinstance(info, dict) else None
        if role == "assistant":
            assistant_msgs.append(msg)
            # A mid-stream provider/relay failure persists HERE on opencode
            # 1.18.x (processor halt -> assistantMessage.error), not as a part.
            err = info.get("error") if isinstance(info, dict) else None
            if isinstance(err, dict):
                info_errors += 1
                err_data = err.get("data") if isinstance(err.get("data"), dict) else {}
                # TYPE FIRST, THEN PROSE. The relay stamps a machine-readable
                # `type`/`code` on every terminal it raises; the message is
                # human text that can be reworded upstream without notice.
                # Both ride in ONE entry so the capture cap still counts
                # errors, not fields.
                err_kind = " ".join(
                    str(v)
                    for v in (
                        err.get("name"),
                        err_data.get("type"),
                        err_data.get("code"),
                    )
                    if v
                )
                err_text = str(err_data.get("message") or err.get("message") or "")
                _capture_error_text(f"{err_kind} {err_text}".strip())
                # Turn-aligned signature counts (WO-TURNACCT-1): only a killed
                # message that ALSO counts as a real turn may be subtracted from
                # the scoring turn count downstream. Exact counts — independent
                # of the error_texts capture cap.
                if _is_real_assistant_turn(msg):
                    haystack = f"{err_kind} {err_text}".lower()
                    if any(sig in haystack for sig in LOOP_GUARD_SIGNATURES):
                        guard_aborted_turns += 1
                    elif any(sig in haystack for sig in STREAM_DEATH_SIGNATURES):
                        finalize_timeouts += 1
        elif role == "user":
            user_count += 1

        for part in _as_list(msg.get("parts")):
            if not isinstance(part, dict):
                continue
            ptype = part.get("type")
            if ptype == "step-finish":
                reason = classify_step_finish_reason(part.get("reason"))
                step_finish_reasons.append(reason)
                if reason in TRUNCATED_STEP_FINISH_REASONS:
                    truncations += 1
            elif ptype == "error":
                error_parts += 1
                _capture_error_text(part.get("message") or part.get("text"))

    input_tokens = 0
    output_tokens = 0
    reasoning_tokens = 0
    cache_read_tokens = 0
    cache_write_tokens = 0
    cost_usd = 0.0
    for msg in assistant_msgs:
        info = msg.get("info") if isinstance(msg, dict) else {}
        tokens = info.get("tokens") if isinstance(info, dict) else {}
        if not isinstance(tokens, dict):
            tokens = {}
        input_tokens = max(input_tokens, tokens.get("input", 0) or 0)
        output_tokens += tokens.get("output", 0) or 0
        reasoning_tokens += tokens.get("reasoning", 0) or 0
        # CACHE IS SUMMED, NOT MAXED. Every turn is billed for the cache read it
        # performed, so the cumulative bill is the sum across turns -- unlike
        # `input_tokens` above, which is a max and therefore a context-size
        # high-water mark rather than a spend.
        #
        # WITHOUT THESE TWO FIELDS `input_tokens` CANNOT BE INTERPRETED AT ALL.
        # On a provider with no prompt caching, per-message `tokens.input` is
        # the WHOLE prompt, so max() approximates the final context size. On a
        # caching provider it is only the UNCACHED remainder -- on a live
        # deepseek-v4-flash cell that was 165, 285, 172 ... a max of 5,914 for a
        # cell that put 57M tokens through the provider. Same field, two
        # meanings, and nothing on the record said which one applied.
        cache = tokens.get("cache")
        if not isinstance(cache, dict):
            cache = {}
        cache_read_tokens += cache.get("read", 0) or 0
        cache_write_tokens += cache.get("write", 0) or 0
        cost_usd += info.get("cost", 0.0) or 0.0

    return {
        "turns": sum(_is_real_assistant_turn(msg) for msg in assistant_msgs),
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "reasoning_tokens": reasoning_tokens,
        "cache_read_tokens": cache_read_tokens,
        "cache_write_tokens": cache_write_tokens,
        "cost_usd": cost_usd,
        "truncations": truncations,
        "last_finish": step_finish_reasons[-1] if step_finish_reasons else None,
        "error_parts": error_parts,
        "info_errors": info_errors,
        "guard_aborted_turns": guard_aborted_turns,
        "finalize_timeouts": finalize_timeouts,
        "error_texts": error_texts,
        "assistant_messages": len(assistant_msgs),
        "user_messages": user_count,
    }


def classify_transport_anomaly(metrics: dict) -> tuple:
    """Detect a transport truncation from ``metrics`` (see module docstring).

    Returns ``(terminal, reason)``; both ``None`` when no anomaly. The
    loop-guard signature is checked FIRST: it is the most specific terminal
    (a guard kill can coincide with a truncation part, and the guard kill —
    not the truncation — is what ended the turn).
    """
    for text in metrics.get("error_texts") or []:
        haystack = str(text).lower()
        if any(sig in haystack for sig in LOOP_GUARD_SIGNATURES):
            return TERMINAL_GUARD_ABORT, REASON_LOOP_GUARD
        if any(sig in haystack for sig in _FINALIZE_TIMEOUT_SIGNATURES):
            # Second-specific check, same precedence logic as the guard: the
            # named relay terminal (the 30s finalize watchdog) is what ended
            # the turn — it beats the derived truncation reading.
            return TERMINAL_TRANSPORT_ERROR, REASON_STREAM_FINALIZE_TIMEOUT
        if any(sig in haystack for sig in _RELAY_STREAM_INCOMPLETE_SIGNATURES):
            # The relay's OTHER stream death: the stream ended mid-flight.
            # Same recovery as the watchdog, distinct reason on the record —
            # and it must beat the derived truncation reading below, which
            # would report the symptom (bytes stopped) instead of the named
            # terminal that caused it.
            return TERMINAL_TRANSPORT_ERROR, REASON_RELAY_STREAM_INCOMPLETE
        if any(sig in haystack for sig in PROVIDER_UNAVAILABLE_SIGNATURES):
            # The provider went away. This says nothing about the model and
            # must never be read as one: it is the most specific explanation
            # available for the turn ending, so it beats the derived
            # truncation reading below (an outage usually ALSO leaves a
            # truncation part behind, and "the stream stopped" would hide why).
            return TERMINAL_TRANSPORT_ERROR, REASON_PROVIDER_UNAVAILABLE
    if metrics.get("truncations", 0) > 0:
        return TERMINAL_TRUNCATED, REASON_STREAM_INCOMPLETE
    if metrics.get("error_parts", 0) > 0 or metrics.get("info_errors", 0) > 0:
        return TERMINAL_TRANSPORT_ERROR, REASON_ERROR_EVENT
    return None, None


# ---- injectable HTTP primitives (swapped in unit tests) ----


def _read_json_response(resp) -> Any:
    """Read and parse a JSON response body, tolerating an empty body."""
    raw = resp.read()
    if not raw:
        return None
    return json.loads(raw.decode("utf-8"))


def _http_json(method: str, url: str, body=None, timeout: float = 5.0) -> Any:
    """Perform an HTTP request expecting a JSON (or empty) response body.

    ``body`` is a dict or None; ``None`` is sent as an empty JSON object.
    Raises :class:`ServeClientError` on HTTP error or network failure.
    """
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return _read_json_response(resp)
    except (urllib.error.HTTPError, urllib.error.URLError, OSError) as exc:
        raise ServeClientError(f"{method} {url} failed: {exc}") from exc


def _is_transient(exc: BaseException) -> bool:
    """True when ``exc`` is a retryable observation fault, not a real answer.

    A 5xx, a 429, or any socket-level failure is the serve failing to ANSWER —
    the session behind it is untouched. A 4xx other than 429 is a real answer
    (bad request, unknown session) and must never be retried into a false read.
    """
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code >= 500 or exc.code == 429
    # URLError/OSError/socket.timeout: the request never landed.
    return isinstance(exc, (urllib.error.URLError, OSError))


def _retry_read(
    call,
    *,
    what: str,
    attempts: int = _READ_RETRY_ATTEMPTS,
    backoff_s: float = _READ_RETRY_BACKOFF_S,
    sleep=None,
):
    """Run an IDEMPOTENT read ``call``, retrying transient observation faults.

    D-SERVE-MESSAGE-500 (2026-08-11): a single ``GET /session/{id}/message``
    returning HTTP 500 from an opencode-internal Drizzle query killed a cell
    32 minutes in. The session was alive and generating; only the harness's
    ability to OBSERVE it failed. Recovery could not fire, because the drive
    loop decides whether to nudge by reading this very endpoint — a blind
    sensor reports no anomaly to recover from.

    Retrying here is safe ONLY because every caller is a read (GET). Writes
    (prompt_async, abort) are NEVER routed through this: replaying
    a prompt would duplicate a turn and corrupt the measurement.

    Raises the LAST :class:`ServeClientError` when every attempt fails, so a
    genuinely dead serve still surfaces loudly rather than hanging.
    """
    last = None
    # Resolved per call, never bound at def time, so a monkeypatched
    # ``time.sleep`` (tests) is honoured.
    nap = sleep if sleep is not None else time.sleep
    for attempt in range(1, attempts + 1):
        try:
            return call()
        except ServeClientError as exc:
            cause = exc.__cause__ or exc
            if not _is_transient(cause):
                raise
            last = exc
            if attempt < attempts:
                _READ_RETRY_OBSERVER(what, attempt, exc)
                nap(backoff_s * attempt)
    raise ServeClientError(
        f"{what}: {attempts} consecutive transient failures; last: {last}"
    ) from last


def _http_status(method: str, url: str, body=None, timeout: float = 5.0) -> int:
    """Perform an HTTP request and return the response status code."""
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status
    except (urllib.error.HTTPError, urllib.error.URLError, OSError) as exc:
        raise ServeClientError(f"{method} {url} failed: {exc}") from exc


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
        """A cheap-to-compare marker of how far the transcript has got.

        ``(messages, parts)``. Parts grow while a turn STREAMS, so a long
        generation keeps advancing this token and is never mistaken for a
        stall; a turn wedged inside a tool call advances neither.
        """
        messages = _as_list(self.get_messages(session_id))
        parts = 0
        for msg in messages:
            if isinstance(msg, dict):
                parts += len(_as_list(msg.get("parts")))
        return (len(messages), parts)

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
    ) -> tuple[bool, str]:
        """Poll until idle, the budget runs out, or the turn stops progressing.

        Returns ``(reached_idle, reason)`` where reason is one of ``idle``,
        ``timeout``, ``stalled`` or ``loop_killed``.

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
        last_token: tuple[int, int] | None = None
        next_progress_check = time.monotonic()

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
            if not busy:
                return True, "idle"

            now = time.monotonic()
            if stall_timeout_s is not None and now >= next_progress_check:
                next_progress_check = now + progress_interval_s
                try:
                    token = self.session_progress_token(session_id)
                except ServeClientError:
                    # A probe outage is not evidence of a stall. Leave the
                    # existing deadline alone rather than start counting down
                    # against a session we simply cannot see.
                    token = None
                if token is not None:
                    if token != last_token:
                        last_token = token
                        stall_deadline = now + stall_timeout_s
                    elif stall_deadline is None:
                        stall_deadline = now + stall_timeout_s
                    elif now >= stall_deadline:
                        return False, "stalled"

            time.sleep(self.poll_interval)
        return False, "timeout"

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
    "RECOVERABLE_STREAM_DEATH_REASONS",
    "ServeClient",
    "ServeClientError",
    "TERMINAL_GUARD_ABORT",
    "build_prompt_body",
    "classify_step_finish_reason",
    "classify_transport_anomaly",
    "extract_transcript_metrics",
    "founder_attach_command",
    "parse_busy_status",
    "loop_kill_marker_name",
    "read_loop_kill_marker",
]
