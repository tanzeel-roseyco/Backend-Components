"""
================================================================================
SIGNAL LIBRARY  —  pure-function technical-analysis signals
================================================================================
Purpose
-------
A single canonical library of pure-function market signals. Every signal takes
market data (an OHLCV ``pandas.DataFrame`` or, for a few, plain scalars) and
returns a standardized :class:`SignalResult` bundling:

    fired    : bool  — does the signal fire right now?
    strength : float in [0, 1] — how strongly (0 = barely, 1 = textbook)
    value    : Optional[float] — the underlying numeric measure (diagnostics)
    extras   : dict — any extra data a caller may want for reporting

Signals are pure: no caching, no I/O, no side effects, and they never raise —
they return ``SignalResult.empty()`` on insufficient / malformed data. This
makes them safe to compose into higher-level conviction scores by a caller.

Conventions
-----------
  - Every signal is ``def sig_<name>(df, **params) -> SignalResult``.
  - Defaults assume 1h bars unless a docstring says otherwise; pass explicit
    window params to scale a signal to a different timeframe.

Required environment variables
------------------------------
  None. This module is pure computation — it reads no config, opens no
  connections, and holds no secrets. All tunables are explicit function
  parameters with sensible defaults.

Key dependencies
----------------
  - numpy, pandas (numeric / dataframe primitives)
  - The indicator functions in the "REFERENCE INDICATORS" section below. These
    are self-contained standard implementations so the module runs as-is; a
    caller may substitute a faster / vendored implementation as long as it
    matches the documented signatures (see ``IndicatorSuite`` docstrings).

AIDEV-NOTE: Adapted and generalized from a production trading codebase. Role:
this is the *single source of truth* for signal definitions — higher-level
scanners must call these, never re-implement a signal, so a signal's meaning
stays identical across every strategy. Ordering constraint: signals read the
LAST row of ``df`` as "now"; callers must pass chronologically-ascending,
already-closed bars (no in-progress candle) or `fired` will be look-ahead
biased. Security: pure functions, no external input beyond the passed frame —
validate/sanitize market data at the fetch boundary, not here.
================================================================================
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd

# AIDEV-NOTE: Original source imported these from an internal `indicators`
# module. For a self-contained public component, standard reference
# implementations are inlined in the "REFERENCE INDICATORS" section below.
# To swap in your own optimized versions, delete that section and restore:
#   from indicators import (
#       compute_rsi, compute_atr, compute_macd, compute_adx,
#       compute_obv, compute_cmf, compute_bb, compute_keltner,
#       compute_supertrend, compute_ema, compute_slope, find_pivots,
#   )


# ─────────────────────────────────────────────────────────────────────────────
# RESULT TYPE
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class SignalResult:
    """
    Standard result for every signal.

    Attributes:
        fired: Does the signal fire on the most recent bar?
        strength: Confidence in ``[0, 1]`` (0 = barely, 1 = textbook). Use this
            for weighting rather than the raw boolean.
        value: The underlying numeric measure (e.g. RSI value, BB width %,
            OI change %). ``None`` when undefined. For diagnostics.
        extras: Free-form dict of extra data a caller may surface in reports.
    """
    fired:    bool                = False
    strength: float               = 0.0
    value:    Optional[float]     = None
    extras:   dict                = field(default_factory=dict)

    @classmethod
    def empty(cls) -> "SignalResult":
        """Neutral 'did not fire / not enough data' result."""
        return cls(fired=False, strength=0.0, value=None)


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _safe_float(x: object) -> float:
    """Convert anything to float, returning nan on failure."""
    try:
        return float(x)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return float("nan")


def _enough_bars(df: Optional[pd.DataFrame], n: int) -> bool:
    """True when ``df`` exists and has at least ``n`` rows."""
    return df is not None and len(df) >= n


# ═════════════════════════════════════════════════════════════════════════════
# REFERENCE INDICATORS
# ═════════════════════════════════════════════════════════════════════════════
# AIDEV-NOTE: Standard, dependency-light implementations of the indicators the
# signals rely on. They intentionally use Wilder-style smoothing (ewm alpha=1/n)
# for RSI/ATR/ADX to match common TA conventions. Callers may replace these
# wholesale — every signal only depends on the documented return shapes below.

def compute_ema(series: pd.Series, period: int) -> pd.Series:
    """Exponential moving average with ``span=period``."""
    return series.astype(float).ewm(span=period, adjust=False).mean()


def compute_slope(series: pd.Series, window: int) -> float:
    """
    Least-squares slope of the last ``window`` non-null points.

    Returns nan when fewer than ``window`` finite points are available.
    """
    y = series.dropna().to_numpy(dtype=float)
    if len(y) < window:
        return float("nan")
    y = y[-window:]
    x = np.arange(window, dtype=float)
    # polyfit degree 1: [slope, intercept]
    slope, _ = np.polyfit(x, y, 1)
    return float(slope)


def _true_range(df: pd.DataFrame) -> pd.Series:
    """True range per bar: max(H-L, |H-prevC|, |L-prevC|)."""
    high = df["high"].astype(float)
    low = df["low"].astype(float)
    prev_close = df["close"].astype(float).shift(1)
    ranges = pd.concat(
        [high - low, (high - prev_close).abs(), (low - prev_close).abs()],
        axis=1,
    )
    return ranges.max(axis=1)


def compute_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Average True Range (Wilder smoothing)."""
    tr = _true_range(df)
    return tr.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()


def compute_rsi(closes: pd.Series, period: int = 14) -> pd.Series:
    """Relative Strength Index (Wilder smoothing), range 0..100."""
    delta = closes.astype(float).diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = gain.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()
    # Avoid divide-by-zero: where avg_loss==0 RSI is 100 (all-gain window).
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100.0 - (100.0 / (1.0 + rs))
    rsi = rsi.where(avg_loss != 0, 100.0)
    return rsi


