"""Unit tests for harness.play_container — the pure argv/name contract.

No docker and no subprocess: these assert the tokens later callers depend on —
what the candidate may mount, which network it joins, and the one loopback port
the operator's browser gets.

WHY THE START IDEMPOTENCY INVARIANT IS PINNED HERE
--------------------------------------------------
Play container names are hashed from the session identity, so a container left
up by an earlier run — or by an earlier boot of the same cell — still owned the
``-cand``/``-fwd`` name and the next ``docker run --name`` died with rc 125,
taking the preview down with it. ``start`` now force-removes its OWN two names
before creating them; these tests pin that the removal precedes the create, that
it never reaches a sibling cell's names, and that ``stop`` still addresses the
very same names — the string is the teardown key, so the two must not diverge.
The effectful seams (``_run``, ``assert_image_available``,
``_resolve_start_command``) are substituted, so nothing here starts a container.
"""

from __future__ import annotations

from pathlib import Path

import harness.play_container as play
from harness.play_container import (
    CANDIDATE_PORT,
    FORWARDER_SCRIPT,
    IMAGE,
    _names,
    build_candidate_argv,
    build_forwarder_argv,
    build_network_argv,
)

WORKTREE = "/host/worktree/cell-0000"
OWNER = "control"
CELL = "cell-0000"
NETWORK = "okp-play-aaaaaaaabbbb-net"
CANDIDATE = "okp-play-aaaaaaaabbbb-cand"
FORWARDER = "okp-play-aaaaaaaabbbb-fwd"
HOST_PORT = 45123
# What control/play.mjs composes: ``${run}::${cell}``. The string is the whole
# teardown key, so tests spell it the way the caller does.
IDENTITY = "run-a1b2::cell-0000"
OTHER_IDENTITY = "run-a1b2::cell-0001"


def _values(argv: list[str], flag: str) -> list[str]:
    """Every value that follows ``flag`` (single-token values only)."""
    return [argv[i + 1] for i, token in enumerate(argv[:-1]) if token == flag]


def _candidate(**overrides: object) -> list[str]:
    kwargs: dict[str, object] = {
        "candidate_name": CANDIDATE,
        "network_name": NETWORK,
        "worktree": WORKTREE,
        "owner": OWNER,
        "cell": CELL,
        "debug_api": False,
        "container_entrypoint": "/tmp/app/src/server.ts",
        "flags": ["--experimental-strip-types"],
        "max_seconds": 21600,
    }
    kwargs.update(overrides)
    return build_candidate_argv(**kwargs)  # type: ignore[arg-type]


def _forwarder(**overrides: object) -> list[str]:
    kwargs: dict[str, object] = {
        "forwarder_name": FORWARDER,
        "owner": OWNER,
        "cell": CELL,
        "host_port": HOST_PORT,
        "candidate_name": CANDIDATE,
        "max_seconds": 21600,
    }
    kwargs.update(overrides)
    return build_forwarder_argv(**kwargs)  # type: ignore[arg-type]


def _completed(
    argv: list[str], code: int, stdout: str = "", stderr: str = ""
) -> play.subprocess.CompletedProcess[str]:
    return play.subprocess.CompletedProcess(argv, code, stdout=stdout, stderr=stderr)


