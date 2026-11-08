import json
import math
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Any, Optional

import pandas as pd
import yfinance as yf

from config import (
    SECTORS,
    SECTOR_MAP,
    NIFTY_SYMBOL,
    CACHE_FILE,
    CACHE_TTL_SECONDS,
    RRG_EMA_PERIOD,
    RRG_ROC_PERIOD,
    RRG_TAIL_COUNT,
)

# In-memory tracking of API calls / token usage
token_stats = {
    "api_calls_made": 0,
    "cache_hits": 0,
    "kite_tokens_used": 0,
    "last_fetched": None,
    "source": "Zero-Token Yahoo Engine"
}

# Number of RRG tail points sent to the UI (supports tail slider / animation)
RRG_HISTORY_LEN = 40


def avg_slice(arr: List[float], window: int) -> float:
    """Computes simple average of the last `window` elements."""
    if not arr:
        return 0.0
    sub = arr[-min(window, len(arr)):]
    return round(sum(sub) / len(sub), 2)


def compute_ema(arr: List[float], period: int) -> List[float]:
    """Calculates Exponential Moving Average matching Julius de Kempenaer formula."""
    if not arr:
        return []
    alpha = 2.0 / (period + 1.0)
    res = [arr[0]]
    for i in range(1, len(arr)):
        res.append(alpha * arr[i] + (1.0 - alpha) * res[-1])
    return res


def classify_quadrant(rs_ratio: float, rs_momentum: float) -> str:
    """Classifies (RS-Ratio, RS-Momentum) into Julius de Kempenaer RRG Quadrant."""
    if rs_ratio > 100.0 and rs_momentum > 100.0:
        return "LEADING"
    if rs_ratio > 100.0 and rs_momentum <= 100.0:
        return "WEAKENING"
    if rs_ratio <= 100.0 and rs_momentum <= 100.0:
        return "LAGGING"
    return "IMPROVING"


def tail_direction(rs_ratio_delta: float, rs_momentum_delta: float) -> str:
    """Classifies movement heading of the RRG tail."""
    if rs_ratio_delta > 0 and rs_momentum_delta > 0:
        return "↗ ACCELERATING"
    if rs_ratio_delta > 0 and rs_momentum_delta <= 0:
        return "→ DECELERATING"
    if rs_ratio_delta <= 0 and rs_momentum_delta > 0:
        return "↗ RECOVERING"
    return "↘ WEAKENING"


def extract_yf_series(df: pd.DataFrame, symbol: str) -> Dict[str, List[Any]]:
    """
    Safely extracts aligned Close, Volume, and Date series for a symbol
    from a yfinance single- or multi-index DataFrame.
    """
    try:
        if isinstance(df.columns, pd.MultiIndex):
            if ("Close", symbol) not in df.columns:
                return {"close": [], "volume": [], "dates": []}
            cs = df[("Close", symbol)].dropna()
            vs = (
                df[("Volume", symbol)].reindex(cs.index).fillna(0)
                if ("Volume", symbol) in df.columns
                else pd.Series(0.0, index=cs.index)
            )
        else:
            if "Close" not in df.columns:
                return {"close": [], "volume": [], "dates": []}
            cs = df["Close"].dropna()
            vs = (
                df["Volume"].reindex(cs.index).fillna(0)
                if "Volume" in df.columns
                else pd.Series(0.0, index=cs.index)
            )

        return {
            "close": [float(x) for x in cs.tolist()],
            "volume": [float(x) for x in vs.tolist()],
            "dates": [d.strftime("%Y-%m-%d") for d in cs.index],
        }
    except Exception:
        return {"close": [], "volume": [], "dates": []}


