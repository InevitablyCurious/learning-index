"""Install the host-side opencode attach client the board's terminal mirror uses.

The version is the one images/worker/Dockerfile pins, so the mirror's client and
the cell's serve are always the same opencode. Run again after the pin changes;
preflight warns while the installed client and the pin disagree.

    .venv/bin/python scripts/install_attach_client.py
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from harness.worker_image import (
    ATTACH_CLIENT_BIN,
    ATTACH_CLIENT_DIR,
    pinned_opencode_version,
)


def main() -> int:
    version = pinned_opencode_version(REPO / "images" / "worker")
    ATTACH_CLIENT_DIR.mkdir(exist_ok=True)
    # --ignore-scripts, stated rather than inherited: opencode-ai's postinstall
    # only links its platform package's binary, which is done below instead.
    subprocess.run(
        [
            "npm",
            "install",
            "--ignore-scripts",
            "--prefix",
            str(ATTACH_CLIENT_DIR),
            f"opencode-ai@{version}",
        ],
        check=True,
    )
    # npm installs only the optional platform package that matches this host.
    natives = sorted(
        p
        for p in (ATTACH_CLIENT_DIR / "node_modules").glob("opencode-*/bin/opencode")
        if p.parts[-3] != "opencode-ai"
    )
    if len(natives) != 1:
        print(
            f"expected one platform binary, found {[str(p) for p in natives]}",
            file=sys.stderr,
        )
        return 1
    ATTACH_CLIENT_BIN.unlink(missing_ok=True)
    ATTACH_CLIENT_BIN.symlink_to(natives[0].relative_to(ATTACH_CLIENT_DIR))
    got = subprocess.run(
        [str(ATTACH_CLIENT_BIN), "--version"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    if got != version:
        print(
            f"installed opencode {got}, but the worker pins {version}", file=sys.stderr
        )
        return 1
    print(f"attach client: opencode {got} at {ATTACH_CLIENT_BIN}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
