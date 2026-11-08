# Kite Pulse — Institutional Sector Strength & RRG Dashboard

A high-performance, ultra-lean web dashboard designed for Nifty Sector Indices analysis using **Relative Strength (RS)**, **Momentum Indicators**, and **Relative Rotation Graphs (RRG)** with **minimal token utilization**.

---

## ⚡ Token Efficiency Architecture

To prevent burning Zerodha Kite Connect API quotas and rate limits (3 req/sec limit):

1. **Smart Local Caching**:
   - 18-month daily candles and 3-year weekly candles are computed and cached in `cache_data.json` with a 15-minute TTL.
   - Subsequent page reloads or tab switches serve directly from local cache in **< 1 millisecond** with **0 API tokens used**.
2. **Dual-Engine Architecture**:
   - **Zero-Token Yahoo Engine (Default/Free)**: Downloads all 19 Nifty sectoral indices in 1 unified batch request. Works 100% out-of-the-box with **0 Kite tokens used**.
   - **Kite Connect Live Engine**: Uses your configured Kite API Key and Secret. When authenticated, fetches real-time LTP quotes for all 19 indices in a **single batched call** (`kite.quote()`), consuming only **1 API token** for the entire market refresh!
3. **Debounced Refresh**:
   - Manual "Refresh" button only hits external APIs when explicitly triggered or when TTL expires.

---

## 📊 Modules & Formulas (Referenced from your Google Apps Script)

### 1. Strength Indicators Matrix
- **Benchmark**: NIFTY 50 (`^NSEI` / `NSE:NIFTY 50`)
- **Regime**: `Nifty Price > SMA50` $\rightarrow$ **Healthy Market**; otherwise **Market Weak**.
- **Relative Strength (RS Value)**:
  $$\text{RS} = 0.4 \times \left(\frac{R_{3\text{m}}}{NR_{3\text{m}}}\right) + 0.3 \times \left(\frac{R_{6\text{m}}}{NR_{6\text{m}}}\right) + 0.3 \times \left(\frac{R_{12\text{m}}}{NR_{12\text{m}}}\right)$$
- **RS Rating**: Percentile ranking across all sectors from 1 to 100.
- **RS Signal**: `LEADER` ($\ge 1.30$), `STRONG` ($\ge 1.10$), `NEUTRAL` ($\ge 1.00$), `WEAK` ($< 1.00$).
- **Volume & RVOL**: Today's volume compared to 20-day SMA volume.
- **50-Day Breakout**: Triggered if Price $\ge \max(\text{Close}_{-51:-1})$.
- **Accumulation**: Triggered if $\text{RVOL} > 1.5$, $\text{Price} > \text{SMA20}$, and $\text{Price} > \text{Previous Close}$.
- **Momentum Score (0 to 5)**:
  - +1 if $\text{Price} > \text{SMA50}$
  - +1 if $\text{SMA50} > \text{SMA200}$
  - +1 if $\text{RS Score} > 1.10$
  - +1 if $\text{RVOL} > 1.5$
  - +1 if Breakout 50D is YES
- **Trend Signal**: `GREEN`, `YELLOW`, `RED`, `MARKET_WEAK`, `HIGH_VOLATILITY`.

### 2. Relative Rotation Graph (RRG) — Julius de Kempenaer Model
- **Daily RRG**: 14-period EMA, 10-period ROC, 8-period trailing tails.
- **Weekly RRG**: 14-week EMA, 10-week ROC, 8-week trailing tails.
- **Quadrants**:
  - **LEADING (Top-Right)**: RS-Ratio $> 100$, RS-Momentum $> 100$ (Emerald)
  - **WEAKENING (Bottom-Right)**: RS-Ratio $> 100$, RS-Momentum $\le 100$ (Amber)
  - **LAGGING (Bottom-Left)**: RS-Ratio $\le 100$, RS-Momentum $\le 100$ (Rose)
  - **IMPROVING (Top-Left)**: RS-Ratio $\le 100$, RS-Momentum $> 100$ (Cyan)
- **Tail Directions**:
  - $\nearrow$ **ACCELERATING**: $\Delta\text{RS-Ratio} > 0$ and $\Delta\text{RS-Mom} > 0$
  - $\rightarrow$ **DECELERATING**: $\Delta\text{RS-Ratio} > 0$ and $\Delta\text{RS-Mom} \le 0$
  - $\nearrow$ **RECOVERING**: $\Delta\text{RS-Ratio} \le 0$ and $\Delta\text{RS-Mom} > 0$
  - $\searrow$ **WEAKENING**: $\Delta\text{RS-Ratio} \le 0$ and $\Delta\text{RS-Mom} \le 0$

---

## 🔑 Configured Kite API Credentials

Stored securely in `.env` (see `.env.example`):
- `KITE_API_KEY`
- `KITE_API_SECRET`

To connect live Kite data:
1. Click **Kite Connect** in the dashboard header.
2. Click **Open Kite Login Page** to log in on Zerodha.
3. Paste the returned `request_token` (from your browser address bar) and click **Authorize**.

---

## 🚀 Running the Dashboard

```bash
cd /Users/vinithsai/Desktop/Kite
./run.sh
# OR
python3 main.py
```
Open **[http://127.0.0.1:8000](http://127.0.0.1:8000)** in any browser.
