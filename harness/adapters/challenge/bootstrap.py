"""Cell-bootstrap methods for the challenge runner.

Extracted VERBATIM from harness/adapters/challenge/__init__.py
(WO-LI15-I2C STAGE 2C) into a role mixin: ChallengeRunner inherits
BootstrapMixin, so every self./cls. cross-call resolves through the MRO
with zero call-site changes. This module must not import from the package
__init__ at module level -- the package __init__ imports this module.

LATE-BOUND SEAM (the only one): _build_cell_config consumes
DockerCellConfig, which tests monkeypatch ON THE PACKAGE
(challenge_mod.DockerCellConfig in test_challenge_budget_stop.py and
test_snapshot_capture.py), so this module does NOT import DockerCellConfig
at the top; the method reads the package attribute into a local once per
call -- same pattern as hold_ui.py's _HOLD_UI_PORT late-bind. The
harness.grader_run-style names this module needs
(build_worker_opencode_config) are not monkeypatched anywhere, so they
import directly. subprocess is the dual-safe module singleton:
monkeypatching challenge_mod.subprocess.run patches the same module
object this module's `import subprocess` resolves to.
"""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess

from .constants import _GRADER_DIR
from harness.adapters.docker_worker import worker_config_host_dir
from harness.egress import EGRESS_MEMORY_PORT
from harness.memory_slot import memory_settings, memory_upstream, redacted

from .worker_config import build_worker_opencode_config


