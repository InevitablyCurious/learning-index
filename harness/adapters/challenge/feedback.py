"""Feedback-override and chunk-completion leaves for the challenge adapter.

Extracted verbatim from harness/adapters/challenge/__init__.py
(WO-LI15-I1B STAGE 1B) and re-exported there, so every name stays
resolvable as harness.adapters.challenge.<name>.

STAGE 2B (WO-LI15-I2B) adds FeedbackMixin: the feedback-voice method group
moved out of ChallengeRunner, which inherits the mixin, so every self./cls.
cross-call resolves through the MRO with zero call-site changes. This module
must not import from the package __init__ -- the package __init__ imports
this module. The gate/tester class attributes the classmethods read
(_CONF_KEY_RE, _GATE_TOKEN_KEY_RE, _TESTER_CONF_PREFIXES,
_TESTER_CONF_EXACT, _HARNESS_INFRA_CHECK_RE) stay on ChallengeRunner and
resolve via cls.

_build_pass_verdict became a @classmethod in the move (orchestrator decision,
WO-LI15-I2B): its two sibling calls were hardcoded to the ChallengeRunner
global, which does not exist in this module; cls. resolves them through the
MRO. No subclass of ChallengeRunner exists, so behavior is identical.

THE LATE-BOUND compute_grader_hash SEAM. tests/test_snapshot_capture.py
patches the PACKAGE attr (challenge_mod.compute_grader_hash), so
_load_cached_grade reads it once per call via a local binding instead of
importing it -- the same pattern as _HOLD_UI_PORT in hold_ui.py.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import datetime as _dt
import json
from pathlib import Path
import re
from typing import Any

from .constants import (
    _CHUNK_STUB_FILE,
    _CONSTRAINTS,
    _EXCUSE_ELIMINATOR,
    _FEEDBACK_HEADER_FIRST,
    _FEEDBACK_HEADER_REPEAT,
    _FIXED_OPENER_MANY,
    _FIXED_OPENER_ONE,
    _GRADER_DIR,
    _PACK,
    _SPEC,
    _PASS_VERDICT_MAX_LISTED,
    _REGRESSION_HEADER,
    _STUB_SENTINEL,
    _TEAM_EXCUSE_ELIMINATOR,
    _TEAM_HEADER,
    _TEAM_HEADER_ALONE,
    _TEAM_REGRESSION_HEADER,
)
from .exceptions import MissingFeedbackOverrideError


def load_feedback_overrides(path: Path) -> dict[str, dict[str, str]]:
    """Load `grader/feedback.json` — the human-written symptom line per gate.

    THE CONTRACT. Keys are a gate's bracket token (`"E08"`, `"F12"`), a
    conformance sub-check key (`"REQ-STATE/state.pip"`), or the exact raw check
    string. Values are ONE sentence per line, in one of two voices: a person
    playing the game describing WHAT THEY SAW (the tester), or a software team
    integrating against the app describing what their tooling and API reads
    could not find or got wrong (the team) — the SYMPTOM, never the cause and
    never the fix. A token key covers every test sharing that token, which is
    the normal case and is deliberately coarse: a coarser report reveals less.

    WHY A FILE AND NOT DERIVED TEXT. The derived string is the test title, and a
    test title states the RULE ("a checker on the bar counts a full 25 pips").
    Handing that to the model after a failure answers the question the gate
    exists to ask. A human writes these once; the grader never generates them.

    SINGLE-SYSTEM (WO-FEEDBACK-VOICE-3, 2026-08-30). This file is the ONLY source
    of what the model hears. There is NO title-derived fallback: a gate with no
    override RAISES `MissingFeedbackOverrideError` when humanised. Completeness
    is enforced before a run starts (bench preflight) and pinned by a test, so
    a missing key is a misconfiguration, not a graceful degradation.

    TWO LINES PER GATE (schema 2, 2026-09-02). Each value is an object with
    `first` (the player's first report) and `repeat` (the same fault seen again
    on a replay, after a failed fix). The returned mapping is
    ``{gate: {"first": ..., "repeat": ...}}``.

    WHY TWO. Byte-identical text across attempts returns zero new information —
    a failed fix reads exactly like a fix never attempted. WO-FEEDBACK-1 solved
    that by appending the grader's own assertion text on a repeat, which worked
    and LEAKED: an assertion states the rule, the one thing this file exists to
    withhold. A second human line carries the gradient without the leak.

    LOADER TOLERANCE. The loader itself still returns `{}` on a missing or
    unreadable file rather than raising, so a broken file surfaces as a
    completeness failure at the preflight/test boundary with a clear name —
    not as an opaque exception mid-load. The hard-fail lives at the humanise
    call, not in the loader. A gate whose entry is malformed or is missing
    either line is DROPPED rather than half-loaded, so it reports as missing at
    that same boundary instead of failing later with a partial record.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    gates = raw.get("gates") if isinstance(raw, dict) else None
    if not isinstance(gates, dict):
        return {}
    loaded: dict[str, dict[str, str]] = {}
    for key, value in gates.items():
        if not isinstance(value, dict):
            continue
        first = " ".join(str(value.get("first", "")).split())
        repeat = " ".join(str(value.get("repeat", "")).split())
        if not first or not repeat:
            continue
        loaded[str(key)] = {"first": first, "repeat": repeat}
    return loaded


