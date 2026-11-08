import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent

load_dotenv(BASE_DIR / ".env")

KITE_API_KEY = os.getenv("KITE_API_KEY", "s2d17052i4lb0duz")
KITE_API_SECRET = os.getenv("KITE_API_SECRET", "4keubds4jpt3j8hkojjjksz9ln0zv7o5")
KITE_ACCESS_TOKEN = os.getenv("KITE_ACCESS_TOKEN", "")

CACHE_TTL_SECONDS = int(os.getenv("CACHE_TTL_SECONDS", "900"))
CACHE_FILE = BASE_DIR / "cache_data.json"
SESSION_FILE = BASE_DIR / "kite_session.json"

NIFTY_SYMBOL = "^NSEI"
NIFTY_KITE_SYMBOL = "NSE:NIFTY 50"

# Julius de Kempenaer RRG Parameters
RRG_EMA_PERIOD = 14
RRG_ROC_PERIOD = 10
RRG_TAIL_COUNT = 8

# Sector specifications with Kite symbols and optimal Yahoo symbols
SECTORS = [
    {
        "symbol": "^CNXAUTO",
        "name": "Nifty Auto",
        "yahoo": "^CNXAUTO",
        "kite": "NSE:NIFTY AUTO",
        "token": 263433
    },
    {
        "symbol": "^NSEBANK",
        "name": "Nifty Bank",
        "yahoo": "^NSEBANK",
        "kite": "NSE:NIFTY BANK",
        "token": 260105
    },
    {
        "symbol": "^CNXFIN",
        "name": "Nifty Financial",
        "yahoo": "FINIETF.NS",
        "kite": "NSE:NIFTY FIN SERVICE",
        "token": 257801
    },
    {
        "symbol": "^CNXFMCG",
        "name": "Nifty FMCG",
        "yahoo": "^CNXFMCG",
        "kite": "NSE:NIFTY FMCG",
        "token": 261897
    },
    {
        "symbol": "^CNXIT",
        "name": "Nifty IT",
        "yahoo": "^CNXIT",
        "kite": "NSE:NIFTY IT",
        "token": 259849
    },
    {
        "symbol": "^CNXMEDIA",
        "name": "Nifty Media",
        "yahoo": "ZEEL.NS",
        "kite": "NSE:NIFTY MEDIA",
        "token": 263945
    },
    {
        "symbol": "^CNXMETAL",
        "name": "Nifty Metal",
        "yahoo": "^CNXMETAL",
        "kite": "NSE:NIFTY METAL",
        "token": 263689
    },
    {
        "symbol": "^CNXPHARMA",
        "name": "Nifty Pharma",
        "yahoo": "^CNXPHARMA",
        "kite": "NSE:NIFTY PHARMA",
        "token": 262409
    },
    {
        "symbol": "^CNXREALTY",
        "name": "Nifty Realty",
        "yahoo": "^CNXREALTY",
        "kite": "NSE:NIFTY REALTY",
        "token": 261129
    },
    {
        "symbol": "^CNXENERGY",
        "name": "Nifty Energy",
        "yahoo": "^CNXENERGY",
        "kite": "NSE:NIFTY ENERGY",
        "token": 261641
    },
    {
        "symbol": "^CNXINFRA",
        "name": "Nifty Infra",
        "yahoo": "^CNXINFRA",
        "kite": "NSE:NIFTY INFRA",
        "token": 261385
    },
    {
        "symbol": "^CNXPSUBANK",
        "name": "Nifty PSU Bank",
        "yahoo": "^CNXPSUBANK",
        "kite": "NSE:NIFTY PSU BANK",
        "token": 262921
    },
    {
        "symbol": "^CNXPVTBANK",
        "name": "Nifty Pvt Bank",
        "yahoo": "NPBET.NS",
        "kite": "NSE:NIFTY PVT BANK",
        "token": 271113
    },
    {
        "symbol": "^CNXCONSUM",
        "name": "Nifty Consumption",
        "yahoo": "^CNXCONSUM",
        "kite": "NSE:NIFTY CONSUMPTION",
        "token": 257545
    },
    {
        "symbol": "^CNXCOMMOD",
        "name": "Nifty Commodities",
        "yahoo": "COMMOIETF.NS",
        "kite": "NSE:NIFTY COMMODITIES",
        "token": 257289
    },
    {
        "symbol": "^CNXOILGAS",
        "name": "Nifty Oil & Gas",
        "yahoo": "OILIETF.NS",
        "kite": "NSE:NIFTY OIL AND GAS",
        "token": 271369
    },
    {
        "symbol": "^CNXPSE",
        "name": "Nifty PSE",
        "yahoo": "^CNXPSE",
        "kite": "NSE:NIFTY PSE",
        "token": 262665
    },
    {
        "symbol": "^CNXSERVICE",
        "name": "Nifty Services",
        "yahoo": "MOSERVICE.NS",
        "kite": "NSE:NIFTY SERV SECTOR",
        "token": 263177
    },
    {
        "symbol": "^CNXMNC",
        "name": "Nifty MNC",
        "yahoo": "^CNXMNC",
        "kite": "NSE:NIFTY MNC",
        "token": 262153
    }
]

SECTOR_MAP = {s["symbol"]: s for s in SECTORS}
YAHOO_TO_SYMBOL = {s["yahoo"]: s["symbol"] for s in SECTORS}
KITE_TO_SYMBOL = {s["kite"]: s["symbol"] for s in SECTORS}
