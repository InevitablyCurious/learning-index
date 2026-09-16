"""Frozen task-template hash + fail-closed freeze guard.

Split out of ``scripts/run_cumulative.py`` (LI-14).
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from .paths import REPO_ROOT

# FROZEN_TASK_TEMPLATE_HASH — WO-FREEZE-1 template freeze.
#
# SHA-256 over the live `task/backgammon/scaffold/` directory using the EXACT
# algorithm `compute_task_template_hash` applies at runtime (sorted relative
# path + raw bytes per file). Frozen at WO-FREEZE-1 (2026-08-06). Any change to
# the scaffold invalidates the hash and therefore every previously scored cell
# that ran against the old bytes — the run path fails closed until the freeze is
# re-baselined deliberately.
# Re-baselined 2026-08-10 (Walter, WO-FEEDBACK-CONTRACT): CONTRACT.md moved into
# the scaffold so the published requirements seed every worker worktree.
# RE-FROZEN 2026-08-24 (blinding pass). The scaffold was rewritten so nothing the
# model can read reveals that it is being measured: CONTRACT.md is now an ordinary
# specification rather than a document about "the hidden gate suite", the package
# is named `backgammon` rather than `benchmark-backgammon` (it printed on every
# npm command), and the debug env var is DEBUG_API rather than BENCH_DEBUG.
# Requirements are unchanged in substance — only the framing around them.
#
# Prior hash: 1ed04db22f0c3bcc27e457f71b0c818a21c46d60dc6489bd8d46d183c21dbc8a
# Re-frozen 2026-08-30 by WO-39 ease-of-use calibration: style.css cut to placeholder,
# package.json start + CONTRACT.md Node clause now use --experimental-strip-types.
# Prior hash: 9391d77d0a4f6ba6d92f769aceb31a5e4c30807d426f4a8ecb13cb88c83936b6
# RE-FROZEN 2026-08-30 (spec-completeness pass). CONTRACT.md now publishes
# `allSequences` and REQ-SEQ-DEDUP. Gate E08 graded that function and that rule
# while NO prompt and no section of CONTRACT.md declared either — the model met
# it first as an unexplained scaffold stub. On run 1788099503 the model failed
# E08 on attempt 1 and passed on attempt 2, having been told the rule by the
# repair-loop message. A gate answered by its own failure text measures attempt
# count, not capability. Requirements are unchanged in substance: the golden
# already behaved this way and the gate already asserted it — only the spec was
# silent. Guarded going forward by
# tests/test_instruction_surface_consistency.py::
#   test_every_graded_function_is_published_in_the_contract
# Prior hash: d2d2f0b798f586101bb34a698235eb1dea691b1ed760f66a316a53fd6ae42928
# RE-FROZEN 2026-09-07 (frontend origin seam). CONTRACT.md now publishes
# REQ-SAME-ORIGIN — the page must call the API with root-relative paths — and
# states the server must be reachable at BOTH `localhost:8002` and
# `127.0.0.1:8002`. Nothing in the corpus had ever said which origin the
# frontend should target, while chunk-01 mandated a loopback bind in the
# server; a model that carried `127.0.0.1` into its fetch base produced a page
# the grader (which loads `localhost`) could not use at all — every call became
# a cross-origin request the server never allowed. Measured on run 1788804359:
# 95/117 with the absolute base, 107/117 with one character changed, and the
# SAME model on run 1788777140 wrote a relative base and scored 112 with a live
# repair curve. A 17-gate swing on an unpublished, ungraded coin flip. The
# golden was never exposed to it — it has always used relative paths — so the
# control could not catch it. Requirements are unchanged in substance for the
# golden; the corpus now states what the golden always did. Graded going
# forward by gate F15 (REQ-SAME-ORIGIN), which loads the app at both host
# names. The unmeasurable loopback-bind mandate was dropped from chunk-01: the
# golden itself binds every interface, so no gate could ever have asserted it.
# Re-frozen 2026-09-10 (WO-PORT-ASSIGNABLE): `src/server.ts` now reads
# `Number(process.env.PORT ?? 8002)` instead of a literal 8002. The default is
# unchanged, so a grading run binds 8002 exactly as before and stays comparable
# with every run taken against the previous freeze. What it buys is that the
# built artifact can be run a SECOND time, on another port, without colliding
# with a grading pass — which is what makes a candidate playable from the board
# at all. The port line was already shipped in the scaffold as working code, so
# the model inherits the behaviour and this widens the required surface by one
# published clause, not by any new work.
# RE-FROZEN 2026-09-15 (spec out of the scaffold). CONTRACT.md moved to
# task/backgammon/reference/: the model is given the six build prompts and
# nothing else, so the spec file is no longer copied into its work folder.
# Prior: e1628129a751556e43cd5e700b3ebcec969af14f9797ded5cf77cd5f0dd94f29
#        (2026-09-10, WO-CONTRACT-CHUNK-12)
# Re-frozen 2026-09-10 (WO-CONTRACT-CHUNK-12): three DERIVABLE facts were cut
# from the published surface — REQ-INIT's literal 26-element opening array,
# REQ-PIP's "167 each at the opening", and REQ-WINCLASS's single/gammon/
# backgammon boundary. The board CONVENTION stays (which end is white's home,
# the points[p] sign rule, array length): no model could guess it and the gates
# assert it literally. What went is what follows from that convention plus
# knowing backgammon — i.e. the part that was capability being handed over as
# transcription. Gates at risk: G01, G02, G10 (and only those). Each already
# carried a human symptom line that could never fire while the answer was in
# the prompt.
FROZEN_TASK_TEMPLATE_HASH = (
    "d7088d77051f58ad71e8b8201058a6733a35c964f0e2b5da6d2ff0f8491481ee"
)


def compute_task_template_hash(scaffold: Path) -> str | None:
    """Stable SHA-256 over task scaffold files (sorted relative paths + bytes).

    Pure function: no instance state, no model endpoints. Returns the hexdigest
    over the concatenation of each file's utf-8-encoded relative path (sorted by
    ``str(path)``) followed by its raw bytes. Returns ``None`` when the scaffold
    directory is unavailable (mirrors the instance method's best-effort
    contract) and never raises for missing/unreadable files.
    """
    if scaffold is None or not scaffold.is_dir():
        return None
    digest = hashlib.sha256()
    files = sorted(
        (p for p in scaffold.rglob("*") if p.is_file()), key=lambda p: str(p)
    )
    for path in files:
        try:
            rel = str(path.relative_to(scaffold))
            digest.update(rel.encode("utf-8"))
            digest.update(path.read_bytes())
        except OSError:
            continue
    return digest.hexdigest()


def verify_task_template_frozen() -> None:
    """Fail-closed template-freeze guard for the benchmark run path.

    Computes the live scaffold hash (via ``compute_task_template_hash`` over
    ``task/backgammon/scaffold``) and raises a RuntimeError naming BOTH the
    expected (frozen) and actual (live) hashes plus the scaffold path whenever
    they differ OR the live hash cannot be computed. Purposely touches no model
    endpoint/proxy. Must be called before any scaffold copy or cell scoring.
    """
    repo_root = REPO_ROOT
    scaffold = repo_root / "task" / "backgammon" / "scaffold"
    live_hash = compute_task_template_hash(scaffold)
    if live_hash is None:
        raise RuntimeError(
            "task template freeze FAILED: scaffold unavailable at "
            f"{scaffold}; expected frozen hash {FROZEN_TASK_TEMPLATE_HASH}, "
            "could not compute live hash"
        )
    if live_hash != FROZEN_TASK_TEMPLATE_HASH:
        raise RuntimeError(
            "task template freeze FAILED: scaffold mismatch at "
            f"{scaffold}; expected (frozen) {FROZEN_TASK_TEMPLATE_HASH}, "
            f"actual (live) {live_hash}"
        )
