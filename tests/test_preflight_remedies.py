"""A refused launch must name the BUTTON that fixes it, not a shell command.

THE FAILURE THIS CLOSES. Preflight's remediations were written for a terminal
("restart: cd dev && make control-restart"), and the board rendered them
verbatim under "Fix what preflight named, then start again". So a refusal on the
board sent the operator to a shell for something the board itself can do — and
an operator sent to a shell for one thing ends up doing everything there, which
is the reasoning that put the rebuild on the board in the first place.

Preflight now names the remedy by TOOL ID. It deliberately stops there: the tool
registry (control/tools.mjs) is the only thing that knows a
tool's display name and whether it is installed at all, and a second copy of that
mapping here would be the drift this seam exists to prevent.

PER FAILURE BRANCH, NEVER PER CHECK NAME. That is the property most of these
tests are about: "the worker image is stale" is one press of Rebuild worker, but
"docker not on PATH" is the SAME CHECK failing for a reason no button can fix,
and offering one there is a lie the operator pays for by pressing it.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def _preflight():
    spec = importlib.util.spec_from_file_location(
        "bench_preflight", REPO / "scripts" / "bench_preflight.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_a_failing_check_carries_its_remedy_tool_id() -> None:
    pf = _preflight()
    c = pf.Check()
    c.add("worker image", False, "stale", remedy=pf.TOOL_WORKER_REBUILD)
    row = c.as_rows()[0]
    assert row["remedy_tool"] == "worker-image-rebuild"


def test_the_grader_image_failures_carry_the_grader_rebuild_button() -> None:
    """A stale or missing grading image is one press, exactly like the worker.

    Before this the refusal printed `python3 scripts/rebuild_grader_image.py`
    and offered nothing, so a launch blocked by the instrument sent the operator
    to a shell for something the board can do.
    """
    pf = _preflight()
    c = pf.Check()
    c.add("grader image", False, "STALE", remedy=pf.TOOL_GRADER_REBUILD)
    c.add("grader resources", False, "not asked", remedy=pf.TOOL_GRADER_REBUILD)
    assert [r["remedy_tool"] for r in c.as_rows()] == [
        "grader-image-rebuild",
        "grader-image-rebuild",
    ]


def test_a_passing_check_never_carries_a_remedy() -> None:
    """A green row with a button attached invites a press that changes a bench
    which was already correct."""
    pf = _preflight()
    c = pf.Check()
    c.add("worker image", True, "matches byte for byte", remedy=pf.TOOL_WORKER_REBUILD)
    assert c.as_rows()[0]["remedy_tool"] is None


def test_a_check_with_no_tool_says_so_rather_than_guessing() -> None:
    """Most failures have no button — a campaign slot to archive, a dead hub, a
    roster that disagrees with itself. The field is present and null, so the
    board can tell "no button" from "the payload predates remedies"."""
    pf = _preflight()
    c = pf.Check()
    c.add("campaign slot", False, "a campaign occupies this slot")
    row = c.as_rows()[0]
    assert "remedy_tool" in row
    assert row["remedy_tool"] is None


def test_render_still_works_with_the_widened_row() -> None:
    """The CLI rendering unpacks these rows positionally; widening the tuple
    without widening the unpack would break `bench_preflight.py` in a terminal
    while leaving --json (and therefore the board) perfectly green."""
    pf = _preflight()
    c = pf.Check()
    c.add("worker image", False, "stale", remedy=pf.TOOL_WORKER_REBUILD)
    c.add("disk free", True, "660 GB")
    c.render()  # must not raise


def test_blocking_failures_still_filters_on_the_widened_row() -> None:
    pf = _preflight()
    c = pf.Check()
    c.add("worker image", False, "stale", remedy=pf.TOOL_WORKER_REBUILD)
    c.add("roster drift", False, "advisory", blocking=False)
    c.add("disk free", True, "660 GB")
    assert [r[0] for r in c.blocking_failures] == ["worker image"]


def test_a_docker_less_host_is_offered_no_button() -> None:
    """THE BRANCH PROPERTY, on the real check.

    `check_image` fails identically-named for two different reasons. Only one of
    them is a rebuild. Pressing Rebuild worker on a host with no docker burns a
    click and returns the same failure.
    """
    pf = _preflight()
    c = pf.Check()
    saved = pf.shutil.which
    pf.shutil.which = lambda _name: None
    try:
        pf.check_image(c)
    finally:
        pf.shutil.which = saved

    rows = c.as_rows()
    assert len(rows) == 1
    assert rows[0]["name"] == "worker image"
    assert rows[0]["status"] == "fail"
    assert rows[0]["remedy_tool"] is None, (
        "docker missing is not repaired by rebuilding the image"
    )


def test_the_relay_port_check_offers_no_button() -> None:
    """A dead model relay is brought up outside the board, so no tool repairs it —
    and preflight checks no memory-system service at all."""
    pf = _preflight()
    c = pf.Check()
    saved = pf.port_open
    pf.port_open = lambda *_a, **_k: False
    try:
        pf.check_ports(c)
    finally:
        pf.port_open = saved

    remedies = {r["name"]: r["remedy_tool"] for r in c.as_rows()}
    assert remedies == {"port 4545 (local relay)": None}


def test_every_remedy_a_check_names_is_one_of_the_declared_tool_ids() -> None:
    """No inline string literals. A typo'd id degrades to "no button", which is
    indistinguishable from a check that never had one — so the ids must come
    from the module's own constants, and the control-plane suite pins those
    against the real registry."""
    pf = _preflight()
    declared = {
        v for k, v in vars(pf).items() if k.startswith("TOOL_") and isinstance(v, str)
    }
    assert declared == {"worker-image-rebuild", "grader-image-rebuild"}

    src = (REPO / "scripts" / "bench_preflight.py").read_text(encoding="utf-8")
    for line in src.splitlines():
        stripped = line.strip()
        if not stripped.startswith("remedy="):
            continue
        value = stripped[len("remedy=") :].rstrip(",")
        assert value.startswith("TOOL_") or value.startswith("None"), (
            f"remedy must be a declared constant, not a literal: {stripped}"
        )
