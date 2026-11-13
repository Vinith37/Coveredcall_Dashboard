"""
Automated NSE F&O Data Fetching Engine & Scheduler (Zerodha Kite Connect).

Responsibilities:
  1. Dynamic NSE F&O universe discovery via Kite Connect `instruments("NFO")` & `instruments("NSE")`.
  2. Incremental & full 30-month historical OHLCV fetching with rate-limit pacing & retries.
  3. Technical indicator calculation (20 SMA, 14 RSI, RVOL, 20D Volatility, extensible extras).
  4. Scheduled intraday snapshots at 10:00 AM, 1:00 PM, and 3:00 PM IST (Asia/Kolkata),
     respecting weekends & NSE trading holidays, running in background even if UI is closed.
"""

import json
import threading
import time
import uuid
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

import requests
from kiteconnect.exceptions import DataException, NetworkException, TokenException

from fno_db import fno_db
from fno_indicators import calculate_indicators_df
from kite_service import kite_service

IST = ZoneInfo("Asia/Kolkata")

# Index underlyings in NFO that are not individual equity F&O stocks
INDEX_UNDERLYINGS = {
    "NIFTY",
    "BANKNIFTY",
    "FINNIFTY",
    "MIDCPNIFTY",
    "NIFTYNXT50",
    "INDIAVIX",
}

# Official NSE Equity / F&O Trading Holidays (YYYY-MM-DD in IST)
NSE_HOLIDAYS = {
    # 2025
    "2025-02-26", "2025-03-14", "2025-03-31", "2025-04-10", "2025-04-14",
    "2025-04-18", "2025-05-01", "2025-08-15", "2025-08-27", "2025-10-02",
    "2025-10-21", "2025-10-22", "2025-11-05", "2025-12-25",
    # 2026
    "2026-01-26", "2026-03-03", "2026-03-26", "2026-03-31", "2026-04-03",
    "2026-04-14", "2026-05-01", "2026-05-28", "2026-06-26", "2026-09-14",
    "2026-10-02", "2026-10-20", "2026-11-10", "2026-11-24", "2026-12-25",
}

SCHEDULE_SLOTS = [
    ("10AM", 10, 0, "Morning (10:00 AM IST)"),
    ("1PM", 13, 0, "Afternoon (1:00 PM IST)"),
    ("3PM", 15, 0, "Evening (3:00 PM IST)"),
]

HISTORICAL_MONTHS = 30
HISTORICAL_DAYS = 915  # ~30 months
HIST_RATE_LIMIT_DELAY = 0.36  # ~2.7 req/sec (Kite historical API limit is 3 req/sec)


def now_ist() -> datetime:
    return datetime.now(IST)


def is_nse_trading_day(d: date) -> bool:
    if d.weekday() >= 5:  # Saturday=5, Sunday=6
        return False
    if d.strftime("%Y-%m-%d") in NSE_HOLIDAYS:
        return False
    return True


def get_next_scheduled_run(ref_dt: Optional[datetime] = None) -> Dict[str, Any]:
    """Computes the next upcoming scheduled fetch in Asia/Kolkata timezone."""
    dt = ref_dt or now_ist()
    for day_offset in range(0, 14):
        candidate_date = (dt + timedelta(days=day_offset)).date()
        if not is_nse_trading_day(candidate_date):
            continue
        for slot_code, hour, minute, label in SCHEDULE_SLOTS:
            slot_dt = datetime(
                candidate_date.year, candidate_date.month, candidate_date.day,
                hour, minute, 0, tzinfo=IST
            )
            if slot_dt > dt:
                return {
                    "slot": slot_code,
                    "label": label,
                    "scheduled_at": slot_dt.strftime("%Y-%m-%d %H:%M:%S IST"),
                    "seconds_remaining": int((slot_dt - dt).total_seconds()),
                }
    return {"slot": "10AM", "label": "Morning (10:00 AM IST)", "scheduled_at": None, "seconds_remaining": None}


