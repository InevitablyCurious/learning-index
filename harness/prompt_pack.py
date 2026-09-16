"""Every word the model reads, loaded from the challenge's own prompts folder.

WHY THIS EXISTS. The build steps always lived in `task/<challenge>/prompts/`,
but the rest of the model-facing text did not: the standing notes, the wrapper
around every repair message and the four interruption messages were string
literals inside the adapter. So the text a challenge author has to write was
split between a folder they own and a Python module they should never have to
touch, and "what does the model actually read?" had no single answer.

All of it now lives in the folder. This module is the one reader.

FAIL LOUD, NEVER SUBSTITUTE. A missing or empty file raises. A challenge whose
notes silently resolved to "" would run, produce a number, and look exactly like
a challenge whose notes said something — the class of failure this benchmark
refuses everywhere else.

ONE NUMBER, ONE PLACE. The write-size limit appears in the notes, the build
steps and the cut-off nudge. The nudge files carry `{write_limit}` rather than
the sentence, so the limit has a single source and cannot drift between voices.
"""

from __future__ import annotations

import os
from pathlib import Path

#: Points at a challenge directory (the one holding `prompts/`, `scaffold/`,
#: `golden/`). Unset means this repo's own backgammon challenge.
TASK_DIR_ENV = "BENCH_TASK_DIR"

_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_TASK_DIR = _REPO_ROOT / "task" / "backgammon"


class MissingPromptError(RuntimeError):
    """A prompt file the run needs is absent or empty."""


class PromptPack:
    """The text of one challenge, read from its prompts directory."""

    def __init__(self, prompts_dir: Path | str) -> None:
        self.dir = Path(prompts_dir).expanduser().resolve()

    def text(self, relative: str) -> str:
        """One prompt file, trailing newlines stripped. Raises when unusable."""
        path = self.dir / relative
        try:
            body = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise MissingPromptError(
                f"{path} could not be read ({exc}). Every word the model reads "
                "comes from the challenge's prompts directory; a run with a "
                "missing prompt would measure a different task than it reports."
            ) from exc
        stripped = body.rstrip("\n")
        if not stripped.strip():
            raise MissingPromptError(
                f"{path} is empty. Delete the file or write the text — an empty "
                "prompt is indistinguishable from one nobody wrote."
            )
        return stripped

    def nudge(self, relative: str) -> str:
        """An interruption message, with `{write_limit}` resolved."""
        return self.text(relative).replace(
            "{write_limit}", self.text("nudges/write-limit.md")
        )

    def chunks(self) -> list[str]:
        """The build steps, in filename order. At least one, or it raises."""
        paths = sorted(self.dir.glob("chunk-*.md"))
        if not paths:
            raise MissingPromptError(
                f"no chunk-*.md build steps in {self.dir} — a challenge with no "
                "build steps has nothing to ask the model to do"
            )
        return [self.text(p.name) + "\n" for p in paths]


def default_task_dir() -> Path:
    """The challenge directory this process runs: `$BENCH_TASK_DIR`, else backgammon."""
    declared = (os.environ.get(TASK_DIR_ENV) or "").strip()
    return Path(declared).expanduser().resolve() if declared else _DEFAULT_TASK_DIR


def default_pack() -> PromptPack:
    return PromptPack(default_task_dir() / "prompts")
