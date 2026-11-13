"""
Technical Indicator Engine for NSE F&O Market Data Collection.

Calculates both OHLCV / Oscillator indicators AND all Stock Strength Screener parameters:
  - SMA 20, SMA 50, SMA 200
  - Trend Signal (GREEN, YELLOW, RED, MARKET_WEAK, HIGH_VOLATILITY)
  - RS Value (weighted 3M/6M/12M relative strength vs Nifty 50)
  - RS Rating (1-100 cross-sectional percentile rank across F&O universe)
  - RS Signal (LEADER, STRONG, NEUTRAL, WEAK)
  - Vol Today, Vol 20 (20-day avg volume), RVOL
  - 50D Breakout (YES / "")
  - Accumulation (ACCUMULATION / "")
  - Momentum Score (0-5)
  - RSI (14-period Wilder's RSI)
  - Volatility % (20-day price range % matching screener, plus annualized log-ret vol in extras)
  - Extensible extra_indicators JSON (atr14, annualized_vol_pct)
"""

import json
import math
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd


def compute_wilder_rsi(close: pd.Series, period: int = 14) -> pd.Series:
    """Computes 14-period Wilder's RSI."""
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)

    avg_gain = gain.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()

    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    rsi = 100.0 - (100.0 / (1.0 + rs))
    rsi = rsi.where(avg_loss != 0.0, np.where(avg_gain > 0.0, 100.0, 50.0))
    return rsi.round(2)


