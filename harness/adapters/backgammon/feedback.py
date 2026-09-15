"""Feedback-override and chunk-completion leaves for the backgammon adapter.

Extracted verbatim from harness/adapters/backgammon/__init__.py
(WO-LI15-I1B STAGE 1B) and re-exported there, so every name stays
resolvable as harness.adapters.backgammon.<name>.

STAGE 2B (WO-LI15-I2B) adds FeedbackMixin: the feedback-voice method group
moved out of BackgammonRunner, which inherits the mixin, so every self./cls.
cross-call resolves through the MRO with zero call-site changes. This module
must not import from the package __init__ -- the package __init__ imports
this module. The gate/tester class attributes the classmethods read
(_CONF_KEY_RE, _GATE_TOKEN_KEY_RE, _TESTER_CONF_PREFIXES,
_TESTER_CONF_EXACT, _HARNESS_INFRA_CHECK_RE) stay on BackgammonRunner and
resolve via cls.

_build_pass_verdict became a @classmethod in the move (orchestrator decision,
WO-LI15-I2B): its two sibling calls were hardcoded to the BackgammonRunner
global, which does not exist in this module; cls. resolves them through the
MRO. No subclass of BackgammonRunner exists, so behavior is identical.

THE LATE-BOUND compute_grader_hash SEAM. tests/test_snapshot_capture.py
patches the PACKAGE attr (backgammon_mod.compute_grader_hash), so
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
    _EXCUSE_ELIMINATOR,
    _GRADER_DIR,
    _PASS_VERDICT_MAX_LISTED,
    _REPAIR_CAPTURE_REMINDER_MD,
    _SESSION_EXTRACTION_MD,
    _STUB_SENTINEL,
    _TEAM_EXCUSE_ELIMINATOR,
    _TEAM_HEADER,
)
from .exceptions import MissingFeedbackOverrideError


def load_feedback_overrides(path: Path) -> dict[str, dict[str, str]]:
    """Load `grader/feedback.json` — the human-written symptom line per gate.

    THE CONTRACT. Keys are a gate's bracket token (`"E08"`, `"F12"`), a
    conformance sub-check key (`"REQ-STATE/state.pip"`), or the exact raw check
    string. Values are ONE sentence in the voice of a person playing the game
    who has noticed something wrong — the SYMPTOM, never the cause and never
    the fix. A token key covers every test sharing that token, which is the
    normal case and is deliberately coarse: a coarser report reveals less.

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


def gate_tokens_in_suite(gates_dir: Path) -> set[str]:
    """Every `[XXX]` gate token declared by a graded gate file.

    Scanned from the source files rather than from a roster so this needs no
    `npx` and cannot go stale against a roster captured for some other run.
    The graded surface is `backend/`, `frontend/` and `conformance/` — `meta/`
    grades the grader, not the candidate, and is deliberately excluded.
    """
    pattern = re.compile(r'["\'`]\s*\[([A-Z]+[0-9]*)\]')
    found: set[str] = set()
    for directory in ("backend", "conformance", "frontend"):
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


def _recorded_claim_count(state_dir: Path | None, session_id: str) -> int | None:
    """Claims the memory layer has persisted for this session, or None.

    Reads the plugin's own artifact rather than asking the model whether it
    recorded — the model's account of its own compliance is exactly the kind of
    self-report this project does not accept anywhere else.

    None means UNREADABLE (no layer, not written yet, malformed), which is a
    third answer and never folded into zero: "no memory layer" and "a memory
    layer that recorded nothing" are different facts.
    """
    if state_dir is None:
        return None
    master = Path(state_dir) / "insession" / session_id / "master.json"
    try:
        data = json.loads(master.read_text())
    except (OSError, ValueError):
        return None
    trajectories = data.get("trajectories")
    if not isinstance(trajectories, list):
        return None
    total = 0
    for traj in trajectories:
        knowledge = traj.get("knowledge") if isinstance(traj, dict) else None
        if isinstance(knowledge, list):
            total += len(knowledge)
    return total


def _default_progress(message: str) -> None:
    stamp = _dt.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    print(f"[bg] {stamp} {message}", flush=True)


