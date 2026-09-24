"""Transport primitives and transcript classification for the serve client.

Split out of ``harness/serve_client.py`` (WO LI-13): the stdlib-urllib HTTP
primitives, the transient-read retry, the transcript-metrics extraction, and
the transport-anomaly classification live here. ``harness/serve_client.py``
keeps the ``ServeClient`` class and EXPLICITLY re-exports this module's public
surface, so every name still resolves from ``harness.serve_client`` — including
the ``harness.serve_client._http_json`` / ``._http_status`` bindings the unit
tests monkeypatch (the ``ServeClient`` method bodies resolve those names as
bare globals in serve_client's namespace).

HTTP IO uses ONLY the standard-library ``urllib`` package (consistent with the
rest of the harness -- no requests/httpx). The endpoint shapes this module's
primitives drive are documented in ``harness/serve_client.py``'s module
docstring (empirically validated against opencode 1.18.10).

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
- ``provider_truncations``: count of genuine provider truncations —
  ``step-finish`` parts whose ``reason`` is in {unknown, stream-incomplete},
  plus ``length`` finishes whose message output+reasoning is BELOW the output
  cap.
- ``cap_cutoffs``: count of ``length`` ``step-finish`` parts whose message
  output+reasoning is AT/ABOVE the output cap (opencode cut the turn at its
  built-in output cap).
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
semantics in ``harness/adapters/challenge.py``; the exact strings here
are the documented surface of :func:`classify_transport_anomaly`):

- any error text carries the loop-guard signature
                 -> (``"guard_abort"``, ``"loop_guard"``)   [most specific first]
- ... the relay finalize-watchdog signature
                 -> (``"transport_error"``, ``"stream_finalize_timeout"``)
- ... the relay stream-incomplete signature
                 -> (``"transport_error"``, ``"relay_stream_incomplete"``)
- ... a provider-unavailable signature
                 -> (``"transport_error"``, ``"provider_unavailable"``)
- provider_truncations > 0 or cap_cutoffs > 0
                 -> (``"truncated"``, ``"stream-incomplete"``)
- error_parts > 0 or info_errors > 0
                 -> (``"transport_error"``, ``"error_event"``)
- otherwise        -> (``None``, ``None``)
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

from harness.context_budget import OPENCODE_OUTPUT_TOKEN_CAP

# Truncation step-finish reasons (mirrors the challenge adapter
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
# NOTE: rebound by :func:`set_read_retry_observer` in THIS module's namespace,
# and read per-call by :func:`_retry_read` here — the observer unit
# (``_READ_RETRY_OBSERVER`` + ``set_read_retry_observer`` + ``_retry_read``)
# must never be split across modules or the rebinding stops reaching the reader.
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


def _message_info(message: Any) -> dict[str, Any]:
    if not isinstance(message, dict):
        return {}
    info = message.get("info")
    return info if isinstance(info, dict) else {}


def _message_tokens(message: Any) -> dict[str, Any]:
    tokens = _message_info(message).get("tokens")
    return tokens if isinstance(tokens, dict) else {}


def message_request_context_tokens(message: Any) -> int:
    """The request-side context one message occupied: input + cache read + cache
    write (excludes output/reasoning — this is the PROMPT side, per the Part D
    definition)."""
    tokens = _message_tokens(message)
    cache = tokens.get("cache") if isinstance(tokens.get("cache"), dict) else {}
    return (
        int(tokens.get("input", 0) or 0)
        + int(cache.get("read", 0) or 0)
        + int(cache.get("write", 0) or 0)
    )


def message_generation_tokens(message: Any) -> tuple[int, int]:
    """(output, reasoning) generated by one assistant message."""
    tokens = _message_tokens(message)
    return int(tokens.get("output", 0) or 0), int(tokens.get("reasoning", 0) or 0)


def message_has_tool_part(message: Any) -> bool:
    for part in _as_list(message.get("parts") if isinstance(message, dict) else None):
        if isinstance(part, dict) and part.get("type") == "tool":
            return True
    return False


def last_assistant_message(messages: list) -> dict | None:
    """The newest assistant message in the list, else None."""
    for msg in reversed(_as_list(messages)):
        if not isinstance(msg, dict):
            continue
        if _message_info(msg).get("role") == "assistant":
            return msg
    return None


def max_request_context_tokens(messages: list) -> int | None:
    """Largest request-side context (input + cache read + cache write) across
    assistant messages; None when there are none (absent, never 0)."""
    peak: int | None = None
    for msg in _as_list(messages):
        if not isinstance(msg, dict) or _message_info(msg).get("role") != "assistant":
            continue
        size = message_request_context_tokens(msg)
        if peak is None or size > peak:
            peak = size
    return peak


def extract_transcript_metrics(
    messages: list, output_cap: int = OPENCODE_OUTPUT_TOKEN_CAP
) -> dict:
    """Compute transcript metrics from a ``GET /session/{sid}/message`` payload.

    See the module docstring for exact field semantics. Defensive: malformed
    or empty payloads yield safe zeros/None.
    """
    assistant_msgs: list[dict] = []
    user_count = 0
    step_finish_reasons: list[str] = []
    provider_truncations = 0
    cap_cutoffs = 0
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
        # Per-message generation size, computed ONCE: a `length` step-finish is
        # a cap cut-off iff this message's output+reasoning reached the cap.
        msg_tokens = _message_tokens(msg)
        msg_output = int(msg_tokens.get("output", 0) or 0)
        msg_reasoning = int(msg_tokens.get("reasoning", 0) or 0)
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
                if reason == "length":
                    # AT/ABOVE the cap: opencode cut the turn at its output cap
                    # (a cap cut-off — nudgeable, not a provider fault). BELOW
                    # the cap: the provider itself stopped short (a genuine
                    # provider truncation).
                    if (msg_output + msg_reasoning) >= output_cap:
                        cap_cutoffs += 1
                    else:
                        provider_truncations += 1
                elif reason in {"unknown", "stream-incomplete"}:
                    provider_truncations += 1
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
        "provider_truncations": provider_truncations,
        "cap_cutoffs": cap_cutoffs,
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
    if metrics.get("provider_truncations", 0) > 0 or metrics.get("cap_cutoffs", 0) > 0:
        return TERMINAL_TRUNCATED, REASON_STREAM_INCOMPLETE
    if metrics.get("error_parts", 0) > 0 or metrics.get("info_errors", 0) > 0:
        return TERMINAL_TRANSPORT_ERROR, REASON_ERROR_EVENT
    return None, None


# ---- injectable HTTP primitives (swapped in unit tests, which monkeypatch
# the re-exported bindings on ``harness.serve_client`` — the ``ServeClient``
# method bodies resolve ``_http_json``/``_http_status`` as bare globals in
# serve_client's namespace, so the patch reaches the call sites) ----


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
