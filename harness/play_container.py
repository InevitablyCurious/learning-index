"""Run a candidate's server inside the grader image — the play-time container recipe.

WHY THIS MODULE EXISTS
----------------------
A candidate's build used to be STARTED as a host process: the operator's
``node``, the operator's ``~/.ssh``, the operator's Docker socket, the
operator's worktree writable. A model-authored start script is untrusted input;
the host is the one place it must never execute.

So play-time runs the candidate the same way grading does — inside the grader
image — but with no route it did not earn:

* ``--internal`` network: no internet, no host gateway.
* ``--user 1000:1000``, ``--read-only``, ``--cap-drop ALL``,
  ``no-new-privileges``, PID/memory/CPU caps, no mounted socket, no host env.
* The worktree is mounted **read-only** at ``/candidate`` and copied into the
  writable tmpfs ``/tmp/app`` at start — the same fresh-checkout shape the
  grader gives a candidate, so a candidate that rewrites its own tree does not
  die on EROFS.
* A hard lifetime via coreutils ``timeout``, because the image's own
  ``ENTRYPOINT`` is ``node report.mjs`` and this overrides it.
* ``/out``, the image's declared ``VOLUME`` for grading reports, is a tmpfs
  here, so no anonymous disk volume outlives a session.

The operator still has to *look* at the thing, and ``-p`` is silently dropped
on an ``--internal``-only container. A second, dual-homed container publishes
``127.0.0.1:<free port>`` on the default bridge and forwards TCP to
``<candidate>:8002`` over the internal network — so the browser reaches the
candidate without the candidate reaching anything.

Layout of what ``start`` creates, all named deterministically from the session
identity string so a later ``stop``/``reap`` needs nothing but that string::

    okp-play-<sha12>-net    docker network (--internal)
    okp-play-<sha12>-cand   the candidate, on -net only
    okp-play-<sha12>-fwd    TCP forwarder, on -net + bridge, publishes the port

Every name is <= 27 characters, well inside Docker's 63-char DNS label limit,
so the forwarder can resolve the candidate by container name with no alias.

The CLI is the contract the JS callers (``control/play.mjs``,
``control/livebuild.mjs``, ``hold_ui.py``) spawn: it prints EXACTLY ONE JSON
line on stdout and never anything else.
"""

from __future__ import annotations

import hashlib
import json
import os
import shlex
import subprocess
from pathlib import Path

from harness.grader_image import IMAGE
from harness.grader_run import GraderImageMissing, assert_image_available

#: Applied to every container this module creates, so ``reap`` can find them
#: without knowing any session identity. Networks carry it too.
PLAY_LABEL = "okp.play=1"
PLAY_LABEL_KEY = "okp.play"

#: The candidate listens here inside its container; the forwarder publishes it.
CANDIDATE_PORT = 8002

#: Hard lifetime for a play container, overridable per call.
MAX_SECONDS_ENV = "OKP_PLAY_MAX_S"
DEFAULT_MAX_SECONDS = 21600

#: Leash on any single docker call: a wedged daemon must fail the start, not hang
#: the caller (the hold path has no outer timeout of its own).
DOCKER_TIMEOUT_S = 120

#: Minimal TCP forwarder: bridge-side ingress -> internal-network candidate.
#: Deliberately NOT harness/egress.py's sidecar — that one hardcodes its
#: 4545/8443 upstreams unconditionally and has no ingress-only mode.
FORWARDER_SCRIPT = (
    "const net=require('node:net');"
    "const [target,portStr]=process.argv.slice(1);"
    "const port=Number(portStr||'8002');"
    "const srv=net.createServer((from)=>{"
    "const to=net.connect(port,target);"
    "from.pipe(to);to.pipe(from);"
    "to.on('error',()=>from.destroy());"
    "from.on('error',()=>to.destroy());"
    "});"
    "srv.listen(port,'0.0.0.0');"
)


class PlayError(RuntimeError):
    """A play-container operation failed, with a machine-readable code.

    ``code`` is the stable part the JS callers switch on; ``reason`` carries
    the operator-facing detail (docker's own stderr, the resolver's output).
    """

    def __init__(self, code: str, reason: str) -> None:
        super().__init__(f"{code}: {reason}")
        self.code = code
        self.reason = reason


