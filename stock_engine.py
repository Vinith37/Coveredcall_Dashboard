import json
import time
from datetime import datetime
from typing import Dict, List, Any

import yfinance as yf

from config import BASE_DIR, NIFTY_SYMBOL, CACHE_TTL_SECONDS
from engine import (
    extract_yf_series,
    compute_nifty_regime,
    compute_single_indicator,
    rank_and_sort_indicators,
)

STOCK_CACHE_FILE = BASE_DIR / "stock_strength_cache.json"

MANUAL_TICKERS = [
    'ABB.NS', 'ABCAPITAL.NS', 'ADANIENSOL.NS', 'ADANIENT.NS', 'ADANIGREEN.NS',
    'ADANIPORTS.NS', 'ADANIPOWER.NS', 'ALKEM.NS', 'AMBER.NS', 'AMBUJACEM.NS',
    'ANGELONE.NS', 'APLAPOLLO.NS', 'APOLLOHOSP.NS', 'ASHOKLEY.NS', 'ASIANPAINT.NS',
    'ASTRAL.NS', 'AUBANK.NS', 'AUROPHARMA.NS', 'AXISBANK.NS', 'BAJAJ-AUTO.NS',
    'BAJAJFINSV.NS', 'BAJAJHLDNG.NS', 'BAJFINANCE.NS', 'BANDHANBNK.NS', 'BANKBARODA.NS',
    'BANKINDIA.NS', 'BDL.NS', 'BEL.NS', 'BHARATFORG.NS', 'BHARTIARTL.NS',
    'BHEL.NS', 'BIOCON.NS', 'BLUESTARCO.NS', 'BOSCHLTD.NS', 'BPCL.NS',
    'BRITANNIA.NS', 'BSE.NS', 'CAMS.NS', 'CANBK.NS', 'CDSL.NS',
    'CGPOWER.NS', 'CHOLAFIN.NS', 'CIPLA.NS', 'COALINDIA.NS', 'COCHINSHIP.NS',
    'COFORGE.NS', 'COLPAL.NS', 'CONCOR.NS', 'CROMPTON.NS', 'CUMMINSIND.NS',
    'DABUR.NS', 'DALBHARAT.NS', 'DELHIVERY.NS', 'DIVISLAB.NS', 'DIXON.NS',
    'DLF.NS', 'DMART.NS', 'DRREDDY.NS', 'EICHERMOT.NS', 'ETERNAL.NS',
    'EXIDEIND.NS', 'FEDERALBNK.NS', 'FORCEMOT.NS', 'FORTIS.NS', 'GAIL.NS',
    'GLENMARK.NS', 'GMRAIRPORT.NS', 'GODFRYPHLP.NS', 'GODREJCP.NS', 'GODREJPROP.NS',
    'GRASIM.NS', 'HAL.NS', 'HAVELLS.NS', 'HCLTECH.NS', 'HDFCAMC.NS',
    'HDFCBANK.NS', 'HDFCLIFE.NS', 'HEROMOTOCO.NS', 'HINDALCO.NS', 'HINDPETRO.NS',
    'HINDUNILVR.NS', 'HINDZINC.NS', 'HYUNDAI.NS', 'ICICIBANK.NS', 'ICICIGI.NS',
    'ICICIPRULI.NS', 'IDEA.NS', 'IDFCFIRSTB.NS', 'IEX.NS', 'INDHOTEL.NS',
    'INDIANB.NS', 'INDIGO.NS', 'INDUSINDBK.NS', 'INDUSTOWER.NS', 'INFY.NS',
    'INOXWIND.NS', 'IOC.NS', 'IREDA.NS', 'IRFC.NS', 'ITC.NS',
    'JINDALSTEL.NS', 'JIOFIN.NS', 'JSWENERGY.NS', 'JSWSTEEL.NS', 'JUBLFOOD.NS',
    'KALYANKJIL.NS', 'KAYNES.NS', 'KEI.NS', 'KFINTECH.NS', 'KOTAKBANK.NS',
    'KPITTECH.NS', 'LAURUSLABS.NS', 'LICHSGFIN.NS', 'LICI.NS', 'LODHA.NS',
    'LT.NS', 'LTF.NS', 'LTIM.NS', 'LUPIN.NS', 'M&M.NS',
    'MANAPPURAM.NS', 'MANKIND.NS', 'MARICO.NS', 'MARUTI.NS', 'MAXHEALTH.NS',
    'MAZDOCK.NS', 'MCX.NS', 'MFSL.NS', 'MOTHERSON.NS', 'MOTILALOFS.NS',
    'MPHASIS.NS', 'MUTHOOTFIN.NS', 'NAM-INDIA.NS', 'NATIONALUM.NS', 'NAUKRI.NS',
    'NBCC.NS', 'NESTLEIND.NS', 'NHPC.NS', 'NMDC.NS', 'NTPC.NS',
    'NUVAMA.NS', 'NYKAA.NS', 'OBEROIRLTY.NS', 'OFSS.NS', 'OIL.NS',
    'ONGC.NS', 'PAGEIND.NS', 'PATANJALI.NS', 'PAYTM.NS', 'PERSISTENT.NS',
    'PETRONET.NS', 'PFC.NS', 'PGEL.NS', 'PHOENIXLTD.NS', 'PIDILITIND.NS',
    'PIIND.NS', 'PNB.NS', 'PNBHOUSING.NS', 'POLICYBZR.NS', 'POLYCAB.NS',
    'POWERGRID.NS', 'POWERINDIA.NS', 'PREMIERENE.NS', 'PRESTIGE.NS', 'RBLBANK.NS',
    'RECLTD.NS', 'RELIANCE.NS', 'RVNL.NS', 'SAIL.NS', 'SAMMAANCAP.NS',
    'SBICARD.NS', 'SBILIFE.NS', 'SBIN.NS', 'SHREECEM.NS', 'SHRIRAMFIN.NS',
    'SIEMENS.NS', 'SOLARINDS.NS', 'SONACOMS.NS', 'SRF.NS', 'SUNPHARMA.NS',
    'SUPREMEIND.NS', 'SUZLON.NS', 'SWIGGY.NS', 'TATACONSUM.NS', 'TATAELXSI.NS',
    'TATAPOWER.NS', 'TATASTEEL.NS', 'TCS.NS', 'TECHM.NS', 'TIINDIA.NS',
    'TITAN.NS', 'TMPV.NS', 'TORNTPHARM.NS', 'TRENT.NS', 'TVSMOTOR.NS',
    'ULTRACEMCO.NS', 'UNIONBANK.NS', 'UNITDSPR.NS', 'UNOMINDA.NS', 'UPL.NS',
    'VBL.NS', 'VEDL.NS', 'VMM.NS', 'VOLTAS.NS', 'WAAREEENER.NS',
    'WIPRO.NS', 'YESBANK.NS', 'ZYDUSLIFE.NS',
]

