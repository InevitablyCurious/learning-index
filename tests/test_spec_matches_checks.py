"""The build prompts and the checks describe the same contract — in both directions.

WHY THIS EXISTS (2026-09-30). Jerry's rule from 2026-09-15: the build prompts are
the model's only specification, and the sorting rule for anything in them is
"does a grading test need this exact detail, or should the model work it out?".
Only function names were enforced (test_instruction_surface_consistency.py).
Everything else slipped both ways:

- A detail the prompts state that no check tested: static elements "keep their
  existing id". Run 9a946250 renamed every id, its own lookup of #endTurnBtn came
  back empty, the page died on load, and the grader never said a name changed.
- Details checks need that the prompts never stated: the buttons that answer the
  computer's double (Accept/Take, Decline/Pass), the word "points" on the
  end-of-game pop-up, and when gamesPlayed goes up — G27 told two runs a false
  line every round because of that last one.

Each test below reads the real files: the chunk prompts on one side, the graded
check files (and the golden's own state) on the other.
"""

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PROMPTS_DIR = REPO / "task" / "backgammon" / "prompts"
GRADER = REPO / "grader"
GOLDEN_SERVER = REPO / "task" / "backgammon" / "golden" / "src" / "server.ts"


def _prompts() -> str:
    return "\n".join(p.read_text(encoding="utf-8") for p in sorted(PROMPTS_DIR.glob("chunk-*.md")))


def _check_sources() -> str:
    parts = []
    for d in ("frontend", "conformance", "backend", "lib"):
        for p in sorted((GRADER / d).rglob("*.ts")):
            if "quarantine" not in p.parts and "node_modules" not in p.parts:
                parts.append(p.read_text(encoding="utf-8"))
    return "\n".join(parts)


def _pregate_list(name: str) -> list[str]:
    src = (GRADER / "conformance" / "pregate.ts").read_text(encoding="utf-8")
    m = re.search(name + r"[^=]*=\s*\[(.*?)\]", src, re.S)
    assert m, f"{name} not found in pregate.ts"
    return re.findall(r'"([^"]+)"', m.group(1))


def _tags_the_checks_use() -> set[str]:
    src = _check_sources()
    tags = set(re.findall(r'getByTestId\(\s*["\']([A-Za-z-]+)["\']', src))
    tags |= set(re.findall(r'data-testid=\\?["\']([A-Za-z-]+)', src))
    tags |= set(_pregate_list("REQUIRED_STATIC_TESTIDS")) | set(_pregate_list("COUNTED_ELEMENT_LABELS"))
    return tags


def _tags_the_prompts_name() -> set[str]:
    prompts = _prompts()
    tags = set(re.findall(r'data-testid="([A-Za-z-]+)"', prompts))
    static = re.search(r"\*\*Static:\*\*(.*?)\n", prompts)
    assert static, "the prompts' static tag list is missing"
    tags |= set(re.findall(r"`([A-Za-z-]+)`", static.group(1)))
    return tags


def _prompt_state_fields() -> set[str]:
    m = re.search(r"```\s*\n(points, bar, off.*?)\n```", _prompts(), re.S)
    assert m, "the prompts' serialized state list is missing"
    return {f.strip() for f in re.split(r"[,\n]", m.group(1)) if f.strip()}


def test_every_page_tag_a_check_uses_is_named_in_the_prompts() -> None:
    prompts = _prompts()
    missing = sorted(t for t in _tags_the_checks_use() if t not in prompts)
    assert not missing, f"checks select on tags the build prompts never name: {missing}"


def test_every_page_tag_the_prompts_require_is_used_by_a_check() -> None:
    unused = sorted(_tags_the_prompts_name() - _tags_the_checks_use())
    assert not unused, f"the build prompts require tags no check uses: {unused}"


def test_every_data_attribute_is_named_on_both_sides() -> None:
    used = set(re.findall(r"\b(data-(?!testid)[a-z-]+)", _check_sources()))
    named = set(re.findall(r"`(data-(?!testid)[a-z-]+)", _prompts()))
    assert used <= set(re.findall(r"\b(data-[a-z-]+)", _prompts())), (
        f"checks read data- attributes the prompts never name: {sorted(used - named)}"
    )
    assert named <= used, f"the prompts name data- attributes no check reads: {sorted(named - used)}"


