# Resilient HTTP client

This module creates a `requests.Session` with retry handling for idempotent reads, bounded connect/read timeouts, exponential backoff, jitter where supported, and optional API-key headers. It also provides a process-local circuit breaker and a `fetch_json` convenience function.

Callers supply configuration to `make_session`; the module does not read API credentials itself. `fetch_json` uses the supplied session and can consult a `CircuitBreaker` before making a request.

Only GET and HEAD requests are retried by default. The circuit breaker is held in memory, so it is neither shared across workers nor durable across restarts. Successful HTTP responses can still fail JSON decoding, and exhausted requests propagate an error rather than returning stale data.

Dependencies are `requests` and `urllib3`. No dedicated test file is present.
