# Exchange HMAC client

`SignedRequestClient` calls REST endpoints using the Bybit v5 HMAC-SHA256 signing layout. It handles signed GET and POST requests, bounded retries, receive-window headers, response parsing, and a convenience balance lookup.

Credentials come from `EXCHANGE_API_KEY` and `EXCHANGE_API_SECRET`. Callers can override the base URL, receive window, timeout, retry count, and session. Signatures depend on the exact timestamp, key, receive window, and transmitted parameter string.

Missing credentials cause signed work to be skipped or rejected according to the called method. Clock skew, parameter reordering, exchange error responses, and network failures can all prevent a request from succeeding. The fallback balance helper explicitly substitutes a caller-provided number, so it should not be mistaken for confirmed live data.

The module depends on `requests` and has no dedicated tests in this repository. It is compatible with the documented Bybit-style scheme; compatibility with other exchanges is not implied.
