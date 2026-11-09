import os
import uvicorn
from urllib.parse import urlparse, parse_qs, quote
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel
from typing import Optional, Dict, Any

from config import BASE_DIR, SESSION_FILE
import engine
import stock_engine
from kite_service import kite_service
from trade_store import trade_store

app = FastAPI(
    title="Kite Pulse - Sector Strength & RRG Dashboard",
    description="Lean, token-efficient Relative Strength & Relative Rotation Graph (RRG) Dashboard for Nifty Sector Indices",
    version="1.0.0",
)


@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


class KiteSessionRequest(BaseModel):
    request_token: Optional[str] = None
    access_token: Optional[str] = None


class EngineModeRequest(BaseModel):
    mode: str  # 'yfinance' or 'kite'


class TradeItemRequest(BaseModel):
    symbol: str
    trade_type: str = "BUY"  # BUY / SELL
    strategy: Optional[str] = "Covered Call / Momentum"
    quantity: float = 1.0
    entry_price: float
    exit_price: Optional[float] = None
    target: Optional[float] = None
    stop_loss: Optional[float] = None
    status: Optional[str] = "OPEN"  # OPEN / CLOSED / CANCELLED
    date: Optional[str] = None
    exit_date: Optional[str] = None
    notes: Optional[str] = ""
    tags: Optional[list] = []
    source: Optional[str] = "MANUAL"
    snapshot: Optional[Dict[str, Any]] = None
    daily_snapshots: Optional[list] = None


class TradeUpdateRequest(BaseModel):
    symbol: Optional[str] = None
    trade_type: Optional[str] = None
    strategy: Optional[str] = None
    quantity: Optional[float] = None
    entry_price: Optional[float] = None
    exit_price: Optional[float] = None
    target: Optional[float] = None
    stop_loss: Optional[float] = None
    status: Optional[str] = None
    date: Optional[str] = None
    exit_date: Optional[str] = None
    notes: Optional[str] = None
    tags: Optional[list] = None
    snapshot: Optional[Dict[str, Any]] = None
    daily_snapshots: Optional[list] = None


CURRENT_ENGINE_MODE = "kite" if kite_service.get_status().get("is_connected") else "yfinance"


def _resolve_mode(mode: Optional[str]) -> str:
    if mode and mode.lower().strip() in ("yfinance", "kite"):
        return mode.lower().strip()
    return CURRENT_ENGINE_MODE


def _update_live_regime(regime: Dict[str, Any], live_nifty_price: Optional[float]):
    """Updates Nifty benchmark price and regime health flag if live quote is valid."""
    if not regime or not live_nifty_price or live_nifty_price <= 0:
        return
    regime["nifty_close"] = round(live_nifty_price, 2)
    sma50 = regime.get("nifty_sma50", 0)
    if sma50 > 0:
        healthy = live_nifty_price > sma50
        regime["healthy"] = healthy
        regime["status_text"] = "MARKET HEALTHY (Nifty > SMA50)" if healthy else "MARKET WEAK (Nifty < SMA50)"


def _stamp_source_meta(data: Dict[str, Any], is_kite_live: bool):
    source_label = "Zerodha Kite Connect (Live)" if is_kite_live else "Zero-Token Yahoo Engine (Free)"
    tokens = 1 if is_kite_live else 0
    if "cache_status" in data:
        data["cache_status"]["source"] = source_label
        data["cache_status"]["tokens_used"] = tokens
    if "token_stats" in data:
        data["token_stats"]["source"] = source_label
        data["token_stats"]["kite_tokens_used"] = tokens


@app.get("/api/engine/mode")
def get_engine_mode():
    """Returns current active engine mode and Kite connection status."""
    kite_status = kite_service.get_status()
    return JSONResponse(content={
        "mode": CURRENT_ENGINE_MODE,
        "is_kite_connected": kite_status["is_connected"],
        "user_name": kite_status.get("user_name"),
        "source": "Zerodha Kite Connect (Live)" if CURRENT_ENGINE_MODE == "kite" else "Zero-Token Yahoo Engine (Free)",
    })


