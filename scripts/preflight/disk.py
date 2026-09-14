"""Host disk headroom — non-blocking, but a run can fill a low disk."""

from __future__ import annotations

import shutil

from preflight.core import REPO, Check


def check_disk(c: Check) -> None:
    usage = shutil.disk_usage(REPO)
    free_gb = usage.free / 1e9
    c.add(
        "disk free",
        free_gb > 10,
        f"{free_gb:.1f} GB free"
        + ("" if free_gb > 10 else " — LOW, a run can fill this"),
        blocking=False,
    )
