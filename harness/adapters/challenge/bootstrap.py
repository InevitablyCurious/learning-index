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
call -- same pattern as hold_ui.py's _HOLD_UI_PORT late-bind. DockerCell
appears only as a parameter annotation (a string under PEP 563, never
evaluated at runtime), so importing it directly from ..docker_worker is
correct; the package-attr patch the tests set targets the runtime read in
_run_cell_impl, which stayed in __init__. The harness.grader_run-style
names this module needs (compact_phase_for, build_worker_opencode_config,
the _COMPACT_PHASE_* constants) are not monkeypatched anywhere, so they
import directly. subprocess is the dual-safe module singleton:
monkeypatching challenge_mod.subprocess.run patches the same module
object this module's `import subprocess` resolves to.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess

from ..docker_worker import DockerCell
from .constants import _COMPACT_PHASE_FILENAME, _COMPACT_PHASE_REPAIR, _GRADER_DIR
from .exceptions import ServeTransportError
from harness.adapters.docker_worker import worker_config_host_dir

from .transport import compact_phase_for
from .worker_config import build_worker_opencode_config


class BootstrapMixin:
    def _publish_compact_phase(
        self, *, active_cell: DockerCell, phase: str, held: bool = False
    ) -> None:
        """Write the drive phase the worker's compaction arm is allowed to read.

        Only meaningful when the run is compacting; a no-op otherwise, so a
        non-``--compact`` run neither creates the directory nor pays for it.

        WRITE-THEN-RENAME. The container reads this file on every
        ``session.idle`` and must never see a half-written value; a rename is
        atomic on the host and the mount propagates the directory entry, so a
        reader gets the old phase or the new one and never a truncated one.

        A FAILURE HERE IS AN ABORT. If the sentinel cannot be published, the
        plugin keeps reading the PREVIOUS phase — which, at the build->repair
        transition, is exactly the stale `build` that lets a repair-round
        compaction through. That is the defect this closes, so it must not be
        possible to continue past it with a warning.

        Since WO-MARKER-RIP the sentinel is the WHOLE gate (there is no longer
        a model-emitted marker as a second condition), so a stale value is not
        one signal of two going wrong — it is the only one.
        """
        if not self.compact:
            return
        host_dir = getattr(active_cell.config, "compact_phase_host_path", None)
        if host_dir is None:
            raise ServeTransportError(
                f"phase {phase}: --compact is armed but this cell has no phase "
                "sentinel path — the worker could not be told which phase it is "
                "in, and the sentinel is the ONLY thing that decides whether an "
                "idle may compact"
            )
        value = (
            _COMPACT_PHASE_REPAIR
            if held
            else compact_phase_for(phase)
        )
        target = Path(host_dir).expanduser().resolve() / _COMPACT_PHASE_FILENAME
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_suffix(".tmp")
            tmp.write_text(f"{value}\n", encoding="utf-8")
            os.replace(tmp, target)
        except OSError as exc:
            raise ServeTransportError(
                f"phase {phase}: could not publish the compaction phase sentinel "
                f"to {target} ({exc}) — the worker would keep reading the "
                "previous phase, which is how a repair-round compaction gets in"
            ) from exc
        if held:
            # A HOLD IS A SENTINEL-VALUE CORRECTION MID-DRIVE, NOT A PHASE
            # TRANSITION. The drive already announced this phase at its
            # boundary publish; re-emitting phase.start (or re-setting the
            # heartbeat's phase) here would falsely announce a restart.
            return
        self._progress(f"PROGRESS step=compact-phase phase={phase} sentinel={value}")
        # THE SAME BOUNDARY, ON THE LIVE STREAM. The log line above is the
        # operator's record; this is the UI's. They are emitted together so
        # they can never disagree about which phase is open.
        #
        # The heartbeat is told too, so every beat from here until the next
        # boundary names this phase — that is what turns "something is alive"
        # into "the build's chunk 5 is alive".
        live = getattr(self, "_live", None)
        if live is not None:
            live.emit(
                "phase.start",
                cell_seq=getattr(self, "_cell_seq", None),
                phase=str(phase),
            )
        heartbeat = getattr(self, "_heartbeat", None)
        if heartbeat is not None:
            heartbeat.set_phase(str(phase))

    def _write_worker_permission_config(self, *, worktree: Path) -> None:
        gates_dir = str(_GRADER_DIR.resolve())
        golden_dir = str((self.task_dir / "golden").resolve())
        # Stashed by the Docker arm beside the image-identity probe; default
        # True keeps direct/mock callers on the plugin-baked path.
        plugin_present = getattr(self, "_plugin_present", True)
        config = build_worker_opencode_config(
            model=self.model,
            reasoning_effort=self.reasoning_effort,
            proxy_base_url=self.proxy_base_url,
            gates_dir=gates_dir,
            golden_dir=golden_dir,
            session_id=self.session_id,
            plugin_present=plugin_present,
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
        DockerCellConfig = _pkg.DockerCellConfig  # late-bound: tests patch the package attr; read once per call
        session_db_dir = worktree.parent / "session-db"
        session_db_dir.mkdir(parents=True, exist_ok=True)
        cell_config = DockerCellConfig(
            worktree=worktree,
            memory_mode=self.memory_mode,
            container_name=container_name,
        )
        cell_config.session_db_host_path = session_db_dir
        # A2 phase sentinel: a sibling of the worktree, never inside it — the
        # model must not see instrument state, and the gates must not score it.
        cell_config.compact_phase_host_path = worktree.parent / "compact-phase"
        # Must exist before `docker run`, or Docker creates the mount source
        # itself; the file inside is written once the container is up.
        worker_config_host_dir(worktree).mkdir(parents=True, exist_ok=True)
        cell_config.output_token_max = self.max_output_tokens
        cell_config.proxy_base_url = self.proxy_base_url
        cell_config.proxy_token = self.proxy_token
        cell_config.cloud = self.cloud
        # Arms the worker plugin's self-fire (it resolves the model to compact
        # with from the session itself — the harness passes no model ids).
        cell_config.self_compact = bool(self.compact)
        cell_config.require_todos = bool(self.require_todos)
        # When set, docker_worker runs this cell on the --internal egress
        # network and launches the sidecar of this name; empty = legacy path.
        cell_config.egress_host = egress_host
        cell_config.worker_logs_dir = worktree.parent / "worker-logs"
        cell_config.serve_host_port = self.serve_host_port
        cell_config.serve_container_port = self.serve_container_port
        return cell_config

    def _init_worktree_git(self, *, worktree: Path) -> None:
        # opencode resolves the session worktree by walking up from --dir /work
        # looking for .git; with no .git at/above the bind-mount root it falls
        # back to "/", so the okp plugin reads /.okp/org.json (absent)
        # and the session stays DORMANT. git-init the seeded worktree so the
        # plugin resolves worktree=/work and reads /work/.okp/org.json.
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

        if self.memory_mode == "on":
            source_org = self._repo_root / ".okp" / "org.json"
            if not source_org.is_file():
                raise FileNotFoundError(f"missing required memory marker: {source_org}")

            marker_dir = worktree / ".okp"
            marker_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_org, marker_dir / "org.json")

            # Wire the bench-fixture predicate adapter: the plugin observes the
            # agent's own tool-call output, so the runner is copied into the cell
            # worktree (outside the frozen scaffold hash) and a predicate.json
            # declares the bench-fixture reporter. Missing runner source degrades
            # to a stderr warning while still writing predicate.json so existing
            # cells keep working.
            predicate = {"reporter": "bench-fixture", "command": "node bench-check.mjs"}
            marker_dir.joinpath("predicate.json").write_text(
                json.dumps(predicate), encoding="utf-8"
            )
            runner_source = self.task_dir / "bench" / "bench-check.mjs"
            if runner_source.is_file():
                shutil.copy2(runner_source, worktree / "bench-check.mjs")
            else:
                self._progress(
                    f"PROGRESS step=memory-mode warning=bench-runner-missing "
                    f"path={runner_source}"
                )

            self._progress(
                f"PROGRESS step=memory-mode mode=on marker={marker_dir / 'org.json'} "
                "recall_env_injection=container"
            )
            return False

        shutil.rmtree(worktree / ".okp", ignore_errors=True)
        self._progress("PROGRESS step=memory-mode mode=off pure=true")
        return True

    def _load_chunk_prompts(self) -> list[str]:
        """Load the WO-77 chunked first-pass prompts (task/backgammon/prompts/chunk-*.md).

        The chunked pass IS the initial pass — there is no monolith fallback.
        Missing or empty chunk data is a loud cell-prep error, never a skip.

        NO CAPTURE/COMPLIANCE PROTOCOL (2026-08-26). Chunk 1 used to carry an
        appended 193-line producer prompt (`scaffold/sxe-candidate/
        S-fork-reasoning.md`) instructing the worker to emit discovery
        blocks in a fixed schema. It is deleted, along with its orphaned E-fork
        pair, for two reasons:

        1. EXTRACTION IS NOT THE BENCHMARK'S JOB ANY MORE. STRIP-2a removed the
           memory-production flow and `scripts/backgammon_sxe.py`; the bench's
           MCP surface is recall-only (plugin auto-inject), and what happens
           inside a session is measured by the plugin substrate rather than by
           asking the model under test to narrate it. The pair was already
           recorded as orphaned and deferred (SESSIONCONTINUANCE, WO-STRIP-2b).

        2. IT WAS ACTIVELY CORRUPTING THE MEASUREMENT. Its "load-bearing
           requirements" told the worker the debug seam was gated by
           `BENCH_DEBUG`. Every other source — CONTRACT.md, chunk-04, chunk-06,
           the golden, the scaffold, and the gate harness that actually launches
           the server — says `DEBUG_API`. A worker that obeyed it renamed the
           seam and then failed every gate that scripts dice: the conformance
           pregate, three backend gate files, and the whole Playwright suite.
           That is a model being penalised for following its instructions.

        Worth knowing for anything that replaces it: the appended text was NEVER
        covered by `chunk_plan_hash`, which hashes only `task/backgammon/
        prompts/`. Edits to it were invisible to drift detection, which is how a
        contradicting env-var name survived in the model's context unnoticed.
        """
        prompts_dir = self.task_dir / "prompts"
        if not prompts_dir.is_dir():
            raise RuntimeError(f"chunked prompts directory missing: {prompts_dir}")
        chunk_paths = sorted(prompts_dir.glob("chunk-*.md"))
        if not chunk_paths:
            raise RuntimeError(f"no chunk prompts (chunk-*.md) found in {prompts_dir}")
        chunks: list[str] = []
        for path in chunk_paths:
            text = path.read_text(encoding="utf-8")
            if not text.strip():
                raise RuntimeError(f"chunk prompt empty: {path}")
            chunks.append(text)

        # SELF-COMPACTION IS WORKER-SIDED, AND INVISIBLE TO THESE PROMPTS.
        # The plugin fires its own summarize on session.idle, gated entirely by
        # the phase sentinel the harness publishes — so the prompts carry no
        # compaction instruction, ask the model for no sign-off string, and are
        # byte-identical whether or not the flag is set. The harness only
        # observes at the boundary (see _settle_after_chunk).
        return chunks

    @staticmethod
    def _joined_chunk_prompt(chunks: list[str]) -> str:
        """Single-text rendering of the chunk plan.

        Used for the launch PROGRESS character count; the cell itself is
        driven chunk-by-chunk over serve.
        """
        return "\n\n---\n\n".join(chunks)
