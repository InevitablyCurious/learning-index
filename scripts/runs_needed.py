#!/usr/bin/env python3
"""How many runs does each arm need before a memory effect is real?

Two runs of the same model on the same challenge never come out the same: the
model samples, so every build differs. A memory system's effect only shows once
it is larger than that run-to-run spread. This reads the spread from a
memory-OFF batch and answers, for a range of improvements, how many runs per
arm it takes to see that improvement 80% of the time with a 5% chance of a
false alarm, and how often three runs per arm would see it.

    python3 scripts/runs_needed.py                    # find the batches under the runs root
    python3 scripts/runs_needed.py <run dir or batch.json>
    python3 scripts/runs_needed.py --values 14,9,17,11,12
    python3 scripts/runs_needed.py --values 412000,388000,530000 --relative

The batch is the one the board keeps for a model's floor (batch.json): one
problem count per scored run, counted after the build. Void runs are not part
of the spread. --values takes any per-run numbers instead (turns, tokens), and
--relative states the improvements as percentages.

The answer is a planning estimate, not a result. It resamples the OFF runs to
stand in for both arms, moves one arm by the improvement (assuming memory moves
runs without changing how much they vary), and counts how often a one-sided
Mann-Whitney test calls the difference. With fewer than five scored runs the
spread itself is a guess, and the report says so.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
from collections.abc import Sequence
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

DEFAULT_ABSOLUTE_EFFECTS = (1.0, 2.0, 3.0, 5.0)
DEFAULT_RELATIVE_EFFECTS = (0.10, 0.20, 0.30, 0.50)
# The README's rule: no difference is claimed below three scored runs per arm.
CURRENT_RULE_RUNS = 3
# Below this many scored runs the spread is too thin to plan on.
THIN_SPREAD = 5


def mann_whitney_p_less(b: Sequence[float], a: Sequence[float]) -> float:
    """One-sided p-value that `b` tends to be smaller than `a`.

    Normal approximation with mid-ranks for ties, the tie-corrected variance and
    a continuity correction. With every value tied there is no evidence either
    way, so the p-value is 1.
    """
    n1, n2 = len(b), len(a)
    pooled = sorted([(value, 0) for value in b] + [(value, 1) for value in a])
    total = n1 + n2
    rank_sum_b = 0.0
    tie_term = 0.0
    i = 0
    while i < total:
        j = i
        while j + 1 < total and pooled[j + 1][0] == pooled[i][0]:
            j += 1
        mid_rank = (i + j) / 2 + 1
        tied = j - i + 1
        tie_term += tied**3 - tied
        rank_sum_b += mid_rank * sum(1 for k in range(i, j + 1) if pooled[k][1] == 0)
        i = j + 1
    u_b = rank_sum_b - n1 * (n1 + 1) / 2
    mean = n1 * n2 / 2
    variance = n1 * n2 / 12 * ((total + 1) - tie_term / (total * (total - 1)))
    if variance <= 0:
        return 1.0
    z = (u_b - mean + 0.5) / math.sqrt(variance)
    return 0.5 * math.erfc(-z / math.sqrt(2))


def improve(value: float, effect: float, *, relative: bool) -> float:
    """One run's value after memory removes `effect` (never below zero)."""
    if relative:
        return value * (1 - effect)
    return max(0.0, value - effect)


def power(
    values: Sequence[float],
    runs: int,
    effect: float,
    *,
    relative: bool,
    alpha: float,
    sims: int,
    rng: random.Random,
) -> float:
    """Share of simulated experiments, `runs` per arm, that see the effect."""
    hits = 0
    for _ in range(sims):
        off = rng.choices(values, k=runs)
        on = [
            improve(v, effect, relative=relative) for v in rng.choices(values, k=runs)
        ]
        if mann_whitney_p_less(on, off) < alpha:
            hits += 1
    return hits / sims


def runs_needed(
    values: Sequence[float],
    effect: float,
    *,
    relative: bool,
    target: float,
    alpha: float,
    max_runs: int,
    sims: int,
    seed: int,
) -> int | None:
    """Fewest runs per arm that see `effect` with at least `target` power."""
    rng = random.Random(seed)
    for runs in range(2, max_runs + 1):
        if (
            power(
                values, runs, effect, relative=relative, alpha=alpha, sims=sims, rng=rng
            )
            >= target
        ):
            return runs
    return None


def load_batch(path: Path) -> tuple[list[float], dict]:
    """Scored problem counts from a board batch.json, plus what it says about itself."""
    batch = json.loads(path.read_text(encoding="utf-8"))
    runs = batch.get("runs") or []
    values = [
        float(run["problem_count"])
        for run in runs
        if run.get("scored") is True
        and isinstance(run.get("problem_count"), (int, float))
        and not isinstance(run.get("problem_count"), bool)
    ]
    info = {
        "fingerprint": batch.get("fingerprint"),
        "void": bool(batch.get("void")),
        "void_kind": batch.get("void_kind"),
        "void_reason": batch.get("void_reason"),
        "excluded": len(runs) - len(values),
    }
    return values, info


def find_batches(root: Path) -> list[Path]:
    """Every batch.json under `root`, archived trees left out."""
    return sorted(
        p
        for p in root.rglob("batch.json")
        if "backups" not in p.relative_to(root).parts
    )


def runs_root() -> Path:
    """The live run root: BENCH_RUNS_DIR when set, else the repo's runs/."""
    env = os.environ.get("BENCH_RUNS_DIR")
    return Path(env) if env else REPO / "runs"


