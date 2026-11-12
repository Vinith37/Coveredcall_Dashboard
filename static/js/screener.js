/**
 * Kite Pulse — Sector Strength Matrix & 200+ Stock Screener Module
 * Uses unified indicator cell renderer, sorting, and CSV export helpers from state.js.
 */

// =================================================================
// SECTOR STRENGTH INDICATORS MATRIX TABLE (19 SECTORS)
// =================================================================
function renderStrengthTable() {
  if (!dashboardData) return;
  const tbody = document.getElementById('tbody-strength');
  if (!tbody) return;

  let list = [...(dashboardData.strength_indicators || [])];

  if (searchQuery) {
    list = list.filter(item =>
      item.name.toLowerCase().includes(searchQuery) ||
      item.symbol.toLowerCase().includes(searchQuery)
    );
  }
  if (filterTrend !== 'ALL') {
    list = list.filter(item => item.trend === filterTrend);
  }
  if (filterRsSignal !== 'ALL') {
    list = list.filter(item => item.rs_signal === filterRsSignal);
  }

  list = list.filter(item => rowMatchesColFilters(item, sectorColFilters));
  updateColHeaderFilterIndicators('table-strength', sectorColFilters, 'btn-clear-sector-col-filters');

  const counterEl = document.getElementById('matrix-counter');
  if (counterEl) {
    counterEl.textContent = `Showing ${list.length} of ${dashboardData.strength_indicators?.length || 19} sectors`;
  }

  sortDataRows(list, strengthSortCol, strengthSortAsc ? 'asc' : 'desc');

  tbody.innerHTML = list.map(item => `
    <tr>
      <td>
        <strong>${item.name}</strong>
        ${item.is_live_kite ? '<span class="badge-live-kite" title="Live LTP from Zerodha Kite Connect">Kite Live</span>' : ''}
        <div style="color: var(--text-muted); font-size: 0.7rem;">${item.symbol}</div>
      </td>
      <td class="num" style="font-weight: 700;">${fmtINR(item.price)}</td>
      ${renderIndicatorCellsHTML(item, { includeVolumeCols: false, breakoutBadgeText: '50D HIGH ⚡', accumBadgeText: 'ACCUM 💎' })}
      <td style="color: var(--text-muted); font-size: 0.72rem;">${item.last_updated}</td>
    </tr>
  `).join('');
}

// =================================================================
// STOCK STRENGTH INDICATOR MATRIX (200+ STOCKS)
// =================================================================
function initStockStrength() {
  setupStockStrengthListeners();
  fetchStockStrengthData(false);
}

function ensureStockStrengthLoaded() {
  if (!stockStrengthData && !stockStrengthLoading) {
    fetchStockStrengthData(false);
  } else if (stockStrengthData) {
    renderStockStrengthTable();
  }
}

async function fetchStockStrengthData(forceRefresh = false) {
  if (stockStrengthLoading) return;
  stockStrengthLoading = true;
  const refreshBtn = document.getElementById('btn-refresh-stock');
  refreshBtn?.classList.add('loading');

  try {
    const url = forceRefresh ? `/api/stock-strength/refresh?mode=${currentEngineMode}` : `/api/stock-strength?mode=${currentEngineMode}`;
    const method = forceRefresh ? 'POST' : 'GET';
    const res = await fetch(url, { method });
    stockStrengthData = await res.json();
    updateStockKPIs();
    renderStockStrengthTable();
    if (typeof libraryTrades !== 'undefined' && libraryTrades.length > 0) {
      renderTradeLibraryTable();
    }
    if (forceRefresh) {
      showToast('⚡ Stock Strength Indicators refreshed');
    }
  } catch (err) {
    console.error('Error fetching stock strength data:', err);
    showToast('Failed to load stock strength indicators');
  } finally {
    stockStrengthLoading = false;
    refreshBtn?.classList.remove('loading');
  }
}

function updateStockKPIs() {
  if (!stockStrengthData) return;
  const regime = stockStrengthData.regime || {};
  const summary = stockStrengthData.summary || {};

  const regimeEl = document.getElementById('stock-kpi-regime');
  const niftyEl = document.getElementById('stock-kpi-nifty');
  if (regimeEl) {
    regimeEl.textContent = regime.healthy ? 'HEALTHY' : 'WEAK';
    regimeEl.className = 'kpi-val ' + (regime.healthy ? 'text-emerald' : 'text-rose');
  }
  if (niftyEl) {
    const cmp = regime.healthy ? '>' : '<';
    niftyEl.textContent = `Nifty ₹${Number(regime.nifty_close || 0).toLocaleString()} ${cmp} SMA50 ₹${Number(regime.nifty_sma50 || 0).toLocaleString()}`;
  }

  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val !== undefined ? val : '0';
  };

  setVal('stock-kpi-leaders', summary.leaders);
  setVal('stock-kpi-breakouts', summary.breakouts);
  setVal('stock-kpi-accum', summary.accumulations);
  setVal('stock-kpi-momentum', summary.score_4_plus);
  setVal('stock-kpi-total', summary.analyzed || summary.total_tracked || 0);
}

