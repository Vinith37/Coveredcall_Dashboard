import json
import os
from contextlib import asynccontextmanager
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import parse_qs, quote, urlparse

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import engine
import stock_engine
from config import BASE_DIR, SESSION_FILE
from fno_fetcher import fno_fetcher
from fno_routes import router as fno_router
from kite_service import kite_service
from trade_store import extract_indicator_snapshot, trade_store


@asynccontextmanager
async def lifespan(_app: FastAPI):
    fno_fetcher.start_scheduler()
    try:
        yield
    finally:
        fno_fetcher.stop_scheduler()


app = FastAPI(
    title="Kite Pulse — Institutional Sector & Stock Strength Engine",
    description="Relative Strength, RRG Visualizer, Stock Screener, Trade Library & F&O Data Fetching powered by Zerodha Kite Connect",
    version="2.1.0",
    lifespan=lifespan,
)
app.include_router(fno_router)


@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


# =================================================================
# PYDANTIC REQUEST SCHEMAS
# =================================================================
class KiteSessionRequest(BaseModel):
    request_token: Optional[str] = None
    access_token: Optional[str] = None


class EngineModeRequest(BaseModel):
    mode: str  # 'yfinance' or 'kite'


class TradeItemRequest(BaseModel):
    symbol: str
    trade_type: str = "BUY"
    strategy: Optional[str] = "Covered Call / Momentum"
    quantity: float = 1.0
    entry_price: float
    exit_price: Optional[float] = None
    target: Optional[float] = None
    stop_loss: Optional[float] = None
    status: Optional[str] = "OPEN"
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


# =================================================================
# SHARED ENGINE MODE & LIVE QUOTE PATCHING HELPERS
# =================================================================
CURRENT_ENGINE_MODE = "kite" if kite_service.get_status().get("is_connected") else "yfinance"


def _resolve_mode(mode: Optional[str]) -> str:
    if mode and mode.lower().strip() in ("yfinance", "kite"):
        return mode.lower().strip()
    return CURRENT_ENGINE_MODE


def _update_live_regime(regime: Dict[str, Any], live_nifty_price: Optional[float]) -> None:
    if not regime or not live_nifty_price or live_nifty_price <= 0:
        return
    regime["nifty_close"] = round(live_nifty_price, 2)
    sma50 = regime.get("nifty_sma50", 0)
    if sma50 > 0:
        healthy = live_nifty_price > sma50
        regime["healthy"] = healthy
        regime["status_text"] = "MARKET HEALTHY (Nifty > SMA50)" if healthy else "MARKET WEAK (Nifty < SMA50)"


def _stamp_source_meta(data: Dict[str, Any], is_kite_live: bool) -> None:
    source_label = "Zerodha Kite Connect (Live)" if is_kite_live else "Zero-Token Yahoo Engine (Free)"
    tokens = 1 if is_kite_live else 0
    if "cache_status" in data:
        data["cache_status"]["source"] = source_label
        data["cache_status"]["tokens_used"] = tokens
    if "token_stats" in data:
        data["token_stats"]["source"] = source_label
        data["token_stats"]["kite_tokens_used"] = tokens


def _patch_live_quotes(
    data: Dict[str, Any],
    rows_key: str,
    effective_mode: str,
    quote_fetcher: Callable[[], Dict[str, float]],
    key_resolver: Callable[[Dict[str, Any]], Optional[str]],
    nifty_quote_key: str,
) -> Dict[str, Any]:
    """Generic helper to enrich either sector or stock rows with live Zerodha Kite quotes."""
    kite_status = kite_service.get_status()
    data["kite_status"] = kite_status
    data["engine_mode"] = effective_mode
    rows = data.get(rows_key, [])

    used_live_kite = False
    if effective_mode == "kite" and kite_status["is_connected"]:
        live_quotes = quote_fetcher()
        if live_quotes:
            used_live_kite = True
            for item in rows:
                k = key_resolver(item)
                if k and k in live_quotes and live_quotes[k] > 0:
                    item["price"] = round(live_quotes[k], 2)
                    item["is_live_kite"] = True
                else:
                    item["is_live_kite"] = False
            _update_live_regime(data.get("regime", {}), live_quotes.get(nifty_quote_key))

    if not used_live_kite:
        for item in rows:
            item["is_live_kite"] = False

    _stamp_source_meta(data, used_live_kite)
    return data


# =================================================================
# ENGINE MODE & MARKET ANALYTICS ENDPOINTS
# =================================================================
@app.get("/api/engine/mode")
def get_engine_mode():
    kite_status = kite_service.get_status()
    return JSONResponse(content={
        "mode": CURRENT_ENGINE_MODE,
        "is_kite_connected": kite_status["is_connected"],
        "user_name": kite_status.get("user_name"),
        "source": "Zerodha Kite Connect (Live)" if CURRENT_ENGINE_MODE == "kite" else "Zero-Token Yahoo Engine (Free)",
    })