def resolve_source(source: str | None) -> Path | None:
    """The one batch.json to read, or None after listing the choices."""
    target = Path(source) if source else runs_root()
    if target.is_file():
        return target
    if (target / "batch.json").is_file():
        return target / "batch.json"
    if not target.is_dir():
        print(f"no batch.json at {target}", file=sys.stderr)
        return None
    found = find_batches(target)
    if len(found) == 1:
        return found[0]
    if not found:
        print(f"no batch.json under {target}", file=sys.stderr)
        return None
    print(f"{len(found)} batches under {target}; name one:", file=sys.stderr)
    for path in found:
        values, info = load_batch(path)
        state = f"void ({info['void_kind']})" if info["void"] else "valid"
        print(f"  {path}  [{len(values)} scored, {state}]", file=sys.stderr)
    return None


def quantile(sorted_values: Sequence[float], q: float) -> float:
    """Linear-interpolation quantile of an already-sorted list."""
    position = (len(sorted_values) - 1) * q
    low = math.floor(position)
    high = math.ceil(position)
    return sorted_values[low] + (sorted_values[high] - sorted_values[low]) * (
        position - low
    )


def number(value: float) -> str:
    return f"{value:,.0f}" if float(value).is_integer() else f"{value:,.1f}"


def effect_label(effect: float, *, relative: bool) -> str:
    if relative:
        return f"{effect * 100:.0f}% less"
    noun = "problem" if effect == 1 else "problems"
    return f"{number(effect)} {noun} fewer"


def report(
    values: Sequence[float],
    *,
    what: str,
    effects: Sequence[float],
    relative: bool,
    target: float,
    alpha: float,
    max_runs: int,
    sims: int,
    seed: int,
) -> str:
    ordered = sorted(values)
    middle = f"{number(quantile(ordered, 0.25))}–{number(quantile(ordered, 0.75))}"
    chance_heading = f"chance with {CURRENT_RULE_RUNS} per arm"
    lines = [
        (
            f"  {what}: median {number(quantile(ordered, 0.5))}, "
            f"middle half {middle}, range {number(ordered[0])}–{number(ordered[-1])}"
        ),
        "",
        f"  {'to see memory give':<24}{'runs per arm':>14}{chance_heading:>26}",
    ]
    for effect in effects:
        needed = runs_needed(
            values,
            effect,
            relative=relative,
            target=target,
            alpha=alpha,
            max_runs=max_runs,
            sims=sims,
            seed=seed,
        )
        chance = power(
            values,
            CURRENT_RULE_RUNS,
            effect,
            relative=relative,
            alpha=alpha,
            sims=sims,
            rng=random.Random(seed),
        )
        needed_text = str(needed) if needed is not None else f"more than {max_runs}"
        lines.append(
            f"  {effect_label(effect, relative=relative):<24}{needed_text:>14}{f'{chance:.0%}':>26}"
        )
    lines += [
        "",
        (
            f"  'runs per arm' = {target:.0%} chance of seeing the improvement, "
            f"{alpha:.0%} chance of a false alarm (one-sided Mann-Whitney)."
        ),
    ]
    if len(values) < THIN_SPREAD:
        lines.append(
            f"  Only {len(values)} scored runs: the spread itself is a guess. Run more OFF "
            "cells under the same fingerprint before planning on these numbers."
        )
    return "\n".join(lines)


def parse_list(text: str) -> list[float]:
    return [float(part) for part in text.replace(" ", "").split(",") if part]


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "source",
        nargs="?",
        help="a run dir or batch.json (default: search the runs root)",
    )
    parser.add_argument(
        "--values", help="comma-separated per-run numbers instead of a batch"
    )
    parser.add_argument(
        "--relative", action="store_true", help="state improvements as percentages"
    )
    parser.add_argument(
        "--effects",
        help="comma-separated improvements (counts, or fractions with --relative)",
    )
    parser.add_argument(
        "--power",
        type=float,
        default=0.8,
        help="chance of seeing a real effect (default 0.8)",
    )
    parser.add_argument(
        "--alpha", type=float, default=0.05, help="false-alarm rate (default 0.05)"
    )
    parser.add_argument(
        "--max-runs", type=int, default=30, help="largest arm size to try (default 30)"
    )
    parser.add_argument(
        "--sims", type=int, default=1000, help="simulated experiments per estimate"
    )
    parser.add_argument(
        "--seed", type=int, default=0, help="seed, so a report can be reproduced"
    )
    args = parser.parse_args(argv)

    if args.values:
        values = parse_list(args.values)
        header = [f"{len(values)} runs given on the command line"]
        what = "values"
    else:
        path = resolve_source(args.source)
        if path is None:
            return 2
        values, info = load_batch(path)
        header = [f"OFF batch: {path}"]
        if info["fingerprint"]:
            header.append(f"  fingerprint: {str(info['fingerprint'])[:16]}")
        if info["void"]:
            header.append(
                f"  VOID ({info['void_kind']}): {info['void_reason']} — "
                "its spread still shows the noise, but it is no longer a floor"
            )
        header.append(
            f"  scored runs: {len(values)} ({info['excluded']} not scored, left out)"
        )
        what = "problems after the build"

    if len(values) < 2:
        print("\n".join(header), file=sys.stderr)
        print("need at least 2 scored runs to measure a spread", file=sys.stderr)
        return 2

    effects = (
        parse_list(args.effects)
        if args.effects
        else (DEFAULT_RELATIVE_EFFECTS if args.relative else DEFAULT_ABSOLUTE_EFFECTS)
    )
    print("\n".join(header))
    print(
        report(
            values,
            what=what,
            effects=effects,
            relative=args.relative,
            target=args.power,
            alpha=args.alpha,
            max_runs=args.max_runs,
            sims=args.sims,
            seed=args.seed,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
