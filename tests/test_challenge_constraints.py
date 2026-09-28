"""The integration-surface block that closes every repair message.

`_build_feedback_prompt` appends `_CONSTRAINTS`
(task/backgammon/prompts/repair/constraints.md) as the LAST paragraph of every
repair message, unconditionally: the 24 static data-testid tags plus 8
dynamic, the routes (9 POST + GET /health + 2 debug behind DEBUG_API=1) and
the 20 state fields the checking depends on — named so a model fixing the
complaints above never renames or removes the surface itself.

Three responsibilities, one group each below:

1. The block ENDS every composed message variant — each built through the
   real player_view → _build_feedback_prompt pipeline (the helpers and the
   check IDs are the ones tests/test_challenge_feedback_channels.py proved
   resolve to failure overrides), never through a stubbed string.
2. A BIDIRECTIONAL drift guard between constraints.md and the build steps
   (chunk-03.md owns the routes and the state keys, chunk-04.md the
   data-testid tags). A name in the block the build steps never mention is a
   typo or an extra name; a name the build steps require that the block omits
   is a silent rename waiting to happen.
3. The block is model-facing text, so it clears the same grader-vocabulary
   bar as every other line the model reads.
"""

from __future__ import annotations

import re
from pathlib import Path

from harness.adapters.challenge import ChallengeRunner as R
from harness.adapters.challenge.constants import _CONSTRAINTS, _GRADER_DIR
from harness.adapters.challenge.stages import load_stages, player_view

REPO = Path(__file__).resolve().parents[1]
PROMPTS = REPO / "task" / "backgammon" / "prompts"
CHUNK_03 = PROMPTS / "chunk-03.md"  # the server chunk: routes + serialized state
CHUNK_04 = PROMPTS / "chunk-04.md"  # the frontend chunk: data-testid tags

STAGES = load_stages(_GRADER_DIR / "checks.json")


# The real path, exactly as tests/test_challenge_feedback_channels.py drives
# it (and the runner drives that): stage the problems with player_view, then
# hand the builder the visible problems plus the withheld and unevaluated
# checks. Copied, not imported: a test module's private helpers are not a
# shared surface, and every feedback test file here carries its own.
def _problem(check: str) -> dict[str, str]:
    return {"check": check, "expected": "present", "observed": "missing"}


def _infra(check: str) -> bool:
    return R._is_harness_infra_check(check)


def _feedback(problems: list[dict[str, str]]):
    view = player_view(problems, STAGES, is_infra=_infra)
    msg = R._build_feedback_prompt(
        problems=view.visible,
        repeat_complaints=set(),
        withheld=view.withheld,
        unevaluated=view.unevaluated,
    )
    return view, msg


def _ends_with_the_block(msg: str) -> None:
    """The invariant every variant shares: the block is the LAST paragraph of
    the message, and it is there exactly once. Anything appended after it
    would push the integration surface out of the closing position."""
    assert msg.endswith(_CONSTRAINTS), (
        "the repair message does not END with the constraints block"
    )
    assert msg.count(_CONSTRAINTS) == 1, (
        "the constraints block must appear exactly once, not be sprinkled "
        "through the message"
    )


# ── GROUP 1 — THE BLOCK ENDS EVERY COMPOSED MESSAGE ─────────────────────────


def test_the_block_ends_the_tester_only_message() -> None:
    """(a) One tester-channel complaint; the team has nothing to say, so there
    is no team section at all — the block still closes the message."""
    _, msg = _feedback([_problem("[G07] REQ-HIT — hitting → bar")])
    _ends_with_the_block(msg)
    assert "software team" not in msg, "this variant has no team section"


def test_the_block_ends_the_team_only_message() -> None:
    """(b) One team-channel complaint; no tester-channel check failed, so the
    tester's only line is the honest clean-look one."""
    _, msg = _feedback(
        [_problem('conformance:REQ-STATE/state.winType — /api/state carries "winType"')]
    )
    _ends_with_the_block(msg)
    assert "1) Nothing jumped out at me this time while I was playing." in msg
    assert "Also, my software team" in msg


def test_the_block_ends_the_both_channels_message() -> None:
    """(c) One tester + one team complaint. Both checks sit in stage 1 of
    grader/checks.json, so player_view keeps both visible and both lists are
    composed into the one message."""
    _, msg = _feedback(
        [
            _problem("[G01] REQ-INIT — initial position"),
            _problem('conformance:REQ-STATE/state.winType — /api/state carries "winType"'),
        ]
    )
    _ends_with_the_block(msg)
    assert "Also, my software team" in msg, "the team section follows the tester's list"
    assert "Nothing jumped out" not in msg, (
        "the tester has a real complaint here, not the clean-look placeholder"
    )


