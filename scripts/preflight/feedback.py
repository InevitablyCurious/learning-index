"""Feedback-override completeness — the launch half of the single-system
feedback voice guarantee (the CI half is test_every_gate_token_has_an_override)."""

from __future__ import annotations

import sys

from preflight.core import REPO, Check


def check_feedback_completeness(c: Check) -> None:
    """BLOCKING: every graded gate must have a human-written feedback override.

    WO-FEEDBACK-VOICE-3 (2026-08-30): the feedback voice is SINGLE-SYSTEM. There
    is NO title-derived fallback — `_humanize_check` raises
    `MissingFeedbackOverrideError` for a gate with no entry in
    `grader/feedback.json`, because the title-derived sentence
    (a test title) states the RULE and answers the gate's question for free.

    A missing override is therefore a misconfigured benchmark, not a graceful
    degradation. This check refuses to let a run start until every gate is
    covered. It is the launch half of the guarantee; the CI half is
    `test_every_gate_token_has_an_override`.
    """
    try:
        sys.path.insert(0, str(REPO))
        from harness.adapters.challenge import missing_feedback_overrides
    except Exception as exc:  # noqa: BLE001
        c.add("feedback completeness", False, f"could not import harness: {exc}")
        return

    gates_dir = REPO / "grader"
    try:
        missing = sorted(missing_feedback_overrides(gates_dir))
    except Exception as exc:  # noqa: BLE001
        c.add(
            "feedback completeness",
            False,
            f"could not enumerate feedback overrides: {exc}",
        )
        return

    if not missing:
        c.add(
            "feedback completeness",
            True,
            "every graded gate has a human-written feedback override",
        )
        return

    shown = ", ".join(missing[:10])
    extra = f" (+{len(missing) - 10} more)" if len(missing) > 10 else ""
    c.add(
        "feedback completeness",
        False,
        f"NO-GO: {len(missing)} gate(s) lack a feedback override: "
        f"{shown}{extra}. Write a symptom sentence for each in "
        "grader/feedback.json before launching.",
    )