class BootstrapMixin:
    def _write_worker_permission_config(self, *, worktree: Path) -> None:
        gates_dir = str(_GRADER_DIR.resolve())
        golden_dir = str((self.task_dir / "golden").resolve())
        # The memory plugin is loaded in memory-ON cells only: listing it is what
        # switches memory on. The baked plugin is stashed by the Docker arm beside
        # the image-identity probe.
        baked = getattr(self, "_baked_plugin", None)
        plugin_entry = baked.entry if (self.memory_mode == "on" and baked) else None
        config = build_worker_opencode_config(
            model=self.model,
            reasoning_effort=self.reasoning_effort,
            proxy_base_url=self.proxy_base_url,
            gates_dir=gates_dir,
            golden_dir=golden_dir,
            session_id=self.session_id,
            plugin_entry=plugin_entry,
        )
        session_header_set = bool(self.session_id)
        provider_id, _, model_id = self.model.partition("/")
        if provider_id and model_id:
            self._progress(
                "PROGRESS step=worker-permission-config "
                f"model_declared={model_id} provider={provider_id} "
                f"session_header_set={str(session_header_set).lower()}"
            )

        self._progress(
            "PROGRESS step=worker-permission-config-provider "
            f"provider={provider_id or 'none'} model={model_id or 'none'} "
            f"proxy_base_url_set={str(bool(self.proxy_base_url)).lower()} "
            f"session_header_set={str(session_header_set).lower()}"
        )

        # Output token caps are enforced via Docker env
        # OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX, not model `options.max_tokens`
        # in opencode.json.
        if provider_id and model_id and self.reasoning_effort is not None:
            self._progress(
                "PROGRESS step=worker-permission-config "
                f"reasoning_effort={self.reasoning_effort} model={self.model}"
            )
        # Outside the worktree: the permission rules name the grading and
        # reference folders, and anything in /work is readable by the model.
        config_dir = worker_config_host_dir(worktree)
        config_dir.mkdir(parents=True, exist_ok=True)
        (config_dir / "opencode.json").write_text(
            json.dumps(config, indent=2) + "\n", encoding="utf-8"
        )
        self._progress(
            "PROGRESS step=worker-permission-config external_directory=deny "
            "oracle_bash_deny=active task_deny=active skip_permissions_removed=true"
        )

    def _build_cell_config(
        self,
        *,
        worktree: Path,
        container_name: str,
        egress_host: str = "",
    ) -> DockerCellConfig:
        import harness.adapters.challenge as _pkg

        DockerCellConfig = (
            _pkg.DockerCellConfig
        )  # late-bound: tests patch the package attr; read once per call
        session_db_dir = worktree.parent / "session-db"
        session_db_dir.mkdir(parents=True, exist_ok=True)
        cell_config = DockerCellConfig(
            worktree=worktree,
            memory_mode=self.memory_mode,
            container_name=container_name,
        )
        cell_config.session_db_host_path = session_db_dir
        # Must exist before `docker run`, or Docker creates the mount source
        # itself; the file inside is written once the container is up.
        worker_config_host_dir(worktree).mkdir(parents=True, exist_ok=True)
        cell_config.output_token_max = self.max_output_tokens
        cell_config.proxy_base_url = self.proxy_base_url
        cell_config.proxy_token = self.proxy_token
        cell_config.cloud = self.cloud
        cell_config.require_todos = bool(self.require_todos)
        # When set, docker_worker runs this cell on the --internal egress
        # network and launches the sidecar of this name; empty = legacy path.
        cell_config.egress_host = egress_host
        cell_config.worker_logs_dir = worktree.parent / "worker-logs"
        cell_config.serve_host_port = self.serve_host_port
        cell_config.serve_container_port = self.serve_container_port
        if self.memory_mode == "on":
            # The memory system's server, reached through the sidecar's memory
            # route — or directly on the legacy bridge path, which has no sidecar.
            upstream = memory_upstream()
            if not upstream:
                memory_url = ""  # a memory system that keeps its state in files
            elif egress_host:
                memory_url = f"http://{egress_host}:{EGRESS_MEMORY_PORT}"
            else:
                memory_url = upstream
            cell_config.memory_upstream = upstream
            cell_config.memory_env = memory_settings(memory_url)
            # Recorded with the cell (memory_record.py), secrets masked.
            self._memory_config = {
                "upstream": upstream or None,
                "memory_url": memory_url or None,
                "settings": redacted(cell_config.memory_env),
            }
            self._progress(
                f"PROGRESS step=memory-config upstream={upstream or 'none'} "
                f"memory_url={memory_url or 'none'} "
                f"settings={self._memory_config['settings']}"
            )
        return cell_config

    def _init_worktree_git(self, *, worktree: Path) -> None:
        # opencode resolves the session worktree by walking up from --dir /work
        # looking for .git; with no .git at/above the bind-mount root it falls
        # back to "/". git-init the seeded worktree so every session resolves
        # worktree=/work — the project a memory plugin is handed.
        subprocess.run(
            ["git", "init"],
            cwd=str(worktree),
            capture_output=True,
            text=True,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.email", "dev@localhost"],
            cwd=str(worktree),
            capture_output=True,
            text=True,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "dev"],
            cwd=str(worktree),
            capture_output=True,
            text=True,
            check=True,
        )
        subprocess.run(
            ["git", "commit", "--allow-empty", "-m", "Initial commit"],
            cwd=str(worktree),
            capture_output=True,
            text=True,
            check=True,
        )
        self._progress(f"PROGRESS step=worktree-git-init path={worktree}")

    def _prepare_memory_mode(self, *, worktree: Path) -> bool:
        """Both arms start from the same worktree. Returns True for an OFF cell.

        Memory is switched on in the cell's opencode config (only a memory-ON
        cell lists the baked plugin — _write_worker_permission_config), never by
        files in the worktree: the model sees the worktree, so anything put there
        for one arm only would be a difference between the arms besides memory.
        A seed snapshot taken under the old OKP wiring can still carry its
        ``.okp/`` state dir; it is removed in both arms.
        """
        shutil.rmtree(worktree / ".okp", ignore_errors=True)
        pure = self.memory_mode != "on"
        self._progress(
            f"PROGRESS step=memory-mode mode={self.memory_mode} "
            f"pure={str(pure).lower()}"
        )
        return pure
