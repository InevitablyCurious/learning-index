"""A gate runner that DIES must not be scored as one that merely failed.

Measured on a real run (2026-08-24): `backend/gates-13-16.test.ts` hit a V8
heap OOM after G13's three tests had already failed. The abort check at the
time required ZERO failures, so the crash went unrecorded — all three attempts
published `gradable: true`, `aborted_runners: []`, and G14/G15/G16 were left
unmeasured without anything saying a process had died.

These tests pin the distinction the fix rests on: vitest exits 1 when tests
fail (a measurement), and anything else nonzero means the process did not
finish (an absence).
"""

import json
import subprocess
from pathlib import Path

import pytest

GATES_DIR = Path(__file__).resolve().parents[1] / "grader"
GATE_RESULTS = GATES_DIR / "gate-results.mjs"


def _is_runner_crash(run: dict) -> bool:
    """Call the real predicate in gate-results.mjs — no reimplementation here."""
    script = (
        f"import {{ isRunnerCrash }} from {str(GATE_RESULTS)!r};\n"
        f"console.log(JSON.stringify(isRunnerCrash({json.dumps(run)})));\n"
    )
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        pytest.fail(f"node failed: {proc.stderr.strip()[:400]}")
    return json.loads(proc.stdout.strip())


@pytest.mark.skipif(
    not GATE_RESULTS.exists(), reason="grader/gate-results.mjs not present"
)
class TestIsRunnerCrash:
    def test_clean_exit_is_not_a_crash(self):
        assert _is_runner_crash({"status": 0, "signal": None}) is False

    def test_failing_tests_are_not_a_crash(self):
        # vitest exits 1 for "tests failed". That is a measurement and must
        # stay gradable, or every genuinely failing cell becomes unscorable.
        assert _is_runner_crash({"status": 1, "signal": None}) is False

    def test_heap_oom_is_a_crash(self):
        # A V8 out-of-memory abort: null status, SIGABRT. This is the exact
        # shape that went undetected.
        assert _is_runner_crash({"status": None, "signal": "SIGABRT"}) is True

    def test_kill_is_a_crash(self):
        assert _is_runner_crash({"status": None, "signal": "SIGKILL"}) is True

    @pytest.mark.parametrize("status", [2, 7, 134, 139, 255])
    def test_other_nonzero_exits_are_crashes(self, status):
        assert _is_runner_crash({"status": status, "signal": None}) is True

    def test_missing_run_is_not_a_crash(self):
        assert _is_runner_crash(None) is False


@pytest.mark.skipif(
    not GATE_RESULTS.exists(), reason="grader/gate-results.mjs not present"
)
def test_oom_really_does_report_sigabrt(tmp_path):
    """Ground the SIGABRT assumption in the actual runtime, not in folklore.

    If node ever reports a heap OOM differently, this fails loudly here rather
    than silently reopening the hole in the abort check.
    """
    script = tmp_path / "oom.mjs"
    script.write_text(
        "const a=[];while(true){a.push(new Array(1e6).fill(Math.random()));}\n"
    )
    proc = subprocess.run(
        ["node", "--max-old-space-size=64", str(script)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode != 0
    assert (
        _is_runner_crash(
            {
                "status": proc.returncode if proc.returncode >= 0 else None,
                "signal": "SIGABRT" if proc.returncode < 0 else None,
            }
        )
        is True
    )
    assert "out of memory" in proc.stderr.lower() or "heap limit" in proc.stderr.lower()


# --- the NUL delimiter, and the cause a dead worker leaves on its gates -------


def test_base_key_joins_file_and_chain_with_a_NUL_delimiter() -> None:
    """The separator is a NUL BYTE, and that is load-bearing, not corruption.

    ``file`` reports this module as binary data because of it, and a reader who
    "cleans" the file destroys the one character that cannot occur in either a
    filename or a test title. Without it ``baseKey`` is plain concatenation, so
    file ``ab`` + chain ``c`` and file ``a`` + chain ``bc`` produce the SAME key
    and two different gates match each other's results.

    This test exists because that strip was actually performed once, by an agent
    reading the file as text.
    """
    raw = GATE_RESULTS.read_bytes()
    assert b"\x00" in raw, (
        "the NUL delimiter in baseKey() is gone — gate keys are now ambiguous; "
        "restore `${base}\\x00${chain}`"
    )

    script = (
        f"import {{ makeMatcher }} from {str(GATE_RESULTS)!r};\n"
        # Two gates that differ ONLY in where the file name stops.
        "const roster = { available: true, byKey: new Map(), gates: [] };\n"
        "const key = (f, c) => `${String(f).split('/').pop()}\\u0000${c}`;\n"
        "roster.byKey.set(key('ab', 'c'), { id: 'AB-C', phase: 'backend' });\n"
        "roster.byKey.set(key('a', 'bc'), { id: 'A-BC', phase: 'backend' });\n"
        "const m = makeMatcher(roster);\n"
        "console.log(JSON.stringify([\n"
        "  m.observed('ab', 'c', 'passed', 1)?.id,\n"
        "  m.observed('a', 'bc', 'passed', 1)?.id,\n"
        "]));\n"
    )
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        check=True,
        cwd=GATES_DIR,
    )
    assert json.loads(proc.stdout) == ["AB-C", "A-BC"], (
        "two gates collided on one key — the delimiter is not doing its job"
    )


def test_a_dead_worker_marks_only_the_gates_that_never_reported() -> None:
    """The cause is on the unmeasured gates, and on nothing else.

    A gate that PASSED in a file whose worker later died holds a real verdict:
    the death cost the gates that had not reported yet, not the ones that had.
    Marking the whole file would turn measured results into absences, which is
    the same class of lie as the reverse.
    """
    script = (
        f"import {{ makeMatcher, vitestGateResults }} from {str(GATE_RESULTS)!r};\n"
        "const key = (f, c) => `${String(f).split('/').pop()}\\u0000${c}`;\n"
        "const roster = { available: true, byKey: new Map(), gates: [] };\n"
        "roster.byKey.set(key('g.test.ts', 'measured'), { id: 'G-OK', phase: 'backend' });\n"
        "roster.byKey.set(key('g.test.ts', 'lost'), { id: 'G-LOST', phase: 'backend' });\n"
        "const report = { testResults: [{ name: 'g.test.ts', assertionResults: [\n"
        "  { ancestorTitles: [], title: 'measured', status: 'passed', duration: 5 },\n"
        "  { ancestorTitles: [], title: 'lost', status: 'pending', duration: null },\n"
        "] }] };\n"
        "const withDeath = vitestGateResults(report, makeMatcher(roster), "
        "{ diedFiles: new Set(['g.test.ts']) });\n"
        "const without = vitestGateResults(report, makeMatcher(roster));\n"
        "console.log(JSON.stringify({ withDeath, without }));\n"
    )
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        check=True,
        cwd=GATES_DIR,
    )
    out = json.loads(proc.stdout)

    measured, lost = out["withDeath"]
    assert measured["id"] == "G-OK" and measured["status"] == "pass"
    assert "not_run_cause" not in measured, (
        "a real verdict must never carry a death cause"
    )

    assert lost["id"] == "G-LOST" and lost["status"] == "not_run"
    assert lost["not_run_cause"] == "runner_died"

    # WITHOUT the death, the same pending gate is an ORDINARY absence. The cause
    # is stated only when the runner actually observed a worker die — it is never
    # inferred from the pending status alone, which every skipped test also has.
    _, ordinary = out["without"]
    assert ordinary["status"] == "not_run"
    assert "not_run_cause" not in ordinary
