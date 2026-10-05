"""Free-port allocation for the per-run live-view serve.

Python mirror of control/play.mjs freePort(): bind port 0, read the
OS-assigned port, close. Two independent env readers (RunConfig and
ChallengeRunner) both default BENCH_SERVE_HOST_PORT to 8719, so two
concurrent cells collide on 127.0.0.1:8719; this module is the shared
allocation seam both resolve through.
"""

from __future__ import annotations

import os
import socket

SERVE_HOST_PORT_ENV = "BENCH_SERVE_HOST_PORT"
# Unset, empty, "0" and "auto" all mean "allocate a free port".
_AUTO_SENTINELS = frozenset({"", "0", "auto"})


def allocate_free_host_port(host: str = "127.0.0.1") -> int:
    """Return a free loopback TCP port assigned by the OS.

    Mirrors control/play.mjs freePort(): bind port 0, read the OS-assigned
    port, close. The close-before-bind race is accepted — a failed later bind
    is loud, never silent.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def resolve_serve_host_port() -> int:
    """The per-run live-view host port, allocated once if not pinned.

    Pin it with BENCH_SERVE_HOST_PORT=<positive int>. Otherwise allocate a
    free port and export it to the environment so every reader (RunConfig,
    ChallengeRunner, _discover_bench_ports) resolves the SAME value — a
    divergent read would publish the serve on one port and attach the operator
    to another.
    """
    raw = (os.environ.get(SERVE_HOST_PORT_ENV) or "").strip()
    if raw.lower() in _AUTO_SENTINELS:
        port = allocate_free_host_port()
        os.environ[SERVE_HOST_PORT_ENV] = str(port)
        return port
    try:
        port = int(raw)
    except ValueError as exc:
        raise ValueError(
            f"{SERVE_HOST_PORT_ENV}={raw!r} is not a valid port number"
        ) from exc
    if port <= 0:
        raise ValueError(f"{SERVE_HOST_PORT_ENV} must be a positive port, got {raw!r}")
    return port
