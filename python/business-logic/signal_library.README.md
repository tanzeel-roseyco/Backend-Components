# Technical-analysis signal library

This file provides a common `SignalResult` shape and a collection of bullish, bearish, volume, momentum, trend, relative-strength, funding, and open-interest signal functions. It also includes the indicator and pivot helpers required by those signals.

Most signals accept a chronological OHLCV DataFrame and inspect its last row as the current bar. Scalar-based functions accept values directly. Results contain `fired`, a normalised strength, an optional diagnostic value, and extra fields.

The functions are designed to return an empty result for insufficient or malformed data, although callers should still validate column names, numeric types, bar ordering, and whether the final candle is closed. Default thresholds encode particular trading assumptions; they are not forecasts, guarantees, or a substitute for strategy validation. The duplicated reference indicators may not match every external charting package.

Dependencies are NumPy and pandas. The repository does not include dedicated signal tests or backtest evidence.
