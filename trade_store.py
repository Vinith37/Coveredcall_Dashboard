import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, List, Optional
from config import BASE_DIR

TRADES_FILE = BASE_DIR / "trades_library.json"

class TradeStore:
    def __init__(self, filepath: Path = TRADES_FILE):
        self.filepath = filepath
        self._ensure_file()

    def _ensure_file(self):
        if not self.filepath.exists():
            default_data = {
                "trades": [],
                "updated_at": datetime.now().isoformat()
            }
            with open(self.filepath, "w", encoding="utf-8") as f:
                json.dump(default_data, f, indent=2)

    def get_all_trades(self) -> List[Dict[str, Any]]:
        try:
            with open(self.filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data.get("trades", [])
        except Exception as e:
            print("Error reading trades:", e)
            return []

    def save_trades(self, trades: List[Dict[str, Any]]) -> bool:
        try:
            data = {
                "trades": trades,
                "updated_at": datetime.now().isoformat()
            }
            with open(self.filepath, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            return True
        except Exception as e:
            print("Error saving trades:", e)
            return False

    def add_trade(self, trade_data: Dict[str, Any]) -> Dict[str, Any]:
        trades = self.get_all_trades()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        date_str = trade_data.get("date") or datetime.now().strftime("%Y-%m-%d")
        
        # Calculate PnL if closed and prices available
        entry_price = float(trade_data.get("entry_price") or 0.0)
        exit_price = float(trade_data.get("exit_price") or 0.0) if trade_data.get("exit_price") is not None else None
        qty = float(trade_data.get("quantity") or 0.0)
        trade_type = trade_data.get("trade_type", "BUY").upper() # BUY / SELL
        status = trade_data.get("status", "OPEN").upper() # OPEN / CLOSED / CANCELLED

        pnl = None
        pnl_pct = None
        if exit_price is not None and exit_price > 0 and qty > 0:
            if trade_type == "BUY":
                pnl = (exit_price - entry_price) * qty
                if entry_price > 0:
                    pnl_pct = ((exit_price - entry_price) / entry_price) * 100.0
            else: # SELL / SHORT
                pnl = (entry_price - exit_price) * qty
                if entry_price > 0:
                    pnl_pct = ((entry_price - exit_price) / entry_price) * 100.0

        # Snapshot of screener indicators at entry or given snapshot
        snapshot = trade_data.get("snapshot") or {}
        daily_snapshots = trade_data.get("daily_snapshots") or []
        
        # If snapshot is provided, create the initial entry in daily_snapshots if not present
        if snapshot and not daily_snapshots:
            init_snap = {
                "date": date_str,
                "timestamp": now_str,
                **snapshot
            }
            daily_snapshots.append(init_snap)

        new_trade = {
            "id": trade_data.get("id") or f"tr_{uuid.uuid4().hex[:8]}",
            "symbol": trade_data.get("symbol", "").strip().upper(),
            "trade_type": trade_type,
            "strategy": trade_data.get("strategy", "Covered Call / Momentum").strip(),
            "quantity": qty,
            "entry_price": entry_price,
            "exit_price": exit_price,
            "target": float(trade_data.get("target") or 0.0) if trade_data.get("target") else None,
            "stop_loss": float(trade_data.get("stop_loss") or 0.0) if trade_data.get("stop_loss") else None,
            "status": status,
            "pnl": round(pnl, 2) if pnl is not None else None,
            "pnl_pct": round(pnl_pct, 2) if pnl_pct is not None else None,
            "date": date_str,
            "exit_date": trade_data.get("exit_date") if status == "CLOSED" else None,
            "notes": trade_data.get("notes", "").strip(),
            "tags": trade_data.get("tags") or [],
            "source": trade_data.get("source", "MANUAL"), # MANUAL / KITE_IMPORT / SCREENER
            "snapshot": snapshot,
            "daily_snapshots": daily_snapshots,
            "created_at": now_str,
            "updated_at": now_str
        }

        trades.insert(0, new_trade) # latest first
        self.save_trades(trades)
        return new_trade

    def update_trade(self, trade_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        trades = self.get_all_trades()
        found = None
        for i, t in enumerate(trades):
            if t.get("id") == trade_id:
                # Merge updates
                t.update(updates)
                t["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                
                # Recalculate PnL
                entry_price = float(t.get("entry_price") or 0.0)
                exit_price = float(t.get("exit_price") or 0.0) if t.get("exit_price") is not None else None
                qty = float(t.get("quantity") or 0.0)
                trade_type = t.get("trade_type", "BUY").upper()
                if exit_price is not None and exit_price > 0 and qty > 0:
                    if trade_type == "BUY":
                        t["pnl"] = round((exit_price - entry_price) * qty, 2)
                        if entry_price > 0:
                            t["pnl_pct"] = round(((exit_price - entry_price) / entry_price) * 100.0, 2)
                    else:
                        t["pnl"] = round((entry_price - exit_price) * qty, 2)
                        if entry_price > 0:
                            t["pnl_pct"] = round(((entry_price - exit_price) / entry_price) * 100.0, 2)
                
                found = t
                break

        if found:
            self.save_trades(trades)
        return found

    def record_daily_snapshot(self, trade_id: str, snapshot_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Appends or updates today's snapshot row for an active trade."""
        trades = self.get_all_trades()
        found = None
        now_date = datetime.now().strftime("%Y-%m-%d")
        now_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        for t in trades:
            if t.get("id") == trade_id:
                daily_list = t.setdefault("daily_snapshots", [])
                
                # Check if an entry for today already exists
                today_entry = next((s for s in daily_list if s.get("date") == now_date), None)
                snap_entry = {
                    "date": now_date,
                    "timestamp": now_ts,
                    **snapshot_data
                }
                
                if today_entry:
                    today_entry.update(snap_entry)
                else:
                    daily_list.append(snap_entry)
                
                # Also keep latest snapshot updated on trade root
                t["snapshot"] = snapshot_data
                t["updated_at"] = now_ts
                found = t
                break

        if found:
            self.save_trades(trades)
        return found

    def sync_open_trades_with_screener(self, screener_rows: List[Dict[str, Any]]) -> int:
        """
        Takes live/cached screener rows and updates all OPEN trades with today's snapshot row.
        Returns count of open trades updated.
        """
        trades = self.get_all_trades()
        now_date = datetime.now().strftime("%Y-%m-%d")
        now_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        lookup = {}
        for r in screener_rows:
            sym = (r.get("ticker") or r.get("symbol") or "").upper().replace(".NS", "").strip()
            if sym:
                lookup[sym] = r

        updated_count = 0
        for t in trades:
            if t.get("status") == "OPEN":
                sym = t.get("symbol", "").upper().replace(".NS", "").strip()
                if sym in lookup:
                    r = lookup[sym]
                    snap_data = {
                        "price": r.get("price"),
                        "last_updated": r.get("last_updated"),
                        "sma20": r.get("sma20"),
                        "sma50": r.get("sma50"),
                        "sma200": r.get("sma200"),
                        "trend": r.get("trend"),
                        "rs_score": r.get("rs_score"),
                        "rs_rating": r.get("rs_rating"),
                        "rs_signal": r.get("rs_signal"),
                        "vol_today": r.get("vol_today"),
                        "vol20": r.get("vol20"),
                        "rvol": r.get("rvol"),
                        "breakout": r.get("breakout"),
                        "accumulation": r.get("accumulation"),
                        "score": r.get("score"),
                        "volatility": r.get("volatility"),
                    }
                    
                    daily_list = t.setdefault("daily_snapshots", [])
                    today_entry = next((s for s in daily_list if s.get("date") == now_date), None)
                    snap_entry = {
                        "date": now_date,
                        "timestamp": now_ts,
                        **snap_data
                    }
                    if today_entry:
                        today_entry.update(snap_entry)
                    else:
                        daily_list.append(snap_entry)

                    t["snapshot"] = snap_data
                    t["updated_at"] = now_ts
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
        total_trades = len(trades)
        open_trades = [t for t in trades if t.get("status") == "OPEN"]
        closed_trades = [t for t in trades if t.get("status") == "CLOSED"]
        
        realized_pnl = sum(t.get("pnl", 0.0) or 0.0 for t in closed_trades)
        win_trades = [t for t in closed_trades if (t.get("pnl") or 0.0) > 0]
        loss_trades = [t for t in closed_trades if (t.get("pnl") or 0.0) < 0]
        
        win_rate = (len(win_trades) / len(closed_trades) * 100.0) if closed_trades else 0.0

        return {
            "total_trades": total_trades,
            "open_count": len(open_trades),
            "closed_count": len(closed_trades),
            "realized_pnl": round(realized_pnl, 2),
            "win_count": len(win_trades),
            "loss_count": len(loss_trades),
            "win_rate": round(win_rate, 1)
        }

trade_store = TradeStore()
