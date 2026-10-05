"""RUN-IDENTITY DISTINCTNESS — two concurrent same-model instances never share
a Docker identity, and a stale prior-run session-DB volume is still cleared.

The run_identity threading made all four collision-relevant Docker identities
unique per run-instance: container name, session-DB volume, egress sidecar and
grader container. Before it, two concurrent runs of the SAME model derived the
same names from the same label — a sibling's live volume could be force-removed
mid-run, or a cell could inherit a previous cell's transcript. These tests pin
BOTH halves of the invariant:

  (a) a FIXED label + two distinct identities => distinct names everywhere;
  (b) the volume preflight still issues `docker volume rm -f` — keyed to THIS
      run's unique volume name, so it can never touch a sibling's live volume
      and the stale-DB-never-leaks guarantee holds by construction.

Pure unit tests: subprocess.run is mocked, no container is ever launched.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
from pathlib import Path

import harness.adapters.docker_worker as docker_worker
import harness.egress
import harness.grader_run
from harness.adapters.docker_worker import DockerCell, DockerCellConfig

#: One fixed label, two run-instances of the same model — the dangerous case:
#: every name derived from the label ALONE would collide.
LABEL = "cumulative-0000-off-somemodel"
IDENTITY_A = "aaaa1111aaaa"
IDENTITY_B = "bbbb2222bbbb"

REPORT_PATH = Path("/runs/off/cell-0000/attempt-1-report.json")

TEST_PROXY_BASE_URL = "http://host.docker.internal:8789/api/v1"
TEST_PROXY_TOKEN = "test-ephemeral-token"


def _container_name(label: str, run_identity: str) -> str:
    """Mirror harness/adapters/challenge/runner.py:971-972 exactly."""
    sanitized_label = re.sub(r"[^a-zA-Z0-9_.-]", "-", label)
    return f"bench-cell-{sanitized_label}-{run_identity}"


def _cell_config(tmp_path: Path, run_identity: str) -> DockerCellConfig:
    return DockerCellConfig(
        worktree=tmp_path / f"worktree-{run_identity}",
        memory_mode="off",
        container_name=_container_name(LABEL, run_identity),
        proxy_base_url=TEST_PROXY_BASE_URL,
        proxy_token=TEST_PROXY_TOKEN,
    )


# ── (a) DISTINCT NAMES FOR TWO CONCURRENT SAME-MODEL INSTANCES ───────────────


def test_two_run_identities_get_distinct_egress_sidecar_names() -> None:
    """The sidecar name is sha256(run_identity), NOT sha256(label): two
    instances of the same model get two sidecars, so one run's egress traffic
    can never be metered/routed through the other's."""
    name_a = harness.egress.egress_container_name(IDENTITY_A)
    name_b = harness.egress.egress_container_name(IDENTITY_B)

    assert name_a != name_b
    # Pin the derivation (same form test_spend_key.py asserts), so a change to
    # the hash or prefix is a loud failure here, not a silent collision later.
    assert name_a == (
        f"okp-egress-{hashlib.sha256(IDENTITY_A.encode('utf-8')).hexdigest()[:12]}"
    )
    assert name_b == (
        f"okp-egress-{hashlib.sha256(IDENTITY_B.encode('utf-8')).hexdigest()[:12]}"
    )


def test_two_run_identities_get_distinct_grader_container_names() -> None:
    """The identity rides FIRST in the derived part (grader_run.container_name),
    so the [:120] clip takes the tail and never the id — concurrent
    run-instances cannot collide on the grader name, and the watchdog can still
    compute it to kill exactly its own grader."""
    name_a = harness.grader_run.container_name(REPORT_PATH, run_identity=IDENTITY_A)
    name_b = harness.grader_run.container_name(REPORT_PATH, run_identity=IDENTITY_B)

    assert name_a != name_b
    assert name_a == "bench-grade-aaaa1111aaaa-cell-0000-attempt-1-report"
    assert name_b == "bench-grade-bbbb2222bbbb-cell-0000-attempt-1-report"


def test_container_names_carry_the_run_identity_suffix() -> None:
    """Same label, two identities => two distinct cell container names, built
    as `bench-cell-{sanitized_label}-{run_identity}` (runner.py:971-972)."""
    container_a = _container_name(LABEL, IDENTITY_A)
    container_b = _container_name(LABEL, IDENTITY_B)

    assert container_a == "bench-cell-cumulative-0000-off-somemodel-aaaa1111aaaa"
    assert container_b == "bench-cell-cumulative-0000-off-somemodel-bbbb2222bbbb"
    assert container_a != container_b


def test_session_db_volume_name_follows_container_name_and_stays_distinct(
    tmp_path: Path,
) -> None:
    """The volume is `{container_name}-session-db` — the SAME derivation in
    docker_worker.session_db_volume_name (docker_worker.py:782) and in the
    residue check (cell_isolation.py:220). Distinct container names therefore
    give distinct volumes, and all three derivations agree byte-for-byte."""
    container_a = _container_name(LABEL, IDENTITY_A)
    container_b = _container_name(LABEL, IDENTITY_B)

    cell_a = DockerCell(_cell_config(tmp_path, IDENTITY_A))
    cell_b = DockerCell(_cell_config(tmp_path, IDENTITY_B))

    volume_a = cell_a.session_db_volume_name()
    volume_b = cell_b.session_db_volume_name()

    assert (
        volume_a == "bench-cell-cumulative-0000-off-somemodel-aaaa1111aaaa-session-db"
    )
    assert (
        volume_b == "bench-cell-cumulative-0000-off-somemodel-bbbb2222bbbb-session-db"
    )
    assert volume_a != volume_b
    # cell_isolation.py:220 derives the residue-check volume identically — if
    # these two derivations ever diverge, the preflight checks a name the
    # worker does not use and residue survives invisibly.
    assert volume_a == f"{container_a}-session-db"
    assert volume_b == f"{container_b}-session-db"


# ── (b) A STALE PRIOR-RUN SESSION-DB VOLUME IS STILL CLEARED ─────────────────


def test_volume_preflight_force_removes_only_this_runs_unique_volume(
    tmp_path: Path, monkeypatch
) -> None:
    """`_ensure_session_db_volume` must STILL remove a stale volume of the same
    name before creating it (a session DB must never inherit a prior run's
    transcript) — and because the name now carries the run_identity, the rm -f
    targets THIS run's unique volume: a sibling instance's live volume can
    never be touched by construction."""
    unique_volume = f"{_container_name(LABEL, IDENTITY_A)}-session-db"
    sibling_volume = f"{_container_name(LABEL, IDENTITY_B)}-session-db"

    calls: list[list[str]] = []

    def fake_run(argv, **kwargs):
        calls.append(list(argv))
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

    monkeypatch.setattr(docker_worker.subprocess, "run", fake_run)

    cell = DockerCell(_cell_config(tmp_path, IDENTITY_A))
    cell._ensure_session_db_volume(uid=501, gid=20)

    # The deliberate residue cleanup is preserved, FIRST, keyed to the unique
    # volume name — then the create reuses that exact name.
    assert calls[0] == ["docker", "volume", "rm", "-f", unique_volume]
    assert calls[1] == ["docker", "volume", "create", unique_volume]
    assert unique_volume == (
        "bench-cell-cumulative-0000-off-somemodel-aaaa1111aaaa-session-db"
    )
    # The sibling's live volume never appears in ANY docker call: the rm -f
    # cannot reach past this run-instance's own identity.
    flat = " ".join(" ".join(argv) for argv in calls)
    assert sibling_volume not in flat
    assert IDENTITY_B not in flat
