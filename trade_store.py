import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple
from config import BASE_DIR

TRADES_FILE = BASE_DIR / "trades_library.json"

SNAPSHOT_FIELDS = (
    "price", "last_updated", "sma20", "sma50", "sma200",
    "trend", "rs_score", "rs_rating", "rs_signal",
    "vol_today", "vol20", "rvol", "breakout",
    "accumulation", "score", "volatility",
)


def extract_indicator_snapshot(row: Dict[str, Any]) -> Dict[str, Any]:
    """Extracts the 16 standardized screener indicator fields from a screener row."""
    return {field: row.get(field) for field in SNAPSHOT_FIELDS}


def _compute_pnl(
    entry_price: float,
    exit_price: Optional[float],
    qty: float,
    trade_type: str,
) -> Tuple[Optional[float], Optional[float]]:
    """Calculates realized (pnl, pnl_pct) when exit_price and quantity are valid."""
    if exit_price is None or exit_price <= 0 or qty <= 0:
        return None, None
    diff = (exit_price - entry_price) if trade_type == "BUY" else (entry_price - exit_price)
    pnl = round(diff * qty, 2)
    pnl_pct = round((diff / entry_price) * 100.0, 2) if entry_price > 0 else None
    return pnl, pnl_pct


def _upsert_daily_snapshot(
    trade: Dict[str, Any],
    snapshot_data: Dict[str, Any],
    now_date: str,
    now_ts: str,
) -> None:
    """Appends or updates today's daily indicator snapshot on a trade record in-place."""
    daily_list = trade.setdefault("daily_snapshots", [])
    snap_entry = {"date": now_date, "timestamp": now_ts, **snapshot_data}
    today_entry = next((s for s in daily_list if s.get("date") == now_date), None)
    if today_entry:
        today_entry.update(snap_entry)
    else:
        daily_list.append(snap_entry)
    trade["snapshot"] = snapshot_data
    trade["updated_at"] = now_ts


