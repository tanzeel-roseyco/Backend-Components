"""
================================================================================
TRADE JOURNAL + ANALYTICS
================================================================================
CSV-backed trade logger and performance analytics engine for systematic
trading strategies. Logs every trade taken from any signal source and produces
hard performance analytics.

Answers the core question: "Is the strategy actually making money?"

Tracks:
  - Entry / exit prices, signal source, market regime, conviction, signals fired
  - R-multiple per trade (P&L normalised to initial risk)
  - Win rate, expectancy, avg winner/loser, profit factor, max drawdown
  - Equity curve (ASCII sparkline)
  - Breakdown by source, regime, exit reason, and top-performing signals
  - Daily realised P&L helper for an external circuit breaker

Storage: CSV flat file — human-readable, auditable, importable into a spreadsheet.

--------------------------------------------------------------------------------
Required / optional environment variables
--------------------------------------------------------------------------------
  TRADE_JOURNAL_FILE           Absolute path to the CSV journal file.
                               If unset, defaults to <cwd>/outputs/journal/
                               trade_journal.csv (parent dirs auto-created).
  TRADE_JOURNAL_ACCOUNT_START  Starting capital used as the equity-curve base
                               and for drawdown %. Float. Defaults to 10000.0.

No secrets are consumed by this module.

--------------------------------------------------------------------------------
Key dependencies
--------------------------------------------------------------------------------
  Standard library only: argparse, csv, os, sys, datetime, pathlib.

--------------------------------------------------------------------------------
CLI usage
--------------------------------------------------------------------------------
  python trade_journal.py log   --symbol SUI --source alpha --conviction 72 \
                                --entry 3.45 --stop 3.18 \
                                --tp1 3.80 --tp2 4.15 --tp3 4.75 \
                                --risk 726 --pos 3867 \
                                --regime bull \
                                --signals "rs_strong,trend_bull,vol_burst" \
                                [--notes "clean breakout"]

  python trade_journal.py close --id 5 --exit 3.80 --reason tp1
  python trade_journal.py list  [--open | --closed]
  python trade_journal.py stats [--source alpha] [--regime bull]
  python trade_journal.py delete --id 5 --confirm
================================================================================

Note: Adapted and generalized from a production codebase. Role:
single source of truth for realised trade performance. Two security/ordering
constraints matter here: (1) all free-text fields written to CSV are passed
through `_sanitize_csv` to neutralise spreadsheet formula injection (=,+,-,@)
BEFORE persisting — never bypass it; (2) `get_today_pnl` is read by an external
daily circuit breaker to enforce a max daily-loss limit, so its return contract
(sum of today's closed pnl, 0.0 on any absence) must stay stable.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# Fix Windows cp1252 encoding issues with Unicode box-drawing characters.
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    # reconfigure() exists on TextIOWrapper (Py3.7+); guard for exotic streams.
    reconfigure = getattr(sys.stdout, "reconfigure", None)
    if callable(reconfigure):
        reconfigure(encoding="utf-8", errors="replace")


# ─────────────────────────────────────────────────────────────────────────────
# PATHS & SCHEMA
# ─────────────────────────────────────────────────────────────────────────────

def _resolve_journal_file() -> Path:
    """
    Resolve the CSV journal path from TRADE_JOURNAL_FILE, or fall back to
    <cwd>/outputs/journal/trade_journal.csv. Ensures the parent directory
    exists so the first write cannot fail on a missing folder.
    """
    override = os.getenv("TRADE_JOURNAL_FILE")
    path = Path(override) if override else Path.cwd() / "outputs" / "journal" / "trade_journal.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _account_start() -> float:
    """Starting capital (equity-curve base) from env, defaulting to 10000.0.

    Note: account_start is a denominator for total-return% and drawdown%.
    A zero/negative base (e.g. TRADE_JOURNAL_ACCOUNT_START=0) would raise
    ZeroDivisionError in cmd_stats — so reject non-positive values at this
    boundary and fall back to the default.
    """
    val = _float(os.getenv("TRADE_JOURNAL_ACCOUNT_START"), 10_000.0)
    return val if val > 0 else 10_000.0


JOURNAL_FILE: Path = _resolve_journal_file()

# CSV schema. Order here IS the on-disk column order — do not reorder without a
# migration, existing journals are read positionally by DictReader on header.
COLUMNS: list[str] = [
    "id",
    "date_opened",
    "date_closed",
    "symbol",
    "source",          # which signal source/strategy produced the trade
    "regime",          # bull / sideways / bear
    "conviction",      # 0–100 conviction score from the source
    "signals",         # comma-separated fired signals
    "entry_price",
    "stop_price",
    "tp1_price",
    "tp2_price",
    "tp3_price",
    "pos_value_usdt",  # position size in quote currency
    "risk_usdt",       # amount at risk (entry→stop × qty)
    "exit_price",
    "exit_reason",     # tp1 / tp2 / tp3 / stop / manual
    "pnl_usdt",        # realised P&L in quote currency
    "r_multiple",      # pnl_usdt / risk_usdt
    "notes",
]


# ─────────────────────────────────────────────────────────────────────────────
# CSV HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _load() -> list[dict[str, str]]:
    """Read all rows from the journal CSV; returns [] if the file is absent."""
    if not JOURNAL_FILE.exists():
        return []
    with JOURNAL_FILE.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _save(rows: list[dict[str, object]]) -> None:
    """Overwrite the journal CSV with `rows` (full rewrite, header first)."""
    with JOURNAL_FILE.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


def _next_id(rows: list[dict[str, str]]) -> int:
    """Monotonic 1-based trade id: max existing id + 1."""
    if not rows:
        return 1
    return max(int(r["id"]) for r in rows) + 1


def _now() -> str:
    """Current UTC timestamp as 'YYYY-MM-DD HH:MM'."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")


