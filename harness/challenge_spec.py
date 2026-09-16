"""What a challenge declares about itself.

WHY THIS EXISTS. The adapter knew the example by heart: the grading suite lived
at a fixed path, the phases were the literal tuple ("backend", "conformance",
"frontend"), the app answered on 8002, the unimplemented-stub marker was a
TypeScript `throw`, and the need card said "backgammon" in prose. None of that
is the benchmark's business — it is what one challenge happens to be — so a
second challenge could not be run without editing the harness.

A challenge now states those facts in `challenge.json` beside its prompts, and
this is the one reader.

FAIL LOUD, NEVER ASSUME. A missing file, a missing key or a key of the wrong
shape raises and names what is wrong. The alternative — defaulting to the
example's values — would run someone else's challenge as if it were backgammon
and report a number for it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from harness.prompt_pack import default_task_dir

MANIFEST_NAME = "challenge.json"


class ChallengeSpecError(RuntimeError):
    """The challenge's manifest is missing, unreadable or incomplete."""


@dataclass(frozen=True)
class ChallengeSpec:
    """One challenge's declared facts. Paths are resolved absolute."""

    dir: Path
    name: str
    run_label: str
    summary: str
    language: str
    stack: tuple[str, ...]
    app_port: int
    grader_dir: Path
    grader_phases: tuple[str, ...]
    test_commands: tuple[str, ...]
    stub_sentinel: str
    chunk_stub_files: dict[int, str]
    #: SHA-256 of the starting files, frozen so two runs of this challenge are
    #: comparable. None until the author freezes it (scripts/freeze_challenge.py).
    scaffold_hash: str | None

    @property
    def prompts_dir(self) -> Path:
        return self.dir / "prompts"

    @property
    def scaffold_dir(self) -> Path:
        return self.dir / "scaffold"

    @property
    def golden_dir(self) -> Path:
        return self.dir / "golden"


def _require(raw: dict[str, Any], key: str, kind: type, where: Path) -> Any:
    if key not in raw:
        raise ChallengeSpecError(
            f"{where} does not declare {key!r}. Every challenge states its own "
            "facts; the benchmark will not borrow the example's."
        )
    value = raw[key]
    if not isinstance(value, kind) or (kind is str and not value.strip()):
        raise ChallengeSpecError(
            f"{where}: {key!r} must be a non-empty {kind.__name__}, got {value!r}"
        )
    return value


def load(task_dir: Path | str) -> ChallengeSpec:
    """Read one challenge's manifest. Raises on anything it cannot honour."""
    root = Path(task_dir).expanduser().resolve()
    path = root / MANIFEST_NAME
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ChallengeSpecError(
            f"{path} could not be read ({exc}). A challenge directory without a "
            f"{MANIFEST_NAME} cannot be run: the benchmark would have to guess "
            "its grading suite, its phases and its port."
        ) from exc
    except ValueError as exc:
        raise ChallengeSpecError(f"{path} is not valid JSON ({exc})") from exc
    if not isinstance(raw, dict):
        raise ChallengeSpecError(f"{path} must hold a JSON object")

    grader_declared = _require(raw, "grader_dir", str, path)
    grader_dir = (root / grader_declared).resolve()
    if not grader_dir.is_dir():
        raise ChallengeSpecError(
            f"{path}: grader_dir {grader_declared!r} resolves to {grader_dir}, "
            "which is not a directory — nothing would grade this challenge."
        )

    stubs_raw = raw.get("chunk_stub_files", {})
    if not isinstance(stubs_raw, dict):
        raise ChallengeSpecError(f"{path}: chunk_stub_files must be an object")
    try:
        chunk_stub_files = {int(k): str(v) for k, v in stubs_raw.items()}
    except (TypeError, ValueError) as exc:
        raise ChallengeSpecError(
            f"{path}: chunk_stub_files keys are build-step numbers ({exc})"
        ) from exc

    def _tuple(key: str, *, required: bool = True) -> tuple[str, ...]:
        if required:
            value = _require(raw, key, list, path)
        else:
            value = raw.get(key, [])
            if not isinstance(value, list):
                raise ChallengeSpecError(f"{path}: {key!r} must be a list")
        return tuple(str(v) for v in value)

    return ChallengeSpec(
        dir=root,
        name=_require(raw, "name", str, path),
        run_label=_require(raw, "run_label", str, path),
        summary=_require(raw, "summary", str, path),
        language=_require(raw, "language", str, path),
        stack=_tuple("stack"),
        app_port=int(_require(raw, "app_port", int, path)),
        grader_dir=grader_dir,
        grader_phases=_tuple("grader_phases"),
        test_commands=_tuple("test_commands", required=False),
        stub_sentinel=str(raw.get("stub_sentinel", "")),
        chunk_stub_files=chunk_stub_files,
        scaffold_hash=(str(raw["scaffold_hash"]) if raw.get("scaffold_hash") else None),
    )


def default_spec() -> ChallengeSpec:
    """The challenge this process runs: `$BENCH_TASK_DIR`, else the example."""
    return load(default_task_dir())
