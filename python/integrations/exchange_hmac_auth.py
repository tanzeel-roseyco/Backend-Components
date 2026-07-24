"""
================================================================================
Exchange HMAC Auth — reusable signed-request API client (Bybit v5 compatible)
================================================================================
Purpose
-------
A small, dependency-light client for calling HMAC-SHA256 signed REST endpoints
of crypto exchanges that follow the Bybit v5 signing scheme
(timestamp + api_key + recv_window + query/body, HMAC-SHA256 over the secret).

It is written as a generic signed-request client so it can be reused across
scanners/bots, with a thin convenience helper for fetching a Unified-account
wallet balance as a worked example of a signed GET.

Required environment variables
------------------------------
  EXCHANGE_API_KEY      Public API key.
  EXCHANGE_API_SECRET   Private API secret used to compute the HMAC signature.

Credentials are read from the environment ONLY. Never hardcode keys in source,
and never commit them to files that sync to cloud storage or version control.

Key dependencies
----------------
  requests   HTTP client (external). Swap for httpx/urllib if preferred.
  hmac/hashlib/time  stdlib — signing + timestamps.

AIDEV-NOTE: Adapted and generalized from a production codebase.
Role: transport-layer auth for signed exchange requests. Security/ordering
constraints that MUST hold for a valid signature:
  1. The signed payload string is order-sensitive:
     `timestamp + api_key + recv_window + params`. The `params` string used to
     build the signature MUST be byte-identical to what is sent on the wire
     (same key order, same encoding). Re-sorting query params after signing
     breaks auth.
  2. `timestamp` is milliseconds since epoch and must be within `recv_window`
     of the server clock, so system clock skew causes auth failures.
  3. Secrets live only in env; this module must never log the secret or the
     computed signature at INFO or above.
================================================================================
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import time
from typing import Optional

import requests  # AIDEV-NOTE: only external dep; isolates HTTP so core signing stays pure.

log = logging.getLogger(__name__)

# ── Defaults (override per-instance) ─────────────────────────────────────────
DEFAULT_BASE_URL = "https://api.bybit.com"
DEFAULT_RECV_WINDOW = "5000"  # ms the server tolerates between our timestamp and its clock
DEFAULT_TIMEOUT = 10  # seconds per HTTP attempt
DEFAULT_MAX_RETRIES = 3

# Env var names — the ONLY place credentials come from.
ENV_API_KEY = "EXCHANGE_API_KEY"
ENV_API_SECRET = "EXCHANGE_API_SECRET"


def _get_credentials() -> tuple[str, str]:
    """
    Read API credentials from environment variables.

    Returns:
        (api_key, api_secret) with surrounding whitespace stripped. Either value
        is an empty string when its env var is unset — the caller decides whether
        to fail hard or fall back to public/unauthenticated mode.
    """
    api_key = os.environ.get(ENV_API_KEY, "").strip()
    api_secret = os.environ.get(ENV_API_SECRET, "").strip()
    return api_key, api_secret


def _parse_float(value: object) -> Optional[float]:
    """
    Parse a numeric field from an API envelope into a float.

    AIDEV-NOTE: Bybit returns "" (empty string), not 0, for balance fields a coin
    has no position in — and occasionally None. Bare float("") / float(None)
    raises, so every external numeric field must go through here. Returns None on
    any unparseable input rather than crashing the caller.
    """
    if value is None or value == "":
        return None
    try:
        return float(value)  # type: ignore[arg-type]  # str/int/float accepted; else caught below
    except (TypeError, ValueError):
        return None


class SignedRequestClient:
    """
    Minimal HMAC-SHA256 signed-request client for Bybit-v5-style REST APIs.

    Credentials are resolved from the environment by default (EXCHANGE_API_KEY /
    EXCHANGE_API_SECRET) but may be injected explicitly for testing or
    multi-account use. Instances are cheap; construct one per (base_url, account).

    Example:
        client = SignedRequestClient()
        if client.has_credentials:
            data = client.signed_get(
                "/v5/account/wallet-balance",
                "accountType=UNIFIED&coin=USDT",
            )
    """

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        api_secret: Optional[str] = None,
        base_url: str = DEFAULT_BASE_URL,
        recv_window: str = DEFAULT_RECV_WINDOW,
        timeout: int = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> None:
        """
        Args:
            api_key:     Public key. Falls back to EXCHANGE_API_KEY when None.
            api_secret:  Private secret. Falls back to EXCHANGE_API_SECRET when None.
            base_url:    API root, no trailing slash.
            recv_window: Signed request validity window in ms (as a string, since
                         it is concatenated verbatim into the signed payload).
            timeout:     Per-request HTTP timeout in seconds.
            max_retries: Attempts before giving up; uses exponential backoff.
        """
        env_key, env_secret = _get_credentials()
        self._api_key = (api_key if api_key is not None else env_key).strip()
        self._api_secret = (api_secret if api_secret is not None else env_secret).strip()
        self.base_url = base_url.rstrip("/")
        self.recv_window = recv_window
        self.timeout = timeout
        self.max_retries = max(1, max_retries)

    @property
    def has_credentials(self) -> bool:
        """True only when both key and secret are present."""
        return bool(self._api_key and self._api_secret)

    def _sign(self, timestamp: str, params: str) -> dict[str, str]:
        """
        Build Bybit v5 HMAC-SHA256 signed headers for a given request.

        AIDEV-NOTE: Payload concatenation order is fixed by the exchange spec —
        `timestamp + api_key + recv_window + params`. `params` must be the exact
        query string (for GET) or raw JSON body (for POST) sent on the wire.

        Args:
            timestamp: Milliseconds-since-epoch as a string.
            params:    Query string (GET) or raw request body (POST) to sign.

        Returns:
            Header dict ready to pass to the HTTP client.
        """
        payload = timestamp + self._api_key + self.recv_window + params
        signature = hmac.new(
            self._api_secret.encode("utf-8"),
            payload.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return {
            "X-BAPI-API-KEY": self._api_key,
            "X-BAPI-TIMESTAMP": timestamp,
            "X-BAPI-RECV-WINDOW": self.recv_window,
            "X-BAPI-SIGN": signature,
            "Content-Type": "application/json",
        }

    def signed_get(self, endpoint: str, query: str = "") -> Optional[dict]:
        """
        Perform a signed GET request with exponential-backoff retries.

        Args:
            endpoint: Path beginning with "/", e.g. "/v5/account/wallet-balance".
            query:    URL-encoded query string WITHOUT the leading "?" (may be "").

        Returns:
            Parsed JSON body on success (retCode == 0), or None if credentials
            are missing or all attempts fail / return an API error.
        """
        if not self.has_credentials:
            log.debug("%s / %s not set — skipping signed request", ENV_API_KEY, ENV_API_SECRET)
            return None

        url = f"{self.base_url}{endpoint}"
        if query:
            url = f"{url}?{query}"

        for attempt in range(self.max_retries):
            # AIDEV-NOTE: Re-sign on EVERY attempt. The signature is bound to a
            # millisecond timestamp that must land within recv_window of the
            # server clock; reusing one signature across backoff sleeps
            # (up to 2**attempt s) would push later retries outside the window
            # and turn every retry into a guaranteed auth failure.
            timestamp = str(int(time.time() * 1000))
            headers = self._sign(timestamp, query)
            is_last = attempt == self.max_retries - 1
            try:
                r = requests.get(url, headers=headers, timeout=self.timeout)
                if r.status_code != 200:
                    log.warning("Signed GET HTTP %s (attempt %d)", r.status_code, attempt + 1)
                    if not is_last:
                        time.sleep(2 ** attempt)
                    continue

                data = r.json()
                # Bybit-style envelope: retCode 0 == success, non-zero == error.
                if data.get("retCode") != 0:
                    log.warning(
                        "Signed GET API error: %s (attempt %d)",
                        data.get("retMsg"),
                        attempt + 1,
                    )
                    if not is_last:
                        time.sleep(2 ** attempt)
                    continue

                return data

            except requests.exceptions.Timeout:
                log.warning("Signed GET timeout (attempt %d)", attempt + 1)
                if not is_last:
                    time.sleep(2 ** attempt)
            except requests.exceptions.RequestException as e:
                # AIDEV-NOTE: catch transport errors only; JSON/logic errors above
                # are handled via retCode so we don't mask programming bugs here.
                log.warning("Signed GET request exception: %s (attempt %d)", e, attempt + 1)
                if not is_last:
                    time.sleep(2 ** attempt)

        log.error("Signed GET failed after %d attempts", self.max_retries)
        return None

    def fetch_live_balance(self, coin: str = "USDT") -> Optional[float]:
        """
        Fetch live wallet balance from a Unified Trading Account (worked example
        of a signed GET against the Bybit v5 wallet-balance endpoint).

        Args:
            coin: Coin symbol to report balance for (default "USDT").

        Returns:
            Total equity for `coin` as a float, or None if credentials are missing,
            the API call fails, or the coin is absent from the wallet.
        """
        query = f"accountType=UNIFIED&coin={coin}"
        data = self.signed_get("/v5/account/wallet-balance", query)
        if data is None:
            return None

        # Navigate: result.list[0].coin[].equity  (UNIFIED account layout).
        accounts = data.get("result", {}).get("list", [])
        if not accounts:
            log.warning("Balance response: empty account list")
            return None

        for coin_entry in accounts[0].get("coin", []):
            if coin_entry.get("coin") == coin:
                balance = _parse_float(coin_entry.get("equity"))
                if balance is not None:
                    log.info("  Live balance: %s %s", f"{balance:,.2f}", coin)
                    return balance
                break  # matched the coin but equity is blank — try totalEquity fallback

        # Coin not itemized (or blank equity) — fall back to account-level totalEquity.
        total = _parse_float(accounts[0].get("totalEquity"))
        if total is not None:
            log.info("  Live balance (totalEquity): %s %s", f"{total:,.2f}", coin)
            return total

        log.warning("Balance response: %s not found in wallet", coin)
        return None

    def fetch_live_balance_with_fallback(self, fallback: float, coin: str = "USDT") -> float:
        """
        Fetch live balance, returning `fallback` when credentials are missing or
        the live fetch fails. Safe for use in tools that must run unauthenticated.

        Args:
            fallback: Value to return when no live balance is available.
            coin:     Coin symbol to check (default "USDT").

        Returns:
            The live balance when available and positive, otherwise `fallback`.
        """
        live = self.fetch_live_balance(coin)
        if live is not None and live > 0:
            return live
        if not self.has_credentials:
            log.debug("  No credentials — using fallback balance: $%s", f"{fallback:,.2f}")
        else:
            log.warning("  Live balance unavailable — using fallback: $%s", f"{fallback:,.2f}")
        return fallback


# ── Module-level convenience wrappers (backwards-compatible functional API) ──
# AIDEV-NOTE: these mirror the original free-function interface so existing
# call sites keep working; each builds a throwaway env-configured client.

def fetch_live_balance(coin: str = "USDT") -> Optional[float]:
    """Env-configured one-shot balance fetch. See SignedRequestClient.fetch_live_balance."""
    return SignedRequestClient().fetch_live_balance(coin)


def fetch_live_balance_with_fallback(fallback: float, coin: str = "USDT") -> float:
    """Env-configured one-shot balance fetch with fallback. See the client method."""
    return SignedRequestClient().fetch_live_balance_with_fallback(fallback, coin)
