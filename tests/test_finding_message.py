"""Markers are read from a finding's own message, never from the code frame around it.

Run 1795065106 round 2: G05's finding "the game played the smaller number" carries no
aspect, but Playwright's code frame printed the NEXT assertion's source — with its
"[aspect: offered]" — and the line was chosen from that.
"""

from harness.adapters.challenge.runner import ChallengeRunner
from harness.adapters.challenge.stages import finding_message, is_untold, needs_of

PLAYWRIGHT = (
    "Error: the game played the smaller number\n\n"
    "expect(received).toBe(expected) // Object.is equality\n\n"
    "Expected: false\nReceived: true\n\n"
    "  1436 |         () => false,\n"
    "  1437 |       );\n"
    '> 1438 |     expect(played, "the game played the smaller number").toBe(false);\n'
    "       |                                                          ^\n"
    "  1439 |   }\n"
    '  1440 |   expect(smaller === undefined, "[aspect: offered] [needs: F03] [untold] the game showed a hint").toBe(true);'
)

VITEST = (
    "AssertionError: [needs: F45]: expected +0 to be 25 // Object.is equality\n"
    '    at /gates/backend/edge/edge-gates.test.ts:172:55 — "[aspect: other] [untold]"'
)


def test_the_message_stops_before_the_code_frame() -> None:
    assert finding_message(PLAYWRIGHT) == "Error: the game played the smaller number"


def test_a_marker_in_the_code_frame_is_not_the_findings() -> None:
    record = {"check": "[G05] REQ-HIGHER-DIE — use higher die", "observed": PLAYWRIGHT}
    assert ChallengeRunner._complaint_aspect(record) is None
    assert needs_of(record) == ()
    assert not is_untold(record)


def test_a_vitest_message_stops_before_its_stack() -> None:
    record = {"check": "[E06] REQ-PIP-BAR — a checker on the bar", "observed": VITEST}
    assert needs_of(record) == ("F45",)
    assert ChallengeRunner._complaint_aspect(record) is None
    assert not is_untold(record)


def test_markers_in_the_message_still_count() -> None:
    observed = "Error: [aspect: twice] [needs: F03] one click played more than one move\n\nexpect(received)…"
    record = {"check": "[F33] REQ-DOUBLES — a double", "observed": observed}
    assert ChallengeRunner._complaint_aspect(record) == "twice"
    assert needs_of(record) == ("F03",)
