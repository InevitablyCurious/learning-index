"""Utility methods for the backgammon runner.

Extracted VERBATIM from harness/adapters/backgammon/__init__.py
(WO-LI15-I2A STAGE 2A) into a role mixin: BackgammonRunner inherits
UtilsMixin, so every self./cls. cross-call resolves through the MRO with
zero call-site changes. This module must not import from the package
__init__ -- the package __init__ imports this module.
"""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
from typing import Any


class UtilsMixin:
    @staticmethod
    def _copy_tree_contents(src_dir: Path, dst_dir: Path) -> None:
        if not src_dir.is_dir():
            raise FileNotFoundError(f"source directory does not exist: {src_dir}")

        dst_dir.mkdir(parents=True, exist_ok=True)
        for item in src_dir.iterdir():
            target = dst_dir / item.name
            if item.is_dir():
                shutil.copytree(item, target, dirs_exist_ok=True)
            else:
                shutil.copy2(item, target)

    @staticmethod
    def _kill_process_group(proc: subprocess.Popen[str]) -> None:
        if proc.poll() is not None:
            return
        try:
            pgid = os.getpgid(proc.pid)
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            return

    def _provider_backoff(self, seconds: float) -> None:
        """Wait out a provider outage before re-prompting.

        Its own method so tests can drive the recovery path without sleeping,
        and so the wait is observable rather than buried in the drive loop.
        """
        if seconds > 0:
            time.sleep(seconds)

    def _progress(self, message: str) -> None:
        self._progress_cb(message)
        if self.logger is None:
            return

        info = getattr(self.logger, "info", None)
        if callable(info):
            info(message)

    @staticmethod
    def _to_int(value: Any) -> int:
        try:
            if value is None:
                return 0
            return int(value)
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _normalize_string_list(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        out: list[str] = []
        for item in value:
            text = str(item).strip()
            if text:
                out.append(text)
        return out

    @staticmethod
    def _normalize_problems(value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        normalized: list[dict[str, Any]] = []
        for item in value:
            if not isinstance(item, dict):
                normalized.append(
                    {"check": "unknown", "expected": "", "observed": str(item)}
                )
                continue
            normalized.append(
                {
                    "check": str(item.get("check", "unknown")),
                    "expected": str(item.get("expected", "")),
                    "observed": str(item.get("observed", "")),
                }
            )
        return normalized
