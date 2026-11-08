import json
from datetime import datetime
from typing import Dict, Any, Optional, List

from kiteconnect import KiteConnect
from config import (
    KITE_API_KEY,
    KITE_API_SECRET,
    SESSION_FILE,
    SECTORS,
    NIFTY_KITE_SYMBOL,
)


class KiteService:
    def __init__(self):
        self.api_key = KITE_API_KEY
        self.api_secret = KITE_API_SECRET
        self.access_token = None
        self.kite = None
        self.session_info = {}
        self._load_saved_session()

    def get_login_url(self) -> str:
        """Returns the official Kite Connect login URL."""
        return f"https://kite.zerodha.com/connect/login?v=3&api_key={self.api_key}"

    def _load_saved_session(self):
        """Loads saved access token from kite_session.json if valid for today."""
        if SESSION_FILE.exists():
            try:
                with open(SESSION_FILE, "r") as f:
                    data = json.load(f)
                token = data.get("access_token")
                token_date = data.get("date")
                today_str = datetime.now().strftime("%Y-%m-%d")

                # Kite tokens expire daily around 6 AM IST
                if token and token_date == today_str:
                    self.access_token = token
                    self.kite = KiteConnect(api_key=self.api_key)
                    self.kite.set_access_token(self.access_token)
                    self.session_info = data
            except Exception as e:
                print("Could not load Kite session:", e)

    def _save_session(self, save_data: Dict[str, Any]):
        self.session_info = save_data
        with open(SESSION_FILE, "w") as f:
            json.dump(save_data, f, indent=2)

    def generate_session(self, request_token: str) -> Dict[str, Any]:
        """Exchanges request_token from Kite redirect URL for a daily access_token."""
        try:
            kite = KiteConnect(api_key=self.api_key)
            session_data = kite.generate_session(request_token, api_secret=self.api_secret)
            self.access_token = session_data["access_token"]
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
            return {"success": False, "error": str(e)}

    def set_direct_access_token(self, access_token: str) -> Dict[str, Any]:
        """Allows direct entry of an existing access token."""
        try:
            kite = KiteConnect(api_key=self.api_key)
            kite.set_access_token(access_token)
            profile = kite.profile()

            self.access_token = access_token
            self.kite = kite
            save_data = {
                "access_token": access_token,
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
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    def get_status(self) -> Dict[str, Any]:
        """Returns Kite connection status."""
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
