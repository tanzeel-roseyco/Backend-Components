import numpy as np
import pandas as pd
import pytest

from backend_components.business_logic.signal_library import (
    SignalResult,
    compute_ema,
    sig_macd_crossover,
)
from backend_components.business_logic.technical_indicators import (
    compute_atr,
    compute_macd,
    compute_obv,
)


def sample_prices(size: int = 40) -> pd.DataFrame:
    close = pd.Series(np.linspace(100.0, 120.0, size))
    return pd.DataFrame(
        {
            "open": close - 0.5,
            "high": close + 1.0,
            "low": close - 1.0,
            "close": close,
            "volume": np.arange(size, dtype=float) + 100.0,
        }
    )


def test_indicators_preserve_shape_and_compute_expected_obv() -> None:
    prices = sample_prices()
    atr = compute_atr(prices, period=3)
    macd, signal, histogram = compute_macd(prices["close"])

    assert len(atr) == len(prices)
    assert atr.iloc[-1] == pytest.approx(2.0)
    assert len(macd) == len(signal) == len(histogram) == len(prices)
    assert compute_obv(prices).iloc[-1] == pytest.approx(prices["volume"].iloc[1:].sum())


def test_indicator_rejects_missing_required_columns() -> None:
    with pytest.raises(KeyError):
        compute_atr(pd.DataFrame({"close": [1.0, 2.0]}))


def test_signal_library_handles_insufficient_and_valid_data() -> None:
    assert compute_ema(pd.Series([1.0, 2.0]), 2).iloc[-1] > 1.0
    result = sig_macd_crossover(sample_prices(2))

    assert isinstance(result, SignalResult)
    assert result.fired is False