def compute_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Computes 14-period Average True Range (extensible extra indicator)."""
    high = df["high"]
    low = df["low"]
    prev_close = df["close"].shift(1)
    tr = pd.concat(
        [
            (high - low).abs(),
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean().round(2)


def build_nifty_lookup(nifty_candles: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """
    Precomputes Nifty 50 regime & 50d/120d/200d return ratios keyed by date (YYYY-MM-DD).
    """
    if not nifty_candles:
        return {}
    ndf = pd.DataFrame(nifty_candles).sort_values("date").drop_duplicates(subset=["date"], keep="last").reset_index(drop=True)
    ndf["close"] = pd.to_numeric(ndf["close"], errors="coerce")
    ndf["sma50"] = ndf["close"].rolling(window=50, min_periods=50).mean()
    ndf["nr3"] = ndf["close"] / ndf["close"].shift(49)
    ndf["nr6"] = ndf["close"] / ndf["close"].shift(119)
    ndf["nr12"] = ndf["close"] / ndf["close"].shift(199)

    lookup: Dict[str, Dict[str, Any]] = {}
    for _, row in ndf.iterrows():
        c = float(row["close"]) if not pd.isna(row["close"]) else 0.0
        s50 = float(row["sma50"]) if not pd.isna(row["sma50"]) else 0.0
        lookup[str(row["date"])] = {
            "healthy": bool(c > s50) if s50 > 0 else True,
            "nr3": None if pd.isna(row["nr3"]) or row["nr3"] == 0 else float(row["nr3"]),
            "nr6": None if pd.isna(row["nr6"]) or row["nr6"] == 0 else float(row["nr6"]),
            "nr12": None if pd.isna(row["nr12"]) or row["nr12"] == 0 else float(row["nr12"]),
        }
    return lookup


def calculate_indicators_df(
    candles: List[Dict[str, Any]],
    nifty_lookup: Optional[Dict[str, Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """
    Enriches chronological OHLCV candles with all technical & screener indicators.
    """
    if not candles:
        return []

    df = pd.DataFrame(candles).copy()
    df = df.sort_values("timestamp").drop_duplicates(subset=["timestamp"], keep="last").reset_index(drop=True)

    for col in ("open", "high", "low", "close", "volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df["sma20"] = df["close"].rolling(window=20, min_periods=1).mean().round(2)
    df["sma50"] = df["close"].rolling(window=50, min_periods=1).mean().round(2)
    df["sma200"] = df["close"].rolling(window=200, min_periods=1).mean().round(2)
    df["rsi14"] = compute_wilder_rsi(df["close"], period=14)

    vol_avg20 = df["volume"].rolling(window=20, min_periods=1).mean()
    df["vol20"] = vol_avg20.fillna(0).round(0).astype(int)
    df["rvol"] = np.where(vol_avg20 > 0, (df["volume"] / vol_avg20).round(2), 0.0)

    # 20-day price range volatility % (matches Stock Strength Screener)
    roll_max20 = df["close"].rolling(window=20, min_periods=1).max()
    roll_min20 = df["close"].rolling(window=20, min_periods=1).min()
    range20 = np.where(df["close"] > 0, (roll_max20 - roll_min20) / df["close"], 0.0)
    df["volatility"] = np.round(range20 * 100.0, 1)

    # Annualized log-return volatility (stored in extra_indicators)
    log_ret = np.log(df["close"] / df["close"].shift(1))
    ann_vol = (log_ret.rolling(window=20, min_periods=20).std(ddof=1) * math.sqrt(252.0) * 100.0).round(2)
    atr14 = compute_atr(df, period=14)

    # 50D Breakout: close >= max(prior 50 closes)
    high50_prev = df["close"].shift(1).rolling(window=50, min_periods=50).max()
    prev_close = df["close"].shift(1)

    # Stock return ratios (50d / 120d / 200d) matching engine.py
    sr3 = df["close"] / df["close"].shift(49)
    sr6 = df["close"] / df["close"].shift(119)
    sr12 = df["close"] / df["close"].shift(199)

    nifty_dates = sorted(nifty_lookup.keys()) if nifty_lookup else []
    latest_nifty = nifty_lookup[nifty_dates[-1]] if nifty_dates else None

    enriched: List[Dict[str, Any]] = []
    for idx, row in df.iterrows():
        d_str = str(row["date"])
        price = round(float(row["close"]), 2) if not pd.isna(row["close"]) else 0.0
        s20 = None if pd.isna(row["sma20"]) else float(row["sma20"])
        s50 = None if pd.isna(row["sma50"]) else float(row["sma50"])
        s200 = None if pd.isna(row["sma200"]) else float(row["sma200"])
        rvol = None if pd.isna(row["rvol"]) else float(row["rvol"])
        vol_pct = None if pd.isna(row["volatility"]) else float(row["volatility"])
        r20_val = float(range20[idx]) if idx < len(range20) and not pd.isna(range20[idx]) else 0.0

        # Nifty benchmark context for this date (fallback to latest Nifty context)
        n_ctx = (nifty_lookup.get(d_str) if nifty_lookup else None) or latest_nifty

        rs_value: Optional[float] = None
        if n_ctx and n_ctx.get("nr3") and n_ctx.get("nr6") and n_ctx.get("nr12"):
            v3 = sr3.iloc[idx]
            v6 = sr6.iloc[idx]
            v12 = sr12.iloc[idx]
            if not pd.isna(v3) and not pd.isna(v6) and not pd.isna(v12):
                rs_value = round(
                    (0.4 * (float(v3) / n_ctx["nr3"]))
                    + (0.3 * (float(v6) / n_ctx["nr6"]))
                    + (0.3 * (float(v12) / n_ctx["nr12"])),
                    3,
                )

        # RS Signal
        if rs_value is None:
            rs_signal = None
        elif rs_value >= 1.30:
            rs_signal = "LEADER"
        elif rs_value >= 1.10:
            rs_signal = "STRONG"
        elif rs_value >= 1.00:
            rs_signal = "NEUTRAL"
        else:
            rs_signal = "WEAK"

        # 50D Breakout
        h50 = high50_prev.iloc[idx]
        breakout_50d = "YES" if (not pd.isna(h50) and price >= float(h50)) else ""

        # Accumulation
        p_prev = prev_close.iloc[idx]
        accum = (
            "ACCUMULATION"
            if (rvol is not None and rvol > 1.5 and s20 is not None and price > s20 and not pd.isna(p_prev) and price > float(p_prev))
            else ""
        )

        # Trend Signal
        nifty_healthy = n_ctx.get("healthy", True) if n_ctx else True
        if not nifty_healthy:
            trend = "MARKET_WEAK"
        elif s50 is not None and s200 is not None and rs_value is not None and price > s50 and s50 > s200 and rs_value > 1.10:
            trend = "GREEN"
        elif s200 is not None and price > s200:
            trend = "YELLOW"
        else:
            trend = "RED"

        if r20_val > 0.35:
            trend = "HIGH_VOLATILITY"

        # Momentum Score (0-5)
        momentum_score = (
            int(s50 is not None and price > s50)
            + int(s50 is not None and s200 is not None and s50 > s200)
            + int(rs_value is not None and rs_value > 1.10)
            + int(rvol is not None and rvol > 1.5)
            + int(breakout_50d == "YES")
        )

        extras = {
            "atr14": None if pd.isna(atr14.iloc[idx]) else float(atr14.iloc[idx]),
            "annualized_vol_pct": None if pd.isna(ann_vol.iloc[idx]) else float(ann_vol.iloc[idx]),
        }

        enriched.append({
            "timestamp": str(row["timestamp"]),
            "date": d_str,
            "open": round(float(row["open"]), 2) if not pd.isna(row["open"]) else 0.0,
            "high": round(float(row["high"]), 2) if not pd.isna(row["high"]) else 0.0,
            "low": round(float(row["low"]), 2) if not pd.isna(row["low"]) else 0.0,
            "close": price,
            "volume": int(row["volume"]) if not pd.isna(row["volume"]) else 0,
            "sma20": s20,
            "sma50": s50,
            "sma200": s200,
            "trend": trend,
            "rs_value": rs_value,
            "rs_rating": None,  # Populated cross-sectionally across the F&O universe
            "rs_signal": rs_signal,
            "vol20": int(row["vol20"]) if not pd.isna(row["vol20"]) else 0,
            "rvol": rvol,
            "breakout_50d": breakout_50d,
            "accumulation": accum,
            "momentum_score": momentum_score,
            "rsi14": None if pd.isna(row["rsi14"]) else float(row["rsi14"]),
            "volatility": vol_pct,
            "extra_indicators": json.dumps(extras),
        })

    return enriched


def assign_rs_ratings(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Assigns 1..100 cross-sectional RS percentile rating across a list of stock rows."""
    valid = [(r["symbol"], r["rs_value"]) for r in rows if r.get("rs_value") is not None]
    if not valid:
        return rows
    valid.sort(key=lambda x: x[1])
    total = len(valid)
    rank_map = {sym: round(((i + 1) / total) * 99 + 1) for i, (sym, _) in enumerate(valid)}
    for r in rows:
        if r.get("rs_value") is not None:
            r["rs_rating"] = rank_map.get(r["symbol"], 50)
    return rows
