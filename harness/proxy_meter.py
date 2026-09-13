from __future__ import annotations

from dataclasses import dataclass
import logging
import statistics
from typing import Any

import psycopg

from harness.contention import ContentionCovariates


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ModelIdentity:
    model: str
    upstream_model: str | None
    calls: int


class SpendMeter:
    """Read-only spend meter over spend-proxy Postgres events.

    TRUE spend means `actual_spend_usd` (cache-discounted real spend used for
    budget decisions). BENCHMARK spend means `theoretical_spend_usd`
    (full-price synthetic comparator used for scoring only).
    """

    def __init__(self, dsn: str, *, connect_timeout_s: int = 5) -> None:
        self._dsn = dsn
        self._connect_timeout_s = connect_timeout_s

    def _connect(self) -> psycopg.Connection[Any]:
        return psycopg.connect(self._dsn, connect_timeout=self._connect_timeout_s)

    def contention_covariates(
        self,
        session_id: str | None,
        *,
        retry_count: int = 0,
        wall_seconds: float | None = None,
        wall_near_timeout: bool = False,
    ) -> ContentionCovariates:
        if not session_id:
            return ContentionCovariates.empty(
                retry_count=retry_count,
                wall_seconds=wall_seconds,
                wall_near_timeout=wall_near_timeout,
            )

        query = (
            "SELECT "
            "COUNT(*) FILTER (WHERE upstream_status=429), "
            "COUNT(*) FILTER (WHERE upstream_status=402), "
            "COUNT(*) FILTER (WHERE err IS NOT NULL), "
            "MAX(request_ms), "
            "ARRAY_AGG(request_ms ORDER BY request_ms) FILTER (WHERE request_ms IS NOT NULL) "
            "FROM spend_events WHERE session_id=%s"
        )
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(query, (session_id,))
                row = cur.fetchone()

        if row is None:
            row = (0, 0, 0, None, [])

        request_ms_values = [int(value) for value in (row[4] or [])]
        median_request_ms = (
            int(statistics.median(request_ms_values)) if request_ms_values else None
        )
        covariates = ContentionCovariates(
            http_429_count=int(row[0]),
            http_402_count=int(row[1]),
            retry_count=int(retry_count),
            upstream_error_count=int(row[2]),
            max_request_ms=int(row[3]) if row[3] is not None else None,
            median_request_ms=median_request_ms,
            wall_seconds=wall_seconds,
            wall_near_timeout=bool(wall_near_timeout),
        )
        logger.info(
            "proxy_meter.contention_covariates op=contention_covariates session_id=%s http_429_count=%s http_402_count=%s upstream_error_count=%s max_request_ms=%s median_request_ms=%s retry_count=%s wall_near_timeout=%s",
            session_id,
            covariates.http_429_count,
            covariates.http_402_count,
            covariates.upstream_error_count,
            covariates.max_request_ms,
            covariates.median_request_ms,
            covariates.retry_count,
            covariates.wall_near_timeout,
        )
        return covariates

    def model_identity(self, session_id: str) -> list[ModelIdentity]:
        query = (
            "SELECT model, upstream_model, COUNT(*) "
            "FROM spend_events WHERE session_id=%s GROUP BY model, upstream_model"
        )
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(query, (session_id,))
                rows = cur.fetchall()

        identities = [
            ModelIdentity(
                model=str(model), upstream_model=upstream_model, calls=int(calls)
            )
            for model, upstream_model, calls in rows
        ]
        logger.info(
            "proxy_meter.model_identity op=model_identity session_id=%s identity_rows=%s",
            session_id,
            len(identities),
        )
        return identities
