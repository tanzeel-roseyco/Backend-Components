import hashlib
import hmac
from typing import Any, cast

import pytest
import requests

from backend_components.integrations.exchange_hmac_auth import SignedRequestClient
from backend_components.utilities.resilient_http_client import (
    CircuitBreaker,
    _parse_retry_after,
    fetch_json,
    make_session,
)


class FakeResponse:
    def __init__(self, status_code: int, payload: Any) -> None:
        self.status_code = status_code
        self._payload = payload
        self.headers: dict[str, str] = {}

    def json(self) -> Any:
        return self._payload


class FakeSession:
    def __init__(self, response: FakeResponse | Exception) -> None:
        self.response = response

    def get(self, url: str, **kwargs: Any) -> FakeResponse:
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def test_exchange_signature_matches_documented_wire_payload() -> None:
    client = SignedRequestClient(api_key="key", api_secret="secret", recv_window="5000")

    headers = client._sign("1000", "coin=USDT")
    expected = hmac.new(b"secret", b"1000key5000coin=USDT", hashlib.sha256).hexdigest()

    assert headers["X-BAPI-SIGN"] == expected
    assert SignedRequestClient(api_key="", api_secret="").signed_get("/private") is None


def test_http_session_configures_identity_and_secret_header() -> None:
    session = make_session(api_key="token", api_key_header="Authorization", user_agent="test/1")

    assert session.headers["Authorization"] == "token"
    assert session.headers["User-Agent"] == "test/1"


def test_fetch_json_records_success_and_transport_failure() -> None:
    breaker = CircuitBreaker(threshold=1, cooloff_s=0)
    session = cast(requests.Session, FakeSession(FakeResponse(200, {"ok": True})))
    assert fetch_json(session, "https://example.test", breaker=breaker) == {"ok": True}

    failed = cast(requests.Session, FakeSession(requests.exceptions.Timeout()))
    assert fetch_json(failed, "https://example.test", breaker=breaker) is None
    assert breaker._opened_at is not None


@pytest.mark.parametrize(
    ("value", "expected"),
    [(None, 60.0), ("-1", 0.0), ("999999", 300.0), ("invalid", 60.0)],
)
def test_retry_after_is_bounded(value: str | None, expected: float) -> None:
    assert _parse_retry_after(value) == expected
