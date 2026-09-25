"""The human-written symptom lines the model is told.

The runtime source is `task/backgammon/prompts/failures/*.md` — one file per
line — and the wording guards below read it directly, so they validate the
bytes the repair loop actually delivers. `grader/feedback.json` remains as a
mirror for the preflight/completeness tooling; this file also tests it for
structural completeness and for byte-equality with the `.md` source.

WHY THESE TESTS. The repair-loop message used to be derived from the test
title, and a test title states the RULE. Gate E08 was reported to the model as
"full-turn sequences are distinct by RESULTING BOARD" — the requirement,
verbatim, for a rule published nowhere else. On run 1788099503 the model failed
E08 on attempt 1 and passed on attempt 2. The gate measured whether it got a
second attempt.

The override file fixes that, and these tests stop it regressing into the same
failure by a different route: a typo'd key silently does nothing, and a line
written in grader voice re-leaks the answer. Both are invisible without a test —
you would only find out by reading a transcript months later.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from harness.adapters.challenge import (
    ChallengeRunner,
    load_feedback_overrides,
    load_feedback_overrides_from_failures,
)

REPO = Path(__file__).resolve().parents[1]
TASK = REPO / "task" / "backgammon"
GATES = REPO / "grader"
FEEDBACK = GATES / "feedback.json"

# Identifiers from the published function surface. A user reporting a symptom
# does not name a function; if one of these appears, the line is grader voice.
# Matched CASE-SENSITIVELY, so these are camelCase identifiers a player could
# not produce by accident.
#
# `opponent` and `evaluate` were here and are now deliberately NOT: both are
# published function names AND ordinary English. A real submission was rejected
# for "which is unfair to my opponent" — a perfectly good player sentence with
# zero leak value. A guard that fires on plain English trains the author to
# write stilted text, which is itself a tell that no human wrote it.
_IMPLEMENTATION_IDENTIFIERS = (
    "allSequences",
    "singleMoves",
    "legalMovesNow",
    "maxPlies",
    "cloneBoard",
    "startingPoints",
    "createGame",
    "allInHome",
    "applyMove",
    "pipCount",
    "checkWin",
    "chooseMoves",
    "winProbability",
    "shouldAiDouble",
    "shouldAiAccept",
    "data-testid",
    "DEBUG_API",
)


# PRESCRIPTIVE VOICE. A player reports what happened; they do not state what
# ought to happen. "I only get two moves" is an observation. "...and not four,
# as it should be" is the rule, and pairing the wrong value with the right one
# hands over the whole fix. This is the paraphrase the title-overlap check
# cannot see: it shares almost no words with the test title and leaks more.
_PRESCRIPTIVE_PHRASES = (
    "should be",
    "should have",
    "should get",
    "should give",
    "should show",
    "supposed to",
    "ought to",
    "needs to be",
    "need to be",
    "must be",
    "instead of",
    "rather than",
    "as it should",
    "is meant to",
    "correct value",
)

# DEVELOPER VOICE. A person playing the game has never seen the source. Naming
# the machinery tells the model it is being graded, which the feedback voice
# exists to conceal, and usually points straight at the file to edit.
def _channel(key: str) -> str:
    """Which of the two people owns this line.

    Imported from the harness rather than re-derived: the prompt builder routes
    on this exact function, and a second copy here would let a line be judged by
    one bar and delivered under the other.
    """
    from harness.adapters.challenge import ChallengeRunner

    return ChallengeRunner.feedback_channel(key)


_DEVELOPER_NOUNS = (
    "implementation",
    "function",
    "endpoint",
    "parameter",
    "variable",
    "codebase",
    "refactor",
    "the code",
    "your code",
    "the api",
    "the server",
    "the engine",
    "return value",
    "unit test",
    "the spec",
)


def _tokens_in_the_suite() -> set[str]:
    """Every `[XXX]` gate token declared by a graded gate file.

    Scanned from the files rather than from a roster so this needs no `npx`
    and cannot go stale against a roster captured for some other run.
    """
    found: set[str] = set()
    pattern = re.compile(r'["\'`]\s*\[([A-Z]+[0-9]*)\]')
    for directory in ("backend", "conformance", "frontend"):
        root = GATES / directory
        if not root.is_dir():
            continue
        for path in root.rglob("*.ts"):
            found.update(pattern.findall(path.read_text(encoding="utf-8")))
    return found


def _overrides() -> dict[str, dict[str, str]]:
    return load_feedback_overrides(FEEDBACK)


def _lines() -> list[tuple[str, str, str]]:
    """Every written line, as ``(gate, pass_kind, text)``.

    Read from the `.md` RUNTIME SOURCE (`task/backgammon/prompts/failures/`),
    not the JSON mirror: a guard that reads the mirror can be escaped by an
    `.md`-only edit, and the guard's whole job is to vet what the model hears.
    `test_the_json_mirror_matches_the_md_runtime_source` pins the mirror to
    this source byte-for-byte.

    EVERY GUARD BELOW RUNS ON BOTH LINES. The `repeat` line is the one most at
    risk: it is written second, it is meant to say something the first line did
    not, and the natural way to do that is to get more specific — which is the
    leak. Holding both to the identical bar is what keeps the second line a
    second SIGHTING rather than a first explanation.
    """
    return [
        (gate, kind, entry[kind])
        for gate, entry in sorted(
            load_feedback_overrides_from_failures(TASK / "prompts").items()
        )
        for kind in ("first", "repeat")
    ]


def _line_ids() -> list[str]:
    return [f"{gate}:{kind}" for gate, kind, _ in _lines()]


def test_the_file_parses_and_the_loader_reads_it() -> None:
    assert FEEDBACK.is_file(), "grader/feedback.json is missing"
    json.loads(FEEDBACK.read_text(encoding="utf-8"))
    assert _overrides(), "the loader read no entries from a file that exists"


def test_the_json_mirror_matches_the_md_runtime_source() -> None:
    """The JSON mirror must agree with the `.md` runtime source, exhaustively.

    The wording guards read the `.md` files; the structural-completeness checks
    read the JSON mirror. If the two drift, one of them is validating text that
    is not delivered. This is the explicit cross-pin that keeps the mirror
    honest against the source: identical key sets AND identical `first`/`repeat`
    strings for every key.
    """
    mirror = _overrides()
    runtime = load_feedback_overrides_from_failures(TASK / "prompts")
    assert mirror and runtime, "a source loaded empty — nothing would be compared"
    assert mirror.keys() == runtime.keys(), (
        "key sets drifted — JSON-only: "
        f"{sorted(mirror.keys() - runtime.keys())}, .md-only: "
        f"{sorted(runtime.keys() - mirror.keys())}"
    )
    for key in sorted(mirror):
        for kind in ("first", "repeat"):
            assert mirror[key][kind] == runtime[key][kind], (
                f"{key}/{kind}: grader/feedback.json and the .md runtime source "
                "disagree — the guards and the mirror are no longer reading the "
                "same text"
            )


def test_a_missing_or_broken_file_is_never_an_error(tmp_path: Path) -> None:
    """Rolling this out gate by gate must not be able to break a campaign."""
    assert load_feedback_overrides(tmp_path / "nope.json") == {}
    broken = tmp_path / "broken.json"
    broken.write_text("{not json", encoding="utf-8")
    assert load_feedback_overrides(broken) == {}


def test_every_key_addresses_a_gate_that_actually_exists() -> None:
    """A typo'd key is silent: the gate keeps its leaky title-derived line."""
    tokens = _tokens_in_the_suite()
    assert tokens, "found no gate tokens in the suite — the scan is broken"

    orphans = sorted(
        key
        for key in _overrides()
        if re.fullmatch(r"[A-Z]+[0-9]*", key) and key not in tokens
    )
    assert not orphans, (
        f"these feedback keys match no gate in the suite: {orphans}. A key that "
        "addresses nothing is indistinguishable from one that works — the gate "
        "silently keeps its title-derived message."
    )


