"""Evaluation-vocabulary guard — the single source of truth for the TELLS.

Nothing the model can read may reveal that it is being measured. A model that
knows it is in an evaluation is not the model whose behaviour the run is trying
to measure.

This module exists because that rule now has to hold at RUNTIME as well as in
the tree. ``tests/test_blinding.py`` scans the files this repo ships — the
scaffold, the prompts, the seeded AGENTS.md — and a static scan is enough for
anything committed here. It is NOT enough for the auxiliary directive a plugged-
in memory layer supplies at seed time (``BENCH_AGENTS_AUX_FILE``): that text is
written by somebody else, arrives after the tests have run, and lands in the one
file the model reads for the whole session. Scanning it needs the same pattern
the tests use, so the pattern lives here and both sides import it.

Keeping two copies would be worse than having no runtime check at all: a TELL
added to the test list but not the runtime one reads as protection that isn't
there.
"""

from __future__ import annotations

import re

# Words that only appear when someone is being tested. Matched case-insensitively
# on word boundaries so ordinary English ("evaluate" the board, a bear-off
# "gate") is not swept up.
#
# Note on ``\bokp\b``: ``_`` is a word character, so this matches the prose "the
# okp tool" but NOT an identifier like ``okp_submit_mark``. That is deliberate —
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