@app.post("/api/engine/mode")
def set_engine_mode(req: EngineModeRequest):
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
            "message": "Zerodha Kite Connect session is not active. Please authorize first.",
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
    effective_mode = _resolve_mode(mode)
    try:
        data = engine.get_dashboard_payload(force_refresh=refresh)
        _patch_live_quotes(
            data=data,
            rows_key="strength_indicators",
            effective_mode=effective_mode,
            quote_fetcher=kite_service.fetch_live_quotes,
            key_resolver=lambda item: (engine.SECTOR_MAP.get(item["symbol"]) or {}).get("kite"),
            nifty_quote_key="NSE:NIFTY 50",
        )
        return JSONResponse(content=data)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/refresh")
def refresh_data(mode: Optional[str] = None):
    return get_data(refresh=True, mode=mode)


@app.get("/api/stock-strength")
def get_stock_strength(refresh: bool = False, mode: Optional[str] = None):
    effective_mode = _resolve_mode(mode)
    try:
        data = stock_engine.get_stock_strength_payload(force_refresh=refresh)
        ticker_list = [r["ticker"] for r in data.get("rows", [])]
        _patch_live_quotes(
            data=data,
            rows_key="rows",
            effective_mode=effective_mode,
            quote_fetcher=lambda: kite_service.fetch_live_stock_quotes(ticker_list),
            key_resolver=lambda r: r.get("ticker"),
            nifty_quote_key="NIFTY 50",
        )
        return JSONResponse(content=data)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/stock-strength/refresh")
def refresh_stock_strength(mode: Optional[str] = None):
    return get_stock_strength(refresh=True, mode=mode)


# =================================================================
# KITE CONNECT AUTHENTICATION ENDPOINTS
# =================================================================
@app.get("/api/kite/status")
def get_kite_status():
    return JSONResponse(content=kite_service.get_status())


@app.get("/api/kite/login")
def redirect_to_kite_login():
    return RedirectResponse(url=kite_service.get_login_url())


def _extract_clean_token(raw: str) -> str:
    val = raw.strip()
    if "request_token=" in val:
        parsed = urlparse(val if "://" in val else f"http://localhost/?{val.lstrip('?')}")
        qs = parse_qs(parsed.query)
        if qs.get("request_token"):
            return qs["request_token"][0].strip()
    return val


@app.post("/api/kite/session")
def set_kite_session(req: KiteSessionRequest):
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
    global CURRENT_ENGINE_MODE
    if SESSION_FILE.exists():
        SESSION_FILE.unlink()
    kite_service._clear_session_state()
    CURRENT_ENGINE_MODE = "yfinance"
    return JSONResponse(content={"success": True, "message": "Disconnected from Kite. Switched to Zero-Token Yahoo Engine."})


# =================================================================
# TRADES LIBRARY & DAILY INDICATOR SNAPSHOT ENDPOINTS
# =================================================================
def _get_cached_screener_rows(allow_fetch: bool = False) -> List[Dict[str, Any]]:
    """Reads cached stock screener rows from disk without blocking, or fetches if requested."""
    try:
        if stock_engine.STOCK_CACHE_FILE.exists():
            with open(stock_engine.STOCK_CACHE_FILE, "r", encoding="utf-8") as f:
                rows = json.load(f).get("data", {}).get("rows", [])
                if rows:
                    return rows
        if allow_fetch:
            return stock_engine.get_stock_strength_payload(force_refresh=False).get("rows", [])
    except Exception:
        pass
    return []


def _find_screener_snapshot(symbol: str) -> Optional[Dict[str, Any]]:
    if not symbol:
        return None
    clean_sym = symbol.upper().replace(".NS", "").strip()
    for r in _get_cached_screener_rows(allow_fetch=True):
        r_sym = (r.get("ticker") or r.get("symbol") or "").upper().replace(".NS", "").strip()
        if r_sym == clean_sym:
            return extract_indicator_snapshot(r)
    return None


@app.get("/api/trades")
def get_trades():
    rows = _get_cached_screener_rows(allow_fetch=False)
    if rows:
        trade_store.sync_open_trades_with_screener(rows)

    return JSONResponse(content={
        "success": True,
        "trades": trade_store.get_all_trades(),
        "summary": trade_store.get_summary(),
    })


