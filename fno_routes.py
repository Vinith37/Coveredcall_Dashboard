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
    "SMA_50",
    "SMA_200",
    "Trend_Signal",
    "RS_Value",
    "RS_Rating",
    "RS_Signal",
    "Vol_20",
    "RVOL",
    "Breakout_50D",
    "Accumulation",
    "Momentum_Score",
    "RSI_14",
    "Volatility_Pct",
    "Extra_Indicators",
]


class FnoFetchRequest(BaseModel):
    mode: str = "snapshot"  # 'snapshot' | 'incremental' | 'historical' | 'simultaneous'
    slot: str = "MANUAL"    # 'MANUAL' or configured schedule slot code


class ScheduleSlotItem(BaseModel):
    slot: str
    label: str = ""
    hour: int
    minute: int
    enabled: bool = True


class FnoScheduleUpdateRequest(BaseModel):
    slots: List[ScheduleSlotItem]


def _csv_val(v: Any) -> Any:
    return "" if v is None else v


def _rows_to_csv_response(rows: List[Dict[str, Any]], filename: str) -> StreamingResponse:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(CSV_HEADERS)
    for r in rows:
        writer.writerow([
            _csv_val(r.get("symbol")),
            _csv_val(r.get("timestamp")),
            _csv_val(r.get("open")),
            _csv_val(r.get("high")),
            _csv_val(r.get("low")),
            _csv_val(r.get("close")),
            _csv_val(r.get("volume")),
            _csv_val(r.get("sma20")),
            _csv_val(r.get("sma50")),
            _csv_val(r.get("sma200")),
            _csv_val(r.get("trend")),
            _csv_val(r.get("rs_value")),
            _csv_val(r.get("rs_rating")),
            _csv_val(r.get("rs_signal")),
            _csv_val(r.get("vol20")),
            _csv_val(r.get("rvol")),
            _csv_val(r.get("breakout_50d")),
            _csv_val(r.get("accumulation")),
            _csv_val(r.get("momentum_score")),
            _csv_val(r.get("rsi14")),
            _csv_val(r.get("volatility")),
            _csv_val(r.get("extra_indicators")),
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
    if mode not in ("snapshot", "incremental", "historical", "simultaneous"):
        raise HTTPException(
            status_code=400,
            detail="Invalid mode. Must be 'snapshot', 'incremental', 'historical', or 'simultaneous'.",
        )
    valid_slots = {"MANUAL", "10AM", "1PM", "3PM"} | {s["slot"].upper() for s in fno_db.get_schedule_slots()}
    if slot not in valid_slots:
        raise HTTPException(status_code=400, detail=f"Invalid slot '{slot}'.")

    started, msg = fno_fetcher.trigger_async_job(mode=mode, slot=slot)
    if not started:
        return JSONResponse(status_code=409, content={"success": False, "message": msg})
    return JSONResponse(content={"success": True, "message": msg})


@router.put("/schedule")
def update_fno_schedule(req: FnoScheduleUpdateRequest):
    if not req.slots:
        raise HTTPException(status_code=400, detail="At least one schedule slot is required.")

    cleaned: List[Dict[str, Any]] = []
    seen_codes = set()
    for item in req.slots:
        code = item.slot.strip().upper().replace(" ", "_")
        if not code:
            raise HTTPException(status_code=400, detail="Slot code cannot be empty.")
        if code in seen_codes:
            raise HTTPException(status_code=400, detail=f"Duplicate slot code '{code}'.")
        if not (0 <= item.hour <= 23 and 0 <= item.minute <= 59):
            raise HTTPException(status_code=400, detail=f"Invalid time {item.hour:02d}:{item.minute:02d} for slot '{code}'.")
        seen_codes.add(code)
        cleaned.append({
            "slot": code,
            "label": (item.label or code).strip(),
            "hour": int(item.hour),
            "minute": int(item.minute),
            "enabled": bool(item.enabled),
        })

    saved = fno_db.save_schedule_slots(cleaned)
    return JSONResponse(content={
        "success": True,
        "message": f"Saved {len(saved)} IST schedule slot(s).",
        "status": fno_fetcher.get_status_payload(),
    })


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
            "sma50": snap.get("sma50"),
            "sma200": snap.get("sma200"),
            "trend": snap.get("trend"),
            "rs_value": snap.get("rs_value"),
            "rs_rating": snap.get("rs_rating"),
            "rs_signal": snap.get("rs_signal"),
            "vol20": snap.get("vol20"),
            "rvol": snap.get("rvol"),
            "breakout_50d": snap.get("breakout_50d"),
            "accumulation": snap.get("accumulation"),
            "momentum_score": snap.get("momentum_score"),
            "rsi14": snap.get("rsi14"),
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

