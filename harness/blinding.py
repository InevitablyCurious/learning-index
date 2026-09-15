"""Evaluation-vocabulary guard — the single source of truth for the TELLS.

Nothing the model can read may reveal that it is being measured. A model that
knows it is in an evaluation is not the model whose behaviour the run is trying
to measure.

``tests/test_blinding.py`` scans the files this repo ships — the scaffold, the
prompts, the seeded AGENTS.md — against the pattern kept here.
"""

from __future__ import annotations

import re

# Words that only appear when someone is being tested. Matched case-insensitively
# on word boundaries so ordinary English ("evaluate" the board, a bear-off
# "gate") is not swept up.
#
# Note on ``\bokp\b``: ``_`` is a word character, so this matches the prose "the
# okp tool" but NOT an identifier like ``okp_submit``. That is deliberate —
# a memory layer has to be able to name its own tool in a directive, and a bare
# identifier reads as a tool name rather than as a statement about the run.
TELLS = [
    r"benchmark",
    r"\bbench\b",
    r"gate suite",
    r"hidden gate",
    r"hidden test",
    r"answer sheet",
    r"\bgrader\b",
    r"\bharness\b",
    r"\boracle\b",
    r"do not cheat",
    r"\bcheat\b",
    r"gates on\b",
    r"gated against",
    r"\bokp\b",
]

TELL_RE = re.compile("|".join(TELLS), re.IGNORECASE)


def offending_lines(text: str) -> list[str]:
    """Every line of ``text`` carrying evaluation vocabulary, as ``"<n>: <line>"``."""
    return [
        f"{n}: {line.strip()}"
        for n, line in enumerate(text.splitlines(), start=1)
        if TELL_RE.search(line)
    ]
