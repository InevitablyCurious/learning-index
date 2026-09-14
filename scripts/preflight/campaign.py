"""Campaign-slot resolution — mirrors control/campaign.mjs `campaignTargetFor`
(where a campaign lands) so preflight reports the slot the harness will use."""

from __future__ import annotations

import json
import re
from pathlib import Path

from preflight.core import REPO, Check


def _segment(value: str, fallback: str) -> str:
    """Mirror of control/tree.mjs `segment()`: dots read as the archive
    convention and slashes as depth, so both (and backslashes) become dashes;
    empty input yields a NAMED placeholder, never an empty segment."""
    cleaned = re.sub(r"[./\\]+", "-", str(value or "").strip()).strip("-")
    return cleaned or fallback


def _campaign_dir_name(model: str) -> str:
    """Mirror of control/campaign.mjs `campaignDirName()` — the LEGACY flat
    slot `runs/cumulative-<model>`, reached only when no tree pointer exists."""
    return "cumulative-" + re.sub(r"[./]", "-", str(model))


def _read_tree_pointer(runs_root: Path) -> tuple[str | None, str | None]:
    """Read runs/active-tree.json READ-ONLY. Returns (tree_id, error).

    Mirrors control/tree.mjs `readTreePointer`: an ABSENT pointer means
    "legacy flat layout", but a MALFORMED one is an error, never an absent —
    guessing would route a campaign into the wrong tree.
    """
    pointer = runs_root / "active-tree.json"
    if not pointer.exists():
        return None, None
    try:
        raw = json.loads(pointer.read_text(encoding="utf-8"))
        active = str(raw.get("active", "") if isinstance(raw, dict) else "")
        if not re.fullmatch(r"\d{9,11}", active):
            raise ValueError(f"active={active!r} is not a unix-seconds tree id")
        return active, None
    except Exception as exc:  # noqa: BLE001
        return None, f"active-tree.json present but unreadable: {exc}"


def check_run_dir(c: Check, args) -> None:
    """Report whether the chosen model's campaign slot is already occupied.

    READ-ONLY — never writes or deletes under runs/. Archive, never delete
    (RUNBOOK §0 3a); under the tree layout a reset MINTS a new tree rather
    than unlinking (control/tree.mjs).

    Slot resolution mirrors control/campaign.mjs `campaignTargetFor`: the
    active tree WINS when the pointer exists — cloud campaigns land at
    runs/<tree>/cloud/<router>/<provider>/<model>, local ones at
    runs/<tree>/local/local-llm-proxy/omlx/<model>; only a bench with NO
    pointer uses the legacy flat runs/cumulative-<model> slot.
    """
    runs_root = REPO / "runs"
    tree_id, tree_err = _read_tree_pointer(runs_root)
    if tree_err:
        c.add(
            "campaign slot",
            False,
            f"{tree_err} — refusing to guess which tree is live (control/tree.mjs)",
        )
        return
    if args.cloud:
        provider = str(args.provider or "").strip()
        model = str(args.model or "").strip()
        router = str(args.router or "orcarouter").strip()
        if tree_id:
            rel = (
                Path(tree_id)
                / "cloud"
                / _segment(router, "orcarouter")
                / _segment(provider, "unknown-provider")
                / _segment(model, "unknown-model")
            )
        else:
            rel = Path(_campaign_dir_name(f"{provider}/{model}"))
    else:
        alias = str(args.model or "").strip()
        if alias.startswith("local-llm-proxy/"):
            alias = alias[len("local-llm-proxy/") :]
        if tree_id:
            rel = (
                Path(tree_id)
                / "local"
                / "local-llm-proxy"
                / "omlx"
                / _segment(alias, "unknown-model")
            )
        else:
            rel = Path(_campaign_dir_name(alias))
    tree_note = (
        f"active tree {tree_id}" if tree_id else "no active tree — legacy flat layout"
    )
    slot = runs_root / rel
    if not slot.exists():
        c.add("campaign slot", True, f"{rel} ABSENT ({tree_note}) — clean slate")
        return
    stamp = "$(date +%Y%m%dT%H%M%S)"
    c.add(
        "campaign slot",
        False,
        f"{rel} EXISTS ({tree_note}) — a campaign occupies this slot. "
        "ARCHIVE IT, NEVER DELETE (legacy: mv runs/<dir> runs/<dir>.<why>-"
        f"{stamp}; tree layout: reset mints a NEW tree, never unlink). "
        "A launch into it RESUMES that campaign — intended only for resumes.",
    )
