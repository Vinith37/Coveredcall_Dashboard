/**
 * Kite Pulse — Application Coordinator & Entrypoint
 * Orchestrates tab navigation, top-level KPIs, cache countdown, and module initialization.
 */

document.addEventListener('DOMContentLoaded', async () => {
  initEventListeners();
  initCanvas();

  await checkUrlForKiteAuthToken();

  try {
    const modeRes = await fetch('/api/engine/mode');
    const modeData = await modeRes.json();
    if (modeData && modeData.mode) {
      currentEngineMode = modeData.mode;
      syncEngineModeUI(currentEngineMode);
    }
  } catch (e) {
    console.error('Failed to load initial engine mode:', e);
  }

  fetchData();
  initStockStrength();
  initTradeLibrary();
});

function initEventListeners() {
  // Chart Style Toggle (Pulse vs StockCharts)
  document.querySelectorAll('[data-style]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-style]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chartStyle = btn.getAttribute('data-style');
      canvasWrapper?.classList.toggle('sc-style', chartStyle === 'SC');
      renderRRGCanvas();
    });
  });

  initScPanel();

  // Engine Mode Toggle (yfinance vs Kite API)
  document.getElementById('btn-mode-yfinance')?.addEventListener('click', () => setEngineMode('yfinance'));
  document.getElementById('btn-mode-kite')?.addEventListener('click', () => setEngineMode('kite'));

  // Header Refresh Button
  document.getElementById('btn-refresh')?.addEventListener('click', () => {
    const activeTab = document.querySelector('.tab-btn.active')?.getAttribute('data-tab');
    fetchData(true);
    if (activeTab === 'tab-stock-strength' || stockStrengthData) {
      fetchStockStrengthData(true);
    }
  });

  // Tab Navigation
  const tfControl = document.getElementById('timeframe-control');
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

      const targetTab = btn.getAttribute('data-tab');
      btn.classList.add('active');
      document.getElementById(targetTab)?.classList.add('active');

      if (tfControl) {
        tfControl.style.display = targetTab === 'tab-rrg' ? 'flex' : 'none';
      }

      if (targetTab === 'tab-rrg') {
        resizeCanvas();
        renderRRGCanvas();
        setTimeout(updateScPanel, 30);
      } else if (targetTab === 'tab-stock-strength') {
        ensureStockStrengthLoaded();
      } else if (targetTab === 'tab-library') {
        ensureTradeLibraryLoaded();
      }
    });
  });

  // Timeframe Toggle (Daily / Weekly)
  document.querySelectorAll('.segment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTimeframe = btn.getAttribute('data-tf');
      const tfBadge = document.getElementById('rrg-tf-badge');
      if (tfBadge) tfBadge.textContent = currentTimeframe.toUpperCase();
      scStopAnimation();
      scEndOffset = 0;
      resetPanZoom();
      updateTopIndicators();
      renderAll();
    });
  });

  // Quadrant Filter Pills
  bindPillGroup('.filter-pill', 'data-q', (val) => {
    currentQuadrantFilter = val;
    renderRRGCanvas();
    renderRRGTable();
  });

  // Visualizer Focus View: Cluster vs All
  const btnFocusCluster = document.getElementById('btn-focus-cluster');
  const btnFitAll = document.getElementById('btn-fit-all');

  btnFocusCluster?.addEventListener('click', () => {
    btnFocusCluster.classList.add('active');
    btnFitAll?.classList.remove('active');
    focusMode = 'CLUSTER';
    resetPanZoom();
    renderRRGCanvas();
  });

  btnFitAll?.addEventListener('click', () => {
    btnFitAll.classList.add('active');
    btnFocusCluster?.classList.remove('active');
    focusMode = 'ALL';
    resetPanZoom();
    renderRRGCanvas();
  });

  document.getElementById('btn-toggle-outlier-fit')?.addEventListener('click', () => {
    btnFitAll?.click();
  });

  // Label Density Buttons
  const labelBtns = [
    { el: document.getElementById('btn-labels-staggered'), mode: 'STAGGERED' },
    { el: document.getElementById('btn-labels-leaders'), mode: 'LEADERS' },
    { el: document.getElementById('btn-labels-hover'), mode: 'HOVER' }
  ];
  labelBtns.forEach(({ el, mode }) => {
    el?.addEventListener('click', () => {
      labelBtns.forEach(b => b.el?.classList.remove('active'));
      el.classList.add('active');
      labelMode = mode;
      renderRRGCanvas();
    });
  });

  // Tail Length Quick Preset Buttons
  document.querySelectorAll('[data-tails]').forEach(btn => {
    btn.addEventListener('click', () => {
      const len = parseInt(btn.getAttribute('data-tails'), 10);
      syncTailControls(len);
      scEndOffset = Math.min(scEndOffset, scMaxOffset());
      renderRRGCanvas();
    });
  });

  // Zoom Buttons
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
    zoomLevel = Math.min(zoomLevel * 1.25, 4.0);
    updateZoomDisplay();
    renderRRGCanvas();
  });

  document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
    zoomLevel = Math.max(zoomLevel / 1.25, 0.4);
    updateZoomDisplay();
    renderRRGCanvas();
  });

  document.getElementById('btn-zoom-reset')?.addEventListener('click', () => {
    resetPanZoom();
    renderRRGCanvas();
  });

  // Spotlight Close Button
  document.getElementById('btn-close-spotlight')?.addEventListener('click', () => {
    clearSectorSelection();
    renderRRGCanvas();
    renderRRGTable();
  });

  // Sector Strength Filters & Search
  document.getElementById('strength-search')?.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    renderStrengthTable();
  });

  document.getElementById('btn-clear-sector-col-filters')?.addEventListener('click', () => {
    sectorColFilters = {};
    searchQuery = '';
    const sEl = document.getElementById('strength-search');
    if (sEl) sEl.value = '';
    closeExcelFilterPopover();
    renderStrengthTable();
  });

  // Kite Modal Handlers
  document.getElementById('btn-open-kite')?.addEventListener('click', openKiteModal);
  document.getElementById('btn-close-kite')?.addEventListener('click', closeKiteModal);
  document.getElementById('btn-done-kite')?.addEventListener('click', closeKiteModal);
  document.getElementById('btn-submit-token')?.addEventListener('click', submitKiteToken);
  document.getElementById('btn-disconnect-kite')?.addEventListener('click', disconnectKite);

  window.addEventListener('resize', () => {
    resizeCanvas();
    renderRRGCanvas();
  });
}

