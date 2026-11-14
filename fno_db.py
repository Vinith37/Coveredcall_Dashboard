"""
Structured SQLite Storage Layer for NSE F&O Data Fetching Module.

Tables:
  - fno_universe:        Dynamically discovered NSE F&O eligible equity stocks
  - historical_candles:  30-month historical OHLCV + indicators (deduplicated by symbol + timestamp)
  - scheduled_snapshots: Immutable time-stamped snapshots (10AM, 1PM, 3PM, MANUAL)
  - fetch_logs:          Audit log of every fetch operation & errors
"""

import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional

from config import BASE_DIR

FNO_DB_FILE = BASE_DIR / "fno_market_data.db"

DEFAULT_SCHEDULE_SLOTS = [
    {"slot": "10AM", "label": "Morning", "hour": 10, "minute": 0, "enabled": True},
    {"slot": "1PM", "label": "Afternoon", "hour": 13, "minute": 0, "enabled": True},
    {"slot": "3PM", "label": "Evening", "hour": 15, "minute": 0, "enabled": True},
]


class FnoDatabase:
    def __init__(self, db_path: Path = FNO_DB_FILE):
        self.db_path = db_path
        self._lock = threading.RLock()
        self._init_schema()
        self.mark_stale_running_logs()

    @contextmanager
    def _connect(self) -> Generator[sqlite3.Connection, None, None]:
        with self._lock:
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
                    sma50 REAL,
                    sma200 REAL,
                    trend TEXT,
                    rs_value REAL,
                    rs_rating INTEGER,
                    rs_signal TEXT,
                    vol20 INTEGER,
                    rvol REAL,
                    breakout_50d TEXT,
                    accumulation TEXT,
                    momentum_score INTEGER,
                    rsi14 REAL,
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
                    sma50 REAL,
                    sma200 REAL,
                    trend TEXT,
                    rs_value REAL,
                    rs_rating INTEGER,
                    rs_signal TEXT,
                    vol20 INTEGER,
                    rvol REAL,
                    breakout_50d TEXT,
                    accumulation TEXT,
                    momentum_score INTEGER,
                    rsi14 REAL,
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

                CREATE TABLE IF NOT EXISTS schedule_slots (
                    slot TEXT PRIMARY KEY,
                    label TEXT NOT NULL,
                    hour INTEGER NOT NULL,
                    minute INTEGER NOT NULL,
                    enabled INTEGER DEFAULT 1,
                    sort_order INTEGER DEFAULT 0
                );
                """
            )
            existing_slots = conn.execute("SELECT COUNT(*) FROM schedule_slots").fetchone()[0]
            if existing_slots == 0:
                conn.executemany(
                    """
                    INSERT INTO schedule_slots (slot, label, hour, minute, enabled, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    [
                        (s["slot"], s["label"], s["hour"], s["minute"], 1 if s["enabled"] else 0, idx)
                        for idx, s in enumerate(DEFAULT_SCHEDULE_SLOTS)
                    ],
                )
            extra_cols = [
                ("sma50", "REAL"),
                ("sma200", "REAL"),
                ("trend", "TEXT"),
                ("rs_value", "REAL"),
                ("rs_rating", "INTEGER"),
                ("rs_signal", "TEXT"),
                ("vol20", "INTEGER"),
                ("breakout_50d", "TEXT"),
                ("accumulation", "TEXT"),
                ("momentum_score", "INTEGER"),
            ]
            for tbl in ("historical_candles", "scheduled_snapshots"):
                existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({tbl})").fetchall()}
                for col_name, col_type in extra_cols:
                    if col_name not in existing:
                        conn.execute(f"ALTER TABLE {tbl} ADD COLUMN {col_name} {col_type};")

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

    def get_first_candle_date(self, symbol: str) -> Optional[str]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT MIN(date) AS min_date FROM historical_candles WHERE symbol = ?",
                (symbol,),
            ).fetchone()
        return row["min_date"] if row and row["min_date"] else None

    _METRIC_COLS = (
        "sma20, sma50, sma200, trend, rs_value, rs_rating, rs_signal, "
        "vol20, rvol, breakout_50d, accumulation, momentum_score, rsi14, volatility, extra_indicators"
    )

    def get_symbol_candles(self, symbol: str, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        query = f"""
            SELECT symbol, timestamp, date, open, high, low, close, volume, {self._METRIC_COLS}
            FROM historical_candles
            WHERE symbol = ?
            ORDER BY timestamp ASC
        """
        if limit:
            query = f"""
                SELECT * FROM (
                    SELECT symbol, timestamp, date, open, high, low, close, volume, {self._METRIC_COLS}
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
                f"""
                INSERT INTO historical_candles (
                    symbol, timestamp, date, open, high, low, close, volume,
                    {self._METRIC_COLS}, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(symbol, timestamp) DO UPDATE SET
                    open = excluded.open,
                    high = excluded.high,
                    low = excluded.low,
                    close = excluded.close,
                    volume = excluded.volume,
                    sma20 = excluded.sma20,
                    sma50 = excluded.sma50,
                    sma200 = excluded.sma200,
                    trend = excluded.trend,
                    rs_value = excluded.rs_value,
                    rs_rating = COALESCE(excluded.rs_rating, historical_candles.rs_rating),
                    rs_signal = excluded.rs_signal,
                    vol20 = excluded.vol20,
                    rvol = excluded.rvol,
                    breakout_50d = excluded.breakout_50d,
                    accumulation = excluded.accumulation,
                    momentum_score = excluded.momentum_score,
                    rsi14 = excluded.rsi14,
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
                        r.get("sma50"),
                        r.get("sma200"),
                        r.get("trend"),
                        r.get("rs_value"),
                        r.get("rs_rating"),
                        r.get("rs_signal"),
                        r.get("vol20"),
                        r.get("rvol"),
                        r.get("breakout_50d"),
                        r.get("accumulation"),
                        r.get("momentum_score"),
                        r.get("rsi14"),
                        r.get("volatility"),
                        r.get("extra_indicators"),
                        updated_at,
                    )
                    for r in rows
                ],
            )
        return len(rows)

    def recompute_historical_rs_ratings(self) -> None:
        """Computes cross-sectional RS Rating (1..100) per date across all historical candles."""
        with self._connect() as conn:
            conn.execute(
                """
                WITH ranked AS (
                    SELECT symbol, timestamp,
                           ROUND(
                             (CAST(ROW_NUMBER() OVER (PARTITION BY date ORDER BY rs_value ASC) AS REAL)
                              / NULLIF(COUNT(*) OVER (PARTITION BY date), 0)) * 99 + 1
                           ) AS calc_rating
                    FROM historical_candles
                    WHERE rs_value IS NOT NULL
                )
                UPDATE historical_candles
                SET rs_rating = (
                    SELECT calc_rating FROM ranked
                    WHERE ranked.symbol = historical_candles.symbol
                      AND ranked.timestamp = historical_candles.timestamp
                )
                WHERE rs_value IS NOT NULL;
                """
            )

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
                    f"""
                    SELECT symbol, timestamp, date, open, high, low, close, volume, {self._METRIC_COLS}
                    FROM historical_candles
                    WHERE symbol = ?
                    ORDER BY timestamp ASC
                    """,
                    (symbol.upper(),),
                ).fetchall()
            else:
                rows = conn.execute(
                    f"""
                    SELECT symbol, timestamp, date, open, high, low, close, volume, {self._METRIC_COLS}
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
                f"""
                INSERT INTO scheduled_snapshots (
                    snapshot_date, slot, symbol, timestamp,
                    open, high, low, close, volume,
                    {self._METRIC_COLS}, fetched_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(snapshot_date, slot, symbol) DO UPDATE SET
                    timestamp = excluded.timestamp,
                    open = excluded.open,
                    high = excluded.high,
                    low = excluded.low,
                    close = excluded.close,
                    volume = excluded.volume,
                    sma20 = excluded.sma20,
                    sma50 = excluded.sma50,
                    sma200 = excluded.sma200,
                    trend = excluded.trend,
                    rs_value = excluded.rs_value,
                    rs_rating = excluded.rs_rating,
                    rs_signal = excluded.rs_signal,
                    vol20 = excluded.vol20,
                    rvol = excluded.rvol,
                    breakout_50d = excluded.breakout_50d,
                    accumulation = excluded.accumulation,
                    momentum_score = excluded.momentum_score,
                    rsi14 = excluded.rsi14,
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
                        r.get("sma50"),
                        r.get("sma200"),
                        r.get("trend"),
                        r.get("rs_value"),
                        r.get("rs_rating"),
                        r.get("rs_signal"),
                        r.get("vol20"),
                        r.get("rvol"),
                        r.get("breakout_50d"),
                        r.get("accumulation"),
                        r.get("momentum_score"),
                        r.get("rsi14"),
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

    def get_symbol_snapshots(self, symbol: str) -> List[Dict[str, Any]]:
        snap_select = f"snapshot_date, slot, symbol, timestamp, open, high, low, close, volume, {self._METRIC_COLS}, fetched_at"
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT {snap_select}
                FROM scheduled_snapshots
                WHERE symbol = ?
                ORDER BY timestamp DESC
                """,
                (symbol.upper(),),
            ).fetchall()
        return [dict(r) for r in rows]

    def get_snapshot_rows(self, snapshot_date: Optional[str] = None, slot: Optional[str] = None) -> List[Dict[str, Any]]:
        snap_select = f"snapshot_date, slot, symbol, timestamp, open, high, low, close, volume, {self._METRIC_COLS}, fetched_at"
        with self._connect() as conn:
            if slot == "ALL":
                if snapshot_date:
                    rows = conn.execute(
                        f"""
                        SELECT {snap_select}
                        FROM scheduled_snapshots
                        WHERE snapshot_date = ?
                        ORDER BY symbol ASC, timestamp DESC
                        """,
                        (snapshot_date,),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        f"""
                        SELECT {snap_select}
                        FROM scheduled_snapshots
                        ORDER BY symbol ASC, timestamp DESC
                        """
                    ).fetchall()
            elif snapshot_date and slot:
                rows = conn.execute(
                    f"""
                    SELECT {snap_select}
                    FROM scheduled_snapshots
                    WHERE snapshot_date = ? AND slot = ?
                    ORDER BY symbol ASC
                    """,
                    (snapshot_date, slot),
                ).fetchall()
            elif slot:
                latest = conn.execute(
                    "SELECT MAX(snapshot_date) AS d FROM scheduled_snapshots WHERE slot = ?",
                    (slot,),
                ).fetchone()
                if not latest or not latest["d"]:
                    return []
                rows = conn.execute(
                    f"""
                    SELECT {snap_select}
                    FROM scheduled_snapshots
                    WHERE snapshot_date = ? AND slot = ?
                    ORDER BY symbol ASC
                    """,
                    (latest["d"], slot),
                ).fetchall()
            else:
                latest = conn.execute(
                    "SELECT snapshot_date, slot FROM scheduled_snapshots ORDER BY fetched_at DESC LIMIT 1"
                ).fetchone()
                if latest:
                    rows = conn.execute(
                        f"""
                        SELECT {snap_select}
                        FROM scheduled_snapshots
                        WHERE snapshot_date = ? AND slot = ?
                        ORDER BY symbol ASC
                        """,
                        (latest["snapshot_date"], latest["slot"]),
                    ).fetchall()
                else:
                    h_cols = ", ".join(f"h.{c.strip()}" for c in self._METRIC_COLS.split(","))
                    rows = conn.execute(
                        f"""
                        SELECT h.date AS snapshot_date, 'HIST' AS slot, h.symbol, h.timestamp,
                               h.open, h.high, h.low, h.close, h.volume,
                               {h_cols}, h.updated_at AS fetched_at
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

    def mark_stale_running_logs(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE fetch_logs
                SET status = 'INTERRUPTED',
                    finished_at = started_at,
                    message = COALESCE(message, '') || ' (Interrupted by server reload)'
                WHERE status = 'RUNNING'
                """
            )

    # ── Configurable Schedule Slots ───────────────────────────────────────
    def get_schedule_slots(self) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT slot, label, hour, minute, enabled
                FROM schedule_slots
                ORDER BY hour ASC, minute ASC, sort_order ASC
                """
            ).fetchall()
        return [
            {
                "slot": r["slot"],
                "label": r["label"],
                "hour": int(r["hour"]),
                "minute": int(r["minute"]),
                "enabled": bool(r["enabled"]),
            }
            for r in rows
        ]

    def save_schedule_slots(self, slots: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            conn.execute("DELETE FROM schedule_slots;")
            conn.executemany(
                """
                INSERT INTO schedule_slots (slot, label, hour, minute, enabled, sort_order)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        str(s["slot"]).strip().upper(),
                        str(s.get("label") or s["slot"]).strip(),
                        int(s["hour"]),
                        int(s["minute"]),
                        1 if s.get("enabled", True) else 0,
                        idx,
                    )
                    for idx, s in enumerate(slots)
                ],
            )
        return self.get_schedule_slots()


fno_db = FnoDatabase()

