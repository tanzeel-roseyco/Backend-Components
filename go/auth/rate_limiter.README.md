# Login rate limiter

Status: **production-ready core with a process-local adapter**

The package applies a fixed-window failed-authentication limit to an explicit
client identifier. It validates configuration and identifiers, records state
through an atomic typed storage contract, clears state after success, and
allows another attempt after the lockout or reset window expires.

## Usage

```go
limiter, err := auth.NewRateLimiter(auth.Config{
    MaxAttempts: 5,
    Lockout:     15 * time.Minute,
    ResetWindow: 24 * time.Hour,
    Storage:     durableStorage,
})
if err != nil {
    return err
}

decision, err := limiter.CheckLimit(ctx, clientID)
if err != nil {
    return err
}
if !decision.Allowed {
    return errTooManyAttempts
}
```

Call `RecordFailure` only after a rejected authentication attempt and
`RecordSuccess` after a successful one. `CheckLimit` does not consume an
attempt. `Reset` is the explicit administrative reset operation.

## Storage contract

`RateLimiterStorage.Update` must atomically read and mutate a key. This prevents
concurrent failures from being lost. The callback must not be retried after it
has returned an error. A `nil` result deletes the record.

`InMemoryStorage` satisfies the contract with a mutex. It is suitable for one
process and loses state on restart. Multi-instance services need a durable,
shared adapter with per-key atomicity; this repository does not provide one.

## Client IP trust

`ExtractClientIP` accepts the transport peer, request headers, and explicit
trusted-proxy CIDRs. All forwarding headers except `X-Forwarded-For` are
ignored. `X-Forwarded-For` is ignored unless the immediate peer is trusted.
The function walks its values from the trusted edge and returns the first
untrusted address. A trusted peer without that header falls back to the peer.
Invalid peers, CIDRs, or forwarded values return errors.

Only configure networks controlled by the deployer. Trusting a public or
client-controlled proxy range permits rate-limit spoofing.

## Logging

`HashIP` uses HMAC-SHA-256 with a caller-provided secret of at least 32 bytes.
The result is stable pseudonymisation, not anonymity. Keep the secret outside
source control and rotate it according to the application's privacy policy.

## Limits

- This is application-level abuse control, not a substitute for edge/WAF
  throttling.
- A client identifier can represent an IP, account, or a deliberate composite;
  the caller owns that choice and its privacy implications.
- The default memory adapter has no cross-process coordination or persistence.

## Compatibility

This API is source-incompatible with the original untagged repository example:
configuration uses `Config`, storage uses typed atomic `Update`, and IP/hash
helpers require explicit trust and secret inputs. No compatibility wrappers
are provided because no release tag established a public contract. The
repository's `v1.0.0` tag is the first stable compatibility boundary.
