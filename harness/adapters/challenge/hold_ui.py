"""Operator-pause leaves for the challenge adapter (WO-PAUSE-AFTER-GRADE).

Extracted verbatim from harness/adapters/challenge/__init__.py
(WO-LI15-I1C STAGE 1C) and re-exported there, so every name stays
resolvable as harness.adapters.challenge.<name>.

THE LATE-BOUND _HOLD_UI_PORT SEAM. tests/test_hold_ui_review.py patches
the port via monkeypatch.setattr(challenge_mod, "_HOLD_UI_PORT", port)
on the PACKAGE, and _hold_for_operator consumes it in seven places.
This module therefore must NOT bind _HOLD_UI_PORT at import time: an
import-time binding would freeze the default (0 = auto-allocate) and
silently ignore the patch, and a module-level __getattr__ cannot help —
PEP 562 fires only on attribute access, never on the bare LOAD_GLOBAL
references inside a function. Instead, _hold_for_operator reads the package
attribute ONCE at call time into a local of the same name, so the
monkeypatched value is what the hold sees. The other _HOLD_UI_*
constants are not patched anywhere, so importing them directly from
.constants is correct. subprocess is imported normally: tests patch
backgammon.subprocess.run, which mutates the stdlib subprocess
singleton this module also holds a reference to — no late binding
needed.

WO-PAUSE-AFTER-GRADE: this was `_hold_for_ui_review`, a benchmark-end-only,
env-gated (BENCH_HOLD_UI) hold. It is now `_hold_for_operator`, driven by the
runner's `pause_after_grade` flag (never by env), and can fire per-grade
(`kind="round"`) or at run end (`kind="final"`). It writes hold-ui.json with
schema_version 2 and honours an operator note carried in the release file. The
runner times each pause itself and excludes it from wall time.
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
    _HOLD_UI_HEALTH_TIMEOUT_S,
    _HOLD_UI_HEARTBEAT_S,
    _HOLD_UI_POLL_S,
    _HOLD_UI_RELEASE_FILE,
    _HOLD_UI_SERVER_LOG,
    _HOLD_UI_STATE_FILE,
)
from harness.free_port import allocate_free_host_port

# The schema_version this module writes. v1 (the env-gated end-only hold) is
# no longer produced; readHold on the control plane accepts v2 only.
_HOLD_UI_SCHEMA_VERSION = 2
# The operator-note journal, written beside hold-ui.json when a release carries
# a note. NEVER into the worktree and never into user-events: the note must
# never reach the model.
_OPERATOR_NOTES_FILE = "operator-notes.jsonl"


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


# The dice an operator plays with during a pause. A pause boots the artifact with
# DEBUG_API=1, so its /api/debug/roll queue (chunk-03: "the next dice-roll consumes
# this queue instead of Math.random") is open. Random dice meant the operator never
# met the positions the grader judged (Jerry, run 1792183915: "the dice are not
# deterministic … which is messing me up seeing what the grader is showing to the
# model"). The opening is the one F04 plays — the player's 5 against the
# computer's 3, so the player moves first with 5 and 3 — then a fixed list from a
# fixed seed; a double is queued as four dice, as the debug route expects.
def _pause_dice() -> list[list[int]]:
    import random

    rng = random.Random(20261017)
    rolls: list[list[int]] = [[5, 3]]
    while len(rolls) < 60:
        a, b = rng.randint(1, 6), rng.randint(1, 6)
        rolls.append([a, a, a, a] if a == b else [a, b])
    return rolls


PAUSE_DICE = _pause_dice()


def _queue_pause_dice(port: int) -> dict[str, Any]:
    """Queue PAUSE_DICE in the artifact's debug roll queue. Reported, never assumed:
    a build without the route says so on the pause panel and plays random dice."""
    for n, dice in enumerate(PAUSE_DICE):
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/debug/roll",
            data=json.dumps({"dice": dice}).encode(),
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                if resp.status >= 400:
                    raise urllib.error.HTTPError(req.full_url, resp.status, "refused", resp.headers, None)
        except (urllib.error.URLError, OSError) as exc:
            return {"fixed": False, "queued": n, "opening": PAUSE_DICE[0], "detail": f"/api/debug/roll failed: {exc}"}
    return {"fixed": True, "queued": len(PAUSE_DICE), "opening": PAUSE_DICE[0], "detail": None}


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


def _read_operator_note(
    release_path: Path, progress: Callable[[str], None]
) -> str | None:
    """Read the operator note from a release file.

    Empty file = plain release (no note). Otherwise the file must be JSON
    `{"note": "<text>"}`; a non-empty note string is returned trimmed. A file
    that cannot be read or parsed still releases the cell, but the lost note
    is reported loudly — never dropped in silence.
    """
    try:
        content = release_path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        progress(f"PROGRESS step=hold-ui operator-note LOST reason=unreadable error={exc}")
        return None
    if not content:
        return None
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        progress(f"PROGRESS step=hold-ui operator-note LOST reason=not-json error={exc}")
        return None
    note = parsed.get("note") if isinstance(parsed, dict) else None
    if isinstance(note, str) and note.strip():
        return note.strip()
    progress("PROGRESS step=hold-ui operator-note LOST reason=no-note-string")
    return None


def _append_operator_note(
    run_dir: Path,
    *,
    kind: str,
    attempt: int | None,
    note: str,
    progress: Callable[[str], None],
) -> None:
    """Append one journal line to operator-notes.jsonl in `run_dir`.

    The note is operator telemetry only: it is written OUTSIDE the worktree
    (beside hold-ui.json) and never touches user-events or the opencode
    session, so it can never reach the model. A write failure is reported
    loudly and does not fail the cell.
    """
    payload = {
        "attempt": attempt,
        "kind": kind,
        "note": note,
        "released_at": _dt.datetime.now(tz=_dt.timezone.utc).isoformat(),
    }
    notes_path = run_dir / _OPERATOR_NOTES_FILE
    try:
        with notes_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, separators=(",", ":")) + "\n")
    except OSError as exc:
        progress(
            f"PROGRESS step=hold-ui operator-note LOST reason=write-failed "
            f"path={notes_path} error={exc}"
        )


def _hold_for_operator(
    *,
    run_label: str,
    run_dir: Path,
    worktree: Path,
    container_name: str,
    live_view_url: str,
    progress: Callable[[str], None],
    kind: str = "final",
    attempt: int | None = None,
    max_attempts: int | None = None,
    told_text: str | None = None,
    grade: dict[str, Any] | None = None,
) -> None:
    """Hold the cell stack for operator review until released.

    Called by the runner ONLY when `pause_after_grade` is on — there is no env
    gate here (BENCH_HOLD_UI is deleted). Boots the artifact's server host-side
    from the worktree on a per-cell FREE port passed to it as PORT (the
    gate's assigned-port boot, minus Playwright), then waits on the
    RELEASE_HOLD sentinel. Never fails the cell: boot problems are logged
    and the hold still proceeds (container + worktree stay inspectable). The
    UI server is killed in a finally — the ProcessReaper does not watch it.

    Writes hold-ui.json with schema_version 2, carrying `kind`, `attempt`,
    `max_attempts`, `told_text` (the exact feedback about to be sent, round
    pauses only) and `grade` (values the attempt's grade report already
    carries, plus the report path). If the release file carries a JSON
    `{"note": "<text>"}`, the note is appended to operator-notes.jsonl beside
    hold-ui.json — never reaching the model.
    """
    import harness.adapters.challenge as _pkg

    _HOLD_UI_PORT = (
        _pkg._HOLD_UI_PORT
    )  # late-bound: tests monkeypatch the package attr; read it once at call time

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

    dice = _queue_pause_dice(port) if ui_healthy else {
        "fixed": False, "queued": 0, "opening": PAUSE_DICE[0], "detail": "the game did not start",
    }
    progress(
        f"PROGRESS run_label={run_label} step=hold-ui dice "
        f"fixed={dice['fixed']} queued={dice['queued']} detail={dice['detail']}"
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
        "schema_version": _HOLD_UI_SCHEMA_VERSION,
        "kind": kind,
        "attempt": attempt,
        "max_attempts": max_attempts,
        "told_text": told_text,
        "grade": grade,
        "dice": dice,
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
            f"  (or write {{'note': 'your words'}} to that file to journal a note\n"
            f"   with the release — it never reaches the model)\n"
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
    note: str | None = None
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
        # Released: read any operator note BEFORE the finally unlinks the file.
        note = _read_operator_note(release_path, progress)
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
        # A round pause continues to the next round; only the final pause (or
        # an interrupt) leads to teardown.
        after = "next-round" if kind == "round" else "teardown"
        progress(
            f"PROGRESS run_label={run_label} step=hold-ui released "
            f"kind={kind} attempt={attempt} "
            f"held_s={time.monotonic() - held_at:.0f} action=proceed-to-{after}"
        )
        print(
            f"HOLD-UI RELEASED run_label={run_label} kind={kind} attempt={attempt} "
            f"— {after.replace('-', ' ')} proceeding\n",
            flush=True,
        )

    if note is not None:
        progress(
            f"PROGRESS run_label={run_label} step=hold-ui operator-note "
            f"kind={kind} attempt={attempt} chars={len(note)} "
            f"path={run_dir / _OPERATOR_NOTES_FILE}"
        )
        _append_operator_note(
            run_dir, kind=kind, attempt=attempt, note=note, progress=progress
        )
