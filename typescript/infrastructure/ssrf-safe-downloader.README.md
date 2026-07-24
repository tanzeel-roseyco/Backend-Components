# SSRF-safe downloader

This downloader fetches HTTPS content only from an explicit host allowlist while pinning the connection to a DNS result that has been checked against private, loopback, link-local, multicast, reserved, and documentation address ranges.

## Using it

Call the exported downloader with exact hostnames plus byte, timeout, and redirect limits. The result is a `Uint8Array` containing the downloaded bytes. DNS resolution can be injected for testing.

Every redirect is validated again. The connection uses the approved address while retaining the original hostname for TLS verification, which reduces DNS rebinding exposure. Responses are streamed and stopped at the configured byte limit.

## Tests

`ssrf-safe-downloader.test.js` covers allowed downloads, blocked addresses, redirects, DNS changes, timeouts, size limits, and malformed destinations.

## Limits

Only HTTPS is supported. The allowlist is exact rather than wildcard-based. Applications must still validate the downloaded media or document format before parsing it.
