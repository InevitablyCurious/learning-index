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

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

#: Points at a challenge directory (the one holding `prompts/`, `scaffold/`,
#: `golden/`). Unset means this repo's own backgammon challenge.
TASK_DIR_ENV = "BENCH_TASK_DIR"

_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_TASK_DIR = _REPO_ROOT / "task" / "backgammon"

#: The machine-readable build-phase declaration, beside the chunk texts. This is
#: the single source of truth for phase order, names and grader layers; the
#: chunk filenames stay the storage keys but nothing reads order off them.
#: `chunk_plan_hash` hashes the whole prompts dir, so it covers this file too.
_PHASE_DECLARATION = "phase-plan.json"

#: The approved build-step header (owner wording, verbatim). `{K}` appears twice
#: and `{name}` once; both are filled per phase. The "7" matches the declaration
#: and is asserted at load — change both together.
#:
#: THE SPEC SO FAR, NEVER AHEAD (Jerry, 2026-11-13). Phase K's message carries
#: phases 1..K only. It used to carry all seven "for reference", and the last
#: words the model read were phase 7's "Play it for real … Fix every defect you
#: find": fresh runs 1794311852 and 1794585511 both wrote the AI, the server,
#: the page and its styling during phase 1, so the phases measured nothing.
_BUILD_HEADER = (
    "This build has 7 phases. You are in phase {K}: {name}. The build spec so "
    "far follows, ending with this phase. Build only what phase {K} asks for — "
    "don't build anything from an earlier or later phase now. Earlier phases "
    "are done and must keep working."
)


class MissingPromptError(RuntimeError):
    """A prompt file the run needs is absent or empty."""


@dataclass(frozen=True)
class Phase:
    """One build phase, as declared in the prompt pack.

    ``index`` is the 1-based position K the header prints; ``name`` is what the
    header and every record label the phase with; ``layer`` is the grader layer
    (``None`` for the backend phases, 1..3 for the frontend); ``file`` is the
    chunk file within the prompts dir; ``text`` is its verbatim body;
    ``work`` is what the phase is doing, in a player's words ("putting the
    pieces on the board"), said when this phase breaks an earlier one — None
    for a phase that never follows a graded one.
    """

    index: int
    name: str
    layer: int | None
    file: str
    text: str
    work: str | None = None


