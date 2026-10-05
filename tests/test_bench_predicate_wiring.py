from __future__ import annotations

from pathlib import Path

from harness.adapters.bench_report import parse_failing_ids


def test_parse_failing_ids_matches_expected_order_ignoring_noise(
    tmp_path: Path,
) -> None:
    report = "\n".join(
        [
            "OKP-BENCH-REPORT v1",
            '{"test":"REQ-PIP","status":"pass"}',
            '{"test":"REQ-TURN","status":"fail"}',
            "not-json-at-all",
            "",
            '{"test":"REQ-CUBE-STATE","status":"fail"}',
            '{"test":"REQ-TURN","status":"fail"}',  # dup -> first-wins, ignored
            '{"test":"","status":"fail"}',  # empty test -> ignored
            '{"test":"REQ-DEBUG","status":"skip"}',  # invalid status -> ignored
            '{"test":"REQ-COMPLETE","status":"pass"}',
            '{"test":"REQ-INIT","status":"fail"}',
        ]
    )

    assert parse_failing_ids(report) == [
        "REQ-TURN",
        "REQ-CUBE-STATE",
        "REQ-INIT",
    ]


def test_parse_failing_ids_returns_empty_when_header_absent() -> None:
    report = "\n".join(
        [
            '{"test":"REQ-TURN","status":"fail"}',
            '{"test":"REQ-PIP","status":"pass"}',
        ]
    )

    assert parse_failing_ids(report) == []


def test_parse_failing_ids_returns_empty_when_header_is_blank_only() -> None:
    report = "\n\n\n"

    assert parse_failing_ids(report) == []


def test_parse_failing_ids_returns_empty_on_all_pass() -> None:
    report = "\n".join(
        [
            "OKP-BENCH-REPORT v1",
            '{"test":"REQ-PIP","status":"pass"}',
            '{"test":"REQ-TURN","status":"pass"}',
        ]
    )

    assert parse_failing_ids(report) == []


def test_parse_failing_ids_dedupes_first_wins(tmp_path: Path) -> None:
    report = "\n".join(
        [
            "OKP-BENCH-REPORT v1",
            '{"test":"REQ-TURN","status":"fail"}',
            '{"test":"REQ-TURN","status":"fail"}',
            '{"test":"REQ-TURN","status":"pass"}',
        ]
    )

    assert parse_failing_ids(report) == ["REQ-TURN"]


def test_parse_failing_ids_handles_leading_blank_lines_before_header() -> None:
    report = "\n".join(
        [
            "",
            "  OKP-BENCH-REPORT v1  ",
            '{"test":"REQ-TURN","status":"fail"}',
        ]
    )

    assert parse_failing_ids(report) == ["REQ-TURN"]