def _key_from_base(base: str) -> str:
    """Reconstruct a gate KEY from a `failures/*.md` filename base.

    Inverse of the emit scheme that wrote `grader/feedback.json` out as one
    `.md` per line: `/` in a key became `-` in the filename, so `REQ-STATE/
    state.pip` emitted as `REQ-STATE-state.pip.md`. The `REQ-<PHASE>` prefix
    is the only place a real `-` precedes the key's own `/`, so the first
    `-` after it is the one to undo. `CONF` has no sub-check, and bracket
    tokens (`G-01` → `G01`) simply drop their separator.
    """
    m = re.match(r"^(REQ-[A-Z]+)-(.*)$", base)
    if m:
        return f"{m.group(1)}/{m.group(2)}"
    if base == "CONF":
        return "CONF"
    return base.replace("-", "", 1)


def load_feedback_overrides_from_failures(
    prompts_dir: Path,
) -> dict[str, dict[str, str]]:
    """Load the per-gate symptom lines from `<prompts_dir>/failures/*.md`.

    THE RUNTIME SOURCE (WO-LI-EXTRACT-FAILURE-PROMPTS). The text that used to
    live in `grader/feedback.json` now lives as one `.md` file per line —
    `<base>.md` is a gate's `first` line, `<base>-repeat.md` its `repeat` —
    with `<base>` mapped back to the gate key by `_key_from_base`. The JSON
    file remains on disk for the preflight/completeness tooling; this loader
    is what the repair loop hears.

    BYTE-IDENTICAL BY CONSTRUCTION. Only trailing newlines are stripped
    (`.rstrip("\\n")`, matching `PromptPack.text`); no whitespace
    normalization — the files hold the exact sentence the model reads.

    Same tolerance contract as `load_feedback_overrides`: a missing directory
    returns `{}`, and a gate missing either line is DROPPED rather than
    half-loaded, so it surfaces as a completeness failure at the
    preflight/test boundary instead of a partial record mid-run.
    """
    failures_dir = Path(prompts_dir) / "failures"
    if not failures_dir.is_dir():
        return {}
    loaded: dict[str, dict[str, str]] = {}
    for path in sorted(failures_dir.glob("*.md")):
        stem = path.stem
        is_repeat = stem.endswith("-repeat")
        base = stem[: -len("-repeat")] if is_repeat else stem
        key = _key_from_base(base)
        text = path.read_text(encoding="utf-8").rstrip("\n")
        loaded.setdefault(key, {})["repeat" if is_repeat else "first"] = text
    return {k: v for k, v in loaded.items() if v.get("first") and v.get("repeat")}


def gate_tokens_in_suite(gates_dir: Path) -> set[str]:
    """Every `[XXX]` gate token declared by a graded gate file.

    Scanned from the source files rather than from a roster so this needs no
    `npx` and cannot go stale against a roster captured for some other run.
    The graded surface is `backend/`, `frontend/` and `conformance/` — `meta/`
    grades the grader, not the candidate, and is deliberately excluded.
    """
    pattern = re.compile(r'["\'`]\s*\[([A-Z]+[0-9]*)\]')
    found: set[str] = set()
    for directory in _SPEC.grader_phases:
        root = gates_dir / directory
        if not root.is_dir():
            continue
        for path in root.rglob("*.ts"):
            found.update(pattern.findall(path.read_text(encoding="utf-8")))
    return found


def missing_feedback_overrides(gates_dir: Path) -> set[str]:
    """Gate tokens in the graded suite that have NO human-written symptom line.

    WO-FEEDBACK-VOICE-3: completeness is mandatory. Any token returned here is a
    gate that — absent an override — would have fallen back to its LEAKY
    title-derived text. The old fallback is deleted, so every returned token is
    a gate whose repair-loop message cannot be built: preflight refuses to start
    a run that returns non-empty, and the test suite refuses to go green.
    """
    tokens = gate_tokens_in_suite(gates_dir)
    overrides = load_feedback_overrides(gates_dir / "feedback.json")
    return {t for t in tokens if t not in overrides}


def count_stub_sentinels(path: Path) -> int | None:
    """Occurrences of the scaffold stub sentinel in ``path``; None if unreadable."""
    try:
        return path.read_text(encoding="utf-8").count(_STUB_SENTINEL)
    except OSError:
        return None