class TradeStore:
    def __init__(self, filepath: Path = TRADES_FILE):
        self.filepath = filepath
        self._ensure_file()

    def _ensure_file(self) -> None:
        if not self.filepath.exists():
            self.save_trades([])

    def get_all_trades(self) -> List[Dict[str, Any]]:
        try:
            with open(self.filepath, "r", encoding="utf-8") as f:
                return json.load(f).get("trades", [])
        except Exception as e:
            print("Error reading trades:", e)
            return []

    def save_trades(self, trades: List[Dict[str, Any]]) -> bool:
        try:
            payload = {"trades": trades, "updated_at": datetime.now().isoformat()}
            with open(self.filepath, "w", encoding="utf-8") as f:
                json.dump(payload, f, indent=2)
            return True
        except Exception as e:
            print("Error saving trades:", e)
            return False

    def add_trade(self, trade_data: Dict[str, Any]) -> Dict[str, Any]:
        trades = self.get_all_trades()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        date_str = trade_data.get("date") or datetime.now().strftime("%Y-%m-%d")

        entry_price = float(trade_data.get("entry_price") or 0.0)
        exit_price = float(trade_data["exit_price"]) if trade_data.get("exit_price") is not None else None
        qty = float(trade_data.get("quantity") or 0.0)
        trade_type = trade_data.get("trade_type", "BUY").upper()
        status = trade_data.get("status", "OPEN").upper()

        pnl, pnl_pct = _compute_pnl(entry_price, exit_price, qty, trade_type)
        snapshot = trade_data.get("snapshot") or {}
        daily_snapshots = trade_data.get("daily_snapshots") or []

        if snapshot and not daily_snapshots:
            daily_snapshots.append({"date": date_str, "timestamp": now_str, **snapshot})

        new_trade = {
            "id": trade_data.get("id") or f"tr_{uuid.uuid4().hex[:8]}",
            "symbol": trade_data.get("symbol", "").strip().upper(),
            "trade_type": trade_type,
            "strategy": (trade_data.get("strategy") or "Covered Call / Momentum").strip(),
            "quantity": qty,
            "entry_price": entry_price,
            "exit_price": exit_price,
            "target": float(trade_data["target"]) if trade_data.get("target") else None,
            "stop_loss": float(trade_data["stop_loss"]) if trade_data.get("stop_loss") else None,
            "status": status,
            "pnl": pnl,
            "pnl_pct": pnl_pct,
            "date": date_str,
            "exit_date": trade_data.get("exit_date") if status == "CLOSED" else None,
            "notes": (trade_data.get("notes") or "").strip(),
            "tags": trade_data.get("tags") or [],
            "source": trade_data.get("source", "MANUAL"),
            "snapshot": snapshot,
            "daily_snapshots": daily_snapshots,
            "created_at": now_str,
            "updated_at": now_str,
        }

        trades.insert(0, new_trade)
        self.save_trades(trades)
        return new_trade

    def update_trade(self, trade_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        trades = self.get_all_trades()
        for t in trades:
            if t.get("id") == trade_id:
                t.update(updates)
                t["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                entry_price = float(t.get("entry_price") or 0.0)
                exit_price = float(t["exit_price"]) if t.get("exit_price") is not None else None
                qty = float(t.get("quantity") or 0.0)
                trade_type = t.get("trade_type", "BUY").upper()
                pnl, pnl_pct = _compute_pnl(entry_price, exit_price, qty, trade_type)
                if pnl is not None:
                    t["pnl"] = pnl
                    t["pnl_pct"] = pnl_pct
                self.save_trades(trades)
                return t
        return None

    def record_daily_snapshot(self, trade_id: str, snapshot_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Appends or updates today's snapshot row for an active trade."""
        trades = self.get_all_trades()
        now_date = datetime.now().strftime("%Y-%m-%d")
        now_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        for t in trades:
            if t.get("id") == trade_id:
                _upsert_daily_snapshot(t, snapshot_data, now_date, now_ts)
                self.save_trades(trades)
                return t
        return None

    def sync_open_trades_with_screener(self, screener_rows: List[Dict[str, Any]]) -> int:
        """
        Takes live/cached screener rows and updates all OPEN trades (or trades missing snapshots)
        with today's snapshot row. Returns count of trades updated.
        """
        trades = self.get_all_trades()
        now_date = datetime.now().strftime("%Y-%m-%d")
        now_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        lookup = {
            (r.get("ticker") or r.get("symbol") or "").upper().replace(".NS", "").strip(): r
            for r in screener_rows
            if (r.get("ticker") or r.get("symbol"))
        }

        updated_count = 0
        for t in trades:
            sym = t.get("symbol", "").upper().replace(".NS", "").strip()
            if sym in lookup and (t.get("status") == "OPEN" or not t.get("snapshot")):
                snap_data = extract_indicator_snapshot(lookup[sym])
                _upsert_daily_snapshot(t, snap_data, now_date, now_ts)
                updated_count += 1

        if updated_count > 0:
            self.save_trades(trades)
        return updated_count

    def delete_trade(self, trade_id: str) -> bool:
        trades = self.get_all_trades()
        new_trades = [t for t in trades if t.get("id") != trade_id]
        if len(new_trades) != len(trades):
            self.save_trades(new_trades)
            return True
        return False

    def get_summary(self) -> Dict[str, Any]:
        trades = self.get_all_trades()
        open_trades = [t for t in trades if t.get("status") == "OPEN"]
        closed_trades = [t for t in trades if t.get("status") == "CLOSED"]

        realized_pnl = sum(t.get("pnl", 0.0) or 0.0 for t in closed_trades)
        win_trades = [t for t in closed_trades if (t.get("pnl") or 0.0) > 0]
        loss_trades = [t for t in closed_trades if (t.get("pnl") or 0.0) < 0]
        win_rate = (len(win_trades) / len(closed_trades) * 100.0) if closed_trades else 0.0

        return {
            "total_trades": len(trades),
            "open_count": len(open_trades),
            "closed_count": len(closed_trades),
            "realized_pnl": round(realized_pnl, 2),
            "win_count": len(win_trades),
            "loss_count": len(loss_trades),
            "win_rate": round(win_rate, 1),
        }


trade_store = TradeStore()
