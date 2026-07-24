# Go Components

Production-ready Go implementations of backend components.

## Components

### Authentication (`./auth/`)
- **rate_limiter.go** — IP-based login rate limiter with configurable lockouts
- More coming...

### Database (`./database/`)
- Coming soon...

### API Middleware (`./api-middleware/`)
- Coming soon...

## Installation

```bash
go get github.com/tanzeel-roseyco/Backend-Components/go
```

## Usage

```go
package main

import (
    "context"
    "github.com/tanzeel-roseyco/Backend-Components/go/auth"
)

func main() {
    storage := auth.NewInMemoryStorage()
    limiter := auth.NewRateLimiter(5, 15, 24, storage)

    result, err := limiter.CheckLimit(context.Background(), ipAddress)
    if !result.Allowed {
        // Return 429 Too Many Requests
    }
}
```

## Testing

```bash
go test ./...
```

## Contributing

- Follow Go code style guidelines
- Add comments to exported functions
- Include unit tests
- Use interfaces for extensibility