def test_every_gate_token_has_an_override() -> None:
    """SINGLE-SYSTEM completeness (WO-FEEDBACK-VOICE-3, 2026-08-30).

    The feedback voice has no fallback: `_humanize_check` RAISES on a gate with
    no override. So this is the reverse of the orphan check — every gate token
    in the graded suite MUST have a human-written symptom line, or that gate's
    repair-loop message cannot be built at all. A missing override is a
    misconfigured benchmark, not a graceful degradation. This test is the CI
    half of the guarantee; bench preflight is the launch half.
    """
    tokens = _tokens_in_the_suite()
    assert tokens, "found no gate tokens in the suite — the scan is broken"

    overrides = _overrides()
    missing = sorted(t for t in tokens if t not in overrides)
    assert not missing, (
        f"these gates have NO feedback override: {missing}. The feedback voice "
        "is single-system — a gate with no human-written symptom line cannot be "
        "reported to the model, and `_humanize_check` will hard-fail on it. "
        "Write a symptom sentence for each in grader/feedback.json."
    )


@pytest.mark.parametrize("key,kind,text", _lines(), ids=_line_ids())
def test_no_override_is_written_in_grader_voice(key: str, kind: str, text: str) -> None:
    """The whole point is that the model hears a user, not a requirement."""
    assert "REQ-" not in text, (
        f"{key}/{kind}: names a requirement id — that is the grader talking"
    )

    leaked = [name for name in _IMPLEMENTATION_IDENTIFIERS if name in text]
    assert not leaked, (
        f"{key}/{kind}: names {leaked}. A person playing the game does not know "
        "the function names; naming one hands over where to look and usually "
        "what to do."
    )


