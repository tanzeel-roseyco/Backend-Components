# Python Components

Production-ready Python implementations. Most were **borrowed from a real
production market-scanner codebase**, then generalized (secrets → env vars,
config parameterized) and adversarially reviewed. All are type-hinted.

## Authentication (`./auth/`)
| File | What it does |
|------|--------------|
| `rate_limiter.py` | Async IP-based login rate limiter with pluggable storage + lockout |

## Integrations (`./integrations/`)
| File | What it does |
|------|--------------|
| `exchange_hmac_auth.py` | HMAC-SHA256 signed-request auth for exchange APIs (Bybit v5 pattern); creds via env |

## Database (`./database/`)
| File | What it does |
|------|--------------|
| `unified_data_layer.py` | Multi-source OHLCV/ticker fetcher: disk caching, frozen-dataclass config, universe construction |

## Business Logic (`./business-logic/`)
| File | What it does |
|------|--------------|
| `technical_indicators.py` | RSI, ATR, MACD, ADX, OBV, SuperTrend, CMF, Bollinger, Keltner — pure numpy/pandas |
| `signal_library.py` | Pure-function signals returning a standardized `SignalResult` (fired/strength/value/extras) |
| `trade_journal.py` | CSV trade logger + analytics: R-multiples, win rate, expectancy, drawdown, CSV-injection sanitization |

## Utilities (`./utilities/`)
| File | What it does |
|------|--------------|
| `resilient_http_client.py` | `requests.Session` with retry, exponential backoff + jitter, DNS timeouts, circuit breaker, retry logging |
| `immutable_config.py` | Frozen-dataclass config with environment loading + validation |
| `hmac_token.py` | HMAC-SHA256 token generation/verification with FastAPI integration example |

## Install

```bash
pip install -r requirements.txt   # numpy, pandas, requests as needed per module
```

## Usage

```python
from auth.rate_limiter import RateLimiter

limiter = RateLimiter(max_attempts=5, lockout_minutes=15)
result = await limiter.check_limit(ip_address)
if not result.allowed:
    ...  # return 429
```

## Conventions
- Full type hints (mypy-friendly)
- Secrets only via `os.getenv` / `os.environ`
- Docstrings on public functions; `AIDEV-NOTE` anchors on non-obvious logic
