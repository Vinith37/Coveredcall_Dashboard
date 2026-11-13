"""
Structured SQLite Storage Layer for NSE F&O Data Fetching Module.

Tables:
  - fno_universe:        Dynamically discovered NSE F&O eligible equity stocks
  - historical_candles:  30-month historical OHLCV + indicators (deduplicated by symbol + timestamp)
  - scheduled_snapshots: Immutable time-stamped snapshots (10AM, 1PM, 3PM, MANUAL)
  - fetch_logs:          Audit log of every fetch operation & errors
"""

import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional

from config import BASE_DIR

FNO_DB_FILE = BASE_DIR / "fno_market_data.db"


class FnoDatabase:
    def __init__(self, db_path: Path = FNO_DB_FILE):
        self.db_path = db_path
        self._init_schema()

    @contextmanager
    def _connect(self) -> Generator[sqlite3.Connection, None, None]:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS fno_universe (
                    symbol TEXT PRIMARY KEY,
                    name TEXT,
                    instrument_token INTEGER NOT NULL,
                    exchange TEXT DEFAULT 'NSE',
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS historical_candles (
                    symbol TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    date TEXT NOT NULL,
                    open REAL NOT NULL,
                    high REAL NOT NULL,
                    low REAL NOT NULL,
                    close REAL NOT NULL,
                    volume INTEGER NOT NULL,
                    sma20 REAL,
                    rsi14 REAL,
                    rvol REAL,
                    volatility REAL,
                    extra_indicators TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (symbol, timestamp)
                );

                CREATE INDEX IF NOT EXISTS idx_hist_symbol_date
                    ON historical_candles (symbol, date DESC);
                CREATE INDEX IF NOT EXISTS idx_hist_date
                    ON historical_candles (date DESC);

                CREATE TABLE IF NOT EXISTS scheduled_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    snapshot_date TEXT NOT NULL,
                    slot TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    open REAL NOT NULL,
                    high REAL NOT NULL,
                    low REAL NOT NULL,
                    close REAL NOT NULL,
                    volume INTEGER NOT NULL,
                    sma20 REAL,
                    rsi14 REAL,
                    rvol REAL,
                    volatility REAL,
                    extra_indicators TEXT,
                    fetched_at TEXT NOT NULL,
                    UNIQUE (snapshot_date, slot, symbol)
                );

                CREATE INDEX IF NOT EXISTS idx_snap_date_slot
                    ON scheduled_snapshots (snapshot_date DESC, slot);

                CREATE TABLE IF NOT EXISTS fetch_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    slot TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    total_stocks INTEGER DEFAULT 0,
                    success_count INTEGER DEFAULT 0,
                    failed_count INTEGER DEFAULT 0,
                    status TEXT NOT NULL,
                    message TEXT,
                    error_details TEXT
                );
                """
            )

    # ── F&O Universe ──────────────────────────────────────────────────────
    def replace_universe(self, stocks: List[Dict[str, Any]], updated_at: str) -> int:
        with self._connect() as conn:
            conn.execute("DELETE FROM fno_universe;")
            conn.executemany(
                """
                INSERT INTO fno_universe (symbol, name, instrument_token, exchange, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                [
                    (
                        s["symbol"],
                        s.get("name", s["symbol"]),
                        int(s["instrument_token"]),
                        s.get("exchange", "NSE"),
                        updated_at,
                    )
                    for s in stocks
                ],
            )
        return len(stocks)

    def get_universe(self) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT symbol, name, instrument_token, exchange, updated_at FROM fno_universe ORDER BY symbol ASC"
            ).fetchall()
        return [dict(r) for r in rows]

    def get_universe_stats(self) -> Dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS cnt, MAX(updated_at) AS last_updated FROM fno_universe"
            ).fetchone()
        return {
            "total_stocks": row["cnt"] if row else 0,
            "last_updated": row["last_updated"] if row else None,
        }

    # ── Historical Candles (30 Months, Incremental, Deduplicated) ─────────
    def get_last_candle_date(self, symbol: str) -> Optional[str]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT MAX(date) AS max_date FROM historical_candles WHERE symbol = ?",
                (symbol,),
            ).fetchone()
        return row["max_date"] if row and row["max_date"] else None

    def get_symbol_candles(self, symbol: str, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        query = """
            SELECT symbol, timestamp, date, open, high, low, close, volume,
                   sma20, rsi14, rvol, volatility, extra_indicators
            FROM historical_candles
            WHERE symbol = ?
            ORDER BY timestamp ASC
        """
        if limit:
            query = f"""
                SELECT * FROM (
                    SELECT symbol, timestamp, date, open, high, low, close, volume,
                           sma20, rsi14, rvol, volatility, extra_indicators
                    FROM historical_candles
                    WHERE symbol = ?
                    ORDER BY timestamp DESC
                    LIMIT {int(limit)}
                ) ORDER BY timestamp ASC
            """
        with self._connect() as conn:
            rows = conn.execute(query, (symbol,)).fetchall()
        return [dict(r) for r in rows]

    def upsert_historical_candles(self, symbol: str, rows: List[Dict[str, Any]], updated_at: str) -> int:
        if not rows:
            return 0
        with self._connect() as conn:
            conn.executemany(
                """
                INSERT INTO historical_candles (
                    symbol, timestamp, date, open, high, low, close, volume,
                    sma20, rsi14, rvol, volatility, extra_indicators, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(symbol, timestamp) DO UPDATE SET
                    open = excluded.open,
                    high = excluded.high,
                    low = excluded.low,
                    close = excluded.close,
                    volume = excluded.volume,
                    sma20 = excluded.sma20,
                    rsi14 = excluded.rsi14,
                    rvol = excluded.rvol,
                    volatility = excluded.volatility,
                    extra_indicators = excluded.extra_indicators,
                    updated_at = excluded.updated_at
                """,
                [
                    (
                        symbol,
                        r["timestamp"],
                        r["date"],
                        r["open"],
                        r["high"],
                        r["low"],
                        r["close"],
                        r["volume"],
                        r.get("sma20"),
                        r.get("rsi14"),
                        r.get("rvol"),
                        r.get("volatility"),
                        r.get("extra_indicators"),
                        updated_at,
                    )
                    for r in rows
                ],
            )
        return len(rows)

    def prune_older_than(self, cutoff_date: str) -> int:
        """Keeps historical dataset bounded to the latest 30 months."""
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM historical_candles WHERE date < ?", (cutoff_date,))
            return cur.rowcount

    def get_historical_stats(self) -> Dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT MIN(date) AS start_date,
                       MAX(date) AS end_date,
                       COUNT(*) AS total_records,
                       COUNT(DISTINCT symbol) AS symbols_with_history
                FROM historical_candles
                """
            ).fetchone()
        return {
            "start_date": row["start_date"] if row else None,
            "end_date": row["end_date"] if row else None,
            "total_records": row["total_records"] if row else 0,
            "symbols_with_history": row["symbols_with_history"] if row else 0,
        }

    def get_all_historical_candles(self, symbol: Optional[str] = None) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            if symbol:
                rows = conn.execute(
                    """
                    SELECT symbol, timestamp, date, open, high, low, close, volume,
                           sma20, rsi14, rvol, volatility, extra_indicators
                    FROM historical_candles
                    WHERE symbol = ?
                    ORDER BY timestamp ASC
                    """,
                    (symbol.upper(),),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT symbol, timestamp, date, open, high, low, close, volume,
                           sma20, rsi14, rvol, volatility, extra_indicators
                    FROM historical_candles
                    ORDER BY symbol ASC, timestamp ASC
                    """
                ).fetchall()
        return [dict(r) for r in rows]

    # ── Scheduled Snapshots (10AM, 1PM, 3PM, MANUAL) ──────────────────────
    def upsert_snapshots(self, rows: List[Dict[str, Any]]) -> int:
        if not rows:
            return 0
        with self._connect() as conn:
            conn.executemany(
                """
                INSERT INTO scheduled_snapshots (
                    snapshot_date, slot, symbol, timestamp,
                    open, high, low, close, volume,
                    sma20, rsi14, rvol, volatility, extra_indicators, fetched_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(snapshot_date, slot, symbol) DO UPDATE SET
                    timestamp = excluded.timestamp,
                    open = excluded.open,
                    high = excluded.high,
                    low = excluded.low,
                    close = excluded.close,
                    volume = excluded.volume,
                    sma20 = excluded.sma20,
                    rsi14 = excluded.rsi14,
                    rvol = excluded.rvol,
                    volatility = excluded.volatility,
                    extra_indicators = excluded.extra_indicators,
                    fetched_at = excluded.fetched_at
                """,
                [
                    (
                        r["snapshot_date"],
                        r["slot"],
                        r["symbol"],
                        r["timestamp"],
                        r["open"],
                        r["high"],
                        r["low"],
                        r["close"],
                        r["volume"],
                        r.get("sma20"),
                        r.get("rsi14"),
                        r.get("rvol"),
                        r.get("volatility"),
                        r.get("extra_indicators"),
                        r["fetched_at"],
                    )
                    for r in rows
                ],
            )
        return len(rows)

    def has_snapshot_for_slot(self, snapshot_date: str, slot: str) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM scheduled_snapshots WHERE snapshot_date = ? AND slot = ? LIMIT 1",
                (snapshot_date, slot),
            ).fetchone()
        return row is not None

    def get_available_snapshots(self) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT snapshot_date, slot, COUNT(*) AS stock_count, MAX(fetched_at) AS fetched_at
                FROM scheduled_snapshots
                GROUP BY snapshot_date, slot
                ORDER BY snapshot_date DESC,
                         CASE slot WHEN '3PM' THEN 1 WHEN '1PM' THEN 2 WHEN '10AM' THEN 3 ELSE 4 END ASC
                LIMIT 60
                """
            ).fetchall()
        return [dict(r) for r in rows]

    def get_snapshot_rows(self, snapshot_date: Optional[str] = None, slot: Optional[str] = None) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            if snapshot_date and slot:
                rows = conn.execute(
                    """
                    SELECT snapshot_date, slot, symbol, timestamp, open, high, low, close, volume,
                           sma20, rsi14, rvol, volatility, extra_indicators, fetched_at
                    FROM scheduled_snapshots
                    WHERE snapshot_date = ? AND slot = ?
                    ORDER BY symbol ASC
                    """,
                    (snapshot_date, slot),
                ).fetchall()
            elif slot:
                # Latest date for that slot
                latest = conn.execute(
                    "SELECT MAX(snapshot_date) AS d FROM scheduled_snapshots WHERE slot = ?",
                    (slot,),
                ).fetchone()
                if not latest or not latest["d"]:
                    return []
                rows = conn.execute(
                    """
                    SELECT snapshot_date, slot, symbol, timestamp, open, high, low, close, volume,
                           sma20, rsi14, rvol, volatility, extra_indicators, fetched_at
                    FROM scheduled_snapshots
                    WHERE snapshot_date = ? AND slot = ?
                    ORDER BY symbol ASC
                    """,
                    (latest["d"], slot),
                ).fetchall()
            else:
                # Latest snapshot across any slot, or latest daily candles if no snapshot yet
                latest = conn.execute(
                    "SELECT snapshot_date, slot FROM scheduled_snapshots ORDER BY fetched_at DESC LIMIT 1"
                ).fetchone()
                if latest:
                    rows = conn.execute(
                        """
                        SELECT snapshot_date, slot, symbol, timestamp, open, high, low, close, volume,
                               sma20, rsi14, rvol, volatility, extra_indicators, fetched_at
                        FROM scheduled_snapshots
                        WHERE snapshot_date = ? AND slot = ?
                        ORDER BY symbol ASC
                        """,
                        (latest["snapshot_date"], latest["slot"]),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        """
                        SELECT h.date AS snapshot_date, 'HIST' AS slot, h.symbol, h.timestamp,
                               h.open, h.high, h.low, h.close, h.volume,
                               h.sma20, h.rsi14, h.rvol, h.volatility, h.extra_indicators, h.updated_at AS fetched_at
                        FROM historical_candles h
                        INNER JOIN (
                            SELECT symbol, MAX(timestamp) AS max_ts FROM historical_candles GROUP BY symbol
                        ) m ON h.symbol = m.symbol AND h.timestamp = m.max_ts
                        ORDER BY h.symbol ASC
                        """
                    ).fetchall()
        return [dict(r) for r in rows]

    # ── Fetch Audit Logs ──────────────────────────────────────────────────
    def insert_log(
        self,
        job_id: str,
        started_at: str,
        slot: str,
        mode: str,
        total_stocks: int = 0,
        status: str = "RUNNING",
        message: str = "",
    ) -> int:
        with self._connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO fetch_logs (job_id, started_at, slot, mode, total_stocks, status, message)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (job_id, started_at, slot, mode, total_stocks, status, message),
            )
            return int(cur.lastrowid)

    def update_log(
        self,
        log_id: int,
        finished_at: str,
        total_stocks: int,
        success_count: int,
        failed_count: int,
        status: str,
        message: str,
        error_details: Optional[str] = None,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE fetch_logs
                SET finished_at = ?, total_stocks = ?, success_count = ?, failed_count = ?,
                    status = ?, message = ?, error_details = ?
                WHERE id = ?
                """,
                (finished_at, total_stocks, success_count, failed_count, status, message, error_details, log_id),
            )

    def get_logs(self, limit: int = 25) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM fetch_logs ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]


fno_db = FnoDatabase()
