"""
================================================================================
Resilient HTTP Client — retrying session with fast-fail DNS, visible retries,
exponential backoff + jitter, and an optional global circuit breaker.
================================================================================

Purpose
-------
A drop-in, hardened replacement for a bare `requests.Session()` for any service
that makes many outbound GET calls to a third-party JSON API (rate-limited,
occasionally slow, occasionally unreachable). It turns silent multi-minute
network hangs into fast, visible, bounded failures.

What it gives you
-----------------
  - urllib3 Retry adapter: retries connect/read errors AND 429/5xx automatically
  - Aggressive connect timeouts (default 5s) — fail fast on dead DNS instead of
    waiting out the OS-level ~30s resolver timeout
  - Generous read timeouts (default 20s) — upstreams are sometimes slow but alive
  - Exponential backoff WITH JITTER — avoids thundering-herd retries
  - Per-request logging hook so retries are VISIBLE instead of silent hangs
  - Optional global circuit breaker — after N consecutive failures, pause the
    whole workload for a configurable cool-off instead of fighting a dead
    network request-by-request

Required / optional environment variables
-----------------------------------------
  - API_KEY        (optional) — upstream API key; injected as a request header.
                    Read by the CALLER and passed to `make_session(api_key=...)`.
                    Never hard-code a key; resolve it via `os.environ.get`.
  - API_KEY_HEADER (optional) — header name the upstream expects the key under
                    (e.g. "X-API-Key", "Authorization"). Defaults to "X-API-Key".

Key dependencies
----------------
  - requests
  - urllib3 (>=2.0 for `backoff_jitter`; older versions still work, jitter no-op)

Usage
-----
    import os
    from resilient_http_client import make_session, fetch_json, CircuitBreaker

    session = make_session(
        api_key=os.environ.get("API_KEY"),
        api_key_header=os.environ.get("API_KEY_HEADER", "X-API-Key"),
    )
    data = fetch_json(session, f"{API_BASE}/resource", params={...})

    # Or use the session directly — it has retries baked in:
    r = session.get(url, params=params, timeout=(5, 20))

AIDEV-NOTE: Adapted and generalized from a production codebase where a
bare Session blocked ~30s per DNS lookup and then looped on `time.sleep(5)` with
no log line, so one network hiccup read as a multi-minute hang. Ordering/security
constraints: (1) connect timeout MUST stay short — that is where DNS blocking
lives; a long connect timeout defeats the whole point. (2) Only idempotent
methods (GET/HEAD) are retried by default; do NOT add POST to `allowed_methods`
without deliberate idempotency guarantees. (3) API keys are injected as headers
from caller-supplied values only — never embed a literal key here.
================================================================================
"""
from __future__ import annotations

import logging
import random
import time
from typing import Any, Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

log = logging.getLogger(__name__)

# Timeouts: (connect, read). Connect MUST be short — that's where DNS lives.
DEFAULT_TIMEOUT: tuple[float, float] = (5.0, 20.0)

# Status codes worth retrying. 408 = request timeout, 425 = too early,
# 429 = rate limited, 500/502/503/504 = server problems.
RETRY_STATUSES: frozenset[int] = frozenset({408, 425, 429, 500, 502, 503, 504})

# Upper bound on any single Retry-After wait. A hostile or misconfigured upstream
# can send "Retry-After: 999999" (or an HTTP-date far in the future); without a
# cap the worker would sleep for hours/days. 300s is long enough to respect a
# genuine rate-limit window but short enough to stay responsive.
MAX_RETRY_AFTER_S: float = 300.0


def _parse_retry_after(value: str | None, default: float = 60.0) -> float:
    """Parse a ``Retry-After`` header into a bounded, non-negative seconds value.

    Per RFC 7231 the header is EITHER an integer number of seconds OR an
    HTTP-date. A bare ``int(value)`` (the naive approach) raises ``ValueError``
    on the date form and would break the caller's non-throwing contract, so this
    handles both forms and clamps the result to ``[0, MAX_RETRY_AFTER_S]``.
    """
    if not value:
        return min(default, MAX_RETRY_AFTER_S)
    value = value.strip()
    try:
        # Common case: delay-seconds as a plain integer.
        seconds = float(int(value))
    except ValueError:
        # HTTP-date form, e.g. "Wed, 21 Oct 2015 07:28:00 GMT".
        try:
            from email.utils import parsedate_to_datetime

            retry_at = parsedate_to_datetime(value)
            if retry_at is None:
                return min(default, MAX_RETRY_AFTER_S)
            # Both sides tz-aware; use the header's tz (UTC when unspecified).
            from datetime import datetime, timezone

            now = datetime.now(retry_at.tzinfo or timezone.utc)
            seconds = (retry_at - now).total_seconds()
        except (TypeError, ValueError):
            return min(default, MAX_RETRY_AFTER_S)
    # Clamp: never negative (past dates / clock skew), never above the cap.
    return max(0.0, min(seconds, MAX_RETRY_AFTER_S))


