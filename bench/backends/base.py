"""Shared payload datatypes for benchmark recall operations.

`NeedCard` is the recall request payload: INV-6 is structurally enforced — only `intent`
and `task` feed the dense/prose digest, keyword-like fields are isolated to the keyword
channel, and `to_wire` builds the probe body with MC-1 envelope symmetry.
`RecalledMemory` is a single recalled item with its score breakdown and decrypted
plaintext payload.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from bench.config import RunConfig


@dataclass
class RecalledMemory:
    """Single recalled memory item with score breakdown and decrypted plaintext payload."""

    cid: str | None
    score: float | None  # top-level freshness score
    vector_score: float | None  # breakdown.vector_score
    combined_score: float | None  # breakdown.combined_score
    keyword_score: float | None  # breakdown.keyword_score
    matched_keywords: list[str]
    text: str  # DECRYPTED plaintext; empty string if not delivered

    def has_content(self) -> bool:
        """Return True only when decrypted plaintext content is non-empty after trimming."""

        return bool(self.text.strip())


@dataclass
class NeedCard:
    """Need-card payload enforcing INV-6 channel separation for dense vs keyword signals."""

    # --- DENSE / prose channel (INV-6): the ONLY fields that feed prompt_digest ---
    intent: str
    task: str
    # --- KEYWORD channel: never enters the dense query; ride the keyword/boost channel ---
    language: str | None = None
    stack: list[str] = field(default_factory=list)
    frameworks: list[str] = field(default_factory=list)
    deps: list[str] = field(default_factory=list)
    error_strings: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    directory: str | None = None
    project_name: str | None = None
    query: str = ""  # raw query string the probe also sends; defaults to task in __post_init__ if empty

    def __post_init__(self) -> None:
        """Set the raw query channel to `task` when query is omitted."""

        if not self.query:
            self.query = self.task

    @property
    def prompt_digest(self) -> str:
        """INV-6 dense digest from ONLY intent and task, whitespace-collapsed, else `unknown`."""

        def collapse_whitespace(value: str) -> str:
            return re.sub(r"\s+", " ", value).strip()

        segments = [collapse_whitespace(self.intent), collapse_whitespace(self.task)]
        dense_segments = [segment for segment in segments if segment]
        if not dense_segments:
            return "unknown"
        return ". ".join(dense_segments)

    def to_wire(
        self, cfg: RunConfig, session_id: str, org_id: str | None = None
    ) -> dict:
        """Build the probe wire body with MC-1 envelope while keeping INV-6 digest client-only.

        NOTE (INV-6): `prompt_digest` is intentionally not a wire field. The server derives its
        dense query from intent+task; this method sends flat harvest fields + envelope only.
        """

        resolved_org_id = org_id or cfg.org_id
        recall_limit = (
            max(cfg.surface_budget, cfg.deterministic_recall_limit)
            if cfg.deterministic_topn
            else cfg.surface_budget
        )

        wire: dict[str, Any] = {
            "query": self.query,
            "intent": self.intent,
            "task": self.task,
            "org_id": resolved_org_id,
            "mc_version": cfg.mc_version,
            "session_id": session_id,
            "relevance_floor": cfg.relevance_floor(),
            "surface_budget": cfg.surface_budget,
            "limit": recall_limit,
        }

        if self.language:
            wire["language"] = self.language
        if self.stack:
            wire["stack"] = list(self.stack)
        if self.frameworks:
            wire["frameworks"] = list(self.frameworks)
        if self.deps:
            wire["deps"] = list(self.deps)
        if self.error_strings:
            wire["errorStrings"] = list(self.error_strings)
        if self.directory:
            wire["directory"] = self.directory
        if self.project_name:
            wire["projectName"] = self.project_name
        if self.files:
            wire["files"] = list(self.files)

        return wire
