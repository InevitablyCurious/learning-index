"""Adapters that implement ``AgentRunner`` against concrete coding substrates."""

from __future__ import annotations

from .backgammon import BackgammonCellResult, BackgammonRunner

__all__ = [
    "BackgammonCellResult",
    "BackgammonRunner",
]
