/**
 * Kite Pulse — Trade Library & Daily Indicator Snapshot Log Module
 * Uses unified indicator cell renderer, sorting, and CSV export helpers from state.js.
 */

function getTradeFlatRow(t) {
  const latestSnap = (Array.isArray(t.daily_snapshots) && t.daily_snapshots.length > 0)
    ? t.daily_snapshots[t.daily_snapshots.length - 1]
    : (t.snapshot || {});
  const entrySnap = t.snapshot || {};

  // Live fallback from loaded stock screener cache if snapshot doesn't have indicator values yet
  const symClean = (t.symbol || '').replace('.NS', '').toUpperCase();
  const liveRow = (stockStrengthData?.rows || []).find(r =>
    (r.ticker || '').toUpperCase() === symClean ||
    (r.symbol || '').replace('.NS', '').toUpperCase() === symClean
  ) || {};

  const pick = (key) => latestSnap[key] ?? entrySnap[key] ?? liveRow[key] ?? null;
  const ltp = latestSnap.price ?? liveRow.price ?? (t.status === 'CLOSED' ? t.exit_price : t.entry_price);

  return {
    ...t,
    ticker: t.symbol,
    price: ltp,
    last_updated: latestSnap.last_updated || entrySnap.last_updated || liveRow.last_updated || t.date,
    sma20: pick('sma20'),
    sma50: pick('sma50'),
    sma200: pick('sma200'),
    trend: pick('trend'),
    rs_score: pick('rs_score'),
    rs_rating: pick('rs_rating'),
    rs_signal: pick('rs_signal'),
    vol_today: pick('vol_today'),
    vol20: pick('vol20'),
    rvol: pick('rvol'),
    breakout: pick('breakout'),
    accumulation: pick('accumulation'),
    score: pick('score'),
    volatility: pick('volatility')
  };
}

function getPreparedLibraryRows() {
  return (libraryTrades || []).map(getTradeFlatRow);
}

function initTradeLibrary() {
  setupTradeLibraryListeners();
  enhanceTableHeadersWithExcelFilters();
  fetchTradeLibraryData();
}

function ensureTradeLibraryLoaded() {
  if (!libraryLoading && libraryTrades.length === 0) {
    fetchTradeLibraryData();
  } else {
    renderTradeLibraryTable();
  }
}

async function fetchTradeLibraryData() {
  if (libraryLoading) return;
  libraryLoading = true;

  try {
    const res = await fetch('/api/trades');
    const data = await res.json();
    if (data && data.success) {
      libraryTrades = data.trades || [];
      librarySummary = data.summary || {};
      updateLibraryKPIs();
      renderTradeLibraryTable();
    }
  } catch (err) {
    console.error('Failed to load trade library:', err);
    showToast('Failed to load trades library');
  } finally {
    libraryLoading = false;
  }
}

