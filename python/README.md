# Python backend components

This directory is an installable Python 3.12 package containing nine reusable
components. Each source module retains its adjacent component README with its
specific contract, inputs, and operational constraints.

## Layout

```text
backend_components/
  auth/             rate limiting
  business_logic/   indicators, signals, and trade journal
  database/         exchange market-data access and caching
  integrations/     signed exchange HTTP client
  utilities/        immutable config, HMAC tokens, resilient HTTP
tests/               deterministic tests with no live network calls
```

Import components through the package namespace:

```python
from backend_components.utilities.hmac_token import HMACToken
```

## Install

Runtime dependencies and supported Python version are declared and directly
pinned in `pyproject.toml`:

```bash
python -m pip install .
```

For development:

```bash
python -m pip install -r requirements-dev.txt
```

`requirements-dev.txt` installs the package's pinned development extra. It is
the single developer entry point; dependency changes belong in `pyproject.toml`.

## Verify

The supported quality gate runs entirely in Docker:

```bash
docker build -f Dockerfile.test -t backend-components-python-test .
docker run --rm backend-components-python-test
```

The container runs Ruff, strict mypy, and pytest in sequence across the entire
package and test suite. Tests cover every module and do not call live exchanges
or require credentials.

## Current state

- The package builds and imports through `backend_components`.
- Runtime and development dependencies are directly pinned.
- All nine modules have deterministic automated coverage.
- Live integrations remain caller-configured and are not exercised in tests.
- Individual component READMEs remain the authoritative behavioral references.
