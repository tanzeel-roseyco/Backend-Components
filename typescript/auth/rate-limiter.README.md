# Login rate limiter

This component counts authentication failures by client IP and exposes check, failure, and reset operations.

## Using it

Construct `RateLimiter` with a configuration and a `RateLimiterStorage` implementation, then call its check, failure, and reset operations. `createRateLimitMiddleware` adapts it to request handlers and reads a client address from the request.

The included memory store is suitable for tests and single-process development. Results report whether the attempt is allowed, attempts remaining, and any lockout expiry.

## Limits

The current failure path sets a lockout expiry on the first recorded failure, even when `maxAttempts` is greater than one. It also always trusts `cf-connecting-ip` and `x-forwarded-for`; the `trustProxyHeaders` setting is not used. Fix those behaviors or place the middleware behind a trusted proxy before adopting it.

Despite the configuration type naming Redis, PostgreSQL, and Supabase, this file only supplies the memory implementation; external stores must be implemented by the consumer. Memory state is lost on restart and cannot coordinate multiple processes.
