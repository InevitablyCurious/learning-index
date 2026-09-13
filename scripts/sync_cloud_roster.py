#!/usr/bin/env python3
"""Regenerate the control plane's ELIGIBLE-model list from the canonical roster.

`harness/config.py` holds the full provider catalogue. `control/cloud.mjs` holds
something narrower and more consequential: the models the harness will ACCEPT,
which is also what the board's picker offers. Every entry there is a claim that
a benchmark cell can validly run on that model.

EVERY catalogued model is mirrored. Nothing is filtered out.

Models with a context window below CONTEXT_ADVISORY_FLOOR are still offered --
they are marked, not hidden. The benchmark measures an INFORMATION DELTA within
one model: the same model runs OFF then ON repeatedly, so it is its own control
and its window cancels out of its own delta. A narrow window does not bias the
measurement; it only risks the run hitting the provider's ceiling mid-cell.
That is a runnability caveat for the operator to weigh, not grounds for the
picker to decide on their behalf.

The mirror was previously hand-kept and drifted: 87 entries against 117
catalogued, while still offering two models (`anthropic/claude-sonnet-4.5`,
`openai/gpt-5-codex`) withdrawn upstream, which would have failed at call time
with no warning here.

A hand-maintained mirror will drift again. This script removes the hand from it:
the JavaScript is generated from Python, and `--check` fails when the two
disagree, so the preflight can gate on it.

    python scripts/sync_cloud_roster.py            # rewrite the mirror
    python scripts/sync_cloud_roster.py --check    # exit 1 if it has drifted

Direction is one way and not negotiable: config.py is canonical because it is
what the harness enforces. Editing the JavaScript by hand is how the drift
started.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

BENCH_ROOT = Path(__file__).resolve().parents[1]
MIRROR = BENCH_ROOT / "control" / "cloud.mjs"

BEGIN = "export const CLOUD_MODELS = {"
END = "};"

# Advisory only. Below this, the board badges the model with its actual window
# and a note that the run may hit the provider's context ceiling. It does not
# remove the model. Mirrors CONTEXT_ADVISORY_FLOOR in control/cloud.mjs.
CONTEXT_ADVISORY_FLOOR = 262144


def canonical_models() -> dict[str, dict]:
    sys.path.insert(0, str(BENCH_ROOT))
    from harness.config import CLOUD_ORCAROUTER_PROVIDER

    return CLOUD_ORCAROUTER_PROVIDER["models"]


def readable_label(key: str, name: str | None) -> str:
    """A label a person can read in a picker.

    The upstream pricing payload leaves `name` equal to the key for 23 entries,
    which would render the picker as a column of raw slugs. Derive one from the
    model segment rather than shipping that.

    Two rules keep the result readable: known acronyms stay uppercase (GPT, not
    Gpt), and a trailing ISO date is re-joined rather than split into three
    words ("GPT 5.2 (2025-12-11)", not "Gpt 5.2 2025 12 11").
    """
    if name and name != key and "/" not in name:
        return name

    segment = key.split("/", 1)[1] if "/" in key else key

    date_suffix = ""
    if m := re.search(r"-(\d{4})-(\d{2})-(\d{2})$", segment):
        date_suffix = f" ({m.group(1)}-{m.group(2)}-{m.group(3)})"
        segment = segment[: m.start()]

    acronyms = {"gpt": "GPT", "glm": "GLM", "vl": "VL", "oss": "OSS", "hy": "HY"}
    words = []
    for w in segment.replace("_", "-").split("-"):
        if not w:
            continue
        elif w.lower() in acronyms:
            words.append(acronyms[w.lower()])
        elif any(c.isdigit() for c in w):
            words.append(w)
        else:
            words.append(w.capitalize())
    return " ".join(words) + date_suffix


def render(models: dict[str, dict]) -> str:
    """Emit the JS object body, one model per line, keys sorted.

    Only the fields the board actually consumes are mirrored (name, context,
    output). Reasoning/tool_call/attachment stay Python-side: the harness reads
    them, the picker does not, and mirroring unused fields is more surface to
    drift.
    """
    lines = [BEGIN]
    for key in sorted(models):
        m = models[key]
        limit = m.get("limit", {}) or {}
        entry = {
            "name": readable_label(key, m.get("name")),
            "context": limit.get("context", 0),
            "output": limit.get("output", 0),
        }
        body = ", ".join(f"{k}: {json.dumps(v)}" for k, v in entry.items())
        lines.append(f"  {json.dumps(key)}: {{ {body} }},")
    lines.append(END)
    return "\n".join(lines)


def splice(source: str, block: str) -> str:
    start = source.index(BEGIN)
    end = source.index(f"\n{END}", start) + len(END) + 1
    return source[:start] + block + source[end:]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="report drift, change nothing")
    args = ap.parse_args()

    models = canonical_models()
    current = MIRROR.read_text()
    updated = splice(current, render(models))

    if args.check:
        if current == updated:
            print(f"cloud roster in sync — {len(models)} models")
            return 0
        # Name the actual difference; "they differ" is not actionable.
        mirrored = set(re.findall(r'^\s{2}"([^"]+)":', current, re.M))
        canon = set(models)
        if missing := sorted(canon - mirrored):
            print(f"MISSING FROM MIRROR ({len(missing)}): {', '.join(missing)}")
        if extra := sorted(mirrored - canon):
            print(f"STALE IN MIRROR ({len(extra)}): {', '.join(extra)}")
        if not missing and not extra:
            print("same model keys, but metadata differs (name/context/output)")
        print("run: python scripts/sync_cloud_roster.py")
        return 1

    if current == updated:
        print(f"cloud roster already in sync — {len(models)} models")
        return 0

    MIRROR.write_text(updated)
    low = sorted(
        (k, (v.get("limit") or {}).get("context", 0))
        for k, v in models.items()
        if (v.get("limit") or {}).get("context", 0) < CONTEXT_ADVISORY_FLOOR
    )
    print(f"regenerated {MIRROR.relative_to(BENCH_ROOT)} — {len(models)} models")
    print(f"  {len(low)} below the {CONTEXT_ADVISORY_FLOOR} advisory floor (offered, badged in the UI)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