@app.post("/api/engine/mode")
def set_engine_mode(req: EngineModeRequest):
    """Switches between 'yfinance' (Free Engine) and 'kite' (Zerodha Kite Live Quotes)."""
    global CURRENT_ENGINE_MODE
    target_mode = req.mode.lower().strip()

    if target_mode not in ("yfinance", "kite"):
        raise HTTPException(status_code=400, detail="Invalid mode. Must be 'yfinance' or 'kite'.")

    kite_status = kite_service.get_status()
    if target_mode == "kite" and not kite_status["is_connected"]:
        return JSONResponse(content={
            "success": False,
            "need_auth": True,
            "mode": CURRENT_ENGINE_MODE,
            "message": "Zerodha Kite Connect session is not active. Please authorize with your request token first.",
        })

    CURRENT_ENGINE_MODE = target_mode
    mode_name = "Zerodha Kite API (Live Quotes)" if target_mode == "kite" else "Zero-Token Yahoo Finance (Free)"
    return JSONResponse(content={
        "success": True,
        "mode": CURRENT_ENGINE_MODE,
        "message": f"Successfully switched to {mode_name}.",
    })


@app.get("/api/data")
def get_data(refresh: bool = False, mode: Optional[str] = None):
    """Returns full sector dashboard data (RRG + Sector Strength Matrix)."""
    effective_mode = _resolve_mode(mode)

    try:
        data = engine.get_dashboard_payload(force_refresh=refresh)
        kite_status = kite_service.get_status()
        data["kite_status"] = kite_status
        data["engine_mode"] = effective_mode

        used_live_kite = False
        if effective_mode == "kite" and kite_status["is_connected"]:
            live_quotes = kite_service.fetch_live_quotes()
            if live_quotes:
                used_live_kite = True
                for item in data.get("strength_indicators", []):
                    sector_def = engine.SECTOR_MAP.get(item["symbol"])
                    kite_sym = sector_def.get("kite") if sector_def else None
                    if kite_sym and kite_sym in live_quotes and live_quotes[kite_sym] > 0:
                        item["price"] = round(live_quotes[kite_sym], 2)
                        item["is_live_kite"] = True
                    else:
                        item["is_live_kite"] = False

                _update_live_regime(data.get("regime", {}), live_quotes.get("NSE:NIFTY 50"))

        if not used_live_kite:
            for item in data.get("strength_indicators", []):
                item["is_live_kite"] = False

        _stamp_source_meta(data, used_live_kite)
        return JSONResponse(content=data)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/refresh")
def refresh_data(mode: Optional[str] = None):
    """Forces fresh calculation and updates cache based on selected mode."""
    return get_data(refresh=True, mode=mode)


@app.get("/api/stock-strength")
def get_stock_strength(refresh: bool = False, mode: Optional[str] = None):
    """Returns Strength Indicators for all manual stock tickers."""
    effective_mode = _resolve_mode(mode)

    try:
        data = stock_engine.get_stock_strength_payload(force_refresh=refresh)
        kite_status = kite_service.get_status()
        data["kite_status"] = kite_status
        data["engine_mode"] = effective_mode

        used_live_kite = False
        if effective_mode == "kite" and kite_status["is_connected"]:
            ticker_list = [r["ticker"] for r in data.get("rows", [])]
            live_quotes = kite_service.fetch_live_stock_quotes(ticker_list)
            if live_quotes:
                used_live_kite = True
                for r in data.get("rows", []):
                    t = r.get("ticker")
                    if t and t in live_quotes and live_quotes[t] > 0:
                        r["price"] = round(live_quotes[t], 2)
                        r["is_live_kite"] = True
                    else:
                        r["is_live_kite"] = False

                _update_live_regime(data.get("regime", {}), live_quotes.get("NIFTY 50"))

        if not used_live_kite:
            for r in data.get("rows", []):
                r["is_live_kite"] = False

        _stamp_source_meta(data, used_live_kite)
        return JSONResponse(content=data)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/stock-strength/refresh")
def refresh_stock_strength(mode: Optional[str] = None):
    """Forces fresh calculation of stock strength indicators."""
    return get_stock_strength(refresh=True, mode=mode)


@app.get("/api/kite/status")
def get_kite_status():
    """Returns Kite API credentials and session status."""
    return JSONResponse(content=kite_service.get_status())


@app.get("/api/kite/login")
def redirect_to_kite_login():
    """Redirects browser directly to the official Zerodha Kite Connect login URL."""
    return RedirectResponse(url=kite_service.get_login_url())


