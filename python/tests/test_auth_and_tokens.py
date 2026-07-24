from dataclasses import FrozenInstanceError
from types import SimpleNamespace

import pytest

from backend_components.auth.rate_limiter import (
    InMemoryStorage,
    RateLimiter,
    extract_client_ip,
)
from backend_components.utilities.hmac_token import HMACToken
from backend_components.utilities.immutable_config import AppConfig


@pytest.mark.asyncio
async def test_rate_limiter_locks_and_resets_client() -> None:
    limiter = RateLimiter(max_attempts=2, storage=InMemoryStorage())

    assert (await limiter.check_limit("192.0.2.1")).allowed
    await limiter.record_failure("192.0.2.1")
    await limiter.record_failure("192.0.2.1")
    assert not (await limiter.check_limit("192.0.2.1")).allowed

    await limiter.record_success("192.0.2.1")
    assert (await limiter.check_limit("192.0.2.1")).allowed


def test_client_ip_uses_forwarding_chain_and_safe_fallback() -> None:
    forwarded = SimpleNamespace(
        headers={"x-forwarded-for": "198.51.100.2, 203.0.113.4"}, remote_addr=None
    )
    direct = SimpleNamespace(headers={}, remote_addr=None)

    assert extract_client_ip(forwarded) == "203.0.113.4"
    assert extract_client_ip(direct) == "0.0.0.0"


def test_hmac_token_is_normalized_tamper_evident_and_requires_secret() -> None:
    secret = "s" * 32
    token = HMACToken.sign(" User@Example.com ", secret)

    assert HMACToken.verify("user@example.com", token, secret)
    assert not HMACToken.verify("attacker@example.com", token, secret)
    with pytest.raises(ValueError, match="at least 32"):
        HMACToken.sign("user@example.com", "short")


def test_immutable_config_loads_typed_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_DATABASE_URL", "postgresql://db/app")
    monkeypatch.setenv("APP_REDIS_URL", "redis://cache")
    monkeypatch.setenv("APP_API_URL", "https://api.example.test")
    monkeypatch.setenv("APP_DEBUG", "true")

    config = AppConfig.from_env(prefix="APP")

    assert config.debug is True
    assert config.database_pool_size == 10
    with pytest.raises(FrozenInstanceError):
        setattr(config, "debug", False)