HEADERS = [
    'Ticker', 'Price', 'Last_Updated', 'SMA20', 'SMA50', 'SMA200',
    'Trend_Signal', 'RS_Value', 'RS_Rating', 'RS_Signal',
    'Vol_Today', 'Vol20', 'RVOL', 'Breakout_50D', 'Accumulation',
    'Momentum_Score', 'Volatility',
]


def fetch_all_stock_history() -> Dict[str, Dict[str, List[float]]]:
    """Downloads 18mo daily data for NIFTY + all manual stock tickers in 1 batch."""
    all_symbols = [NIFTY_SYMBOL] + MANUAL_TICKERS
    print(f"📥 Downloading market data for {len(all_symbols)} tickers...")

    df = yf.download(
        all_symbols,
        period="18mo",
        interval="1d",
        progress=False,
        group_by="column",
    )

    return {sym: extract_yf_series(df, sym) for sym in all_symbols}


def calculate_stock_indicators(history_map: Dict[str, Dict[str, List[float]]]) -> Dict[str, Any]:
    """
    Computes all 17 stock strength indicators using the shared engine formula.
    """
    nifty_close = history_map.get(NIFTY_SYMBOL, {}).get("close", [])
    nifty_ctx = compute_nifty_regime(nifty_close)
    if not nifty_ctx:
        return {"regime": {}, "rows": [], "count": 0}

    now_stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    rows = []

    for symbol in MANUAL_TICKERS:
        hist = history_map.get(symbol)
        if not hist:
            continue
        row = compute_single_indicator(
            symbol=symbol,
            close=hist.get("close", []),
            volume=hist.get("volume", []),
            nifty_ctx=nifty_ctx,
            now_stamp=now_stamp,
            min_bars=200,
            extra_fields={"ticker": symbol.replace(".NS", "")},
        )
        if row:
            rows.append(row)

    rank_and_sort_indicators(rows)

    summary = {
        "total_tracked": len(MANUAL_TICKERS),
        "analyzed": len(rows),
        "leaders": sum(1 for r in rows if r["rs_signal"] == "LEADER"),
        "strong": sum(1 for r in rows if r["rs_signal"] == "STRONG"),
        "breakouts": sum(1 for r in rows if r["breakout"] == "YES"),
        "accumulations": sum(1 for r in rows if r["accumulation"] == "ACCUMULATION"),
        "green_trend": sum(1 for r in rows if r["trend"] == "GREEN"),
        "score_5": sum(1 for r in rows if r["score"] == 5),
        "score_4_plus": sum(1 for r in rows if r["score"] >= 4),
    }

    return {
        "regime": {
            "healthy": nifty_ctx["healthy"],
            "nifty_close": nifty_ctx["nifty_close"],
            "nifty_sma50": nifty_ctx["nifty_sma50"],
            "status_text": nifty_ctx["status_text"],
        },
        "summary": summary,
        "rows": rows,
        "headers": HEADERS,
        "timestamp": now_stamp,
    }