class FnoDataFetcher:
    def __init__(self):
        self._lock = threading.Lock()
        self._scheduler_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

        self.last_successful_api_conn: Optional[str] = None
        self.progress: Dict[str, Any] = {
            "is_running": False,
            "job_id": None,
            "mode": None,
            "slot": None,
            "total": 0,
            "processed": 0,
            "progress_pct": 0.0,
            "current_symbol": None,
            "success_count": 0,
            "failed_count": 0,
            "errors": [],
            "started_at": None,
            "finished_at": None,
            "last_message": "Idle",
        }

    def _require_kite(self):
        """Returns active KiteConnect client or raises an actionable error."""
        if not kite_service.kite or not kite_service.access_token:
            raise RuntimeError("Zerodha Kite Connect is not authenticated. Please connect via Kite Connect first.")
        return kite_service.kite

    def _call_with_retry(self, fn, retries: int = 3, base_delay: float = 0.8):
        """Retries transient network, timeout, or Kite rate-limit errors."""
        last_exc = None
        for attempt in range(retries + 1):
            try:
                result = fn()
                self.last_successful_api_conn = now_ist().strftime("%Y-%m-%d %H:%M:%S IST")
                return result
            except TokenException:
                raise
            except (NetworkException, DataException, requests.exceptions.RequestException, Exception) as exc:
                last_exc = exc
                msg = str(exc).lower()
                is_rate_or_net = (
                    "too many requests" in msg
                    or "429" in msg
                    or "timeout" in msg
                    or "connection" in msg
                    or isinstance(exc, (NetworkException, requests.exceptions.RequestException))
                )
                if attempt < retries and is_rate_or_net:
                    time.sleep(base_delay * (2 ** attempt))
                    continue
                raise
        raise last_exc

    # ── Dynamic F&O Universe Discovery ────────────────────────────────────
    def refresh_universe(self) -> List[Dict[str, Any]]:
        """
        Dynamically discovers all eligible NSE F&O equity stocks from Kite Connect:
          1. Fetches NFO instruments -> extracts unique equity F&O underlying names.
          2. Fetches NSE instruments -> maps each underlying to NSE EQ tradingsymbol & token.
        """
        kite = self._require_kite()
        nfo_instruments = self._call_with_retry(lambda: kite.instruments("NFO"))
        nse_instruments = self._call_with_retry(lambda: kite.instruments("NSE"))

        # Identify eligible equity F&O underlyings (exclude index derivatives)
        fno_names = set()
        for inst in nfo_instruments:
            if inst.get("segment") == "NFO-FUT":
                name = (inst.get("name") or "").strip().upper()
                if name and name not in INDEX_UNDERLYINGS:
                    fno_names.add(name)

        # Match against NSE cash equity instruments
        nse_eq_map: Dict[str, Dict[str, Any]] = {}
        for inst in nse_instruments:
            if inst.get("segment") == "NSE" and inst.get("instrument_type") == "EQ":
                sym = (inst.get("tradingsymbol") or "").strip().upper()
                if sym in fno_names:
                    nse_eq_map[sym] = {
                        "symbol": sym,
                        "name": (inst.get("name") or sym).strip(),
                        "instrument_token": int(inst["instrument_token"]),
                        "exchange": "NSE",
                    }

        universe = sorted(nse_eq_map.values(), key=lambda x: x["symbol"])
        if not universe:
            raise RuntimeError("No eligible NSE F&O stocks resolved from Kite instruments.")

        fno_db.replace_universe(universe, now_ist().strftime("%Y-%m-%d %H:%M:%S IST"))
        return universe

    def ensure_universe(self) -> List[Dict[str, Any]]:
        universe = fno_db.get_universe()
        if not universe:
            universe = self.refresh_universe()
        return universe

    # ── Historical Data Fetch (30 Months / Incremental) ───────────────────
    def _fetch_kite_daily_candles(
        self,
        kite,
        instrument_token: int,
        from_dt: datetime,
        to_dt: datetime,
    ) -> List[Dict[str, Any]]:
        """Fetches daily OHLCV candles from Kite Connect in safe chunks."""
        all_candles: List[Dict[str, Any]] = []
        chunk_start = from_dt
        max_chunk_days = 1800  # Kite allows up to 2000 days per day-candle call

        while chunk_start < to_dt:
            chunk_end = min(chunk_start + timedelta(days=max_chunk_days), to_dt)
            time.sleep(HIST_RATE_LIMIT_DELAY)
            raw = self._call_with_retry(
                lambda cs=chunk_start, ce=chunk_end: kite.historical_data(
                    instrument_token=instrument_token,
                    from_date=cs.strftime("%Y-%m-%d %H:%M:%S"),
                    to_date=ce.strftime("%Y-%m-%d %H:%M:%S"),
                    interval="day",
                )
            )
            for c in raw or []:
                ts = c["date"]
                if isinstance(ts, datetime):
                    ts_ist = ts.astimezone(IST) if ts.tzinfo else ts.replace(tzinfo=IST)
                    ts_str = ts_ist.strftime("%Y-%m-%d %H:%M:%S")
                    date_str = ts_ist.strftime("%Y-%m-%d")
                else:
                    ts_str = str(ts)[:19]
                    date_str = ts_str[:10]
                all_candles.append({
                    "timestamp": ts_str,
                    "date": date_str,
                    "open": float(c.get("open") or 0.0),
                    "high": float(c.get("high") or 0.0),
                    "low": float(c.get("low") or 0.0),
                    "close": float(c.get("close") or 0.0),
                    "volume": int(c.get("volume") or 0),
                })
            chunk_start = chunk_end + timedelta(seconds=1)

        return all_candles

    def _sync_single_stock_history(
        self,
        kite,
        stock: Dict[str, Any],
        full_refresh: bool = False,
    ) -> int:
        """
        Fetches either full 30-month history or incremental delta for one F&O stock,
        computes technical indicators with trailing context, and upserts to SQLite.
        """
        symbol = stock["symbol"]
        token = int(stock["instrument_token"])
        end_dt = now_ist()
        cutoff_dt = end_dt - timedelta(days=HISTORICAL_DAYS)

        last_date = None if full_refresh else fno_db.get_last_candle_date(symbol)
        existing_tail: List[Dict[str, Any]] = []

        if last_date and not full_refresh:
            last_dt = datetime.strptime(last_date, "%Y-%m-%d").replace(tzinfo=IST)
            # Fetch a 7-day overlap so updated/incomplete candles are cleanly refreshed
            from_dt = max(cutoff_dt, last_dt - timedelta(days=7))
            # Load trailing 60 bars from DB so 20 SMA / 14 RSI / 20D Vol have full lookback
            existing_tail = fno_db.get_symbol_candles(symbol, limit=60)
        else:
            from_dt = cutoff_dt

        fetched = self._fetch_kite_daily_candles(kite, token, from_dt, end_dt)
        if not fetched and not existing_tail:
            return 0

        # Merge existing tail + newly fetched (deduplicated by timestamp, newest wins)
        merged_map: Dict[str, Dict[str, Any]] = {}
        for row in existing_tail:
            merged_map[row["timestamp"]] = {
                "timestamp": row["timestamp"],
                "date": row["date"],
                "open": row["open"],
                "high": row["high"],
                "low": row["low"],
                "close": row["close"],
                "volume": row["volume"],
            }
        for row in fetched:
            merged_map[row["timestamp"]] = row

        enriched = calculate_indicators_df(list(merged_map.values()))
        # Only upsert rows from `from_dt` onwards when incremental (or all when full)
        min_upsert_date = from_dt.strftime("%Y-%m-%d")
        to_save = [r for r in enriched if r["date"] >= min_upsert_date] if existing_tail else enriched

        now_str = now_ist().strftime("%Y-%m-%d %H:%M:%S IST")
        return fno_db.upsert_historical_candles(symbol, to_save, now_str)

    # ── Batch Live Snapshot + Indicator Calculation ───────────────────────
    def _fetch_batch_quotes(self, kite, universe: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        """Fetches live OHLCV quotes in batches of 200 (respecting Kite limits)."""
        results: Dict[str, Dict[str, Any]] = {}
        batch_size = 200
        for i in range(0, len(universe), batch_size):
            batch = universe[i : i + batch_size]
            kite_syms = [f"NSE:{s['symbol']}" for s in batch]
            if i > 0:
                time.sleep(0.35)
            quotes = self._call_with_retry(lambda ks=kite_syms: kite.quote(ks))
            for ksym, q in (quotes or {}).items():
                sym = ksym.replace("NSE:", "").upper()
                results[sym] = q
        return results

    def _run_job(self, mode: str, slot: str) -> None:
        """
        Executes a full data-fetching job in the background:
          - mode='historical': Full 30-month historical backfill for all F&O stocks.
          - mode='incremental': Incremental historical update for all F&O stocks.
          - mode='snapshot': Captures scheduled/manual OHLCV + indicator snapshot (10AM/1PM/3PM/MANUAL),
                             also ensuring historical context is incrementally updated.
        """
        job_id = f"fno_{uuid.uuid4().hex[:8]}"
        started_at = now_ist().strftime("%Y-%m-%d %H:%M:%S IST")
        log_id = fno_db.insert_log(
            job_id=job_id,
            started_at=started_at,
            slot=slot,
            mode=mode,
            status="RUNNING",
            message=f"Starting {mode} job ({slot})...",
        )

        with self._lock:
            self.progress.update({
                "is_running": True,
                "job_id": job_id,
                "mode": mode,
                "slot": slot,
                "total": 0,
                "processed": 0,
                "progress_pct": 0.0,
                "current_symbol": "Refreshing F&O Universe...",
                "success_count": 0,
                "failed_count": 0,
                "errors": [],
                "started_at": started_at,
                "finished_at": None,
                "last_message": f"Discovering NSE F&O universe ({mode})...",
            })

        try:
            kite = self._require_kite()
            universe = self.refresh_universe() if mode == "historical" else self.ensure_universe()
            total = len(universe)

            with self._lock:
                self.progress["total"] = total
                self.progress["last_message"] = f"Processing {total} F&O stocks ({mode})..."

            success_count = 0
            failed_count = 0
            errors: List[Dict[str, str]] = []

            if mode in ("historical", "incremental"):
                full_refresh = mode == "historical"
                for idx, stock in enumerate(universe, start=1):
                    sym = stock["symbol"]
                    with self._lock:
                        self.progress["current_symbol"] = sym
                    try:
                        self._sync_single_stock_history(kite, stock, full_refresh=full_refresh)
                        success_count += 1
                    except Exception as exc:
                        failed_count += 1
                        errors.append({"symbol": sym, "error": str(exc)})
                    with self._lock:
                        self.progress["processed"] = idx
                        self.progress["progress_pct"] = round((idx / total) * 100.0, 1) if total else 100.0
                        self.progress["success_count"] = success_count
                        self.progress["failed_count"] = failed_count
                        self.progress["errors"] = errors[-50:]

                # Keep database strictly within 30 months
                cutoff_str = (now_ist() - timedelta(days=HISTORICAL_DAYS)).strftime("%Y-%m-%d")
                fno_db.prune_older_than(cutoff_str)

            else:
                # Snapshot mode (10AM, 1PM, 3PM, MANUAL)
                with self._lock:
                    self.progress["current_symbol"] = "Fetching batch live quotes..."
                quotes = self._fetch_batch_quotes(kite, universe)

                ist_now = now_ist()
                snap_date = ist_now.strftime("%Y-%m-%d")
                snap_ts = ist_now.strftime("%Y-%m-%d %H:%M:%S")
                fetched_at = ist_now.strftime("%Y-%m-%d %H:%M:%S IST")
                snapshot_rows: List[Dict[str, Any]] = []

                for idx, stock in enumerate(universe, start=1):
                    sym = stock["symbol"]
                    with self._lock:
                        self.progress["current_symbol"] = sym
                    try:
                        q = quotes.get(sym)
                        if not q:
                            raise RuntimeError("No quote returned by Kite API")

                        ohlc = q.get("ohlc") or {}
                        ltp = float(q.get("last_price") or ohlc.get("close") or 0.0)
                        vol = int(q.get("volume") or 0)
                        open_p = float(ohlc.get("open") or ltp)
                        high_p = float(ohlc.get("high") or ltp)
                        low_p = float(ohlc.get("low") or ltp)

                        # Check trailing historical bars; backfill incrementally if missing
                        hist_tail = fno_db.get_symbol_candles(sym, limit=60)
                        if len(hist_tail) < 25:
                            self._sync_single_stock_history(kite, stock, full_refresh=False)
                            hist_tail = fno_db.get_symbol_candles(sym, limit=60)

                        # Combine trailing historical bars (prior to today) + current live intraday bar
                        combined = [
                            {
                                "timestamp": r["timestamp"],
                                "date": r["date"],
                                "open": r["open"],
                                "high": r["high"],
                                "low": r["low"],
                                "close": r["close"],
                                "volume": r["volume"],
                            }
                            for r in hist_tail
                            if r["date"] < snap_date
                        ]
                        combined.append({
                            "timestamp": snap_ts,
                            "date": snap_date,
                            "open": open_p,
                            "high": high_p,
                            "low": low_p,
                            "close": ltp,
                            "volume": vol,
                        })

                        enriched = calculate_indicators_df(combined)
                        latest = enriched[-1]
                        snapshot_rows.append({
                            "snapshot_date": snap_date,
                            "slot": slot,
                            "symbol": sym,
                            "timestamp": snap_ts,
                            "open": latest["open"],
                            "high": latest["high"],
                            "low": latest["low"],
                            "close": latest["close"],
                            "volume": latest["volume"],
                            "sma20": latest["sma20"],
                            "rsi14": latest["rsi14"],
                            "rvol": latest["rvol"],
                            "volatility": latest["volatility"],
                            "extra_indicators": latest["extra_indicators"],
                            "fetched_at": fetched_at,
                        })
                        success_count += 1
                    except Exception as exc:
                        failed_count += 1
                        errors.append({"symbol": sym, "error": str(exc)})

                    with self._lock:
                        self.progress["processed"] = idx
                        self.progress["progress_pct"] = round((idx / total) * 100.0, 1) if total else 100.0
                        self.progress["success_count"] = success_count
                        self.progress["failed_count"] = failed_count
                        self.progress["errors"] = errors[-50:]

                if snapshot_rows:
                    fno_db.upsert_snapshots(snapshot_rows)

            finished_at = now_ist().strftime("%Y-%m-%d %H:%M:%S IST")
            status = "SUCCESS" if failed_count == 0 else ("PARTIAL" if success_count > 0 else "FAILED")
            msg = f"Completed {mode} ({slot}): {success_count}/{total} succeeded, {failed_count} failed."

            fno_db.update_log(
                log_id=log_id,
                finished_at=finished_at,
                total_stocks=total,
                success_count=success_count,
                failed_count=failed_count,
                status=status,
                message=msg,
                error_details=json.dumps(errors[:50]) if errors else None,
            )

            with self._lock:
                self.progress.update({
                    "is_running": False,
                    "current_symbol": None,
                    "finished_at": finished_at,
                    "last_message": msg,
                })

        except Exception as exc:
            finished_at = now_ist().strftime("%Y-%m-%d %H:%M:%S IST")
            err_msg = str(exc)
            fno_db.update_log(
                log_id=log_id,
                finished_at=finished_at,
                total_stocks=self.progress.get("total", 0),
                success_count=self.progress.get("success_count", 0),
                failed_count=self.progress.get("failed_count", 0),
                status="FAILED",
                message=f"Job failed: {err_msg}",
                error_details=json.dumps([{"symbol": "SYSTEM", "error": err_msg}]),
            )
            with self._lock:
                self.progress.update({
                    "is_running": False,
                    "current_symbol": None,
                    "finished_at": finished_at,
                    "last_message": f"Failed: {err_msg}",
                    "errors": (self.progress.get("errors", []) + [{"symbol": "SYSTEM", "error": err_msg}])[-50:],
                })

    def trigger_async_job(self, mode: str = "snapshot", slot: str = "MANUAL") -> Tuple[bool, str]:
        with self._lock:
            if self.progress["is_running"]:
                return False, f"A fetch job ({self.progress['mode']}) is already running."

        t = threading.Thread(target=self._run_job, args=(mode, slot), daemon=True, name=f"fno-{mode}-{slot}")
        t.start()
        return True, f"Started {mode} fetch ({slot}) in background."

    # ── Background Scheduler (10:00 AM, 1:00 PM, 3:00 PM IST) ─────────────
    def _scheduler_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                dt = now_ist()
                today_str = dt.strftime("%Y-%m-%d")
                if is_nse_trading_day(dt.date()):
                    for slot_code, hour, minute, _ in SCHEDULE_SLOTS:
                        # Trigger within [HH:MM:00, HH:MM:59] + 1 min grace window if not yet run today
                        slot_start = dt.replace(hour=hour, minute=minute, second=0, microsecond=0)
                        delta_sec = (dt - slot_start).total_seconds()
                        if 0 <= delta_sec <= 120:
                            if not fno_db.has_snapshot_for_slot(today_str, slot_code):
                                with self._lock:
                                    running = self.progress["is_running"]
                                if not running:
                                    print(f"⏰ Triggering scheduled NSE F&O fetch: {today_str} {slot_code}")
                                    self.trigger_async_job(mode="snapshot", slot=slot_code)
            except Exception as e:
                print(f"F&O scheduler tick error: {e}")

            self._stop_event.wait(15.0)

    def start_scheduler(self) -> None:
        if self._scheduler_thread and self._scheduler_thread.is_alive():
            return
        self._stop_event.clear()
        self._scheduler_thread = threading.Thread(
            target=self._scheduler_loop,
            daemon=True,
            name="fno-ist-scheduler",
        )
        self._scheduler_thread.start()
        print("⏰ F&O IST Scheduler active (10:00 AM, 1:00 PM, 3:00 PM Asia/Kolkata)")

    def stop_scheduler(self) -> None:
        self._stop_event.set()

    def get_status_payload(self) -> Dict[str, Any]:
        kite_status = kite_service.get_status()
        # Strip any sensitive or unused raw key before returning to frontend
        safe_kite_status = {
            "is_connected": kite_status.get("is_connected", False),
            "user_name": kite_status.get("user_name"),
            "user_id": kite_status.get("user_id"),
            "session_date": kite_status.get("session_date"),
            "last_successful_connection": self.last_successful_api_conn or kite_status.get("session_date"),
        }

        universe_stats = fno_db.get_universe_stats()
        hist_stats = fno_db.get_historical_stats()
        snapshots = fno_db.get_available_snapshots()
        logs = fno_db.get_logs(limit=15)

        dt = now_ist()
        today_str = dt.strftime("%Y-%m-%d")
        schedule_slots_status = [
            {
                "slot": code,
                "label": label,
                "hour": h,
                "minute": m,
                "completed_today": fno_db.has_snapshot_for_slot(today_str, code),
            }
            for code, h, m, label in SCHEDULE_SLOTS
        ]

        with self._lock:
            progress_copy = dict(self.progress)

        return {
            "api_connection": safe_kite_status,
            "universe": universe_stats,
            "schedule": {
                "timezone": "Asia/Kolkata",
                "current_ist": dt.strftime("%Y-%m-%d %H:%M:%S IST"),
                "is_trading_day": is_nse_trading_day(dt.date()),
                "slots": schedule_slots_status,
                "next_fetch": get_next_scheduled_run(dt),
            },
            "progress": progress_copy,
            "historical": hist_stats,
            "available_snapshots": snapshots,
            "logs": logs,
        }


fno_fetcher = FnoDataFetcher()
