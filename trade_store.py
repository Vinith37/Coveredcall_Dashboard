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
