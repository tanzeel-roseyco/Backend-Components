"""
Technical Indicators Library
================================================================================
Pure, dependency-light technical-analysis indicator functions built on numpy
and pandas. Single source of truth for RSI, ATR, MACD, ADX, OBV, SuperTrend,
CMF, Bollinger Bands, and Keltner Channels.

Adapted and generalized from a production market-scanner codebase for reuse
as a standalone, framework-agnostic component.

Purpose:
    Given OHLCV (open/high/low/close/volume) price data as pandas objects,
    compute common technical indicators used by trading/scanning systems.

Required env vars:
    None. This module performs pure numerical computation and reads no
    configuration, credentials, or network resources. All tunables (periods,
    multipliers) are passed explicitly as function arguments.

Key dependencies:
    - numpy   (vectorized numerics)
    - pandas  (Series/DataFrame time-series handling)

Input conventions:
    - Price series are passed as pd.Series (e.g. close prices).
    - OHLCV frames are pd.DataFrame with lowercase columns among:
      "open", "high", "low", "close", "volume" (only those a given function
      needs are required — see each docstring).
    - Output Series preserve the input index; leading positions where a
      rolling window has insufficient data are NaN by design.

Note: Role = shared, pure indicator kernel. It intentionally holds NO
state, NO I/O, and NO secrets so it is safe to publish and reuse. Ordering
constraint: SuperTrend and ADX are path-dependent (each bar depends on the
prior bar), so callers must pass rows in chronological order (oldest first);
passing reverse-sorted data yields silently wrong trend signals.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def compute_rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """Relative Strength Index (Wilder, simple-mean variant).

    Args:
        series: Price series (typically close prices), chronological order.
        period: Lookback window in bars.

    Returns:
        pd.Series of RSI values in [0, 100]. NaN where there is insufficient
        data to fill the window, or where average loss is zero (no downward
        movement) and RSI is undefined.
    """
    delta = series.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    # Divide-by-zero guard: a flat/rising window has zero average loss.
    rs = gain / loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def compute_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Average True Range (simple rolling mean of True Range).

    Args:
        df: OHLCV frame requiring columns "high", "low", "close".
        period: Lookback window in bars.

    Returns:
        pd.Series of ATR values; NaN until the window is filled.
    """
    highs = df["high"]
    lows = df["low"]
    closes = df["close"]
    # True Range = max(H-L, |H - prev_close|, |L - prev_close|).
    tr = pd.concat(
        [
            highs - lows,
            (highs - closes.shift(1)).abs(),
            (lows - closes.shift(1)).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr.rolling(period).mean()


def compute_macd(
    series: pd.Series,
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Moving Average Convergence Divergence.

    Args:
        series: Price series (typically close prices).
        fast: Span of the fast EMA.
        slow: Span of the slow EMA.
        signal: Span of the signal-line EMA applied to the MACD line.

    Returns:
        Tuple of (macd_line, signal_line, histogram) as pd.Series.
    """
    ema_fast = series.ewm(span=fast, adjust=False).mean()
    ema_slow = series.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram


def compute_adx(
    df: pd.DataFrame,
    period: int = 14,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Average Directional Index with directional indicators.

    Args:
        df: OHLCV frame requiring columns "high", "low", "close",
            in chronological order (path-dependent via prior-bar diffs).
        period: Lookback window in bars.

    Returns:
        Tuple of (adx, plus_di, minus_di) as pd.Series.
    """
    highs = df["high"]
    lows = df["low"]
    closes = df["close"]

    up = highs.diff()
    down = -lows.diff()
    # Directional movement: only the dominant, positive move counts each bar.
    plus_dm = up.where((up > down) & (up > 0), 0.0)
    minus_dm = down.where((down > up) & (down > 0), 0.0)

    tr = pd.concat(
        [
            highs - lows,
            (highs - closes.shift(1)).abs(),
            (lows - closes.shift(1)).abs(),
        ],
        axis=1,
    ).max(axis=1)

    # replace(0, nan) so flat ATR windows produce NaN DI rather than inf.
    atr_s = tr.rolling(period).mean().replace(0, np.nan)
    plus_di = 100 * (plus_dm.rolling(period).mean() / atr_s)
    minus_di = 100 * (minus_dm.rolling(period).mean() / atr_s)
    dx = 100 * ((plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan))
    adx = dx.rolling(period).mean()

    return adx, plus_di, minus_di


def compute_obv(df: pd.DataFrame) -> pd.Series:
    """On-Balance Volume (cumulative volume signed by close direction).

    Args:
        df: OHLCV frame requiring columns "close", "volume".

    Returns:
        Cumulative OBV pd.Series.
    """
    direction = np.sign(df["close"].diff().fillna(0))
    return (direction * df["volume"]).cumsum()


def compute_supertrend(
    df: pd.DataFrame,
    period: int = 10,
    multiplier: float = 3.0,
) -> pd.Series:
    """SuperTrend trend-direction indicator.

    Args:
        df: OHLCV frame requiring columns "high", "low", "close",
            in chronological order (each bar depends on the previous bar).
        period: ATR lookback window in bars.
        multiplier: ATR band multiplier controlling band width.

    Returns:
        Boolean pd.Series aligned to df.index: True = bullish
        (close above the SuperTrend line), False otherwise.

    Note:
        Uses raw numpy arrays and explicit loops because each bar's band and
        trend depend on the previous bar's values — this recurrence cannot be
        vectorized cleanly, and array access is markedly faster than iterating
        pandas objects row-by-row.
    """
    n = len(df)
    h = df["high"].values.astype(float)
    l = df["low"].values.astype(float)
    c = df["close"].values.astype(float)

    # True Range (index 0 left at 0.0: no prior close to compare).
    tr = np.zeros(n)
    for i in range(1, n):
        tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))

    # ATR as a simple rolling mean over the True Range.
    atr = np.zeros(n)
    for i in range(period, n):
        atr[i] = tr[i - period + 1 : i + 1].mean()

    hl2 = (h + l) / 2.0
    upper_basic = hl2 + multiplier * atr
    lower_basic = hl2 - multiplier * atr

    # Final bands "ratchet": they only loosen when price breaks through,
    # otherwise they hold the prior bar's tighter band.
    upper = upper_basic.copy()
    lower = lower_basic.copy()
    for i in range(1, n):
        upper[i] = (
            upper_basic[i]
            if (upper_basic[i] < upper[i - 1] or c[i - 1] > upper[i - 1])
            else upper[i - 1]
        )
        lower[i] = (
            lower_basic[i]
            if (lower_basic[i] > lower[i - 1] or c[i - 1] < lower[i - 1])
            else lower[i - 1]
        )

    # SuperTrend line + trend state: flip on band breakout, else carry trend.
    st = np.zeros(n)
    in_uptrend = True
    for i in range(period, n):
        if atr[i] == 0:
            continue
        if c[i] > upper[i - 1]:
            in_uptrend = True
        elif c[i] < lower[i - 1]:
            in_uptrend = False
        st[i] = lower[i] if in_uptrend else upper[i]

    # Emit bullish flags only where the SuperTrend line is defined.
    bullish = np.zeros(n, dtype=bool)
    for i in range(period, n):
        if st[i] != 0 and not np.isnan(st[i]):
            bullish[i] = float(c[i]) > st[i]

    return pd.Series(bullish, index=df.index)


def compute_cmf(df: pd.DataFrame, period: int = 20) -> pd.Series:
    """Chaikin Money Flow.

    Args:
        df: OHLCV frame requiring columns "high", "low", "close", "volume".
        period: Lookback window in bars.

    Returns:
        CMF pd.Series in the range [-1, +1].
    """
    # replace(0, nan) avoids divide-by-zero on doji bars where high == low.
    hl = (df["high"] - df["low"]).replace(0, np.nan)
    mfm = ((df["close"] - df["low"]) - (df["high"] - df["close"])) / hl
    mfv = mfm * df["volume"]
    vol_sum = df["volume"].rolling(period).sum().replace(0, np.nan)
    return mfv.rolling(period).sum() / vol_sum


def compute_bb(
    series: pd.Series,
    period: int = 20,
    std_mult: float = 2.0,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Bollinger Bands.

    Args:
        series: Price series (typically close prices).
        period: Lookback window for the moving average and standard deviation.
        std_mult: Number of standard deviations for the outer bands.

    Returns:
        Tuple of (upper, mid, lower) as pd.Series.
    """
    mid = series.rolling(period).mean()
    std = series.rolling(period).std()
    upper = mid + std_mult * std
    lower = mid - std_mult * std
    return upper, mid, lower


def compute_keltner(
    df: pd.DataFrame,
    period: int = 20,
    atr_period: int = 10,
    multiplier: float = 1.5,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Keltner Channels.

    Args:
        df: OHLCV frame requiring columns "high", "low", "close".
        period: EMA span for the channel midline.
        atr_period: ATR lookback window for band width.
        multiplier: ATR multiplier controlling band width.

    Returns:
        Tuple of (upper, mid, lower) as pd.Series, where
        mid = EMA(close, period) and bands = mid ± multiplier × ATR(atr_period).

    Note:
        When Bollinger Bands sit inside Keltner Channels the market is in a
        volatility "squeeze" (compression), often read as a precursor to a
        directional expansion.
    """
    mid = df["close"].ewm(span=period, adjust=False).mean()
    atr = compute_atr(df, atr_period)
    upper = mid + multiplier * atr
    lower = mid - multiplier * atr
    return upper, mid, lower
