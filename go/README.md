# Go components

This directory is an independent Go module containing the production-ready
`auth` rate limiter.

## Requirements

- Go 1.24
- Docker for the repository verification path

## Use

The directory is a nested Go module. Until a `go/v*` module tag is published,
use a checked-out copy through a workspace or a `replace` directive. Import the
component as:

```go
import "github.com/tanzeel-roseyco/Backend-Components/go/auth"
```

## Verify

```sh
docker build -f Dockerfile.test -t backend-components-go-test .
docker run --rm backend-components-go-test
```

The image runs `go vet ./...` while building and `go test -race ./...` when
started.

## Architecture

The package keeps policy in `RateLimiter` and persistence behind the typed,
atomic `RateLimiterStorage` port. `InMemoryStorage` is a concurrency-safe
single-process adapter. Distributed deployments must provide storage whose
`Update` operation is atomic for each key.

Create the limiter with `auth.NewRateLimiter`, call `CheckLimit` before an
authentication attempt, `RecordFailure` after rejection, and `RecordSuccess`
after successful authentication. `CheckLimit` does not consume an attempt.

`ExtractClientIP` trusts `X-Forwarded-For` only when the immediate peer belongs
to an explicitly configured trusted-proxy CIDR. `HashIP` requires a secret of
at least 32 bytes and produces stable pseudonymisation, not anonymity. Keep the
secret outside source control.

The limiter is application-level abuse control, not a replacement for edge
throttling. The included memory adapter loses state on restart and cannot
coordinate multiple processes.

## Current state

The Go module has deterministic lifecycle, validation, proxy-trust, hashing,
and concurrent-update tests. It has no durable or distributed storage adapter.
The root repository's `v1.0.0` tag is not a Go submodule release. No stable
`go/v*` module tag is currently published.