def _names(name: str) -> dict[str, str]:
    """The deterministic container/network names for a session identity.

    Hashed, not slugified: the identity string is caller-chosen and may be
    arbitrarily long or hostile, while every name here has to stay a legal
    Docker DNS label — and ``stop``/``reap`` must be able to recompute it.
    """
    base = "okp-play-" + hashlib.sha256(name.encode()).hexdigest()[:12]
    return {
        "base": base,
        "candidate": base + "-cand",
        "forwarder": base + "-fwd",
        "network": base + "-net",
    }


def _detail(result: subprocess.CompletedProcess[str]) -> str:
    text = ((result.stdout or "") + (result.stderr or "")).strip()
    return text or f"exit {result.returncode}"


def _run(argv: list[str]) -> subprocess.CompletedProcess[str]:
    """Run docker, mapping an unreachable daemon/CLI to ``docker_missing``."""
    try:
        return subprocess.run(
            argv,
            capture_output=True,
            text=True,
            check=False,
            timeout=DOCKER_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired as exc:
        raise PlayError(
            "docker_timeout",
            f"{' '.join(argv[:3])} did not return within {DOCKER_TIMEOUT_S}s",
        ) from exc
    except FileNotFoundError as exc:
        raise PlayError(
            "docker_missing", f"docker CLI not found in PATH: {exc}"
        ) from exc
    except OSError as exc:
        raise PlayError("docker_missing", f"docker is unreachable: {exc}") from exc


def _resolve_start_command(worktree: Path) -> tuple[str, list[str]]:
    """Resolve the candidate's declared start command, flags preserved.

    Delegates to the grader's own resolver rather than re-parsing
    ``package.json`` here: two parsers for one declaration is how the play
    runtime and the grading runtime drift into starting different commands.
    The resolver returns a HOST path; the container sees the worktree copied to
    ``/tmp/app``, so the path is rebased onto that root.
    """
    entrypoint_mjs = (
        Path(__file__).resolve().parents[1] / "grader" / "lib" / "entrypoint.mjs"
    )
    script = (
        "import { resolveStartCommand } from "
        + repr(str(entrypoint_mjs))
        + ";"
        + " const r=resolveStartCommand(process.argv[1]);"
        + " console.log(JSON.stringify(r));"
    )
    try:
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script, str(worktree)],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as exc:
        raise PlayError("no_entrypoint", f"node is not runnable: {exc}") from exc

    if result.returncode != 0:
        raise PlayError(
            "no_entrypoint",
            f"resolveStartCommand failed for {worktree}: {_detail(result)}",
        )
    try:
        data = json.loads(result.stdout)
    except ValueError as exc:
        raise PlayError(
            "no_entrypoint",
            f"resolveStartCommand printed unparseable output: "
            f"{(result.stdout or '').strip()!r}",
        ) from exc
    entrypoint = str((data or {}).get("entrypoint") or "")
    if not entrypoint:
        raise PlayError("no_entrypoint", f"no entrypoint declared in {worktree}")

    rel = os.path.relpath(entrypoint, worktree)
    return "/tmp/app/" + rel, list((data or {}).get("flags") or [])


def build_candidate_argv(
    *,
    candidate_name: str,
    network_name: str,
    worktree: str,
    owner: str,
    cell: str,
    debug_api: bool,
    container_entrypoint: str,
    flags: list[str],
    max_seconds: int,
    image: str = IMAGE,
) -> list[str]:
    """The ``docker run`` argv for the candidate. Pure: builds tokens only.

    The command is ``timeout <max_seconds> sh -c "<copy, then exec node>"``:
    ``--entrypoint timeout`` replaces the image's ``ENTRYPOINT ["node",
    "report.mjs"]``, and the lifetime is enforced INSIDE the container so a
    wedged candidate cannot outlive its budget even if the host-side reaper
    never runs.
    """
    # The flags and entrypoint come from the candidate's own package.json, so
    # each is quoted: a path with a space must stay one argument.
    inner = "cp -a /candidate/. /tmp/app/ && cd /tmp/app && exec " + shlex.join(
        ["node", *flags, container_entrypoint]
    )
    argv = [
        "docker",
        "run",
        "-d",
        "--name",
        candidate_name,
        "--network",
        network_name,
        "--user",
        "1000:1000",
        "--read-only",
        "--tmpfs",
        "/tmp:mode=1777,size=512m",
        "--tmpfs",
        "/out:size=16m",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "256",
        "--memory",
        "1g",
        "--cpus",
        "2",
        "--label",
        PLAY_LABEL,
        "--label",
        f"okp.play.owner={owner}",
        "--label",
        f"okp.play.cell={cell}",
        "-v",
        f"{worktree}:/candidate:ro",
        "-e",
        f"PORT={CANDIDATE_PORT}",
    ]
    if debug_api:
        argv += ["-e", "DEBUG_API=1"]
    argv += [
        "--entrypoint",
        "timeout",
        image,
        str(max_seconds),
        "sh",
        "-c",
        inner,
    ]
    return argv