def build_chunk_completion(
    *,
    chunk_reports: Sequence[Mapping[str, Any]],
    expected: int,
    worktree: Path | None = None,
) -> list[dict[str, Any]]:
    """Fold ``chunk_reports`` into one operator-facing row per build chunk.

    THREE STATES, NOT TWO. `chunk_reports.append(report)` runs BEFORE the
    chunked driver's `exit_code != 0` early return, so a chunk that died still
    carries an entry while every chunk after it carries none:

      complete     entry, exit_code 0    - the drive ran to a clean idle
      died         entry, exit_code != 0 - it ran and the drive ended badly
      not_reached  no entry at all       - it never got a turn

    THE STATE IS THE TRANSPORT'S VERDICT, NOT THE MODEL'S (WO-MARKER-RIP,
    2026-09-09). `complete` used to mean "the model printed CHUNK FINISHED",
    which a model could print having written nothing and withhold having
    written everything. It now means the drive reached idle without a
    transport failure — an event the harness observes rather than a claim it
    is handed. `stubs_remaining` beside it is what says whether the work was
    actually done.

    Collapsing the last two into one "incomplete" list is what makes an
    operator read "4, 5, 6 are broken" when the truth is "4 broke, and 5 and 6
    never started because of it". Naming the culprit is the whole value.
    """
    by_index: dict[int, Mapping[str, Any]] = {}
    for report in chunk_reports or ():
        idx = report.get("chunk")
        if isinstance(idx, int):
            by_index[idx] = report

    rows: list[dict[str, Any]] = []
    for index in range(1, max(0, int(expected)) + 1):
        report = by_index.get(index)
        stub_file = _CHUNK_STUB_FILE.get(index)
        stubs = None
        if stub_file is not None and worktree is not None:
            stubs = count_stub_sentinels(worktree / stub_file)

        if report is None:
            rows.append(
                {
                    "chunk": index,
                    "state": "not_reached",
                    "nudges": 0,
                    "reason": None,
                    "stub_file": stub_file,
                    "stubs_remaining": stubs,
                }
            )
            continue

        clean = int(report.get("exit_code", 0) or 0) == 0
        rows.append(
            {
                "chunk": index,
                "state": "complete" if clean else "died",
                # Recovery pressure on this chunk: how many times the harness
                # re-drove it after an upstream proxy terminal. Zero on a chunk
                # that ran straight through.
                "nudges": int(report.get("recovery_nudges", 0) or 0),
                # Why the drive ended badly. `killed_reason` names the real
                # cause (run_timeout / turn_stalled); exit_code alone would say
                # only "not zero", which tells an operator nothing actionable.
                "reason": None
                if clean
                else (report.get("killed_reason") or _died_reason(report)),
                "stub_file": stub_file,
                "stubs_remaining": stubs,
            }
        )
    return rows


def _died_reason(report: Mapping[str, Any]) -> str:
    """Best available explanation for a chunk whose drive ended badly."""
    exit_code = report.get("exit_code")
    if isinstance(exit_code, int) and exit_code != 0:
        return f"exit_code={exit_code}"
    return "no_exit_signal"


def _default_progress(message: str) -> None:
    stamp = _dt.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    print(f"[bg] {stamp} {message}", flush=True)


# ── A SETUP THAT DID NOT TAKE ───────────────────────────────────────────────
#
# The grader marks a gate whose debug-endpoint setup was refused or dropped
# (grader/lib/harness.ts SETUP_REFUSED) before it judges any behaviour. The
# gate's own line would then be false — it describes a player experience that
# never happened ("I picked the hard computer, refreshed the page…", run
# 1790183923). What IS true is what an integrating team saw: they set a
# position through the app's debug endpoint and it did not read back. Said in
# the team's voice, naming the fields the grader found missing.
SETUP_REFUSED = "SETUP REFUSED"
_ASPECT_RE = re.compile(r"\[aspect: ([a-z]+)\]")
_SETUP_FIELDS_RE = re.compile(
    r"did not take (?P<missed>.+?)(?: \(sent (?P<sent>.+?)\))?(?: \[error: (?P<error>.*)\])?$"
)
_SETUP_HTTP_RE = re.compile(r"answered HTTP (?P<code>\d{3})")
# Names what they SENT, because the request is the finding: a whole position
# and a one-field update are different calls (run 1790191629 — told "a
# position", the model tested a full board, saw it work, and never tried the
# one-field update the gate had sent).
_SETUP_LINE_FIRST = (
    "They sent your app's debug endpoint {sent} to set up something they were checking, "
    "and it didn't take: {missed} didn't read back as what they sent."
)
_SETUP_LINE_REPEAT = (
    "They sent your debug endpoint {sent} again and it still didn't take: "
    "{missed} still didn't read back as what they sent."
)
# A body carrying the board is a whole position; anything less is an update of
# just those fields.
_POSITION_KEYS = {"points", "bar", "off"}


def _describe_sent(keys: list[str]) -> str:
    if _POSITION_KEYS <= set(keys):
        return "a whole game position"
    quoted = ", ".join(f'"{k}"' for k in keys)
    return f"an update with just {quoted}"


# ── THE APP ANSWERED AN API CALL WITH AN ERROR ─────────────────────────────
#
# When a check failed because the app answered one of its own API calls with an
# error status, that status and the app's own error text ARE the finding — what
# an integrating team pastes into a bug report. The gate's line described
# something downstream instead: run 1790183923 turned one "HTTP 500 from POST
# /api/new: EROFS …" into "their automation fell over while reading your page"
# and thirty tag complaints, and the model never learned the call was failing.
_HTTP_ERROR_RES = (
    re.compile(r"HTTP (?P<code>\d{3}) from (?P<method>GET|POST) (?P<path>/\S*?):?\s(?P<detail>.*)"),
    re.compile(r"(?P<method>GET|POST) (?P<path>/\S+) failed \((?P<code>\d{3})\)"),
)
_HTTP_LINE_FIRST = (
    'When they called {method} {path} on your app it answered HTTP {code} instead of the game state{detail}.'
)
_HTTP_LINE_REPEAT = 'They called {method} {path} again and it still answers HTTP {code}{detail}.'


def http_error_line(observed: str, *, pass_kind: str) -> str | None:
    """The true line for a failed API call, or None when none is recorded."""
    first = str(observed or "").strip().split("\n", 1)[0]
    for rx in _HTTP_ERROR_RES:
        if m := rx.search(first):
            if not m.group("code").startswith(("4", "5")):
                return None
            raw = (m.groupdict().get("detail") or "").strip()
            detail = f' — the response said: "{raw[:140]}"' if raw else ""
            template = _HTTP_LINE_REPEAT if pass_kind == "repeat" else _HTTP_LINE_FIRST
            return template.format(method=m.group("method"), path=m.group("path"), code=m.group("code"), detail=detail)
    return None


