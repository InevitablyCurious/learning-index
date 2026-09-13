"""Tests for the gate -> predicate outcome emitter.

The defect under test is a memory asserting a fix for a gate that never went
green. Everything here guards the seam where that could be reintroduced:
absence must never read as a pass, and a result must never be bound to code it
did not run against.
"""

import json
import subprocess
from pathlib import Path

import pytest

from harness.outcomes.predicate_emitter import (
    STATE_BINDING_ATTEMPT,
    STATE_BINDING_NOT_RETAINED,
    STATE_BINDING_WORKTREE,
    UnknownGateStatus,
    emit_for_run,
    manifest_hash_for,
    map_gate_status,
    predicate_id_for,
    walk_manifest,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
TS_WALK = REPO_ROOT / "okp-mcp" / "dist" / "gstv" / "walk.js"


class TestStatusMapping:
    def test_pass_and_fail_map_straight_through(self):
        assert map_gate_status("pass") == "pass"
        assert map_gate_status("fail") == "fail"

    def test_not_run_is_not_evaluated_never_pass(self):
        # A gate that never ran produced no observation. Table 23 records that
        # as its own state; gate-results.mjs likewise never promotes it.
        assert map_gate_status("not_run") == "not_evaluated"

    def test_harness_error_is_not_evaluated_not_fail(self):
        # `error` means the harness broke, not that the code is wrong. Calling
        # it a fail would assert something the run never established.
        assert map_gate_status("error") == "not_evaluated"

    @pytest.mark.parametrize("bad", ["passed", "PASS", "green", "", None, 1, True])
    def test_unknown_status_raises_rather_than_defaulting(self, bad):
        with pytest.raises(UnknownGateStatus):
            map_gate_status(bad)


class TestPredicateIdentity:
    def test_is_stable_and_hex(self):
        a = predicate_id_for("G13", "backend/gates.test.ts", "sha256:abc")
        assert a == predicate_id_for("G13", "backend/gates.test.ts", "sha256:abc")
        assert len(a) == 64 and int(a, 16) >= 0

    def test_suite_revision_changes_identity(self):
        # The same-named test in a different suite revision is a different
        # predicate, so an outcome cannot silently carry across a suite change.
        a = predicate_id_for("G13", "backend/gates.test.ts", "sha256:abc")
        b = predicate_id_for("G13", "backend/gates.test.ts", "sha256:def")
        assert a != b

    def test_test_file_is_part_of_identity(self):
        a = predicate_id_for("G13", "backend/a.test.ts", "s")
        b = predicate_id_for("G13", "backend/b.test.ts", "s")
        assert a != b


class TestWalkV1:
    def test_manifest_hash_is_order_and_content_sensitive(self, tmp_path):
        base = [{"path": "a", "sha256": "11"}, {"path": "b", "sha256": "22"}]
        assert manifest_hash_for(base) == manifest_hash_for(list(base))
        assert manifest_hash_for(base) != manifest_hash_for(list(reversed(base)))
        assert manifest_hash_for(base) != manifest_hash_for(
            [{"path": "a", "sha256": "11"}, {"path": "b", "sha256": "33"}]
        )

    def test_git_directory_is_ignored(self, tmp_path):
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "a.ts").write_text("x")
        before = walk_manifest(tmp_path)[1]
        (tmp_path / ".git").mkdir()
        (tmp_path / ".git" / "index").write_text("noise")
        assert walk_manifest(tmp_path)[1] == before

    def test_symlinks_are_not_followed(self, tmp_path):
        (tmp_path / "a.ts").write_text("x")
        before = walk_manifest(tmp_path)[1]
        (tmp_path / "link.ts").symlink_to(tmp_path / "a.ts")
        assert walk_manifest(tmp_path)[1] == before

    def test_gitignore_is_refused_rather_than_guessed(self, tmp_path):
        # A quietly divergent hash is worse than a refusal.
        (tmp_path / "a.ts").write_text("x")
        (tmp_path / ".gitignore").write_text("*.log\n")
        with pytest.raises(NotImplementedError):
            walk_manifest(tmp_path)

    @pytest.mark.skipif(not TS_WALK.exists(), reason="okp-mcp/dist walk-v1 not built")
    def test_agrees_with_the_typescript_implementation(self, tmp_path):
        # Two implementations of walk-v1 exist (this one and gstv/walk.ts). If
        # they disagree, a state hash means different things on either side and
        # bindings silently stop matching. Pin them together.
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "game.ts").write_text("export const x = 1\n")
        (tmp_path / "src" / "ai.ts").write_text("export const y = 2\n")
        (tmp_path / "README.md").write_text("# hi\n")
        (tmp_path / "nested").mkdir()
        (tmp_path / "nested" / "deep.json").write_text('{"a":1}')

        script = tmp_path / "_walk.mjs"
        script.write_text(
            f"import {{ walkManifest }} from {str(TS_WALK)!r};\n"
            "const r = await walkManifest(process.argv[2], { useCache: false });\n"
            "console.log(r.manifest_hash);\n"
        )
        proc = subprocess.run(
            ["node", str(script), str(tmp_path)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if proc.returncode != 0:
            pytest.skip(f"node walk-v1 unavailable: {proc.stderr.strip()[:200]}")

        # The helper script itself is inside the walked tree, so hash after it
        # exists on both sides.
        assert walk_manifest(tmp_path)[1] == proc.stdout.strip()


def _write_run(tmp_path, rows, gates, worktree_files=(("src/a.ts", "x"),)):
    run = tmp_path / "run"
    (run / "memoryOFF" / "cell-0000" / "worktree").mkdir(parents=True)
    for rel, body in worktree_files:
        target = run / "memoryOFF" / "cell-0000" / "worktree" / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body)
    (run / "gate-roster.json").write_text(
        json.dumps({"suite_fingerprint": "sha256:suite", "gates": gates})
    )
    with open(run / "manifest.status.jsonl", "w") as fh:
        for row in rows:
            fh.write(json.dumps(row) + "\n")
    return run


def _row(attempt, gate_results):
    return {
        "type": "attempt",
        "attempt": attempt,
        "sequence_index": 0,
        "memory_mode": "off",
        "org_id": "org",
        "session_id": "ses_x",
        "session_fp": "fp",
        "gate_results": gate_results,
    }


class TestEmitForRun:
    def test_every_gate_produces_a_record_including_failures(self, tmp_path):
        # Recording only the passes would rebuild the defect from the far side.
        run = _write_run(
            tmp_path,
            [
                _row(
                    1,
                    [
                        {"id": "G01", "status": "pass", "phase": "backend"},
                        {"id": "G02", "status": "fail", "phase": "backend"},
                        {"id": "G03", "status": "not_run", "phase": "backend"},
                    ],
                )
            ],
            [{"id": "G01", "file": "a.test.ts"}, {"id": "G02", "file": "a.test.ts"}],
        )
        summary = emit_for_run(run)
        assert summary["records_written"] == 3
        assert summary["counts"] == {"pass": 1, "fail": 1, "not_evaluated": 1}

    def test_only_the_terminal_attempt_is_bound_to_the_worktree(self, tmp_path):
        # A cell keeps one worktree: the code as it ended. Binding earlier
        # attempts to it would attach their results to code they never ran on.
        run = _write_run(
            tmp_path,
            [
                _row(1, [{"id": "G01", "status": "fail", "phase": "backend"}]),
                _row(2, [{"id": "G01", "status": "fail", "phase": "backend"}]),
                _row(3, [{"id": "G01", "status": "pass", "phase": "backend"}]),
            ],
            [{"id": "G01", "file": "a.test.ts"}],
        )
        emit_for_run(run)
        records = [json.loads(l) for l in open(run / "predicate-outcomes.jsonl")]
        by_attempt = {r["attempt"]: r for r in records}
        assert by_attempt[3]["state_binding"] == STATE_BINDING_WORKTREE
        assert by_attempt[3]["state_hash"] != ""
        for earlier in (1, 2):
            assert by_attempt[earlier]["state_binding"] == STATE_BINDING_NOT_RETAINED
            assert by_attempt[earlier]["state_hash"] == ""

    def test_unknown_gate_status_aborts_the_run(self, tmp_path):
        run = _write_run(
            tmp_path,
            [_row(1, [{"id": "G01", "status": "flaky", "phase": "backend"}])],
            [{"id": "G01", "file": "a.test.ts"}],
        )
        with pytest.raises(UnknownGateStatus):
            emit_for_run(run)

    def test_truncated_trailing_line_is_skipped_not_guessed(self, tmp_path):
        run = _write_run(
            tmp_path,
            [_row(1, [{"id": "G01", "status": "pass", "phase": "backend"}])],
            [{"id": "G01", "file": "a.test.ts"}],
        )
        with open(run / "manifest.status.jsonl", "a") as fh:
            fh.write('{"type":"attempt","gate_re')
        assert emit_for_run(run)["records_written"] == 1


class TestAttemptSnapshotBinding:
    def test_harness_snapshot_is_preferred_for_superseded_attempts(self, tmp_path):
        # With per-attempt snapshots the earlier attempts are honestly bound —
        # each to the code it actually ran against, not to the survivor.
        rows = [
            {
                **_row(1, [{"id": "G01", "status": "fail", "phase": "backend"}]),
                "state_hash": "aaa",
                "state_alg": "walk-v1",
            },
            {
                **_row(2, [{"id": "G01", "status": "fail", "phase": "backend"}]),
                "state_hash": "bbb",
                "state_alg": "walk-v1",
            },
            {
                **_row(3, [{"id": "G01", "status": "pass", "phase": "backend"}]),
                "state_hash": "ccc",
                "state_alg": "walk-v1",
            },
        ]
        run = _write_run(tmp_path, rows, [{"id": "G01", "file": "a.test.ts"}])
        emit_for_run(run)
        records = {
            json.loads(l)["attempt"]: json.loads(l)
            for l in open(run / "predicate-outcomes.jsonl")
        }
        assert [records[a]["state_hash"] for a in (1, 2, 3)] == ["aaa", "bbb", "ccc"]
        for a in (1, 2, 3):
            assert records[a]["state_binding"] == STATE_BINDING_ATTEMPT

    def test_missing_snapshot_falls_back_without_borrowing(self, tmp_path):
        # A row with no snapshot must not inherit a neighbour's hash.
        rows = [
            {
                **_row(1, [{"id": "G01", "status": "fail", "phase": "backend"}]),
                "state_hash": None,
            },
            {
                **_row(2, [{"id": "G01", "status": "pass", "phase": "backend"}]),
                "state_hash": "bbb",
                "state_alg": "walk-v1",
            },
        ]
        run = _write_run(tmp_path, rows, [{"id": "G01", "file": "a.test.ts"}])
        emit_for_run(run)
        records = {
            json.loads(l)["attempt"]: json.loads(l)
            for l in open(run / "predicate-outcomes.jsonl")
        }
        assert records[1]["state_hash"] == ""
        assert records[1]["state_binding"] == STATE_BINDING_NOT_RETAINED
        assert records[2]["state_hash"] == "bbb"
        assert records[2]["state_binding"] == STATE_BINDING_ATTEMPT