def test_the_block_ends_the_tester_silent_message() -> None:
    """(d) A team line plus a later-stage tester check that player_view
    withheld: tester_fell_silent fires, the team opens alone with
    team-header-alone — and the block still closes the message."""
    view, msg = _feedback(
        [
            {"check": "conformance:REQ-TESTID/testid.board", "observed": "missing"},
            {"check": "[G07] REQ-HIT — hitting → bar", "observed": "x"},
        ]
    )
    _ends_with_the_block(msg)
    assert view.withheld == ["[G07] REQ-HIT — hitting → bar"]
    assert "My software team" in msg
    assert "Also, my software team" not in msg, "the team opens alone, without 'Also'"


def test_the_block_ends_the_could_not_pin_it_down_message() -> None:
    """(e) No itemised problems at all: both channels are empty and the tester
    says the only honest thing left."""
    _, msg = _feedback([])
    _ends_with_the_block(msg)
    assert "1) Something is still broken but I couldn't pin down what it was." in msg


# ── GROUP 2 — BIDIRECTIONAL DRIFT GUARD ─────────────────────────────────────
#
# The authoritative sets, derived from the build steps, in order. Shared names
# ("message", "dice", "cube", "bar", "off") legitimately appear in more than
# one set — each set is parsed and guarded independently, never merged.

STATIC_TESTIDS = (
    "scoreWhite", "scoreBlack", "difficulty", "newGameBtn", "board",
    "playfield", "checkerLayer", "pointHints", "turnIndicator", "pipWhite",
    "pipBlack", "cube", "cubeVal", "cubeOwner", "dice", "rollBtn",
    "doubleBtn", "undoBtn", "endTurnBtn", "message", "modalOverlay",
    "modalTitle", "modalBody", "modalBtns",
)
DYNAMIC_TESTIDS = ("point", "checker", "hint", "die", "bar", "off-tray", "off-ai", "off-you")
POST_ROUTES = (
    "/api/state", "/api/new", "/api/roll", "/api/move", "/api/undo",
    "/api/endturn", "/api/double", "/api/double/respond", "/api/ai",
)
GET_ROUTES = ("/health",)
DEBUG_ROUTES = ("/api/debug/state", "/api/debug/roll")
ALL_ROUTES = POST_ROUTES + GET_ROUTES + DEBUG_ROUTES
STATE_KEYS = (
    "points", "bar", "off", "turn", "phase", "dice", "remainingDice",
    "cube", "difficulty", "score", "winner", "winType", "pointsWon",
    "doubleOfferedBy", "message", "turnOver", "gamesPlayed", "pip",
    "legalMoves", "canDouble",
)


def _bullet(marker: str) -> str:
    """The constraints bullet that opens with ``- {marker}`` — parsed from
    _CONSTRAINTS, the delivered bytes, not a second read of the file."""
    for line in _CONSTRAINTS.splitlines():
        if line.startswith(f"- {marker}"):
            return line
    raise AssertionError(
        f"the constraints block has no '- {marker}' bullet — it changed shape "
        "and this guard would otherwise parse nothing and pass"
    )


def _parsed_testids() -> tuple[list[str], list[str]]:
    """(static, dynamic) tag names from the testid bullet, whose shape is
    ``… tags: <static, comma-separated>; and on the dynamic elements <dynamic>``."""
    static_part, sep, dynamic_part = _bullet("the data-testid tags:").partition(
        "dynamic elements"
    )
    assert sep, "the testid bullet lost its 'dynamic elements' clause"
    tags = static_part.split(":", 1)[1].split(";", 1)[0]
    static = [t.strip() for t in tags.split(",") if t.strip()]
    dynamic = [t.strip() for t in dynamic_part.split(",") if t.strip()]
    return static, dynamic


def _parsed_routes() -> list[str]:
    """Every `/api/…` and `/health` path in the routes bullet."""
    return re.findall(r"(?:/api/[\w/]+|/health)", _bullet("the routes:"))


def _parsed_state_keys() -> list[str]:
    """The comma-separated tokens after 'returns:' in the fields bullet."""
    fields = _bullet("the fields every response returns:").split("returns:", 1)[1]
    return [t.strip() for t in fields.split(",") if t.strip()]


