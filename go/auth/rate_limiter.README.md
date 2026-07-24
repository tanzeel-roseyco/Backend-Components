# Go login rate limiter

This package tracks failed authentication attempts by IP address. It exposes checks, failure and success recording, manual reset, a storage interface, an in-memory adapter, proxy-header IP extraction, and a SHA-256 helper for obscuring an IP value.

`NewRateLimiter` accepts the maximum attempts, lockout duration in minutes, reset window in hours, and an optional storage implementation. Storage operations receive a `context.Context` and can return errors to the caller.

The included in-memory map has no locking, is not safe for concurrent use, is not shared between processes, and loses data on restart. Use a concurrency-safe durable adapter in a multi-request service. Forwarding headers must only be trusted behind a configured proxy. `HashIP` is an unsalted deterministic hash, so it is pseudonymisation rather than anonymity.

There is no Go test file in this repository.
