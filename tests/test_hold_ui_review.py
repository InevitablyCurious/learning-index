"""WO-PAUSE-AFTER-GRADE operator-pause tests.

The pause boots a REAL node server from a stub worktree — inside the grader
image, via `harness.play_container` — waits on the real RELEASE_HOLD sentinel,
and must leave no listener behind (the ProcessReaper does not watch play
containers; the hold tears its own down).

PLAY-TIME SHAPE. The candidate always listens on PORT=8002 *inside* its
container and the operator reaches it on the PUBLISHED host port, which is the
only port that varies per cell. So a stub that BAKES a host port into its source
can never boot, and every stub here reads PORT from the environment. The
`_HOLD_UI_PORT` value a test pins is the published host port, nothing else.

Replaces the old WO-HOLD-UI-1 env-gated end-only hold contract: the pause is
now driven by the runner's `pause_after_grade` flag (never by env), writes
hold-ui.json schema_version 2 (kind/attempt/told_text/grade), honours an
operator note in the release file (journaled to operator-notes.jsonl, never to
user-events or the worktree), and returns the seconds held.
"""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import socket
import threading
import time

import pytest

from harness.adapters import challenge as challenge_mod
from harness.adapters.challenge import (
    _HOLD_UI_RELEASE_FILE,
    _HOLD_UI_STATE_FILE,
    _hold_for_operator,
    _resolve_hold_ui_entrypoint,
)
from harness.adapters.docker_worker import docker_available
from harness.grader_image import IMAGE, image_digest

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node required")

# The boot tests run a REAL candidate inside the grader image, so they need
# docker AND a built image. Probed once at import (cheap, never fatal) so the
# skip reason reaches the -ra summary instead of a mid-test failure.
_DOCKER_OK, _DOCKER_DETAIL = docker_available()
REQUIRES_DOCKER = pytest.mark.skipif(
    not _DOCKER_OK,
    reason=f"docker unavailable: {_DOCKER_DETAIL}",
)


def _require_grader_image() -> None:
    # Skip, as REQUIRES_DOCKER does: CI has docker but never builds the grader
    # image, and a fresh clone has not built it yet. play_container.start
    # refuses without the image anyway, so this only moves the failure to a skip.
    if image_digest(IMAGE) is None:
        pytest.skip(
            f"grader image {IMAGE} not built or built unsanctioned. Build with: "
            ".venv/bin/python scripts/rebuild_grader_image.py"
        )


# The pinned value is the PUBLISHED host port. Tests NEVER touch the campaign
# port 8002 (the live gates own it) — each port-touching test monkeypatches the
# module constant to its own high port, so the suite is safe to run while a
# benchmark cell is live, and parallel xdist workers never collide.
_BOOT_TEST_PORT = 18311
_UNRESOLVABLE_TEST_PORT = 18312


def _stub_server() -> str:
    """A minimal candidate: `/health` for the boot probe, a page, no dice route.

    The port comes from the ENVIRONMENT because that is the only port the
    artifact can know: the container always sets PORT=8002, and the published
    host port is not visible from inside.
    """
    return (
        "const http = require('http');\n"
        "const PORT = Number(process.env.PORT ?? 8002);\n"
        "const srv = http.createServer((req, res) => {\n"
        "  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }\n"
        "  res.writeHead(200, { 'content-type': 'text/html' });\n"
        "  res.end('<html><body>stub-ui</body></html>');\n"
        "});\n"
        "srv.listen(PORT, '0.0.0.0');\n"
    )


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) != 0


def _mk_worktree(tmp_path: Path, port: int) -> Path:
    """The candidate worktree every boot test starts.

    `port` is the PUBLISHED host port the caller pins on
    `challenge_mod._HOLD_UI_PORT` (0 = auto-allocate); it is deliberately NOT
    baked into the stub, which reads PORT from the environment like the artifact
    must.
    """
    worktree = tmp_path / "worktree"
    worktree.mkdir()
    (worktree / "package.json").write_text(
        json.dumps(
            {"name": "stub", "type": "commonjs", "scripts": {"start": "node server.js"}}
        ),
        encoding="utf-8",
    )
    (worktree / "server.js").write_text(_stub_server(), encoding="utf-8")
    return worktree


