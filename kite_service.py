import os
import json
import time
from datetime import datetime
from typing import Dict, Any, Optional, List

import requests
from dotenv import load_dotenv
from kiteconnect import KiteConnect
from kiteconnect.exceptions import TokenException
from config import (
    BASE_DIR,
    SESSION_FILE,
    SECTORS,
    NIFTY_KITE_SYMBOL,
)


class KiteService:
    def __init__(self):
        self.api_key = ""
        self.api_secret = ""
        self.access_token = None
        self.last_request_token = None
        self.kite = None
        self.session_info = {}
        self._refresh_credentials()
        self._load_saved_session()

    def _refresh_credentials(self):
        """Reloads .env so any updates to KITE_API_KEY / KITE_API_SECRET take effect immediately."""
        load_dotenv(BASE_DIR / ".env", override=True)
        self.api_key = os.getenv("KITE_API_KEY", "").strip()
        self.api_secret = os.getenv("KITE_API_SECRET", "").strip()

    def get_login_url(self) -> str:
        """Returns the official Kite Connect login URL."""
        self._refresh_credentials()
        return f"https://kite.zerodha.com/connect/login?v=3&api_key={self.api_key}"

    def _create_kite_client(self, access_token: Optional[str] = None) -> KiteConnect:
        """Instantiates a KiteConnect client with a safe network timeout."""
        kite = KiteConnect(api_key=self.api_key, timeout=15)
        if access_token:
            kite.set_access_token(access_token)
        return kite

    @staticmethod
    def _with_network_retry(fn, retries: int = 2, delay: float = 0.6):
        """Retries transient network/DNS errors with short exponential backoff."""
        last_exc = None
        for attempt in range(retries + 1):
            try:
                return fn()
            except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
                last_exc = exc
                if attempt < retries:
                    time.sleep(delay * (attempt + 1))
        raise last_exc

    @staticmethod
    def _format_kite_error(exc: Exception) -> str:
        """Returns an actionable error message for DNS/network vs API/token failures."""
        msg = str(exc)
        if "NameResolutionError" in msg or "Failed to resolve" in msg or "nodename nor servname" in msg:
            return (
                "Cannot reach api.kite.trade (DNS/network blocked or offline). "
                "Ensure the server is running outside a restricted sandbox with internet access."
            )
        if isinstance(exc, requests.exceptions.Timeout):
            return "Timed out connecting to Zerodha Kite API (api.kite.trade). Please retry."
        return msg

    def _clear_session_state(self):
        self.access_token = None
        self.kite = None
        self.session_info = {}

    def _load_saved_session(self):
        """Loads saved access token from kite_session.json (or .env) if valid."""
        self._refresh_credentials()
        today_str = datetime.now().strftime("%Y-%m-%d")

        if SESSION_FILE.exists():
            try:
                with open(SESSION_FILE, "r") as f:
                    data = json.load(f)
                token = data.get("access_token")
                token_date = data.get("date")

                if token and token_date == today_str and self.api_key:
                    kite = self._create_kite_client(token)
                    try:
                        profile = self._with_network_retry(kite.profile, retries=1)
                        self.access_token = token
                        self.kite = kite
                        self.session_info = {
                            **data,
                            "user_name": profile.get("user_name") or data.get("user_name"),
                            "user_id": profile.get("user_id") or data.get("user_id"),
                        }
                        return
                    except Exception as e:
                        print("Saved Kite session token is no longer valid:", e)
                        self._clear_session_state()
            except Exception as e:
                print("Could not load Kite session:", e)

        env_token = os.getenv("KITE_ACCESS_TOKEN", "").strip()
        if env_token:
            self.set_direct_access_token(env_token)

    def _save_session(self, save_data: Dict[str, Any]):
        self.session_info = save_data
        with open(SESSION_FILE, "w") as f:
            json.dump(save_data, f, indent=2)

    def generate_session(self, request_token: str) -> Dict[str, Any]:
        """Exchanges request_token from Kite redirect URL for a daily access_token."""
        self._refresh_credentials()
        if not self.api_key or not self.api_secret:
            return {"success": False, "error": "KITE_API_KEY or KITE_API_SECRET is missing in .env"}

        clean_req_token = request_token.strip()

        # If this exact request_token was just exchanged (e.g. via auto-redirect), return existing session
        if (
            clean_req_token
            and clean_req_token == self.last_request_token
            and self.kite
            and self.access_token
        ):
            return {
                "success": True,
                "message": f"Kite session active for {self.session_info.get('user_name', 'User')}",
                "session": self.session_info,
            }

        try:
            kite = self._create_kite_client()
            session_data = self._with_network_retry(
                lambda: kite.generate_session(clean_req_token, api_secret=self.api_secret)
            )
            self.access_token = session_data["access_token"]
            self.last_request_token = clean_req_token
            self.kite = kite
            self.kite.set_access_token(self.access_token)

            save_data = {
                "access_token": self.access_token,
                "public_token": session_data.get("public_token"),
                "user_name": session_data.get("user_name"),
                "user_id": session_data.get("user_id"),
                "email": session_data.get("email"),
                "login_time": str(session_data.get("login_time")),
                "date": datetime.now().strftime("%Y-%m-%d"),
            }
            self._save_session(save_data)

            return {
                "success": True,
                "message": f"Kite session generated successfully for {save_data.get('user_name', 'User')}",
                "session": save_data,
            }
        except Exception as e:
            return {"success": False, "error": self._format_kite_error(e)}

    def set_direct_access_token(self, access_token: str) -> Dict[str, Any]:
        """Allows direct entry of an existing access token."""
        self._refresh_credentials()
        if not self.api_key:
            return {"success": False, "error": "KITE_API_KEY is missing in .env"}

        clean_token = access_token.strip()
        try:
            kite = self._create_kite_client(clean_token)
            profile = self._with_network_retry(kite.profile, retries=1)

            self.access_token = clean_token
            self.kite = kite
            save_data = {
                "access_token": clean_token,
                "user_name": profile.get("user_name"),
                "user_id": profile.get("user_id"),
                "email": profile.get("email"),
                "date": datetime.now().strftime("%Y-%m-%d"),
            }
            self._save_session(save_data)

            return {
                "success": True,
                "message": f"Connected to Kite as {profile.get('user_name')}",
                "profile": profile,
                "session": save_data,
            }
        except Exception as e:
            return {"success": False, "error": self._format_kite_error(e)}

    def get_status(self) -> Dict[str, Any]:
        """Returns Kite connection status."""
        self._refresh_credentials()
        is_connected = bool(self.kite and self.access_token)
        return {
            "is_connected": is_connected,
            "api_key": self.api_key[:4] + "••••••••" + self.api_key[-4:] if self.api_key else "",
            "raw_api_key": self.api_key,
            "login_url": self.get_login_url(),
            "user_name": self.session_info.get("user_name"),
            "user_id": self.session_info.get("user_id"),
            "session_date": self.session_info.get("date"),
            "mode": "Kite Connect Live" if is_connected else "Zero-Token Yahoo Engine (Free)",
        }

    def _fetch_batch_quotes(self, symbols: List[str]) -> Optional[Dict[str, float]]:
        """Fetches live LTP quotes in a single batched Kite API call."""
        if not self.kite or not self.access_token or not symbols:
            return None
        try:
            quotes = self.kite.quote(symbols)
            return {sym: data.get("last_price", 0.0) for sym, data in quotes.items()}
        except TokenException as te:
            print("Kite token expired or invalid during quote fetch:", te)
            self._clear_session_state()
            return None
        except Exception as e:
            print("Kite live quote error:", e)
            return None

    def fetch_live_quotes(self) -> Optional[Dict[str, float]]:
        """Fetches live LTP quotes for all 19 sectors + Nifty 50 (1 API token)."""
        symbols = [NIFTY_KITE_SYMBOL] + [s["kite"] for s in SECTORS if s.get("kite")]
        return self._fetch_batch_quotes(symbols)

    def fetch_live_stock_quotes(self, tickers: List[str]) -> Optional[Dict[str, float]]:
        """Fetches live LTP quotes for stock tickers + Nifty 50 (1 API token)."""
        symbols = [NIFTY_KITE_SYMBOL] + ["NSE:" + t.replace(".NS", "") for t in tickers]
        quotes = self._fetch_batch_quotes(symbols)
        if not quotes:
            return None
        return {k.replace("NSE:", ""): v for k, v in quotes.items()}


kite_service = KiteService()