function setupStockStrengthListeners() {
  bindSearchInput('stock-search-input', 'btn-clear-stock-search', (val) => {
    stockSearchQuery = val.toUpperCase();
    renderStockStrengthTable();
  });

  document.getElementById('stock-filter-trend')?.addEventListener('change', (e) => {
    stockTrendFilter = e.target.value;
    renderStockStrengthTable();
  });

  document.getElementById('stock-filter-rs-signal')?.addEventListener('change', (e) => {
    stockRsSignalFilter = e.target.value;
    renderStockStrengthTable();
  });

  bindPillGroup('.stock-pill', 'data-filter', (val) => {
    stockQuickPill = val;
    renderStockStrengthTable();
  });

  document.getElementById('btn-refresh-stock')?.addEventListener('click', () => {
    fetchStockStrengthData(true);
  });

  document.getElementById('btn-export-stock-csv')?.addEventListener('click', exportStockStrengthCSV);

  document.getElementById('btn-clear-stock-col-filters')?.addEventListener('click', () => {
    stockColFilters = {};
    stockSearchQuery = '';
    stockTrendFilter = 'ALL';
    stockRsSignalFilter = 'ALL';
    stockQuickPill = 'all';
    const searchInput = document.getElementById('stock-search-input');
    const clearBtn = document.getElementById('btn-clear-stock-search');
    if (searchInput) searchInput.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    const tEl = document.getElementById('stock-filter-trend');
    if (tEl) tEl.value = 'ALL';
    const rEl = document.getElementById('stock-filter-rs-signal');
    if (rEl) rEl.value = 'ALL';
    document.querySelectorAll('.stock-pill').forEach(p => p.classList.toggle('active', p.getAttribute('data-filter') === 'all'));
    closeExcelFilterPopover();
    renderStockStrengthTable();
  });

  enhanceTableHeadersWithExcelFilters();
}

function renderStockStrengthTable() {
  const tbody = document.getElementById('tbody-stock-strength');
  const counterEl = document.getElementById('stock-match-counter');
  if (!tbody || !stockStrengthData) return;

  let rows = [...(stockStrengthData.rows || [])];
  const total = rows.length;

  if (stockSearchQuery) {
    rows = rows.filter(r => (r.ticker && r.ticker.includes(stockSearchQuery)) || (r.symbol && r.symbol.includes(stockSearchQuery)));
  }
  if (stockTrendFilter !== 'ALL') {
    rows = rows.filter(r => r.trend === stockTrendFilter);
  }
  if (stockRsSignalFilter !== 'ALL') {
    rows = rows.filter(r => r.rs_signal === stockRsSignalFilter);
  }

  if (stockQuickPill === 'score5') {
    rows = rows.filter(r => r.score === 5);
  } else if (stockQuickPill === 'breakout') {
    rows = rows.filter(r => r.breakout === 'YES');
  } else if (stockQuickPill === 'accumulation') {
    rows = rows.filter(r => r.accumulation === 'ACCUMULATION');
  } else if (stockQuickPill === 'leaders') {
    rows = rows.filter(r => r.rs_signal === 'LEADER' || r.rs_signal === 'STRONG');
  }

  rows = rows.filter(r => rowMatchesColFilters(r, stockColFilters));
  updateColHeaderFilterIndicators('table-stock-strength', stockColFilters, 'btn-clear-stock-col-filters');

  sortDataRows(rows, stockSortCol, stockSortDir);
  lastFilteredStockRows = rows;

  if (counterEl) {
    counterEl.textContent = `Showing ${rows.length} of ${total} stocks`;
  }

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="18" style="text-align:center; padding: 48px; color: var(--text-muted);">No stocks matching the selected filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const liveIndicator = r.is_live_kite ? '<span class="live-dot" title="Live Kite LTP Quote" style="color:#10b981;font-size:0.7rem;margin-right:3px;">●</span>' : '';
    const rowJson = JSON.stringify(r).replace(/'/g, '&#39;').replace(/"/g, '&quot;');

    return `
      <tr>
        <td class="stock-ticker-cell">
          <span class="stock-sym-badge">${r.ticker}</span>
        </td>
        <td class="num font-mono">${liveIndicator}${fmtINR(r.price)}</td>
        <td class="font-mono" style="font-size:0.75rem; color:var(--text-muted);">${r.last_updated}</td>
        ${renderIndicatorCellsHTML(r)}
        <td style="text-align:center;">
          <button class="btn btn-sm btn-emerald" style="padding: 2px 8px; font-size: 0.68rem;" onclick='openTradeModalFromScreenerRow(${rowJson})' title="Log this stock into Trade Library with full indicator snapshot">
            + Trade
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function exportStockStrengthCSV() {
  if (!stockStrengthData || !stockStrengthData.rows || stockStrengthData.rows.length === 0) {
    showToast('No stock data available to export');
    return;
  }

  const headers = [
    'Ticker', 'Price', 'Last_Updated', 'SMA20', 'SMA50', 'SMA200',
    'Trend_Signal', 'RS_Value', 'RS_Rating', 'RS_Signal',
    'Vol_Today', 'Vol20', 'RVOL', 'Breakout_50D', 'Accumulation',
    'Momentum_Score', 'Volatility'
  ];

  const exportList = (lastFilteredStockRows && lastFilteredStockRows.length > 0)
    ? lastFilteredStockRows
    : stockStrengthData.rows;

  const rows = exportList.map(r => [
    `"${r.symbol || r.ticker + '.NS'}"`,
    r.price ?? '',
    `"${r.last_updated || ''}"`,
    r.sma20 ?? '',
    r.sma50 ?? '',
    r.sma200 ?? '',
    `"${r.trend || ''}"`,
    r.rs_score ?? '',
    r.rs_rating ?? '',
    `"${r.rs_signal || ''}"`,
    r.vol_today ?? '',
    r.vol20 ?? '',
    r.rvol ?? '',
    `"${r.breakout || ''}"`,
    `"${r.accumulation || ''}"`,
    r.score ?? '',
    r.volatility ?? ''
  ]);

  downloadCSV(`Strength_Indicators_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
}