def _sanitize_csv(value: str) -> str:
    """
    Prevent CSV/spreadsheet formula injection by prefixing a single quote to
    any value that begins with a formula-trigger character.

    Note: security-critical. Must run on every user-supplied free-text
    field (signals, notes) before it is persisted.
    """
    if value and value[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def _float(val: object | None, default: float = 0.0) -> float:
    """Coerce a CSV/env string to float, tolerating '', None and 'None'."""
    try:
        return float(val) if val not in (None, "", "None") else default  # type: ignore[arg-type]
    except (ValueError, TypeError):
        return default


# ─────────────────────────────────────────────────────────────────────────────
# CIRCUIT BREAKER HELPER
# ─────────────────────────────────────────────────────────────────────────────

def get_today_pnl() -> float:
    """
    Sum of all closed-trade realised P&L (pnl_usdt) for today (UTC).

    Consumed by an external daily circuit breaker (e.g. an orchestrator that
    halts new entries once a max daily-loss threshold is breached). Returns
    0.0 if no trades exist or the journal file is missing.

    Note: expected interface for the omitted orchestrator dependency —
    the circuit breaker calls this and compares the result against its own
    configured daily-loss limit (commonly a negative % of account equity).
    """
    rows = _load()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    total = 0.0
    for r in rows:
        if r.get("date_closed", "").startswith(today) and r.get("pnl_usdt"):
            try:
                total += float(r["pnl_usdt"])
            except (ValueError, TypeError):
                pass
    return total


# ─────────────────────────────────────────────────────────────────────────────
# COMMANDS
# ─────────────────────────────────────────────────────────────────────────────

def cmd_log(args: argparse.Namespace) -> None:
    """Add a new open trade to the journal."""
    rows = _load()
    trade_id = _next_id(rows)

    # Derive risk from position value and stop distance if not given explicitly.
    entry = args.entry
    stop = args.stop
    pos = args.pos if args.pos else 0.0
    risk = args.risk
    if risk is None:
        if entry and stop and pos:
            stop_pct = abs(entry - stop) / entry
            risk = round(pos * stop_pct, 2)
        else:
            risk = 0.0

    row: dict[str, object] = {
        "id": trade_id,
        "date_opened": _now(),
        "date_closed": "",
        "symbol": args.symbol.upper(),
        "source": args.source.lower(),
        "regime": args.regime.lower() if args.regime else "",
        "conviction": args.conviction if args.conviction else "",
        "signals": _sanitize_csv(args.signals) if args.signals else "",
        "entry_price": round(entry, 8) if entry else "",
        "stop_price": round(stop, 8) if stop else "",
        "tp1_price": round(args.tp1, 8) if args.tp1 else "",
        "tp2_price": round(args.tp2, 8) if args.tp2 else "",
        "tp3_price": round(args.tp3, 8) if args.tp3 else "",
        "pos_value_usdt": round(pos, 2),
        "risk_usdt": round(risk, 2),
        "exit_price": "",
        "exit_reason": "",
        "pnl_usdt": "",
        "r_multiple": "",
        "notes": _sanitize_csv(args.notes) if args.notes else "",
    }

    rows.append(row)
    _save(rows)

    print(f"\n  Trade #{trade_id} logged.")
    print(f"  {row['symbol']}  |  entry {row['entry_price']}  stop {row['stop_price']}"
          f"  |  risk ${row['risk_usdt']}  |  source: {row['source']}\n")


def cmd_close(args: argparse.Namespace) -> None:
    """Close an open trade, computing realised P&L and R-multiple."""
    rows = _load()
    found = [r for r in rows if int(r["id"]) == args.id]
    if not found:
        print(f"\n  [ERROR] Trade #{args.id} not found.\n")
        sys.exit(1)

    row = found[0]
    if row["date_closed"]:
        print(f"\n  [ERROR] Trade #{args.id} is already closed ({row['date_closed']}).\n")
        sys.exit(1)

    entry = _float(row["entry_price"])
    pos = _float(row["pos_value_usdt"])
    risk = _float(row["risk_usdt"])
    exit_p = args.exit
    reason = args.reason.lower()

    # P&L = price move × quantity, where qty is derived from position notional.
    # Note: long-only P&L. The origin codebase's direction/`short` enum was
    # dropped during generalisation, so shorts would report an inverted sign.
    # Add a `direction` field + `(entry - exit)` branch before using for shorts.
    if entry > 0 and pos > 0:
        qty = pos / entry
        pnl = round((exit_p - entry) * qty, 2)
    else:
        pnl = 0.0

    r_mult = round(pnl / risk, 2) if risk and risk > 0 else None

    row["date_closed"] = _now()
    row["exit_price"] = round(exit_p, 8)
    row["exit_reason"] = reason
    row["pnl_usdt"] = pnl
    row["r_multiple"] = r_mult if r_mult is not None else ""
    if args.notes:
        # Append close note to any existing open note.
        row["notes"] = (str(row["notes"]) + " | " + args.notes).strip(" | ")

    _save(rows)

    pnl_str = f"+${pnl:,.2f}" if pnl >= 0 else f"-${abs(pnl):,.2f}"
    r_str = ("N/A" if r_mult is None else
             f"+{r_mult:.2f}R" if r_mult >= 0 else f"{r_mult:.2f}R")
    print(f"\n  Trade #{args.id} closed.  {row['symbol']}  @{exit_p}  [{reason}]")
    print(f"  P&L: {pnl_str}   R: {r_str}\n")


def cmd_list(args: argparse.Namespace) -> None:
    """List trades, optionally filtered to only open or only closed."""
    rows = _load()
    if not rows:
        print("\n  No trades logged yet.\n")
        return

    if args.open:
        rows = [r for r in rows if not r["date_closed"]]
    elif args.closed:
        rows = [r for r in rows if r["date_closed"]]

    if not rows:
        print("\n  No matching trades.\n")
        return

    print()
    print(f"  {'#':<4}  {'Symbol':<8}  {'Source':<10}  {'Regime':<10}  "
          f"{'Conv':>4}  {'Entry':>10}  {'Stop':>10}  {'Exit':>10}  "
          f"{'P&L':>9}  {'R':>6}  {'Reason':<8}  {'Opened':<16}")
    print("  " + "─" * 118)

    for r in rows:
        pnl_raw = _float(r["pnl_usdt"], None)  # type: ignore[arg-type]
        r_raw = _float(r["r_multiple"], None)  # type: ignore[arg-type]

        # Note: test `is None`, not truthiness — a closed breakeven trade
        # has pnl/r == 0.0 (falsy) and must NOT be mislabelled "open"/"—".
        pnl_str = ("open" if pnl_raw is None
                   else f"+{pnl_raw:,.0f}" if pnl_raw >= 0
                   else f"{pnl_raw:,.0f}")
        r_str = ("—" if r_raw is None
                 else f"+{r_raw:.2f}R" if r_raw >= 0
                 else f"{r_raw:.2f}R")

        print(f"  {r['id']:<4}  {r['symbol']:<8}  {r['source']:<10}  "
              f"{r['regime']:<10}  {r['conviction']:>4}  "
              f"{r['entry_price']:>10}  {r['stop_price']:>10}  "
              f"{r['exit_price'] or '—':>10}  "
              f"{pnl_str:>9}  {r_str:>6}  {r['exit_reason'] or '—':<8}  "
              f"{r['date_opened'][:16]:<16}")

    print()


def cmd_delete(args: argparse.Namespace) -> None:
    """Hard-delete a trade (irreversible; requires --confirm)."""
    if not args.confirm:
        print("\n  Pass --confirm to permanently delete a trade.\n")
        sys.exit(1)
    rows = _load()
    before = len(rows)
    rows = [r for r in rows if int(r["id"]) != args.id]
    if len(rows) == before:
        print(f"\n  [ERROR] Trade #{args.id} not found.\n")
        sys.exit(1)
    _save(rows)
    print(f"\n  Trade #{args.id} deleted.\n")


def cmd_stats(args: argparse.Namespace) -> None:
    """Compute and print full performance analytics over closed trades."""
    rows = _load()
    account_start = _account_start()

    # Filter to closed trades, applying optional source/regime filters.
    closed = [r for r in rows if r["date_closed"]]
    if args.source:
        closed = [r for r in closed if r["source"] == args.source.lower()]
    if args.regime:
        closed = [r for r in closed if r["regime"] == args.regime.lower()]

    open_trades = [r for r in rows if not r["date_closed"]]

    width = 62  # output width

    def line(label: str = "", value: str = "", w: int = width) -> None:
        if not label and not value:
            print(f"  {'─' * (w - 2)}")
            return
        print(f"  {label:<30}{value}")

    def header(title: str) -> None:
        print()
        print("  " + "═" * (width - 2))
        print(f"  {title}")
        print("  " + "═" * (width - 2))

    header("TRADE JOURNAL  —  Performance Analytics")
    print(f"  Account start : ${account_start:>10,.2f}")
    print(f"  Total trades  : {len(rows)}  ({len(closed)} closed, {len(open_trades)} open)")
    if args.source or args.regime:
        filters = []
        if args.source:
            filters.append(f"source={args.source}")
        if args.regime:
            filters.append(f"regime={args.regime}")
        print(f"  Filter        : {', '.join(filters)}")

    if not closed:
        print("\n  No closed trades to analyse yet.\n")
        return

    # ── Core metrics ──────────────────────────────────────────────────────────
    # R-multiple is the primary performance unit (P&L normalised to risk).
    r_vals: list[float] = [
        _float(r["r_multiple"])
        for r in closed
        if r["r_multiple"] not in (None, "", "None")
    ]
    pnl_vals = [_float(r["pnl_usdt"]) for r in closed]

    # Note: win/loss classification keys off r_multiple. The original
    # source keyed off a non-existent 'pnl_pct' field, which silently made
    # win_rate/avg_win/avg_loss always 0 — fixed here to use realised R.
    win_r = [x for x in r_vals if x > 0]
    loss_r = [x for x in r_vals if x < 0]

    win_rate = len(win_r) / len(r_vals) * 100 if r_vals else 0.0
    avg_win = sum(win_r) / len(win_r) if win_r else 0.0
    avg_loss = sum(loss_r) / len(loss_r) if loss_r else 0.0
    expectancy = sum(r_vals) / len(r_vals) if r_vals else 0.0
    total_pnl = sum(pnl_vals)
    total_risk = sum(_float(r["risk_usdt"]) for r in closed)
    best_trade = max(closed, key=lambda r: _float(r["r_multiple"]))
    worst_trade = min(closed, key=lambda r: _float(r["r_multiple"]))

    # Equity curve & max drawdown (peak-to-trough on realised equity).
    equity = account_start
    peak = account_start
    max_dd = 0.0
    eq_curve: list[float] = []
    for pnl in pnl_vals:
        equity += pnl
        peak = max(peak, equity)
        dd = peak - equity
        max_dd = max(max_dd, dd)
        eq_curve.append(equity)

    current_equity = eq_curve[-1] if eq_curve else account_start
    total_ret_pct = (current_equity - account_start) / account_start * 100

    # Profit factor = gross wins / gross losses.
    gross_win = sum(p for p in pnl_vals if p > 0)
    gross_loss = abs(sum(p for p in pnl_vals if p < 0))
    pf = (gross_win / gross_loss) if gross_loss > 0 else float("inf")

    line()
    line("CLOSED TRADE SUMMARY")
    line()
    line("Win Rate", f"{win_rate:.1f}%  ({len(win_r)}W / {len(loss_r)}L)")
    line("Avg Winner", f"+{avg_win:.2f}R")
    line("Avg Loser", f"{avg_loss:.2f}R")
    line("Expectancy", f"{expectancy:+.2f}R per trade")
    line("Profit Factor", f"{pf:.2f}" if pf != float("inf") else "∞ (no losing trades)")
    line()
    line("Total P&L", f"${total_pnl:+,.2f}  ({total_ret_pct:+.2f}%)")
    line("Current Equity", f"${current_equity:,.2f}")
    line("Max Drawdown", f"-${max_dd:,.2f}  (-{max_dd / account_start * 100:.2f}%)")
    line("Total Risk Used", f"${total_risk:,.2f}")
    line()
    line("Best Trade",
         f"#{best_trade['id']} {best_trade['symbol']}  {_float(best_trade['r_multiple']):+.2f}R  "
         f"${_float(best_trade['pnl_usdt']):+,.2f}")
    line("Worst Trade",
         f"#{worst_trade['id']} {worst_trade['symbol']}  {_float(worst_trade['r_multiple']):+.2f}R  "
         f"${_float(worst_trade['pnl_usdt']):+,.2f}")

    # ── By source ─────────────────────────────────────────────────────────────
    sources = sorted({r["source"] for r in closed})
    if len(sources) > 1:
        line()
        line("BY SOURCE")
        line()
        for src in sources:
            src_rows = [r for r in closed if r["source"] == src]
            src_r = [_float(r["r_multiple"]) for r in src_rows]
            src_wr = sum(1 for x in src_r if x > 0) / len(src_r) * 100
            src_exp = sum(src_r) / len(src_r)
            src_pnl = sum(_float(r["pnl_usdt"]) for r in src_rows)
            line(f"  {src:<12}",
                 f"{len(src_rows):>3} trades  |  {src_wr:>5.1f}% WR  |  "
                 f"{src_exp:+.2f}R avg  |  ${src_pnl:+,.0f}")

    # ── By regime ─────────────────────────────────────────────────────────────
    regimes = sorted({r["regime"] for r in closed if r["regime"]})
    if len(regimes) > 1:
        line()
        line("BY REGIME")
        line()
        for rg in regimes:
            rg_rows = [r for r in closed if r["regime"] == rg]
            rg_r = [_float(r["r_multiple"]) for r in rg_rows]
            rg_wr = sum(1 for x in rg_r if x > 0) / len(rg_r) * 100
            rg_exp = sum(rg_r) / len(rg_r)
            rg_pnl = sum(_float(r["pnl_usdt"]) for r in rg_rows)
            line(f"  {rg:<12}",
                 f"{len(rg_rows):>3} trades  |  {rg_wr:>5.1f}% WR  |  "
                 f"{rg_exp:+.2f}R avg  |  ${rg_pnl:+,.0f}")

    # ── By exit reason ──────────────────────────────────────────────────────────
    reasons = sorted({r["exit_reason"] for r in closed if r["exit_reason"]})
    if reasons:
        line()
        line("BY EXIT REASON")
        line()
        for reason in reasons:
            rr_rows = [r for r in closed if r["exit_reason"] == reason]
            rr_r = [_float(r["r_multiple"]) for r in rr_rows]
            rr_wr = sum(1 for x in rr_r if x > 0) / len(rr_r) * 100
            rr_exp = sum(rr_r) / len(rr_r)
            line(f"  {reason:<12}",
                 f"{len(rr_rows):>3} trades  |  {rr_wr:>5.1f}% WR  |  {rr_exp:+.2f}R avg")

    # ── Signal hit rate ─────────────────────────────────────────────────────────
    all_signals: dict[str, list[float]] = {}
    for r in closed:
        r_mult = _float(r["r_multiple"])
        for sig in r["signals"].split(","):
            sig = sig.strip()
            if sig:
                all_signals.setdefault(sig, []).append(r_mult)

    if all_signals:
        line()
        line("SIGNALS  (≥3 appearances, sorted by avg R)")
        line()
        sig_stats = [(sig, rs) for sig, rs in all_signals.items() if len(rs) >= 3]
        sig_stats.sort(key=lambda x: sum(x[1]) / len(x[1]), reverse=True)
        for sig, rs in sig_stats[:15]:
            wr = sum(1 for x in rs if x > 0) / len(rs) * 100
            avg = sum(rs) / len(rs)
            line(f"  {sig:<26}",
                 f"{len(rs):>3}x  |  {wr:>5.1f}% WR  |  {avg:+.2f}R avg")

    # ── Equity curve (ASCII sparkline) ──────────────────────────────────────────
    if len(eq_curve) >= 2:
        line()
        line("EQUITY CURVE")
        line()
        _print_sparkline(eq_curve, width=width - 6)

    # ── Open positions summary ──────────────────────────────────────────────────
    if open_trades:
        line()
        line("OPEN POSITIONS")
        line()
        heat = sum(_float(r["risk_usdt"]) for r in open_trades)
        heat_pct = heat / current_equity * 100 if current_equity else 0.0
        line(f"  {len(open_trades)} open",
             f"total risk ${heat:,.2f}  ({heat_pct:.1f}% heat)")
        for r in open_trades:
            line(f"  #{r['id']} {r['symbol']:<8}",
                 f"{r['source']}  entry {r['entry_price']}  "
                 f"risk ${_float(r['risk_usdt']):,.0f}")

    # ── Recent trades ────────────────────────────────────────────────────────────
    line()
    line("RECENT CLOSED TRADES")
    line()
    for r in closed[-8:]:
        r_raw = _float(r["r_multiple"])
        pnl_raw = _float(r["pnl_usdt"])
        r_str = f"{r_raw:+.2f}R"
        pnl_str = f"${pnl_raw:+,.0f}"
        print(f"  #{r['id']:<4} {r['symbol']:<8} {r['source']:<10} "
              f"{r['date_opened'][:10]}  {r_str:>7}  {pnl_str:>9}  [{r['exit_reason']}]")

    print()


def _print_sparkline(values: list[float], width: int = 55) -> None:
    """Render an ASCII sparkline of the equity curve, downsampled to `width`."""
    bars = "▁▂▃▄▅▆▇█"
    lo, hi = min(values), max(values)
    rng = hi - lo or 1.0

    # Downsample to the target width.
    step = max(1, len(values) // width)
    sampled = values[::step][-width:]

    line_chars = []
    for v in sampled:
        idx = int((v - lo) / rng * (len(bars) - 1))
        line_chars.append(bars[idx])

    print(f"  ${lo:,.0f} {''.join(line_chars)} ${hi:,.0f}")
    print(f"  {' ' * (len(sampled) // 2)}^")


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    """Construct the argparse CLI for the trade journal."""
    parser = argparse.ArgumentParser(
        prog="trade_journal",
        description="Trade journal with performance analytics",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # ── log ──────────────────────────────────────────────────────────────────
    p_log = sub.add_parser("log", help="Log a new trade")
    p_log.add_argument("--symbol", required=True, help="Instrument symbol, e.g. SUI")
    # Note: `source` is free-text (was a fixed scanner enum in the origin
    # codebase). Kept open so the component works for any strategy/signal source.
    p_log.add_argument("--source", required=True, help="Signal source / strategy name")
    p_log.add_argument("--entry", type=float, required=True, help="Entry price")
    p_log.add_argument("--stop", type=float, required=True, help="Stop-loss price")
    p_log.add_argument("--tp1", type=float, help="Take-profit 1 price")
    p_log.add_argument("--tp2", type=float, help="Take-profit 2 price")
    p_log.add_argument("--tp3", type=float, help="Take-profit 3 price")
    p_log.add_argument("--pos", type=float, help="Position value in quote currency")
    p_log.add_argument("--risk", type=float, help="Risk amount (auto-derived if omitted)")
    p_log.add_argument("--conviction", type=float, help="Conviction score 0-100")
    p_log.add_argument("--regime", choices=["bull", "sideways", "bear"],
                       help="Market regime at entry")
    p_log.add_argument("--signals", help="Comma-separated fired signals")
    p_log.add_argument("--notes", help="Free-text notes")

    # ── close ────────────────────────────────────────────────────────────────
    p_close = sub.add_parser("close", help="Close an open trade")
    p_close.add_argument("--id", type=int, required=True, help="Trade ID to close")
    p_close.add_argument("--exit", type=float, required=True, help="Exit price")
    p_close.add_argument("--reason", required=True,
                         choices=["tp1", "tp2", "tp3", "stop", "manual"],
                         help="Exit reason")
    p_close.add_argument("--notes", help="Optional notes on close")

    # ── list ─────────────────────────────────────────────────────────────────
    p_list = sub.add_parser("list", help="List trades")
    grp = p_list.add_mutually_exclusive_group()
    grp.add_argument("--open", action="store_true", help="Show only open trades")
    grp.add_argument("--closed", action="store_true", help="Show only closed trades")

    # ── stats ────────────────────────────────────────────────────────────────
    p_stats = sub.add_parser("stats", help="Performance analytics")
    p_stats.add_argument("--source", help="Filter by signal source")
    p_stats.add_argument("--regime", help="Filter by regime (bull/sideways/bear)")

    # ── delete ───────────────────────────────────────────────────────────────
    p_del = sub.add_parser("delete", help="Delete a trade (irreversible)")
    p_del.add_argument("--id", type=int, required=True)
    p_del.add_argument("--confirm", action="store_true")

    return parser


def main(argv: list[str] | None = None) -> None:
    """CLI entry point."""
    args = build_parser().parse_args(argv)

    dispatch = {
        "log": cmd_log,
        "close": cmd_close,
        "list": cmd_list,
        "stats": cmd_stats,
        "delete": cmd_delete,
    }
    dispatch[args.command](args)


if __name__ == "__main__":
    main()