def compute_macd(
    closes: pd.Series,
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Classic MACD. Returns (macd_line, signal_line, histogram)."""
    ema_fast = compute_ema(closes, fast)
    ema_slow = compute_ema(closes, slow)
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    hist = macd_line - signal_line
    return macd_line, signal_line, hist


def compute_adx(
    df: pd.DataFrame,
    period: int = 14,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """
    Average Directional Index. Returns (adx, plus_di, minus_di).

    Uses Wilder smoothing throughout.
    """
    high = df["high"].astype(float)
    low = df["low"].astype(float)

    up_move = high.diff()
    down_move = -low.diff()
    plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)
    plus_dm = pd.Series(plus_dm, index=df.index)
    minus_dm = pd.Series(minus_dm, index=df.index)

    atr = compute_atr(df, period).replace(0, np.nan)
    alpha = 1.0 / period
    plus_di = 100.0 * (plus_dm.ewm(alpha=alpha, min_periods=period, adjust=False).mean() / atr)
    minus_di = 100.0 * (minus_dm.ewm(alpha=alpha, min_periods=period, adjust=False).mean() / atr)

    di_sum = (plus_di + minus_di).replace(0, np.nan)
    dx = 100.0 * (plus_di - minus_di).abs() / di_sum
    adx = dx.ewm(alpha=alpha, min_periods=period, adjust=False).mean()
    return adx, plus_di, minus_di


def compute_obv(df: pd.DataFrame) -> pd.Series:
    """On-Balance Volume cumulative series."""
    close = df["close"].astype(float)
    volume = df["volume"].astype(float)
    direction = np.sign(close.diff().fillna(0.0))
    return (direction * volume).fillna(0.0).cumsum()


def compute_cmf(df: pd.DataFrame, period: int = 20) -> pd.Series:
    """Chaikin Money Flow over ``period`` bars, range -1..1."""
    high = df["high"].astype(float)
    low = df["low"].astype(float)
    close = df["close"].astype(float)
    volume = df["volume"].astype(float)

    rng = (high - low).replace(0, np.nan)
    # Money Flow Multiplier; 0 when the bar has no range (avoids inf).
    mfm = (((close - low) - (high - close)) / rng).fillna(0.0)
    mfv = mfm * volume
    vol_sum = volume.rolling(period).sum().replace(0, np.nan)
    return mfv.rolling(period).sum() / vol_sum


def compute_bb(
    closes: pd.Series,
    period: int = 20,
    std: float = 2.0,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Bollinger Bands. Returns (upper, mid, lower)."""
    closes = closes.astype(float)
    mid = closes.rolling(period).mean()
    # population-consistent with common TA libs is ddof=0; use sample std (ddof=1
    # is pandas default) here to match the source's expectations.
    sd = closes.rolling(period).std()
    upper = mid + std * sd
    lower = mid - std * sd
    return upper, mid, lower


def compute_keltner(
    df: pd.DataFrame,
    period: int = 20,
    atr_period: int = 10,
    mult: float = 1.5,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Keltner Channels (EMA mid + ATR bands). Returns (upper, mid, lower)."""
    mid = compute_ema(df["close"], period)
    atr = compute_atr(df, atr_period)
    upper = mid + mult * atr
    lower = mid - mult * atr
    return upper, mid, lower


def compute_supertrend(
    df: pd.DataFrame,
    period: int = 10,
    multiplier: float = 3.0,
) -> pd.Series:
    """
    SuperTrend direction as a boolean series (True = bullish / price above the
    trailing line). Standard trailing-band construction.
    """
    atr = compute_atr(df, period)
    hl2 = (df["high"].astype(float) + df["low"].astype(float)) / 2.0
    upper = (hl2 + multiplier * atr).to_numpy(dtype=float)
    lower = (hl2 - multiplier * atr).to_numpy(dtype=float)
    close = df["close"].astype(float).to_numpy(dtype=float)

    n = len(df)
    final_upper = np.full(n, np.nan)
    final_lower = np.full(n, np.nan)
    trend = np.ones(n, dtype=bool)  # default bullish until proven otherwise

    for i in range(1, n):
        # Trailing upper band only ratchets down while price stays below it.
        if np.isnan(upper[i]) or np.isnan(final_upper[i - 1]):
            final_upper[i] = upper[i]
        elif upper[i] < final_upper[i - 1] or close[i - 1] > final_upper[i - 1]:
            final_upper[i] = upper[i]
        else:
            final_upper[i] = final_upper[i - 1]

        # Trailing lower band only ratchets up while price stays above it.
        if np.isnan(lower[i]) or np.isnan(final_lower[i - 1]):
            final_lower[i] = lower[i]
        elif lower[i] > final_lower[i - 1] or close[i - 1] < final_lower[i - 1]:
            final_lower[i] = lower[i]
        else:
            final_lower[i] = final_lower[i - 1]

        if close[i] > final_upper[i - 1]:
            trend[i] = True
        elif close[i] < final_lower[i - 1]:
            trend[i] = False
        else:
            trend[i] = trend[i - 1]

    return pd.Series(trend, index=df.index)


def find_pivots(
    series: pd.Series,
    left: int = 3,
    right: int = 3,
) -> tuple[list[int], list[int]]:
    """
    Fractal swing pivots. Returns (high_pivot_positions, low_pivot_positions)
    as *positional* integer indices into ``series`` (usable with ``.iloc``).

    A bar at position ``i`` is a pivot high when its value is the strict maximum
    of the window ``[i-left, i+right]`` (and symmetrically for pivot lows). The
    ``right`` bars to the right are required, so the most recent ``right`` bars
    can never be pivots — this is what makes a pivot "confirmed".
    """
    vals = series.to_numpy(dtype=float)
    n = len(vals)
    highs: list[int] = []
    lows: list[int] = []
    for i in range(left, n - right):
        window = vals[i - left : i + right + 1]
        if np.isnan(window).any():
            continue
        center = vals[i]
        # Strict extremum vs. neighbors so flat plateaus don't spam pivots.
        if center == window.max() and center > vals[i - 1] and center > vals[i + 1]:
            highs.append(i)
        if center == window.min() and center < vals[i - 1] and center < vals[i + 1]:
            lows.append(i)
    return highs, lows


# ═════════════════════════════════════════════════════════════════════════════
# CONTESTED SIGNAL #1 — BB SQUEEZE (TTM canonical)
# ═════════════════════════════════════════════════════════════════════════════

def sig_bb_squeeze(
    df:          pd.DataFrame,
    bb_period:   int   = 20,
    bb_std:      float = 2.0,
    kc_period:   int   = 20,
    kc_atr:      int   = 10,
    kc_mult:     float = 1.5,
    width_lookback: int = 120,
    width_pct:    float = 20.0,   # bottom 20th percentile (TTM with KC)
    deep_pct:     float = 5.0,    # bottom 5th percentile (sufficient alone)
) -> SignalResult:
    """
    Compression signal — fires under either of two conditions:

      (A) TTM Squeeze:  BB bands inside Keltner bands AND BB width
                        in the bottom `width_pct` of recent history.
      (B) Deep compression alone: BB width in the bottom `deep_pct` of
                                  recent history, regardless of KC.

    Why both: pure TTM is mathematically clean but too strict on volatile
    crypto 1h data — coins genuinely coiled at the 1st-5th percentile of
    their recent BB-width history are filtered out because BB happens to
    poke just above/below KC. Adding the deep-compression alternative
    catches these. The two conditions are NOT additive (no double-count)
    — fired = A OR B.

    fired    : True if either condition holds.
    strength : 0..1, scaled by how deep into the compression we are.
    value    : current BB width as fraction of mid.
    extras   : trigger='ttm' or 'deep' shows which condition fired.
    """
    if not _enough_bars(df, max(bb_period, kc_period, width_lookback) + 5):
        return SignalResult.empty()

    closes = df["close"]
    bb_u, bb_m, bb_l = compute_bb(closes, bb_period, bb_std)
    kc_u, _, kc_l    = compute_keltner(df, kc_period, kc_atr, kc_mult)

    if bb_m.iloc[-1] == 0 or pd.isna(bb_m.iloc[-1]):
        return SignalResult.empty()

    bb_width = (bb_u - bb_l) / bb_m.replace(0, np.nan)
    cur_w    = _safe_float(bb_width.iloc[-1])
    if np.isnan(cur_w):
        return SignalResult.empty()

    # BB inside KC?
    inside_kc = (
        bb_u.iloc[-1] <= kc_u.iloc[-1]
        and bb_l.iloc[-1] >= kc_l.iloc[-1]
    )

    # Width thresholds
    recent_widths = bb_width.dropna().iloc[-width_lookback:]
    if len(recent_widths) < 20:
        return SignalResult.empty()
    threshold_ttm  = float(np.percentile(recent_widths.values, width_pct))
    threshold_deep = float(np.percentile(recent_widths.values, deep_pct))

    # Two trigger paths
    ttm_fire  = inside_kc and (cur_w <= threshold_ttm)
    deep_fire = cur_w <= threshold_deep
    fired     = bool(ttm_fire or deep_fire)

    # How deep is the current width vs all of the lookback window?
    rank_pct = float(
        (recent_widths < cur_w).sum() / len(recent_widths) * 100
    )

    # Strength: linear in [0..width_pct] for TTM, more aggressive for deep
    if fired:
        if deep_fire and not ttm_fire:
            # Pure deep compression — strength scales with how deep
            strength = max(0.5, (deep_pct - rank_pct) / deep_pct)
            trigger  = "deep"
        elif ttm_fire and deep_fire:
            # Both — full strength
            strength = max(0.7, (width_pct - rank_pct) / width_pct)
            trigger  = "ttm+deep"
        else:
            # TTM only
            strength = max(0.0, (width_pct - rank_pct) / width_pct)
            trigger  = "ttm"
    else:
        strength = 0.0
        trigger  = None

    return SignalResult(
        fired    = fired,
        strength = float(min(strength, 1.0)),
        value    = cur_w,
        extras   = {
            "bb_width_pct":         round(cur_w * 100, 3),
            "ttm_threshold_pct":    round(threshold_ttm  * 100, 3),
            "deep_threshold_pct":   round(threshold_deep * 100, 3),
            "rank_pct":             round(rank_pct, 1),
            "inside_kc":            inside_kc,
            "trigger":              trigger,
        },
    )


# ═════════════════════════════════════════════════════════════════════════════
# CONTESTED SIGNAL #2 — RSI DIVERGENCE (pivot-based, RSI(7))
# ═════════════════════════════════════════════════════════════════════════════

def sig_rsi_divergence(
    df:        pd.DataFrame,
    rsi_period: int = 7,
    pivot_left:  int = 3,
    pivot_right: int = 3,
    lookback:    int = 60,
    min_price_drop: float = 0.005,   # second low must be 0.5% below first
    min_rsi_gap:    float = 3.0,     # RSI at 2nd low must be 3pts higher
) -> SignalResult:
    """
    Bullish RSI divergence detected via swing-low pivots.
    Fires when: most recent two confirmed pivot LOWS in price both have
    corresponding RSI pivot lows where price2 < price1 (lower low) but
    rsi2 > rsi1 + min_rsi_gap (higher low). Canonical bullish divergence.

    Also detects HIDDEN bullish (price higher low + RSI lower low) — flagged
    in extras as 'kind'='hidden_bullish' (rare but legitimate signal).

    Uses RSI(7) by default per the source spec.
    """
    min_required = max(rsi_period, lookback) + pivot_right + 5
    if not _enough_bars(df, min_required):
        return SignalResult.empty()

    closes = df["close"]
    rsi    = compute_rsi(closes, rsi_period)

    # Limit search window to the recent `lookback` bars
    window_closes = closes.iloc[-lookback:]
    window_rsi    = rsi.iloc[-lookback:]

    # Find swing-low pivots in price within the window
    _, price_low_idx = find_pivots(window_closes, pivot_left, pivot_right)
    if len(price_low_idx) < 2:
        return SignalResult.empty()

    # Take the two most recent confirmed pivot lows
    i1, i2 = price_low_idx[-2], price_low_idx[-1]
    p1 = float(window_closes.iloc[i1])
    p2 = float(window_closes.iloc[i2])
    r1 = _safe_float(window_rsi.iloc[i1])
    r2 = _safe_float(window_rsi.iloc[i2])

    if any(np.isnan([p1, p2, r1, r2])) or p1 == 0:
        return SignalResult.empty()

    price_change_pct = (p2 - p1) / p1
    rsi_gap          = r2 - r1

    # Classic bullish divergence: lower low in price, higher low in RSI
    is_bullish = (price_change_pct <= -min_price_drop) and (rsi_gap >= min_rsi_gap)
    # Hidden bullish: higher low in price, lower low in RSI (continuation)
    is_hidden  = (price_change_pct >= +min_price_drop) and (rsi_gap <= -min_rsi_gap)

    fired = bool(is_bullish or is_hidden)
    if not fired:
        return SignalResult(
            fired = False, strength = 0.0, value = rsi_gap,
            extras = {"kind": None, "price_change_pct": round(price_change_pct * 100, 2)},
        )

    # Strength: how big is the gap in standard divergence units?
    # Normalize: rsi_gap of 5pts + price drop of 2% ≈ strength 0.5
    if is_bullish:
        gap_score   = min(rsi_gap / 10.0, 1.0)         # 10pt RSI gap caps at 1.0
        price_score = min(abs(price_change_pct) / 0.05, 1.0)  # 5% drop caps at 1.0
        strength    = (gap_score + price_score) / 2.0
        kind        = "bullish"
    else:
        gap_score   = min(abs(rsi_gap) / 10.0, 1.0)
        price_score = min(price_change_pct / 0.05, 1.0)
        strength    = (gap_score + price_score) / 2.0
        kind        = "hidden_bullish"

    return SignalResult(
        fired    = True,
        strength = float(strength),
        value    = rsi_gap,
        extras   = {
            "kind":             kind,
            "price_change_pct": round(price_change_pct * 100, 2),
            "rsi_gap":          round(rsi_gap, 2),
            "rsi1":             round(r1, 1),
            "rsi2":             round(r2, 1),
        },
    )


# ═════════════════════════════════════════════════════════════════════════════
# CONTESTED SIGNAL #3 — OBV (split into 3 distinct signals)
# ═════════════════════════════════════════════════════════════════════════════

def sig_obv_slope(
    df:    pd.DataFrame,
    bars:  int = 12,
    min_slope_norm: float = 0.0,
) -> SignalResult:
    """
    OBV trend: linear regression slope over `bars` bars is positive.
    Normalizes slope by mean OBV magnitude so the threshold is comparable
    across coins.

    fired    : slope/|mean OBV| > min_slope_norm AND OBV[-1] > OBV[-bars].
    strength : magnitude of normalized slope, capped at 1.0.
    """
    if not _enough_bars(df, bars + 5) or "volume" not in df.columns:
        return SignalResult.empty()

    obv = compute_obv(df)
    slope = compute_slope(obv, bars)
    if np.isnan(slope):
        return SignalResult.empty()

    obv_window = obv.iloc[-bars:].dropna()
    if len(obv_window) < bars:
        return SignalResult.empty()

    # Normalize slope by typical OBV magnitude in the window
    mean_abs = float(obv_window.abs().mean())
    if mean_abs == 0:
        return SignalResult.empty()

    norm_slope = slope / mean_abs
    direction_ok = float(obv.iloc[-1]) > float(obv.iloc[-bars])
    fired = norm_slope > min_slope_norm and direction_ok

    return SignalResult(
        fired    = bool(fired),
        strength = float(min(abs(norm_slope) * 10, 1.0)) if fired else 0.0,
        value    = float(norm_slope),
        extras   = {"slope": float(slope), "obv_now": float(obv.iloc[-1])},
    )


def sig_obv_stealth_accum(
    df:           pd.DataFrame,
    obv_lookback: int   = 12,
    min_obv_pct:  float = 0.015,   # OBV must rise ≥ 1.5%
    max_price_move: float = 0.03,  # while price stays within ±3%
) -> SignalResult:
    """
    Stealth accumulation: OBV rises significantly while price is flat.
    Indicates buying pressure not yet reflected in price.
    """
    if not _enough_bars(df, obv_lookback + 5) or "volume" not in df.columns:
        return SignalResult.empty()

    obv    = compute_obv(df)
    closes = df["close"]

    p_now    = float(closes.iloc[-1])
    p_prior  = float(closes.iloc[-obv_lookback])
    o_now    = float(obv.iloc[-1])
    o_prior  = float(obv.iloc[-obv_lookback])

    if any(np.isnan([p_now, p_prior, o_now, o_prior])) or o_prior == 0 or p_prior == 0:
        return SignalResult.empty()

    obv_pct   = (o_now - o_prior) / abs(o_prior)
    price_pct = (p_now - p_prior) / p_prior

    is_flat       = abs(price_pct) <= max_price_move
    obv_advancing = obv_pct >= min_obv_pct
    fired         = bool(is_flat and obv_advancing)

    strength = 0.0
    if fired:
        # Stronger when OBV is rising more AND price is more pinned
        obv_score   = min(obv_pct / (min_obv_pct * 4), 1.0)
        flat_score  = 1.0 - min(abs(price_pct) / max_price_move, 1.0)
        strength    = (obv_score + flat_score) / 2.0

    return SignalResult(
        fired    = fired,
        strength = float(strength),
        value    = float(obv_pct),
        extras   = {
            "obv_pct":   round(obv_pct * 100, 2),
            "price_pct": round(price_pct * 100, 2),
        },
    )


def sig_obv_divergence(
    df:           pd.DataFrame,
    pivot_left:   int = 3,
    pivot_right:  int = 3,
    lookback:     int = 40,
) -> SignalResult:
    """
    Bullish OBV divergence: price makes lower low, OBV makes higher low.
    Pivot-based for proper swing-low detection.
    """
    if not _enough_bars(df, lookback + pivot_right + 5) or "volume" not in df.columns:
        return SignalResult.empty()

    obv    = compute_obv(df)
    closes = df["close"]

    win_close = closes.iloc[-lookback:]
    win_obv   = obv.iloc[-lookback:]

    _, price_lows = find_pivots(win_close, pivot_left, pivot_right)
    _, obv_lows   = find_pivots(win_obv,   pivot_left, pivot_right)
    if len(price_lows) < 2 or len(obv_lows) < 2:
        return SignalResult.empty()

    p1, p2 = float(win_close.iloc[price_lows[-2]]), float(win_close.iloc[price_lows[-1]])
    o1, o2 = float(win_obv.iloc[obv_lows[-2]]),     float(win_obv.iloc[obv_lows[-1]])

    if p1 == 0:
        return SignalResult.empty()

    price_lower = p2 < p1 * 0.995          # ≥ 0.5% lower low
    obv_higher  = o2 > o1                   # any higher low
    fired       = bool(price_lower and obv_higher)

    strength = 0.0
    if fired:
        price_drop = (p1 - p2) / p1
        obv_gap    = (o2 - o1) / max(abs(o1), 1.0)
        strength   = min((price_drop * 10 + obv_gap) / 2.0, 1.0)
        strength   = max(strength, 0.0)

    return SignalResult(
        fired    = fired,
        strength = float(strength),
        value    = float((o2 - o1) / max(abs(o1), 1.0)) if o1 != 0 else 0.0,
        extras   = {
            "price_drop_pct": round((p1 - p2) / p1 * 100, 2) if p1 else 0.0,
        },
    )


# ═════════════════════════════════════════════════════════════════════════════
# CONTESTED SIGNAL #4 — VOLUME (split into 2 distinct signals)
# ═════════════════════════════════════════════════════════════════════════════

def sig_vol_expansion(
    df:        pd.DataFrame,
    recent:    int   = 6,
    base_start: int  = 7,
    base_end:   int  = 42,
    mult:       float = 1.5,
) -> SignalResult:
    """
    Volume expansion: recent N bars vs baseline window has strong elevation.
    "Fresh capital arriving" — fires when ratio >= mult.

    Default windows are 1h-bar centric: 6 recent (~6h) vs 7-42 bars back (~36h baseline).
    """
    if not _enough_bars(df, base_end + recent) or "volume" not in df.columns:
        return SignalResult.empty()

    vols = df["volume"].dropna()
    if len(vols) < base_end + recent:
        return SignalResult.empty()

    recent_avg = float(vols.iloc[-recent:].mean())
    base_slice = vols.iloc[-base_end:-base_start] if base_start > 0 else vols.iloc[-base_end:]
    base_avg   = float(base_slice.mean())
    if base_avg <= 0:
        return SignalResult.empty()

    ratio = recent_avg / base_avg
    fired = ratio >= mult
    return SignalResult(
        fired    = bool(fired),
        # Strength: 1.5x = 0.0, 4.5x = 1.0
        strength = float(min(max((ratio - mult) / (3.0), 0.0), 1.0)) if fired else 0.0,
        value    = float(ratio),
        extras   = {"recent_avg": recent_avg, "base_avg": base_avg},
    )


def sig_vol_in_window(
    df:        pd.DataFrame,
    recent:    int   = 6,
    base_back: int   = 30,
    low_mult:  float = 1.2,
    high_mult: float = 4.5,
) -> SignalResult:
    """
    Volume "building but not yet pumping": recent vol/baseline in [low_mult, high_mult].
    Distinct from vol_expansion — this one EXCLUDES already-pumping coins.
    Useful for prepump-style detection where you want to catch it before it's loud.
    """
    if not _enough_bars(df, base_back + recent) or "volume" not in df.columns:
        return SignalResult.empty()

    vols = df["volume"].dropna()
    if len(vols) < base_back + recent:
        return SignalResult.empty()

    recent_avg = float(vols.iloc[-recent:].mean())
    base_avg   = float(vols.iloc[-(base_back + recent):-recent].mean())
    if base_avg <= 0:
        return SignalResult.empty()

    ratio = recent_avg / base_avg
    fired = low_mult <= ratio <= high_mult

    # Strength peaks in middle of window
    strength = 0.0
    if fired:
        mid = (low_mult + high_mult) / 2.0
        # 1.0 at exactly mid, falling linearly to 0 at edges
        dist = abs(ratio - mid) / ((high_mult - low_mult) / 2.0)
        strength = max(0.0, 1.0 - dist)

    return SignalResult(
        fired    = bool(fired),
        strength = float(strength),
        value    = float(ratio),
    )


# ═════════════════════════════════════════════════════════════════════════════
# CONTESTED SIGNAL #5 — WHALE CANDLE (ATR-normalized, lookback param)
# ═════════════════════════════════════════════════════════════════════════════

def sig_whale_candle(
    df:        pd.DataFrame,
    lookback:  int   = 6,
    atr_mult:  float = 1.8,
    atr_period: int  = 14,
    close_upper_pct: float = 0.30,
) -> SignalResult:
    """
    Bullish whale candle in the last `lookback` bars.
    Definition: body >= ATR(14) * atr_mult, AND close in upper N% of range,
                AND bullish (close > open).

    Single canonical version — replaces divergent definitions across scanners.
    """
    if not _enough_bars(df, atr_period + lookback + 2):
        return SignalResult.empty()

    atr = compute_atr(df, atr_period)
    atr_now = _safe_float(atr.iloc[-1])
    if np.isnan(atr_now) or atr_now <= 0:
        return SignalResult.empty()

    recent = df.iloc[-lookback:]
    best_strength = 0.0
    fired = False
    bars_ago = -1

    for i, (_, bar) in enumerate(recent.iloc[::-1].iterrows()):  # newest first
        o, h, l, c = float(bar["open"]), float(bar["high"]), float(bar["low"]), float(bar["close"])
        body = c - o
        rng  = h - l
        if rng <= 0 or body <= 0:
            continue
        # Close in upper portion of range?
        close_pos = (c - l) / rng    # 0 = at low, 1 = at high
        if close_pos < (1.0 - close_upper_pct):
            continue
        body_atr_mult = body / atr_now
        if body_atr_mult < atr_mult:
            continue
        # Strength: bigger body relative to ATR mult, more recent
        strength = min((body_atr_mult / atr_mult - 1.0) + 0.5, 1.0)
        recency_factor = 1.0 - (i / (lookback * 1.5))   # newer = stronger
        strength *= recency_factor
        if strength > best_strength:
            best_strength = strength
            bars_ago = i
            fired = True

    return SignalResult(
        fired    = fired,
        strength = float(best_strength),
        value    = atr_now,
        extras   = {"bars_ago": bars_ago} if fired else {},
    )


# ═════════════════════════════════════════════════════════════════════════════
# CONTESTED SIGNAL #6 — RSI (split into reset and in_zone)
# ═════════════════════════════════════════════════════════════════════════════

def sig_rsi_reset(
    df:           pd.DataFrame,
    rsi_period:   int   = 7,
    low_thresh:   float = 42.0,
    lookback:     int   = 24,
) -> SignalResult:
    """
    RSI reset: RSI was <= low_thresh within the last `lookback` bars,
    AND RSI is currently rising (last bar > previous bar).
    Catches the bottoming/reversal process.

    Uses RSI(7) by default per the source spec.
    """
    if not _enough_bars(df, max(rsi_period, lookback) + 5):
        return SignalResult.empty()

    rsi = compute_rsi(df["close"], rsi_period).dropna()
    if len(rsi) < lookback + 2:
        return SignalResult.empty()

    window = rsi.iloc[-lookback:]
    cur    = float(rsi.iloc[-1])
    prev   = float(rsi.iloc[-2])
    had_low  = bool((window <= low_thresh).any())
    rising   = cur > prev
    fired    = had_low and rising

    strength = 0.0
    if fired:
        # Stronger when current RSI is further off the bottom and rising harder
        depth   = (low_thresh - float(window.min())) / low_thresh   # how oversold did it get
        bounce  = (cur - float(window.min())) / max(low_thresh, 1)  # how much off the bottom
        rise    = (cur - prev) / 100.0                              # current bar rise
        strength = float(min(max(depth + bounce + rise * 5, 0.0), 1.0))

    return SignalResult(
        fired    = fired,
        strength = strength,
        value    = cur,
        extras   = {
            "min_in_window": round(float(window.min()), 1),
            "rsi_now":       round(cur, 1),
        },
    )


def sig_rsi_in_zone(
    df:         pd.DataFrame,
    rsi_period: int   = 7,
    low:        float = 25.0,
    high:       float = 62.0,
) -> SignalResult:
    """
    RSI currently in the healthy zone [low, high].
    Acts as a filter — keeps both oversold extremes AND overbought froth out.
    Pure boolean; strength = how well-centered in the zone (peaks at midpoint).
    """
    if not _enough_bars(df, rsi_period + 5):
        return SignalResult.empty()
    rsi_val = _safe_float(compute_rsi(df["close"], rsi_period).iloc[-1])
    if np.isnan(rsi_val):
        return SignalResult.empty()
    fired = low <= rsi_val <= high

    strength = 0.0
    if fired:
        mid    = (low + high) / 2.0
        half   = (high - low) / 2.0
        strength = float(max(0.0, 1.0 - abs(rsi_val - mid) / half))

    return SignalResult(
        fired    = bool(fired),
        strength = strength,
        value    = rsi_val,
    )


# ═════════════════════════════════════════════════════════════════════════════
# UNCONTESTED TREND SIGNALS — single source of truth for trend strategies
# ═════════════════════════════════════════════════════════════════════════════

def sig_macd_crossover(df: pd.DataFrame) -> SignalResult:
    """MACD histogram just crossed above zero this bar."""
    if not _enough_bars(df, 35):
        return SignalResult.empty()
    _, _, hist = compute_macd(df["close"])
    h = hist.dropna()
    if len(h) < 4:
        return SignalResult.empty()
    h0, h1 = float(h.iloc[-1]), float(h.iloc[-2])
    fired  = h0 > 0 and h1 <= 0
    return SignalResult(
        fired    = bool(fired),
        strength = float(min(abs(h0 - h1) * 100, 1.0)) if fired else 0.0,
        value    = h0,
    )


def sig_macd_turning(df: pd.DataFrame) -> SignalResult:
    """
    Histogram negative but rising for 3 consecutive bars.
    Earlier than crossover but still filtered.
    """
    if not _enough_bars(df, 35):
        return SignalResult.empty()
    _, _, hist = compute_macd(df["close"])
    h = hist.dropna()
    if len(h) < 4:
        return SignalResult.empty()
    h0, h1, h2, h3 = (float(h.iloc[-1]), float(h.iloc[-2]),
                      float(h.iloc[-3]), float(h.iloc[-4]))
    fired = h0 < 0 and h3 < h2 < h1 < h0
    return SignalResult(
        fired    = bool(fired),
        strength = 0.6 if fired else 0.0,
        value    = h0,
    )


def sig_adx_trend_strong(
    df:    pd.DataFrame,
    period: int   = 14,
    min_adx: float = 25.0,
) -> SignalResult:
    """ADX > threshold and +DI > -DI — bullish trend strength."""
    if not _enough_bars(df, period + 10):
        return SignalResult.empty()
    adx, pdi, ndi = compute_adx(df, period)
    a  = _safe_float(adx.iloc[-1])
    p  = _safe_float(pdi.iloc[-1])
    n  = _safe_float(ndi.iloc[-1])
    if any(np.isnan([a, p, n])):
        return SignalResult.empty()
    fired = a >= min_adx and p > n
    return SignalResult(
        fired    = bool(fired),
        strength = float(min(max(a - min_adx, 0) / 25.0, 1.0)) if fired else 0.0,
        value    = a,
        extras   = {"plus_di": round(p, 1), "minus_di": round(n, 1)},
    )


def sig_atr_expanding(df: pd.DataFrame, atr_period: int = 14, slope_window: int = 5) -> SignalResult:
    """ATR slope is positive — volatility expanding (energy building)."""
    if not _enough_bars(df, atr_period + slope_window + 5):
        return SignalResult.empty()
    closes = df["close"]
    atr = compute_atr(df, atr_period)
    atr_norm = atr / closes.replace(0, np.nan)
    slope = compute_slope(atr_norm, slope_window)
    if np.isnan(slope):
        return SignalResult.empty()
    cur_pct = float(atr_norm.iloc[-1]) if not pd.isna(atr_norm.iloc[-1]) else 0.0
    fired   = slope > 0 and cur_pct > 0.025
    return SignalResult(
        fired    = bool(fired),
        strength = float(min(slope * 1000, 1.0)) if fired else 0.0,
        value    = cur_pct,
    )


def sig_cmf_positive(
    df:        pd.DataFrame,
    period:    int   = 20,
    threshold: float = 0.05,
) -> SignalResult:
    """Chaikin Money Flow > threshold — institutional buying pressure."""
    if not _enough_bars(df, period + 5) or "volume" not in df.columns:
        return SignalResult.empty()
    cmf = _safe_float(compute_cmf(df, period).iloc[-1])
    if np.isnan(cmf):
        return SignalResult.empty()
    fired = cmf >= threshold
    return SignalResult(
        fired    = bool(fired),
        strength = float(min(max((cmf - threshold) / 0.15, 0.0), 1.0)) if fired else 0.0,
        value    = cmf,
    )


def sig_higher_lows(
    df:        pd.DataFrame,
    window:    int   = 30,
    pivot_left: int  = 3,
    pivot_right: int = 3,
) -> SignalResult:
    """
    Two consecutive higher swing lows — base-building / accumulation structure.
    """
    if not _enough_bars(df, window + pivot_right + 5):
        return SignalResult.empty()
    closes = df["close"].iloc[-window:]
    _, lows_idx = find_pivots(closes, pivot_left, pivot_right)
    if len(lows_idx) < 2:
        return SignalResult.empty()
    l1 = float(closes.iloc[lows_idx[-2]])
    l2 = float(closes.iloc[lows_idx[-1]])
    fired = l2 > l1 * 1.001
    return SignalResult(
        fired    = bool(fired),
        strength = float(min((l2 - l1) / l1 * 20, 1.0)) if fired else 0.0,
        value    = (l2 - l1) / l1 if l1 else 0.0,
    )


def sig_supertrend_bullish(
    df:        pd.DataFrame,
    period:    int   = 10,
    multiplier: float = 3.0,
) -> SignalResult:
    """SuperTrend currently bullish (price above ST line)."""
    if not _enough_bars(df, period + 10):
        return SignalResult.empty()
    st = compute_supertrend(df, period, multiplier)
    fired = bool(st.iloc[-1])
    # Strength: how many of last 5 bars were also bullish?
    last5 = st.iloc[-5:].sum() if len(st) >= 5 else int(fired)
    strength = float(last5) / 5.0 if fired else 0.0
    return SignalResult(fired=fired, strength=strength, value=1.0 if fired else 0.0)


def sig_price_range_break(
    df:       pd.DataFrame,
    lookback: int = 120,
) -> SignalResult:
    """Current close is the highest close in the lookback window."""
    if not _enough_bars(df, 20):
        return SignalResult.empty()
    closes = df["close"]
    n = min(lookback, len(closes))
    window_max = float(closes.iloc[-n:].max())
    cur = float(closes.iloc[-1])
    fired = cur >= window_max * 0.999
    if not fired:
        return SignalResult(fired=False, strength=0.0, value=cur / window_max if window_max else 0)
    # Strength = how clean the breakout is (prior bar much lower = clean break)
    if len(closes) >= 5:
        prior_max = float(closes.iloc[-n:-1].max())
        margin = (cur - prior_max) / prior_max if prior_max else 0
        strength = float(min(max(margin * 50, 0.2), 1.0))
    else:
        strength = 0.5
    return SignalResult(fired=True, strength=strength, value=cur)


# ═════════════════════════════════════════════════════════════════════════════
# RELATIVE STRENGTH vs BTC
# ═════════════════════════════════════════════════════════════════════════════

def sig_rs_vs_btc(
    token_closes: pd.Series,
    btc_closes:   pd.Series,
    window:       int   = 42,    # default 42 bars on 4h = 7 days
    min_outperformance: float = 0.03,
) -> SignalResult:
    """
    Token's return over `window` bars exceeds the benchmark's (BTC) by
    min_outperformance.
    """
    if (token_closes is None or btc_closes is None
            or len(token_closes) < window + 1 or len(btc_closes) < window + 1):
        return SignalResult.empty()
    t = token_closes.iloc[-(window + 1):].dropna()
    b = btc_closes.iloc[-(window + 1):].dropna()
    if len(t) < 2 or len(b) < 2:
        return SignalResult.empty()
    tok_ret = (float(t.iloc[-1]) - float(t.iloc[0])) / float(t.iloc[0])
    btc_ret = (float(b.iloc[-1]) - float(b.iloc[0])) / float(b.iloc[0])
    rs      = tok_ret - btc_ret
    fired   = rs >= min_outperformance
    return SignalResult(
        fired    = bool(fired),
        strength = float(min(max((rs - min_outperformance) / 0.15, 0.0), 1.0)) if fired else 0.0,
        value    = rs,
        extras   = {"token_ret_pct": round(tok_ret * 100, 2),
                    "btc_ret_pct":   round(btc_ret * 100, 2)},
    )


def sig_rs_acceleration(
    token_closes: pd.Series,
    btc_closes:   pd.Series,
    short_window: int   = 7,
    long_window:  int   = 42,
    min_outperformance: float = 0.03,
) -> SignalResult:
    """
    Short-window RS exceeds long-window RS — momentum is accelerating.
    Both windows must be outperforming individually.
    """
    short_rs = sig_rs_vs_btc(token_closes, btc_closes, short_window, min_outperformance)
    long_rs  = sig_rs_vs_btc(token_closes, btc_closes, long_window,  min_outperformance)
    if short_rs.value is None or long_rs.value is None:
        return SignalResult.empty()
    fired = (short_rs.fired and long_rs.fired
             and short_rs.value > long_rs.value)
    return SignalResult(
        fired    = bool(fired),
        strength = min(short_rs.strength, long_rs.strength) if fired else 0.0,
        value    = short_rs.value - long_rs.value,
        extras   = {"short_rs": short_rs.value, "long_rs": long_rs.value},
    )


def sig_btc_decoupling(
    token_closes: pd.Series,
    btc_closes:   pd.Series,
    window:       int   = 6,
    min_decoupling: float = 0.015,    # 1.5% outperformance
) -> SignalResult:
    """
    Short-window decoupling: token outperforms the benchmark (BTC) by
    min_decoupling over `window` bars. Catches token-specific catalysts.
    """
    res = sig_rs_vs_btc(token_closes, btc_closes, window, min_decoupling)
    return res


# ═════════════════════════════════════════════════════════════════════════════
# BEARISH-TWIN SIGNALS  — for short-side strategies (mirror of bullish signals)
# ═════════════════════════════════════════════════════════════════════════════
# Each function below is the bearish mirror of an existing bullish signal —
# same math, inverted comparisons.
#
# Note: sig_bb_squeeze, sig_rsi_in_zone, and sig_funding_extreme_long are
# direction-agnostic / already-bearish and are reused as-is by short strategies.


def sig_vol_distribution(
    df:         pd.DataFrame,
    recent:     int   = 6,
    base_start: int   = 7,
    base_end:   int   = 42,
    mult:       float = 1.5,
) -> SignalResult:
    """
    Bearish twin of sig_vol_expansion.
    Volume elevation in recent N bars vs baseline, only counted if the recent
    net price move is NEGATIVE (high volume + selling = distribution).
    """
    if not _enough_bars(df, base_end + recent) or "volume" not in df.columns:
        return SignalResult.empty()

    vols   = df["volume"].dropna()
    closes = df["close"].dropna()
    if len(vols) < base_end + recent or len(closes) < recent + 1:
        return SignalResult.empty()

    recent_avg = float(vols.iloc[-recent:].mean())
    base_slice = vols.iloc[-base_end:-base_start] if base_start > 0 else vols.iloc[-base_end:]
    base_avg   = float(base_slice.mean())
    if base_avg <= 0:
        return SignalResult.empty()

    p_start = float(closes.iloc[-recent])
    p_end   = float(closes.iloc[-1])
    if p_start <= 0:
        return SignalResult.empty()
    recent_price_pct = (p_end - p_start) / p_start

    ratio = recent_avg / base_avg
    fired = (ratio >= mult) and (recent_price_pct < -0.005)

    strength = 0.0
    if fired:
        vol_score  = min((ratio - mult) / 3.0, 1.0)
        drop_score = min(abs(recent_price_pct) / 0.05, 1.0)
        strength   = (vol_score + drop_score) / 2.0

    return SignalResult(
        fired    = bool(fired),
        strength = float(strength),
        value    = float(ratio),
        extras   = {
            "vol_ratio":        round(ratio, 2),
            "recent_price_pct": round(recent_price_pct * 100, 2),
        },
    )


def sig_bear_distribution_candle(
    df:              pd.DataFrame,
    lookback:        int   = 6,
    atr_mult:        float = 1.8,
    atr_period:      int   = 14,
    close_lower_pct: float = 0.30,
) -> SignalResult:
    """
    Bearish twin of sig_whale_candle. Large RED candle in the last `lookback`
    bars: body >= ATR * atr_mult, close in LOWER N% of range, close < open.
    Distribution-by-size — opposite of accumulation-by-size.
    """
    if not _enough_bars(df, atr_period + lookback + 2):
        return SignalResult.empty()

    atr = compute_atr(df, atr_period)
    atr_now = _safe_float(atr.iloc[-1])
    if np.isnan(atr_now) or atr_now <= 0:
        return SignalResult.empty()

    recent = df.iloc[-lookback:]
    best_strength = 0.0
    fired = False
    bars_ago = -1

    for i, (_, bar) in enumerate(recent.iloc[::-1].iterrows()):  # newest first
        o = float(bar["open"]); h = float(bar["high"])
        l = float(bar["low"]);  c = float(bar["close"])
        body = o - c                              # positive if bearish
        rng  = h - l
        if rng <= 0 or body <= 0:
            continue
        close_pos = (c - l) / rng                 # 0 = at low, 1 = at high
        if close_pos > close_lower_pct:
            continue
        body_atr_mult = body / atr_now
        if body_atr_mult < atr_mult:
            continue
        strength = min((body_atr_mult / atr_mult - 1.0) + 0.5, 1.0)
        recency_factor = 1.0 - (i / (lookback * 1.5))
        strength *= recency_factor
        if strength > best_strength:
            best_strength = strength
            bars_ago = i
            fired = True

    return SignalResult(
        fired    = fired,
        strength = float(best_strength),
        value    = atr_now,
        extras   = {"bars_ago": bars_ago} if fired else {},
    )


def sig_bear_obv_distribution(
    df:             pd.DataFrame,
    obv_lookback:   int   = 12,
    max_obv_pct:    float = -0.015,    # OBV must fall >= 1.5%
    max_price_move: float = 0.03,       # while price stays within +/-3%
) -> SignalResult:
    """
    Stealth distribution: OBV falls significantly while price is flat.
    Selling pressure not yet reflected in price.
    Bearish twin of sig_obv_stealth_accum.
    """
    if not _enough_bars(df, obv_lookback + 5) or "volume" not in df.columns:
        return SignalResult.empty()

    obv    = compute_obv(df)
    closes = df["close"]

    p_now   = float(closes.iloc[-1])
    p_prior = float(closes.iloc[-obv_lookback])
    o_now   = float(obv.iloc[-1])
    o_prior = float(obv.iloc[-obv_lookback])

    if any(np.isnan([p_now, p_prior, o_now, o_prior])) or o_prior == 0 or p_prior == 0:
        return SignalResult.empty()

    obv_pct   = (o_now - o_prior) / abs(o_prior)
    price_pct = (p_now - p_prior) / p_prior

    is_flat       = abs(price_pct) <= max_price_move
    obv_declining = obv_pct <= max_obv_pct
    fired         = bool(is_flat and obv_declining)

    strength = 0.0
    if fired:
        obv_score  = min(abs(obv_pct) / (abs(max_obv_pct) * 4), 1.0)
        flat_score = 1.0 - min(abs(price_pct) / max_price_move, 1.0)
        strength   = (obv_score + flat_score) / 2.0

    return SignalResult(
        fired    = fired,
        strength = float(strength),
        value    = float(obv_pct),
        extras   = {
            "obv_pct":   round(obv_pct * 100, 2),
            "price_pct": round(price_pct * 100, 2),
        },
    )


def sig_bear_obv_divergence(
    df:          pd.DataFrame,
    pivot_left:  int = 3,
    pivot_right: int = 3,
    lookback:    int = 40,
) -> SignalResult:
    """
    Bearish OBV divergence: price makes HIGHER high, OBV makes LOWER high.
    Smart money exiting while retail chases the price.
    Bearish twin of sig_obv_divergence.
    """
    if not _enough_bars(df, lookback + pivot_right + 5) or "volume" not in df.columns:
        return SignalResult.empty()

    obv    = compute_obv(df)
    closes = df["close"]

    win_close = closes.iloc[-lookback:]
    win_obv   = obv.iloc[-lookback:]

    # We want HIGH pivots
    price_highs, _ = find_pivots(win_close, pivot_left, pivot_right)
    obv_highs,   _ = find_pivots(win_obv,   pivot_left, pivot_right)
    if len(price_highs) < 2 or len(obv_highs) < 2:
        return SignalResult.empty()

    p1, p2 = float(win_close.iloc[price_highs[-2]]), float(win_close.iloc[price_highs[-1]])
    o1, o2 = float(win_obv.iloc[obv_highs[-2]]),     float(win_obv.iloc[obv_highs[-1]])

    if p1 == 0:
        return SignalResult.empty()

    price_higher = p2 > p1 * 1.005          # >= 0.5% higher high
    obv_lower    = o2 < o1
    fired        = bool(price_higher and obv_lower)

    strength = 0.0
    if fired:
        price_rise = (p2 - p1) / p1
        obv_gap    = (o1 - o2) / max(abs(o1), 1.0)
        strength   = min((price_rise * 10 + obv_gap) / 2.0, 1.0)
        strength   = max(strength, 0.0)

    return SignalResult(
        fired    = fired,
        strength = float(strength),
        value    = float((o1 - o2) / max(abs(o1), 1.0)) if o1 != 0 else 0.0,
        extras   = {
            "price_rise_pct": round((p2 - p1) / p1 * 100, 2) if p1 else 0.0,
        },
    )


def sig_bear_rsi_divergence(
    df:             pd.DataFrame,
    rsi_period:     int = 7,
    pivot_left:     int = 3,
    pivot_right:    int = 3,
    lookback:       int = 60,
    min_price_rise: float = 0.005,
    min_rsi_gap:    float = 3.0,
) -> SignalResult:
    """
    Bearish RSI divergence via swing-HIGH pivots.
    Fires when most recent two confirmed pivot HIGHS in price both have
    corresponding RSI pivot highs where price2 > price1 (higher high) but
    rsi2 < rsi1 - min_rsi_gap (lower high). Canonical bearish divergence.

    Also detects HIDDEN bearish (price lower high + RSI higher high) — flagged
    in extras as 'kind'='hidden_bearish' (continuation in downtrend).

    Uses RSI(7) by default — mirrors sig_rsi_divergence.
    """
    min_required = max(rsi_period, lookback) + pivot_right + 5
    if not _enough_bars(df, min_required):
        return SignalResult.empty()

    closes = df["close"]
    rsi    = compute_rsi(closes, rsi_period)

    window_closes = closes.iloc[-lookback:]
    window_rsi    = rsi.iloc[-lookback:]

    # HIGH pivots this time
    price_high_idx, _ = find_pivots(window_closes, pivot_left, pivot_right)
    if len(price_high_idx) < 2:
        return SignalResult.empty()

    i1, i2 = price_high_idx[-2], price_high_idx[-1]
    p1 = float(window_closes.iloc[i1])
    p2 = float(window_closes.iloc[i2])
    r1 = _safe_float(window_rsi.iloc[i1])
    r2 = _safe_float(window_rsi.iloc[i2])

    if any(np.isnan([p1, p2, r1, r2])) or p1 == 0:
        return SignalResult.empty()

    price_change_pct = (p2 - p1) / p1
    rsi_gap          = r2 - r1                  # negative => bearish

    is_bearish = (price_change_pct >= +min_price_rise) and (rsi_gap <= -min_rsi_gap)
    is_hidden  = (price_change_pct <= -min_price_rise) and (rsi_gap >= +min_rsi_gap)

    fired = bool(is_bearish or is_hidden)
    if not fired:
        return SignalResult(
            fired = False, strength = 0.0, value = rsi_gap,
            extras = {"kind": None, "price_change_pct": round(price_change_pct * 100, 2)},
        )

    if is_bearish:
        gap_score   = min(abs(rsi_gap) / 10.0, 1.0)
        price_score = min(price_change_pct / 0.05, 1.0)
        strength    = (gap_score + price_score) / 2.0
        kind        = "bearish"
    else:
        gap_score   = min(rsi_gap / 10.0, 1.0)
        price_score = min(abs(price_change_pct) / 0.05, 1.0)
        strength    = (gap_score + price_score) / 2.0
        kind        = "hidden_bearish"

    return SignalResult(
        fired    = True,
        strength = float(strength),
        value    = rsi_gap,
        extras   = {
            "kind":             kind,
            "price_change_pct": round(price_change_pct * 100, 2),
            "rsi_gap":          round(rsi_gap, 2),
            "rsi1":             round(r1, 1),
            "rsi2":             round(r2, 1),
        },
    )


def sig_rsi_overbought_reset(
    df:          pd.DataFrame,
    rsi_period:  int   = 7,
    high_thresh: float = 68.0,
    lookback:    int   = 24,
) -> SignalResult:
    """
    RSI was overbought (>= high_thresh) within the last `lookback` bars,
    AND RSI is currently FALLING. Catches the topping process.
    Bearish twin of sig_rsi_reset.
    """
    if not _enough_bars(df, max(rsi_period, lookback) + 5):
        return SignalResult.empty()

    rsi = compute_rsi(df["close"], rsi_period).dropna()
    if len(rsi) < lookback + 2:
        return SignalResult.empty()

    window   = rsi.iloc[-lookback:]
    cur      = float(rsi.iloc[-1])
    prev     = float(rsi.iloc[-2])
    had_high = bool((window >= high_thresh).any())
    falling  = cur < prev
    fired    = had_high and falling

    strength = 0.0
    if fired:
        depth   = (float(window.max()) - high_thresh) / max(100 - high_thresh, 1)
        bounce  = (float(window.max()) - cur)         / max(100 - high_thresh, 1)
        fall    = (prev - cur) / 100.0
        strength = float(min(max(depth + bounce + fall * 5, 0.0), 1.0))

    return SignalResult(
        fired    = fired,
        strength = strength,
        value    = cur,
        extras   = {
            "max_in_window": round(float(window.max()), 1),
            "rsi_now":       round(cur, 1),
        },
    )


def sig_lower_highs(
    df:          pd.DataFrame,
    window:      int = 30,
    pivot_left:  int = 3,
    pivot_right: int = 3,
) -> SignalResult:
    """Two consecutive lower swing highs — topping / distribution structure.
    Bearish twin of sig_higher_lows."""
    if not _enough_bars(df, window + pivot_right + 5):
        return SignalResult.empty()
    closes = df["close"].iloc[-window:]
    highs_idx, _ = find_pivots(closes, pivot_left, pivot_right)
    if len(highs_idx) < 2:
        return SignalResult.empty()
    h1 = float(closes.iloc[highs_idx[-2]])
    h2 = float(closes.iloc[highs_idx[-1]])
    fired = h2 < h1 * 0.999
    return SignalResult(
        fired    = bool(fired),
        strength = float(min((h1 - h2) / h1 * 20, 1.0)) if fired else 0.0,
        value    = (h2 - h1) / h1 if h1 else 0.0,
    )


def sig_cmf_negative(
    df:        pd.DataFrame,
    period:    int   = 20,
    threshold: float = -0.05,
) -> SignalResult:
    """Chaikin Money Flow <= threshold — institutional selling pressure.
    Bearish twin of sig_cmf_positive."""
    if not _enough_bars(df, period + 5) or "volume" not in df.columns:
        return SignalResult.empty()
    cmf = _safe_float(compute_cmf(df, period).iloc[-1])
    if np.isnan(cmf):
        return SignalResult.empty()
    fired = cmf <= threshold
    return SignalResult(
        fired    = bool(fired),
        strength = float(min(max((threshold - cmf) / 0.15, 0.0), 1.0)) if fired else 0.0,
        value    = cmf,
    )


def sig_price_range_fail(
    df:            pd.DataFrame,
    lookback:      int   = 120,
    rejection_pct: float = 0.02,
) -> SignalResult:
    """
    Price tagged within rejection_pct of the lookback-window high, then closed
    meaningfully below it within the last few bars. Topping rejection pattern.
    No direct bullish twin — this is a stand-alone bearish signal.
    """
    if not _enough_bars(df, 20):
        return SignalResult.empty()
    closes = df["close"]
    highs  = df["high"]
    n = min(lookback, len(closes))
    window_high = float(highs.iloc[-n:].max())
    cur         = float(closes.iloc[-1])
    if window_high <= 0:
        return SignalResult.empty()

    pull_back_pct = (window_high - cur) / window_high
    recent_high   = float(highs.iloc[-5:].max()) if len(highs) >= 5 else cur
    tagged_high   = recent_high >= window_high * 0.995

    fired = tagged_high and pull_back_pct >= rejection_pct

    strength = 0.0
    if fired:
        strength = float(min(pull_back_pct / 0.08, 1.0))   # 8% rejection = max

    return SignalResult(
        fired    = bool(fired),
        strength = strength,
        value    = pull_back_pct,
        extras   = {
            "window_high":   round(window_high, 6),
            "pull_back_pct": round(pull_back_pct * 100, 2),
        },
    )


def sig_btc_underperform(
    token_closes:     pd.Series,
    btc_closes:       pd.Series,
    window:           int   = 6,
    min_underperform: float = 0.015,
) -> SignalResult:
    """
    Short-window UNDERperformance: token loses to the benchmark (BTC) by
    min_underperform over `window` bars. Token-specific weakness
    (mirror of sig_btc_decoupling).
    """
    if (token_closes is None or btc_closes is None
            or len(token_closes) < window + 1 or len(btc_closes) < window + 1):
        return SignalResult.empty()
    t = token_closes.iloc[-(window + 1):].dropna()
    b = btc_closes.iloc[-(window + 1):].dropna()
    if len(t) < 2 or len(b) < 2:
        return SignalResult.empty()
    tok_ret = (float(t.iloc[-1]) - float(t.iloc[0])) / float(t.iloc[0])
    btc_ret = (float(b.iloc[-1]) - float(b.iloc[0])) / float(b.iloc[0])
    rs      = tok_ret - btc_ret                # negative = underperform
    fired   = rs <= -min_underperform
    return SignalResult(
        fired    = bool(fired),
        strength = float(min(max((-rs - min_underperform) / 0.15, 0.0), 1.0)) if fired else 0.0,
        value    = rs,
        extras   = {
            "token_ret_pct": round(tok_ret * 100, 2),
            "btc_ret_pct":   round(btc_ret * 100, 2),
        },
    )


def sig_bear_failed_breakout(
    df:            pd.DataFrame,
    lookback:      int = 60,
    max_bars_back: int = 5,
) -> SignalResult:
    """
    Failed breakout / bull trap: within the last `max_bars_back` bars, the
    HIGH of some bar exceeded the prior `lookback`-bar range high — but the
    current close is back BELOW that prior range high.

    Strong bearish signal — no direct bullish twin.
    """
    if not _enough_bars(df, lookback + max_bars_back + 2):
        return SignalResult.empty()

    closes = df["close"]
    highs  = df["high"]

    range_window = highs.iloc[-(lookback + max_bars_back):-max_bars_back]
    if len(range_window) < lookback // 2:
        return SignalResult.empty()
    range_high = float(range_window.max())
    if range_high <= 0:
        return SignalResult.empty()

    recent_highs  = highs.iloc[-max_bars_back:]
    breakout_bars = recent_highs[recent_highs > range_high * 1.001]
    if len(breakout_bars) == 0:
        return SignalResult.empty()

    cur = float(closes.iloc[-1])
    fired = cur < range_high * 0.999

    strength = 0.0
    if fired:
        extension_pct = (float(breakout_bars.max()) - range_high) / range_high
        retrace_pct   = (range_high - cur) / range_high
        strength = float(min((extension_pct * 20 + retrace_pct * 20) / 2, 1.0))

    return SignalResult(
        fired    = bool(fired),
        strength = strength,
        value    = cur / range_high if range_high else 0.0,
        extras   = {
            "range_high":    round(range_high, 6),
            "max_extension": round((float(breakout_bars.max()) - range_high) / range_high * 100, 2),
            "current_below": round((range_high - cur) / range_high * 100, 2),
        },
    )


# ═════════════════════════════════════════════════════════════════════════════
# PERP-SPECIFIC SIGNALS  — for perpetual-futures positioning data
# ═════════════════════════════════════════════════════════════════════════════
# AIDEV-NOTE: These take plain scalars (open interest, funding rate, turnover)
# rather than a DataFrame — feed them values already pulled from your perp/
# derivatives data source at the fetch boundary.

def sig_oi_building(
    oi_now:      float,
    oi_prev:     Optional[float],
    min_pct:     float = 0.03,
) -> SignalResult:
    """Open interest grew vs prior snapshot by >= min_pct."""
    if not isinstance(oi_prev, (int, float)) or oi_prev <= 0:
        return SignalResult.empty()
    pct = (oi_now - oi_prev) / oi_prev
    fired = pct >= min_pct
    return SignalResult(
        fired    = bool(fired),
        strength = float(min(max((pct - min_pct) / 0.10, 0.0), 1.0)) if fired else 0.0,
        value    = pct,
    )


def sig_oi_unwind(
    oi_now:      float,
    oi_prev:     Optional[float],
    max_pct:     float = -0.05,
) -> SignalResult:
    """Open interest fell vs prior snapshot by >= |max_pct| — conviction leaving."""
    if not isinstance(oi_prev, (int, float)) or oi_prev <= 0:
        return SignalResult.empty()
    pct = (oi_now - oi_prev) / oi_prev
    fired = pct <= max_pct
    return SignalResult(
        fired    = bool(fired),
        strength = float(min(abs(pct - max_pct) / 0.10, 1.0)) if fired else 0.0,
        value    = pct,
    )


def sig_funding_negative(
    funding_rate: Optional[float],
    threshold:    float = -0.0001,
) -> SignalResult:
    """Funding rate <= threshold — shorts paying longs (squeeze fuel)."""
    if funding_rate is None:
        return SignalResult.empty()
    fired = funding_rate <= threshold
    return SignalResult(
        fired    = bool(fired),
        strength = float(min(abs(funding_rate) / 0.0005, 1.0)) if fired else 0.0,
        value    = funding_rate,
    )


def sig_funding_extreme_long(
    funding_rate: Optional[float],
    threshold:    float = 0.0008,
) -> SignalResult:
    """
    Funding above extreme long threshold — DANGER signal (fade).
    fired=True is BAD here — caller should treat as a penalty.
    """
    if funding_rate is None:
        return SignalResult.empty()
    fired = funding_rate >= threshold
    return SignalResult(
        fired    = bool(fired),
        strength = float(min((funding_rate - threshold) / 0.0010, 1.0)) if fired else 0.0,
        value    = funding_rate,
    )


def sig_vol_oi_surge(
    turnover_24h: float,
    oi_value:     Optional[float],
    threshold:    float = 2.0,
) -> SignalResult:
    """24h turnover relative to OI value — high ratio = volume surge."""
    if oi_value is None or oi_value <= 0:
        return SignalResult.empty()
    ratio = turnover_24h / oi_value
    fired = ratio >= threshold
    return SignalResult(
        fired    = bool(fired),
        strength = float(min(max((ratio - threshold) / 5.0, 0.0), 1.0)) if fired else 0.0,
        value    = ratio,
    )


# ═════════════════════════════════════════════════════════════════════════════
# SIGNAL REGISTRY  — for introspection / programmatic dispatch
# ═════════════════════════════════════════════════════════════════════════════
# AIDEV-NOTE: Only the df-based signals share the (df, **params) shape. The RS
# family takes (token_closes, btc_closes, ...) and the perp family takes plain
# scalars — a generic dispatcher must special-case those groups (see comments).

SIGNAL_REGISTRY = {
    # contested (canonical)
    "bb_squeeze":          sig_bb_squeeze,
    "rsi_divergence":      sig_rsi_divergence,
    "obv_slope":           sig_obv_slope,
    "obv_stealth_accum":   sig_obv_stealth_accum,
    "obv_divergence":      sig_obv_divergence,
    "vol_expansion":       sig_vol_expansion,
    "vol_in_window":       sig_vol_in_window,
    "whale_candle":        sig_whale_candle,
    "rsi_reset":           sig_rsi_reset,
    "rsi_in_zone":         sig_rsi_in_zone,
    # uncontested trend
    "macd_crossover":      sig_macd_crossover,
    "macd_turning":        sig_macd_turning,
    "adx_trend_strong":    sig_adx_trend_strong,
    "atr_expanding":       sig_atr_expanding,
    "cmf_positive":        sig_cmf_positive,
    "higher_lows":         sig_higher_lows,
    "supertrend_bullish":  sig_supertrend_bullish,
    "price_range_break":   sig_price_range_break,
    # RS family (special: take btc series too)
    "rs_vs_btc":           sig_rs_vs_btc,
    "rs_acceleration":     sig_rs_acceleration,
    "btc_decoupling":      sig_btc_decoupling,
    # perp-specific (special: take scalars not df)
    "oi_building":         sig_oi_building,
    "oi_unwind":           sig_oi_unwind,
    "funding_negative":    sig_funding_negative,
    "funding_extreme_long": sig_funding_extreme_long,
    "vol_oi_surge":        sig_vol_oi_surge,
    # bearish-twin (used by short-side strategies)
    "vol_distribution":         sig_vol_distribution,
    "bear_distribution_candle": sig_bear_distribution_candle,
    "bear_obv_distribution":    sig_bear_obv_distribution,
    "bear_obv_divergence":      sig_bear_obv_divergence,
    "bear_rsi_divergence":      sig_bear_rsi_divergence,
    "rsi_overbought_reset":     sig_rsi_overbought_reset,
    "lower_highs":              sig_lower_highs,
    "cmf_negative":             sig_cmf_negative,
    "price_range_fail":         sig_price_range_fail,
    "btc_underperform":         sig_btc_underperform,
    "bear_failed_breakout":     sig_bear_failed_breakout,
}