def _hold_kwargs(tmp_path: Path, worktree: Path, lines: list[str]) -> dict:
    return {
        "run_label": "test-hold",
        "run_dir": tmp_path,
        "worktree": worktree,
        # Unique per test: the hold names its play session from this, and
        # play_container hashes it into every docker name — a shared name would
        # make parallel (xdist) boot tests collide on "container name in use".
        "container_name": f"hold-test-{tmp_path.name}",
        "live_view_url": "http://127.0.0.1:4096",
        "progress": lines.append,
        "kind": "round",
        "attempt": 1,
        "max_attempts": 5,
        "told_text": "I'm still seeing the off tray drawn over some points.",
        "grade": {
            "report_path": str(tmp_path / "attempt-1-report.json"),
            "verdict": "FAIL",
            "conformed": False,
            "failed_gates": ["F01"],
            "n_problems": 3,
            "results": {"conformance": False, "backend": True, "frontend": False},
        },
    }


def _release_when_held(run_dir: Path, content: str = "release\n") -> threading.Thread:
    """Write the release sentinel once the pause's state file exists (the pause
    consumes stale sentinels before waiting, so the sentinel must land AFTER
    the state file). On timeout the pause hangs and pytest-timeout fails loud."""

    def _release() -> None:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if (run_dir / _HOLD_UI_STATE_FILE).exists():
                time.sleep(0.5)
                (run_dir / _HOLD_UI_RELEASE_FILE).write_text(content, encoding="utf-8")
                return
            time.sleep(0.2)

    releaser = threading.Thread(target=_release, daemon=True)
    releaser.start()
    return releaser