@pytest.mark.parametrize("key,kind,text", _lines(), ids=_line_ids())
def test_no_override_states_what_should_happen(key: str, kind: str, text: str) -> None:
    """The paraphrase leak, which the title-overlap check cannot catch.

    Real submission, rejected 2026-08-30: "whenever i roll doubles i can only
    move the pieces 2 times and not 4 as it should be". It shares exactly one
    significant word with its test title, so the overlap check passed it — and
    it names the wrong value AND the right value, which is more than the title
    it replaced. The observation ("I only get two moves on a double") is the
    useful half; the correction is the leak.
    """
    lowered = text.lower()
    found = [phrase for phrase in _PRESCRIPTIVE_PHRASES if phrase in lowered]
    assert not found, (
        f"{key}/{kind}: says {found} — that is the RULE, not the symptom. A player "
        "reports what happened to them; stating what ought to have happened "
        "pairs the wrong value with the right one and hands over the fix."
    )


@pytest.mark.parametrize("key,kind,text", _lines(), ids=_line_ids())
def test_no_override_speaks_in_developer_voice(key: str, kind: str, text: str) -> None:
    """The TESTER is a player, not a reviewer with the source open.

    SCOPED TO THE TESTER'S CHANNEL (2026-09-05). The repair message now carries
    two people: the tester, who played the game, and a software team integrating
    against it. This guard encodes "a player would not say this" — and the whole
    reason the second persona exists is that a player CANNOT say some of these
    things. There is no player sentence for "your state response has no
    winType", and forcing one is precisely how eleven conformance findings came
    out as "The game doesn't seem to start up correctly at all".

    The team may name machinery; that is their job. What they may not do is
    state the rule or speak as the grader — `test_no_override_states_what_should_happen`
    and `test_team_line_is_not_the_graders_voice` still hold them, and every
    other guard in this file runs on both channels unchanged.
    """
    if _channel(key) != "tester":
        pytest.skip(f"{key} is the software team's line — see test_team_line_is_not_the_graders_voice")
    lowered = text.lower()
    found = [noun for noun in _DEVELOPER_NOUNS if noun in lowered]
    assert not found, (
        f"{key}/{kind}: says {found}. Someone playing the game has not seen the "
        "source. Naming the machinery both breaks the voice and points at the "
        "file to edit."
    )


