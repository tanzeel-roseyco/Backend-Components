# CSV trade journal

This command-line component records trades in a CSV file, closes and deletes entries, lists open or closed positions, and calculates performance summaries. Reported measures include realised profit and loss, R multiples, win rate, expectancy, profit factor, drawdown, and breakdowns by strategy metadata.

`TRADE_JOURNAL_FILE` selects the CSV path; otherwise the file is created under `outputs/journal` in the current directory. `TRADE_JOURNAL_ACCOUNT_START` sets the equity-curve starting value and defaults to 10,000. The CLI exposes `log`, `close`, `list`, `stats`, and confirmed `delete` commands.

Writes replace the CSV file and are not protected by a file lock, so concurrent writers can lose updates. Free-text fields are neutralised against common spreadsheet-formula prefixes before storage. The analytics are derived from recorded values and do not reconcile against an exchange or broker.

The component uses only the standard library. No automated test file is included.