async function fetchData(forceRefresh = false) {
  const refreshBtn = document.getElementById('btn-refresh');
  const refreshIcon = refreshBtn?.querySelector('.refresh-icon');
  refreshIcon?.classList.add('spin');

  try {
    const url = forceRefresh ? `/api/refresh?mode=${currentEngineMode}` : `/api/data?mode=${currentEngineMode}`;
    const method = forceRefresh ? 'POST' : 'GET';
    const res = await fetch(url, { method });
    const json = await res.json();

    dashboardData = json.data || json;
    if (dashboardData && dashboardData.engine_mode) {
      currentEngineMode = dashboardData.engine_mode;
    }
    syncEngineModeUI(currentEngineMode);
    updateTopIndicators();
    renderAll();
    setTimeout(updateScPanel, 50);
    startCacheCountdown();
    if (forceRefresh) {
      showToast('⚡ Sector RRG & Matrix refreshed');
    }
  } catch (err) {
    console.error('Fetch error:', err);
    showToast('Failed to load sector data');
  } finally {
    refreshIcon?.classList.remove('spin');
  }
}

function updateTopIndicators() {
  if (!dashboardData) return;

  const regime = dashboardData.regime || {};
  const niftyValEl = document.getElementById('regime-nifty-val');
  const regimeBadgeEl = document.getElementById('regime-badge');
  const regimePill = document.getElementById('market-regime-pill');

  if (regime.nifty_close) {
    if (niftyValEl) niftyValEl.textContent = `₹${regime.nifty_close.toLocaleString()} (SMA50: ₹${regime.nifty_sma50?.toLocaleString()})`;
    const priceEl = document.getElementById('kpi-nifty-price');
    const smaEl = document.getElementById('kpi-nifty-sma');
    if (priceEl) priceEl.textContent = `₹${regime.nifty_close.toLocaleString()}`;
    if (smaEl) smaEl.textContent = `SMA 50: ₹${regime.nifty_sma50?.toLocaleString()}`;
  }

  if (regime.healthy) {
    if (regimeBadgeEl) {
      regimeBadgeEl.textContent = 'HEALTHY';
      regimeBadgeEl.className = 'regime-status-badge text-emerald';
    }
    regimePill?.classList.remove('weak');
  } else {
    if (regimeBadgeEl) {
      regimeBadgeEl.textContent = 'WEAK';
      regimeBadgeEl.className = 'regime-status-badge text-rose';
    }
    regimePill?.classList.add('weak');
  }

  const cacheStatus = dashboardData.cache_status || {};
  const tokenStats = dashboardData.token_stats || {};
  remainingCacheSeconds = cacheStatus.remaining_ttl_seconds || 900;

  const tokenCountEl = document.getElementById('token-count-display');
  const sourceNameEl = document.getElementById('source-name');

  if (currentEngineMode === 'kite') {
    if (tokenCountEl) tokenCountEl.textContent = `${tokenStats.kite_tokens_used || 1} Kite Token (Live)`;
    if (sourceNameEl) sourceNameEl.textContent = cacheStatus.source || 'Zerodha Kite API';
  } else {
    if (tokenCountEl) tokenCountEl.textContent = '0 Kite Tokens';
    if (sourceNameEl) sourceNameEl.textContent = cacheStatus.source || 'yfinance (Zero-Token)';
  }

  const rrgList = currentTimeframe === 'daily' ? dashboardData.daily_rrg : dashboardData.weekly_rrg;
  const strengthList = dashboardData.strength_indicators || [];

  const setKpi = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  setKpi('kpi-leading-count', (rrgList || []).filter(x => x.quadrant === 'LEADING').length);
  setKpi('kpi-improving-count', (rrgList || []).filter(x => x.quadrant === 'IMPROVING').length);
  setKpi('kpi-breakouts-count', strengthList.filter(x => x.breakout === 'YES').length);
  setKpi('kpi-accumulation-count', strengthList.filter(x => x.accumulation === 'ACCUMULATION').length);

  const kiteStatus = dashboardData.kite_status;
  const kiteBtnText = document.getElementById('kite-btn-text');
  const openKiteBtn = document.getElementById('btn-open-kite');
  if (kiteStatus && kiteStatus.is_connected) {
    if (kiteBtnText) kiteBtnText.textContent = `Kite (${kiteStatus.user_name || 'Active'})`;
    openKiteBtn?.classList.add('btn-emerald');
  } else {
    if (kiteBtnText) kiteBtnText.textContent = 'Kite Connect';
    openKiteBtn?.classList.remove('btn-emerald');
  }
}

function startCacheCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  const timerEl = document.getElementById('cache-timer');

  const tick = () => {
    if (remainingCacheSeconds <= 0) {
      if (timerEl) timerEl.textContent = 'Cache Refreshing...';
      return;
    }
    const mins = Math.floor(remainingCacheSeconds / 60);
    const secs = remainingCacheSeconds % 60;
    if (timerEl) timerEl.textContent = `Cache TTL: ${mins}:${secs.toString().padStart(2, '0')}`;
    remainingCacheSeconds--;
  };

  tick();
  countdownTimer = setInterval(tick, 1000);
}

function renderAll() {
  populateSectorChips();
  renderRRGCanvas();
  renderRRGTable();
  renderStrengthTable();
}