function updateLibraryKPIs() {
  const badge = document.getElementById('library-count-badge');
  if (badge) badge.textContent = librarySummary.total_trades ?? libraryTrades.length;

  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setVal('lib-kpi-total', librarySummary.total_trades ?? libraryTrades.length);
  setVal('lib-kpi-open', librarySummary.open_count ?? 0);
  setVal('lib-kpi-closed', librarySummary.closed_count ?? 0);

  const pnlEl = document.getElementById('lib-kpi-pnl');
  if (pnlEl) {
    const pnl = Number(librarySummary.realized_pnl || 0);
    pnlEl.textContent = `${pnl >= 0 ? '+' : ''}₹${pnl.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    pnlEl.className = 'kpi-val font-mono ' + (pnl > 0 ? 'text-emerald' : (pnl < 0 ? 'text-rose' : 'text-white'));
  }

  setVal('lib-kpi-winrate', `Win Rate: ${librarySummary.win_rate ?? 0.0}% (${librarySummary.closed_count ?? 0} closed)`);
  setVal('lib-kpi-ratio', `${librarySummary.win_count ?? 0}W / ${librarySummary.loss_count ?? 0}L`);
}

function setupTradeLibraryListeners() {
  document.getElementById('btn-open-new-trade-modal')?.addEventListener('click', () => openTradeEntryModal());
  document.getElementById('btn-close-trade-modal')?.addEventListener('click', closeTradeEntryModal);
  document.getElementById('btn-cancel-trade')?.addEventListener('click', closeTradeEntryModal);

  document.getElementById('form-trade-entry')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveTradeFromModal();
  });

  document.getElementById('btn-import-kite-trades')?.addEventListener('click', importTradesFromKite);
  document.getElementById('btn-sync-daily-snapshots')?.addEventListener('click', syncDailySnapshots);
  document.getElementById('btn-export-lib-csv')?.addEventListener('click', exportTradeLibraryCSV);

  document.getElementById('btn-close-history-modal')?.addEventListener('click', closeTradeHistoryModal);
  document.getElementById('btn-close-history-footer')?.addEventListener('click', closeTradeHistoryModal);

  bindSearchInput('lib-search-input', 'btn-clear-lib-search', (val) => {
    libSearchQuery = val.toLowerCase();
    renderTradeLibraryTable();
  });

  document.getElementById('lib-filter-status')?.addEventListener('change', (e) => {
    libStatusFilter = e.target.value;
    renderTradeLibraryTable();
  });

  document.getElementById('lib-filter-type')?.addEventListener('change', (e) => {
    libTypeFilter = e.target.value;
    renderTradeLibraryTable();
  });

  bindPillGroup('[data-lib-filter]', 'data-lib-filter', (val) => {
    libQuickFilter = val;
    renderTradeLibraryTable();
  });

  document.getElementById('btn-clear-lib-col-filters')?.addEventListener('click', () => {
    libColFilters = {};
    closeExcelFilterPopover();
    renderTradeLibraryTable();
  });
}

function openTradeEntryModal(existingTrade = null, screenerSnapshot = null) {
  const modal = document.getElementById('trade-modal');
  if (!modal) return;

  const setField = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val ?? '';
  };

  const title = document.getElementById('trade-modal-title');
  window._pendingTradeSnapshot = screenerSnapshot || (existingTrade ? existingTrade.snapshot : null);

  if (existingTrade) {
    if (title) title.textContent = `Edit Trade: ${existingTrade.symbol}`;
    setField('trade-edit-id', existingTrade.id);
    setField('trade-sym', existingTrade.symbol);
    setField('trade-type', existingTrade.trade_type || 'BUY');
    setField('trade-status', existingTrade.status || 'OPEN');
    setField('trade-strategy', existingTrade.strategy || '');
    setField('trade-qty', existingTrade.quantity || 1);
    setField('trade-entry', existingTrade.entry_price || '');
    setField('trade-exit', existingTrade.exit_price ?? '');
    setField('trade-target', existingTrade.target ?? '');
    setField('trade-sl', existingTrade.stop_loss ?? '');
    setField('trade-date', existingTrade.date || '');
    setField('trade-exit-date', existingTrade.exit_date || '');
    setField('trade-notes', existingTrade.notes || '');
  } else if (screenerSnapshot) {
    const sym = (screenerSnapshot.ticker || screenerSnapshot.symbol || '').replace('.NS', '');
    const price = screenerSnapshot.price || 0;
    const strat = screenerSnapshot.breakout === 'YES'
      ? '50D Breakout Setup'
      : (screenerSnapshot.accumulation === 'ACCUMULATION' ? 'Heavy Accumulation' : 'Relative Strength Momentum');

    if (title) title.textContent = `Log Trade: ${sym} (From Screener Snapshot)`;
    setField('trade-edit-id', '');
    setField('trade-sym', sym);
    setField('trade-type', 'BUY');
    setField('trade-status', 'OPEN');
    setField('trade-strategy', strat);
    setField('trade-qty', '100');
    setField('trade-entry', price);
    setField('trade-exit', '');
    setField('trade-target', price ? (price * 1.10).toFixed(2) : '');
    setField('trade-sl', screenerSnapshot.sma20 ? screenerSnapshot.sma20.toFixed(2) : (price ? (price * 0.95).toFixed(2) : ''));
    setField('trade-date', new Date().toISOString().slice(0, 10));
    setField('trade-exit-date', '');
    setField('trade-notes', `Captured from Screener: Trend=${screenerSnapshot.trend}, RS=${screenerSnapshot.rs_score?.toFixed(3)}, RVOL=${screenerSnapshot.rvol?.toFixed(2)}x, Score=${screenerSnapshot.score}/5`);
  } else {
    if (title) title.textContent = 'Log New Trade';
    setField('trade-edit-id', '');
    setField('trade-sym', '');
    setField('trade-type', 'BUY');
    setField('trade-status', 'OPEN');
    setField('trade-strategy', 'Covered Call / Momentum');
    setField('trade-qty', '100');
    setField('trade-entry', '');
    setField('trade-exit', '');
    setField('trade-target', '');
    setField('trade-sl', '');
    setField('trade-date', new Date().toISOString().slice(0, 10));
    setField('trade-exit-date', '');
    setField('trade-notes', '');
  }

  modal.style.display = 'flex';
}

function openTradeModalFromScreenerRow(row) {
  openTradeEntryModal(null, row);
}

function closeTradeEntryModal() {
  const modal = document.getElementById('trade-modal');
  if (modal) modal.style.display = 'none';
}

async function saveTradeFromModal() {
  const editId = document.getElementById('trade-edit-id')?.value;
  const symbol = document.getElementById('trade-sym')?.value.trim().toUpperCase();
  const trade_type = document.getElementById('trade-type')?.value;
  const status = document.getElementById('trade-status')?.value;
  const strategy = document.getElementById('trade-strategy')?.value.trim();
  const quantity = parseFloat(document.getElementById('trade-qty')?.value);
  const entry_price = parseFloat(document.getElementById('trade-entry')?.value);
  const exitVal = document.getElementById('trade-exit')?.value;
  const exit_price = exitVal !== '' ? parseFloat(exitVal) : null;
  const targetVal = document.getElementById('trade-target')?.value;
  const target = targetVal !== '' ? parseFloat(targetVal) : null;
  const slVal = document.getElementById('trade-sl')?.value;
  const stop_loss = slVal !== '' ? parseFloat(slVal) : null;
  const date = document.getElementById('trade-date')?.value || null;
  const exit_date = document.getElementById('trade-exit-date')?.value || null;
  const notes = document.getElementById('trade-notes')?.value.trim();

  if (!symbol || isNaN(quantity) || isNaN(entry_price)) {
    showToast('⚠️ Symbol, Quantity, and Entry Price are required.');
    return;
  }

  const payload = {
    symbol,
    trade_type,
    status,
    strategy,
    quantity,
    entry_price,
    exit_price,
    target,
    stop_loss,
    date,
    exit_date: status === 'CLOSED' ? (exit_date || new Date().toISOString().slice(0, 10)) : null,
    notes,
    snapshot: window._pendingTradeSnapshot || null
  };

  try {
    const res = await fetch(editId ? `/api/trades/${editId}` : '/api/trades', {
      method: editId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(editId ? `✅ Trade for ${symbol} updated.` : `🎉 Trade for ${symbol} saved to Library!`);
      closeTradeEntryModal();
      await fetchTradeLibraryData();
    } else {
      showToast(`⚠️ Error: ${data.detail || 'Could not save trade'}`);
    }
  } catch (err) {
    console.error('Error saving trade:', err);
    showToast('⚠️ Network error saving trade.');
  }
}

async function deleteTradeFromLibrary(tradeId, symbol) {
  if (!confirm(`Are you sure you want to delete the trade for ${symbol}?`)) return;

  try {
    const res = await fetch(`/api/trades/${tradeId}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`🗑️ Trade for ${symbol} deleted.`);
      await fetchTradeLibraryData();
    } else {
      showToast(`⚠️ Could not delete trade: ${data.detail || 'Error'}`);
    }
  } catch (err) {
    console.error('Delete trade error:', err);
    showToast('⚠️ Error deleting trade.');
  }
}