@app.post("/api/trades")
def create_trade(req: TradeItemRequest):
    trade_dict = req.model_dump()
    if not trade_dict.get("snapshot"):
        snap = _find_screener_snapshot(trade_dict.get("symbol", ""))
        if snap:
            trade_dict["snapshot"] = snap
    created = trade_store.add_trade(trade_dict)
    return JSONResponse(content={
        "success": True,
        "trade": created,
        "summary": trade_store.get_summary(),
    })


@app.put("/api/trades/{trade_id}")
def update_trade(trade_id: str, req: TradeUpdateRequest):
    update_data = {k: v for k, v in req.model_dump().items() if v is not None}
    updated = trade_store.update_trade(trade_id, update_data)
    if not updated:
        raise HTTPException(status_code=404, detail="Trade not found")
    return JSONResponse(content={
        "success": True,
        "trade": updated,
        "summary": trade_store.get_summary(),
    })


@app.delete("/api/trades/{trade_id}")
def delete_trade(trade_id: str):
    if not trade_store.delete_trade(trade_id):
        raise HTTPException(status_code=404, detail="Trade not found")
    return JSONResponse(content={
        "success": True,
        "message": "Trade deleted successfully",
        "summary": trade_store.get_summary(),
    })


@app.post("/api/trades/import-kite")
def import_trades_from_kite():
    if not kite_service.kite:
        raise HTTPException(status_code=400, detail="Zerodha Kite is not connected. Authenticate first.")

    try:
        imported_count = 0
        existing_ids = {t.get("id") for t in trade_store.get_all_trades()}

        for ord_item in kite_service.kite.orders():
            if ord_item.get("status") == "COMPLETE":
                ord_id = f"kite_ord_{ord_item.get('order_id')}"
                if ord_id in existing_ids:
                    continue
                sym = ord_item.get("tradingsymbol", "").upper()
                trade_store.add_trade({
                    "id": ord_id,
                    "symbol": sym,
                    "trade_type": ord_item.get("transaction_type", "BUY").upper(),
                    "strategy": f"{ord_item.get('product', 'CNC')} Order",
                    "quantity": float(ord_item.get("filled_quantity") or ord_item.get("quantity") or 1.0),
                    "entry_price": float(ord_item.get("average_price") or ord_item.get("price") or 0.0),
                    "status": "OPEN",
                    "date": str(ord_item.get("order_timestamp", ""))[:10] or None,
                    "notes": f"Kite Order #{ord_item.get('order_id')}",
                    "source": "KITE_IMPORT",
                    "snapshot": _find_screener_snapshot(sym),
                })
                existing_ids.add(ord_id)
                imported_count += 1

        for pos in kite_service.kite.positions().get("net", []):
            qty = float(pos.get("quantity") or 0.0)
            if qty == 0 and float(pos.get("day_buy_quantity") or 0) == 0:
                continue
            pos_id = f"kite_pos_{pos.get('instrument_token')}"
            if pos_id in existing_ids:
                continue
            sym = pos.get("tradingsymbol", "").upper()
            trade_store.add_trade({
                "id": pos_id,
                "symbol": sym,
                "trade_type": "BUY" if qty >= 0 else "SELL",
                "strategy": f"Position ({pos.get('product', 'NRML')})",
                "quantity": abs(qty) if qty != 0 else float(pos.get("day_buy_quantity", 1)),
                "entry_price": float(pos.get("average_price") or pos.get("buy_price") or 0.0),
                "exit_price": float(pos.get("last_price")) if qty == 0 else None,
                "status": "CLOSED" if qty == 0 else "OPEN",
                "notes": f"Kite Position PnL: ₹{pos.get('pnl', 0.0)}",
                "source": "KITE_IMPORT",
                "snapshot": _find_screener_snapshot(sym),
            })
            existing_ids.add(pos_id)
            imported_count += 1

        return JSONResponse(content={
            "success": True,
            "message": f"Successfully imported {imported_count} trades/positions from Kite.",
            "imported_count": imported_count,
            "summary": trade_store.get_summary(),
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to import from Kite: {str(e)}")


@app.post("/api/trades/sync-snapshots")
def sync_daily_snapshots():
    try:
        rows = _get_cached_screener_rows(allow_fetch=True)
        updated_count = trade_store.sync_open_trades_with_screener(rows)
        return JSONResponse(content={
            "success": True,
            "updated_count": updated_count,
            "message": f"Synchronized daily screener snapshot for {updated_count} trades.",
            "trades": trade_store.get_all_trades(),
            "summary": trade_store.get_summary(),
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to sync daily snapshots: {str(e)}")


# =================================================================
# STATIC FILES & SPA ENTRYPOINT
# =================================================================
static_dir = BASE_DIR / "static"
static_dir.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
def serve_index(request_token: Optional[str] = None, status: Optional[str] = None):
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
