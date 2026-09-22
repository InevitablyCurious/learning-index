"""Hold-UI leaves for the challenge adapter.

Extracted verbatim from harness/adapters/challenge/__init__.py
(WO-LI15-I1C STAGE 1C) and re-exported there, so every name stays
resolvable as harness.adapters.challenge.<name>.

THE LATE-BOUND _HOLD_UI_PORT SEAM. tests/test_hold_ui_review.py patches
the port via monkeypatch.setattr(challenge_mod, "_HOLD_UI_PORT", port)
on the PACKAGE, and _hold_for_ui_review consumes it in seven places.
This module therefore must NOT bind _HOLD_UI_PORT at import time: an
import-time binding would freeze the default (0 = auto-allocate) and
silently ignore the patch, and a module-level __getattr__ cannot help —
PEP 562 fires only on attribute access, never on the bare LOAD_GLOBAL
references inside a function. Instead, _hold_for_ui_review reads the package
attribute ONCE at call time into a local of the same name, so the
monkeypatched value is what the hold sees. The other _HOLD_UI_*
constants are not patched anywhere, so importing them directly from
.constants is correct. subprocess is imported normally: tests patch
backgammon.subprocess.run, which mutates the stdlib subprocess
singleton this module also holds a reference to — no late binding
needed.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import time
from typing import Any, Callable
import urllib.error
import urllib.request

from .constants import (
    _HOLD_UI_ENV,
    _HOLD_UI_HEALTH_TIMEOUT_S,
    _HOLD_UI_HEARTBEAT_S,
    _HOLD_UI_POLL_S,
    _HOLD_UI_RELEASE_FILE,
    _HOLD_UI_SERVER_LOG,
    _HOLD_UI_STATE_FILE,
)
from harness.free_port import allocate_free_host_port


def _resolve_hold_ui_entrypoint(worktree: Path) -> Path:
    """Artifact-driven entrypoint resolution — the Python port of
    grader/lib/harness.ts resolveEntrypoint: package.json
    scripts.start first, then src/server.{ts,js,mjs,cjs}, else a loud throw
    (a distinct failure class, never a silent skip)."""
    pkg_path = worktree / "package.json"
    if pkg_path.is_file():
        try:
            pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pkg = None
        scripts = pkg.get("scripts") if isinstance(pkg, dict) else None
        start_cmd = scripts.get("start") if isinstance(scripts, dict) else None
        if isinstance(start_cmd, str) and start_cmd.strip():
            parts = start_cmd.split()
            for idx, part in enumerate(parts):
                if part in {"node", "tsx", "deno", "bun", "next", "ts-node", "esrun"}:
                    if idx + 1 < len(parts) and re.search(
                        r"\.(ts|js|mjs|cjs|tsx|jsx)$", parts[idx + 1], re.IGNORECASE
                    ):
                        resolved = (worktree / parts[idx + 1]).resolve()
                        if resolved.is_file():
                            return resolved
    for name in ("server.ts", "server.js", "server.mjs", "server.cjs"):
        candidate = worktree / "src" / name
        if candidate.is_file():
            return candidate
    raise RuntimeError(
        "hold-ui: no entrypoint resolved — searched package.json scripts.start and "
        f"src/server.{{ts,js,mjs,cjs}} in {worktree}"
    )


def _hold_ui_port_listeners(port: int) -> list[int]:
    try:
        out = subprocess.run(
            ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return []
    return [int(tok) for tok in (out.stdout or "").split() if tok.strip().isdigit()]


def _hold_ui_healthy(port: int) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/health", timeout=1.0
        ) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError):
        return False


def _hold_ui_lan_exposed(port: int) -> str | None:
    """Is the held UI reachable from OFF this machine? Returns the reachable
    address, or None when it is loopback-only.

    The prompt REQUIRES the artifact to bind 127.0.0.1, but the agent wrote
    that server and an agent can ignore an instruction — `listen(8002)` with no
    host binds `::` (verified), publishing the game to every device on the
    operator's network. So this is checked, never assumed: bind the machine's
    own LAN address and see whether the port is already taken there by the
    artifact.

    A failure to determine it returns None (treated as not-exposed) — this is a
    warning surface on an operator-local review feature, and it must never fail
    a finished cell.
    """
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            # No packet is sent; this just selects the default-route interface.
            probe.connect(("192.0.2.1", 9))  # TEST-NET-1, RFC 5737
            lan_ip = probe.getsockname()[0]
        finally:
            probe.close()
    except OSError:
        return None
    if not lan_ip or lan_ip.startswith("127."):
        return None
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.5)
            if sock.connect_ex((lan_ip, port)) == 0:
                return f"{lan_ip}:{port}"
    except OSError:
        return None
    return None


def _hold_for_ui_review(
    *,
    run_label: str,
    run_dir: Path,
    worktree: Path,
    container_name: str,
    live_view_url: str,
    progress: Callable[[str], None],
) -> None:
    """Hold the cell stack for operator UI review until released.

    No-op unless BENCH_HOLD_UI=1. Boots the artifact's server host-side
    from the worktree on a per-cell FREE port passed to it as PORT (the
    gate's assigned-port boot, minus Playwright), then waits on the
    RELEASE_HOLD sentinel. Never fails the cell: boot problems are logged
    and the hold still proceeds (container + worktree stay inspectable). The
    UI server is killed in a finally — the ProcessReaper does not watch it.
    """
    import harness.adapters.challenge as _pkg
    _HOLD_UI_PORT = _pkg._HOLD_UI_PORT  # late-bound: tests monkeypatch the package attr; read it once at call time
    if (os.environ.get(_HOLD_UI_ENV) or "").strip() != "1":
        return

    # Per-cell free port: a fixed 8002 would collide when N held cells boot
    # host-side at once. A positive value is a pin (tests monkeypatch it);
    # 0 (the default) allocates a free port and passes it to the artifact.
    port = int(_HOLD_UI_PORT) if int(_HOLD_UI_PORT) > 0 else allocate_free_host_port()

    release_path = run_dir / _HOLD_UI_RELEASE_FILE
    state_path = run_dir / _HOLD_UI_STATE_FILE
    server_log_path = run_dir / _HOLD_UI_SERVER_LOG
    url = f"http://localhost:{port}"

    proc: subprocess.Popen[str] | None = None
    log_handle: Any = None
    ui_healthy = False
    boot_detail = "not_attempted"

    # A stale listener here is the audit's leaked-gate-server class; the gates
    # themselves SIGKILL it on every boot (harness.ts freePort). Mirrored.
    for pid in _hold_ui_port_listeners(port):
        try:
            os.kill(pid, signal.SIGKILL)
            progress(
                f"PROGRESS run_label={run_label} step=hold-ui killed_stale_listener pid={pid}"
            )
        except OSError as exc:
            progress(
                f"PROGRESS run_label={run_label} step=hold-ui kill_stale_listener_failed pid={pid} detail={exc}"
            )

    try:
        entrypoint = _resolve_hold_ui_entrypoint(worktree)
    except RuntimeError as exc:
        boot_detail = f"entrypoint_unresolved detail={exc}"
        progress(f"PROGRESS run_label={run_label} step=hold-ui boot=fail {boot_detail}")
    else:
        try:
            log_handle = server_log_path.open("w", encoding="utf-8")
            proc = subprocess.Popen(
                ["node", str(entrypoint)],
                cwd=str(worktree),
                env={**os.environ, "DEBUG_API": "1", "PORT": str(port)},
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                text=True,
                start_new_session=True,
            )
        except OSError as exc:
            boot_detail = f"spawn_failed detail={exc}"
            progress(
                f"PROGRESS run_label={run_label} step=hold-ui boot=fail {boot_detail}"
            )
            proc = None
        else:
            deadline = time.monotonic() + _HOLD_UI_HEALTH_TIMEOUT_S
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    break
                if _hold_ui_healthy(port):
                    ui_healthy = True
                    break
                time.sleep(0.25)
            if ui_healthy:
                boot_detail = f"healthy pid={proc.pid} entrypoint={entrypoint}"
            elif proc.poll() is not None:
                boot_detail = (
                    f"server_exited exit={proc.returncode} log={server_log_path}"
                )
            else:
                boot_detail = f"health_timeout log={server_log_path}"
            progress(
                f"PROGRESS run_label={run_label} step=hold-ui "
                f"boot={'ok' if ui_healthy else 'fail'} {boot_detail}"
            )

    # Consume any stale sentinel from a prior hold in this run_dir BEFORE waiting.
    try:
        release_path.unlink(missing_ok=True)
    except OSError:
        pass

    # Did the artifact actually bind loopback-only, as the prompt requires?
    lan_exposure = _hold_ui_lan_exposed(port) if ui_healthy else None
    if lan_exposure is not None:
        progress(
            f"PROGRESS run_label={run_label} step=hold-ui bind=LAN_EXPOSED "
            f"address={lan_exposure} detail=artifact_ignored_loopback_requirement"
        )

    state = {
        "url": url,
        "ui_healthy": ui_healthy,
        "boot_detail": boot_detail,
        "ui_pid": proc.pid if (proc is not None and proc.poll() is None) else None,
        "container_name": container_name,
        "worktree": str(worktree),
        "live_view_url": live_view_url,
        "release_cmd": f"touch {release_path}",
        "server_log": str(server_log_path),
        "started_at": _dt.datetime.now(tz=_dt.timezone.utc).isoformat(),
        # ── CONSUMABLE RELEASE CONTRACT (for the dashboard/control plane) ────
        # Deliberately NOT wired into the dashboard here — a separate agent owns
        # that. This is the stable surface it consumes.
        #
        # Release is a FILE TOUCH, not an HTTP endpoint, on purpose: the holding
        # process is a plain blocking loop with no server of its own, and giving
        # it a listening socket would add a second network surface (and a second
        # thing to secure) to a feature whose whole point is a human looking at
        # one page. A file works from the dashboard, a script, or a shell, needs
        # no auth story, and cannot be reached from off-box at all.
        "status": "held",
        "schema_version": 1,
        "release": {
            "method": "touch_file",
            "path": str(release_path),
            "poll_interval_s": _HOLD_UI_POLL_S,
            # A consumer releases the hold by creating this file. The loop polls
            # for it and tears the stack down on the next tick.
            "example_python": f"open({str(release_path)!r}, 'w').close()",
            "example_shell": f"touch {release_path}",
        },
        "bind": {
            # MEASURED, not asserted: the agent wrote the server, so whether it
            # honoured the loopback-only requirement is a fact to check.
            "expected_host": "127.0.0.1",
            "lan_reachable": lan_exposure is not None,
            "lan_address": lan_exposure,
        },
    }
    try:
        state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        progress(
            f"PROGRESS run_label={run_label} step=hold-ui state_write_failed detail={exc}"
        )

    hold_banner = (
        f"HOLD-UI ACTIVE run_label={run_label} url={url} "
        f"ui={'live' if ui_healthy else f'UNAVAILABLE ({boot_detail})'} "
        f"container={container_name} live_view={live_view_url} "
        f"release='touch {release_path}'"
    )
    progress(f"PROGRESS run_label={run_label} step=hold-ui waiting {hold_banner}")

    # The operator-facing close-out. The machine-readable banner above is for
    # the log; this is the line a human reads at the end of a run, so it leads
    # with a clickable URL and states plainly that the session is waiting on
    # them. Printed only when the UI actually booted — offering a link to a
    # server that is not listening is worse than saying nothing.
    if ui_healthy:
        if lan_exposure is None:
            reach_lines = (
                "  The page is served on loopback only — reachable from this\n"
                "  machine, not from anything else on your network.\n"
            )
        else:
            reach_lines = (
                f"  WARNING: this server is ALSO reachable at {lan_exposure}\n"
                "  — every device on your network can open it. The artifact did\n"
                "  not honour the loopback-only requirement in its prompt.\n"
            )
        operator_message = (
            f"\n{'=' * 72}\n"
            f"  game is finished — you can view it here: {url}\n"
            f"{'=' * 72}\n"
            f"  This session is now HELD and will wait until you release it.\n"
            f"{reach_lines}\n"
            f"  When you are done looking, release it with:\n"
            f"      touch {release_path}\n"
            f"{'=' * 72}\n"
        )
    else:
        operator_message = (
            f"\n{'=' * 72}\n"
            f"  game is finished, but the UI did NOT boot: {boot_detail}\n"
            f"{'=' * 72}\n"
            f"  No URL is offered because nothing is listening on {url}.\n"
            f"  Server log: {server_log_path}\n"
            f"  The container and worktree are still up for inspection.\n\n"
            f"  Release the hold with:\n"
            f"      touch {release_path}\n"
            f"{'=' * 72}\n"
        )
    print(operator_message, flush=True)

    held_at = time.monotonic()
    last_heartbeat = 0.0
    try:
        while not release_path.exists():
            now = time.monotonic()
            if now - last_heartbeat >= _HOLD_UI_HEARTBEAT_S:
                last_heartbeat = now
                server_alive = proc is not None and proc.poll() is None
                progress(
                    f"PROGRESS run_label={run_label} step=hold-ui heartbeat "
                    f"held_s={now - held_at:.0f} url={url} healthy={_hold_ui_healthy(port)} "
                    f"server_alive={server_alive}"
                )
            time.sleep(_HOLD_UI_POLL_S)
    finally:
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=1.5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=1.5)
            except OSError:
                pass
        if log_handle is not None:
            try:
                log_handle.close()
            except OSError:
                pass
        remaining = _hold_ui_port_listeners(port)
        if remaining:
            progress(
                f"PROGRESS run_label={run_label} step=hold-ui "
                f"port_still_occupied port={port} pids={remaining} "
                "detail=not-our-server; left running"
            )
        try:
            release_path.unlink(missing_ok=True)
            state_path.unlink(missing_ok=True)
        except OSError:
            pass
        progress(
            f"PROGRESS run_label={run_label} step=hold-ui released "
            f"held_s={time.monotonic() - held_at:.0f} action=proceed-to-teardown"
        )
        print(
            f"HOLD-UI RELEASED run_label={run_label} — teardown proceeding\n",
            flush=True,
        )