def get_stock_strength_payload(force_refresh: bool = False) -> Dict[str, Any]:
    """Returns stock strength payload with local caching and fallback resilience."""
    now = time.time()
    if not force_refresh and STOCK_CACHE_FILE.exists():
        try:
            with open(STOCK_CACHE_FILE, "r") as f:
                cached = json.load(f)
            cached_time = cached.get("cache_timestamp", 0)
            remaining = CACHE_TTL_SECONDS - (now - cached_time)
            if remaining > 0 and cached.get("data", {}).get("rows"):
                payload = cached["data"]
                payload["cache_status"] = {
                    "is_cached": True,
                    "remaining_ttl_seconds": int(remaining),
                    "cache_ttl_seconds": CACHE_TTL_SECONDS,
                }
                return payload
        except Exception as e:
            print(f"Error reading stock cache: {e}")

    history_map = fetch_all_stock_history()
    payload = calculate_stock_indicators(history_map)

    if payload.get("rows"):
        try:
            with open(STOCK_CACHE_FILE, "w") as f:
                json.dump({"cache_timestamp": now, "data": payload}, f, indent=2)
        except Exception as e:
            print(f"Error saving stock cache: {e}")
    elif STOCK_CACHE_FILE.exists():
        try:
            with open(STOCK_CACHE_FILE, "r") as f:
                cached = json.load(f)
            cached_data = cached.get("data", {})
            if cached_data.get("rows"):
                print("Fresh stock fetch had empty rows; serving previously cached data.")
                cached_data["cache_status"] = {
                    "is_cached": True,
                    "remaining_ttl_seconds": CACHE_TTL_SECONDS,
                    "cache_ttl_seconds": CACHE_TTL_SECONDS,
                }
                with open(STOCK_CACHE_FILE, "w") as fw:
                    json.dump({"cache_timestamp": now, "data": cached_data}, fw, indent=2)
                return cached_data
        except Exception as e:
            print(f"Error reading fallback stock cache: {e}")

    payload["cache_status"] = {
        "is_cached": False,
        "remaining_ttl_seconds": CACHE_TTL_SECONDS,
        "cache_ttl_seconds": CACHE_TTL_SECONDS,
    }
    return payload


if __name__ == "__main__":
    data = get_stock_strength_payload(force_refresh=True)
    print("Done! Total rows computed:", len(data.get("rows", [])))
    for r in data.get("rows", [])[:3]:
        print(r["ticker"], "Price:", r["price"], "Score:", r["score"], "RS:", r["rs_score"], "Signal:", r["rs_signal"])
