"""
FastAPI Router for the NSE F&O Data Fetching & CSV Export Module.
"""

import csv
import io
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from fno_db import fno_db
from fno_fetcher import fno_fetcher, now_ist

router = APIRouter(prefix="/api/fno", tags=["F&O Data Fetching"])

CSV_HEADERS = [
    "Symbol",
    "Timestamp",
    "Open",
    "High",
    "Low",
    "Close",
    "Volume",
    "SMA_20",
    "RSI_14",
    "RVOL",
    "Volatility_Pct",
    "Extra_Indicators",
]


class FnoFetchRequest(BaseModel):
    mode: str = "snapshot"  # 'snapshot' | 'incremental' | 'historical'
    slot: str = "MANUAL"    # 'MANUAL' | '10AM' | '1PM' | '3PM'


def _rows_to_csv_response(rows: List[Dict[str, Any]], filename: str) -> StreamingResponse:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(CSV_HEADERS)
    for r in rows:
        writer.writerow([
            r.get("symbol", ""),
            r.get("timestamp", ""),
            r.get("open", ""),
            r.get("high", ""),
            r.get("low", ""),
            r.get("close", ""),
            r.get("volume", ""),
            "" if r.get("sma20") is None else r.get("sma20"),
            "" if r.get("rsi14") is None else r.get("rsi14"),
            "" if r.get("rvol") is None else r.get("rvol"),
            "" if r.get("volatility") is None else r.get("volatility"),
            r.get("extra_indicators", ""),
        ])
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/status")
def get_fno_status():
    return JSONResponse(content=fno_fetcher.get_status_payload())


@router.post("/universe/refresh")
def refresh_fno_universe():
    try:
        universe = fno_fetcher.refresh_universe()
        return JSONResponse(content={
            "success": True,
            "total_stocks": len(universe),
            "message": f"Discovered {len(universe)} eligible NSE F&O stocks via Kite Connect.",
        })
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/fetch")
def trigger_fno_fetch(req: FnoFetchRequest):
    mode = req.mode.lower().strip()
    slot = req.slot.upper().strip()
    if mode not in ("snapshot", "incremental", "historical"):
        raise HTTPException(status_code=400, detail="Invalid mode. Must be 'snapshot', 'incremental', or 'historical'.")
    if slot not in ("MANUAL", "10AM", "1PM", "3PM"):
        raise HTTPException(status_code=400, detail="Invalid slot. Must be 'MANUAL', '10AM', '1PM', or '3PM'.")

    started, msg = fno_fetcher.trigger_async_job(mode=mode, slot=slot)
    if not started:
        return JSONResponse(status_code=409, content={"success": False, "message": msg})
    return JSONResponse(content={"success": True, "message": msg})


@router.get("/stocks")
def get_fno_stocks(search: str = ""):
    universe = fno_db.get_universe()
    latest_rows = fno_db.get_snapshot_rows()
    latest_map = {r["symbol"]: r for r in latest_rows}

    q = search.strip().upper()
    combined = []
    for u in universe:
        sym = u["symbol"]
        if q and q not in sym and q not in (u.get("name") or "").upper():
            continue
        snap = latest_map.get(sym, {})
        combined.append({
            "symbol": sym,
            "name": u.get("name", sym),
            "instrument_token": u.get("instrument_token"),
            "timestamp": snap.get("timestamp"),
            "open": snap.get("open"),
            "high": snap.get("high"),
            "low": snap.get("low"),
            "close": snap.get("close"),
            "volume": snap.get("volume"),
            "sma20": snap.get("sma20"),
            "rsi14": snap.get("rsi14"),
            "rvol": snap.get("rvol"),
            "volatility": snap.get("volatility"),
            "slot": snap.get("slot"),
        })

    return JSONResponse(content={
        "success": True,
        "total": len(combined),
        "rows": combined,
    })


@router.get("/export/all")
def export_all_stocks_csv(date: Optional[str] = None, slot: Optional[str] = None):
    clean_slot = slot.upper().strip() if slot else None
    rows = fno_db.get_snapshot_rows(snapshot_date=date, slot=clean_slot)
    if not rows:
        raise HTTPException(
            status_code=404,
            detail="No snapshot or historical data found for the requested date/slot. Run a fetch first.",
        )

    snap_date = rows[0].get("snapshot_date") or now_ist().strftime("%Y-%m-%d")
    slot_tag = clean_slot or rows[0].get("slot") or "LATEST"
    filename = f"FNO_All_Stocks_{snap_date}_{slot_tag}.csv"
    return _rows_to_csv_response(rows, filename)


@router.get("/export/stock/{symbol}")
def export_single_stock_historical_csv(symbol: str):
    clean_sym = symbol.strip().upper().replace(".NS", "")
    rows = fno_db.get_all_historical_candles(symbol=clean_sym)
    if not rows:
        # Fallback to snapshot if 30M historical hasn't been pulled yet
        snaps = [r for r in fno_db.get_snapshot_rows() if r["symbol"] == clean_sym]
        if not snaps:
            raise HTTPException(
                status_code=404,
                detail=f"No historical or snapshot data stored for {clean_sym}. Run Historical Refresh or Fetch first.",
            )
        rows = snaps

    filename = f"{clean_sym}_Historical_30M.csv"
    return _rows_to_csv_response(rows, filename)


@router.get("/export/historical-all")
def export_all_historical_csv():
    rows = fno_db.get_all_historical_candles()
    if not rows:
        raise HTTPException(
            status_code=404,
            detail="No 30-month historical records found yet. Click 'Refresh 30M History' first.",
        )
    filename = f"FNO_Historical_30M_All_{now_ist().strftime('%Y-%m-%d')}.csv"
    return _rows_to_csv_response(rows, filename)