# Words that would tell the model it is being graded. The team is a customer
# integrating an app; a customer does not know the app is under test, and a
# sentence that says otherwise is the same class of tell as the `FAILING` label
# that was removed from the old bullet list.
_GRADER_VOCABULARY = (
    "conformance",
    "gate",
    "test suite",
    "assertion",
    "expected value",
    "pre-gate",
    "harness",
    "benchmark",
    "grader",
    "pass/fail",
)


@pytest.mark.parametrize("key,kind,text", _lines(), ids=_line_ids())
def test_team_line_is_not_the_graders_voice(key: str, kind: str, text: str) -> None:
    """The software team is a customer, not the thing measuring the model.

    They may say "endpoint" — they are integrating against one. They may not say
    "conformance check", which is the harness's own word for the gate and tells
    the model it is being measured.
    """
    if _channel(key) != "team":
        pytest.skip(f"{key} is the tester's line")
    lowered = text.lower()
    found = [word for word in _GRADER_VOCABULARY if word in lowered]
    assert not found, (
        f"{key}/{kind}: says {found}. That is the harness's vocabulary, not a "
        "customer's. A model that can tell it is being measured is not the "
        "model this run is measuring."
    )


@pytest.mark.parametrize("key,kind,text", _lines(), ids=_line_ids())
def test_no_override_restates_its_own_test_title(key: str, kind: str, text: str) -> None:
    """The failure mode this file exists to prevent, checked directly.

    Copying the title in is the easy mistake — it reads like a description of
    the problem because it IS one, stated as the rule.
    """
    titles = [
        line
        for path in (GATES / "backend", GATES / "frontend", GATES / "conformance")
        if path.is_dir()
        for file in path.rglob("*.ts")
        for line in file.read_text(encoding="utf-8").splitlines()
        if f"[{key}]" in line
    ]
    if not titles:
        pytest.skip(f"{key} is not a bracket-token key")

    def significant(s: str) -> set[str]:
        words = re.findall(r"[a-z]{4,}", s.lower())
        return {
            w
            for w in words
            if w not in {"when", "with", "that", "does", "into", "from", "have", "been"}
        }

    body = significant(text)
    for title in titles:
        overlap = body & significant(title)
        assert len(overlap) < 4, (
            f"{key}/{kind}: the message shares {sorted(overlap)} with its own test title "
            f"({title.strip()[:90]}). Restating the title is exactly the leak this "
            "file removes — describe what a player SAW, not what the rule says."
        )


def test_the_override_actually_reaches_the_delivered_message() -> None:
    """End to end: a written override must replace the title-derived phrasing."""
    overrides = _overrides()
    key = "E08"
    if key not in overrides:
        pytest.skip("E08 has no override written yet")

    check = f"[{key}] REQ-SEQ-DEDUP — full-turn sequences are distinct by RESULTING BOARD"

    first = ChallengeRunner._build_feedback_prompt(problems=[{"check": check}])
    assert overrides[key]["first"] in first
    assert overrides[key]["repeat"] not in first, (
        "the first report must not use the second-sighting wording"
    )

    # THE SAME GATE, FAILING AGAIN. The gradient is the second human line, and
    # nothing from the grader: `observed` is deliberately supplied here and must
    # not appear anywhere in the delivered text.
    repeat = ChallengeRunner._build_feedback_prompt(
        problems=[{"check": check, "observed": "AssertionError: expected 4 to be 2"}],
        had_prior_feedback=True,
        repeat_complaints={check},
    )
    assert overrides[key]["repeat"] in repeat
    assert overrides[key]["first"] not in repeat

    for prompt in (first, repeat):
        assert "RESULTING BOARD" not in prompt, (
            "the title leaked into the delivered text anyway"
        )
        assert "REQ-SEQ-DEDUP" not in prompt
    assert "AssertionError" not in repeat and "expected 4 to be 2" not in repeat, (
        "the grader's assertion reached the model — that is the leak the second "
        "human line replaced"
    )