async function markTradeClosedPrompt(trade) {
  const currentExit = trade.exit_price || trade.entry_price || '';
  const exitInput = prompt(`Enter exit price for ${trade.symbol} (Quantity: ${trade.quantity}):`, currentExit);
  if (exitInput === null) return;
  const exitPrice = parseFloat(exitInput);
  if (isNaN(exitPrice) || exitPrice <= 0) {
    showToast('⚠️ Invalid exit price');
    return;
  }

  try {
    const res = await fetch(`/api/trades/${trade.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'CLOSED',
        exit_price: exitPrice,
        exit_date: new Date().toISOString().slice(0, 10)
      })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ Trade ${trade.symbol} closed at ₹${exitPrice}. P&L: ₹${data.trade?.pnl}`);
      await fetchTradeLibraryData();
    }
  } catch (err) {
    console.error('Error closing trade:', err);
    showToast('⚠️ Error updating trade');
  }
}

async function importTradesFromKite() {
  const btn = document.getElementById('btn-import-kite-trades');
  btn?.classList.add('loading');

  try {
    const res = await fetch('/api/trades/import-kite', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`🎉 ${data.message}`);
      await fetchTradeLibraryData();
    } else {
      showToast(`⚠️ ${data.detail || 'Could not import from Kite'}`);
    }
  } catch (err) {
    console.error('Error importing Kite trades:', err);
    showToast('⚠️ Failed to import from Kite');
  } finally {
    btn?.classList.remove('loading');
  }
}

