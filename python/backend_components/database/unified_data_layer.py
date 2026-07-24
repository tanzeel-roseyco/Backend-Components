"""
================================================================================
UNIFIED DATA LAYER
================================================================================
Single fetcher for multi-source OHLCV + ticker + funding + open-interest (OI)
data, with a shared on-disk cache and deduplicated universe construction.

Adapted and generalized from a production market-data ingestion layer that
consolidated the duplicated fetching code once spread across several
independent scanners.

--------------------------------------------------------------------------------
PURPOSE
--------------------------------------------------------------------------------
  - One on-disk OHLCV cache shared across every consumer
  - Universe construction (deduplicated set of base symbols across venues)
  - Per-symbol OHLCV fetch with cache + closed-bar filtering
  - Bybit ticker snapshot (price, OI, funding, turnover)
  - Bybit OI history (interval-based change)
  - BTC reference data (for market-context / relative-strength signals)

Universes:
  Bybit linear perps (USDT-margined)  — primary, free, no auth required
  Binance USDT spot                   — secondary, complementary coverage

--------------------------------------------------------------------------------
PUBLIC API
--------------------------------------------------------------------------------
  get_universe(source: 'bybit'|'binance'|'both') -> list[dict]
  get_ohlcv(base, source, tf, bars) -> pd.DataFrame | None
  get_btc(tf, bars) -> pd.DataFrame | None
  get_bybit_tickers() -> list[dict]
  get_bybit_oi_history(symbol, interval, limit) -> list[dict]
  get_funding_rates_binance() -> dict[base -> float]
  clear_cache(older_than_hours) -> int

--------------------------------------------------------------------------------
REQUIRED / OPTIONAL ENVIRONMENT VARIABLES  (all optional; sensible defaults)
--------------------------------------------------------------------------------
  DATA_CACHE_DIR      Directory for the shared OHLCV CSV cache.
                      Default: <cwd>/cache/shared_ohlcv
  DATA_LOG_DIR        Directory for rotating daily log files.
                      Default: <cwd>/outputs/logs
  DATA_BYBIT_API      Bybit REST base URL.   Default: https://api.bybit.com
  DATA_BINANCE_API    Binance spot base URL. Default: https://api.binance.com/api/v3
  DATA_BINANCE_FAPI   Binance futures base.  Default: https://fapi.binance.com/fapi/v1
  DATA_USER_AGENT     HTTP User-Agent header. Default: unified-data-layer/1.0

  NOTE: The public exchange endpoints used here require NO API key. If you point
  these at authenticated endpoints, inject credentials via env vars only — never
  hard-code secrets in this module.

--------------------------------------------------------------------------------
KEY DEPENDENCIES
--------------------------------------------------------------------------------
  pandas, requests, urllib3 (urllib3 ships with requests)

--------------------------------------------------------------------------------
Note: Role & constraints
  This module is the single ingestion boundary for all downstream analytics —
  it owns the ONE shared cache and the ONE HTTP retry/backoff policy so callers
  never talk to exchanges directly. Import-safe: no network calls on import
  (only directory creation + logger setup). Two design invariants downstream
  code relies on:
    (1) Only CLOSED bars are ever returned (see _drop_unclosed_bars) — acting on
        the in-progress candle makes signals flicker intrabar and diverge from
        closed-bar backtests. Do NOT remove this filter.
    (2) OHLCV frames always have exactly columns [open, high, low, close, volume],
        UTC-naive DatetimeIndex, oldest-first. Cache format depends on this.
  Security: endpoints are public + read-only; if you add auth, route every
  credential through env vars only.
================================================================================
"""

from __future__ import annotations

import logging
import os
import sys
import time
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Literal, cast

import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


# ─────────────────────────────────────────────────────────────────────────────
# PATHS  — configurable via env so caches/logs can be shared or relocated.
# Defaults are relative to the current working directory to keep the module
# portable across projects.
# ─────────────────────────────────────────────────────────────────────────────
_CACHE_DIR = Path(os.getenv("DATA_CACHE_DIR", str(Path.cwd() / "cache" / "shared_ohlcv")))
_LOG_DIR = Path(os.getenv("DATA_LOG_DIR", str(Path.cwd() / "outputs" / "logs")))
_CACHE_DIR.mkdir(parents=True, exist_ok=True)
_LOG_DIR.mkdir(parents=True, exist_ok=True)