class LoggingRetry(Retry):
    """Retry subclass that logs each retry instead of failing silently.

    Standard `urllib3.util.retry.Retry` retries silently and exhausts without
    telling you why. This subclass emits one log line per retry so you can see
    in real time that the client is fighting a flaky network, not hung.
    """

    def increment(  # type: ignore[override]
        self,
        method: Optional[str] = None,
        url: Optional[str] = None,
        response: Any = None,
        error: Optional[Exception] = None,
        _pool: Any = None,
        _stacktrace: Any = None,
    ) -> "Retry":
        if error is not None:
            log.warning(
                f"  retry: {type(error).__name__} on {method} {url} "
                f"(retries left: {self.total - 1 if self.total else 0})"
            )
        elif response is not None:
            log.warning(
                f"  retry: HTTP {response.status} on {method} {url} "
                f"(retries left: {self.total - 1 if self.total else 0})"
            )
        return super().increment(method, url, response, error, _pool, _stacktrace)


def make_session(
    *,
    api_key: str | None = None,
    api_key_header: str = "X-API-Key",
    user_agent: str = "resilient-http-client/1.0",
    total_retries: int = 4,
    backoff_factor: float = 1.5,
    pool_connections: int = 10,
    pool_maxsize: int = 20,
) -> requests.Session:
    """Build a `requests.Session` with retries, a sized pool, and a User-Agent.

    Args:
        api_key: Optional upstream API key. When provided, it is injected as a
            request header under ``api_key_header``. Resolve this from the
            environment in the caller (e.g. ``os.environ.get("API_KEY")``);
            never hard-code a literal key.
        api_key_header: Header name the upstream expects the key under
            (e.g. ``"X-API-Key"``, ``"Authorization"``).
        user_agent: Value for the ``User-Agent`` header.
        total_retries: Max retries for connect, read, and retryable statuses.
        backoff_factor: Exponential backoff base. With 4 retries this yields
            waits of roughly 1.5s, 3s, 6s, 12s (~22s worst case before final
            failure), plus jitter (urllib3 >=2.0 adds 0-1s on top).
        pool_connections: Number of connection pools to cache.
        pool_maxsize: Max connections to save in the pool.

    Returns:
        A configured `requests.Session`. Retries are baked into the mounted
        adapter, so plain ``session.get(...)`` calls inherit them.
    """
    retry = LoggingRetry(
        total=total_retries,
        connect=total_retries,          # retry on connect errors (covers DNS)
        read=total_retries,             # retry on read timeouts
        status=total_retries,           # retry on retryable HTTP statuses
        status_forcelist=RETRY_STATUSES,
        allowed_methods=frozenset({"GET", "HEAD"}),  # don't retry POSTs blindly
        backoff_factor=backoff_factor,
        backoff_jitter=1.0,             # urllib3 >=2.0 supports this
        respect_retry_after_header=True,
        raise_on_status=False,
    )

    adapter = HTTPAdapter(
        max_retries=retry,
        pool_connections=pool_connections,
        pool_maxsize=pool_maxsize,
    )

    s = requests.Session()
    s.mount("https://", adapter)
    s.mount("http://", adapter)

    headers: dict[str, str] = {"User-Agent": user_agent}
    if api_key:
        # AIDEV-NOTE: key comes from the caller (env-resolved) — never a literal.
        headers[api_key_header] = api_key
    s.headers.update(headers)

    return s


