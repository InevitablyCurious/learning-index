from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ContentionCovariates:
    http_429_count: int | None
    http_402_count: int | None
    retry_count: int
    upstream_error_count: int | None
    max_request_ms: int | None
    median_request_ms: int | None
    wall_seconds: float | None

    @classmethod
    def empty(
        cls,
        *,
        retry_count: int = 0,
        wall_seconds: float | None = None,
    ) -> ContentionCovariates:
        return cls(
            http_429_count=None,
            http_402_count=None,
            retry_count=int(retry_count),
            upstream_error_count=None,
            max_request_ms=None,
            median_request_ms=None,
            wall_seconds=wall_seconds,
        )


__all__ = ["ContentionCovariates"]
