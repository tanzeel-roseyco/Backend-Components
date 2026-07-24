# Python Components

Production-ready Python implementations of backend components.

## Components

### Authentication (`./auth/`)
- **rate_limiter.py** — IP-based login rate limiter with configurable lockouts
- More coming...

### Database (`./database/`)
- Coming soon...

### API Middleware (`./api-middleware/`)
- Coming soon...

### Business Logic (`./business_logic/`)
- Coming soon...

### Utilities (`./utilities/`)
- **immutable_config.py** — Immutable configuration dataclass with environment variable support
- **hmac_token.py** — HMAC token generation and verification with RFC 8058 compliance
- More coming...

## Installation

```bash
pip install -r requirements.txt
```

## Usage

```python
from auth.rate_limiter import RateLimiter

limiter = RateLimiter(
    max_attempts=5,
    lockout_minutes=15,
)

result = await limiter.check_limit(ip_address)
if not result.allowed:
    # Return 429 Too Many Requests
```

## Testing

```bash
pytest
```

## Contributing

- Use type hints (mypy compatible)
- Add docstrings to functions
- Include unit tests
- Follow PEP 8 style guide
