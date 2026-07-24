# Technical indicators

This module calculates RSI, ATR, MACD, ADX, OBV, SuperTrend, CMF, Bollinger Bands, and Keltner Channels from pandas Series or OHLCV DataFrames.

There is no configuration or I/O. Inputs must contain the lowercase price and volume columns required by the chosen function and must be sorted oldest first for path-dependent calculations. Outputs are pandas Series or tuples of Series aligned to the input index; rolling warm-up periods normally contain `NaN`.

The formulas are the implementations shown in the source and may differ from charting platforms that use different smoothing, seed, or missing-value conventions. Validate parity against the intended trading venue before using them for decisions.

Dependencies are NumPy and pandas. There is no dedicated automated test file in this repository.
