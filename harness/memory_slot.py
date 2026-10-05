"""The memory slot's host-side settings: what a memory-ON cell is given.

A memory system enters the benchmark as an opencode plugin baked into the
worker image (BENCH_PLUGIN_DIR). Everything else it needs at run time comes
from the operator's environment and reaches memory-ON cells only:

- BENCH_MEMORY_UPSTREAM: the memory system's server, as the egress sidecar
  reaches it (scheme://host:port, e.g. http://host.docker.internal:8000). It
  opens the sidecar's memory route (harness/egress.py). Unset: no route — a
  memory system that keeps its state in files needs none.
- BENCH_MEMORY_ENV: a file of the plugin's own settings, one NAME=value per
  line, passed into the worker by name. ``{memory_url}`` in a value becomes the
  address the cell reaches the server at, e.g. ``HONCHO_BASE_URL={memory_url}``.

The benchmark reads these settings; it never interprets them. Which names a
plugin needs is the memory system's business.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

ENV_MEMORY_UPSTREAM = "BENCH_MEMORY_UPSTREAM"
ENV_MEMORY_ENV = "BENCH_MEMORY_ENV"

#: The placeholder a settings value may use for the server's in-cell address.
MEMORY_URL_PLACEHOLDER = "{memory_url}"

_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

#: Names that decide what the cell is and what it measures, not what memory
#: does: the benchmark sets them itself, the docker CLI that starts the cell
#: reads them (the settings travel in its env), or they reroute or reshape the
#: worker's runtime. A memory system's settings may not use them.
_RESERVED = re.compile(
    r"^(HOME|PATH|XDG_.*|OPENCODE_.*|BENCH_.*|LOCAL_LLM_PROXY_API_KEY"
    r"|ORCAROUTER_API_KEY|REQUIRE_TODOS|NODE_PATH|NODE_OPTIONS|PLAYWRIGHT_.*"
    r"|DOCKER_.*|(HTTP|HTTPS|ALL|NO)_PROXY)$",
    re.IGNORECASE,
)

#: Settings whose values are never recorded or printed.
_SECRET = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH", re.IGNORECASE)


def memory_upstream(env: dict | None = None) -> str:
    """The memory server's origin as the sidecar reaches it, or "" for none."""
    return (env if env is not None else os.environ).get(ENV_MEMORY_UPSTREAM, "").strip()


def parse_settings(text: str) -> dict[str, str]:
    """NAME=value lines; blank lines, ``#`` comments and ``export`` are allowed.

    Raises ValueError on a malformed line or a reserved name, naming the line.
    """
    settings: dict[str, str] = {}
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ").strip()
        name, sep, value = line.partition("=")
        name = name.strip()
        if not sep or not _NAME.match(name):
            raise ValueError(f"line {number}: expected NAME=value, got {raw!r}")
        if _RESERVED.match(name):
            raise ValueError(
                f"line {number}: {name} is reserved by the benchmark and cannot "
                "be a memory setting"
            )
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        settings[name] = value
    return settings


def memory_settings(memory_url: str, env: dict | None = None) -> dict[str, str]:
    """The plugin's settings from the BENCH_MEMORY_ENV file, placeholder filled.

    Unset: no settings. Set to a file that is not there: an error, because a
    memory-ON cell run without the settings its operator wrote would quietly
    measure a differently configured memory.
    """
    raw = (env if env is not None else os.environ).get(ENV_MEMORY_ENV, "").strip()
    if not raw:
        return {}
    path = Path(raw).expanduser()
    if not path.is_file():
        raise FileNotFoundError(f"{ENV_MEMORY_ENV}={raw} is not a file")
    settings = parse_settings(path.read_text(encoding="utf-8"))
    if not memory_url and any(MEMORY_URL_PLACEHOLDER in v for v in settings.values()):
        raise ValueError(
            f"{raw} uses {MEMORY_URL_PLACEHOLDER}, but {ENV_MEMORY_UPSTREAM} is "
            "not set: there is no memory server for it to name"
        )
    return {
        name: value.replace(MEMORY_URL_PLACEHOLDER, memory_url)
        for name, value in settings.items()
    }


def redacted(settings: dict[str, str]) -> dict[str, str]:
    """The settings as they may be recorded: secret-looking values masked."""
    return {
        name: ("***" if _SECRET.search(name) else value)
        for name, value in sorted(settings.items())
    }
