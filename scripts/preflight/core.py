"""Shared scaffolding for the bench preflight check families.

Everything here is used by MORE THAN ONE family, or by the entry itself: the
repo anchor, the one sanctioned rebuild command, and the Check row accumulator
that the entry renders and projects to JSON.
"""

from __future__ import annotations

from pathlib import Path

# scripts/preflight/core.py -> repo root (Learning-Index).
REPO = Path(__file__).resolve().parents[2]

# THE ONE SANCTIONED REBUILD. Named identically everywhere a check tells an
# operator to rebuild, because it is the only build that records what the image
# was made from — see harness/worker_image.py.
REBUILD_CMD = (
    "rebuild: press REBUILD WORKER on the board, "
    "or .venv/bin/python scripts/rebuild_worker_image.py"
)


class Check:
    def __init__(self) -> None:
        self.rows: list[tuple[str, bool, str, bool, str | None]] = []

    def add(
        self,
        name: str,
        ok: bool,
        detail: str,
        blocking: bool = True,
        remedy: str | None = None,
    ) -> None:
        """Record one check.

        ``remedy`` names the CUSTOM TOOL that repairs this failure, by tool id.
        It is set per FAILURE BRANCH, never per check name: "the worker image is
        stale" is repaired by pressing Rebuild worker, but "docker not on PATH"
        is the same check failing for a reason no button can fix, and offering
        one there would be a lie the operator pays for by pressing it.

        The id is all that is emitted. The tool's NAME, and whether it is
        registered at all, are resolved by the control plane from the tool
        registry — this file must not carry a second copy of either, and a bare
        clone of bench/ genuinely does not have the dev-contributed tools.
        """
        self.rows.append((name, ok, detail, blocking, remedy))

    @property
    def blocking_failures(self) -> list[tuple[str, bool, str, bool, str | None]]:
        return [r for r in self.rows if not r[1] and r[3]]

    def as_rows(self) -> list[dict]:
        """The same rows, as data.

        The board renders preflight rather than re-deriving it: two
        implementations of "can I start" is how a dashboard ends up disagreeing
        with the CLI about why a button is dead. One check, two renderings.
        """
        return [
            {
                "name": name,
                "ok": ok,
                "blocking": blocking,
                "status": "pass" if ok else ("fail" if blocking else "warn"),
                "detail": detail,
                # Only on a failure. A passing row with a remedy attached would
                # invite a press that changes a bench that was already correct.
                "remedy_tool": None if ok else remedy,
            }
            for name, ok, detail, blocking, remedy in self.rows
        ]

    def render(self) -> None:
        width = max(len(r[0]) for r in self.rows)
        for name, ok, detail, blocking, _remedy in self.rows:
            mark = "PASS" if ok else ("FAIL" if blocking else "WARN")
            print(f"  [{mark}] {name.ljust(width)}  {detail}")