def test_every_route_a_check_calls_is_in_the_prompts() -> None:
    # One way only: routes such as /api/endturn are exercised through the page,
    # so a check never has to spell every route the prompts publish.
    prompts = _prompts()
    routes = set(re.findall(r'["\'`](/api/[a-z/_-]+|/health)\b', _check_sources()))
    missing = sorted(r for r in routes if f"`{r}`" not in prompts)
    assert not missing, f"checks call routes the build prompts never publish: {missing}"


def test_the_prompts_state_list_is_the_state_the_conformance_checks_require() -> None:
    required = set(_pregate_list("REQUIRED_STATE_KEYS"))
    listed = _prompt_state_fields()
    assert listed == required, (
        f"state the prompts list but no check requires: {sorted(listed - required)}; "
        f"state checks require but the prompts never list: {sorted(required - listed)}"
    )


def test_every_state_field_a_check_reads_is_in_the_prompts_state_list() -> None:
    server = GOLDEN_SERVER.read_text(encoding="utf-8")
    m = re.search(r"function serialize\(.*?\n}\n", server, re.S)
    assert m, "the golden's serialize() is missing"
    fields = set(re.findall(r"^\s+(\w+)\s*[:,]", m.group(0), re.M))
    src = _check_sources()
    read = {f for f in fields if re.search(r"\." + re.escape(f) + r"\b", src)}
    missing = sorted(read - _prompt_state_fields())
    assert not missing, f"checks read state fields the prompts never list: {missing}"


# The exact words a check matches on the page, each beside the prompt text that
# states it. A new word pattern in a check has to be added here, with its prompt
# sentence, or the scan below fails.
_WORDS = {
    "TAKE": "Accept (or Take)",
    "PASS": "Decline (or Pass)",
    "FAST_FORWARD": '"Fast Forward"',
    "PAUSE": '"Pause"',
    "REASONING_ARTIFACTS": "never show its win percentage, its pip counts, or its reasoning",
}
_LITERALS = {
    r"/point/i": 'the word "point" or "points"',
    r"no moves available": '"No moves available"',
    r"tie\s*[—–-]\s*roll again": "Tie — roll again",
    r"You win": '"You win"',
    r"/win/i": 'contains the word "win"',
    r"match score": '"Match score"',
    r"in use|already": "already in use",
    r"/center|centre|centr/": '"center", "centered" or "centre"',
}


def test_every_word_pattern_a_check_defines_is_stated_in_the_prompts() -> None:
    src = _check_sources()
    prompts = _prompts()
    constants = set(re.findall(r"\bconst ([A-Z][A-Z_]+) = /", src))
    unlisted = sorted(constants - set(_WORDS))
    assert not unlisted, f"word patterns in the checks with no prompt sentence listed here: {unlisted}"
    for name, sentence in _WORDS.items():
        assert sentence in prompts, f"{name}: the prompts no longer say {sentence!r}"
    for literal, sentence in _LITERALS.items():
        assert literal.lower() in src.lower(), f"{literal!r} is no longer matched by any check — drop it here"
        assert sentence in prompts, f"{literal!r}: the prompts no longer say {sentence!r}"


def test_the_static_id_check_and_the_prompts_id_rule_go_together() -> None:
    checks_ids = "REQ-TESTID/id." in (GRADER / "conformance" / "pregate.ts").read_text(encoding="utf-8")
    states_ids = "keep their existing `id`" in _prompts()
    assert checks_ids == states_ids, (
        "the pre-gate checks static ids but the prompts never say to keep them"
        if checks_ids
        else "the prompts say static elements keep their ids but no check looks"
    )


# NOT COVERED HERE: requirements that are behaviour rather than a name or a word —
# G27's "gamesPlayed goes up when a game ends" was one. Those stay a review item:
# every new or changed check is read against the prompt sentence it grades.


def test_the_repair_reminder_lists_every_tag_the_prompts_require() -> None:
    # The repair rounds remind the model what not to rename. Fast Forward's tag
    # joined chunk-04 in batch 4 and never reached this list.
    reminder = (PROMPTS_DIR / "repair" / "constraints.md").read_text(encoding="utf-8")
    missing = sorted(t for t in _tags_the_prompts_name() if not re.search(r"\b" + re.escape(t) + r"\b", reminder))
    assert not missing, f"tags the prompts require that the repair reminder never lists: {missing}"
