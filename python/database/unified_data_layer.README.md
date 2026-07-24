# Unified public market-data layer

This module retrieves symbol universes, OHLCV bars, tickers, funding rates, and open-interest history from public Bybit and Binance endpoints. It shares OHLCV data through a CSV cache and removes the current unclosed candle before returning frames.

All configuration is optional. `DATA_CACHE_DIR`, `DATA_LOG_DIR`, the three API base variables, and `DATA_USER_AGENT` override their documented defaults. Public functions return dictionaries, pandas DataFrames, or `None`/empty collections when data cannot be obtained.

Importing the module creates cache and log directories and configures logging. Network calls use retries and a process-local circuit breaker. Cached CSV files can become stale or corrupted, exchange schemas and limits can change, and public endpoints provide no availability guarantee. Returned OHLCV is normalised to lowercase columns and chronological order when parsing succeeds.

Dependencies are pandas, requests, and urllib3. There is no dedicated automated test file here.
