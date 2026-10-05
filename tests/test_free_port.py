"""Unit tests for harness.free_port — free-port allocation + env resolution."""

from __future__ import annotations

import os

import pytest

from harness.free_port import (
    SERVE_HOST_PORT_ENV,
    allocate_free_host_port,
    resolve_serve_host_port,
)


def test_allocate_free_host_port_returns_positive_int() -> None:
    port = allocate_free_host_port()
    assert isinstance(port, int)
    assert port > 0


def test_allocate_free_host_port_two_calls_distinct() -> None:
    # The close-before-bind race means the OS may rarely hand back the same
    # port twice; loop up to 20 times and require at least one distinct pair.
    distinct = False
    for _ in range(20):
        first = allocate_free_host_port()
        second = allocate_free_host_port()
        if first != second:
            distinct = True
            break
    assert distinct, (
        "allocate_free_host_port() never returned two distinct ports in 20 attempts"
    )


def test_resolve_pinned_env_returns_exact_port_without_overwrite(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(SERVE_HOST_PORT_ENV, "9111")
    assert resolve_serve_host_port() == 9111
    assert os.environ[SERVE_HOST_PORT_ENV] == "9111"


def test_resolve_unset_env_allocates_and_exports(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(SERVE_HOST_PORT_ENV, raising=False)
    port = resolve_serve_host_port()
    assert port > 0
    assert os.environ[SERVE_HOST_PORT_ENV] == str(port)


@pytest.mark.parametrize("sentinel", ["0", "auto"])
def test_resolve_auto_sentinels_allocate_and_export(
    monkeypatch: pytest.MonkeyPatch, sentinel: str
) -> None:
    monkeypatch.setenv(SERVE_HOST_PORT_ENV, sentinel)
    port = resolve_serve_host_port()
    assert port > 0
    assert os.environ[SERVE_HOST_PORT_ENV] == str(port)


def test_resolve_non_numeric_env_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(SERVE_HOST_PORT_ENV, "garbage")
    with pytest.raises(ValueError):
        resolve_serve_host_port()