def setup_refusal_line(observed: str, *, pass_kind: str) -> str | None:
    """The true line for a refused setup, or None when the gate's setup took."""
    text = str(observed or "")
    if SETUP_REFUSED not in text:
        return None
    first = text[text.index(SETUP_REFUSED):].split("\n", 1)[0]
    if h := _SETUP_HTTP_RE.search(first):
        if pass_kind == "repeat":
            return f"They sent your debug endpoint the same setup again and it still answers HTTP {h.group('code')}."
        return (
            "They sent your app's debug endpoint a request to set up something they were checking, "
            f"and it answered HTTP {h.group('code')}."
        )
    m = _SETUP_FIELDS_RE.search(first)
    missed = ", ".join(f'"{k.strip()}"' for k in m.group("missed").split(",")) if m else "what they set"
    sent_keys = [k.strip() for k in m.group("sent").split(",")] if m and m.group("sent") else []
    sent = _describe_sent(sent_keys) if sent_keys else "a request"
    template = _SETUP_LINE_REPEAT if pass_kind == "repeat" else _SETUP_LINE_FIRST
    said = f' The response said: "{m.group("error").strip()[:140]}".' if m and m.group("error") else ""
    return template.format(sent=sent, missed=missed) + said


class FeedbackMixin:
    @classmethod
    def feedback_channel(cls, check: str) -> str:
        """`"tester"` or `"team"` for one check id. Single source of truth."""
        m = cls._CONF_KEY_RE.match(str(check or "").strip())
        if not m:
            token = cls._GATE_TOKEN_KEY_RE.match(str(check or "").strip())
            if token and token.group(1) in cls._TEAM_GATE_TOKENS:
                return "team"
            return "tester"
        key = m.group(1)
        if key.startswith(cls._TESTER_CONF_PREFIXES):
            return "tester"
        if any(key == exact or key.startswith(f"{exact} ") for exact in cls._TESTER_CONF_EXACT):
            return "tester"
        return "team"

    @classmethod
    def _feedback_overrides(cls) -> dict[str, dict[str, str]]:
        """Human-written symptom lines, keyed by gate token or exact check text.

        Cached on the class; read from the challenge's `prompts/failures/*.md`
        files — see `load_feedback_overrides_from_failures` for the contract.
        """
        cached = getattr(cls, "_FEEDBACK_OVERRIDES_CACHE", None)
        if cached is None:
            cached = load_feedback_overrides_from_failures(_PACK.dir)
            cls._FEEDBACK_OVERRIDES_CACHE = cached
        return cached

    @classmethod
    def _fill_seconds(cls, line: str, observed: str | None) -> str:
        """Substitute `{seconds}` in a symptom line from the grader's `observed`.

        ONE NUMBER, ONE PLACE — the same contract the nudge files use for
        `{write_limit}`. The sentence stays hand-written; only the duration is
        filled in, because only the grader knows how long it actually waited.

        A stall line without a real duration would be worse than one with no
        number at all: "it hung for 0 seconds" is a false report. So an
        unresolvable number degrades to the vaguer human phrasing rather than
        inventing a figure, and the tests pin that the stall path always
        supplies one.

        THE PLACEHOLDER CARRIES ITS UNIT. `{seconds}` renders as "63 seconds",
        not "63" — so the fallback can be a phrase ("a long while") and the
        sentence still reads as English either way. A bare number would leave
        the fallback as "a long while seconds".
        """
        if "{seconds}" not in line:
            return line
        m = re.search(r"(\d+)\s*s\b", str(observed or ""))
        filled = f"{m.group(1)} seconds" if m else "a long while"
        return line.replace("{seconds}", filled)

    @classmethod
    def _humanize_check(
        cls, check: str, *, pass_kind: str = "first", observed: str | None = None
    ) -> str:
        """Render a gate id as the phrase a person would actually say.

        `pass_kind` selects which of the gate's two lines to use: `"first"` the
        first time the model hears about this gate, `"repeat"` once it has
        already tried to fix it and failed. See `load_feedback_overrides` for
        why there are two.

        SINGLE-SYSTEM (WO-FEEDBACK-VOICE-3, 2026-08-30). The ONLY sentence a gate
        may carry is the human-written line in `grader/feedback.json`. Deriving
        the sentence from the TEST TITLE leaks the fix whenever the title states
        the rule rather than the symptom — measured on the deepseek-chat run
        1788099503: gate E08 failed on attempt 1, the model was told
        "full-turn sequences are distinct by RESULTING BOARD", and it passed on
        attempt 2. That sentence IS the requirement, so the gate stopped
        measuring whether the model could infer it. The title-derived fallback
        is therefore DELETED.

        `feedback.json` maps a gate to what a PERSON PLAYING THE GAME would
        report — the symptom, not the cause. A gate with NO override RAISES
        `MissingFeedbackOverrideError`: it is a misconfigured benchmark, and the
        completeness preflight + test are what guarantee it never happens at
        run time. The raw ids stay in `failed_gates`/`gate_results` untouched.

        `[G05] REQ-HIGHER-DIE — use higher die` becomes whatever `feedback.json`
        says for `G05` (here: the human symptom sentence), never the title.
        """
        raw = str(check or "").strip()
        overrides = cls._feedback_overrides()
        line = "repeat" if pass_kind == "repeat" else "first"

        # Lookup order: exact check text, then bracket token, then a specific
        # conformance sub-check key (a narrower message may override the broad
        # CONF line), then the broad CONF token for any conformance check.
        token_key = m.group(1) if (m := cls._GATE_TOKEN_KEY_RE.match(raw)) else None
        conf_key = m.group(1) if (m := cls._CONF_KEY_RE.match(raw)) else None
        # ONE TEST, SEVERAL SITUATIONS: a gate whose assertions carry an
        # `[aspect: X]` message names the one that failed, and its `<gate>.X`
        # line says just that. G01's single line listed "the pieces, the cube,
        # or whose turn" — the model re-checked the cube and turn six times and
        # never looked at the black layout, the only thing wrong (run
        # 1790196821). Absent the marker, the gate's own line.
        aspect = m.group(1) if (m := _ASPECT_RE.search(str(observed or ""))) else None
        aspect_key = f"{token_key or conf_key}.{aspect}" if (token_key or conf_key) and aspect else None
        for key in (aspect_key, raw, token_key, conf_key, "CONF"):
            if key and key in overrides:
                # "CONF" must only resolve conformance checks, never a stray use
                # of the literal token in a backend/frontend context.
                if key != "CONF" or conf_key is not None:
                    return cls._fill_seconds(overrides[key][line], observed)

        if cls._HARNESS_INFRA_CHECK_RE.match(raw):
            raise MissingFeedbackOverrideError(
                f"harness-infra check {raw!r} reached _humanize_check. These "
                "check names are born only when a gate RUNNER dies mid-run; "
                "they are not gates and must be filtered before feedback "
                "composition, never resolved to a symptom line. See "
                "_HARNESS_INFRA_CHECK_RE."
            )

        token = token_key or conf_key or "??"
        raise MissingFeedbackOverrideError(
            f"no feedback override for gate token {token!r} "
            f"(check: {raw!r}). The feedback voice is single-system: every gate "
            "must carry a human-written symptom line in grader/feedback.json. "
            "Run the bench preflight to list the missing gates."
        )

    @classmethod
    def _is_harness_infra_check(cls, check: str) -> bool:
        """True for runner-death check names that are NOT gates.

        See `_HARNESS_INFRA_CHECK_RE`. They stay in `failed_gates` /
        `problems` (the graded artifacts record the runner death exactly as
        published), but are excluded from feedback composition: the repair
        prompt is for gates the model can fix, and no symptom line can exist
        for a name the preflight has never seen.
        """
        return bool(cls._HARNESS_INFRA_CHECK_RE.match(str(check or "").strip()))

    @classmethod
    def _complaint_id(cls, record: dict[str, Any]) -> str:
        """Which complaint a problem is: its check, plus the aspect it names.

        One check can say different things ("the off tray isn't showing", "the
        off tray is drawn over some of the points"); only the SAME complaint made
        again is a repeat. Keyed on the check alone, run 1790345941 told "The off
        tray is still drawn over some of the points." the first time a player
        could have said it.
        """
        raw = str(record.get("check", "")).strip()
        aspect = m.group(1) if (m := _ASPECT_RE.search(str(record.get("observed", "") or ""))) else None
        return f"{raw} [aspect: {aspect}]" if aspect else raw

    @classmethod
    def _told_label(cls, record: dict[str, Any], *, pass_kind: str) -> tuple[str, str]:
        """The line the model is told for one problem, and whose voice says it.

        One place, so the complaint list and the "that fixed it" list can never
        disagree about what was said. A refused setup or a failed API call is
        the team's finding whatever the gate's channel; otherwise the gate's
        own line in its own channel.
        """
        raw_check = str(record.get("check", "")).strip()
        observed = str(record.get("observed", "") or "")
        setup_line = setup_refusal_line(observed, pass_kind=pass_kind) or http_error_line(
            observed, pass_kind=pass_kind
        )
        if setup_line:
            return setup_line, "team"
        label = cls._humanize_check(
            raw_check.split("\n", 1)[0],
            pass_kind=pass_kind,
            # A stall line names how long the tester waited; the duration
            # only exists on the grader's finding.
            observed=observed,
        )
        return label, cls.feedback_channel(raw_check)

    @classmethod
    def _build_pass_verdict(
        cls, *, newly_passing: list[str], told: dict[str, str]
    ) -> str:
        """What the player says about the complaints that are now gone.

        SAME VOICE, SAME SHAPE as the failure message: a short opener, then a
        numbered list of the things they are no longer running into. Each item
        is the line the model was FIRST told for that check (`told`, recorded
        by the runner) — the person is referring back to what they reported,
        so it must be what they actually said. It used to be the gate's own
        first line whatever had been said: run 1790194347 told the model a
        debug-endpoint finding for F19, then thanked it for fixing "I picked
        the hard computer, refreshed the page…" — a complaint it never got —
        and the model built difficulty persistence the next round.

        WHAT THIS REPLACED. The old form spliced the symptom into a clause it
        did not fit: "That fixed it — {symptom} works now", which rendered as
        "That fixed it — Sometimes the same die gets used twice in one turn
        works now." A symptom sentence describes the PROBLEM, so appending
        "works now" to one produces a sentence that says the opposite of what
        it means. It was broken before the two-pass rewrite too (it read "also
        the numbers … works now"); the rewrite only made it visible.
        """
        if not newly_passing:
            return ""

        deduped: list[str] = []
        seen: set[str] = set()
        for item in newly_passing:
            first_line = str(item).split("\n", 1)[0]
            if cls._is_harness_infra_check(first_line):
                continue
            # Only what was said can be reported fixed; never a line composed now.
            sanitized = told.get(str(item).strip())
            if not sanitized:
                continue
            # Same cap and reasoning as the failure list: a human symptom
            # sentence legitimately runs long, and a cut mid-clause is the tell
            # that no person wrote it.
            # 320, the failure list's cap: a told line quoted back must read
            # whole — at 200 it cut the setup line mid-quote ("The response
            # said:…", run 1790196821), the very tell this cap exists to avoid.
            if len(sanitized) > 320:
                sanitized = f"{sanitized[:320].rsplit(' ', 1)[0]}…"
            if not sanitized or sanitized in seen:
                continue
            seen.add(sanitized)
            deduped.append(sanitized)

        if not deduped:
            return ""

        opener = _FIXED_OPENER_ONE if len(deduped) == 1 else _FIXED_OPENER_MANY
        # Generous, but bounded: naming what got fixed is the signal that stops
        # the model undoing it, and a numbered list holds far more than the old
        # comma-spliced sentence could. The tail keeps a mass pass from turning
        # one message into a wall.
        shown = deduped[:_PASS_VERDICT_MAX_LISTED]
        lines = [opener, ""]
        for index, text in enumerate(shown, start=1):
            lines.append(f"{index}) {text}")
        remaining = len(deduped) - len(shown)
        if remaining:
            noun = "thing" if remaining == 1 else "things"
            lines.append("")
            lines.append(f"({remaining} other {noun} I mentioned look fine now too.)")
        return "\n".join(lines)

    @classmethod
    def _build_feedback_prompt(
        cls,
        *,
        problems: list[dict[str, Any]] | None = None,
        checks: list[str] | None = None,
        repeat_complaints: set[str] | None = None,
        withheld: list[str] | None = None,
        unevaluated: list[str] | None = None,
        regressions: set[str] | None = None,
    ) -> str:
        """Compose the message the model receives after a failed attempt.

        THE VOICE (2026-09-02). One person who played the finished game and is
        listing what they hit. Two openers, chosen by whether EVERY complaint on
        the list is one they reported before and have seen in every round since
        (``repeat_complaints``); a list with anything new on it opens as a
        report, and the repeated lines say "still" for themselves:

          first  "I've checked your work thoroughly, and I want to list the
                  issues that I've encountered while playing the game:"
          repeat "I've checked your resolution for the problems that were given
                  before, played the game in full again, and I'm still seeing
                  these problems:"

        Then a numbered list, one complaint per line. The old shape was a
        bulleted `- {label}: FAILING`, and every symptom in `feedback.json`
        began with the word "also" so the bullets would read as one continuous
        grumble. Under a real opener that "also" is a tic, and `FAILING` is
        grader vocabulary a player would never use — both are gone.

        THE GRADIENT, AND HOW IT STOPPED LEAKING. Before WO-FEEDBACK-1 this
        listed gate names and nothing else, so a gate failing in attempt 2 and
        again in attempt 3 produced BYTE-IDENTICAL text. A failed fix returned
        zero new information and the model could not tell "closer" from "no
        change" — across a 3-attempt ceiling the loop had no gradient at all.

        WO-FEEDBACK-1 fixed that by appending one sanitised line of the
        grader's own assertion on a repeat failure. It worked, and it leaked:
        an assertion states the RULE, which is precisely what `feedback.json`
        exists to withhold. A gate that answers itself measures attempt count,
        not capability — the same defect the title-derived fallback was deleted
        for.

        So the gradient now comes from a SECOND HUMAN LINE per gate rather than
        from the grader. A repeat failure sends the same person's second
        sighting of the same fault — what they did differently, what they
        watched for — which carries "your fix missed, and I looked again"
        without carrying where to look. `observed` is no longer read here at
        all; it stays in the graded artifacts, unchanged, for the operator.

        Repeats are keyed on the complaint — gate id plus the aspect it names
        (stable) — never the rendered sentence (lossy).

        THE EXCUSE ELIMINATOR (2026-09-04). Every failure verdict — first or
        repeat — OPENS with `_EXCUSE_ELIMINATOR`: the harness-side fact that
        grading runs in a clean browser (cache cleared, no saved session, a
        brand-new game). It pre-empts the stale-page / hard-refresh /
        saved-session excuse class measured on OFF-cell run 1788499216, where
        the model deflected to "the user needs to hard-refresh" over ten
        failures that had nothing to do with caching. It is constant across the
        gradient on purpose: it is a fact about how grading happens, not a
        sighting, so it carries no new information and only the opener and the
        per-gate lines carry the gradient.

        REGRESSIONS (2026-09-28). A check that PASSED the immediately-previous
        graded round and fails now is the model's own fix undoing code that
        worked — a different event from an ordinary complaint. ``regressions``
        carries those raw check strings (aspect-free, runner-side
        ``_regressed_checks``); each channel heads its regressed labels with
        its own opener (_REGRESSION_HEADER / _TEAM_REGRESSION_HEADER) BEFORE
        the ordinary complaint list, and the ordinary tester header reflects
        only the ordinary labels. With ``regressions`` empty the message is
        byte-identical to the shape without it.
        """
        # Accept either the rich problem records or a bare check list, so older
        # callers and tests keep working unchanged.
        records: list[dict[str, Any]]
        if problems is not None:
            records = [p for p in problems if isinstance(p, dict)]
        else:
            records = [{"check": c} for c in (checks or [])]

        repeats = repeat_complaints or set()
        regressions = regressions or set()

        # The excuse eliminator opens the message; then the opener; then the
        # numbered complaints. See the docstring for why it is first.
        # ── TWO PEOPLE, TWO LISTS, ONE MESSAGE ──────────────────────────────
        #
        # A player cannot observe a missing JSON field or an absent automation
        # attribute. There is no honest player sentence for either, and forcing
        # one is exactly how eleven conformance findings became "The game
        # doesn't seem to start up correctly at all" — a sentence contradicted
        # by the fifteen complaints under it and by the 36 gates that passed.
        #
        # The fix is not to abandon prose, it is to stop pretending the only
        # available human is a player. A team integrating against the app is an
        # ordinary person who reads API responses, and everything they report is
        # something they could genuinely have hit.
        #
        # Both lists are numbered from 1: they are two people's accounts, not
        # one list with a divider.
        by_channel: dict[str, list[str]] = {"tester": [], "team": []}
        # The REGRESSED labels per channel, in record order: checks told this
        # round that passed the immediately-previous graded round on changed
        # code, keyed on the raw check string (runner._regressed_checks).
        # by_channel still holds EVERY label — tester_speaks, the filler and
        # the team gate all read it — this dict only splits the emission.
        regressed: dict[str, list[str]] = {"tester": [], "team": []}
        # Pass-kinds of the NON-regressed tester labels only: a regression is
        # always a first sighting, and the ordinary header ("still seeing")
        # must describe only the ordinary list it heads.
        tester_ordinary_kinds: list[str] = []
        seen: set[str] = set()
        # A tester-channel check whose line went to the team (the app refused its
        # setup, or an API call failed) is a tester who could not say what they
        # saw. Set in the loop below; extended with withheld/unevaluated after.
        tester_fell_silent = False

        for record in records:
            raw_check = str(record.get("check", "")).strip()
            if not raw_check:
                continue
            # Harness-infra check names (`backend:runner <file>`,
            # `frontend:boot`, ...) are born when a gate RUNNER dies mid-run.
            # They are not gates: no feedback line can exist for them, the
            # model cannot repair the gate tooling from inside its cell, and
            # routing them into `_humanize_check` would raise and abort the
            # whole campaign after the graded attempt was already recorded
            # (measured: run 1788122095, attempt 3). Recorded in the scored
            # artifacts; excluded from the repair prompt.
            if cls._is_harness_infra_check(raw_check):
                continue
            # THE GRADIENT, chosen per complaint: a complaint the model has
            # already been told and failed to fix gets its second-sighting line.
            # Keyed on the gate id plus the aspect it names (_complaint_id),
            # never on the rendered sentence, which differs between passes.
            pass_kind = "repeat" if cls._complaint_id(record) in repeats else "first"
            label, channel = cls._told_label(record, pass_kind=pass_kind)
            if channel == "team" and cls.feedback_channel(raw_check) == "tester":
                tester_fell_silent = True
            # 320, not 200 (2026-09-05). The comment below has been right twice
            # over: at 200 it was ALREADY truncating two hand-written tester
            # lines (E04 at 267 characters, E02 at 244), and the software team's
            # lines are legitimately longer still because each one states what
            # the missing thing IS, not merely that it is missing.
            #
            # That length is not padding. The build prompt is not in the model's
            # context when it reads this — a normal run compacts between the six
            # build chunks, and a SEEDED run never ran the build at all — so
            # "there's no winType" is cryptic to a model that no longer knows,
            # or never knew, what winType was supposed to be. The definition has
            # to travel with the complaint.
            #
            # Truncating one mid-clause loses the symptom AND reads like a
            # machine wrote it — the exact tell this voice exists to avoid.
            if len(label) > 320:
                label = f"{label[:320].rsplit(' ', 1)[0]}…"
            if not label or label in seen:
                continue
            seen.add(label)
            by_channel[channel].append(label)
            is_regression = raw_check in regressions
            if is_regression:
                regressed[channel].append(label)
            if channel == "tester" and not is_regression:
                tester_ordinary_kinds.append(pass_kind)

        # "I'm still seeing these problems" only over problems they are still
        # seeing: a stage that just unlocked lists new ones, and heading them
        # "still" told the model it had heard them before (run 1790349319).
        header = (
            _FEEDBACK_HEADER_REPEAT
            if tester_ordinary_kinds
            and all(kind == "repeat" for kind in tester_ordinary_kinds)
            else _FEEDBACK_HEADER_FIRST
        )

        # A TESTER WHO COULD NOT SAY WHAT THEY SAW stays out of it. Run 1790597957
        # round 2 dropped every tag the team reads, every check of the board
        # stopped behind the team's finding, and the tester said "Nothing jumped
        # out at me" of a board of four coloured blocks. What a player sees there
        # is unknown, so the team speaks alone.
        #
        # The round's failing checks NOT told as a tester line: the later-stage
        # checks the runner withheld, the checks it never evaluated (never
        # reached, or stopped at a `[needs:]` the player did report), and a
        # visible tester-channel check whose line went to the team (flagged in
        # the loop above). Classified on the CHECK via feedback_channel, never
        # by _told_label's voice: a refused setup is still a tester-channel check.
        tester_fell_silent = tester_fell_silent or any(
            cls.feedback_channel(check) == "tester"
            for check in ((withheld or []) + (unevaluated or []))
        )
        tester_speaks = bool(by_channel["tester"]) or not by_channel["team"] or not tester_fell_silent

        lines: list[str] = [_EXCUSE_ELIMINATOR, ""]
        if tester_speaks:
            # A REGRESSION GETS ITS OWN OPENER, FIRST: a check that passed the
            # immediately-previous graded round and fails now is the model's own
            # fix undoing working code, and that news heads the tester's list
            # before the ordinary complaints. Numbered from 1 like every list:
            # two sightings by the same person, not one list with a divider.
            if regressed["tester"]:
                lines += [_REGRESSION_HEADER, ""]
                for n, label in enumerate(regressed["tester"], start=1):
                    lines.append(f"{n}) {label}")
            regressed_tester = set(regressed["tester"])
            ordinary_tester = [
                label for label in by_channel["tester"] if label not in regressed_tester
            ]
            # The ordinary header heads the ordinary list — and the filler line
            # below, which IS the tester's list when they have nothing to name.
            # With `regressions` empty this is byte-identical to the old shape.
            if ordinary_tester or not by_channel["tester"]:
                if regressed["tester"]:
                    lines.append("")
                lines += [header, ""]
                for n, label in enumerate(ordinary_tester, start=1):
                    lines.append(f"{n}) {label}")

            # The tester always speaks when they have anything to stand on, even
            # with nothing to report: the opener has already promised a list,
            # and an opener with no list under it reads as a truncated message
            # rather than a clean run.
            if not by_channel["tester"]:
                lines.append(
                    "1) Something is still broken but I couldn't pin down what it was."
                    if not by_channel["team"]
                    else "1) Nothing jumped out at me this time while I was playing."
                )

        # The team section appears ONLY when the team has something to say.
        # Announcing an integration attempt and then listing nothing would be a
        # sentence with no content, and it would still hand the model a party to
        # argue with.
        if by_channel["team"]:
            # The team's regressions head its section, under the team's own
            # regression opener. The leading blank separates from the tester
            # block; when the tester is silent the excuse-eliminator's trailing
            # "" is already exactly that blank — never double it.
            if regressed["team"]:
                if tester_speaks:
                    lines.append("")
                lines += [_TEAM_REGRESSION_HEADER, ""]
                for n, label in enumerate(regressed["team"], start=1):
                    lines.append(f"{n}) {label}")
            regressed_team = set(regressed["team"])
            ordinary_team = [
                label for label in by_channel["team"] if label not in regressed_team
            ]
            if ordinary_team:
                # _TEAM_HEADER_ALONE only when the ordinary list is the team's
                # FIRST sub-list AND the tester is silent; a regression list or
                # a tester list ahead of it makes the "Also," variant correct.
                team_alone = not tester_speaks and not regressed["team"]
                if not team_alone:
                    lines.append("")
                lines += [_TEAM_HEADER_ALONE if team_alone else _TEAM_HEADER, ""]
                for n, label in enumerate(ordinary_team, start=1):
                    lines.append(f"{n}) {label}")
            lines += ["", _TEAM_EXCUSE_ELIMINATOR]

        # The integration surface closes EVERY repair message, team or no
        # team: it names what the checking depends on, so the model stops
        # renaming or removing it while fixing the complaints above.
        lines += ["", _CONSTRAINTS]

        return "\n".join(lines)

    def _load_cached_grade(self, snapshot_dir: Path) -> dict[str, Any] | None:
        """Return the stored attempt-1 grade iff the grader is byte-identical.

        DEV-MODE GRADE CACHE, NOT CERTIFICATION. A seeded cell re-runs the
        gates over a tree copied from a prior cell; when the gate code has not
        changed since that cell graded, the outcome is already known — the
        snapshot carries the full attempt-1 grade beside its tree. Reuse it
        ONLY when the stored ``grader_hash`` equals the running gates dir's
        hash. Any miss — absent files, unparseable JSON, absent or mismatched
        hash, non-dict grade — returns ``None`` silently and the cell grades
        for real, exactly as before the cache existed. Never raises.
        """
        import harness.adapters.challenge as _pkg
        compute_grader_hash = _pkg.compute_grader_hash  # late-bound: tests patch the package attr; read once per call
        try:
            current = compute_grader_hash(_GRADER_DIR)
            stored = json.loads(
                (snapshot_dir / "snapshot.json").read_text(encoding="utf-8")
            ).get("grader_hash")
            grade = json.loads(
                (snapshot_dir / "grade-report.json").read_text(encoding="utf-8")
            )
            if stored is not None and stored == current and isinstance(grade, dict):
                live = getattr(self, "_live", None)
                if live is not None:
                    live.notice(
                        "harness",
                        "grade_cache_hit",
                        level="info",
                        cell_seq=getattr(self, "_cell_seq", None),
                        session_id=self._cell_session_id,
                        detail={
                            "snapshot_id": snapshot_dir.name,
                            "grader_hash_matched": True,
                        },
                    )
                return grade
            return None
        except Exception:
            # An unreadable cache is a miss, not an error: grade for real.
            return None