def phase_label(phase: Phase, kind: str) -> dict[str, Any]:
    """The single serialization of a phase's identity onto every record.

    One phase is one thing: K, the name the author gave it, and whether the
    grader tests it as a build step (``"build"``) or a repair round
    (``"troubleshooting"``). Every record that names a phase — the live
    ``phase.start`` and ``heartbeat``, and the attempt, gate and pause records
    built on top of them — carries exactly these keys, from this function, so a
    reader never has to learn a second spelling and no two records can disagree.

    ``phase_layer`` is OMITTED, not ``None``, for a backend phase: the live
    stream drops ``None`` fields, and the cost reduction reads "absent" as
    "never zero". A key that is sometimes ``None`` and sometimes ``1`` would make
    those two cases indistinguishable on the wire.
    """
    label = {"phase_index": phase.index, "phase_name": phase.name, "phase_kind": kind}
    if phase.layer is not None:
        label["phase_layer"] = phase.layer
    return label


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
        """The build steps, in filename order. At least one, or it raises.

        This is the generic, filename-order primitive for a challenge without a
        phase declaration (the TEMPLATE skeleton). For the backgammon challenge
        the authoritative order is `phases()`, driven by the declaration.
        """
        paths = sorted(self.dir.glob("chunk-*.md"))
        if not paths:
            raise MissingPromptError(
                f"no chunk-*.md build steps in {self.dir} — a challenge with no "
                "build steps has nothing to ask the model to do"
            )
        return [self.text(p.name) + "\n" for p in paths]

    def phases(self) -> list[Phase]:
        """The ordered build phases, from the declaration (single source of truth).

        Reads `phase-plan.json` beside the chunk texts. Fails loudly — never
        falls back to filename sort — when the declaration is missing, malformed,
        or disagrees with the chunk files on disk.
        """
        decl_path = self.dir / _PHASE_DECLARATION
        try:
            raw = json.loads(decl_path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise MissingPromptError(
                f"{decl_path} could not be read ({exc}). The build phase plan is "
                "data the challenge author owns; without it a run would order "
                "phases by filename accident."
            ) from exc
        except json.JSONDecodeError as exc:
            raise MissingPromptError(f"{decl_path} is not valid JSON ({exc}).") from exc

        entries = raw.get("phases")
        if not isinstance(entries, list) or not entries:
            raise MissingPromptError(
                f"{decl_path} must declare a non-empty `phases` list."
            )
        if len(entries) != 7:
            raise MissingPromptError(
                f"{decl_path} declares {len(entries)} phases; the approved "
                "header says 7. Change the declaration and the header together."
            )

        on_disk = {p.name for p in self.dir.glob("chunk-*.md")}
        declared: set[str] = set()
        phases: list[Phase] = []
        for position, entry in enumerate(entries, start=1):
            if not isinstance(entry, dict):
                raise MissingPromptError(
                    f"{decl_path}: phase {position} is not an object."
                )
            index = entry.get("index")
            name = entry.get("name")
            layer = entry.get("layer")
            file = entry.get("file")
            work = entry.get("work")
            if work is not None and (not isinstance(work, str) or not work.strip()):
                raise MissingPromptError(
                    f"{decl_path}: phase {index} has an empty `work`."
                )
            if index != position:
                raise MissingPromptError(
                    f"{decl_path}: phase at position {position} has index "
                    f"{index!r}; expected {position} (1..7 in order)."
                )
            if not isinstance(name, str) or not name.strip():
                raise MissingPromptError(
                    f"{decl_path}: phase {index} is missing a `name`."
                )
            if layer is not None and (
                not isinstance(layer, int) or not 1 <= layer <= 3
            ):
                raise MissingPromptError(
                    f"{decl_path}: phase {index} has layer {layer!r}; expected "
                    "null (backend) or 1..3."
                )
            if not isinstance(file, str) or not file.strip():
                raise MissingPromptError(
                    f"{decl_path}: phase {index} is missing a `file`."
                )
            if file in declared:
                raise MissingPromptError(
                    f"{decl_path}: `file` {file!r} declared more than once."
                )
            declared.add(file)
            phases.append(
                Phase(
                    index=index,
                    name=name,
                    layer=layer,
                    file=file,
                    text=self.text(file),
                    work=work,
                )
            )

        if declared != on_disk:
            raise MissingPromptError(
                f"{decl_path} and the chunk files disagree: declared "
                f"{sorted(declared)}, on disk {sorted(on_disk)}."
            )
        return phases

    def phase(self, k: int) -> Phase:
        """One phase by its 1-based index K. Raises on an out-of-range K."""
        plan = self.phases()
        if not 1 <= k <= len(plan):
            raise MissingPromptError(f"no phase {k}; the build has {len(plan)} phases.")
        return plan[k - 1]

    def spec_through(self, k: int) -> str:
        """Phases 1..K's chunk texts in order, each under a label naming its phase."""
        self.phase(k)  # raises on an out-of-range K
        return "\n\n".join(
            f"## Phase {p.index}: {p.name}\n\n{p.text}"
            for p in self.phases()
            if p.index <= k
        )

    def whole_spec(self) -> str:
        """Every phase's chunk text: the spec as the last phase sees it."""
        return self.spec_through(len(self.phases()))

    def build_step_message(self, k: int) -> str:
        """The composed build-step message for phase K: header + the spec so far."""
        p = self.phase(k)
        header = _BUILD_HEADER.format(K=p.index, name=p.name)
        return f"{header}\n\n{self.spec_through(k)}"


def default_task_dir() -> Path:
    """The challenge directory this process runs: `$BENCH_TASK_DIR`, else backgammon."""
    declared = (os.environ.get(TASK_DIR_ENV) or "").strip()
    return Path(declared).expanduser().resolve() if declared else _DEFAULT_TASK_DIR


def default_pack() -> PromptPack:
    return PromptPack(default_task_dir() / "prompts")