def _extract_clean_token(raw: str) -> str:
    """Extracts request_token if the user pasted a full redirect URL or query string."""
    val = raw.strip()
    if "request_token=" in val:
        parsed = urlparse(val if "://" in val else f"http://localhost/?{val.lstrip('?')}")
        qs = parse_qs(parsed.query)
        if "request_token" in qs and qs["request_token"]:
            return qs["request_token"][0].strip()
    return val


@app.post("/api/kite/session")
def set_kite_session(req: KiteSessionRequest):
    """Generates or stores Kite session using request_token, redirect URL, or access_token."""
    global CURRENT_ENGINE_MODE
    raw_token = req.request_token or req.access_token
    if not raw_token or not raw_token.strip():
        raise HTTPException(status_code=400, detail="Either request_token or access_token must be provided")

    clean_token = _extract_clean_token(raw_token)

    if req.request_token:
        res = kite_service.generate_session(clean_token)
        if res.get("success"):
            CURRENT_ENGINE_MODE = "kite"
            return JSONResponse(content=res)

        # Fallback: check if user pasted a direct access_token into the input box
        direct_res = kite_service.set_direct_access_token(clean_token)
        if direct_res.get("success"):
            CURRENT_ENGINE_MODE = "kite"
            return JSONResponse(content=direct_res)

        raise HTTPException(status_code=400, detail=res.get("error", "Failed to generate Kite session"))

    res = kite_service.set_direct_access_token(clean_token)
    if res.get("success"):
        CURRENT_ENGINE_MODE = "kite"
        return JSONResponse(content=res)
    raise HTTPException(status_code=400, detail=res.get("error", "Invalid access token"))


@app.post("/api/kite/disconnect")
def disconnect_kite():
    """Clears Kite session and switches back to Zero-Token Yahoo Mode."""
    global CURRENT_ENGINE_MODE
    if SESSION_FILE.exists():
        SESSION_FILE.unlink()
    kite_service._clear_session_state()
    CURRENT_ENGINE_MODE = "yfinance"
    return JSONResponse(content={"success": True, "message": "Disconnected from Kite. Switched to Zero-Token Yahoo Engine."})


# =================================================================
# TRADES LIBRARY API ENDPOINTS
# =================================================================
@app.get("/api/trades")
def get_trades():
    """Returns all stored trades in the library and aggregate summary metrics."""
    trades = trade_store.get_all_trades()
    summary = trade_store.get_summary()
    return JSONResponse(content={
        "success": True,
        "trades": trades,
        "summary": summary
    })


@app.post("/api/trades")
def create_trade(req: TradeItemRequest):
    """Adds a new trade record to the library."""
    trade_dict = req.model_dump()
    created = trade_store.add_trade(trade_dict)
    return JSONResponse(content={
        "success": True,
        "trade": created,
        "summary": trade_store.get_summary()
    })


@app.put("/api/trades/{trade_id}")
def update_trade(trade_id: str, req: TradeUpdateRequest):
    """Updates an existing trade record."""
    update_data = {k: v for k, v in req.model_dump().items() if v is not None}
    updated = trade_store.update_trade(trade_id, update_data)
    if not updated:
        raise HTTPException(status_code=404, detail="Trade not found")
    return JSONResponse(content={
        "success": True,
        "trade": updated,
        "summary": trade_store.get_summary()
    })