def _stub_start(
    monkeypatch,
    calls: list[list[str]],
    *,
    present: tuple[str, ...] = (),
    stuck: tuple[str, ...] = (),
) -> None:
    """Make ``start``/``stop`` reachable with no docker, node or image.

    ``present`` names containers a leftover run really left behind: each exists
    until ``docker rm -f`` clears it, and ``docker ps --filter name=^X$``
    answers for it, so a test can prove the removal is the thing that lets the
    create succeed. ``stuck`` names a container whose removal reports success
    while it is still there — the wedged-daemon case the re-check guards.
    """
    sitting = set(present)

    def fake_run(argv: list[str]) -> play.subprocess.CompletedProcess[str]:
        calls.append(argv)
        if argv[1:3] == ["rm", "-f"]:
            target = argv[-1]
            if target not in sitting:
                return _completed(argv, 1, stderr=f"No such container: {target}")
            if target not in stuck:
                sitting.discard(target)
            return _completed(argv, 0)
        if argv[1:2] == ["ps"]:
            wanted = argv[argv.index("--filter") + 1][len("name=^") : -1]
            return _completed(argv, 0, stdout=wanted if wanted in sitting else "")
        return _completed(argv, 0)

    monkeypatch.setattr(play, "_run", fake_run)
    monkeypatch.setattr(play, "assert_image_available", lambda image: None)
    monkeypatch.setattr(
        play, "_resolve_start_command", lambda root: ("/tmp/app/src/server.ts", [])
    )


def _start(identity: str) -> dict:
    return play.start(
        name=identity,
        worktree=WORKTREE,
        owner=OWNER,
        cell=CELL,
        host_port=HOST_PORT,
        max_seconds=21600,
    )


def _created(calls: list[list[str]]) -> list[str]:
    """Every container name a recorded ``docker run`` asked for, in order."""
    return [_values(argv, "--name")[0] for argv in calls if argv[1:2] == ["run"]]


def _removed(calls: list[list[str]]) -> list[str]:
    """Every container name a recorded ``docker rm -f`` asked to remove."""
    return [argv[-1] for argv in calls if argv[1:3] == ["rm", "-f"]]


def test_candidate_carries_every_isolation_token() -> None:
    argv = _candidate()

    assert _values(argv, "--user") == ["1000:1000"]
    assert "--read-only" in argv
    # The only writable places are in-memory and private to the container.
    assert [v.split(":")[0] for v in _values(argv, "--tmpfs")] == ["/tmp", "/out"]
    assert _values(argv, "--cap-drop") == ["ALL"]
    assert _values(argv, "--security-opt") == ["no-new-privileges"]
    assert _values(argv, "--pids-limit") == ["256"]
    assert _values(argv, "--memory") == ["1g"]
    assert _values(argv, "--cpus") == ["2"]

    labels = _values(argv, "--label")
    assert "okp.play=1" in labels
    assert f"okp.play.owner={OWNER}" in labels
    assert f"okp.play.cell={CELL}" in labels

    assert _values(argv, "--entrypoint") == ["timeout"]
    assert IMAGE in argv


def test_candidate_mounts_worktree_read_only_and_nothing_else() -> None:
    argv = _candidate()

    assert _values(argv, "-v") == [f"{WORKTREE}:/candidate:ro"]
    joined = " ".join(argv)
    assert "docker.sock" not in joined
    assert "--add-host" not in argv


def test_candidate_network_is_the_internal_one_only() -> None:
    argv = _candidate()

    assert _values(argv, "--network") == [NETWORK]
    assert NETWORK not in {"bridge", "host", "none"}


def test_candidate_env_is_port_only() -> None:
    argv = _candidate()
    assert _values(argv, "-e") == [f"PORT={CANDIDATE_PORT}"]

    debug = _candidate(debug_api=True)
    assert _values(debug, "-e") == [f"PORT={CANDIDATE_PORT}", "DEBUG_API=1"]

    for value in _values(argv, "-e") + _values(debug, "-e"):
        for prefix in ("HOME=", "PATH=", "SSH_", "USER="):
            assert not value.startswith(prefix), value


def test_candidate_lifetime_is_enforced_inside_the_container() -> None:
    argv = _candidate(max_seconds=1234)
    image_index = argv.index(IMAGE)

    assert _values(argv, "--entrypoint") == ["timeout"]
    assert argv[image_index + 1 : image_index + 4] == ["1234", "sh", "-c"]


