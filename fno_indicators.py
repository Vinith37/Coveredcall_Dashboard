"""
Technical Indicator Engine for NSE F&O Market Data Collection.

Calculation Methodology & Timeframe (Daily OHLCV Candles):
-----------------------------------------------------------
1. 20 SMA (Simple Moving Average):
   - Arithmetic mean of the last 20 daily closing prices.
   - Formula: SMA_20 = sum(Close[t-19 : t]) / 20
2. RSI (14-period Wilder's Relative Strength Index):
   - Standard 14-day Wilder's Exponential Moving Average of price gains and losses.
   - RS = AvgGain_14 / AvgLoss_14 ; RSI = 100 - (100 / (1 + RS))
3. RVOL (Relative Volume):
   - Ratio of the current bar's traded volume to the 20-period average volume.
   - Formula: RVOL = Volume[t] / mean(Volume[t-19 : t])
4. Volatility (20-day Annualized Historical Volatility %):
   - Sample standard deviation of daily logarithmic returns over the last 20 trading days,
     annualized using sqrt(252) and expressed as a percentage.
   - Formula: Vol = std(ln(Close[i] / Close[i-1]), ddof=1) * sqrt(252) * 100
5. Extensible `extra_indicators` (JSON):
   - Additional indicators (e.g., SMA 50, ATR 14) are computed via pluggable helpers
     and stored as structured JSON so new indicators require no schema changes.
"""

import json
import math
from typing import Any, Dict, List

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
    # Where avg_loss == 0 and avg_gain > 0, RSI = 100; where both == 0, RSI = 50
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


def calculate_indicators_df(candles: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Takes a chronological list of OHLCV candle dicts:
      [{"timestamp": ..., "date": ..., "open": ..., "high": ..., "low": ..., "close": ..., "volume": ...}, ...]
    Returns the same list enriched with:
      sma20, rsi14, rvol, volatility, and extra_indicators (JSON string).
    """
    if not candles:
        return []

    df = pd.DataFrame(candles).copy()
    df = df.sort_values("timestamp").drop_duplicates(subset=["timestamp"], keep="last").reset_index(drop=True)

    for col in ("open", "high", "low", "close", "volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # 1. 20 SMA
    df["sma20"] = df["close"].rolling(window=20, min_periods=20).mean().round(2)

    # 2. 14-period Wilder RSI
    df["rsi14"] = compute_wilder_rsi(df["close"], period=14)

    # 3. Relative Volume (Volume / 20-day Avg Volume)
    vol_avg20 = df["volume"].rolling(window=20, min_periods=1).mean()
    df["rvol"] = np.where(vol_avg20 > 0, (df["volume"] / vol_avg20).round(2), 0.0)

    # 4. 20-day Annualized Historical Volatility (%)
    log_ret = np.log(df["close"] / df["close"].shift(1))
    df["volatility"] = (log_ret.rolling(window=20, min_periods=20).std(ddof=1) * math.sqrt(252.0) * 100.0).round(2)

    # 5. Extensible extra indicators
    sma50 = df["close"].rolling(window=50, min_periods=50).mean().round(2)
    atr14 = compute_atr(df, period=14)

    enriched: List[Dict[str, Any]] = []
    for idx, row in df.iterrows():
        extras = {
            "sma50": None if pd.isna(sma50.iloc[idx]) else float(sma50.iloc[idx]),
            "atr14": None if pd.isna(atr14.iloc[idx]) else float(atr14.iloc[idx]),
        }
        enriched.append({
            "timestamp": str(row["timestamp"]),
            "date": str(row["date"]),
            "open": round(float(row["open"]), 2) if not pd.isna(row["open"]) else 0.0,
            "high": round(float(row["high"]), 2) if not pd.isna(row["high"]) else 0.0,
            "low": round(float(row["low"]), 2) if not pd.isna(row["low"]) else 0.0,
            "close": round(float(row["close"]), 2) if not pd.isna(row["close"]) else 0.0,
            "volume": int(row["volume"]) if not pd.isna(row["volume"]) else 0,
            "sma20": None if pd.isna(row["sma20"]) else float(row["sma20"]),
            "rsi14": None if pd.isna(row["rsi14"]) else float(row["rsi14"]),
            "rvol": None if pd.isna(row["rvol"]) else float(row["rvol"]),
            "volatility": None if pd.isna(row["volatility"]) else float(row["volatility"]),
            "extra_indicators": json.dumps(extras),
        })

    return enriched
