"""PLAYER ORDER — the model hears what a player could actually reach.

A player cannot test bearing off if the opening position is wrong, and cannot
test hitting before a move can be made. So every round still grades every
check, but the repair message carries only the failing checks of the EARLIEST
stage that has any. Once that stage is clean the next one's problems appear.

The stages belong to the challenge (``grader/checks.json`` → ``stages``): each
lists check ids — a bracket token (``G05``) or a setup key (``REQ-RENDER/die``,
or ``REQ-STATE/`` for every key under it). The most specific key wins, so
``REQ-TESTID/die`` can sit in a later stage than ``REQ-TESTID/``.

A failing check with no stage RAISES: which stage it is in decides whether the
model hears about it, so guessing would silently change what a run measures.
tests/test_player_stages.py proves every check the grader can emit has one.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_TOKEN_RE = re.compile(r"^\s*\[([A-Z]+[0-9]*)\]")
_CONF_KEY_RE = re.compile(r"^\s*(?:conformance:)?(REQ-[A-Z0-9-]+/\S+)")


class UnstagedCheckError(RuntimeError):
    """A failing check the challenge gave no stage."""


@dataclass(frozen=True)
class Stage:
    number: int
    name: str
    keys: tuple[str, ...]


@dataclass(frozen=True)
class PlayerView:
    """What the model is told this round."""

    stage: Stage | None
    visible: list[dict[str, Any]] = field(default_factory=list)
    withheld: list[str] = field(default_factory=list)
    # Checks the grader never reached this round, and checks that stopped at a
    # step another failing check already reports (`[needs: …]`). Scored as not
    # passing; never told to the model, because nobody observed them fail.
    unevaluated: list[str] = field(default_factory=list)


# The pre-gate's wording for a check an earlier failure skipped
# (grader/conformance/pregate.ts verdictFor; pinned by
# grader/meta/unevaluated-is-not-pass.test.ts). Such a check was never looked
# at, so there is nothing true to say about it: telling the model "their
# automation can't find the board" when the page was never opened is how one
# HTTP 500 became 30 false complaints (run 1790183923, attempts 4 and 5).
_UNEVALUATED = "never evaluated"


def is_unevaluated(problem: dict[str, Any]) -> bool:
    return str(problem.get("observed", "")).strip().startswith(_UNEVALUATED)


# A CHECK THAT CANNOT GET STARTED IS NOT TOLD (Jerry, 2026-09-24). A gate that
# fails before it reaches its own subject — no checker to pick up, no hint to
# click, no move to undo — names the checks that test that same step:
# `[needs: F03 REQ-HINT/hint]`. When one of them failed too, the player's
# complaint is theirs, so this one is scored as not passing and told to no one;
# the doubles gate used to tell "I could only make two moves" to a player who
# could make none (FIX-2 mutations M13, M27, M28, M34). When none of them
# failed, the step went wrong only in this gate's situation, and the gate's own
# `[aspect: …]` line for it is told — hiding it would skip a stage a player
# meets. The needed checks sit in the same or an earlier stage and never form a
# cycle (tests/test_player_stages.py), so a withheld check always has a told
# one at or before its stage.
_NEEDS_RE = re.compile(r"\[needs: ([^\]]+)\]")


def needs_of(problem: dict[str, Any]) -> tuple[str, ...]:
    # EVERY marker, not the first: fourteen assertions write two, such as
    # `[needs: F01] [needs: G12]`, and reading only the first dropped the second
    # (2026-09-30) — the line was told even when G12 had already failed.
    observed = str(problem.get("observed", ""))
    return tuple(n for m in _NEEDS_RE.finditer(observed) for n in m.group(1).split())


def load_stages(checks_json: Path) -> list[Stage]:
    data = json.loads(Path(checks_json).read_text(encoding="utf-8"))
    stages = [
        Stage(
            number=int(s["stage"]),
            name=str(s["name"]),
            keys=tuple(str(k) for k in s["checks"]),
        )
        for s in data.get("stages") or []
    ]
    if not stages:
        raise UnstagedCheckError(f"{checks_json} declares no stages")
    return sorted(stages, key=lambda s: s.number)


def check_id(check: str) -> str | None:
    """``G05`` from ``[G05] …``, or ``REQ-RENDER/die`` from a setup check."""
    raw = str(check or "").split("\n", 1)[0]
    if m := _TOKEN_RE.match(raw):
        return m.group(1)
    if m := _CONF_KEY_RE.match(raw):
        return m.group(1)
    return None


def _match(check: str, stages: Iterable[Stage]) -> tuple[Stage, int]:
    """The check's stage and the position of its key in that stage's list."""
    ident = check_id(check)
    best: tuple[int, Stage, int] | None = None
    if ident is not None:
        for stage in stages:
            for index, key in enumerate(stage.keys):
                matches = ident == key or (key.endswith("/") and ident.startswith(key))
                if matches and (best is None or len(key) > best[0]):
                    best = (len(key), stage, index)
    if best is None:
        raise UnstagedCheckError(
            f"check {check!r} has no player stage in grader/checks.json — its stage decides "
            "whether the model hears about it, so it must be declared, never guessed"
        )
    return best[1], best[2]


def stage_of(check: str, stages: Iterable[Stage]) -> Stage:
    return _match(check, stages)[0]


def player_order(check: str, stages: Iterable[Stage]) -> tuple[int, int]:
    """Where a player meets this check: its stage, then its place in that stage's
    list. A stage's list is written in the order a player meets things (Jerry,
    2026-10-28: app loads → board → pieces → buttons → resizing), and the model
    reads its problems in that order — never in the grader's file order, which
    put conformance before backend before frontend whatever the player saw first
    (WO-LI-GRADER-ORIENTATION: 769 inversions in stage 1)."""
    stage, index = _match(check, stages)
    return stage.number, index


def player_view(
    problems: Iterable[dict[str, Any]],
    stages: list[Stage],
    *,
    is_infra: Callable[[str], bool],
) -> PlayerView:
    """The problems of the earliest failing stage; the rest are withheld, and
    checks the grader never reached, or that stopped at a step another failing
    check reports, are told to no one."""
    records = [p for p in problems if isinstance(p, dict)]
    # A check the grader never reached is not a failure a player met, so it cannot
    # excuse another check from being told: both would reach no one.
    failed = {
        ident
        for p in records
        if not is_unevaluated(p)
        and (ident := check_id(str(p.get("check", "")).strip()))
    }
    staged: list[tuple[Stage, dict[str, Any]]] = []
    unevaluated: list[str] = []
    for problem in records:
        check = str(problem.get("check", "")).strip()
        if not check or is_infra(check):
            continue
        if is_unevaluated(problem) or any(n in failed for n in needs_of(problem)):
            unevaluated.append(check)
            continue
        staged.append((stage_of(check, stages), problem))
    if not staged:
        return PlayerView(stage=None, unevaluated=unevaluated)
    first = min(s.number for s, _ in staged)
    stage = next(s for s, _ in staged if s.number == first)
    visible = sorted(
        (p for s, p in staged if s.number == first),
        key=lambda p: player_order(str(p.get("check", "")).strip(), stages),
    )
    withheld = [str(p.get("check", "")).strip() for s, p in staged if s.number != first]
    return PlayerView(
        stage=stage, visible=visible, withheld=withheld, unevaluated=unevaluated
    )


# WHERE IN ITS TEST A COMPLAINT IS ASKED. A test stops at its first failing
# assertion, so a check that now fails on an aspect asked LATER in its test than
# the one the model was told about has passed that earlier one: the told
# complaint is fixed, and the player can say so. One that fails EARLIER never
# reached the told assertion, and nothing true can be said about it. Two aspects
# asked inside one loop are NOT ordered: F31 asks side, up, down and past piece by
# piece, so "past" failing on one piece says nothing about "up" on another. Read
# from the graded source: each aspect's first ask in its test body, with the
# `for` blocks around it.
_TEST_START_RE = re.compile(r"""^\s*(?:test|it)\(\s*["'`]\[([A-Z]+[0-9]*)\]""", re.M)
_ASPECT_MARK_RE = re.compile(r"\[aspect: ([a-z]+)\]")
_FOR_OPEN_RE = re.compile(r"\bfor\s*\([^{]*\)\s*$")


@dataclass(frozen=True)
class AspectAsk:
    position: int
    loops: frozenset[int]


def _asks(body: str, offset: int) -> dict[str, list[AspectAsk]]:
    asks: dict[str, list[AspectAsk]] = {}
    stack: list[tuple[int, bool]] = []  # (open position, is a for-loop block)
    # Asks, not mentions: a comment naming an aspect is not where it is asked.
    marks = {
        m.start(): m.group(1)
        for m in _ASPECT_MARK_RE.finditer(body)
        if not body[body.rfind("\n", 0, m.start()) + 1 : m.start()]
        .lstrip()
        .startswith(("//", "*"))
    }
    for i, ch in enumerate(body):
        if ch == "{":
            stack.append((i, bool(_FOR_OPEN_RE.search(body[max(0, i - 200) : i]))))
        elif ch == "}" and stack:
            stack.pop()
        elif i in marks:
            loops = frozenset(offset + pos for pos, is_for in stack if is_for)
            asks.setdefault(marks[i], []).append(AspectAsk(offset + i, loops))
    return asks


def aspect_order(grader_dir: Path) -> dict[str, dict[str, list[AspectAsk]]]:
    """check token -> {aspect: every place its test asks it, and inside which loops}."""
    order: dict[str, dict[str, list[AspectAsk]]] = {}
    for path in sorted(
        [
            *Path(grader_dir).glob("frontend/*.spec.ts"),
            *Path(grader_dir).glob("backend/*.test.ts"),
        ]
    ):
        text = path.read_text(encoding="utf-8")
        starts = list(_TEST_START_RE.finditer(text))
        for i, m in enumerate(starts):
            end = starts[i + 1].start() if i + 1 < len(starts) else len(text)
            seen = order.setdefault(m.group(1), {})
            for aspect, asks in _asks(text[m.end() : end], m.end()).items():
                seen.setdefault(aspect, []).extend(asks)
    return order


def asked_after(
    order: dict[str, dict[str, list[AspectAsk]]], token: str, later: str, earlier: str
) -> bool:
    """True only when every ask of `earlier` comes before the first ask of `later`,
    outside any loop they share — F87 asks "stale" twice, once before "place" and
    once after it, so a failure on "place" proves nothing about the second."""
    asks = order.get(token, {})
    before, after = asks.get(earlier), asks.get(later)
    if not before or not after:
        return False
    first = min(after, key=lambda x: x.position)
    return all(
        a.position < first.position and not (a.loops & first.loops) for a in before
    )


def told_complaints_fixed(
    told: Iterable[tuple[str, str | None]],
    now: Iterable[tuple[str, str | None]],
    order: dict[str, dict[str, list[AspectAsk]]],
) -> list[tuple[str, str | None]]:
    """Which of last round's told complaints (check, aspect) are gone now.

    Gone when the check passes, or when every way it fails now is asked after
    the told aspect, outside any loop they share. Run 1793479392 round 3: the
    collision told in round 2 was fixed and the check failed on uneven pieces,
    asked after it; acknowledged per check, the model never heard its fix worked.
    """
    failing: dict[str, set[str | None]] = {}
    # A line belongs to a gate id and aspect, not to one check: two checks of
    # one gate tell the same line, so while either fails it is not fixed (run
    # 1793662415 round 3: one G12 check passed, the other still told the G12
    # line, and the model heard it fixed and still broken in one message).
    open_lines: set[tuple[str, str | None]] = set()
    for check, aspect in now:
        failing.setdefault(check, set()).add(aspect)
        open_lines.add((check_id(check) or check, aspect))
    fixed = []
    for check, aspect in told:
        if check not in failing:
            if (check_id(check) or check, aspect) not in open_lines:
                fixed.append((check, aspect))
            continue
        token = check_id(check) or ""
        if aspect is not None and all(
            b is not None and asked_after(order, token, b, aspect)
            for b in failing[check]
        ):
            fixed.append((check, aspect))
    return fixed