def test_candidate_copies_then_execs_with_flags_and_entrypoint_preserved() -> None:
    inner = _candidate()[-1]

    assert "cp -a /candidate/. /tmp/app/" in inner
    assert "cd /tmp/app" in inner
    assert "exec node " in inner
    assert "--experimental-strip-types" in inner
    assert "/tmp/app/src/server.ts" in inner


def test_forwarder_publishes_loopback_only() -> None:
    argv = _forwarder()

    assert _values(argv, "-p") == [f"127.0.0.1:{HOST_PORT}:{CANDIDATE_PORT}"]
    published = _values(argv, "-p")
    assert all(value.startswith("127.0.0.1:") for value in published)
    assert not any("0.0.0.0" in value for value in published)


def test_forwarder_runs_on_the_default_bridge_and_runs_node_with_a_lifetime() -> None:
    argv = _forwarder()

    # The default bridge in ONE docker run: docker rejects mixing it with a
    # user-defined network, so the internal network is joined afterwards with
    # ``docker network connect`` in ``start()``.
    assert _values(argv, "--network") == ["bridge"]
    assert argv.count("--network") == 1
    # The same hard lifetime as its candidate: an orphaned forwarder must not
    # keep publishing a port after the candidate is gone.
    assert _values(argv, "--entrypoint") == ["timeout"]

    image_index = argv.index(IMAGE)
    assert "-e" not in argv[:image_index]
    assert argv[image_index + 1 :] == [
        "21600",
        "node",
        "-e",
        FORWARDER_SCRIPT,
        CANDIDATE,
        str(CANDIDATE_PORT),
    ]
    assert argv[-1] == str(CANDIDATE_PORT)
    assert CANDIDATE in argv


def test_names_are_deterministic_distinct_and_label_safe() -> None:
    first = _names("run::cell")
    second = _names("run::cell")
    other = _names("other")

    assert first == second
    assert first["candidate"] != other["candidate"]
    assert first["forwarder"] != other["forwarder"]
    assert first["network"] != other["network"]
    assert len({first["candidate"], first["forwarder"], first["network"]}) == 3

    for value in first.values():
        assert value.startswith("okp-play-")
        assert len(value) <= 63


def test_start_clears_its_own_leftover_containers_before_it_creates(
    monkeypatch,
) -> None:
    names = _names(IDENTITY)
    calls: list[list[str]] = []
    _stub_start(
        monkeypatch,
        calls,
        present=(names["candidate"], names["forwarder"]),
    )

    _start(IDENTITY)

    # Exactly this identity's two names, candidate first (as ``stop`` does).
    assert _removed(calls) == [names["candidate"], names["forwarder"]]

    creates = [i for i, argv in enumerate(calls) if argv[1:2] == ["run"]]
    removes = [i for i, argv in enumerate(calls) if argv[1:3] == ["rm", "-f"]]
    assert len(creates) == 2
    # Every removal precedes the first create: the name must be free BEFORE
    # ``docker run --name`` reaches the daemon (rc 125 otherwise).
    assert max(removes) < min(creates), [calls[i] for i in removes + creates]
    assert _created(calls) == [names["candidate"], names["forwarder"]]

    # --rm would delete the container, and the ``docker logs`` the operator is
    # pointed at after a dev-mode pause; the pre-remove is the whole fix.
    assert not any("--rm" in argv for argv in calls)


def test_the_name_is_per_run_cell_so_a_reboot_reuses_only_its_own(
    monkeypatch,
) -> None:
    first: list[list[str]] = []
    _stub_start(monkeypatch, first)
    _start(IDENTITY)

    again: list[list[str]] = []
    _stub_start(monkeypatch, again)
    _start(IDENTITY)

    other: list[list[str]] = []
    _stub_start(monkeypatch, other)
    _start(OTHER_IDENTITY)

    # Same identity re-booted targets the same two names — that sameness is
    # what lets the pre-remove clear its own leftover.
    assert _created(first) == _created(again)
    assert set(_created(first)).isdisjoint(_created(other))

    # And a boot clears its own names only: a sibling cell is never touched.
    other_names = _names(OTHER_IDENTITY)
    assert _removed(other) == [other_names["candidate"], other_names["forwarder"]]
    assert set(_removed(other)).isdisjoint(_removed(first))
    assert set(_removed(other)).isdisjoint(_created(first))