def build_forwarder_argv(
    *,
    forwarder_name: str,
    owner: str,
    cell: str,
    host_port: int,
    candidate_name: str,
    max_seconds: int,
    image: str = IMAGE,
) -> list[str]:
    """The ``docker run`` argv for the TCP forwarder. Pure: builds tokens only.

    Runs on the default ``bridge`` network, because that is where the ``-p``
    publish is real — docker silently drops ``-p`` on an internal-only
    container, and the bridge is the textbook case that definitely works.

    It is *then* attached to the per-session ``--internal`` network by
    ``_connect_network`` from ``start()``: that network is where
    ``<candidate>:8002`` resolves. It cannot be done in this one ``docker run``
    — docker rejects mixing a user-defined network with the default bridge in a
    single invocation (``conflicting options: cannot attach both user-defined
    and non-user-defined network-modes``, rc 125).

    ``-e`` comes AFTER the image token, so docker stops parsing options there
    and node receives ``-e <script> <candidate> 8002`` as its own args. The
    forwarder gets the same ``timeout`` lifetime as its candidate, so an
    orphaned one does not keep publishing a port that answers nothing.
    """
    return [
        "docker",
        "run",
        "-d",
        "--name",
        forwarder_name,
        "--network",
        "bridge",
        "--user",
        "1000:1000",
        "--read-only",
        "--tmpfs",
        "/tmp:mode=1777,size=512m",
        "--tmpfs",
        "/out:size=16m",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "256",
        "--memory",
        "1g",
        "--cpus",
        "2",
        "--label",
        PLAY_LABEL,
        "--label",
        f"okp.play.owner={owner}",
        "--label",
        f"okp.play.cell={cell}",
        "-p",
        f"127.0.0.1:{host_port}:{CANDIDATE_PORT}",
        "--entrypoint",
        "timeout",
        image,
        str(max_seconds),
        "node",
        "-e",
        FORWARDER_SCRIPT,
        candidate_name,
        str(CANDIDATE_PORT),
    ]


def build_network_argv(network_name: str, owner: str) -> list[str]:
    """The ``docker network create`` argv for a play network. Pure.

    ``--internal`` gives the candidate zero internet and no host gateway;
    the labels are what let ``reap`` find the network after a crash, and only
    its own owner's.
    """
    return [
        "docker",
        "network",
        "create",
        "--internal",
        "--label",
        PLAY_LABEL,
        "--label",
        f"okp.play.owner={owner}",
        network_name,
    ]


def _ensure_play_network(name: str, owner: str) -> None:
    """Create the play network if absent (idempotent). Raises PlayError on failure."""
    inspected = _run(["docker", "network", "inspect", name])
    if inspected.returncode == 0:
        return
    created = _run(build_network_argv(name, owner))
    if created.returncode == 0:
        return
    if "already exists" in _detail(created).lower():
        return
    raise PlayError(
        "start_failed", f"docker network create failed for {name}: {_detail(created)}"
    )


def _connect_network(container: str, network: str) -> None:
    """Attach a running container to a network. Raises PlayError on failure."""
    result = _run(["docker", "network", "connect", network, container])
    if result.returncode != 0:
        raise PlayError(
            "start_failed",
            f"docker network connect {network} {container} failed: {_detail(result)}",
        )


def _rm_container(name: str, *, code: str) -> bool:
    """``docker rm -f`` one container. ``True`` only if something was removed."""
    # -v: also remove the container's anonymous volumes, so nothing outlives it.
    result = _run(["docker", "rm", "-f", "-v", name])
    if result.returncode == 0:
        return True
    detail = _detail(result)
    if "no such container" in detail.lower():
        return False
    raise PlayError(code, f"docker rm -f {name} failed: {detail}")


def _rm_network(name: str, *, code: str) -> bool:
    """``docker network rm`` one network. ``True`` only if something was removed."""
    result = _run(["docker", "network", "rm", name])
    if result.returncode == 0:
        return True
    detail = _detail(result)
    lowered = detail.lower()
    if "no such network" in lowered or "not found" in lowered:
        return False
    raise PlayError(code, f"docker network rm {name} failed: {detail}")


