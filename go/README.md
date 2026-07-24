# Go components

This directory is an independent Go module containing the production-ready
`auth` rate limiter.

## Requirements

- Go 1.24
- Docker for the repository verification path

## Install

```sh
go get github.com/tanzeel-roseyco/Backend-Components/go
```

Import the component as:

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

See [auth/rate_limiter.README.md](auth/rate_limiter.README.md) for the API,
security model, and operational limits.

## Current state

The Go module has deterministic lifecycle, validation, proxy-trust, hashing,
and concurrent-update tests. It has no durable or distributed storage adapter.
The `v1.0.0` repository tag establishes its first stable API boundary; earlier
untagged examples are not source-compatible and have no compatibility shim.