def test_stop_tears_down_exactly_the_names_start_created(monkeypatch) -> None:
    starts: list[list[str]] = []
    _stub_start(monkeypatch, starts)
    _start(IDENTITY)
    created = _created(starts)

    stops: list[list[str]] = []
    _stub_start(monkeypatch, stops)
    play.stop(IDENTITY)

    # The identity string is the teardown key: stop recomputes the same names
    # start hashed, so the preview a user can see is the one stop removes.
    assert _removed(stops) == created
    assert ["docker", "network", "rm", _names(IDENTITY)["network"]] in stops


def test_a_container_that_survives_removal_fails_the_start(monkeypatch) -> None:
    names = _names(IDENTITY)
    calls: list[list[str]] = []
    _stub_start(
        monkeypatch,
        calls,
        present=(names["candidate"],),
        stuck=(names["candidate"],),
    )

    try:
        _start(IDENTITY)
    except play.PlayError as exc:
        assert exc.code == "start_failed"
        assert names["candidate"] in exc.reason
    else:
        raise AssertionError("a stale container that survives rm -f must fail start")

    # Nothing is created on top of a name that is provably still taken.
    assert _created(calls) == []


def test_docker_worker_import_stays_inside_start() -> None:
    source = Path(play.__file__).read_text(encoding="utf-8")
    module_level = source.split("def start(", 1)[0]

    assert "docker_worker" not in module_level


def test_network_argv_is_internal_and_labeled_with_its_owner() -> None:
    argv = build_network_argv("okp-play-abc-net", "hold")

    assert argv[:3] == ["docker", "network", "create"]
    assert "--internal" in argv
    assert _values(argv, "--label") == ["okp.play=1", "okp.play.owner=hold"]
    assert argv[-1] == "okp-play-abc-net"


def test_no_anonymous_volume_outlives_a_session() -> None:
    # The grader image declares VOLUME /out; without a tmpfs over it every play
    # session would leave an anonymous disk volume behind.
    for argv in (_candidate(), _forwarder()):
        assert "/out:size=16m" in _values(argv, "--tmpfs")


def test_candidate_command_quotes_what_the_candidate_declared() -> None:
    # The flags and entrypoint come from a model-written package.json: a path
    # with a space or a shell metacharacter must arrive as ONE argument.
    inner = _candidate(
        container_entrypoint="/tmp/app/src/my server.ts",
        flags=["--title=$(id)"],
    )[-1]

    assert inner.endswith("exec node '--title=$(id)' '/tmp/app/src/my server.ts'")


def test_reap_for_one_owner_filters_on_that_owner(monkeypatch) -> None:
    calls: list[list[str]] = []

    def fake_run(argv: list[str]):
        calls.append(argv)
        return play.subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

    monkeypatch.setattr(play, "_run", fake_run)
    play.reap(owner="control")

    listings = [c for c in calls if c[1] in ("ps", "network")]
    assert len(listings) == 2
    for argv in listings:
        assert "label=okp.play.owner=control" in argv
        assert "label=okp.play=1" in argv


def test_a_wedged_docker_call_fails_instead_of_hanging(monkeypatch) -> None:
    def hang(*args, **kwargs):
        raise play.subprocess.TimeoutExpired(cmd=args[0], timeout=play.DOCKER_TIMEOUT_S)

    monkeypatch.setattr(play.subprocess, "run", hang)
    try:
        play._run(["docker", "ps"])
    except play.PlayError as exc:
        assert exc.code == "docker_timeout"
    else:
        raise AssertionError("a docker call that never returns must raise")
