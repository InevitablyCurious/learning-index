"""Identity assertion at the seam — liveness is not identity (AGENTS.md §2.1)."""

from __future__ import annotations

import hashlib
import logging
import subprocess
import sys

from preflight.core import FORBIDDEN_PORT, LIB_SH, REPO, Check


def expected_bench_ed_fp() -> str:
    """Expected bench identity fp from the shared helper — the ONLY derivation seam.

    Never re-derive seed -> pubkey -> fp in this file: lib.sh owns the
    derivation (seed -> client dist/crypto.js -> fp). Raises RuntimeError
    on ANY failure (missing seed, missing crypto build, empty output): an
    underivable expected identity is a HARD failure, never a skip
    (AGENTS.md §2.1).
    """
    proc = subprocess.run(
        ["bash", str(LIB_SH), "bench-identity-ed-fp"],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    out = proc.stdout.strip()
    if proc.returncode != 0 or not out:
        raise RuntimeError(f"rc={proc.returncode} stderr={proc.stderr.strip() or '-'}")
    return out


def check_identity(c: Check) -> None:
    """Assert identity AT THE SEAM. Liveness is not identity (AGENTS.md §2.1).

    A port answering and health returning 200 proved nothing in two separate
    real failures. Anything that mints, signs, or attributes must have its
    identity asserted, never inferred.
    """
    try:
        sys.path.insert(0, str(REPO))
        from harness.lifecycle.lconfig import LifecycleConfig
        from harness.lifecycle.mcp_rest import McpRest
    except Exception as exc:  # noqa: BLE001
        c.add("identity assertion", False, f"cannot import lifecycle client: {exc}")
        return

    # Function-local: the remedy id is a literal in the entry (regex-pinned by
    # control/control.test.mjs); importing it at module top level would be
    # circular (the entry imports this family at its top level).
    from bench_preflight import TOOL_BENCH_MCP_RESTART

    logging.basicConfig(level=logging.CRITICAL)
    log = logging.getLogger("preflight")
    cfg = LifecycleConfig()

    for label, url in (("bench", cfg.leader_mcp_url),):
        if f":{FORBIDDEN_PORT}" in url:
            c.add(
                f"identity {label}",
                False,
                f"{url} TARGETS THE OPERATOR HOST MCP :{FORBIDDEN_PORT} — "
                "this mints orgs under the operator's keychain identity. "
                "See AGENTS.md §2.1.",
            )
            continue
        try:
            expected = expected_bench_ed_fp()
        except Exception as exc:  # noqa: BLE001
            c.add(
                f"identity {label}",
                False,
                f"cannot derive expected fp via {LIB_SH}: {exc} — HARD failure; "
                "make the bench identity seed available (env BENCH_MCP_SEED or "
                "0600 ~/.okp/bench/bench-identity-seed.txt; run bench-mcp.sh start to generate it)",
            )
            continue
        try:
            payload = McpRest(url, cfg, log).identity_pubkeys()
            ed = (
                payload.get("ed25519")
                or payload.get("ed25519_pubkey")
                or payload.get("edPubkey")
                or ""
            )
            fp = hashlib.sha256(bytes.fromhex(ed)).hexdigest()[:8] if ed else ""
            if not fp:
                c.add(
                    f"identity {label}",
                    False,
                    f"{url} no ed25519 key in response",
                    remedy=TOOL_BENCH_MCP_RESTART,
                )
            elif fp == expected:
                c.add(f"identity {label}", True, f"{url} fp(ed_pubkey)={fp}")
            else:
                c.add(
                    f"identity {label}",
                    False,
                    f"{url} fp(ed_pubkey)={fp} EXPECTED {expected} — wrong identity "
                    "on the seam; a run on an unverified seam is VOID-INSTRUMENT "
                    "(RUNBOOK §6)",
                    remedy=TOOL_BENCH_MCP_RESTART,
                )
        except Exception as exc:  # noqa: BLE001
            # Unreachable is a HARD failure, never a skip (AGENTS.md §2.1).
            c.add(
                f"identity {label}",
                False,
                f"{url} UNREACHABLE/failed: {exc}",
                remedy=TOOL_BENCH_MCP_RESTART,
            )
