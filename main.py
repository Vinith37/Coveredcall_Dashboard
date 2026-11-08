import os
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional, Dict, Any

from config import BASE_DIR, SESSION_FILE
import engine
import stock_engine
from kite_service import kite_service

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


CURRENT_ENGINE_MODE = "yfinance"


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


@app.post("/api/kite/session")
def set_kite_session(req: KiteSessionRequest):
    """Generates or stores Kite session using request_token or access_token."""
    global CURRENT_ENGINE_MODE
    if req.request_token:
        res = kite_service.generate_session(req.request_token.strip())
        if res.get("success"):
            CURRENT_ENGINE_MODE = "kite"
            return JSONResponse(content=res)
        raise HTTPException(status_code=400, detail=res.get("error", "Failed to generate session"))
    elif req.access_token:
        res = kite_service.set_direct_access_token(req.access_token.strip())
        if res.get("success"):
            CURRENT_ENGINE_MODE = "kite"
            return JSONResponse(content=res)
        raise HTTPException(status_code=400, detail=res.get("error", "Invalid access token"))
    else:
        raise HTTPException(status_code=400, detail="Either request_token or access_token must be provided")


@app.post("/api/kite/disconnect")
def disconnect_kite():
    """Clears Kite session and switches back to Zero-Token Yahoo Mode."""
    global CURRENT_ENGINE_MODE
    if SESSION_FILE.exists():
        SESSION_FILE.unlink()
    kite_service.access_token = None
    kite_service.kite = None
    kite_service.session_info = {}
    CURRENT_ENGINE_MODE = "yfinance"
    return JSONResponse(content={"success": True, "message": "Disconnected from Kite. Switched to Zero-Token Yahoo Engine."})


static_dir = BASE_DIR / "static"
static_dir.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
def serve_index():
    return FileResponse(static_dir / "index.html")


if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    host = os.getenv("HOST", "127.0.0.1")
    print(f"🚀 Kite Pulse running at: http://{host}:{port}")
    uvicorn.run("main:app", host=host, port=port, reload=True)
