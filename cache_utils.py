"""
Shared cache-read / cache-write / fallback logic for both
Sector (engine.py) and Stock (stock_engine.py) payloads.
Eliminates the near-identical read → TTL → write → fallback patterns.
"""

import json
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional


def load_or_refresh_cache(
    cache_file: Path,
    ttl_seconds: int,
    fetch_fn: Callable[[], Dict[str, Any]],
    validate_fn: Callable[[Dict[str, Any]], bool],
    force_refresh: bool = False,
    on_cache_hit: Optional[Callable[[Dict[str, Any], int], None]] = None,
) -> Dict[str, Any]:
    """
    Generic cached-payload loader with fallback resilience.

    Parameters
    ----------
    cache_file : Path
        Where the JSON cache is stored on disk.
    ttl_seconds : int
        Seconds before the cache is considered stale.
    fetch_fn : () -> dict
        Called when data must be refreshed (downloads from Yahoo, etc.).
    validate_fn : (payload) -> bool
        Returns True if the payload has enough data to be worth caching.
    force_refresh : bool
        If True, skip the cache and fetch fresh data.
    on_cache_hit : (payload, remaining_ttl) -> None
        Optional callback invoked on a cache hit (e.g. to bump stats counters).

    Returns
    -------
    dict  – The payload (freshly fetched or from cache).
    """
    now = time.time()

    # ── Try serving from cache ───────────────────────────────────
    if not force_refresh and cache_file.exists():
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                cached = json.load(f)
            cached_time = cached.get("timestamp", cached.get("cache_timestamp", 0))
            remaining = ttl_seconds - (now - cached_time)
            cached_data = cached.get("data", {})

            if remaining > 0 and validate_fn(cached_data):
                cached_data["cache_status"] = {
                    "is_cached": True,
                    "remaining_ttl_seconds": int(remaining),
                    "cache_ttl_seconds": ttl_seconds,
                }
                if on_cache_hit:
                    on_cache_hit(cached_data, int(remaining))
                return cached_data
        except Exception as e:
            print(f"Error reading cache {cache_file.name}: {e}")

    # ── Fetch fresh data ─────────────────────────────────────────
    payload = fetch_fn()

    # ── Save if valid, fallback to stale cache if not ────────────
    if validate_fn(payload):
        try:
            with open(cache_file, "w", encoding="utf-8") as f:
                json.dump({"timestamp": now, "data": payload}, f)
        except Exception as e:
            print(f"Error saving cache {cache_file.name}: {e}")
    elif cache_file.exists():
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                cached = json.load(f)
            cached_data = cached.get("data", {})
            if validate_fn(cached_data):
                print(f"Fresh fetch had missing data; serving previously cached {cache_file.name}.")
                cached_data["cache_status"] = {
                    "is_cached": True,
                    "remaining_ttl_seconds": ttl_seconds,
                    "cache_ttl_seconds": ttl_seconds,
                }
                # Re-stamp so TTL resets (prevents infinite re-fetching)
                with open(cache_file, "w", encoding="utf-8") as fw:
                    json.dump({"timestamp": now, "data": cached_data}, fw)
                return cached_data
        except Exception as e:
            print(f"Error reading fallback cache {cache_file.name}: {e}")

    # Stamp fresh payload with cache meta
    payload.setdefault("cache_status", {
        "is_cached": False,
        "remaining_ttl_seconds": ttl_seconds,
        "cache_ttl_seconds": ttl_seconds,
    })
    return payload

