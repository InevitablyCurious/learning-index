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
# `[needs: F03 REQ-HINT/selectable]`. When one of them failed too, the player's
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
    m = _NEEDS_RE.search(str(problem.get("observed", "")))
    return tuple(m.group(1).split()) if m else ()


def load_stages(checks_json: Path) -> list[Stage]:
    data = json.loads(Path(checks_json).read_text(encoding="utf-8"))
    stages = [
        Stage(number=int(s["stage"]), name=str(s["name"]), keys=tuple(str(k) for k in s["checks"]))
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


def stage_of(check: str, stages: Iterable[Stage]) -> Stage:
    ident = check_id(check)
    best: tuple[int, Stage] | None = None
    if ident is not None:
        for stage in stages:
            for key in stage.keys:
                matches = ident == key or (key.endswith("/") and ident.startswith(key))
                if matches and (best is None or len(key) > best[0]):
                    best = (len(key), stage)
    if best is None:
        raise UnstagedCheckError(
            f"check {check!r} has no player stage in grader/checks.json — its stage decides "
            "whether the model hears about it, so it must be declared, never guessed"
        )
    return best[1]


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
    failed = {ident for p in records if (ident := check_id(str(p.get("check", "")).strip()))}
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
    visible = [p for s, p in staged if s.number == first]
    withheld = [str(p.get("check", "")).strip() for s, p in staged if s.number != first]
    return PlayerView(stage=stage, visible=visible, withheld=withheld, unevaluated=unevaluated)