class FeedbackMixin:
    @classmethod
    def feedback_channel(cls, check: str) -> str:
        """`"tester"` or `"team"` for one check id. Single source of truth."""
        m = cls._CONF_KEY_RE.match(str(check or "").strip())
        if not m:
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

        Cached on the class; see `_load_feedback_overrides` for the contract.
        """
        cached = getattr(cls, "_FEEDBACK_OVERRIDES_CACHE", None)
        if cached is None:
            cached = load_feedback_overrides(_GRADER_DIR / "feedback.json")
            cls._FEEDBACK_OVERRIDES_CACHE = cached
        return cached

    @classmethod
    def _humanize_check(cls, check: str, *, pass_kind: str = "first") -> str:
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
        for key in (raw, token_key, conf_key, "CONF"):
            if key and key in overrides:
                # "CONF" must only resolve conformance checks, never a stray use
                # of the literal token in a backend/frontend context.
                if key != "CONF" or conf_key is not None:
                    return overrides[key][line]

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
    def _build_pass_verdict(cls, *, newly_passing: list[str]) -> str:
        """What the player says about the complaints that are now gone.

        SAME VOICE, SAME SHAPE as the failure message: a short opener, then a
        numbered list of the things they are no longer running into. Each item
        is that gate's FIRST-pass line — the person is referring back to what
        they originally reported, so that is the wording they would use.

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
            sanitized = cls._humanize_check(first_line)
            # Same cap and reasoning as the failure list: a human symptom
            # sentence legitimately runs long, and a cut mid-clause is the tell
            # that no person wrote it.
            if len(sanitized) > 200:
                sanitized = f"{sanitized[:200].rsplit(' ', 1)[0]}…"
            if not sanitized or sanitized in seen:
                continue
            seen.add(sanitized)
            deduped.append(sanitized)

        if not deduped:
            return ""

        opener = (
            "That fixed it — I'm not running into this any more:"
            if len(deduped) == 1
            else "That fixed it — I'm not running into these any more:"
        )
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
        had_prior_feedback: bool = False,
        repeat_checks: set[str] | None = None,
        capture_protocol: bool | None = None,
    ) -> str:
        """Compose the message the model receives after a failed attempt.

        THE VOICE (2026-09-02). One person who played the finished game and is
        listing what they hit. Two openers, chosen by whether this gate list is
        their first report or a re-report after the model said it had fixed
        things:

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

        Repeats are keyed on the raw gate id (stable), never the rendered
        sentence (lossy).

        CAPTURE RIDES THIS PROMPT, AFTER THE PLAYER'S WORDS (2026-09-04). The
        capture protocol used to live in AGENTS.md, in front of the model for the
        whole session including the build. It is now delivered here, because
        troubleshooting is the phase whose knowledge is worth preserving.

        It is appended as its own trailing section and NEVER folded into the
        complaint list: the message above it is one person describing what they
        hit while playing, and a player does not ask for a tool call. Mixing the
        two would cost the voice, which is load-bearing — a model that can tell
        it is being measured is not the model this run is measuring.

        `capture_protocol=True` sends the full protocol (the first troubleshooting
        round of a session), `False` sends the short reminder, `None` sends
        neither — the default, so every existing caller and test is unchanged.

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
        """
        header = (
            "I've checked your resolution for the problems that were given "
            "before, played the game in full again, and I'm still seeing these "
            "problems:"
            if had_prior_feedback
            else "I've checked your work thoroughly, and I want to list the "
            "issues that I've encountered while playing the game:"
        )

        # Accept either the rich problem records or a bare check list, so older
        # callers and tests keep working unchanged.
        records: list[dict[str, Any]]
        if problems is not None:
            records = [p for p in problems if isinstance(p, dict)]
        else:
            records = [{"check": c} for c in (checks or [])]

        repeats = repeat_checks or set()

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
        seen: set[str] = set()

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
            # THE GRADIENT, chosen per gate: a gate the model has already been
            # told about and failed to fix gets that gate's second-sighting
            # line. Keyed on the raw id because the rendered sentence differs
            # between the two passes and could not key anything.
            pass_kind = "repeat" if raw_check in repeats else "first"
            label = cls._humanize_check(
                raw_check.split("\n", 1)[0], pass_kind=pass_kind
            )
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
            by_channel[cls.feedback_channel(raw_check)].append(label)

        lines: list[str] = [_EXCUSE_ELIMINATOR, "", header, ""]
        for n, label in enumerate(by_channel["tester"], start=1):
            lines.append(f"{n}) {label}")

        # The tester always speaks, even with nothing to report: the opener has
        # already promised a list, and an opener with no list under it reads as
        # a truncated message rather than a clean run.
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
            lines += ["", _TEAM_HEADER, ""]
            for n, label in enumerate(by_channel["team"], start=1):
                lines.append(f"{n}) {label}")
            lines += ["", _TEAM_EXCUSE_ELIMINATOR]

        # LAST, AND SEPARATE. Everything above is the player's message; this is
        # the harness speaking to the worker about capture. It is appended, never
        # interleaved — see the docstring.
        if capture_protocol is True:
            lines += ["", _SESSION_EXTRACTION_MD]
        elif capture_protocol is False:
            lines += ["", _REPAIR_CAPTURE_REMINDER_MD]

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
        import harness.adapters.backgammon as _pkg
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