def _container_lingering(name: str) -> bool:
    """Exact-match existence check — a prefix match would lie about siblings."""
    result = _run(
        [
            "docker",
            "ps",
            "-a",
            "--filter",
            f"name=^{name}$",
            "--format",
            "{{.Names}}",
        ]
    )
    if result.returncode != 0:
        # Cannot verify: report it rather than claim a removal we did not see.
        return True
    return name in (result.stdout or "").split()


def _network_lingering(name: str) -> bool:
    result = _run(["docker", "network", "inspect", name])
    return result.returncode == 0


def start(
    *,
    name: str,
    worktree: str | Path,
    owner: str,
    cell: str,
    debug_api: bool = False,
    host_port: int | None = None,
    max_seconds: int | None = None,
) -> dict:
    """Start a candidate + its forwarder inside the grader image.

    Order matters: the image is asserted before anything is created (grading
    and play must run the same toolchain), the network exists before the
    candidate joins it, and the CANDIDATE starts before the forwarder — a
    forwarder whose target never came up would publish a port that answers
    nothing.
    """
    try:
        assert_image_available(IMAGE)
    except GraderImageMissing as exc:
        raise PlayError("image_missing", str(exc)) from exc

    names = _names(name)
    root = Path(worktree).resolve()
    container_entrypoint, flags = _resolve_start_command(root)

    # Order matters (see docstring): the network must exist before the
    # candidate tries to join it.
    _ensure_play_network(names["network"], owner)

    if host_port is None:
        from harness.free_port import allocate_free_host_port

        host_port = allocate_free_host_port()
    if max_seconds is None:
        max_seconds = int(os.environ.get(MAX_SECONDS_ENV, DEFAULT_MAX_SECONDS))

    candidate_argv = build_candidate_argv(
        candidate_name=names["candidate"],
        network_name=names["network"],
        worktree=str(root),
        owner=owner,
        cell=cell,
        debug_api=debug_api,
        container_entrypoint=container_entrypoint,
        flags=flags,
        max_seconds=max_seconds,
    )
    forwarder_argv = build_forwarder_argv(
        forwarder_name=names["forwarder"],
        owner=owner,
        cell=cell,
        host_port=host_port,
        candidate_name=names["candidate"],
        max_seconds=max_seconds,
    )

    started = _run(candidate_argv)
    if started.returncode != 0:
        raise PlayError(
            "start_failed", f"candidate container failed to start: {_detail(started)}"
        )

    forwarded = _run(forwarder_argv)
    if forwarded.returncode != 0:
        try:
            _rm_container(names["candidate"], code="start_failed")
        except PlayError:
            pass
        raise PlayError(
            "start_failed", f"forwarder container failed to start: {_detail(forwarded)}"
        )

    # The forwarder was started on the default bridge (so its ``-p`` publish is
    # real); it can only resolve ``<candidate>:8002`` once it joins the
    # internal network, and docker refuses to do both in one ``docker run``.
    try:
        _connect_network(names["forwarder"], names["network"])
    except PlayError:
        for cleanup in (names["forwarder"], names["candidate"]):
            try:
                _rm_container(cleanup, code="start_failed")
            except PlayError:
                pass
        raise

    return {
        "ok": True,
        "name": name,
        "candidate": names["candidate"],
        "forwarder": names["forwarder"],
        "network": names["network"],
        "host_port": int(host_port),
        "url": f"http://localhost:{host_port}/",
    }


def stop(name: str) -> dict:
    """Tear down everything ``start`` created for ``name``. Idempotent.

    Order matters: the network cannot be removed while containers are attached,
    and every removal is re-checked by exact name afterwards — a ``docker rm``
    that reported success is not the same fact as a container that is gone.
    """
    names = _names(name)
    removed: list[str] = []
    for key in ("candidate", "forwarder"):
        target = names[key]
        if _rm_container(target, code="stop_failed"):
            removed.append(target)
    if _rm_network(names["network"], code="stop_failed"):
        removed.append(names["network"])

    lingering = [
        names[k] for k in ("candidate", "forwarder") if _container_lingering(names[k])
    ]
    if _network_lingering(names["network"]):
        lingering.append(names["network"])

    return {
        "ok": True,
        "name": name,
        "candidate": names["candidate"],
        "forwarder": names["forwarder"],
        "network": names["network"],
        "removed": removed,
        "lingering": lingering,
    }