# ─────────────────────────────────────────────────────────────────────────────
# CIRCUIT BREAKER — stop fighting a dead network
# ─────────────────────────────────────────────────────────────────────────────
class CircuitBreaker:
    """After N consecutive failures, pause for ``cooloff_s`` before resuming.

    Use case: if the network drops for real (not a single-request blip), the
    retry adapter will dutifully waste ~22s per call fighting a dead network.
    The breaker detects sustained failure and pauses ONCE for a long cool-off,
    then resumes half-open — a much better experience than per-call thrashing.

    Usage:
        breaker = CircuitBreaker(threshold=5, cooloff_s=60)
        for item in items:
            breaker.wait_if_open()
            try:
                do_request(item)
                breaker.record_success()
            except Exception:
                breaker.record_failure()
    """

    def __init__(self, threshold: int = 5, cooloff_s: float = 60.0) -> None:
        self.threshold = threshold
        self.cooloff_s = cooloff_s
        self._fails = 0
        self._opened_at: float | None = None

    def record_success(self) -> None:
        """Reset the breaker after a successful request."""
        if self._fails or self._opened_at:
            log.info(f"  network recovered after {self._fails} failure(s)")
        self._fails = 0
        self._opened_at = None

    def record_failure(self) -> None:
        """Count a failure and open the breaker once the threshold is crossed."""
        self._fails += 1
        if self._fails >= self.threshold and self._opened_at is None:
            self._opened_at = time.time()
            log.warning(
                f"  circuit breaker OPEN — {self._fails} consecutive failures. "
                f"Pausing {self.cooloff_s:.0f}s before resuming."
            )

    def wait_if_open(self) -> None:
        """Block for the remaining cool-off if the breaker is open, then half-open.

        AIDEV-NOTE: This transitions OPEN -> HALF-OPEN by clearing `_opened_at`
        and letting the next request through. The next `record_success` fully
        closes the breaker; the next `record_failure` re-opens it (fail count is
        NOT reset here, so a still-dead network re-opens immediately).
        """
        if self._opened_at is None:
            return
        elapsed = time.time() - self._opened_at
        remaining = self.cooloff_s - elapsed
        if remaining > 0:
            time.sleep(remaining)
        # half-open: let the next request try; if it succeeds, the breaker closes
        self._opened_at = None
        log.info("  circuit breaker HALF-OPEN — trying one request...")


# ─────────────────────────────────────────────────────────────────────────────
# CONVENIENCE WRAPPER
# ─────────────────────────────────────────────────────────────────────────────
def fetch_json(
    session: requests.Session,
    url: str,
    *,
    params: dict[str, Any] | None = None,
    timeout: tuple[float, float] = DEFAULT_TIMEOUT,
    breaker: CircuitBreaker | None = None,
) -> Any | None:
    """GET a URL and return parsed JSON, or ``None`` on any failure.

    Retries are handled by the session's mounted adapter; this wrapper adds the
    optional circuit breaker and uniform, non-throwing error logging. Every
    failure path returns ``None`` and records a breaker failure (if provided),
    so callers can loop over many URLs without try/except at each call site.

    Args:
        session: A session from `make_session` (or any `requests.Session`).
        url: Fully-qualified request URL.
        params: Optional query-string parameters.
        timeout: ``(connect, read)`` timeout tuple.
        breaker: Optional `CircuitBreaker` to gate/record this request.

    Returns:
        Parsed JSON on HTTP 200 with a JSON body, otherwise ``None``.
    """
    if breaker is not None:
        breaker.wait_if_open()

    try:
        r = session.get(url, params=params, timeout=timeout)
    except requests.exceptions.ConnectionError as e:
        cause = type(e.__cause__).__name__ if e.__cause__ else "ConnectionError"
        log.warning(f"  connection failed: {url} — {cause}")
        if breaker:
            breaker.record_failure()
        return None
    except requests.exceptions.Timeout:
        log.warning(f"  timeout: {url}")
        if breaker:
            breaker.record_failure()
        return None
    except requests.exceptions.RequestException as e:
        log.warning(f"  request error: {url} — {e}")
        if breaker:
            breaker.record_failure()
        return None

    if r.status_code == 429:
        # Honour Retry-After when present; add jitter so concurrent workers
        # don't wake and re-hammer the upstream in lockstep. Retry-After may be
        # seconds OR an HTTP-date and may be hostile — _parse_retry_after handles
        # both forms and bounds the value to avoid ValueError / multi-hour sleeps.
        wait = _parse_retry_after(r.headers.get("Retry-After"))
        log.warning(f"  rate-limited on {url} — sleeping {wait:.0f}s")
        time.sleep(wait + random.uniform(0, 2))
        if breaker:
            breaker.record_failure()
        return None

    if r.status_code != 200:
        log.warning(f"  HTTP {r.status_code} on {url}")
        if breaker:
            breaker.record_failure()
        return None

    try:
        data = r.json()
    except ValueError:
        log.warning(f"  non-JSON response from {url}")
        if breaker:
            breaker.record_failure()
        return None

    if breaker:
        breaker.record_success()
    return data
