"""Turn graded gate results into recorded predicate outcomes.

Why this exists
---------------
Memory extraction reads a session transcript. A transcript shows the model
CHANGING code and saying it fixed something; it does not show whether the
acceptance gate then passed, because grading happens after the session, out
here in the bench. With no observation of the outcome available to it, the
extraction model supplies confidence instead — which is how memories come to
assert fixes for gates that never went green.

The bench already decides those outcomes honestly (``gate-results.mjs`` never
promotes ``not_run`` to a pass) and writes them to ``manifest.status.jsonl``.
Nothing downstream ever read them. This module is that missing reader: it
converts each graded gate into a record a joiner can look up, so the outcome
is retrieved rather than inferred.

Vocabulary (WHITEPAPER §9.5, Table 23)
--------------------------------------
The field is ``predicate_outcome`` and its values are ``pass``, ``fail`` and
``not_evaluated``. It is deliberately NOT called a verdict — §9.5 bans verdicts
on the wire, and this is a sensor reading, not a judgment.

``not_evaluated`` is first class. A gate that never ran, or that blew up in the
harness, produced NO observation, and that is recorded as its own thing. It is
never rounded down to ``fail`` (which would claim the code is wrong when the
harness is what broke) and never rounded up to ``pass``. Absence is recorded as
absence.

Scope
-----
Bench-local by default. These records are self-authored evidence — the bench
grading its own runs — so they are written beside the run and are NOT submitted
to the production chain, where §7.8/§8.7 discounting for self-authored outcomes
would apply. Nothing here joins an outcome to a memory; that join is a separate
step, and doing it here would quietly bake in an assumption about which claim
a gate belongs to.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable, Iterator

SCHEMA_VERSION = 1
RECORD_TYPE = "predicate_outcome"
STATE_ALG = "walk-v1"

# Bench gate status -> Table 23 vocabulary.
#
# `error` maps to not_evaluated, NOT fail: a gate that errored produced no
# observation of the code at all. Calling that a failure would assert something
# about the code that the run never established.
_STATUS_MAP = {
    "pass": "pass",
    "fail": "fail",
    "not_run": "not_evaluated",
    "error": "not_evaluated",
}


class UnknownGateStatus(ValueError):
    """A gate status the mapping does not cover.

    Raised rather than defaulted. A silent default here would be the exact
    defect this module exists to remove.
    """


def map_gate_status(status: object) -> str:
    if not isinstance(status, str) or status not in _STATUS_MAP:
        raise UnknownGateStatus(
            f"unmapped gate status {status!r}; expected one of {sorted(_STATUS_MAP)}"
        )
    return _STATUS_MAP[status]


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --- walk-v1 ---------------------------------------------------------------
#
# Byte-compatible with the TypeScript walk-v1 in
# okp-mcp/src/gstv/walk.ts, so a state hash computed here means the same
# thing as one computed by the plugin. Covered by a cross-check test that runs
# the TypeScript implementation over the same directory and compares.
#
# The rules that matter for agreement: repo-relative '/'-separated paths, byte
# sorted; symlinks never followed and never hashed; `.git` always ignored.


def walk_manifest(
    repo_root: str | os.PathLike[str],
) -> tuple[list[dict[str, str]], str]:
    """Return (files, manifest_hash) for a worktree.

    Note this implements the ``.git``-only ignore case, which is what a graded
    bench worktree needs. A worktree carrying its own ``.gitignore`` is
    rejected loudly rather than hashed under rules this does not implement —
    a quietly divergent hash is worse than a refusal.
    """
    root = Path(repo_root).resolve()
    if not root.is_dir():
        raise NotADirectoryError(f"worktree not found: {root}")

    stray_ignores = [
        p for p in root.rglob(".gitignore") if ".git" not in p.relative_to(root).parts
    ]
    if stray_ignores:
        raise NotImplementedError(
            "worktree contains .gitignore files; walk-v1 ignore rules are not "
            f"implemented in the bench emitter: {[str(p.relative_to(root)) for p in stray_ignores]}"
        )

    files: list[dict[str, str]] = []

    def visit(abs_dir: Path) -> None:
        for entry in sorted(os.scandir(abs_dir), key=lambda e: e.name.encode()):
            abs_path = Path(entry.path)
            rel = abs_path.relative_to(root).as_posix()
            if entry.is_symlink():
                continue
            if entry.is_dir(follow_symlinks=False):
                if rel == ".git" or rel.startswith(".git/"):
                    continue
                visit(abs_path)
                continue
            if not entry.is_file(follow_symlinks=False):
                continue
            if rel == ".git" or rel.startswith(".git/"):
                continue
            files.append({"path": rel, "sha256": sha256_hex(abs_path.read_bytes())})

    visit(root)
    files.sort(key=lambda f: f["path"].encode())
    return files, manifest_hash_for(files)


def manifest_hash_for(files: Iterable[dict[str, str]]) -> str:
    joined = "\n".join(f"{f['path']}\n{f['sha256']}" for f in files)
    return sha256_hex(joined.encode())


# --- predicate identity ----------------------------------------------------


def predicate_id_for(
    gate_id: str, test_file: str | None, suite_fingerprint: str
) -> str:
    """Stable identity for one acceptance gate.

    §8.12 defines predicate_hash as sha256(test command ‖ test file). A bench
    gate's equivalent is its roster id and the file it lives in, qualified by
    the suite fingerprint so the same-named test in a different suite revision
    is a different predicate.
    """
    preimage = "\n".join(
        ["okp-predicate-id-v1", suite_fingerprint, gate_id, test_file or ""]
    )
    return sha256_hex(preimage.encode())


@dataclass(frozen=True)
class PredicateOutcomeRecord:
    type: str
    schema_version: int
    predicate_id: str
    predicate_outcome: str
    gate_id: str
    gate_phase: str | None
    gate_test_file: str | None
    gate_status_raw: str
    suite_fingerprint: str
    state_alg: str
    state_hash: str
    state_binding: str
    session_id: str | None
    session_fp: str | None
    sequence_index: int | None
    memory_mode: str | None
    org_id: str | None
    attempt: object | None
    duration_ms: object | None
    reason: str | None


def build_records(
    *,
    gate_results: list[dict],
    roster_by_id: dict[str, dict],
    suite_fingerprint: str,
    state_hash: str,
    state_binding: str,
    status_row: dict,
) -> list[PredicateOutcomeRecord]:
    records: list[PredicateOutcomeRecord] = []
    for gate in gate_results:
        gate_id = gate.get("id")
        if not isinstance(gate_id, str) or not gate_id:
            raise ValueError(f"gate result without a usable id: {gate!r}")
        roster = roster_by_id.get(gate_id, {})
        raw_status = gate.get("status")
        records.append(
            PredicateOutcomeRecord(
                type=RECORD_TYPE,
                schema_version=SCHEMA_VERSION,
                predicate_id=predicate_id_for(
                    gate_id, roster.get("file"), suite_fingerprint
                ),
                predicate_outcome=map_gate_status(raw_status),
                gate_id=gate_id,
                gate_phase=gate.get("phase") or roster.get("phase"),
                gate_test_file=roster.get("file"),
                gate_status_raw=raw_status
                if isinstance(raw_status, str)
                else repr(raw_status),
                suite_fingerprint=suite_fingerprint,
                state_alg=STATE_ALG,
                state_hash=state_hash,
                state_binding=state_binding,
                session_id=status_row.get("session_id"),
                session_fp=status_row.get("session_fp"),
                sequence_index=status_row.get("sequence_index"),
                memory_mode=status_row.get("memory_mode"),
                org_id=status_row.get("org_id"),
                attempt=status_row.get("attempt"),
                duration_ms=gate.get("duration_ms"),
                reason=gate.get("reason"),
            )
        )
    return records


def iter_status_rows_with_gates(status_path: str | os.PathLike[str]) -> Iterator[dict]:
    """Yield status records that carry gate results.

    Mirrors StatusStream's read contract: unparseable trailing fragments from a
    run that died mid-write are skipped, never guessed at.
    """
    with open(status_path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if (
                isinstance(row, dict)
                and isinstance(row.get("gate_results"), list)
                and row["gate_results"]
            ):
                yield row


def record_to_json(record: PredicateOutcomeRecord) -> str:
    return json.dumps(asdict(record), sort_keys=True, separators=(",", ":"))


# --- run driver ------------------------------------------------------------

OUTCOMES_FILENAME = "predicate-outcomes.jsonl"

# How a record's state_hash was obtained.
#
# A bench cell keeps ONE worktree on disk: the code as it stood when the cell
# finished. A cell that took three attempts therefore has three sets of gate
# results but only the LAST attempt's code. Binding all three to that surviving
# worktree would assert that attempt 1's passes happened against code they
# never ran against — the precise "attach a pass to different code" mistake the
# state binding exists to prevent.
#
# Runs graded by a harness that snapshots each attempt carry their own
# state_hash on the status row; that is ATTEMPT_SNAPSHOT and is always
# preferred, because it was taken while the code still existed.
#
# For older runs without those snapshots, only the terminal attempt can be
# bound. Earlier attempts are recorded with an empty state_hash and
# NOT_RETAINED, which a joiner must treat as unusable for state-bound claims
# rather than as a match against anything.
STATE_BINDING_ATTEMPT = "attempt_snapshot"  # hashed at grading time, by the harness
STATE_BINDING_WORKTREE = "worktree"  # hashed from the surviving worktree
STATE_BINDING_NOT_RETAINED = "not_retained"  # superseded attempt; its code is gone
STATE_BINDING_MISSING = "worktree_missing"  # cell worktree not found at all


def _cell_worktree(
    run_dir: Path, memory_mode: object, sequence_index: object
) -> Path | None:
    """Locate the graded worktree for one cell.

    Returns None when it cannot be located, so the caller records the outcomes
    as not-state-bound rather than inventing a hash.
    """
    if not isinstance(memory_mode, str) or not isinstance(sequence_index, int):
        return None
    mode_dir = run_dir / f"memory{memory_mode.upper()}"
    cell_dir = mode_dir / f"cell-{sequence_index:04d}"
    worktree = cell_dir / "worktree"
    return worktree if worktree.is_dir() else None


def emit_for_run(
    run_dir: str | os.PathLike[str], *, out_path: str | os.PathLike[str] | None = None
) -> dict:
    """Read a run's graded gates and write one record per gate.

    Returns a summary. Every gate in every gate-bearing status row produces
    exactly one record — including gates that failed and gates that were never
    evaluated. Recording only the passes would rebuild the original defect from
    the other direction.
    """
    run = Path(run_dir).resolve()
    status_path = run / "manifest.status.jsonl"
    if not status_path.is_file():
        raise FileNotFoundError(f"no manifest.status.jsonl under {run}")

    roster_path = run / "gate-roster.json"
    roster_by_id: dict[str, dict] = {}
    suite_fingerprint = ""
    if roster_path.is_file():
        roster_doc = json.loads(roster_path.read_text(encoding="utf-8"))
        suite_fingerprint = str(roster_doc.get("suite_fingerprint") or "")
        for gate in roster_doc.get("gates") or []:
            if isinstance(gate, dict) and isinstance(gate.get("id"), str):
                roster_by_id[gate["id"]] = gate

    destination = Path(out_path) if out_path is not None else run / OUTCOMES_FILENAME
    counts = {"pass": 0, "fail": 0, "not_evaluated": 0}
    binding_counts = {
        STATE_BINDING_ATTEMPT: 0,
        STATE_BINDING_WORKTREE: 0,
        STATE_BINDING_NOT_RETAINED: 0,
        STATE_BINDING_MISSING: 0,
    }

    # Two passes: the terminal attempt per cell is only knowable once every row
    # has been seen, and only the terminal attempt may claim the worktree.
    rows = list(iter_status_rows_with_gates(status_path))
    terminal_attempt: dict[tuple, int] = {}
    for row in rows:
        key = (row.get("memory_mode"), row.get("sequence_index"))
        attempt = row.get("attempt")
        if isinstance(attempt, int):
            terminal_attempt[key] = max(terminal_attempt.get(key, attempt), attempt)

    state_hashes: dict[tuple, str] = {}
    written = 0

    with open(destination, "w", encoding="utf-8") as out:
        for row in rows:
            key = (row.get("memory_mode"), row.get("sequence_index"))
            attempt = row.get("attempt")
            is_terminal = (
                isinstance(attempt, int) and terminal_attempt.get(key) == attempt
            )

            row_state_hash = row.get("state_hash")
            if isinstance(row_state_hash, str) and row_state_hash:
                # The harness fingerprinted this attempt as it graded it. Always
                # preferred: it is the only binding that is correct for a
                # superseded attempt.
                state_hash, binding = row_state_hash, STATE_BINDING_ATTEMPT
            elif not is_terminal:
                state_hash, binding = "", STATE_BINDING_NOT_RETAINED
            else:
                if key not in state_hashes:
                    worktree = _cell_worktree(
                        run, row.get("memory_mode"), row.get("sequence_index")
                    )
                    state_hashes[key] = (
                        "" if worktree is None else walk_manifest(worktree)[1]
                    )
                state_hash = state_hashes[key]
                binding = (
                    STATE_BINDING_WORKTREE if state_hash else STATE_BINDING_MISSING
                )

            records = build_records(
                gate_results=row["gate_results"],
                roster_by_id=roster_by_id,
                suite_fingerprint=suite_fingerprint,
                state_hash=state_hash,
                state_binding=binding,
                status_row=row,
            )
            for record in records:
                counts[record.predicate_outcome] += 1
                binding_counts[record.state_binding] += 1
                out.write(record_to_json(record) + "\n")
                written += 1

    return {
        "run_dir": str(run),
        "out_path": str(destination),
        "status_rows_with_gates": len(rows),
        "records_written": written,
        "counts": counts,
        "state_binding_counts": binding_counts,
        "suite_fingerprint": suite_fingerprint,
        "roster_gates": len(roster_by_id),
    }


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description="Emit predicate outcome records from a graded bench run.",
    )
    parser.add_argument(
        "run_dir", help="run directory containing manifest.status.jsonl"
    )
    parser.add_argument(
        "--out",
        default=None,
        help="output path (default: <run_dir>/predicate-outcomes.jsonl)",
    )
    args = parser.parse_args(argv)
    summary = emit_for_run(args.run_dir, out_path=args.out)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