function renderTradeLibraryTable() {
  const tbody = document.getElementById('tbody-trades-library');
  const counterEl = document.getElementById('lib-match-counter');
  if (!tbody) return;

  let flatList = getPreparedLibraryRows();
  const total = flatList.length;

  if (libSearchQuery) {
    flatList = flatList.filter(t =>
      (t.symbol && t.symbol.toLowerCase().includes(libSearchQuery)) ||
      (t.strategy && t.strategy.toLowerCase().includes(libSearchQuery)) ||
      (t.notes && t.notes.toLowerCase().includes(libSearchQuery))
    );
  }
  if (libStatusFilter !== 'ALL') {
    flatList = flatList.filter(t => t.status === libStatusFilter);
  }
  if (libTypeFilter !== 'ALL') {
    flatList = flatList.filter(t => t.trade_type === libTypeFilter);
  }

  if (libQuickFilter === 'open') {
    flatList = flatList.filter(t => t.status === 'OPEN');
  } else if (libQuickFilter === 'closed') {
    flatList = flatList.filter(t => t.status === 'CLOSED');
  } else if (libQuickFilter === 'winners') {
    flatList = flatList.filter(t => (t.pnl || 0) > 0);
  } else if (libQuickFilter === 'losers') {
    flatList = flatList.filter(t => (t.pnl || 0) < 0);
  }

  flatList = flatList.filter(r => rowMatchesColFilters(r, libColFilters));
  updateColHeaderFilterIndicators('table-trades-library', libColFilters, 'btn-clear-lib-col-filters');

  sortDataRows(flatList, libSortCol, libSortDir);

  if (counterEl) {
    counterEl.textContent = `Showing ${flatList.length} of ${total} trades`;
  }

  if (flatList.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="28" style="text-align:center; padding: 48px; color: var(--text-muted);">
          No stored trades matching filters. Click <strong>+ Log Trade</strong> or <strong>Import Kite</strong> to store your first trade.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = flatList.map(t => {
    const isBuy = (t.trade_type || 'BUY') === 'BUY';
    const typeBadge = `<span class="badge-trade-type ${isBuy ? 'BUY' : 'SELL'}">${t.trade_type || 'BUY'}</span>`;
    const statusBadge = `<span class="badge-trade-status ${t.status || 'OPEN'}">${t.status || 'OPEN'}</span>`;

    let pnlHtml = '<span style="color:var(--text-muted); opacity:0.4;">—</span>';
    let pnlPctHtml = '<span style="color:var(--text-muted); opacity:0.4;">—</span>';
    if (t.pnl !== null && t.pnl !== undefined) {
      const pnlVal = Number(t.pnl);
      const colorClass = pnlVal > 0 ? 'text-emerald' : (pnlVal < 0 ? 'text-rose' : 'text-white');
      pnlHtml = `<span class="font-mono ${colorClass}" style="font-weight:700;">${pnlVal >= 0 ? '+' : ''}₹${pnlVal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`;
    }
    if (t.pnl_pct !== null && t.pnl_pct !== undefined) {
      const pctVal = Number(t.pnl_pct);
      const colorClass = pctVal > 0 ? 'text-emerald' : (pctVal < 0 ? 'text-rose' : 'text-white');
      pnlPctHtml = `<span class="font-mono ${colorClass}" style="font-weight:700;">${pctVal >= 0 ? '+' : ''}${pctVal.toFixed(2)}%</span>`;
    }

    const tradeJson = JSON.stringify(t).replace(/"/g, '&quot;');
    const dailyCount = Array.isArray(t.daily_snapshots) ? t.daily_snapshots.length : 0;

    return `
      <tr>
        <td class="stock-ticker-cell">
          <strong style="color: #fff;">${t.symbol}</strong>
          ${t.source === 'KITE_IMPORT' ? '<span class="badge-live-kite" style="font-size:0.6rem; padding:1px 4px;" title="Imported from Zerodha Kite">Kite</span>' : ''}
        </td>
        <td>${typeBadge}</td>
        <td>${statusBadge}</td>
        <td class="num font-mono">${fmtInt(t.quantity || 0)}</td>
        <td class="num font-mono">${fmtINR(t.entry_price || 0)}</td>
        <td class="num font-mono">${fmtINR(t.price)}</td>
        <td class="num">${pnlHtml}</td>
        <td class="num">${pnlPctHtml}</td>

        ${renderIndicatorCellsHTML(t)}

        <td style="color: var(--text-secondary);">${t.strategy || '—'}</td>
        <td class="num font-mono">${fmtINR(t.target)}</td>
        <td class="num font-mono">${fmtINR(t.stop_loss)}</td>
        <td class="font-mono" style="font-size: 0.72rem; color: var(--text-muted);">${t.date || '—'}</td>
        <td>
          <button class="btn btn-sm btn-outline" style="padding: 2px 7px; font-size: 0.68rem;" onclick='openTradeHistoryModal(${tradeJson})' title="View daily indicator log history">
            📊 ${dailyCount}d Log
          </button>
        </td>
        <td style="text-align: center;">
          <div class="trade-actions-cell">
            ${t.status === 'OPEN' ? `<button class="btn-trade-action action-close" onclick='markTradeClosedPrompt(${tradeJson})' title="Close Trade">Close</button>` : ''}
            <button class="btn-trade-action" onclick='openTradeEntryModal(${tradeJson})' title="Edit Trade">Edit</button>
            <button class="btn-trade-action action-delete" onclick="deleteTradeFromLibrary('${t.id}', '${t.symbol}')" title="Delete Trade">&times;</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function exportTradeLibraryCSV() {
  const flatTrades = getPreparedLibraryRows();
  if (!flatTrades || flatTrades.length === 0) {
    showToast('No trades in library to export');
    return;
  }

  const headers = [
    'ID', 'Ticker', 'Type', 'Status', 'Quantity', 'Entry_Price', 'Price_LTP',
    'PnL', 'PnL_Pct', 'SMA20', 'SMA50', 'SMA200', 'Trend_Signal', 'RS_Value',
    'RS_Rating', 'RS_Signal', 'Vol_Today', 'Vol20', 'RVOL', 'Breakout_50D',
    'Accumulation', 'Momentum', 'Volatility_Pct', 'Strategy', 'Target', 'Stop_Loss',
    'Entry_Date', 'Exit_Date', 'Source', 'Notes'
  ];

  const rows = flatTrades.map(t => [
    `"${t.id || ''}"`,
    `"${t.symbol || ''}"`,
    `"${t.trade_type || 'BUY'}"`,
    `"${t.status || 'OPEN'}"`,
    t.quantity ?? '',
    t.entry_price ?? '',
    t.price ?? '',
    t.pnl ?? '',
    t.pnl_pct ?? '',
    t.sma20 ?? '',
    t.sma50 ?? '',
    t.sma200 ?? '',
    `"${t.trend || ''}"`,
    t.rs_score ?? '',
    t.rs_rating ?? '',
    `"${t.rs_signal || ''}"`,
    t.vol_today ?? '',
    t.vol20 ?? '',
    t.rvol ?? '',
    `"${t.breakout || ''}"`,
    `"${t.accumulation || ''}"`,
    t.score ?? '',
    t.volatility ?? '',
    `"${(t.strategy || '').replace(/"/g, '""')}"`,
    t.target ?? '',
    t.stop_loss ?? '',
    `"${t.date || ''}"`,
    `"${t.exit_date || ''}"`,
    `"${t.source || 'MANUAL'}"`,
    `"${(t.notes || '').replace(/"/g, '""')}"`
  ]);

  downloadCSV(`Trades_Library_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
}

async function syncDailySnapshots() {
  const btn = document.getElementById('btn-sync-daily-snapshots');
  btn?.classList.add('loading');

  try {
    const res = await fetch('/api/trades/sync-snapshots', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ ${data.message}`);
      await fetchTradeLibraryData();
    } else {
      showToast(`⚠️ ${data.detail || 'Could not sync snapshots'}`);
    }
  } catch (err) {
    console.error('Error syncing snapshots:', err);
    showToast('⚠️ Network error syncing snapshots');
  } finally {
    btn?.classList.remove('loading');
  }
}