def compute_nifty_regime(nifty_close: List[float]) -> Optional[Dict[str, Any]]:
    """Computes Nifty 50 benchmark regime and 3m/6m/12m return ratios."""
    if len(nifty_close) < 200:
        return None

    nifty_price = nifty_close[-1]
    nifty_sma50 = avg_slice(nifty_close, 50)
    market_healthy = nifty_price > nifty_sma50

    return {
        "healthy": market_healthy,
        "nifty_close": round(nifty_price, 2),
        "nifty_sma50": nifty_sma50,
        "status_text": "MARKET HEALTHY (Nifty > SMA50)" if market_healthy else "MARKET WEAK (Nifty < SMA50)",
        "nr3": nifty_price / nifty_close[-50],
        "nr6": nifty_price / nifty_close[-120],
        "nr12": nifty_price / nifty_close[-200],
    }


def compute_single_indicator(
    symbol: str,
    close: List[float],
    volume: List[float],
    nifty_ctx: Dict[str, Any],
    now_stamp: str,
    min_bars: int = 120,
    extra_fields: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """
    Shared indicator calculation for both Sectors and Individual Stocks
    (replicates exact Google Apps Script logic).
    """
    c_len = len(close)
    if c_len < min_bars:
        return None

    price = close[-1]
    sma20 = avg_slice(close, 20)
    sma50 = avg_slice(close, 50)
    sma200 = avg_slice(close, 200)

    r3 = price / close[-50]
    r6 = price / close[-120]
    r12 = price / close[-min(200, c_len)]

    rs_score = round(
        (0.4 * (r3 / nifty_ctx["nr3"]))
        + (0.3 * (r6 / nifty_ctx["nr6"]))
        + (0.3 * (r12 / nifty_ctx["nr12"])),
        3,
    )

    vol_today = volume[-1] if volume else 0.0
    vol20 = avg_slice(volume, 20) if len(volume) >= 20 else (vol_today if vol_today else 1.0)
    rvol = round(vol_today / vol20, 2) if vol20 > 0 else 0.0

    high50 = max(close[-51:-1])
    breakout = "YES" if price >= high50 else ""

    prev_close = close[-2] if c_len >= 2 else price
    accumulation = "ACCUMULATION" if (rvol > 1.5 and price > sma20 and price > prev_close) else ""

    range20 = (max(close[-20:]) - min(close[-20:])) / price if price > 0 else 0.0
    volatility = round(range20 * 100.0, 1)

    # Trend Signal
    if not nifty_ctx["healthy"]:
        trend = "MARKET_WEAK"
    elif price > sma50 and sma50 > sma200 and rs_score > 1.10:
        trend = "GREEN"
    elif price > sma200:
        trend = "YELLOW"
    else:
        trend = "RED"

    if range20 > 0.35:
        trend = "HIGH_VOLATILITY"

    # RS Signal
    if rs_score >= 1.30:
        rs_signal = "LEADER"
    elif rs_score >= 1.10:
        rs_signal = "STRONG"
    elif rs_score >= 1.00:
        rs_signal = "NEUTRAL"
    else:
        rs_signal = "WEAK"

    # Momentum Score (0-5)
    score = (
        int(price > sma50)
        + int(sma50 > sma200)
        + int(rs_score > 1.10)
        + int(rvol > 1.5)
        + int(breakout == "YES")
    )

    row = {
        "symbol": symbol,
        "price": round(price, 2),
        "last_updated": now_stamp,
        "sma20": sma20,
        "sma50": sma50,
        "sma200": sma200,
        "trend": trend,
        "rs_score": rs_score,
        "rs_signal": rs_signal,
        "vol_today": int(vol_today),
        "vol20": int(vol20),
        "rvol": rvol,
        "breakout": breakout,
        "accumulation": accumulation,
        "score": score,
        "volatility": volatility,
    }
    if extra_fields:
        row.update(extra_fields)
    return row


def rank_and_sort_indicators(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Assigns RS percentile rank (1..100) and sorts by (score desc, rs_score desc)."""
    valid_scores = [(item["symbol"], item["rs_score"]) for item in items if item.get("rs_score") is not None]
    valid_scores.sort(key=lambda x: x[1])
    total_valid = len(valid_scores)

    ranks = {
        sym: round(((i + 1) / total_valid) * 99 + 1)
        for i, (sym, _) in enumerate(valid_scores)
    }

    for item in items:
        item["rs_rating"] = ranks.get(item["symbol"], 50)

    items.sort(key=lambda x: (x["score"], x["rs_score"]), reverse=True)
    return items


def compute_rrg(
    sector_close: List[float],
    benchmark_close: List[float],
    m: int = RRG_EMA_PERIOD,
    k: int = RRG_ROC_PERIOD,
    tail_len: int = RRG_TAIL_COUNT
) -> Optional[Dict[str, Any]]:
    """
    RRG COMPUTATION ENGINE (Julius de Kempenaer Enhanced EMA methodology):
      RS        = Sector_Close / Benchmark_Close
      EMA_RS    = EMA(RS, m)
      RS_Ratio  = 100 * (EMA_RS / SMA(EMA_RS, m))
      ROC       = (RS_Ratio[t] - RS_Ratio[t-k]) / RS_Ratio[t-k]
      EMA_ROC   = EMA(ROC, m)
      RS_Mom    = 100 + 100 * EMA_ROC
    """
    length = min(len(sector_close), len(benchmark_close))
    sc = sector_close[-length:]
    bc = benchmark_close[-length:]

    min_required = m + k + m + tail_len
    if length < min_required:
        return None

    # Step 1: Raw Relative Strength
    rs = [sc[i] / bc[i] if bc[i] != 0 else 1.0 for i in range(length)]

    # Step 2: EMA of RS (period m)
    ema_rs = compute_ema(rs, m)

    # Step 3: RS_Ratio = 100 * (EMA_RS / SMA(EMA_RS, m))
    rs_ratio: List[Optional[float]] = [None] * length
    for i in range(m - 1, length):
        mean = sum(ema_rs[i - m + 1 : i + 1]) / m
        if mean != 0:
            rs_ratio[i] = 100.0 * (ema_rs[i] / mean)

    # Step 4: ROC of RS_Ratio (lookback k)
    roc_start = m - 1 + k
    roc: List[Optional[float]] = [None] * length
    for i in range(roc_start, length):
        if (
            rs_ratio[i] is not None
            and rs_ratio[i - k] is not None
            and rs_ratio[i - k] != 0
        ):
            roc[i] = (rs_ratio[i] - rs_ratio[i - k]) / rs_ratio[i - k]

    # Step 5: EMA of ROC (period m)
    valid_roc = [roc[i] if roc[i] is not None else 0.0 for i in range(roc_start, length)]
    if len(valid_roc) < m:
        return None
    ema_roc = compute_ema(valid_roc, m)

    # Step 6: RS_Momentum = 100 + 100 * EMA_ROC
    rs_mom = [100.0 + 100.0 * v for v in ema_roc]

    mom_len = len(rs_mom)
    if mom_len < tail_len + 1:
        return None

    current_mom = rs_mom[-1]
    prev_mom = rs_mom[-2]

    current_rs_idx = roc_start + mom_len - 1
    prev_rs_idx = roc_start + mom_len - 2

    current_rs = rs_ratio[current_rs_idx]
    prev_rs = rs_ratio[prev_rs_idx]

    if current_rs is None or current_mom is None:
        return None

    # Step 7: Build Tail (chronological: oldest to newest for charting)
    tail_points = []
    tail_rs = []
    tail_mom = []

    for t in range(tail_len - 1, -1, -1):
        midx = mom_len - 1 - t
        rsidx = roc_start + midx
        r_val = round(rs_ratio[rsidx], 2) if (rsidx < len(rs_ratio) and rs_ratio[rsidx] is not None) else None
        m_val = round(rs_mom[midx], 2) if (0 <= midx < len(rs_mom)) else None
        tail_points.append({"rs_ratio": r_val, "rs_momentum": m_val, "step": tail_len - t})
        tail_rs.append(r_val)
        tail_mom.append(m_val)

    rs_ratio_delta = round(current_rs - prev_rs, 3)
    rs_mom_delta = round(current_mom - prev_mom, 3)
    quadrant = classify_quadrant(current_rs, current_mom)
    direction = tail_direction(rs_ratio_delta, rs_mom_delta)
    distance = round(math.sqrt((current_rs - 100.0) ** 2 + (current_mom - 100.0) ** 2), 2)

    return {
        "rs_ratio": round(current_rs, 2),
        "rs_momentum": round(current_mom, 2),
        "rs_ratio_delta": rs_ratio_delta,
        "rs_momentum_delta": rs_mom_delta,
        "quadrant": quadrant,
        "direction": direction,
        "distance": distance,
        "tail_points": tail_points,
        "tail_rs": list(reversed(tail_rs)),
        "tail_mom": list(reversed(tail_mom))
    }


def compute_strength_indicators(
    history_map: Dict[str, Dict[str, List[float]]],
    nifty: Dict[str, List[float]]
) -> Dict[str, Any]:
    """Calculates all 17 strength indicator metrics for the 19 Nifty sectors."""
    nifty_ctx = compute_nifty_regime(nifty.get("close", []))
    if not nifty_ctx:
        return {"metrics": [], "regime": {"healthy": False, "nifty_close": 0, "nifty_sma50": 0}}

    now_stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    metrics_list = []

    for sector in SECTORS:
        symbol = sector["symbol"]
        history = history_map.get(symbol)
        if not history:
            continue
        row = compute_single_indicator(
            symbol=symbol,
            close=history.get("close", []),
            volume=history.get("volume", []),
            nifty_ctx=nifty_ctx,
            now_stamp=now_stamp,
            min_bars=120,
            extra_fields={"name": sector["name"]},
        )
        if row:
            metrics_list.append(row)

    rank_and_sort_indicators(metrics_list)

    return {
        "metrics": metrics_list,
        "regime": {
            "healthy": nifty_ctx["healthy"],
            "nifty_close": nifty_ctx["nifty_close"],
            "nifty_sma50": nifty_ctx["nifty_sma50"],
            "status_text": nifty_ctx["status_text"],
        }
    }


def fetch_yahoo_market_data() -> Dict[str, Any]:
    """
    Downloads historical data for all sectors in 1 batch request (Zero Tokens).
    Daily: 18 months, Weekly: 3 years.
    """
    token_stats["api_calls_made"] += 1
    token_stats["last_fetched"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    yahoo_symbols = [NIFTY_SYMBOL] + [s["yahoo"] for s in SECTORS]

    daily_df = yf.download(
        yahoo_symbols,
        period="18mo",
        interval="1d",
        progress=False,
        group_by="column"
    )

    weekly_df = yf.download(
        yahoo_symbols,
        period="3y",
        interval="1wk",
        progress=False,
        group_by="column"
    )

    daily_history = {NIFTY_SYMBOL: extract_yf_series(daily_df, NIFTY_SYMBOL)}
    weekly_history = {NIFTY_SYMBOL: extract_yf_series(weekly_df, NIFTY_SYMBOL)}

    for sector in SECTORS:
        sym = sector["symbol"]
        y_sym = sector["yahoo"]
        daily_history[sym] = extract_yf_series(daily_df, y_sym)
        weekly_history[sym] = extract_yf_series(weekly_df, y_sym)

    return {"daily": daily_history, "weekly": weekly_history}


def get_dashboard_payload(force_refresh: bool = False) -> Dict[str, Any]:
    """
    Retrieves full dashboard payload with smart local caching to ensure minimal token/network utilization.
    """
    now = time.time()

    if not force_refresh and CACHE_FILE.exists():
        try:
            with open(CACHE_FILE, "r") as f:
                cached = json.load(f)
            cached_time = cached.get("timestamp", 0)
            remaining_ttl = CACHE_TTL_SECONDS - (now - cached_time)
            if remaining_ttl > 0 and cached.get("data", {}).get("daily_rrg"):
                token_stats["cache_hits"] += 1
                cached["data"]["cache_status"] = {
                    "is_cached": True,
                    "remaining_ttl_seconds": int(remaining_ttl),
                    "cache_ttl_seconds": CACHE_TTL_SECONDS,
                    "tokens_used": token_stats["kite_tokens_used"],
                    "cache_hits": token_stats["cache_hits"],
                    "source": token_stats["source"]
                }
                return cached["data"]
        except Exception as e:
            print("Error reading cache file:", e)

    market_data = fetch_yahoo_market_data()
    daily_history = market_data["daily"]
    weekly_history = market_data["weekly"]

    nifty_daily = daily_history.get(NIFTY_SYMBOL, {"close": [], "volume": []})
    nifty_weekly = weekly_history.get(NIFTY_SYMBOL, {"close": [], "volume": []})

    strength = compute_strength_indicators(daily_history, nifty_daily)

    quadrant_order = {"LEADING": 1, "IMPROVING": 2, "WEAKENING": 3, "LAGGING": 4}

    def build_rrg_list(hist_map: Dict[str, Any], bench_close: List[float]) -> List[Dict[str, Any]]:
        rrg_items = []
        for sector in SECTORS:
            sym = sector["symbol"]
            sec_close = hist_map.get(sym, {}).get("close", [])
            rrg_res = compute_rrg(sec_close, bench_close, tail_len=RRG_HISTORY_LEN)
            if rrg_res:
                rrg_items.append({"symbol": sym, "name": sector["name"], **rrg_res})
        rrg_items.sort(key=lambda x: (quadrant_order.get(x["quadrant"], 5), -x["distance"]))
        return rrg_items

    daily_rrg_list = build_rrg_list(daily_history, nifty_daily["close"])
    weekly_rrg_list = build_rrg_list(weekly_history, nifty_weekly["close"])

    payload = {
        "regime": strength["regime"],
        "strength_indicators": strength["metrics"],
        "daily_rrg": daily_rrg_list,
        "weekly_rrg": weekly_rrg_list,
        "benchmark": {
            "daily": {"dates": nifty_daily.get("dates", [])[-260:], "close": [round(x, 2) for x in nifty_daily["close"][-260:]]},
            "weekly": {"dates": nifty_weekly.get("dates", [])[-156:], "close": [round(x, 2) for x in nifty_weekly["close"][-156:]]}
        },
        "token_stats": {
            "api_calls_made": token_stats["api_calls_made"],
            "cache_hits": token_stats["cache_hits"],
            "kite_tokens_used": token_stats["kite_tokens_used"],
            "last_fetched": token_stats["last_fetched"],
            "source": token_stats["source"]
        },
        "cache_status": {
            "is_cached": False,
            "remaining_ttl_seconds": CACHE_TTL_SECONDS,
            "cache_ttl_seconds": CACHE_TTL_SECONDS,
            "tokens_used": token_stats["kite_tokens_used"],
            "cache_hits": token_stats["cache_hits"],
            "source": token_stats["source"]
        }
    }

    if daily_rrg_list and strength.get("metrics"):
        try:
            with open(CACHE_FILE, "w") as f:
                json.dump({"timestamp": now, "data": payload}, f)
        except Exception as e:
            print("Error saving to cache file:", e)
    elif CACHE_FILE.exists():
        try:
            with open(CACHE_FILE, "r") as f:
                cached = json.load(f)
            cached_data = cached.get("data", {})
            if cached_data.get("daily_rrg"):
                print("Fresh fetch had missing data; serving previously cached data.")
                cached_data["cache_status"] = {
                    "is_cached": True,
                    "remaining_ttl_seconds": CACHE_TTL_SECONDS,
                    "cache_ttl_seconds": CACHE_TTL_SECONDS,
                    "tokens_used": token_stats["kite_tokens_used"],
                    "cache_hits": token_stats["cache_hits"],
                    "source": token_stats["source"],
                }
                with open(CACHE_FILE, "w") as fw:
                    json.dump({"timestamp": now, "data": cached_data}, fw)
                return cached_data
        except Exception as e:
            print("Error reading fallback cache:", e)

    return payload