def reap(except_names: list[str] | None = None, owner: str | None = None) -> dict:
    """Remove every ``okp.play=1`` container and network, except kept sessions.

    The label is the only inventory that survives a crash: a caller that lost
    its state still finds everything, and ``except_names`` (session identity
    strings, not container names) protects the cells that are still running.
    ``owner`` narrows the sweep to one owner's sessions, so the board's Stop
    never removes a hold-review container a running harness still serves.
    """
    keep = [k for k in (except_names or []) if k]
    label_filter = f"label={PLAY_LABEL_KEY}=1"
    owner_filter = (
        [] if owner is None else ["--filter", f"label=okp.play.owner={owner}"]
    )
    # A caller may hand us the session identity it spawned with, or the base
    # name it read back off the containers. Normalise both to the base so the
    # keep-rule is one comparison.
    kept_bases = {k if k.startswith("okp-play-") else _names(k)["base"] for k in keep}
    try:
        listed = _run(
            [
                "docker",
                "ps",
                "-a",
                "--filter",
                label_filter,
                *owner_filter,
                "--format",
                "{{.Names}}",
            ]
        )
        listed_nets = _run(
            [
                "docker",
                "network",
                "ls",
                "--filter",
                label_filter,
                *owner_filter,
                "--format",
                "{{.Name}}",
            ]
        )
        if listed.returncode != 0 or listed_nets.returncode != 0:
            detail = _detail(listed if listed.returncode != 0 else listed_nets)
            return {
                "ok": False,
                "code": "docker_missing",
                "reason": f"docker is unreachable: {detail}",
                "removed_containers": [],
                "removed_networks": [],
                "lingering": [],
            }
    except PlayError as exc:
        return {
            "ok": False,
            "code": exc.code,
            "reason": exc.reason,
            "removed_containers": [],
            "removed_networks": [],
            "lingering": [],
        }

    def _kept(target: str) -> bool:
        return any(target.startswith(base + "-") for base in kept_bases)

    containers = [c for c in (listed.stdout or "").split() if c.startswith("okp-play-")]
    networks = [
        n for n in (listed_nets.stdout or "").split() if n.startswith("okp-play-")
    ]

    removed_containers: list[str] = []
    removed_networks: list[str] = []
    lingering: list[str] = []

    for container in containers:
        if _kept(container):
            continue
        if _rm_container(container, code="reap_failed"):
            removed_containers.append(container)
    for network in networks:
        if _kept(network):
            continue
        if _rm_network(network, code="reap_failed"):
            removed_networks.append(network)

    for container in containers:
        if not _kept(container) and _container_lingering(container):
            lingering.append(container)
    for network in networks:
        if not _kept(network) and _network_lingering(network):
            lingering.append(network)

    return {
        "ok": True,
        "removed_containers": removed_containers,
        "removed_networks": removed_networks,
        "lingering": lingering,
    }


def main(argv: list[str] | None = None) -> int:
    """CLI: exactly one JSON line on stdout, exit 0 on ok else 1."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Run a candidate's server inside the grader image.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_start = sub.add_parser("start", help="start a candidate + its forwarder")
    p_start.add_argument("--name", required=True, help="session identity string")
    p_start.add_argument("--worktree", required=True, help="candidate worktree")
    p_start.add_argument("--owner", required=True)
    p_start.add_argument("--cell", required=True)
    p_start.add_argument("--debug-api", action="store_true")
    p_start.add_argument("--host-port", type=int, default=None)
    p_start.add_argument("--max-seconds", type=int, default=None)

    p_stop = sub.add_parser("stop", help="tear down one session's containers")
    p_stop.add_argument("--name", required=True, help="session identity string")

    p_reap = sub.add_parser("reap", help="remove every play container and network")
    p_reap.add_argument(
        "--except",
        dest="except_names",
        action="append",
        default=[],
        help="session identity string to keep (repeatable)",
    )
    p_reap.add_argument(
        "--owner", default=None, help="only this owner's sessions (control|hold)"
    )

    args = parser.parse_args(argv)
    try:
        if args.command == "start":
            result = start(
                name=args.name,
                worktree=args.worktree,
                owner=args.owner,
                cell=args.cell,
                debug_api=args.debug_api,
                host_port=args.host_port,
                max_seconds=args.max_seconds,
            )
        elif args.command == "stop":
            result = stop(args.name)
        else:
            result = reap(args.except_names, owner=args.owner)
    except PlayError as exc:
        print(json.dumps({"ok": False, "code": exc.code, "reason": exc.reason}))
        return 1
    except Exception as exc:  # noqa: BLE001 - the CLI's whole job is one JSON line
        print(json.dumps({"ok": False, "code": "unexpected", "reason": str(exc)}))
        return 1

    print(json.dumps(result))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