@REQUIRES_DOCKER
def test_hold_boots_real_ui_and_release_tears_it_down(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _require_grader_image()
    monkeypatch.setattr(challenge_mod, "_HOLD_UI_PORT", _BOOT_TEST_PORT)
    assert _port_free(_BOOT_TEST_PORT), "test requires a free boot-test port"
    worktree = _mk_worktree(tmp_path, _BOOT_TEST_PORT)
    lines: list[str] = []

    releaser = _release_when_held(tmp_path)
    _hold_for_operator(**_hold_kwargs(tmp_path, worktree, lines))
    releaser.join(timeout=25)

    joined = "\n".join(lines)
    assert "step=hold-ui boot=ok" in joined
    assert "step=hold-ui waiting" in joined
    assert "step=hold-ui released" in joined
    assert "action=proceed-to-next-round" in joined
    assert _port_free(_BOOT_TEST_PORT), "pause must leave no listener behind"
    assert not (tmp_path / _HOLD_UI_STATE_FILE).exists(), (
        "state file consumed at release"
    )
    assert not (tmp_path / _HOLD_UI_RELEASE_FILE).exists(), "release sentinel consumed"
    # The UI was genuinely observable over the PUBLISHED port while held: proven
    # by the boot health probe; re-prove the served page contract from the stub.
    stub = _stub_server()
    assert "/health" in stub and "stub-ui" in stub


@REQUIRES_DOCKER
def test_hold_auto_allocates_a_free_port_and_passes_it_as_port_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """_HOLD_UI_PORT=0 (the shipped default) must allocate a free per-cell
    PUBLISHED port — a fixed one collides when N cells are held at once. The
    stub listens ONLY on the PORT env value (the container fixes it at 8002), so
    a URL that answers on a different, auto-allocated host port proves the
    forwarder published the right one (the grader boots the artifact the same
    way: grader/lib/harness.ts)."""
    _require_grader_image()
    monkeypatch.setattr(challenge_mod, "_HOLD_UI_PORT", 0)
    worktree = _mk_worktree(tmp_path, 0)
    lines: list[str] = []
    # The state file is unlinked at release, so capture it DURING the hold.
    captured: dict = {}

    def _capture_then_release() -> None:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            state_file = tmp_path / _HOLD_UI_STATE_FILE
            if state_file.exists():
                time.sleep(0.5)
                captured.update(json.loads(state_file.read_text(encoding="utf-8")))
                (tmp_path / _HOLD_UI_RELEASE_FILE).write_text(
                    "release\n", encoding="utf-8"
                )
                return
            time.sleep(0.2)

    grabber = threading.Thread(target=_capture_then_release, daemon=True)
    grabber.start()

    _hold_for_operator(**_hold_kwargs(tmp_path, worktree, lines))
    grabber.join(timeout=25)

    joined = "\n".join(lines)
    assert "step=hold-ui boot=ok" in joined
    assert captured, "pause never published its state file"
    assert captured["ui_healthy"] is True
    port = int(captured["url"].rsplit(":", 1)[1])
    assert port != 8002, "the published port must be allocated, not the spec port"
    # The url the operator is handed (the waiting banner) carries the same port.
    assert f"url=http://localhost:{port}" in joined
    assert _port_free(port), "pause must leave no listener behind"


def test_hold_survives_unresolvable_entrypoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(challenge_mod, "_HOLD_UI_PORT", _UNRESOLVABLE_TEST_PORT)
    worktree = tmp_path / "worktree"
    worktree.mkdir()
    lines: list[str] = []

    releaser = _release_when_held(tmp_path)
    _hold_for_operator(**_hold_kwargs(tmp_path, worktree, lines))
    releaser.join(timeout=25)

    joined = "\n".join(lines)
    assert "entrypoint_unresolved" in joined
    assert "step=hold-ui waiting" in joined
    assert "step=hold-ui released" in joined
    assert _port_free(_UNRESOLVABLE_TEST_PORT)


def test_resolve_entrypoint_prefers_package_start(tmp_path: Path) -> None:
    worktree = _mk_worktree(tmp_path, _BOOT_TEST_PORT)
    assert _resolve_hold_ui_entrypoint(worktree) == (worktree / "server.js").resolve()


def test_resolve_entrypoint_globs_src_server(tmp_path: Path) -> None:
    worktree = tmp_path / "worktree"
    (worktree / "src").mkdir(parents=True)
    server = worktree / "src" / "server.ts"
    server.write_text("// stub\n", encoding="utf-8")
    assert _resolve_hold_ui_entrypoint(worktree) == server


def test_resolve_entrypoint_throws_loudly(tmp_path: Path) -> None:
    worktree = tmp_path / "worktree"
    worktree.mkdir()
    with pytest.raises(RuntimeError, match="no entrypoint resolved"):
        _resolve_hold_ui_entrypoint(worktree)


# ── The v2 contract: schema, kind/attempt/told_text/grade, and the note ──────

_RELEASE_CONTRACT_PORT = 18313


def _capture_state_then_release(
    tmp_path: Path, captured: dict, content: str = "release\n"
) -> threading.Thread:
    def _run() -> None:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            state_file = tmp_path / _HOLD_UI_STATE_FILE
            if state_file.exists():
                time.sleep(0.5)
                captured.update(json.loads(state_file.read_text(encoding="utf-8")))
                (tmp_path / _HOLD_UI_RELEASE_FILE).write_text(content, encoding="utf-8")
                return
            time.sleep(0.2)

    grabber = threading.Thread(target=_run, daemon=True)
    grabber.start()
    return grabber


@REQUIRES_DOCKER
def test_state_file_carries_the_v2_contract(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A consumer (the dashboard, a separate agent's work) must be able to
    release the pause from hold-ui.json ALONE, without reading this source.
    schema_version is 2 and carries kind/attempt/max_attempts/told_text/grade."""
    _require_grader_image()
    monkeypatch.setattr(challenge_mod, "_HOLD_UI_PORT", _RELEASE_CONTRACT_PORT)
    worktree = _mk_worktree(tmp_path, _RELEASE_CONTRACT_PORT)
    lines: list[str] = []
    # The state file is deliberately UNLINKED on release, so it must be
    # captured DURING the hold, not after.
    captured: dict = {}

    grabber = _capture_state_then_release(tmp_path, captured)
    _hold_for_operator(**_hold_kwargs(tmp_path, worktree, lines))
    grabber.join(timeout=25)

    state = captured
    assert state, "pause never published its state file"
    assert state["status"] == "held"
    assert state["schema_version"] == 2

    release = state["release"]
    assert release["method"] == "touch_file"
    # The advertised path must be the one the loop actually waits on.
    assert Path(release["path"]) == tmp_path / _HOLD_UI_RELEASE_FILE
    assert release["poll_interval_s"] > 0
    assert str(tmp_path / _HOLD_UI_RELEASE_FILE) in release["example_shell"]

    # The URL the operator is handed must be the one that was served.
    assert state["url"].endswith(f":{_RELEASE_CONTRACT_PORT}")
    assert state["ui_healthy"] is True

    # ── WO-PAUSE-AFTER-GRADE v2 fields ──
    assert state["kind"] == "round"
    assert state["attempt"] == 1
    assert state["max_attempts"] == 5
    assert state["told_text"] == "I'm still seeing the off tray drawn over some points."
    grade = state["grade"]
    assert grade["verdict"] == "FAIL"
    assert grade["conformed"] is False
    assert grade["failed_gates"] == ["F01"]
    assert grade["n_problems"] == 3
    assert grade["results"] == {
        "conformance": False,
        "backend": True,
        "frontend": False,
    }
    assert grade["report_path"] == str(tmp_path / "attempt-1-report.json")

    # Loopback claim is MEASURED. The forwarder publishes 127.0.0.1 only, so the
    # held UI must NOT be reachable off this machine — even though the stub
    # binds 0.0.0.0 inside its container.
    assert state["bind"]["expected_host"] == "127.0.0.1"
    assert state["bind"]["lan_reachable"] is False, (
        "the play forwarder publishes loopback only; a LAN-reachable hold means "
        "the publish widened"
    )

    out = capsys.readouterr().out
    assert "game is finished" in out
    assert state["url"] in out
    assert f"touch {tmp_path / _HOLD_UI_RELEASE_FILE}" in out
    assert _port_free(_RELEASE_CONTRACT_PORT), "pause left a listener behind"


def test_no_url_is_offered_when_the_ui_never_booted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Handing the operator a link to a dead server is worse than saying
    nothing — the close-out must say the UI failed and name the log."""
    monkeypatch.setattr(challenge_mod, "_HOLD_UI_PORT", 18314)
    worktree = tmp_path / "worktree"
    worktree.mkdir()  # no entrypoint -> boot fails
    lines: list[str] = []
    captured: dict = {}

    grabber = _capture_state_then_release(tmp_path, captured)
    _hold_for_operator(**_hold_kwargs(tmp_path, worktree, lines))
    grabber.join(timeout=25)

    out = capsys.readouterr().out
    assert "did NOT boot" in out
    assert "you can view it here" not in out
    assert captured, "pause never published its state file"
    assert captured["ui_healthy"] is False
    # No UI booted, so nothing can be LAN-reachable.
    assert captured["bind"]["lan_reachable"] is False


@REQUIRES_DOCKER
def test_operator_note_is_journaled_and_never_reaches_worktree_or_user_events(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A release file carrying `{"note": "..."}` appends one line to
    operator-notes.jsonl beside hold-ui.json — and nothing is written into the
    worktree (the only place the model could see it)."""
    _require_grader_image()
    monkeypatch.setattr(challenge_mod, "_HOLD_UI_PORT", 18315)
    worktree = _mk_worktree(tmp_path, 18315)
    lines: list[str] = []

    releaser = _release_when_held(
        tmp_path, content=json.dumps({"note": "off tray looks fixed now"}) + "\n"
    )
    _hold_for_operator(**_hold_kwargs(tmp_path, worktree, lines))
    releaser.join(timeout=25)

    notes = tmp_path / "operator-notes.jsonl"
    assert notes.is_file(), "operator note must be journaled"
    row = json.loads(notes.read_text(encoding="utf-8").strip().splitlines()[-1])
    assert row["kind"] == "round"
    assert row["attempt"] == 1
    assert row["note"] == "off tray looks fixed now"
    assert "released_at" in row

    # The note must never reach the model: nothing in the worktree, nothing in
    # a user-events file. The worktree's only files are the stub server.
    assert "off tray looks fixed now" not in (worktree / "server.js").read_text(
        encoding="utf-8"
    )
    assert not (tmp_path / "worktree.user-events.jsonl").exists(), (
        "the note must never be appended to user-events"
    )


@REQUIRES_DOCKER
def test_plain_release_writes_no_operator_note(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An empty release file (plain touch) journals no operator note."""
    _require_grader_image()
    monkeypatch.setattr(challenge_mod, "_HOLD_UI_PORT", 18316)
    worktree = _mk_worktree(tmp_path, 18316)
    lines: list[str] = []

    releaser = _release_when_held(tmp_path, content="")
    _hold_for_operator(**_hold_kwargs(tmp_path, worktree, lines))
    releaser.join(timeout=25)

    assert not (tmp_path / "operator-notes.jsonl").exists(), (
        "a plain release must not journal a note"
    )