@app.delete("/api/trades/{trade_id}")
def delete_trade(trade_id: str):
    """Deletes a trade record by ID."""
    deleted = trade_store.delete_trade(trade_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Trade not found")
    return JSONResponse(content={
        "success": True,
        "message": "Trade deleted successfully",
        "summary": trade_store.get_summary()
    })


@app.post("/api/trades/import-kite")
def import_trades_from_kite():
    """Imports orders/positions directly from Zerodha Kite into the trade library."""
    if not kite_service.kite:
        raise HTTPException(status_code=400, detail="Zerodha Kite is not connected. Authenticate first.")

    try:
        imported_count = 0
        existing_trades = trade_store.get_all_trades()
        existing_ids = {t.get("id") for t in existing_trades}

        # 1. Fetch completed orders from Kite
        orders = kite_service.kite.orders()
        for ord_item in orders:
            # Only consider filled/complete orders
            if ord_item.get("status") == "COMPLETE":
                ord_id = f"kite_ord_{ord_item.get('order_id')}"
                if ord_id in existing_ids:
                    continue
                
                trade_record = {
                    "id": ord_id,
                    "symbol": ord_item.get("tradingsymbol", "").upper(),
                    "trade_type": ord_item.get("transaction_type", "BUY").upper(),
                    "strategy": f"{ord_item.get('product', 'CNC')} Order",
                    "quantity": float(ord_item.get("filled_quantity") or ord_item.get("quantity") or 1.0),
                    "entry_price": float(ord_item.get("average_price") or ord_item.get("price") or 0.0),
                    "status": "OPEN",
                    "date": str(ord_item.get("order_timestamp", ""))[:10] or None,
                    "notes": f"Kite Order #{ord_item.get('order_id')}",
                    "source": "KITE_IMPORT"
                }
                trade_store.add_trade(trade_record)
                existing_ids.add(ord_id)
                imported_count += 1

        # 2. Fetch net positions from Kite
        positions = kite_service.kite.positions()
        net_pos = positions.get("net", [])
        for pos in net_pos:
            qty = float(pos.get("quantity") or 0.0)
            if qty == 0 and float(pos.get("day_buy_quantity") or 0) == 0:
                continue
            pos_id = f"kite_pos_{pos.get('instrument_token')}"
            if pos_id in existing_ids:
                continue
            
            trade_record = {
                "id": pos_id,
                "symbol": pos.get("tradingsymbol", "").upper(),
                "trade_type": "BUY" if qty >= 0 else "SELL",
                "strategy": f"Position ({pos.get('product', 'NRML')})",
                "quantity": abs(qty) if qty != 0 else float(pos.get("day_buy_quantity", 1)),
                "entry_price": float(pos.get("average_price") or pos.get("buy_price") or 0.0),
                "exit_price": float(pos.get("last_price")) if qty == 0 else None,
                "status": "CLOSED" if qty == 0 else "OPEN",
                "notes": f"Kite Position PnL: ₹{pos.get('pnl', 0.0)}",
                "source": "KITE_IMPORT"
            }
            trade_store.add_trade(trade_record)
            existing_ids.add(pos_id)
            imported_count += 1

        return JSONResponse(content={
            "success": True,
            "message": f"Successfully imported {imported_count} trades/positions from Kite.",
            "imported_count": imported_count,
            "summary": trade_store.get_summary()
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to import from Kite: {str(e)}")


@app.post("/api/trades/sync-snapshots")
def sync_daily_snapshots():
    """
    Scans the current screener indicators (price, SMAs, Trend, RS, RVOL, Breakout, etc.)
    and automatically records/updates today's snapshot for all active OPEN trades.
    """
    try:
        screener_payload = stock_engine.get_stock_strength_payload(force_refresh=False)
        rows = screener_payload.get("rows", [])
        updated_count = trade_store.sync_open_trades_with_screener(rows)
        return JSONResponse(content={
            "success": True,
            "updated_count": updated_count,
            "message": f"Synchronized daily screener snapshot for {updated_count} open trades.",
            "trades": trade_store.get_all_trades(),
            "summary": trade_store.get_summary()
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to sync daily snapshots: {str(e)}")


static_dir = BASE_DIR / "static"
static_dir.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
def serve_index(request_token: Optional[str] = None, status: Optional[str] = None):
    """
    Serves the main dashboard HTML.
    If Zerodha Kite redirects back with ?request_token=...&status=success,
    automatically exchanges the token on the server and redirects to /?kite_auth=success.
    """
    global CURRENT_ENGINE_MODE
    if request_token and (not status or status.lower() == "success"):
        res = kite_service.generate_session(request_token.strip())
        if res.get("success"):
            CURRENT_ENGINE_MODE = "kite"
            return RedirectResponse(url="/?kite_auth=success")
        err_msg = quote(str(res.get("error", "Token exchange failed")))
        return RedirectResponse(url=f"/?kite_auth=error&reason={err_msg}")
    return FileResponse(static_dir / "index.html")


if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    host = os.getenv("HOST", "127.0.0.1")
    print(f"🚀 Kite Pulse running at: http://{host}:{port}")
    uvicorn.run("main:app", host=host, port=port, reload=True)
