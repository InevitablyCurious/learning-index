"""The instruction surface must not contradict the code that grades it.

WHY THIS EXISTS (2026-08-26). A 193-line producer prompt was appended to chunk
1 telling the worker the debug seam was gated by `BENCH_DEBUG`. Every source
that actually EXECUTES — CONTRACT.md, the chunk prompts, the golden reference,
the scaffold, and the gate harness that launches the server — says `DEBUG_API`.

A worker that obeyed the instruction renamed the seam and then failed every
gate that scripts dice: the conformance pregate, three backend gate files, and
the whole Playwright suite. It was penalised for following its instructions,
which is a measurement error, not a capability signal.

The contradiction survived because the appended text was never covered by
`chunk_plan_hash` (which hashes only `task/backgammon/prompts/`), so drift
detection could not see it. These tests are the replacement for that blind
spot: they read the real files and fail if the names diverge again.
"""

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
TASK = REPO / "task" / "backgammon"

# The one true name. It is what the gate harness exports when it spawns the
# server, so it is the only name that can possibly work.
DEBUG_ENV = "DEBUG_API"
WRONG = "BENCH_DEBUG"

# Files the model reads, and files the grader runs. Both must agree.
SOURCES = [
    TASK / "prompts" / "chunk-04.md",
    
    TASK / "scaffold" / "src" / "server.ts",
    TASK / "golden" / "src" / "server.ts",
    REPO / "grader" / "lib" / "harness.ts",
    REPO / "grader" / "playwright.config.ts",
]


@pytest.mark.parametrize("path", SOURCES, ids=lambda p: str(p.name))
def test_debug_seam_env_var_name_is_never_contradicted(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    assert WRONG not in text, (
        f"{path} names the debug seam {WRONG}; the gate harness exports "
        f"{DEBUG_ENV} when it launches the server, so a worker that obeys this "
        "loses every gate that scripts dice"
    )


def test_the_gate_harness_is_the_authority_and_exports_debug_api() -> None:
    """If this ever changes, the constant above changes with it — not the prompts."""
    harness = (REPO / "grader" / "lib" / "harness.ts").read_text(encoding="utf-8")
    assert f"{DEBUG_ENV}:" in harness


def test_no_chunk_prompt_asks_the_worker_for_discovery_capture() -> None:
    """Extraction is measured by the plugin substrate, not narrated by the
    model under test. Nothing in the chunk plan may ask for it."""
    for path in sorted((TASK / "prompts").glob("chunk-*.md")):
        text = path.read_text(encoding="utf-8")
        for token in (
            "candidate_memory_text",
            "CAPTURE & COMPLIANCE",
        ):
            assert token not in text, f"{path} asks the worker to produce {token}"


def test_the_orphaned_sxe_candidate_pair_stays_deleted() -> None:
    """Deleted 2026-08-26. Extraction belongs outside the benchmark; the
    canonical strategy body lives in okp-mcp/prompts/memory-extraction/."""
    assert not (TASK.parents[1] / "scaffold" / "sxe-candidate").exists()


# ─────────────────────────────────────────────────────────────────────────────
# THE SPEC MUST PUBLISH EVERY FUNCTION THE GATES GRADE (2026-08-30).
#
# WHY THIS EXISTS. Gate E08 (`REQ-SEQ-DEDUP`) called `game.allSequences(...)`
# and asserted that full-turn sequences are deduplicated by RESULTING BOARD.
# That function appeared in NO prompt and in NO section of CONTRACT.md — it
# existed only as an unexplained stub in the scaffold and as a working
# implementation in the golden. The dedup semantics were written down nowhere.
#
# Observed consequence, deepseek-chat run 1788099503: the model implemented
# `allSequences` returning one entry per move-PATH (4) instead of per resulting
# BOARD (2), failed E08 on attempt 1, and then passed it on attempt 2 — because
# the repair-loop feedback line ("full-turn sequences are distinct by RESULTING
# BOARD") stated the unpublished rule outright. The gate therefore measured
# whether the model got a second attempt, not whether it could build the thing.
#
# The build prompts are the only specification the model is given. This test is
# what keeps them sufficient: any function a gate invokes on the candidate's
# modules must be published in those prompts.
#
# NOTE the deliberate narrowness. This asserts the SURFACE is published, not
# that every assertion is published. Publishing rules is the spec's job;
# publishing assertions would hand over the answer key.
# ─────────────────────────────────────────────────────────────────────────────

GATES = REPO / "grader"

# Directories holding tests that grade the CANDIDATE. `meta/` is excluded on
# purpose: those files test the grader itself and reach the golden, never the
# target (see grader/meta/README.md).
_GRADED_GATE_DIRS = ["backend", "conformance", "frontend", "lib"]

# `loadEngine()` hands the gates the candidate's two modules under these names.
_CANDIDATE_MODULE_BINDINGS = ("game", "ai")


def _functions_the_gates_call() -> set[str]:
    """Every `game.fn(` / `ai.fn(` call across the graded gate files."""
    pattern = re.compile(
        r"\b(?:"
        + "|".join(_CANDIDATE_MODULE_BINDINGS)
        + r")\.([a-zA-Z_][a-zA-Z0-9_]*)\("
    )
    found: set[str] = set()
    for directory in _GRADED_GATE_DIRS:
        root = GATES / directory
        if not root.is_dir():
            continue
        for path in root.rglob("*.ts"):
            found.update(pattern.findall(path.read_text(encoding="utf-8")))
    return found


def test_every_graded_function_is_published_in_the_contract() -> None:
    # The published surface is the six build prompts: CONTRACT.md moved out of
    # the scaffold on 2026-09-15 and is no longer seeded into the work folder.
    contract = "\n".join(
        p.read_text(encoding="utf-8") for p in sorted((TASK / "prompts").glob("chunk-*.md"))
    )
    called = _functions_the_gates_call()
    assert called, (
        "found no candidate-module calls in the gate files — the scan is broken"
    )

    unpublished = sorted(
        fn for fn in called if f"export function {fn}(" not in contract
    )
    assert not unpublished, (
        "these functions are graded but never published in the build prompts: "
        f"{unpublished}. A gate that calls a function the spec does not declare "
        "cannot be passed by reading the spec — it can only be passed after the "
        "repair loop names it, which measures attempt count, not capability. "
        "Either publish the function surface or delete the gate."
    )


def test_every_graded_function_is_published_in_the_chunk_prompts() -> None:
    """The chunk prompts call their function list EXACT. It must therefore be
    complete, or a model that trusts the prompt deletes a graded stub."""
    prompts = "\n".join(
        p.read_text(encoding="utf-8")
        for p in sorted((TASK / "prompts").glob("chunk-*.md"))
    )
    called = _functions_the_gates_call()

    missing = sorted(fn for fn in called if f"export function {fn}(" not in prompts)
    assert not missing, (
        "these functions are graded but absent from the chunk prompts' declared "
        f"function surface: {missing}. chunk-02/chunk-03 present that list as "
        "EXACT, so a model following the prompt is entitled to conclude the "
        "function should not exist."
    )