function openTradeHistoryModal(trade) {
  const modal = document.getElementById('trade-history-modal');
  if (!modal) return;

  const titleEl = document.getElementById('history-modal-title');
  if (titleEl) {
    titleEl.textContent = `Daily Log & Indicator Progression — ${trade.symbol}`;
  }

  const summaryEl = document.getElementById('history-trade-summary');
  if (summaryEl) {
    const statusClass = trade.status === 'OPEN' ? 'text-cyan' : 'text-emerald';
    summaryEl.innerHTML = `
      <div><span style="color:var(--text-muted); font-size:0.75rem;">Status:</span> <strong class="${statusClass}">${trade.status}</strong></div>
      <div><span style="color:var(--text-muted); font-size:0.75rem;">Type:</span> <strong>${trade.trade_type}</strong></div>
      <div><span style="color:var(--text-muted); font-size:0.75rem;">Quantity:</span> <strong class="font-mono">${trade.quantity}</strong></div>
      <div><span style="color:var(--text-muted); font-size:0.75rem;">Entry Price:</span> <strong class="font-mono">${fmtINR(trade.entry_price || 0)}</strong></div>
      <div><span style="color:var(--text-muted); font-size:0.75rem;">Entry Date:</span> <strong class="font-mono">${trade.date || '—'}</strong></div>
      ${trade.exit_price ? `<div><span style="color:var(--text-muted); font-size:0.75rem;">Exit Price:</span> <strong class="font-mono">${fmtINR(trade.exit_price)}</strong></div>` : ''}
      ${trade.pnl ? `<div><span style="color:var(--text-muted); font-size:0.75rem;">Realized PnL:</span> <strong class="font-mono ${trade.pnl > 0 ? 'text-emerald' : 'text-rose'}">${fmtINR(trade.pnl)} (${trade.pnl_pct}%)</strong></div>` : ''}
    `;
  }

  const tbody = document.getElementById('tbody-trade-history');
  if (tbody) {
    const snapshots = Array.isArray(trade.daily_snapshots) ? trade.daily_snapshots : [];
    if (snapshots.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="16" style="text-align:center; padding:32px; color:var(--text-muted);">
            No daily snapshots recorded yet for ${trade.symbol}. Click <strong>Sync Today's Data</strong> to capture current indicator values.
          </td>
        </tr>
      `;
    } else {
      tbody.innerHTML = snapshots.map(s => `
        <tr>
          <td class="font-mono" style="font-weight:700; color:#fff;">${s.date} <span style="font-size:0.68rem; color:var(--text-muted); font-weight:normal;">${s.timestamp ? s.timestamp.slice(11) : ''}</span></td>
          <td class="num font-mono font-bold" style="color:var(--cyan);">${fmtINR(s.price || 0)}</td>
          ${renderIndicatorCellsHTML(s)}
        </tr>
      `).join('');
    }
  }

  modal.style.display = 'flex';
}

function closeTradeHistoryModal() {
  const modal = document.getElementById('trade-history-modal');
  if (modal) modal.style.display = 'none';
}

