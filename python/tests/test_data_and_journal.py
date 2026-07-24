from pathlib import Path

import pandas as pd
import pytest

from backend_components.business_logic import trade_journal
from backend_components.database import unified_data_layer


def test_data_layer_circuit_breaker_opens_and_recovers(monkeypatch: pytest.MonkeyPatch) -> None:
    now = 100.0
    monkeypatch.setattr(
        "backend_components.database.unified_data_layer.time.time", lambda: now
    )
    breaker = unified_data_layer.CircuitBreaker(threshold=2, cooloff_s=10)

    breaker.record_failure()
    breaker.record_failure()
    assert breaker.is_open()

    now = 111.0
    assert not breaker.is_open()
    breaker.record_success()
    assert not breaker.is_open()


def test_data_layer_cache_path_stays_inside_cache_and_validates_timeframe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(unified_data_layer, "_CACHE_DIR", tmp_path)
    path = unified_data_layer._cache_path("BTC", "../outside", "1h")
    assert path.parent == tmp_path
    assert "/" not in path.name

    empty = pd.DataFrame()
    assert unified_data_layer._drop_unclosed_bars(empty, "unsupported") is empty


def test_cache_path_is_bounded_unique_and_defined_for_empty_values(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(unified_data_layer, "_CACHE_DIR", tmp_path)
    slash = unified_data_layer._cache_path("a/b", "", "")
    question = unified_data_layer._cache_path("a?b", "", "")
    embedded_nul = unified_data_layer._cache_path("a\0b", "c", "d")
    shifted_nul = unified_data_layer._cache_path("a", "b", "c\0d")
    empty = unified_data_layer._cache_path("", "", "")
    huge = unified_data_layer._cache_path("x" * 100_000, "source", "1h")

    assert slash != question
    assert embedded_nul != shifted_nul
    assert empty.parent == huge.parent == tmp_path
    assert len(huge.name) <= 24 + 1 + 64 + 4


def test_trade_journal_persists_and_loads_trade(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    journal = tmp_path / "trades.csv"
    monkeypatch.setattr(trade_journal, "JOURNAL_FILE", journal)
    trade_journal._save([{"id": 1, "symbol": "BTCUSDT", "notes": "test"}])
    rows = trade_journal._load()

    assert len(rows) == 1
    assert rows[0]["symbol"] == "BTCUSDT"
    assert journal.exists()


def test_trade_journal_sanitizes_spreadsheet_formula() -> None:
    assert trade_journal._sanitize_csv("=1+1").startswith("'")
    assert trade_journal._float("invalid", default=3.5) == 3.5