# ─────────────────────────────────────────────────────────────────────────────
# LOGGING
# ─────────────────────────────────────────────────────────────────────────────
log = logging.getLogger("unified_data_layer")
if not log.handlers:
    _log_file = _LOG_DIR / f"data_{datetime.now().strftime('%Y%m%d')}.log"
    handler = logging.FileHandler(_log_file, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    log.addHandler(handler)
    log.setLevel(logging.INFO)


# ─────────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class DataConfig:
    """Immutable runtime configuration for the data layer.

    Frozen so it can be treated as a shared, side-effect-free singleton across
    threads. Values are read from env at construction time (see :data:`CFG`).
    """

    bybit_api: str = os.getenv("DATA_BYBIT_API", "https://api.bybit.com")
    binance_api: str = os.getenv("DATA_BINANCE_API", "https://api.binance.com/api/v3")
    binance_fapi: str = os.getenv("DATA_BINANCE_FAPI", "https://fapi.binance.com/fapi/v1")
    user_agent: str = os.getenv("DATA_USER_AGENT", "unified-data-layer/1.0")
    cache_max_age_h: float = 1.5  # OHLCV reuse window
    btc_cache_max_age_h: float = 1.0  # BTC fetched more often
    # (connect, read): a short connect timeout fails fast on dead DNS instead of
    # blocking ~30s on some platforms' getaddrinfo. Read timeout stays generous
    # so slow-but-alive servers still answer.
    request_timeout_s: tuple[int, int] = (5, 15)
    bybit_min_volume: float = 500_000  # 24h turnover floor (USD)
    binance_min_volume: float = 200_000  # 24h volume floor (USD)


CFG = DataConfig()


# Bases we never want in the universe: stablecoins and wrapped/liquid-staking
# derivatives — they don't behave like tradeable momentum names.
STABLECOINS_AND_WRAPPED: frozenset[str] = frozenset({
    "USDT", "USDC", "DAI", "BUSD", "TUSD", "USDD", "FDUSD", "PYUSD",
    "USDE", "SUSDE", "BFUSD", "RLUSD", "USDG", "USD0", "GHO", "USDAI",
    "WBTC", "WETH", "STETH", "RETH", "CBETH", "PAXG", "XAUT", "TBTC",
    "WBNB", "JITOSOL", "MSOL", "BNSOL", "EURC", "FRAX", "LUSD", "SUSD",
    "CRVUSD", "GUSD", "USDS", "SUSDS", "FRXETH", "OETH", "SUPRETH",
})


# ─────────────────────────────────────────────────────────────────────────────
# HTTP SESSION FACTORY + CIRCUIT BREAKER
#
# Note: Inlined from an internal `http_client` helper in the source
# codebase to keep this module self-contained. Original import was:
#     from http_client import make_session, CircuitBreaker
# make_session() installs a urllib3 Retry adapter that retries connect errors
# (incl. DNS), read timeouts, and 429/5xx with exponential backoff + jitter.
# ─────────────────────────────────────────────────────────────────────────────

def make_session(user_agent: str, total_retries: int = 3) -> requests.Session:
    """Build a ``requests.Session`` with retry/backoff on transient failures.

    Retries connect errors (including DNS resolution failures), read timeouts,
    and 429/5xx responses using exponential backoff with jitter. A separate
    session per host keeps headers and connection pools isolated.

    Args:
        user_agent: Value for the ``User-Agent`` request header.
        total_retries: Max retry attempts per request before giving up.

    Returns:
        A configured :class:`requests.Session`.
    """
    session = requests.Session()
    session.headers.update({"User-Agent": user_agent})
    retry = Retry(
        total=total_retries,
        connect=total_retries,
        read=total_retries,
        status=total_retries,
        # Retry on rate-limit and common transient server errors.
        status_forcelist=(429, 500, 502, 503, 504),
        backoff_factor=0.5,  # 0.5s, 1s, 2s, ... between attempts
        backoff_jitter=0.3,  # spread retries so hosts don't get thundering herds
        allowed_methods=frozenset({"GET"}),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


class CircuitBreaker:
    """Simple thread-safe circuit breaker.

    After ``threshold`` consecutive failures, the breaker opens and short-circuits
    calls for ``cooloff_s`` seconds instead of hammering a dead endpoint. A single
    success (or the cool-off elapsing) closes it again.

    Note: Provided as a reusable guard for callers that want to wrap batch
    fetch loops (e.g. "stop after N dead-network failures, pause once, resume").
    Kept faithful to the source's public shape; the per-request Retry adapter in
    make_session already handles single-request transience.
    """

    def __init__(self, threshold: int = 5, cooloff_s: float = 60.0) -> None:
        self._threshold = threshold
        self._cooloff_s = cooloff_s
        self._failures = 0
        self._opened_at: float | None = None
        self._lock = Lock()

    def is_open(self) -> bool:
        """Return True while the breaker is open (calls should be skipped)."""
        with self._lock:
            if self._opened_at is None:
                return False
            if (time.time() - self._opened_at) >= self._cooloff_s:
                # Cool-off elapsed — half-open: reset and allow the next attempt.
                self._failures = 0
                self._opened_at = None
                return False
            return True

    def record_success(self) -> None:
        """Reset failure count after a successful call."""
        with self._lock:
            self._failures = 0
            self._opened_at = None

    def record_failure(self) -> None:
        """Increment failure count and open the breaker at the threshold."""
        with self._lock:
            self._failures += 1
            if self._failures >= self._threshold and self._opened_at is None:
                self._opened_at = time.time()
                log.warning(
                    "Circuit breaker OPEN after %d consecutive failures; "
                    "pausing %.0fs", self._failures, self._cooloff_s
                )


_BYBIT_SESSION = make_session(user_agent=CFG.user_agent)
_BINANCE_SESSION = make_session(user_agent=CFG.user_agent)

# Shared breaker available to batch callers; see CircuitBreaker docstring.
_BREAKER = CircuitBreaker(threshold=5, cooloff_s=60)


# ─────────────────────────────────────────────────────────────────────────────
# TIMEFRAME MAP — single source of truth for TF labels
# ─────────────────────────────────────────────────────────────────────────────
TF_BYBIT: dict[str, str] = {
    "1m": "1", "5m": "5", "15m": "15", "30m": "30",
    "1h": "60", "2h": "120", "4h": "240", "6h": "360",
    "12h": "720", "1d": "D",
}
TF_BINANCE: dict[str, str] = {
    "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1h", "2h": "2h", "4h": "4h", "6h": "6h",
    "12h": "12h", "1d": "1d",
}

# Duration of one bar per timeframe — used to detect and drop the candle that
# is still forming. Acting on an unclosed bar means signals are computed on a
# partial high/low/close that keeps moving, so they flicker intrabar and don't
# match closed-bar backtests. We only ever evaluate the most recent CLOSED bar.
TF_DELTA: dict[str, timedelta] = {
    "1m": timedelta(minutes=1), "5m": timedelta(minutes=5),
    "15m": timedelta(minutes=15), "30m": timedelta(minutes=30),
    "1h": timedelta(hours=1), "2h": timedelta(hours=2),
    "4h": timedelta(hours=4), "6h": timedelta(hours=6),
    "12h": timedelta(hours=12), "1d": timedelta(days=1),
}


def _drop_unclosed_bars(df: pd.DataFrame | None, tf: str) -> pd.DataFrame | None:
    """Drop trailing bar(s) whose period has not finished yet.

    Exchange kline endpoints include the in-progress candle. A bar indexed by
    its START time ``t0`` is closed only once ``t0 + duration <= now (UTC)``.
    Index is naive-UTC (epoch-ms), so we compare against naive-UTC now.

    Args:
        df: OHLCV frame indexed by naive-UTC bar-start timestamps, or None.
        tf: Timeframe label (key of :data:`TF_DELTA`).

    Returns:
        The frame with any still-forming trailing bar removed, or the input
        unchanged if empty / the timeframe is unknown.
    """
    if df is None or len(df) == 0:
        return df
    d = TF_DELTA.get(tf)
    if d is None:
        return df
    now = pd.Timestamp(datetime.now(timezone.utc).replace(tzinfo=None))
    closed = (df.index + d) <= now
    return df[closed]


# ─────────────────────────────────────────────────────────────────────────────
# UNIVERSE  — base symbols (e.g. "BTC", "SOL") with light metadata
# ─────────────────────────────────────────────────────────────────────────────

def _bybit_universe() -> list[dict[str, Any]]:
    """Return all linear USDT perps with 24h turnover above the floor."""
    try:
        r = _BYBIT_SESSION.get(
            f"{CFG.bybit_api}/v5/market/tickers",
            params={"category": "linear"},
            timeout=CFG.request_timeout_s,
        )
        if r.status_code != 200:
            log.error(f"Bybit universe HTTP {r.status_code}")
            return []
        data = r.json()
        if data.get("retCode") != 0:
            log.error(f"Bybit universe API error: {data.get('retMsg')}")
            return []
    except Exception as e:
        log.error(f"Bybit universe fetch failed: {e}")
        return []

    # Defensive: a malformed 200 could carry retCode 0 without result.list.
    tickers = data.get("result", {}).get("list") or []
    out: list[dict[str, Any]] = []
    for t in tickers:
        sym = t.get("symbol", "")
        if not sym.endswith("USDT"):
            continue
        base = sym[:-4]
        if base in STABLECOINS_AND_WRAPPED:
            continue
        try:
            turnover = float(t.get("turnover24h") or 0)
            price = float(t.get("lastPrice") or 0)
        except (ValueError, TypeError):
            continue
        if turnover < CFG.bybit_min_volume or price <= 0:
            continue
        out.append({
            "base": base,
            "symbol_bybit": sym,
            "price": price,
            "turnover_24h": turnover,
            "open_interest": float(t.get("openInterest") or 0),
            "oi_value": float(t.get("openInterestValue") or 0),
            "funding_rate": float(t.get("fundingRate") or 0),
            "price_24h_pct": float(t.get("price24hPcnt") or 0) * 100,
            "source": "bybit",
        })
    out.sort(key=lambda x: x["turnover_24h"], reverse=True)
    log.info(f"Bybit universe: {len(out)} perps")
    return out


def _binance_universe() -> list[dict[str, Any]]:
    """Return all Binance USDT spot pairs above the volume floor."""
    try:
        r = _BINANCE_SESSION.get(
            f"{CFG.binance_api}/ticker/24hr",
            timeout=CFG.request_timeout_s,
        )
        r.raise_for_status()
        tickers = r.json()
    except Exception as e:
        log.error(f"Binance universe fetch failed: {e}")
        return []

    out: list[dict[str, Any]] = []
    for t in tickers:
        sym = t.get("symbol", "")
        if not sym.endswith("USDT"):
            continue
        base = sym[:-4]
        if base in STABLECOINS_AND_WRAPPED:
            continue
        try:
            volume = float(t["quoteVolume"])
            price = float(t["lastPrice"])
            change = float(t["priceChangePercent"])
        except (ValueError, KeyError):
            continue
        if volume < CFG.binance_min_volume or price <= 0:
            continue
        if change < -50:  # skip free-falling tokens
            continue
        out.append({
            "base": base,
            "symbol_binance": sym,
            "price": price,
            "volume_24h": volume,
            "price_24h_pct": change,
            "source": "binance",
        })
    out.sort(key=lambda x: x["volume_24h"], reverse=True)
    log.info(f"Binance universe: {len(out)} pairs")
    return out


def get_universe(
    source: Literal["bybit", "binance", "both"] = "both",
) -> list[dict[str, Any]]:
    """Return the merged universe of tradeable base symbols with metadata.

    When ``source='both'``, a coin present on both venues yields one record with
    both ``symbol_bybit`` and ``symbol_binance`` set, plus the union of metadata.

    Args:
        source: Which venue(s) to include.

    Returns:
        A list of per-base dicts sorted by descending 24h volume/turnover.
    """
    if source == "bybit":
        return _bybit_universe()
    if source == "binance":
        return _binance_universe()

    # Merge — keyed by base symbol
    bybit = {c["base"]: c for c in _bybit_universe()}
    binance = {c["base"]: c for c in _binance_universe()}
    bases = set(bybit) | set(binance)

    merged: list[dict[str, Any]] = []
    for base in bases:
        b = bybit.get(base, {})
        bn = binance.get(base, {})
        record = {
            "base": base,
            "symbol_bybit": b.get("symbol_bybit"),
            "symbol_binance": bn.get("symbol_binance"),
            # Prefer Binance price if available (spot is canonical), fall back to Bybit
            "price": bn.get("price") or b.get("price") or 0.0,
            "turnover_24h": b.get("turnover_24h", 0.0),
            "volume_24h": bn.get("volume_24h", 0.0),
            "open_interest": b.get("open_interest", 0.0),
            "oi_value": b.get("oi_value", 0.0),
            "funding_rate": b.get("funding_rate"),
            # Use Bybit 24h pct if present; Binance otherwise
            "price_24h_pct": b.get("price_24h_pct", bn.get("price_24h_pct", 0.0)),
            "on_bybit": bool(b),
            "on_binance": bool(bn),
        }
        merged.append(record)

    merged.sort(
        key=lambda x: max(x.get("turnover_24h", 0.0), x.get("volume_24h", 0.0)),
        reverse=True,
    )
    log.info(f"Merged universe: {len(merged)} bases (Bybit={len(bybit)} Binance={len(binance)})")
    return merged


# ─────────────────────────────────────────────────────────────────────────────
# OHLCV  — per-symbol kline fetch with on-disk CSV cache
# ─────────────────────────────────────────────────────────────────────────────

def _cache_path(base: str, source: str, tf: str) -> Path:
    canonical = json.dumps(
        [base, source, tf], ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    digest = hashlib.sha256(canonical).hexdigest()
    readable = "".join(char for char in base if char.isalnum())[:24] or "data"
    return _CACHE_DIR / f"{readable}_{digest}.csv"


def _read_cache(path: Path, max_age_h: float, min_bars: int) -> pd.DataFrame | None:
    """Return cached frame if it exists, is fresh, and has enough bars."""
    if not path.exists():
        return None
    age_h = (time.time() - path.stat().st_mtime) / 3600
    if age_h > max_age_h:
        return None
    try:
        df = pd.read_csv(path, index_col=0, parse_dates=True)
        if len(df) < min_bars:
            return None
        return df
    except Exception:
        return None


def _write_cache(path: Path, df: pd.DataFrame) -> None:
    try:
        df.to_csv(path)
    except Exception as e:
        log.debug(f"Cache write failed for {path.name}: {e}")


def _bybit_ohlcv(symbol: str, tf: str, bars: int) -> pd.DataFrame | None:
    """Fetch and normalize Bybit klines into a closed-bar OHLCV frame."""
    interval = TF_BYBIT.get(tf)
    if interval is None:
        log.error(f"Unknown tf '{tf}' for Bybit")
        return None
    try:
        r = _BYBIT_SESSION.get(
            f"{CFG.bybit_api}/v5/market/kline",
            params={  # type: ignore[arg-type]  # requests stubs reject valid mixed scalar params.
                "category": "linear",
                "symbol": symbol,
                "interval": interval,
                "limit": min(bars, 1000),
            },
            timeout=CFG.request_timeout_s,
        )
        if r.status_code != 200:
            return None
        rows = r.json().get("result", {}).get("list", [])
        if not rows:
            return None
        rows.reverse()  # Bybit returns newest-first, we want oldest-first
        df = pd.DataFrame(rows, columns=[
            "ts", "open", "high", "low", "close", "volume", "turnover",
        ])
        df["ts"] = pd.to_datetime(df["ts"].astype("int64"), unit="ms")
        df.set_index("ts", inplace=True)
        for col in ("open", "high", "low", "close", "volume", "turnover"):
            df[col] = pd.to_numeric(df[col], errors="coerce")
        normalized = df[["open", "high", "low", "close", "volume"]].dropna()
        closed = _drop_unclosed_bars(normalized, tf)
        return closed if closed is not None and len(closed) >= 30 else None
    except Exception as e:
        log.debug(f"Bybit kline fetch failed {symbol} {tf}: {e}")
        return None


def _binance_ohlcv(symbol: str, tf: str, bars: int) -> pd.DataFrame | None:
    """Fetch and normalize Binance klines into a closed-bar OHLCV frame."""
    interval = TF_BINANCE.get(tf)
    if interval is None:
        log.error(f"Unknown tf '{tf}' for Binance")
        return None
    try:
        r = _BINANCE_SESSION.get(
            f"{CFG.binance_api}/klines",
            params={"symbol": symbol, "interval": interval, "limit": min(bars, 1000)},  # type: ignore[arg-type]
            timeout=CFG.request_timeout_s,
        )
        if r.status_code != 200:
            return None
        rows = r.json()
        if not isinstance(rows, list) or not rows:
            return None
        df = pd.DataFrame(rows, columns=[
            "ts", "open", "high", "low", "close", "base_vol",
            "close_time", "volume", "trades", "taker_base", "taker_quote", "ignore",
        ])
        df["ts"] = pd.to_datetime(df["ts"], unit="ms")
        df.set_index("ts", inplace=True)
        for col in ("open", "high", "low", "close", "volume"):
            df[col] = pd.to_numeric(df[col], errors="coerce")
        normalized = df[["open", "high", "low", "close", "volume"]].dropna()
        closed = _drop_unclosed_bars(normalized, tf)
        return closed if closed is not None and len(closed) >= 30 else None
    except Exception as e:
        log.debug(f"Binance kline fetch failed {symbol} {tf}: {e}")
        return None


def get_ohlcv(
    base: str,
    source: Literal["bybit", "binance"],
    tf: str = "1h",
    bars: int = 200,
    use_cache: bool = True,
) -> pd.DataFrame | None:
    """Fetch OHLCV for ``base`` from ``source`` at timeframe ``tf``.

    The cache is shared across all consumers and lives in ``DATA_CACHE_DIR``.

    Args:
        base: Base asset symbol without the quote (e.g. ``"BTC"``).
        source: Venue to fetch from.
        tf: Timeframe label (key of :data:`TF_BYBIT` / :data:`TF_BINANCE`).
        bars: Number of bars to request (capped at 1000 by the exchange).
        use_cache: Whether to serve a fresh cached frame if available.

    Returns:
        A closed-bar OHLCV DataFrame, or None if the fetch fails or fewer than
        30 bars are available.
    """
    symbol = f"{base}USDT"

    cache = _cache_path(base, source, tf)
    if use_cache:
        cached = _read_cache(cache, CFG.cache_max_age_h, min_bars=30)
        if cached is not None:
            return cached

    df = (_bybit_ohlcv if source == "bybit" else _binance_ohlcv)(symbol, tf, bars)
    if df is not None:
        _write_cache(cache, df)
    return df


# ─────────────────────────────────────────────────────────────────────────────
# BTC REFERENCE DATA  — used for relative-strength-vs-BTC / decoupling signals
# ─────────────────────────────────────────────────────────────────────────────

def get_btc(tf: str = "1h", bars: int = 200) -> pd.DataFrame | None:
    """Return BTC OHLCV from Binance with a longer cache window.

    Acts as the single reference series for market-context signals.

    Args:
        tf: Timeframe label.
        bars: Number of bars to request.

    Returns:
        A closed-bar OHLCV DataFrame, or None on failure.
    """
    cache = _cache_path("BTC", "binance", tf)
    cached = _read_cache(cache, CFG.btc_cache_max_age_h, min_bars=50)
    if cached is not None:
        return cached
    df = _binance_ohlcv("BTCUSDT", tf, bars)
    if df is not None:
        _write_cache(cache, df)
    return df


# ─────────────────────────────────────────────────────────────────────────────
# BYBIT TICKERS / OI / FUNDING  — perp-specific data
# ─────────────────────────────────────────────────────────────────────────────

def get_bybit_tickers() -> list[dict[str, Any]]:
    """Return the raw Bybit ticker list (linear category)."""
    try:
        r = _BYBIT_SESSION.get(
            f"{CFG.bybit_api}/v5/market/tickers",
            params={"category": "linear"},
            timeout=CFG.request_timeout_s,
        )
        if r.status_code != 200:
            return []
        data = r.json()
        if data.get("retCode") != 0:
            return []
        return cast(list[dict[str, Any]], data["result"]["list"])
    except Exception as e:
        log.error(f"Bybit tickers fetch failed: {e}")
        return []


def get_bybit_oi_history(
    symbol: str,
    interval: str = "1h",
    limit: int = 4,
) -> list[dict[str, Any]]:
    """Return Bybit open-interest history, NEWEST FIRST.

    Args:
        symbol: Full perp symbol (e.g. ``"BTCUSDT"``).
        interval: Bybit OI interval (e.g. ``"1h"``).
        limit: Number of snapshots; ``limit=4`` gives 4h of hourly OI evolution.

    Returns:
        A list of ``{timestamp, openInterest}`` dicts, newest first.
    """
    try:
        r = _BYBIT_SESSION.get(
            f"{CFG.bybit_api}/v5/market/open-interest",
            params={  # type: ignore[arg-type]  # requests stubs reject valid mixed scalar params.
                "category": "linear",
                "symbol": symbol,
                "intervalTime": interval,
                "limit": limit,
            },
            timeout=CFG.request_timeout_s,
        )
        if r.status_code != 200:
            return []
        data = r.json()
        if data.get("retCode") != 0:
            return []
        return cast(list[dict[str, Any]], data["result"]["list"])
    except Exception:
        return []


# ─────────────────────────────────────────────────────────────────────────────
# BINANCE FUNDING  — supplementary for coins not on Bybit perps
# ─────────────────────────────────────────────────────────────────────────────

def get_funding_rates_binance() -> dict[str, float]:
    """Return current Binance perp funding rates keyed by base symbol.

    Returns:
        A mapping ``base -> lastFundingRate``; empty on failure.
    """
    try:
        r = _BINANCE_SESSION.get(
            f"{CFG.binance_fapi}/premiumIndex",
            timeout=CFG.request_timeout_s,
        )
        if r.status_code != 200:
            return {}
        out: dict[str, float] = {}
        for d in r.json():
            if not isinstance(d, dict):
                continue
            sym = d.get("symbol", "")
            if not sym.endswith("USDT"):
                continue
            base = sym[:-4]
            try:
                out[base] = float(d.get("lastFundingRate", 0))
            except (ValueError, TypeError):
                continue
        return out
    except Exception as e:
        log.warning(f"Binance funding fetch failed: {e}")
        return {}


# ─────────────────────────────────────────────────────────────────────────────
# CACHE MAINTENANCE
# ─────────────────────────────────────────────────────────────────────────────

def clear_cache(older_than_hours: float | None = None) -> int:
    """Delete cache files.

    Args:
        older_than_hours: If given, only delete files older than this many
            hours. ``None`` deletes every cache file.

    Returns:
        The number of files deleted.
    """
    deleted = 0
    now = time.time()
    for p in _CACHE_DIR.glob("*.csv"):
        if older_than_hours is None:
            p.unlink(missing_ok=True)
            deleted += 1
        else:
            age_h = (now - p.stat().st_mtime) / 3600
            if age_h > older_than_hours:
                p.unlink(missing_ok=True)
                deleted += 1
    log.info(f"Cleared {deleted} cache file(s)")
    return deleted


# ─────────────────────────────────────────────────────────────────────────────
# SELF-TEST  — runnable as a script for a live sanity check
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Force UTF-8 stdout (cross-platform friendly).
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        try:
            cast(Any, sys.stdout).reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    # Echo logger to stdout for the self-test.
    log.addHandler(logging.StreamHandler(sys.stdout))

    print("=" * 60)
    print("UNIFIED DATA LAYER SELF-TEST")
    print("=" * 60)

    print("\n[1] Universe (both venues):")
    uni = get_universe("both")
    print(f"    {len(uni)} bases. Top 5 by volume:")
    for c in uni[:5]:
        venues = []
        if c["on_bybit"]:
            venues.append("Bybit")
        if c["on_binance"]:
            venues.append("Binance")
        print(f"      {c['base']:<8} ${c['price']:>10,.4f}  ({', '.join(venues)})")

    print("\n[2] BTC 1h:")
    btc = get_btc("1h", 200)
    if btc is not None:
        print(f"    {len(btc)} bars, last close ${float(btc['close'].iloc[-1]):,.0f}")
    else:
        print("    FAILED")

    print("\n[3] OHLCV fetch (BTC 4h, Bybit):")
    df = get_ohlcv("BTC", "bybit", "4h", 200)
    print(f"    {len(df) if df is not None else 0} bars")

    print("\n[4] Funding rates (Binance):")
    fr = get_funding_rates_binance()
    print(f"    {len(fr)} symbols. BTC funding: {fr.get('BTC', 'N/A')}")

    print("\n[5] OI history (BTC, Bybit):")
    oi = get_bybit_oi_history("BTCUSDT", "1h", 4)
    print(f"    {len(oi)} snapshots")
    if oi:
        print(f"    Latest OI: {oi[0].get('openInterest', 'N/A')}")

    print("\nDONE")