def test_every_name_in_the_block_is_in_the_build_steps() -> None:
    """DIRECTION 1: constraints.md → build steps. Every data-testid name,
    route path and state-key token the block names must appear in the chunk
    that owns it. This catches a typo or an extra name in the block: the
    model would be told to preserve something the spec never asked for."""
    chunk03 = CHUNK_03.read_text(encoding="utf-8")
    chunk04 = CHUNK_04.read_text(encoding="utf-8")
    static, dynamic = _parsed_testids()
    routes = _parsed_routes()
    keys = _parsed_state_keys()
    assert static and dynamic and routes and keys, (
        "a parse came back empty — the direction-1 guard would pass on nothing"
    )

    absent = [t for t in static + dynamic if t not in chunk04]
    assert not absent, (
        f"data-testid tags named in constraints.md but absent from chunk-04.md: {absent}"
    )
    absent = [r for r in routes if r not in chunk03]
    assert not absent, f"routes named in constraints.md but absent from chunk-03.md: {absent}"
    absent = [k for k in keys if k not in chunk03]
    assert not absent, (
        f"state keys named in constraints.md but absent from chunk-03.md: {absent}"
    )


def test_every_required_name_reaches_the_block() -> None:
    """DIRECTION 2: build steps → constraints.md. Every name the build steps
    require must be present in the block — an omitted name is a silent rename
    waiting to happen: the model stays free to remove something the checking
    depends on. Presence is asserted as a parsed TOKEN of the right bullet,
    not a raw substring, so a short name ("bar", "off", "dice") cannot pass
    by happening to appear somewhere else in the block."""
    static, dynamic = _parsed_testids()
    routes = _parsed_routes()
    keys = _parsed_state_keys()

    absent = [t for t in STATIC_TESTIDS if t not in static]
    assert not absent, f"static data-testid tags missing from the constraints block: {absent}"
    absent = [t for t in DYNAMIC_TESTIDS if t not in dynamic]
    assert not absent, f"dynamic data-testid tags missing from the constraints block: {absent}"
    absent = [r for r in ALL_ROUTES if r not in routes]
    assert not absent, f"routes missing from the constraints block: {absent}"
    absent = [k for k in STATE_KEYS if k not in keys]
    assert not absent, f"state keys missing from the constraints block: {absent}"


def test_the_authoritative_sets_stay_pinned_to_the_build_steps() -> None:
    """The other half of direction 2: each authoritative name must also be
    present in the chunk file that owns it. If a build step changes under the
    sets above, this fails instead of the sets silently guarding a surface the
    build no longer asks for."""
    chunk03 = CHUNK_03.read_text(encoding="utf-8")
    chunk04 = CHUNK_04.read_text(encoding="utf-8")

    absent = [t for t in STATIC_TESTIDS + DYNAMIC_TESTIDS if t not in chunk04]
    assert not absent, f"authoritative data-testid tags absent from chunk-04.md: {absent}"
    absent = [r for r in ALL_ROUTES if r not in chunk03]
    assert not absent, f"authoritative routes absent from chunk-03.md: {absent}"
    absent = [k for k in STATE_KEYS if k not in chunk03]
    assert not absent, f"authoritative state keys absent from chunk-03.md: {absent}"


# ── GROUP 3 — GRADER-VOCABULARY GUARD ───────────────────────────────────────
#
# The same forbidden terms the existing voice guards use
# (tests/test_challenge_feedback_overrides.py::_GRADER_VOCABULARY). The block
# is model-facing text like every other line the repair message carries: a
# model that can tell it is being measured is not the model this run is
# measuring. "data-testid" and "DEBUG_API" are deliberately NOT forbidden —
# they are the model's own interface vocabulary, named in the build steps it
# built against, and naming them back is the whole point of the block.

_GRADER_VOCABULARY = (
    "conformance",
    "pre-gate",
    "gate",
    "harness",
    "benchmark",
    "grader",
    "test suite",
    "assertion",
    "expected value",
    "pass/fail",
)


def test_the_block_is_not_the_graders_vocabulary() -> None:
    lowered = _CONSTRAINTS.lower()
    for word in _GRADER_VOCABULARY:
        assert word not in lowered, (
            f"the constraints block says {word!r} — that is the harness's "
            "vocabulary, not a customer's, and it tells the model it is being "
            "measured"
        )


def test_the_block_names_no_requirement_id() -> None:
    assert "REQ-" not in _CONSTRAINTS, (
        "the constraints block names a requirement id — that is the grader "
        "talking, the same tell the failure-line guards reject"
    )
