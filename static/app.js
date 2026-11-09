/**
 * Kite Pulse — Relative Strength & RRG Institutional Sector Dashboard
 * Enhanced Visualization Engine with Locked 1:1 Aspect Ratio (True Square),
 * True Circular Distance Rings, Anti-Collision Labels, and Clean Outlier Handling.
 */

// Global State
let dashboardData = null;
let chartStyle = 'PULSE'; // 'PULSE' (dark) or 'SC' (StockCharts-style)
let scTailLen = 8;        // Active tail length (bars), synced between toolbar & slider
let scEndOffset = 0;      // Bars back from latest (0 = latest)
let scTimer = null;       // Animation interval handle
let currentEngineMode = 'yfinance'; // 'yfinance' or 'kite'
let currentTimeframe = 'daily'; // 'daily' or 'weekly'
let currentQuadrantFilter = 'ALL';
let hoveredSector = null;
let selectedSector = null;

// Visualization Controls State
let focusMode = 'CLUSTER'; // 'CLUSTER' (default: zooms on core cluster) or 'ALL'
let labelMode = 'STAGGERED'; // 'STAGGERED', 'LEADERS', 'HOVER'

// Zoom & Pan State
let zoomLevel = 1.0;
let panOffsetX = 0;
let panOffsetY = 0;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let hasDragged = false;
let initialPanX = 0;
let initialPanY = 0;

// Sector Matrix Sort & Filter State
let strengthSortCol = 'score';
let strengthSortAsc = false;
let searchQuery = '';
let filterTrend = 'ALL';
let filterRsSignal = 'ALL';
let sectorColFilters = {};

// Stock Screener Sort & Filter State
let stockStrengthData = null;
let stockStrengthLoading = false;
let stockSortCol = 'score';
let stockSortDir = 'desc';
let stockSearchQuery = '';
let stockTrendFilter = 'ALL';
let stockRsSignalFilter = 'ALL';
let stockQuickPill = 'all';
let stockColFilters = {};
let lastFilteredStockRows = [];
let activeExcelPopover = null;

let countdownTimer = null;
let remainingCacheSeconds = 900;

// Color Constants
const QUAD_COLORS = {
  LEADING: { stroke: '#10b981', fill: 'rgba(16, 185, 129, 0.25)', bg: 'rgba(16, 185, 129, 0.05)', text: '#10b981', chipClass: 'chip-leading', badgeClass: 'quad-leading' },
  IMPROVING: { stroke: '#06b6d4', fill: 'rgba(6, 182, 212, 0.25)', bg: 'rgba(6, 182, 212, 0.05)', text: '#06b6d4', chipClass: 'chip-improving', badgeClass: 'quad-improving' },
  WEAKENING: { stroke: '#f59e0b', fill: 'rgba(245, 158, 11, 0.25)', bg: 'rgba(245, 158, 11, 0.05)', text: '#f59e0b', chipClass: 'chip-weakening', badgeClass: 'quad-weakening' },
  LAGGING: { stroke: '#f43f5e', fill: 'rgba(244, 63, 94, 0.25)', bg: 'rgba(244, 63, 94, 0.05)', text: '#f43f5e', chipClass: 'chip-lagging', badgeClass: 'quad-lagging' }
};

const SC_QUAD = { LEADING: '#1e9e1e', IMPROVING: '#2a45d6', WEAKENING: '#f2c200', LAGGING: '#e01010' };

// DOM Elements
const canvas = document.getElementById('rrg-canvas');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('rrg-tooltip');
const canvasWrapper = document.getElementById('canvas-wrapper');
const spotlightCard = document.getElementById('sector-spotlight-card');
const sectorChipsBar = document.getElementById('sector-chips-bar');
const outlierPill = document.getElementById('outlier-alert-pill');

// =================================================================
// INITIALIZATION
// =================================================================
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

async function checkUrlForKiteAuthToken() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const kiteAuth = urlParams.get('kite_auth');
    const reqToken = urlParams.get('request_token');
    const status = urlParams.get('status');

    if (kiteAuth === 'success') {
      window.history.replaceState({}, document.title, window.location.pathname);
      currentEngineMode = 'kite';
      syncEngineModeUI('kite');
      showToast('🎉 Connected to Zerodha Kite Connect (Live Mode Active)!');
      return;
    }

    if (kiteAuth === 'error') {
      const reason = urlParams.get('reason') || 'Token exchange failed';
      window.history.replaceState({}, document.title, window.location.pathname);
      showToast(`⚠️ Kite Auth Error: ${reason}`);
      return;
    }

    if (reqToken && status === 'success') {
      window.history.replaceState({}, document.title, window.location.pathname);
      const res = await fetch('/api/kite/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_token: reqToken.trim() })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        currentEngineMode = 'kite';
        syncEngineModeUI('kite');
        showToast(`🎉 Connected to Zerodha Kite as ${data.session?.user_name || 'User'}!`);
      } else {
        showToast(`⚠️ Kite Auth Error: ${data.detail || 'Token expired or invalid'}`);
      }
    }
  } catch (e) {
    console.error('Auto Kite auth check error:', e);
  }
}

function showToast(msg) {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed; bottom: 24px; right: 24px; background: #10b981; color: #fff;
    padding: 12px 20px; border-radius: 10px; font-weight: 700; font-size: 0.85rem;
    box-shadow: 0 10px 30px rgba(0,0,0,0.5); z-index: 9999; animation: fadeIn 0.3s ease;
  `;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

function syncTailControls(newLen) {
  scTailLen = newLen;
  const slider = document.getElementById('sc-tail-slider');
  if (slider && parseInt(slider.value, 10) !== newLen) {
    slider.value = newLen;
  }
  document.querySelectorAll('[data-tails]').forEach(btn => {
    const btnVal = parseInt(btn.getAttribute('data-tails'), 10);
    btn.classList.toggle('active', btnVal === newLen);
  });
}

function clearSectorSelection() {
  selectedSector = null;
  if (spotlightCard) spotlightCard.style.display = 'none';
  document.querySelectorAll('.sector-chip').forEach(c => c.classList.remove('active'));
  document.querySelector('.sector-chip[data-symbol="ALL"]')?.classList.add('active');
}

function initEventListeners() {
  // Chart Style Toggle (Pulse vs StockCharts)
  document.querySelectorAll('[data-style]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-style]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chartStyle = btn.getAttribute('data-style');
      canvasWrapper.classList.toggle('sc-style', chartStyle === 'SC');
      renderRRGCanvas();
    });
  });

  initScPanel();

  // Engine Mode Toggle (yfinance vs Kite API)
  document.getElementById('btn-mode-yfinance')?.addEventListener('click', () => setEngineMode('yfinance'));
  document.getElementById('btn-mode-kite')?.addEventListener('click', () => setEngineMode('kite'));

  // Header Refresh Button — refreshes sector data and stock screener if active/loaded
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
      document.getElementById('rrg-tf-badge').textContent = currentTimeframe.toUpperCase();
      scStopAnimation();
      scEndOffset = 0;
      resetPanZoom();
      updateTopIndicators();
      renderAll();
    });
  });

  // Quadrant Filter Pills
  document.querySelectorAll('.filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentQuadrantFilter = pill.getAttribute('data-q');
      renderRRGCanvas();
      renderRRGTable();
    });
  });

  // Visualizer Focus View: Cluster vs All
  const btnFocusCluster = document.getElementById('btn-focus-cluster');
  const btnFitAll = document.getElementById('btn-fit-all');

  btnFocusCluster?.addEventListener('click', () => {
    btnFocusCluster.classList.add('active');
    btnFitAll.classList.remove('active');
    focusMode = 'CLUSTER';
    resetPanZoom();
    renderRRGCanvas();
  });

  btnFitAll?.addEventListener('click', () => {
    btnFitAll.classList.add('active');
    btnFocusCluster.classList.remove('active');
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

  // Tail Length Quick Preset Buttons (synced with slider)
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

  document.getElementById('filter-trend')?.addEventListener('change', (e) => {
    filterTrend = e.target.value;
    renderStrengthTable();
  });

  document.getElementById('filter-rs-signal')?.addEventListener('change', (e) => {
    filterRsSignal = e.target.value;
    renderStrengthTable();
  });

  // Sector Table Column Sort
  document.querySelectorAll('#table-strength th[data-sort]').forEach(th => {
    th.addEventListener('click', (e) => {
      if (e.target.closest('.th-filter-btn')) return;
      const col = th.getAttribute('data-sort');
      if (strengthSortCol === col) {
        strengthSortAsc = !strengthSortAsc;
      } else {
        strengthSortCol = col;
        strengthSortAsc = false;
      }
      document.querySelectorAll('#table-strength thead th').forEach(h => {
        h.classList.remove('sort-asc', 'sort-desc');
      });
      th.classList.add(strengthSortAsc ? 'sort-asc' : 'sort-desc');
      renderStrengthTable();
    });
  });

  document.getElementById('btn-clear-sector-col-filters')?.addEventListener('click', () => {
    sectorColFilters = {};
    searchQuery = '';
    filterTrend = 'ALL';
    filterRsSignal = 'ALL';
    const sEl = document.getElementById('strength-search');
    if (sEl) sEl.value = '';
    const tEl = document.getElementById('filter-trend');
    if (tEl) tEl.value = 'ALL';
    const rEl = document.getElementById('filter-rs-signal');
    if (rEl) rEl.value = 'ALL';
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

function resetPanZoom() {
  zoomLevel = 1.0;
  panOffsetX = 0;
  panOffsetY = 0;
  updateZoomDisplay();
}

function updateZoomDisplay() {
  const el = document.getElementById('zoom-level-text');
  if (el) el.textContent = `${Math.round(zoomLevel * 100)}%`;
}

// =================================================================
// DATA FEED ENGINE MODE SWITCH (yfinance vs Kite API)
// =================================================================
function syncEngineModeUI(mode) {
  const isKite = mode === 'kite';
  document.getElementById('engine-mode-switch')?.classList.toggle('mode-kite', isKite);
  document.getElementById('btn-mode-kite')?.classList.toggle('active', isKite);
  document.getElementById('btn-mode-yfinance')?.classList.toggle('active', !isKite);
  document.querySelector('.token-meter-pill')?.classList.toggle('kite-active', isKite);
  document.getElementById('source-badge')?.classList.toggle('kite-active', isKite);
  const tokenIcon = document.getElementById('token-meter-icon');
  if (tokenIcon) tokenIcon.textContent = isKite ? '🪁' : '⚡';
}

async function setEngineMode(mode) {
  if (mode === currentEngineMode) return;

  if (mode === 'kite') {
    const isKiteConnected = dashboardData?.kite_status?.is_connected;
    if (!isKiteConnected) {
      try {
        const res = await fetch('/api/kite/status');
        const st = await res.json();
        if (!st.is_connected) {
          openKiteModal();
          const feedback = document.getElementById('auth-feedback');
          if (feedback) {
            feedback.textContent = 'Please authorize Kite Connect to enable live Kite API stream.';
            feedback.style.color = 'var(--amber)';
          }
          showToast('⚠️ Kite session needed. Please login to Kite.');
          return;
        }
      } catch (e) {
        openKiteModal();
        return;
      }
    }
  }

  try {
    const res = await fetch('/api/engine/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    const result = await res.json();
    if (result.success) {
      currentEngineMode = mode;
      syncEngineModeUI(mode);
      showToast(result.message || `Switched to ${mode}`);
      await fetchData(false);
      if (stockStrengthData) {
        fetchStockStrengthData(false);
      }
    } else if (result.need_auth) {
      openKiteModal();
      showToast('⚠️ Please login to Kite to activate Kite API.');
    }
  } catch (err) {
    console.error('Failed to change engine mode:', err);
    showToast('Failed to switch engine mode.');
  }
}

// =================================================================
// DATA FETCHING & SYNC
// =================================================================
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
    niftyValEl.textContent = `₹${regime.nifty_close.toLocaleString()} (SMA50: ₹${regime.nifty_sma50?.toLocaleString()})`;
    document.getElementById('kpi-nifty-price').textContent = `₹${regime.nifty_close.toLocaleString()}`;
    document.getElementById('kpi-nifty-sma').textContent = `SMA 50: ₹${regime.nifty_sma50?.toLocaleString()}`;
  }

  if (regime.healthy) {
    regimeBadgeEl.textContent = 'HEALTHY';
    regimeBadgeEl.className = 'regime-status-badge text-emerald';
    regimePill.classList.remove('weak');
  } else {
    regimeBadgeEl.textContent = 'WEAK';
    regimeBadgeEl.className = 'regime-status-badge text-rose';
    regimePill.classList.add('weak');
  }

  const cacheStatus = dashboardData.cache_status || {};
  const tokenStats = dashboardData.token_stats || {};
  remainingCacheSeconds = cacheStatus.remaining_ttl_seconds || 900;

  const tokenCountEl = document.getElementById('token-count-display');
  const sourceNameEl = document.getElementById('source-name');

  if (currentEngineMode === 'kite') {
    tokenCountEl.textContent = `${tokenStats.kite_tokens_used || 1} Kite Token (Live)`;
    sourceNameEl.textContent = cacheStatus.source || 'Zerodha Kite API';
  } else {
    tokenCountEl.textContent = '0 Kite Tokens';
    sourceNameEl.textContent = cacheStatus.source || 'yfinance (Zero-Token)';
  }

  const rrgList = currentTimeframe === 'daily' ? dashboardData.daily_rrg : dashboardData.weekly_rrg;
  const strengthList = dashboardData.strength_indicators || [];

  document.getElementById('kpi-leading-count').textContent = (rrgList || []).filter(x => x.quadrant === 'LEADING').length;
  document.getElementById('kpi-improving-count').textContent = (rrgList || []).filter(x => x.quadrant === 'IMPROVING').length;
  document.getElementById('kpi-breakouts-count').textContent = strengthList.filter(x => x.breakout === 'YES').length;
  document.getElementById('kpi-accumulation-count').textContent = strengthList.filter(x => x.accumulation === 'ACCUMULATION').length;

  const kiteStatus = dashboardData.kite_status;
  const kiteBtnText = document.getElementById('kite-btn-text');
  const openKiteBtn = document.getElementById('btn-open-kite');
  if (kiteStatus && kiteStatus.is_connected) {
    kiteBtnText.textContent = `Kite (${kiteStatus.user_name || 'Active'})`;
    openKiteBtn?.classList.add('btn-emerald');
  } else {
    kiteBtnText.textContent = 'Kite Connect';
    openKiteBtn?.classList.remove('btn-emerald');
  }
}

function populateSectorChips() {
  if (!dashboardData || !sectorChipsBar) return;
  const rrgList = currentTimeframe === 'daily' ? dashboardData.daily_rrg : dashboardData.weekly_rrg;
  if (!rrgList) return;

  sectorChipsBar.innerHTML = '';

  const allChip = document.createElement('button');
  allChip.className = `sector-chip ${selectedSector === null ? 'active' : ''}`;
  allChip.setAttribute('data-symbol', 'ALL');
  allChip.textContent = '⭐ All Sectors';
  allChip.addEventListener('click', () => {
    clearSectorSelection();
    renderRRGCanvas();
    renderRRGTable();
  });
  sectorChipsBar.appendChild(allChip);

  rrgList.forEach(item => {
    const chip = document.createElement('button');
    const colorConfig = QUAD_COLORS[item.quadrant] || QUAD_COLORS.LEADING;
    const isAct = selectedSector === item.symbol;
    chip.className = `sector-chip ${colorConfig.chipClass} ${isAct ? 'active' : ''}`;
    chip.setAttribute('data-symbol', item.symbol);
    chip.textContent = item.name.replace('Nifty ', '');

    chip.addEventListener('click', () => {
      document.querySelectorAll('.sector-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectSector(item);
    });

    chip.addEventListener('mouseenter', () => {
      if (!selectedSector) {
        hoveredSector = item;
        renderRRGCanvas();
      }
    });

    chip.addEventListener('mouseleave', () => {
      if (!selectedSector) {
        hoveredSector = null;
        renderRRGCanvas();
      }
    });

    sectorChipsBar.appendChild(chip);
  });
}

function selectSector(item) {
  selectedSector = item.symbol;
  showSpotlightCard(item);
  renderRRGCanvas();
  renderRRGTable();
}

function showSpotlightCard(item) {
  if (!spotlightCard) return;
  spotlightCard.style.display = 'block';
  document.getElementById('spotlight-name').textContent = item.name;
  document.getElementById('spotlight-ticker').textContent = item.symbol;

  const dp = getDisplayPoint(item);
  const quadEl = document.getElementById('spotlight-quadrant');
  quadEl.textContent = dp.q;
  const qColor = QUAD_COLORS[dp.q]?.stroke || '#fff';
  quadEl.style.backgroundColor = `${qColor}25`;
  quadEl.style.color = qColor;
  quadEl.style.border = `1px solid ${qColor}50`;

  document.getElementById('spotlight-ratio').textContent = `${dp.r.toFixed(2)} (${item.rs_ratio_delta >= 0 ? '+' : ''}${item.rs_ratio_delta})`;
  document.getElementById('spotlight-mom').textContent = `${dp.m.toFixed(2)} (${item.rs_momentum_delta >= 0 ? '+' : ''}${item.rs_momentum_delta})`;
  document.getElementById('spotlight-direction').textContent = item.direction;
  document.getElementById('spotlight-dist').textContent = item.distance;
}

function startCacheCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  const cacheTimerDisplay = document.getElementById('cache-timer-display');

  countdownTimer = setInterval(() => {
    if (remainingCacheSeconds > 0) {
      remainingCacheSeconds--;
      const mins = Math.floor(remainingCacheSeconds / 60);
      const secs = remainingCacheSeconds % 60;
      cacheTimerDisplay.textContent = `Cache: Active (${mins}m ${secs < 10 ? '0' : ''}${secs}s)`;
    } else {
      cacheTimerDisplay.textContent = 'Cache: Ready to sync';
    }
  }, 1000);
}

function renderAll() {
  populateSectorChips();
  renderRRGCanvas();
  renderRRGTable();
  renderStrengthTable();
}

// =================================================================
// RRG CANVAS VISUALIZER WITH LOCKED 1:1 SQUARE ASPECT RATIO
// =================================================================
function initCanvas() {
  resizeCanvas();

  canvas.addEventListener('wheel', handleCanvasWheel, { passive: false });

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    hasDragged = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    initialPanX = panOffsetX;
    initialPanY = panOffsetY;
  });

  window.addEventListener('mousemove', (e) => {
    if (isDragging) {
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (Math.hypot(dx, dy) > 4) {
        hasDragged = true;
        canvas.style.cursor = 'grabbing';
      }
      panOffsetX = initialPanX + dx;
      panOffsetY = initialPanY + dy;
      renderRRGCanvas();
    } else {
      handleCanvasMouseMove(e);
    }
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      canvas.style.cursor = 'crosshair';
    }
  });

  window.addEventListener('blur', () => {
    isDragging = false;
    canvas.style.cursor = 'crosshair';
  });

  canvas.addEventListener('mouseleave', () => {
    if (!isDragging) {
      hoveredSector = null;
      tooltip.style.display = 'none';
      renderRRGCanvas();
    }
  });

  canvas.addEventListener('click', handleCanvasClick);

  canvas.addEventListener('dblclick', () => {
    resetPanZoom();
    renderRRGCanvas();
  });
}

function handleCanvasWheel(e) {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
    const newZoom = Math.min(Math.max(zoomLevel * zoomFactor, 0.4), 4.0);

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    panOffsetX = mouseX - (mouseX - panOffsetX) * (newZoom / zoomLevel);
    panOffsetY = mouseY - (mouseY - panOffsetY) * (newZoom / zoomLevel);

    zoomLevel = newZoom;
    updateZoomDisplay();
    renderRRGCanvas();
  }
}

function resizeCanvas() {
  const rect = canvasWrapper.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.floor(rect.width);
  const h = Math.floor(rect.height);
  if (w <= 0 || h <= 0) return;

  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function handleCanvasMouseMove(e) {
  if (!dashboardData) return;
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const rrgList = currentTimeframe === 'daily' ? dashboardData.daily_rrg : dashboardData.weekly_rrg;
  if (!rrgList) return;

  const { transformX, transformY } = getCanvasTransforms(rect.width, rect.height);

  let found = null;
  let minDistance = 24;

  rrgList.forEach(item => {
    const dp = getDisplayPoint(item);
    if (currentQuadrantFilter !== 'ALL' && dp.q !== currentQuadrantFilter) return;

    const cx = transformX(dp.r);
    const cy = transformY(dp.m);
    const dist = Math.hypot(mouseX - cx, mouseY - cy);

    if (dist < minDistance) {
      minDistance = dist;
      found = item;
    }
  });

  if (found !== hoveredSector) {
    hoveredSector = found;
    renderRRGCanvas();
  }

  if (hoveredSector) {
    showTooltip(e.clientX, e.clientY, hoveredSector);
  } else {
    tooltip.style.display = 'none';
  }
}

function handleCanvasClick() {
  if (hasDragged) {
    hasDragged = false;
    return;
  }
  if (hoveredSector) {
    if (selectedSector === hoveredSector.symbol) {
      clearSectorSelection();
    } else {
      selectSector(hoveredSector);
      document.querySelectorAll('.sector-chip').forEach(c => {
        c.classList.toggle('active', c.getAttribute('data-symbol') === hoveredSector.symbol);
      });
    }
    renderRRGCanvas();
    renderRRGTable();
  }
}

function showTooltip(clientX, clientY, item) {
  const dp = getDisplayPoint(item);
  tooltip.style.display = 'block';
  tooltip.innerHTML = `
    <div class="tt-title">${item.name}</div>
    <div class="tt-sub">${item.symbol}</div>
    <div class="tt-row">
      <span class="lbl">Quadrant:</span>
      <span class="val" style="color: ${QUAD_COLORS[dp.q]?.stroke}">${dp.q}</span>
    </div>
    <div class="tt-row">
      <span class="lbl">Heading:</span>
      <span class="val">${item.direction}</span>
    </div>
    <div class="tt-row">
      <span class="lbl">RS-Ratio:</span>
      <span class="val">${dp.r?.toFixed(2)}${scEndOffset > 0 ? '' : ` (${item.rs_ratio_delta >= 0 ? '+' : ''}${item.rs_ratio_delta})`}</span>
    </div>
    <div class="tt-row">
      <span class="lbl">RS-Momentum:</span>
      <span class="val">${dp.m?.toFixed(2)}${scEndOffset > 0 ? '' : ` (${item.rs_momentum_delta >= 0 ? '+' : ''}${item.rs_momentum_delta})`}</span>
    </div>
    <div class="tt-row">
      <span class="lbl">Distance:</span>
      <span class="val">${Math.hypot(dp.r - 100, dp.m - 100).toFixed(2)}</span>
    </div>
  `;

  const ttRect = tooltip.getBoundingClientRect();
  const wrapperRect = canvasWrapper.getBoundingClientRect();

  let left = clientX - wrapperRect.left + 15;
  let top = clientY - wrapperRect.top + 15;

  if (left + ttRect.width > wrapperRect.width - 20) {
    left = clientX - wrapperRect.left - ttRect.width - 15;
  }
  if (top + ttRect.height > wrapperRect.height - 20) {
    top = clientY - wrapperRect.top - ttRect.height - 15;
  }

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

/**
 * STRICT 1:1 SQUARE ASPECT RATIO TRANSFORM
 */
function getCanvasTransforms(width, height) {
  const maxPanX = width * 0.45;
  const maxPanY = height * 0.45;
  panOffsetX = Math.max(-maxPanX, Math.min(maxPanX, panOffsetX));
  panOffsetY = Math.max(-maxPanY, Math.min(maxPanY, panOffsetY));

  const centerX = width / 2 + panOffsetX;
  const centerY = height / 2 + panOffsetY;

  const span = currentTimeframe === 'weekly'
    ? (focusMode === 'ALL' ? 18.5 : 6.5)
    : (focusMode === 'ALL' ? 7.5 : 2.8);

  const marginY = 55;
  const availHalfHeight = Math.max((height / 2) - marginY, 150);
  const pixelsPerUnit = (availHalfHeight / span) * zoomLevel;

  const transformX = (x) => centerX + (x - 100.0) * pixelsPerUnit;
  const transformY = (y) => centerY - (y - 100.0) * pixelsPerUnit;

  return { transformX, transformY, centerX, centerY, pixelsPerUnit, span, width, height };
}

function updateOutlierBanner(outliers) {
  if (!outlierPill) return;
  if (outliers.length > 0 && focusMode === 'CLUSTER') {
    outlierPill.style.display = 'flex';
    document.getElementById('outlier-count-text').textContent = `${outliers.length} sector${outliers.length > 1 ? 's' : ''}`;
    document.getElementById('outlier-names').textContent = outliers.map(o => o.name.replace('Nifty ', '')).join(', ');
  } else {
    outlierPill.style.display = 'none';
  }
}

function findNonOverlappingSlot(curX, curY, boxW, boxH, placedLabels, checkCollision = true) {
  const candidateSlots = [
    { x: curX + 10, y: curY - 9 },
    { x: curX + 10, y: curY + 12 },
    { x: curX - boxW - 10, y: curY - 9 },
    { x: curX - boxW - 10, y: curY + 12 },
    { x: curX - boxW / 2, y: curY - 22 },
    { x: curX - boxW / 2, y: curY + 24 },
    { x: curX + 18, y: curY - 18 },
    { x: curX - boxW - 18, y: curY - 18 }
  ];

  let bestSlot = candidateSlots[0];
  if (checkCollision) {
    for (const slot of candidateSlots) {
      const rect = { x: slot.x, y: slot.y, w: boxW, h: boxH };
      const overlaps = placedLabels.some(p =>
        !(rect.x + rect.w < p.x || rect.x > p.x + p.w || rect.y + rect.h < p.y || rect.y > p.y + p.h)
      );
      if (!overlaps) {
        bestSlot = slot;
        break;
      }
    }
  }
  placedLabels.push({ x: bestSlot.x, y: bestSlot.y, w: boxW, h: boxH });
  return bestSlot;
}

function renderRRGCanvas() {
  if (!dashboardData) return;
  const rect = canvasWrapper.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.floor(rect.width);
  const height = Math.floor(rect.height);
  if (width <= 0 || height <= 0) return;

  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const rrgList = currentTimeframe === 'daily' ? dashboardData.daily_rrg : dashboardData.weekly_rrg;
  if (!rrgList || !rrgList.length) return;

  const transforms = getCanvasTransforms(width, height);
  const { transformX, transformY, centerX: cx, centerY: cy, pixelsPerUnit, span } = transforms;

  if (chartStyle === 'SC') {
    renderStockChartsRRG(width, height, rrgList, transforms);
    return;
  }

  // 1. Draw 4 Quadrants
  ctx.fillStyle = 'rgba(16, 185, 129, 0.055)';
  ctx.fillRect(cx, 0, width - cx, cy);
  ctx.fillStyle = 'rgba(6, 182, 212, 0.055)';
  ctx.fillRect(0, 0, cx, cy);
  ctx.fillStyle = 'rgba(244, 63, 94, 0.055)';
  ctx.fillRect(0, cy, cx, height - cy);
  ctx.fillStyle = 'rgba(245, 158, 11, 0.055)';
  ctx.fillRect(cx, cy, width - cx, height - cy);

  // 2. Concentric Distance Rings
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.045)';
  ctx.lineWidth = 1;

  const ringStep = span > 10 ? 4.0 : (span > 5 ? 2.0 : 1.0);
  const maxRingDist = Math.max(width, height) / pixelsPerUnit;

  for (let d = ringStep; d <= maxRingDist; d += ringStep) {
    const radius = d * pixelsPerUnit;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    const diagX = cx + (radius * 0.7071);
    const diagY = cy - (radius * 0.7071);
    if (diagX > 10 && diagX < width - 40 && diagY > 20 && diagY < height - 10) {
      ctx.font = '500 9px JetBrains Mono, monospace';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.fillText(`${d.toFixed(0)}%`, diagX + 3, diagY - 3);
    }
  }
  ctx.restore();

  // 3. Grid Lines & Numeric Ticks
  const tickStep = span > 10 ? 2.0 : (span > 4 ? 1.0 : 0.5);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  ctx.font = '500 10px JetBrains Mono, monospace';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';

  const minXVal = Math.floor((100.0 - cx / pixelsPerUnit) / tickStep) * tickStep;
  const maxXVal = Math.ceil((100.0 + (width - cx) / pixelsPerUnit) / tickStep) * tickStep;
  for (let val = minXVal; val <= maxXVal; val += tickStep) {
    if (Math.abs(val - 100.0) < 0.001) continue;
    const tx = transformX(val);
    if (tx >= 25 && tx <= width - 25) {
      ctx.beginPath(); ctx.moveTo(tx, 0); ctx.lineTo(tx, height); ctx.stroke();
      ctx.fillText(val.toFixed(1), tx - 12, height - 12);
    }
  }

  const minYVal = Math.floor((100.0 - (height - cy) / pixelsPerUnit) / tickStep) * tickStep;
  const maxYVal = Math.ceil((100.0 + cy / pixelsPerUnit) / tickStep) * tickStep;
  for (let val = minYVal; val <= maxYVal; val += tickStep) {
    if (Math.abs(val - 100.0) < 0.001) continue;
    const ty = transformY(val);
    if (ty >= 25 && ty <= height - 25) {
      ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(width, ty); ctx.stroke();
      ctx.fillText(val.toFixed(1), 10, ty + 4);
    }
  }

  // 4. Main Crosshairs at (100.0, 100.0)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.38)';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, height); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(width, cy); ctx.stroke();
  ctx.setLineDash([]);

  // Benchmark Bullseye
  ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)'; ctx.fill();
  ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = '#38bdf8'; ctx.fill();

  ctx.font = '700 9px JetBrains Mono, monospace';
  ctx.fillStyle = 'rgba(56, 189, 248, 0.85)';
  ctx.fillText('100.0 (Benchmark)', cx + 9, cy - 8);

  // Quadrant Watermarks
  ctx.font = '800 12px Outfit, sans-serif';
  ctx.fillStyle = 'rgba(16, 185, 129, 0.35)'; ctx.fillText('LEADING (Top-Right)', width - 160, 26);
  ctx.fillStyle = 'rgba(6, 182, 212, 0.35)';  ctx.fillText('IMPROVING (Top-Left)', 20, 26);
  ctx.fillStyle = 'rgba(244, 63, 94, 0.35)';  ctx.fillText('LAGGING (Bottom-Left)', 20, height - 26);
  ctx.fillStyle = 'rgba(245, 158, 11, 0.35)'; ctx.fillText('WEAKENING (Bottom-Right)', width - 175, height - 26);

  // Axis Labels
  ctx.font = '600 10px Inter, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.fillText('RS-Ratio (Benchmark = 100) →', width - 210, cy + 16);
  ctx.save();
  ctx.translate(cx - 10, 85);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('RS-Momentum (Benchmark = 100) →', 0, 0);
  ctx.restore();

  // 5. Partition Visible Nodes vs Outliers (using scWindow so scrubbing & animation work!)
  const visibleNodes = [];
  const outliers = [];

  rrgList.forEach(item => {
    const win = scWindow(item);
    const dp = getDisplayPoint(item);
    if (currentQuadrantFilter !== 'ALL' && dp.q !== currentQuadrantFilter) return;

    const curX = transformX(dp.r);
    const curY = transformY(dp.m);
    const isInside = curX >= 15 && curX <= width - 15 && curY >= 15 && curY <= height - 15;

    if (isInside) {
      visibleNodes.push({
        item,
        curX,
        curY,
        winPts: win.pts,
        colorConfig: QUAD_COLORS[dp.q] || QUAD_COLORS.LEADING
      });
    } else {
      outliers.push(item);
    }
  });

  updateOutlierBanner(outliers);

  // Draw Tails
  if (scTailLen > 0) {
    visibleNodes.forEach(({ item, winPts, colorConfig }) => {
      const isHovered = hoveredSector && hoveredSector.symbol === item.symbol;
      const isSelected = selectedSector && selectedSector === item.symbol;
      const isMuted = (hoveredSector || selectedSector) && !isHovered && !isSelected;

      if (winPts.length >= 2) {
        ctx.beginPath();
        winPts.forEach((pt, i) => {
          const px = transformX(pt.r);
          const py = transformY(pt.m);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });

        ctx.strokeStyle = isMuted
          ? 'rgba(255, 255, 255, 0.03)'
          : (isHovered || isSelected) ? colorConfig.stroke : colorConfig.stroke + '75';
        ctx.lineWidth = (isHovered || isSelected) ? 3.5 : 1.8;
        ctx.stroke();

        for (let i = 0; i < winPts.length - 1; i++) {
          const px = transformX(winPts[i].r);
          const py = transformY(winPts[i].m);
          ctx.beginPath();
          ctx.arc(px, py, (isHovered || isSelected) ? 3.0 : 2.0, 0, Math.PI * 2);
          ctx.fillStyle = isMuted ? 'rgba(255, 255, 255, 0.05)' : colorConfig.stroke + '80';
          ctx.fill();
        }
      }
    });
  }

  // Draw Nodes and Anti-Collision Labels
  const placedLabels = [];
  visibleNodes.sort((a, b) => {
    const aActive = (selectedSector === a.item.symbol || (hoveredSector && hoveredSector.symbol === a.item.symbol)) ? 1 : 0;
    const bActive = (selectedSector === b.item.symbol || (hoveredSector && hoveredSector.symbol === b.item.symbol)) ? 1 : 0;
    return aActive - bActive;
  });

  visibleNodes.forEach(({ item, curX, curY, colorConfig }) => {
    const isHovered = hoveredSector && hoveredSector.symbol === item.symbol;
    const isSelected = selectedSector && selectedSector === item.symbol;
    const isMuted = (hoveredSector || selectedSector) && !isHovered && !isSelected;

    if (isHovered || isSelected) {
      ctx.beginPath(); ctx.arc(curX, curY, 18, 0, Math.PI * 2);
      ctx.fillStyle = colorConfig.fill; ctx.fill();
      ctx.beginPath(); ctx.arc(curX, curY, 11, 0, Math.PI * 2);
      ctx.strokeStyle = colorConfig.stroke; ctx.lineWidth = 2; ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(curX, curY, (isHovered || isSelected) ? 7.0 : 5.0, 0, Math.PI * 2);
    ctx.fillStyle = isMuted ? '#475569' : colorConfig.stroke;
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    let shouldDrawLabel = true;
    if (labelMode === 'HOVER') {
      shouldDrawLabel = isHovered || isSelected;
    } else if (labelMode === 'LEADERS') {
      shouldDrawLabel = isHovered || isSelected || item.distance > 1.5;
    }

    if (shouldDrawLabel) {
      const labelText = item.name.replace('Nifty ', '');
      ctx.font = (isHovered || isSelected) ? '700 11px Inter, sans-serif' : '600 10px Inter, sans-serif';
      const boxWidth = ctx.measureText(labelText).width + 12;
      const boxHeight = 18;

      const bestSlot = findNonOverlappingSlot(
        curX, curY, boxWidth, boxHeight, placedLabels,
        labelMode === 'STAGGERED' && !isHovered && !isSelected
      );

      if (Math.hypot(bestSlot.x - (curX + 10), bestSlot.y - (curY - 9)) > 4) {
        ctx.beginPath();
        ctx.moveTo(curX, curY);
        ctx.lineTo(bestSlot.x + boxWidth / 2, bestSlot.y + boxHeight / 2);
        ctx.strokeStyle = isMuted ? 'rgba(255, 255, 255, 0.08)' : (colorConfig.stroke + '85');
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.fillStyle = isMuted ? 'rgba(15, 23, 42, 0.5)' : (isHovered || isSelected) ? 'rgba(15, 23, 42, 0.96)' : 'rgba(15, 23, 42, 0.84)';
      ctx.fillRect(bestSlot.x, bestSlot.y, boxWidth, boxHeight);

      ctx.strokeStyle = (isHovered || isSelected) ? colorConfig.stroke : 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = (isHovered || isSelected) ? 1.5 : 1;
      ctx.strokeRect(bestSlot.x, bestSlot.y, boxWidth, boxHeight);

      ctx.fillStyle = isMuted ? '#64748b' : (isHovered || isSelected) ? '#ffffff' : '#f1f5f9';
      ctx.fillText(labelText, bestSlot.x + 6, bestSlot.y + 13);
    }
  });

  updateScPanel();
}

// =================================================================
// STOCKCHARTS-STYLE RRG RENDERER
// =================================================================
function renderStockChartsRRG(width, height, rrgList, t) {
  const { transformX, transformY, centerX: cx, centerY: cy, pixelsPerUnit, span } = t;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  const cxc = Math.max(0, Math.min(width, cx));
  const cyc = Math.max(0, Math.min(height, cy));
  ctx.fillStyle = '#cfe2f7'; ctx.fillRect(0, 0, cxc, cyc);
  ctx.fillStyle = '#d4edd1'; ctx.fillRect(cxc, 0, width - cxc, cyc);
  ctx.fillStyle = '#f6d2d2'; ctx.fillRect(0, cyc, cxc, height - cyc);
  ctx.fillStyle = '#fbf0c0'; ctx.fillRect(cxc, cyc, width - cxc, height - cyc);

  const tickStep = span > 10 ? 2.0 : (span > 4 ? 1.0 : 0.5);
  ctx.strokeStyle = 'rgba(0,0,0,0.07)';
  ctx.lineWidth = 1;
  ctx.font = '500 10px Inter, sans-serif';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  const minX = Math.floor((100 - cx / pixelsPerUnit) / tickStep) * tickStep;
  const maxX = Math.ceil((100 + (width - cx) / pixelsPerUnit) / tickStep) * tickStep;
  for (let v = minX; v <= maxX; v += tickStep) {
    const x = transformX(v);
    if (x < 20 || x > width - 20) continue;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    ctx.fillText(v.toFixed(1), x - 11, height - 24);
  }
  const minY = Math.floor((100 - (height - cy) / pixelsPerUnit) / tickStep) * tickStep;
  const maxY = Math.ceil((100 + cy / pixelsPerUnit) / tickStep) * tickStep;
  for (let v = minY; v <= maxY; v += tickStep) {
    const y = transformY(v);
    if (y < 56 || y > height - 56) continue;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    ctx.fillText(v.toFixed(1), 26, y - 3);
  }

  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, height); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(width, cy); ctx.stroke();

  ctx.font = '700 26px Outfit, Inter, sans-serif';
  ctx.fillStyle = 'rgba(40, 90, 160, 0.38)';  ctx.fillText('Improving', 16, 38);
  ctx.fillStyle = 'rgba(40, 130, 50, 0.38)';  ctx.fillText('Leading', width - ctx.measureText('Leading').width - 16, 38);
  ctx.fillStyle = 'rgba(170, 40, 40, 0.38)';  ctx.fillText('Lagging', 16, height - 40);
  ctx.fillStyle = 'rgba(170, 130, 10, 0.45)'; ctx.fillText('Weakening', width - ctx.measureText('Weakening').width - 16, height - 40);

  ctx.font = '600 11px Inter, sans-serif';
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  const xt = 'JdK RS-Ratio';
  ctx.fillText(xt, width / 2 - ctx.measureText(xt).width / 2, height - 8);
  ctx.save();
  ctx.translate(16, height / 2 + 40);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('JdK RS-Momentum', 0, 0);
  ctx.restore();

  const placedLabels = [];
  const nodes = [];
  const outliers = [];

  rrgList.forEach(item => {
    const win = scWindow(item);
    if (!win.pts.length) return;
    const head = win.pts[win.pts.length - 1];
    const q = classifyQuadrantJS(head.r, head.m);
    if (currentQuadrantFilter !== 'ALL' && q !== currentQuadrantFilter) return;
    const hx = transformX(head.r), hy = transformY(head.m);
    if (hx < 8 || hx > width - 8 || hy < 8 || hy > height - 8) {
      outliers.push(item);
      return;
    }
    nodes.push({ item, hx, hy, win, q });
  });

  updateOutlierBanner(outliers);

  nodes.sort((a, b) => {
    const f = n => (selectedSector === n.item.symbol || (hoveredSector && hoveredSector.symbol === n.item.symbol)) ? 1 : 0;
    return f(a) - f(b);
  });

  nodes.forEach(({ item, hx, hy, win, q }) => {
    const hot = (hoveredSector && hoveredSector.symbol === item.symbol) || selectedSector === item.symbol;
    const muted = (hoveredSector || selectedSector) && !hot;
    ctx.globalAlpha = muted ? 0.18 : 1;

    const xy = win.pts.map(p => [transformX(p.r), transformY(p.m), classifyQuadrantJS(p.r, p.m)]);

    if (scTailLen > 0 && xy.length >= 2) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = hot ? 6 : 4;
      for (let i = 1; i < xy.length; i++) {
        ctx.beginPath();
        ctx.moveTo(xy[i - 1][0], xy[i - 1][1]);
        ctx.lineTo(xy[i][0], xy[i][1]);
        ctx.strokeStyle = SC_QUAD[xy[i][2]];
        ctx.stroke();
      }
      for (let i = 0; i < xy.length - 1; i++) {
        ctx.beginPath();
        ctx.arc(xy[i][0], xy[i][1], hot ? 2.6 : 2, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      }
    }

    ctx.beginPath();
    ctx.arc(hx, hy, hot ? 7 : 5.5, 0, Math.PI * 2);
    ctx.fillStyle = SC_QUAD[q];
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#111';
    ctx.stroke();

    const label = item.name.replace('Nifty ', '');
    ctx.font = hot ? '700 12px Inter, sans-serif' : '500 10px Inter, sans-serif';
    const w = ctx.measureText(label).width;
    const slot = findNonOverlappingSlot(hx, hy, w, 13, placedLabels, true);
    ctx.fillStyle = '#111';
    ctx.fillText(label, slot.x, slot.y + 10);
    ctx.globalAlpha = 1;
  });

  updateScPanel();
}

// =================================================================
// TIMELINE SCRUBBER, TAIL WINDOW & BENCHMARK CHART
// =================================================================
function classifyQuadrantJS(r, m) {
  if (r > 100 && m > 100) return 'LEADING';
  if (r > 100) return 'WEAKENING';
  if (m > 100) return 'IMPROVING';
  return 'LAGGING';
}

function scWindow(item) {
  const all = (item.tail_points || [])
    .filter(p => p.rs_ratio != null && p.rs_momentum != null)
    .map(p => ({ r: p.rs_ratio, m: p.rs_momentum }));
  if (!all.length) return { pts: [], n: 0 };
  const idx = Math.max(0, all.length - 1 - scEndOffset);
  const start = Math.max(0, idx - scTailLen);
  return { pts: all.slice(start, idx + 1), n: all.length };
}

function getDisplayPoint(item) {
  const w = scWindow(item);
  if (w.pts.length) {
    const h = w.pts[w.pts.length - 1];
    return { r: h.r, m: h.m, q: classifyQuadrantJS(h.r, h.m) };
  }
  return { r: item.rs_ratio, m: item.rs_momentum, q: item.quadrant };
}

function scMaxOffset() {
  const list = currentTimeframe === 'daily' ? dashboardData?.daily_rrg : dashboardData?.weekly_rrg;
  const n = list && list.length ? Math.min(...list.map(i => (i.tail_points || []).length)) : 1;
  return Math.max(0, n - 1 - scTailLen);
}

function scStopAnimation() {
  if (scTimer) { clearInterval(scTimer); scTimer = null; }
  const b = document.getElementById('btn-sc-animate');
  if (b) b.textContent = '▶ Animate';
}

function scStartAnimation() {
  scStopAnimation();
  scEndOffset = scMaxOffset();
  document.getElementById('btn-sc-animate').textContent = '⏸ Pause';
  renderRRGCanvas();
  renderRRGTable();
  scTimer = setInterval(() => {
    if (scEndOffset <= 0) { scStopAnimation(); return; }
    scEndOffset -= 1;
    renderRRGCanvas();
    renderRRGTable();
  }, 380);
}

function initScPanel() {
  document.getElementById('btn-sc-animate')?.addEventListener('click', () => {
    if (scTimer) scStopAnimation(); else scStartAnimation();
  });
  document.getElementById('btn-sc-latest')?.addEventListener('click', () => {
    scStopAnimation();
    scEndOffset = 0;
    renderRRGCanvas();
    renderRRGTable();
  });
  document.getElementById('sc-tail-slider')?.addEventListener('input', e => {
    const val = parseInt(e.target.value, 10);
    syncTailControls(val);
    scEndOffset = Math.min(scEndOffset, scMaxOffset());
    renderRRGCanvas();
  });

  const bc = document.getElementById('sc-bench-canvas');
  if (!bc) return;
  let dragging = false;
  const setFromEvent = e => {
    const bench = dashboardData?.benchmark?.[currentTimeframe];
    if (!bench || !bench.close.length) return;
    const rect = bc.getBoundingClientRect();
    const L = bench.close.length;
    const padL = 8, padR = 60;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left - padL) / (rect.width - padL - padR)));
    const idx = Math.round(frac * (L - 1));
    scStopAnimation();
    scEndOffset = Math.max(0, Math.min(scMaxOffset(), L - 1 - idx));
    renderRRGCanvas();
    renderRRGTable();
  };
  bc.addEventListener('mousedown', e => { dragging = true; setFromEvent(e); });
  window.addEventListener('mousemove', e => { if (dragging) setFromEvent(e); });
  window.addEventListener('mouseup', () => { dragging = false; });
}

function updateScPanel() {
  const panel = document.getElementById('sc-panel');
  if (!panel || !dashboardData) return;
  const unit = currentTimeframe === 'daily' ? 'day' : 'week';
  const bench = dashboardData.benchmark?.[currentTimeframe] || { dates: [], close: [] };
  const L = bench.close.length;

  scEndOffset = Math.max(0, Math.min(scEndOffset, scMaxOffset()));

  const tailLbl = scTailLen === 0 ? 'Dots only' : `${scTailLen} ${unit}${scTailLen > 1 ? 's' : ''}`;
  document.getElementById('sc-tail-label').textContent = tailLbl;
  const endIdx = L - 1 - scEndOffset;
  const endDate = bench.dates[endIdx];
  const pretty = endDate ? new Date(endDate + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '--';
  document.getElementById('sc-caption').textContent = `${tailLbl} ending ${pretty}`;

  const bc = document.getElementById('sc-bench-canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = bc.clientWidth, h = bc.clientHeight;
  if (w <= 0 || h <= 0 || L < 2) return;
  if (bc.width !== Math.round(w * dpr) || bc.height !== Math.round(h * dpr)) {
    bc.width = Math.round(w * dpr);
    bc.height = Math.round(h * dpr);
  }
  const g = bc.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h);

  const padL = 8, padR = 60, padT = 10, padB = 18;
  const min = Math.min(...bench.close), max = Math.max(...bench.close);
  const X = i => padL + (i / (L - 1)) * (w - padL - padR);
  const Y = v => padT + (1 - (v - min) / ((max - min) || 1)) * (h - padT - padB);

  const histBars = scMaxOffset() + scTailLen;
  g.fillStyle = 'rgba(0,0,0,0.035)';
  g.fillRect(X(Math.max(0, L - 1 - histBars)), padT, X(L - 1) - X(Math.max(0, L - 1 - histBars)), h - padT - padB);

  const x0 = X(Math.max(0, endIdx - scTailLen)), x1 = X(endIdx);
  g.fillStyle = 'rgba(42, 69, 214, 0.18)';
  g.fillRect(x0, padT, Math.max(2, x1 - x0), h - padT - padB);

  g.beginPath();
  g.moveTo(X(0), h - padB);
  for (let i = 0; i < L; i++) g.lineTo(X(i), Y(bench.close[i]));
  g.lineTo(X(L - 1), h - padB);
  g.closePath();
  g.fillStyle = 'rgba(120,120,120,0.14)';
  g.fill();

  g.beginPath();
  for (let i = 0; i < L; i++) (i ? g.lineTo(X(i), Y(bench.close[i])) : g.moveTo(X(i), Y(bench.close[i])));
  g.strokeStyle = '#222';
  g.lineWidth = 1.4;
  g.stroke();

  g.strokeStyle = '#2a45d6';
  g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(X(endIdx), padT); g.lineTo(X(endIdx), h - padB); g.stroke();
  const price = bench.close[endIdx];
  g.fillStyle = '#2a45d6';
  g.fillRect(w - padR + 4, Y(price) - 8, 54, 16);
  g.fillStyle = '#fff';
  g.font = '600 10px Inter, sans-serif';
  g.fillText(Math.round(price).toLocaleString(), w - padR + 8, Y(price) + 4);

  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.font = '500 10px Inter, sans-serif';
  g.fillText(bench.dates[0] || '', padL, h - 4);
  const lastD = bench.dates[L - 1] || '';
  g.fillText(lastD, w - padR - g.measureText(lastD).width, h - 4);
}

// =================================================================
// RRG TABLE RENDERER
// =================================================================
function renderRRGTable() {
  if (!dashboardData) return;
  const tbody = document.getElementById('tbody-rrg');
  if (!tbody) return;

  const rrgList = currentTimeframe === 'daily' ? dashboardData.daily_rrg : dashboardData.weekly_rrg;
  if (!rrgList) return;

  tbody.innerHTML = '';

  rrgList.forEach(item => {
    const dp = getDisplayPoint(item);
    if (currentQuadrantFilter !== 'ALL' && dp.q !== currentQuadrantFilter) return;

    const isSelected = selectedSector === item.symbol;
    const isHovered = hoveredSector && hoveredSector.symbol === item.symbol;

    const tr = document.createElement('tr');
    if (isSelected || isHovered) tr.style.backgroundColor = 'rgba(6, 182, 212, 0.16)';

    tr.style.cursor = 'pointer';
    tr.addEventListener('mouseenter', () => {
      hoveredSector = item;
      renderRRGCanvas();
    });
    tr.addEventListener('mouseleave', () => {
      hoveredSector = null;
      renderRRGCanvas();
    });
    tr.addEventListener('click', () => {
      if (selectedSector === item.symbol) {
        clearSectorSelection();
      } else {
        selectSector(item);
      }
      renderRRGCanvas();
      renderRRGTable();
    });

    const quadClass = QUAD_COLORS[dp.q]?.badgeClass || '';
    const dist = Math.hypot(dp.r - 100, dp.m - 100).toFixed(2);

    tr.innerHTML = `
      <td><strong>${item.name}</strong> <span style="color: var(--text-muted); font-size: 0.7rem;">(${item.symbol})</span></td>
      <td class="num">${dp.r.toFixed(2)}</td>
      <td class="num">${dp.m.toFixed(2)}</td>
      <td><span class="badge-quadrant ${quadClass}">${dp.q}</span></td>
      <td><span class="badge-direction">${item.direction}</span></td>
      <td class="num">${dist}</td>
    `;
    tbody.appendChild(tr);
  });
}

// =================================================================
// SHARED INDICATOR FORMATTING HELPERS
// =================================================================
function renderScorePips(score) {
  let pipsHtml = '';
  for (let i = 1; i <= 5; i++) {
    let pipClass = '';
    if (i <= score) {
      pipClass = score === 5 ? 'active-5' : score === 4 ? 'active-4' : score === 3 ? 'active-3' : 'active-low';
    }
    pipsHtml += `<div class="score-pip ${pipClass}"></div>`;
  }
  return `<div class="score-cell"><div class="score-pips">${pipsHtml}</div><span class="score-num">${score}/5</span></div>`;
}

function getRsRatingTier(rating) {
  if (rating >= 80) return 'tier-top';
  if (rating >= 60) return 'tier-high';
  if (rating >= 40) return 'tier-mid';
  return 'tier-low';
}

// =================================================================
// SECTOR STRENGTH INDICATORS MATRIX TABLE
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

  document.getElementById('matrix-counter').textContent = `Showing ${list.length} of ${dashboardData.strength_indicators?.length || 19} sectors`;

  list.sort((a, b) => {
    const valA = a[strengthSortCol];
    const valB = b[strengthSortCol];
    if (valA == null) return 1;
    if (valB == null) return -1;
    if (typeof valA === 'string') {
      return strengthSortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }
    return strengthSortAsc ? valA - valB : valB - valA;
  });

  tbody.innerHTML = list.map(item => `
    <tr>
      <td>
        <strong>${item.name}</strong>
        ${item.is_live_kite ? '<span class="badge-live-kite" title="Live LTP from Zerodha Kite Connect">Kite Live</span>' : ''}
        <div style="color: var(--text-muted); font-size: 0.7rem;">${item.symbol}</div>
      </td>
      <td class="num" style="font-weight: 700;">₹${item.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="num">${item.sma20?.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="num">${item.sma50?.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="num">${item.sma200?.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td><span class="trend-badge ${item.trend}">${item.trend}</span></td>
      <td class="num" style="font-weight: 600;">${item.rs_score?.toFixed(3)}</td>
      <td class="num"><span class="rs-rating-pill ${getRsRatingTier(item.rs_rating)}">${item.rs_rating}</span></td>
      <td><span class="rs-signal-badge ${item.rs_signal}">${item.rs_signal}</span></td>
      <td class="num ${item.rvol > 1.5 ? 'rvol-high' : ''}">${item.rvol?.toFixed(2)}x</td>
      <td>${item.breakout === 'YES' ? '<span class="badge-breakout">50D HIGH ⚡</span>' : '<span style="color:var(--text-muted);opacity:0.3;">—</span>'}</td>
      <td>${item.accumulation === 'ACCUMULATION' ? '<span class="badge-accum">ACCUM 💎</span>' : '<span style="color:var(--text-muted);opacity:0.3;">—</span>'}</td>
      <td>${renderScorePips(item.score)}</td>
      <td class="num">${item.volatility?.toFixed(1)}%</td>
      <td style="color: var(--text-muted); font-size: 0.72rem;">${item.last_updated}</td>
    </tr>
  `).join('');
}

// =================================================================
// KITE CONNECT MODAL & CREDENTIALS
// =================================================================
let kiteModalPollTimer = null;

async function refreshKiteModalStatus(autoSwitchOnConnect = false) {
  const loginLink = document.getElementById('kite-login-link');
  const statusText = document.getElementById('kite-session-status');
  const details = document.getElementById('kite-session-details');

  try {
    const res = await fetch('/api/kite/status');
    const status = await res.json();

    const apiKeyInput = document.getElementById('modal-api-key');
    if (apiKeyInput) apiKeyInput.value = status.raw_api_key || '';
    if (loginLink) loginLink.href = status.login_url || '/api/kite/login';

    if (status.is_connected) {
      if (statusText) {
        statusText.textContent = 'CONNECTED';
        statusText.style.color = 'var(--emerald)';
      }
      if (details) {
        details.innerHTML = `Connected as <strong>${status.user_name || status.user_id}</strong> (Session Date: ${status.session_date}). Live quotes enabled.`;
      }
      if (autoSwitchOnConnect && currentEngineMode !== 'kite') {
        currentEngineMode = 'kite';
        syncEngineModeUI('kite');
        showToast(`🎉 Connected to Zerodha Kite as ${status.user_name || status.user_id || 'User'}!`);
        fetchData(false);
        if (stockStrengthData) fetchStockStrengthData(false);
      }
    } else {
      if (statusText) {
        statusText.textContent = 'ZERO-TOKEN MODE (OFFLINE)';
        statusText.style.color = 'var(--cyan)';
      }
      if (details) {
        details.textContent = 'Free Zero-Token Engine active with 15-minute local cache. Log in to Kite to stream live quotes.';
      }
    }
  } catch (e) {
    console.error('Failed to get Kite status:', e);
    if (loginLink) loginLink.href = '/api/kite/login';
    if (statusText) {
      statusText.textContent = 'SERVER UNREACHABLE';
      statusText.style.color = 'var(--rose)';
    }
    if (details) {
      details.textContent = 'Could not reach local backend. Ensure server is running at http://127.0.0.1:8000.';
    }
  }
}

async function openKiteModal() {
  const modal = document.getElementById('kite-modal');
  if (modal) modal.style.display = 'flex';

  await refreshKiteModalStatus(false);

  if (kiteModalPollTimer) clearInterval(kiteModalPollTimer);
  kiteModalPollTimer = setInterval(() => {
    refreshKiteModalStatus(true);
  }, 2000);
}

function closeKiteModal() {
  if (kiteModalPollTimer) {
    clearInterval(kiteModalPollTimer);
    kiteModalPollTimer = null;
  }
  document.getElementById('kite-modal').style.display = 'none';
  document.getElementById('auth-feedback').textContent = '';
}

async function submitKiteToken() {
  const tokenInput = document.getElementById('input-request-token');
  const token = tokenInput.value.trim();
  const feedback = document.getElementById('auth-feedback');

  if (!token) {
    feedback.textContent = 'Please enter a request_token or access_token.';
    feedback.style.color = 'var(--rose)';
    return;
  }

  feedback.textContent = 'Authenticating with Kite Connect...';
  feedback.style.color = 'var(--cyan)';

  try {
    const res = await fetch('/api/kite/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_token: token })
    });
    const json = await res.json();

    if (res.ok && json.success) {
      feedback.textContent = `Success! ${json.message}`;
      feedback.style.color = 'var(--emerald)';
      tokenInput.value = '';
      currentEngineMode = 'kite';
      syncEngineModeUI('kite');
      showToast('🪁 Switched to Zerodha Kite API (Live Quotes)');
      fetchData(false);
      if (stockStrengthData) fetchStockStrengthData(false);
      openKiteModal();
    } else {
      feedback.textContent = json.detail || 'Authorization failed. Please verify request token.';
      feedback.style.color = 'var(--rose)';
    }
  } catch (e) {
    feedback.textContent = 'Error connecting to server.';
    feedback.style.color = 'var(--rose)';
  }
}

async function disconnectKite() {
  try {
    await fetch('/api/kite/disconnect', { method: 'POST' });
    currentEngineMode = 'yfinance';
    syncEngineModeUI('yfinance');
    showToast('⚡ Switched to Zero-Token Yahoo Finance Engine');
    openKiteModal();
    fetchData(false);
    if (stockStrengthData) fetchStockStrengthData(false);
  } catch (e) {
    console.error('Error disconnecting:', e);
  }
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
    niftyEl.textContent = regime.healthy
      ? `Nifty ₹${Number(regime.nifty_close || 0).toLocaleString()} > SMA50 ₹${Number(regime.nifty_sma50 || 0).toLocaleString()}`
      : `Nifty ₹${Number(regime.nifty_close || 0).toLocaleString()} < SMA50 ₹${Number(regime.nifty_sma50 || 0).toLocaleString()}`;
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
  const searchInput = document.getElementById('stock-search-input');
  const clearBtn = document.getElementById('btn-clear-stock-search');
  searchInput?.addEventListener('input', (e) => {
    stockSearchQuery = e.target.value.trim().toUpperCase();
    if (clearBtn) clearBtn.style.display = stockSearchQuery ? 'block' : 'none';
    renderStockStrengthTable();
  });

  clearBtn?.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    stockSearchQuery = '';
    clearBtn.style.display = 'none';
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

  document.querySelectorAll('.stock-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.stock-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      stockQuickPill = pill.getAttribute('data-filter');
      renderStockStrengthTable();
    });
  });

  document.getElementById('btn-refresh-stock')?.addEventListener('click', () => {
    fetchStockStrengthData(true);
  });

  document.getElementById('btn-export-stock-csv')?.addEventListener('click', () => {
    exportStockStrengthCSV();
  });

  document.getElementById('btn-clear-stock-col-filters')?.addEventListener('click', () => {
    stockColFilters = {};
    stockSearchQuery = '';
    stockTrendFilter = 'ALL';
    stockRsSignalFilter = 'ALL';
    stockQuickPill = 'all';
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

  document.querySelectorAll('#table-stock-strength thead th').forEach(th => {
    th.addEventListener('click', (e) => {
      if (e.target.closest('.th-filter-btn')) return;
      const col = th.getAttribute('data-sort');
      if (!col) return;
      if (stockSortCol === col) {
        stockSortDir = stockSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        stockSortCol = col;
        stockSortDir = ['ticker', 'trend', 'rs_signal', 'breakout', 'accumulation', 'last_updated'].includes(col) ? 'asc' : 'desc';
      }

      document.querySelectorAll('#table-stock-strength thead th').forEach(h => {
        h.classList.remove('sort-asc', 'sort-desc');
      });
      th.classList.add(stockSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      renderStockStrengthTable();
    });
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

  rows.sort((a, b) => {
    if (stockSortCol === 'score') {
      const diff = stockSortDir === 'asc' ? a.score - b.score : b.score - a.score;
      if (diff !== 0) return diff;
      return (b.rs_score || 0) - (a.rs_score || 0);
    }
    const va = a[stockSortCol] ?? '';
    const vb = b[stockSortCol] ?? '';
    if (typeof va === 'number' && typeof vb === 'number') {
      return stockSortDir === 'asc' ? va - vb : vb - va;
    }
    return stockSortDir === 'asc'
      ? String(va).toLowerCase().localeCompare(String(vb).toLowerCase())
      : String(vb).toLowerCase().localeCompare(String(va).toLowerCase());
  });

  lastFilteredStockRows = rows;

  if (counterEl) {
    counterEl.textContent = `Showing ${rows.length} of ${total} stocks`;
  }

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="17" style="text-align:center; padding: 48px; color: var(--text-muted);">No stocks matching the selected filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const breakoutHtml = r.breakout === 'YES' ? `<span class="badge-breakout">YES</span>` : '<span style="color:var(--text-muted);opacity:0.3;">—</span>';
    const accumHtml = r.accumulation === 'ACCUMULATION' ? `<span class="badge-accum">ACCUM</span>` : '<span style="color:var(--text-muted);opacity:0.3;">—</span>';
    const liveIndicator = r.is_live_kite ? '<span class="live-dot" title="Live Kite LTP Quote" style="color:#10b981;font-size:0.7rem;margin-right:3px;">●</span>' : '';

    return `
      <tr>
        <td class="stock-ticker-cell">
          <span class="stock-sym-badge">${r.ticker}</span>
        </td>
        <td class="num font-mono">${liveIndicator}₹${Number(r.price).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td class="font-mono" style="font-size:0.75rem; color:var(--text-muted);">${r.last_updated}</td>
        <td class="num font-mono">${r.sma20 ? '₹' + Number(r.sma20).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</td>
        <td class="num font-mono">${r.sma50 ? '₹' + Number(r.sma50).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</td>
        <td class="num font-mono">${r.sma200 ? '₹' + Number(r.sma200).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</td>
        <td><span class="trend-badge ${r.trend}">${r.trend}</span></td>
        <td class="num font-mono font-bold">${r.rs_score !== null ? Number(r.rs_score).toFixed(3) : '—'}</td>
        <td class="num"><span class="rs-rating-pill ${getRsRatingTier(r.rs_rating)}">${r.rs_rating || '—'}</span></td>
        <td><span class="rs-signal-badge ${r.rs_signal}">${r.rs_signal}</span></td>
        <td class="num font-mono">${r.vol_today ? Number(r.vol_today).toLocaleString('en-IN') : '—'}</td>
        <td class="num font-mono">${r.vol20 ? Number(r.vol20).toLocaleString('en-IN') : '—'}</td>
        <td class="num font-mono ${r.rvol > 1.5 ? 'rvol-high' : ''}">${r.rvol ? Number(r.rvol).toFixed(2) + 'x' : '—'}</td>
        <td style="text-align:center;">${breakoutHtml}</td>
        <td style="text-align:center;">${accumHtml}</td>
        <td>${renderScorePips(r.score)}</td>
        <td class="num font-mono">${r.volatility ? r.volatility.toFixed(1) + '%' : '—'}</td>
        <td style="text-align:center;">
          <button class="btn btn-sm btn-emerald" style="padding: 2px 8px; font-size: 0.68rem;" onclick='openTradeModalFromScreenerRow(${JSON.stringify(r).replace(/'/g, "&#39;").replace(/"/g, "&quot;")})' title="Log this stock into Trade Library with full indicator snapshot">
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

  const csvRows = [headers.join(',')];
  const exportList = (lastFilteredStockRows && lastFilteredStockRows.length > 0)
    ? lastFilteredStockRows
    : stockStrengthData.rows;

  exportList.forEach(r => {
    csvRows.push([
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
    ].join(','));
  });

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `Strength_Indicators_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('📥 Exported Strength_Indicators.csv');
}

// =================================================================
// EXCEL-STYLE COLUMN HEADER FILTER ENGINE
// =================================================================
const NUMERIC_COLS = new Set([
  'price', 'sma20', 'sma50', 'sma200', 'rs_score', 'rs_rating',
  'vol_today', 'vol20', 'rvol', 'score', 'volatility'
]);

const COL_PRESETS = {
  price: [
    { label: '< ₹500', op: 'lt', val1: 500, val2: null },
    { label: '₹500–1.5K', op: 'between', val1: 500, val2: 1500 },
    { label: '₹1.5K–5K', op: 'between', val1: 1500, val2: 5000 },
    { label: '> ₹5,000', op: 'gt', val1: 5000, val2: null }
  ],
  sma20: [
    { label: 'Price > SMA 20', op: 'above_sma', val1: null, val2: null },
    { label: 'Price < SMA 20', op: 'below_sma', val1: null, val2: null }
  ],
  sma50: [
    { label: 'Price > SMA 50', op: 'above_sma', val1: null, val2: null },
    { label: 'Price < SMA 50', op: 'below_sma', val1: null, val2: null }
  ],
  sma200: [
    { label: 'Price > SMA 200', op: 'above_sma', val1: null, val2: null },
    { label: 'Price < SMA 200', op: 'below_sma', val1: null, val2: null }
  ],
  rs_score: [
    { label: '≥ 1.30 (Leader)', op: 'gte', val1: 1.30, val2: null },
    { label: '≥ 1.10 (Strong)', op: 'gte', val1: 1.10, val2: null },
    { label: '1.00–1.10', op: 'between', val1: 1.00, val2: 1.10 },
    { label: '< 1.00 (Weak)', op: 'lt', val1: 1.00, val2: null }
  ],
  rs_rating: [
    { label: '80–99 (Top)', op: 'gte', val1: 80, val2: null },
    { label: '60–79 (High)', op: 'between', val1: 60, val2: 79 },
    { label: '40–59 (Mid)', op: 'between', val1: 40, val2: 59 },
    { label: '< 40 (Low)', op: 'lt', val1: 40, val2: null }
  ],
  rvol: [
    { label: '≥ 2.0x (Ultra)', op: 'gte', val1: 2.0, val2: null },
    { label: '≥ 1.5x (High)', op: 'gte', val1: 1.5, val2: null },
    { label: '1.0x–1.5x', op: 'between', val1: 1.0, val2: 1.5 },
    { label: '< 1.0x (Low)', op: 'lt', val1: 1.0, val2: null }
  ],
  score: [
    { label: '5 / 5 Only', op: 'eq', val1: 5, val2: null },
    { label: '≥ 4 / 5', op: 'gte', val1: 4, val2: null },
    { label: '≥ 3 / 5', op: 'gte', val1: 3, val2: null },
    { label: '≤ 2 / 5', op: 'lte', val1: 2, val2: null }
  ],
  volatility: [
    { label: '< 20% (Low)', op: 'lt', val1: 20, val2: null },
    { label: '20%–35% (Mod)', op: 'between', val1: 20, val2: 35 },
    { label: '> 35% (High)', op: 'gt', val1: 35, val2: null }
  ],
  vol_today: [
    { label: '≥ 10M', op: 'gte', val1: 10000000, val2: null },
    { label: '≥ 1M', op: 'gte', val1: 1000000, val2: null },
    { label: '< 1M', op: 'lt', val1: 1000000, val2: null }
  ],
  vol20: [
    { label: '≥ 10M', op: 'gte', val1: 10000000, val2: null },
    { label: '≥ 1M', op: 'gte', val1: 1000000, val2: null },
    { label: '< 1M', op: 'lt', val1: 1000000, val2: null }
  ]
};

function formatColDisplayValue(row, col) {
  const raw = row[col];
  if (col === 'score') return `${raw ?? 0} / 5`;
  if (col === 'breakout') return raw === 'YES' ? 'YES' : 'NO';
  if (col === 'accumulation') return raw === 'ACCUMULATION' ? 'ACCUMULATION' : 'NONE';
  if (col === 'rs_score') return raw != null ? Number(raw).toFixed(3) : '—';
  if (col === 'rvol') return raw != null ? `${Number(raw).toFixed(2)}x` : '—';
  if (col === 'volatility') return raw != null ? `${Number(raw).toFixed(1)}%` : '—';
  if (col === 'price' || col === 'sma20' || col === 'sma50' || col === 'sma200') {
    return raw != null ? `₹${Number(raw).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
  }
  if (col === 'vol_today' || col === 'vol20') {
    return raw != null ? Number(raw).toLocaleString('en-IN') : '—';
  }
  return raw != null && raw !== '' ? String(raw) : '—';
}

function isColFilterActive(f) {
  if (!f) return false;
  if (f.selectedValues instanceof Set) return true;
  if (f.op && f.op !== 'ALL') return true;
  return false;
}

function rowMatchesSingleColFilter(row, col, f) {
  if (!isColFilterActive(f)) return true;

  if (f.selectedValues instanceof Set) {
    const valStr = formatColDisplayValue(row, col);
    if (!f.selectedValues.has(valStr)) return false;
  }

  if (f.op && f.op !== 'ALL') {
    if (f.op === 'above_sma') {
      const p = Number(row.price);
      const s = Number(row[col]);
      if (isNaN(p) || isNaN(s) || p <= s) return false;
      return true;
    }
    if (f.op === 'below_sma') {
      const p = Number(row.price);
      const s = Number(row[col]);
      if (isNaN(p) || isNaN(s) || p >= s) return false;
      return true;
    }

    const num = Number(row[col]);
    if (isNaN(num)) return false;
    const v1 = f.val1 !== null && f.val1 !== '' && !isNaN(Number(f.val1)) ? Number(f.val1) : null;
    const v2 = f.val2 !== null && f.val2 !== '' && !isNaN(Number(f.val2)) ? Number(f.val2) : null;

    if (f.op === 'gte' && v1 !== null && num < v1) return false;
    if (f.op === 'lte' && v1 !== null && num > v1) return false;
    if (f.op === 'gt' && v1 !== null && num <= v1) return false;
    if (f.op === 'lt' && v1 !== null && num >= v1) return false;
    if (f.op === 'eq' && v1 !== null && Math.abs(num - v1) > 1e-6) return false;
    if (f.op === 'between') {
      if (v1 !== null && num < v1) return false;
      if (v2 !== null && num > v2) return false;
    }
  }

  return true;
}

function rowMatchesColFilters(row, filtersMap, ignoreCol = null) {
  for (const [col, f] of Object.entries(filtersMap)) {
    if (col === ignoreCol) continue;
    if (!rowMatchesSingleColFilter(row, col, f)) return false;
  }
  return true;
}

function updateColHeaderFilterIndicators(tableId, filtersMap, clearBtnId) {
  const table = document.getElementById(tableId);
  if (!table) return;
  let activeCount = 0;

  table.querySelectorAll('thead th[data-sort]').forEach(th => {
    const col = th.getAttribute('data-sort');
    const active = isColFilterActive(filtersMap[col]);
    th.classList.toggle('has-col-filter', active);
    if (active) activeCount++;
  });

  const clearBtn = document.getElementById(clearBtnId);
  if (clearBtn) {
    if (activeCount > 0) {
      clearBtn.style.display = 'inline-flex';
      clearBtn.innerHTML = `<span>✕ Clear Column Filters (${activeCount})</span>`;
    } else {
      clearBtn.style.display = 'none';
    }
  }
}

function enhanceTableHeadersWithExcelFilters() {
  ['table-stock-strength', 'table-strength'].forEach(tableId => {
    const table = document.getElementById(tableId);
    if (!table) return;

    table.querySelectorAll('thead th[data-sort]').forEach(th => {
      if (th.querySelector('.th-excel-wrap')) return;
      const col = th.getAttribute('data-sort');
      const label = th.textContent.trim();

      th.innerHTML = `
        <div class="th-excel-wrap">
          <span class="th-label-text">${label}</span>
          <button type="button" class="th-filter-btn" title="Filter ${label} (Excel Dropdown)">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 4h18l-7 8v7l-4 2v-9L3 4z"/></svg>
          </button>
        </div>
      `;

      const filterBtn = th.querySelector('.th-filter-btn');
      filterBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openExcelFilterPopover(tableId, col, label, th, filterBtn);
      });
    });
  });

  document.addEventListener('mousedown', (e) => {
    const pop = document.getElementById('excel-filter-popover');
    if (!pop || !pop.classList.contains('visible')) return;
    if (pop.contains(e.target) || e.target.closest('.th-filter-btn')) return;
    closeExcelFilterPopover();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeExcelFilterPopover();
  });

  document.getElementById('stock-table-scroll')?.addEventListener('scroll', () => {
    if (activeExcelPopover) positionExcelPopover(activeExcelPopover.thEl);
  });
}

function positionExcelPopover(thEl) {
  const pop = document.getElementById('excel-filter-popover');
  if (!pop || !thEl) return;
  const rect = thEl.getBoundingClientRect();
  const popWidth = 276;
  let left = rect.left;
  if (left + popWidth > window.innerWidth - 12) {
    left = Math.max(12, window.innerWidth - popWidth - 12);
  }
  const top = Math.min(rect.bottom + 4, window.innerHeight - pop.offsetHeight - 12);
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(12, top)}px`;
}

function closeExcelFilterPopover() {
  const pop = document.getElementById('excel-filter-popover');
  if (pop) pop.classList.remove('visible');
  document.querySelectorAll('.th-filter-btn.open').forEach(b => b.classList.remove('open'));
  activeExcelPopover = null;
}

function openExcelFilterPopover(tableId, col, label, thEl, btnEl) {
  const pop = document.getElementById('excel-filter-popover');
  if (!pop) return;

  if (activeExcelPopover && activeExcelPopover.tableId === tableId && activeExcelPopover.col === col) {
    closeExcelFilterPopover();
    return;
  }

  document.querySelectorAll('.th-filter-btn.open').forEach(b => b.classList.remove('open'));
  btnEl.classList.add('open');
  activeExcelPopover = { tableId, col, thEl, btnEl };

  const isStockTable = tableId === 'table-stock-strength';
  const sourceRows = isStockTable
    ? (stockStrengthData?.rows || [])
    : (dashboardData?.strength_indicators || []);
  const filtersMap = isStockTable ? stockColFilters : sectorColFilters;
  const currentFilter = filtersMap[col] || { selectedValues: null, op: 'ALL', val1: null, val2: null };

  // Filter rows by all OTHER columns to compute accurate Excel-style value counts
  const contextRows = sourceRows.filter(r => rowMatchesColFilters(r, filtersMap, col));

  // Build unique values & counts
  const valueMap = new Map();
  contextRows.forEach(r => {
    const disp = formatColDisplayValue(r, col);
    const raw = r[col];
    if (!valueMap.has(disp)) {
      valueMap.set(disp, { disp, raw, count: 0 });
    }
    valueMap.get(disp).count++;
  });

  // Ensure any previously selected values remain visible even if count is 0
  if (currentFilter.selectedValues instanceof Set) {
    currentFilter.selectedValues.forEach(v => {
      if (!valueMap.has(v)) valueMap.set(v, { disp: v, raw: v, count: 0 });
    });
  }

  const isNumeric = NUMERIC_COLS.has(col);
  const uniqueItems = Array.from(valueMap.values()).sort((a, b) => {
    if (isNumeric && typeof a.raw === 'number' && typeof b.raw === 'number') {
      return b.raw - a.raw;
    }
    return String(a.disp).localeCompare(String(b.disp));
  });

  const allValueStrings = uniqueItems.map(u => u.disp);
  let draftSelected = currentFilter.selectedValues instanceof Set
    ? new Set(currentFilter.selectedValues)
    : new Set(allValueStrings);
  let draftOp = currentFilter.op || 'ALL';
  let draftVal1 = currentFilter.val1 ?? '';
  let draftVal2 = currentFilter.val2 ?? '';

  const isSortedAsc = isStockTable
    ? (stockSortCol === col && stockSortDir === 'asc')
    : (strengthSortCol === col && strengthSortAsc === true);
  const isSortedDesc = isStockTable
    ? (stockSortCol === col && stockSortDir === 'desc')
    : (strengthSortCol === col && strengthSortAsc === false);

  const presets = COL_PRESETS[col] || [];
  const hasSmaOps = col === 'sma20' || col === 'sma50' || col === 'sma200';

  pop.innerHTML = `
    <div class="efp-header">
      <span class="efp-title">${label} Filter</span>
      <button type="button" class="efp-close" id="efp-btn-close">&times;</button>
    </div>

    <div class="efp-sort-group">
      <button type="button" class="efp-sort-btn ${isSortedAsc ? 'active' : ''}" id="efp-sort-asc">
        ▲ ${isNumeric ? 'Smallest → Largest' : 'Sort A → Z'}
      </button>
      <button type="button" class="efp-sort-btn ${isSortedDesc ? 'active' : ''}" id="efp-sort-desc">
        ▼ ${isNumeric ? 'Largest → Smallest' : 'Sort Z → A'}
      </button>
    </div>

    ${isNumeric ? `
      <div class="efp-section">
        <div class="efp-section-label">Condition / Range Filter</div>
        <div class="efp-num-row">
          <select class="efp-select" id="efp-op-select">
            <option value="ALL" ${draftOp === 'ALL' ? 'selected' : ''}>Any Value</option>
            ${hasSmaOps ? `
              <option value="above_sma" ${draftOp === 'above_sma' ? 'selected' : ''}>Price &gt; ${label}</option>
              <option value="below_sma" ${draftOp === 'below_sma' ? 'selected' : ''}>Price &lt; ${label}</option>
            ` : ''}
            <option value="gte" ${draftOp === 'gte' ? 'selected' : ''}>&ge; Greater/Eq</option>
            <option value="lte" ${draftOp === 'lte' ? 'selected' : ''}>&le; Less/Eq</option>
            <option value="gt" ${draftOp === 'gt' ? 'selected' : ''}>&gt; Greater</option>
            <option value="lt" ${draftOp === 'lt' ? 'selected' : ''}>&lt; Less</option>
            <option value="eq" ${draftOp === 'eq' ? 'selected' : ''}>= Equals</option>
            <option value="between" ${draftOp === 'between' ? 'selected' : ''}>Between</option>
          </select>
          <input type="number" step="any" class="efp-input" id="efp-val1" placeholder="Value" value="${draftVal1}" style="display:${['ALL', 'above_sma', 'below_sma'].includes(draftOp) ? 'none' : 'block'};">
          <input type="number" step="any" class="efp-input" id="efp-val2" placeholder="Max" value="${draftVal2}" style="display:${draftOp === 'between' ? 'block' : 'none'};">
        </div>
        ${presets.length > 0 ? `
          <div class="efp-presets">
            ${presets.map((p, idx) => `
              <button type="button" class="efp-preset-chip ${draftOp === p.op && String(draftVal1) === String(p.val1 ?? '') && String(draftVal2) === String(p.val2 ?? '') ? 'active' : ''}" data-preset-idx="${idx}">
                ${p.label}
              </button>
            `).join('')}
          </div>
        ` : ''}
      </div>
    ` : ''}

    <div class="efp-search-box">
      <input type="text" id="efp-val-search" placeholder="Search ${label.toLowerCase()} values..." autocomplete="off">
    </div>

    <div class="efp-values-list" id="efp-values-list"></div>

    <div class="efp-footer">
      <button type="button" class="efp-btn-clear" id="efp-btn-clear">Clear Filter</button>
      <button type="button" class="efp-btn-apply" id="efp-btn-apply">Apply Filter</button>
    </div>
  `;

  pop.classList.add('visible');
  positionExcelPopover(thEl);

  const listContainer = pop.querySelector('#efp-values-list');
  const searchInput = pop.querySelector('#efp-val-search');

  function renderCheckboxList(query = '') {
    const q = query.trim().toLowerCase();
    const visibleItems = q
      ? uniqueItems.filter(u => u.disp.toLowerCase().includes(q))
      : uniqueItems;

    const allVisibleChecked = visibleItems.length > 0 && visibleItems.every(u => draftSelected.has(u.disp));

    listContainer.innerHTML = `
      <label class="efp-val-item select-all-row">
        <span class="efp-val-left">
          <input type="checkbox" id="efp-chk-all" ${allVisibleChecked ? 'checked' : ''}>
          <span>(Select All${q ? ' Matching' : ''})</span>
        </span>
        <span class="efp-val-count">${visibleItems.length}</span>
      </label>
      ${visibleItems.map(u => `
        <label class="efp-val-item">
          <span class="efp-val-left">
            <input type="checkbox" class="efp-chk-val" data-val="${u.disp.replace(/"/g, '&quot;')}" ${draftSelected.has(u.disp) ? 'checked' : ''}>
            <span>${u.disp}</span>
          </span>
          <span class="efp-val-count">${u.count}</span>
        </label>
      `).join('')}
    `;

    const chkAll = listContainer.querySelector('#efp-chk-all');
    chkAll?.addEventListener('change', (e) => {
      if (e.target.checked) {
        visibleItems.forEach(u => draftSelected.add(u.disp));
      } else {
        visibleItems.forEach(u => draftSelected.delete(u.disp));
      }
      renderCheckboxList(searchInput.value);
    });

    listContainer.querySelectorAll('.efp-chk-val').forEach(chk => {
      chk.addEventListener('change', (e) => {
        const val = e.target.getAttribute('data-val');
        if (e.target.checked) {
          draftSelected.add(val);
        } else {
          draftSelected.delete(val);
        }
        if (chkAll) {
          chkAll.checked = visibleItems.length > 0 && visibleItems.every(u => draftSelected.has(u.disp));
        }
      });
    });
  }

  renderCheckboxList('');

  searchInput?.addEventListener('input', (e) => {
    renderCheckboxList(e.target.value);
  });

  // Sort buttons inside popover
  pop.querySelector('#efp-sort-asc')?.addEventListener('click', () => {
    applyTableSort(tableId, col, 'asc');
    closeExcelFilterPopover();
  });

  pop.querySelector('#efp-sort-desc')?.addEventListener('click', () => {
    applyTableSort(tableId, col, 'desc');
    closeExcelFilterPopover();
  });

  // Numeric operator & presets
  const opSelect = pop.querySelector('#efp-op-select');
  const val1Input = pop.querySelector('#efp-val1');
  const val2Input = pop.querySelector('#efp-val2');

  opSelect?.addEventListener('change', (e) => {
    draftOp = e.target.value;
    if (val1Input) val1Input.style.display = ['ALL', 'above_sma', 'below_sma'].includes(draftOp) ? 'none' : 'block';
    if (val2Input) val2Input.style.display = draftOp === 'between' ? 'block' : 'none';
    pop.querySelectorAll('.efp-preset-chip').forEach(c => c.classList.remove('active'));
  });

  val1Input?.addEventListener('input', (e) => {
    draftVal1 = e.target.value;
    pop.querySelectorAll('.efp-preset-chip').forEach(c => c.classList.remove('active'));
  });

  val2Input?.addEventListener('input', (e) => {
    draftVal2 = e.target.value;
    pop.querySelectorAll('.efp-preset-chip').forEach(c => c.classList.remove('active'));
  });

  pop.querySelectorAll('.efp-preset-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const idx = parseInt(chip.getAttribute('data-preset-idx'), 10);
      const p = presets[idx];
      if (!p) return;

      const isAlreadyActive = chip.classList.contains('active');
      pop.querySelectorAll('.efp-preset-chip').forEach(c => c.classList.remove('active'));

      if (isAlreadyActive) {
        draftOp = 'ALL';
        draftVal1 = '';
        draftVal2 = '';
      } else {
        chip.classList.add('active');
        draftOp = p.op;
        draftVal1 = p.val1 ?? '';
        draftVal2 = p.val2 ?? '';
      }

      if (opSelect) opSelect.value = draftOp;
      if (val1Input) {
        val1Input.value = draftVal1;
        val1Input.style.display = ['ALL', 'above_sma', 'below_sma'].includes(draftOp) ? 'none' : 'block';
      }
      if (val2Input) {
        val2Input.value = draftVal2;
        val2Input.style.display = draftOp === 'between' ? 'block' : 'none';
      }
    });
  });

  pop.querySelector('#efp-btn-close')?.addEventListener('click', closeExcelFilterPopover);

  pop.querySelector('#efp-btn-clear')?.addEventListener('click', () => {
    delete filtersMap[col];
    closeExcelFilterPopover();
    if (isStockTable) renderStockStrengthTable();
    else renderStrengthTable();
  });

  pop.querySelector('#efp-btn-apply')?.addEventListener('click', () => {
    const isAllValuesChecked = draftSelected.size === allValueStrings.length;
    const hasOp = isNumeric && draftOp && draftOp !== 'ALL';

    if (isAllValuesChecked && !hasOp) {
      delete filtersMap[col];
    } else {
      filtersMap[col] = {
        selectedValues: isAllValuesChecked ? null : new Set(draftSelected),
        op: hasOp ? draftOp : 'ALL',
        val1: draftVal1 !== '' ? Number(draftVal1) : null,
        val2: draftVal2 !== '' ? Number(draftVal2) : null
      };
    }

    closeExcelFilterPopover();
    if (isStockTable) renderStockStrengthTable();
    else renderStrengthTable();
  });
}

function applyTableSort(tableId, col, dir) {
  if (tableId === 'table-stock-strength') {
    stockSortCol = col;
    stockSortDir = dir;
    document.querySelectorAll('#table-stock-strength thead th').forEach(h => {
      h.classList.remove('sort-asc', 'sort-desc');
      if (h.getAttribute('data-sort') === col) {
        h.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');
      }
    });
    renderStockStrengthTable();
  } else {
    strengthSortCol = col;
    strengthSortAsc = (dir === 'asc');
    document.querySelectorAll('#table-strength thead th').forEach(h => {
      h.classList.remove('sort-asc', 'sort-desc');
      if (h.getAttribute('data-sort') === col) {
        h.classList.add(strengthSortAsc ? 'sort-asc' : 'sort-desc');
      }
    });
    renderStrengthTable();
  }
}

// =================================================================
// TRADE LIBRARY (STORED & LOGGED TRADES)
// =================================================================
let libraryTrades = [];
let librarySummary = {};
let libraryLoading = false;
let libSortCol = 'date';
let libSortDir = 'desc';
let libSearchQuery = '';
let libStatusFilter = 'ALL';
let libTypeFilter = 'ALL';
let libQuickFilter = 'all';

function initTradeLibrary() {
  setupTradeLibraryListeners();
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

  const totalEl = document.getElementById('lib-kpi-total');
  if (totalEl) totalEl.textContent = librarySummary.total_trades ?? libraryTrades.length;

  const openEl = document.getElementById('lib-kpi-open');
  if (openEl) openEl.textContent = librarySummary.open_count ?? 0;

  const closedEl = document.getElementById('lib-kpi-closed');
  if (closedEl) closedEl.textContent = librarySummary.closed_count ?? 0;

  const pnlEl = document.getElementById('lib-kpi-pnl');
  if (pnlEl) {
    const pnl = Number(librarySummary.realized_pnl || 0);
    pnlEl.textContent = `${pnl >= 0 ? '+' : ''}₹${pnl.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    pnlEl.className = 'kpi-val font-mono ' + (pnl > 0 ? 'text-emerald' : (pnl < 0 ? 'text-rose' : 'text-white'));
  }

  const winrateEl = document.getElementById('lib-kpi-winrate');
  if (winrateEl) {
    winrateEl.textContent = `Win Rate: ${librarySummary.win_rate ?? 0.0}% (${librarySummary.closed_count ?? 0} closed)`;
  }

  const ratioEl = document.getElementById('lib-kpi-ratio');
  if (ratioEl) {
    ratioEl.textContent = `${librarySummary.win_count ?? 0}W / ${librarySummary.loss_count ?? 0}L`;
  }
}

function setupTradeLibraryListeners() {
  // Modal open/close
  document.getElementById('btn-open-new-trade-modal')?.addEventListener('click', () => {
    openTradeEntryModal();
  });

  document.getElementById('btn-close-trade-modal')?.addEventListener('click', closeTradeEntryModal);
  document.getElementById('btn-cancel-trade')?.addEventListener('click', closeTradeEntryModal);

  // Form submit
  document.getElementById('form-trade-entry')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveTradeFromModal();
  });

  // Import from Kite
  document.getElementById('btn-import-kite-trades')?.addEventListener('click', async () => {
    await importTradesFromKite();
  });

  // Sync Daily Snapshots
  document.getElementById('btn-sync-daily-snapshots')?.addEventListener('click', async () => {
    await syncDailySnapshots();
  });

  // Export CSV
  document.getElementById('btn-export-lib-csv')?.addEventListener('click', () => {
    exportTradeLibraryCSV();
  });

  // History modal close
  document.getElementById('btn-close-history-modal')?.addEventListener('click', closeTradeHistoryModal);
  document.getElementById('btn-close-history-footer')?.addEventListener('click', closeTradeHistoryModal);

  // Search input
  const searchInput = document.getElementById('lib-search-input');
  const clearBtn = document.getElementById('btn-clear-lib-search');
  searchInput?.addEventListener('input', (e) => {
    libSearchQuery = e.target.value.trim().toLowerCase();
    if (clearBtn) clearBtn.style.display = libSearchQuery ? 'block' : 'none';
    renderTradeLibraryTable();
  });

  clearBtn?.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    libSearchQuery = '';
    clearBtn.style.display = 'none';
    renderTradeLibraryTable();
  });

  // Status & Type filter
  document.getElementById('lib-filter-status')?.addEventListener('change', (e) => {
    libStatusFilter = e.target.value;
    renderTradeLibraryTable();
  });

  document.getElementById('lib-filter-type')?.addEventListener('change', (e) => {
    libTypeFilter = e.target.value;
    renderTradeLibraryTable();
  });

  // Quick pills
  document.querySelectorAll('[data-lib-filter]').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('[data-lib-filter]').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      libQuickFilter = pill.getAttribute('data-lib-filter');
      renderTradeLibraryTable();
    });
  });

  // Table header sorting
  document.querySelectorAll('#table-trades-library thead th[data-lib-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.getAttribute('data-lib-sort');
      if (!col) return;
      if (libSortCol === col) {
        libSortDir = libSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        libSortCol = col;
        libSortDir = ['symbol', 'trade_type', 'status', 'strategy', 'date'].includes(col) ? 'asc' : 'desc';
      }

      document.querySelectorAll('#table-trades-library thead th').forEach(h => {
        h.classList.remove('sort-asc', 'sort-desc');
      });
      th.classList.add(libSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      renderTradeLibraryTable();
    });
  });
}

function openTradeEntryModal(existingTrade = null, screenerSnapshot = null) {
  const modal = document.getElementById('trade-modal');
  if (!modal) return;

  const title = document.getElementById('trade-modal-title');
  const editIdInput = document.getElementById('trade-edit-id');
  const symInput = document.getElementById('trade-sym');
  const typeSelect = document.getElementById('trade-type');
  const statusSelect = document.getElementById('trade-status');
  const stratInput = document.getElementById('trade-strategy');
  const qtyInput = document.getElementById('trade-qty');
  const entryInput = document.getElementById('trade-entry');
  const exitInput = document.getElementById('trade-exit');
  const targetInput = document.getElementById('trade-target');
  const slInput = document.getElementById('trade-sl');
  const dateInput = document.getElementById('trade-date');
  const exitDateInput = document.getElementById('trade-exit-date');
  const notesInput = document.getElementById('trade-notes');

  // Stored pending snapshot in window state for submit
  window._pendingTradeSnapshot = screenerSnapshot || (existingTrade ? existingTrade.snapshot : null);

  if (existingTrade) {
    if (title) title.textContent = `Edit Trade: ${existingTrade.symbol}`;
    if (editIdInput) editIdInput.value = existingTrade.id;
    if (symInput) symInput.value = existingTrade.symbol;
    if (typeSelect) typeSelect.value = existingTrade.trade_type || 'BUY';
    if (statusSelect) statusSelect.value = existingTrade.status || 'OPEN';
    if (stratInput) stratInput.value = existingTrade.strategy || '';
    if (qtyInput) qtyInput.value = existingTrade.quantity || 1;
    if (entryInput) entryInput.value = existingTrade.entry_price || '';
    if (exitInput) exitInput.value = existingTrade.exit_price ?? '';
    if (targetInput) targetInput.value = existingTrade.target ?? '';
    if (slInput) slInput.value = existingTrade.stop_loss ?? '';
    if (dateInput) dateInput.value = existingTrade.date || '';
    if (exitDateInput) exitDateInput.value = existingTrade.exit_date || '';
    if (notesInput) notesInput.value = existingTrade.notes || '';
  } else if (screenerSnapshot) {
    const sym = (screenerSnapshot.ticker || screenerSnapshot.symbol || '').replace('.NS', '');
    const price = screenerSnapshot.price || 0;
    const strat = screenerSnapshot.breakout === 'YES' ? '50D Breakout Setup' : (screenerSnapshot.accumulation === 'ACCUMULATION' ? 'Heavy Accumulation' : 'Relative Strength Momentum');

    if (title) title.textContent = `Log Trade: ${sym} (From Screener Snapshot)`;
    if (editIdInput) editIdInput.value = '';
    if (symInput) symInput.value = sym;
    if (typeSelect) typeSelect.value = 'BUY';
    if (statusSelect) statusSelect.value = 'OPEN';
    if (stratInput) stratInput.value = strat;
    if (qtyInput) qtyInput.value = '100';
    if (entryInput) entryInput.value = price;
    if (exitInput) exitInput.value = '';
    if (targetInput) targetInput.value = price ? (price * 1.10).toFixed(2) : '';
    if (slInput) slInput.value = screenerSnapshot.sma20 ? screenerSnapshot.sma20.toFixed(2) : (price ? (price * 0.95).toFixed(2) : '');
    if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
    if (exitDateInput) exitDateInput.value = '';
    if (notesInput) notesInput.value = `Captured from Screener: Trend=${screenerSnapshot.trend}, RS=${screenerSnapshot.rs_score?.toFixed(3)}, RVOL=${screenerSnapshot.rvol?.toFixed(2)}x, Score=${screenerSnapshot.score}/5`;
  } else {
    if (title) title.textContent = 'Log New Trade';
    if (editIdInput) editIdInput.value = '';
    if (symInput) symInput.value = '';
    if (typeSelect) typeSelect.value = 'BUY';
    if (statusSelect) statusSelect.value = 'OPEN';
    if (stratInput) stratInput.value = 'Covered Call / Momentum';
    if (qtyInput) qtyInput.value = '100';
    if (entryInput) entryInput.value = '';
    if (exitInput) exitInput.value = '';
    if (targetInput) targetInput.value = '';
    if (slInput) slInput.value = '';
    if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
    if (exitDateInput) exitDateInput.value = '';
    if (notesInput) notesInput.value = '';
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
    let res;
    if (editId) {
      res = await fetch(`/api/trades/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch('/api/trades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

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

  let list = [...libraryTrades];
  const total = list.length;

  // Search filter
  if (libSearchQuery) {
    list = list.filter(t => 
      (t.symbol && t.symbol.toLowerCase().includes(libSearchQuery)) ||
      (t.strategy && t.strategy.toLowerCase().includes(libSearchQuery)) ||
      (t.notes && t.notes.toLowerCase().includes(libSearchQuery))
    );
  }

  // Status dropdown filter
  if (libStatusFilter !== 'ALL') {
    list = list.filter(t => t.status === libStatusFilter);
  }

  // Type dropdown filter
  if (libTypeFilter !== 'ALL') {
    list = list.filter(t => t.trade_type === libTypeFilter);
  }

  // Quick pills filter
  if (libQuickFilter === 'open') {
    list = list.filter(t => t.status === 'OPEN');
  } else if (libQuickFilter === 'closed') {
    list = list.filter(t => t.status === 'CLOSED');
  } else if (libQuickFilter === 'winners') {
    list = list.filter(t => (t.pnl || 0) > 0);
  } else if (libQuickFilter === 'losers') {
    list = list.filter(t => (t.pnl || 0) < 0);
  }

  // Sorting
  list.sort((a, b) => {
    const va = a[libSortCol] ?? '';
    const vb = b[libSortCol] ?? '';
    if (typeof va === 'number' && typeof vb === 'number') {
      return libSortDir === 'asc' ? va - vb : vb - va;
    }
    return libSortDir === 'asc'
      ? String(va).toLowerCase().localeCompare(String(vb).toLowerCase())
      : String(vb).toLowerCase().localeCompare(String(va).toLowerCase());
  });

  if (counterEl) {
    counterEl.textContent = `Showing ${list.length} of ${total} trades`;
  }

  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="15" style="text-align:center; padding: 48px; color: var(--text-muted);">
          No stored trades found. Click <strong>+ Log Trade</strong> or <strong>Import Kite</strong> to store your first trade.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = list.map(t => {
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
    const snap = t.snapshot || {};
    const dailyCount = Array.isArray(t.daily_snapshots) ? t.daily_snapshots.length : 0;
    
    // Quick indicator pill summary
    let indPills = '';
    if (snap.trend) {
      indPills += `<span class="trend-badge ${snap.trend}" style="font-size:0.65rem; padding:1px 5px;">${snap.trend}</span> `;
    }
    if (snap.rs_rating) {
      indPills += `<span class="rs-rating-pill ${getRsRatingTier(snap.rs_rating)}" style="font-size:0.65rem; padding:1px 5px;">${snap.rs_rating}</span> `;
    }
    if (snap.score) {
      indPills += `<span style="font-family:var(--font-mono); font-size:0.7rem; font-weight:700; color:var(--cyan);">${snap.score}/5</span>`;
    }

    return `
      <tr>
        <td class="stock-ticker-cell">
          <strong style="color: #fff;">${t.symbol}</strong>
          ${t.source === 'KITE_IMPORT' ? '<span class="badge-live-kite" style="font-size:0.6rem; padding:1px 4px;" title="Imported from Zerodha Kite">Kite</span>' : ''}
        </td>
        <td>${typeBadge}</td>
        <td>${statusBadge}</td>
        <td style="color: var(--text-secondary);">${t.strategy || '—'}</td>
        <td class="num font-mono">${Number(t.quantity || 0).toLocaleString()}</td>
        <td class="num font-mono">₹${Number(t.entry_price || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td class="num font-mono">${t.exit_price ? '₹' + Number(t.exit_price).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '<span style="color:var(--text-muted); opacity:0.3;">—</span>'}</td>
        <td class="num font-mono">${t.target ? '₹' + Number(t.target).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '<span style="color:var(--text-muted); opacity:0.3;">—</span>'}</td>
        <td class="num font-mono">${t.stop_loss ? '₹' + Number(t.stop_loss).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '<span style="color:var(--text-muted); opacity:0.3;">—</span>'}</td>
        <td class="num">${pnlHtml}</td>
        <td class="num">${pnlPctHtml}</td>
        <td class="font-mono" style="font-size: 0.72rem; color: var(--text-muted);">${t.date || '—'}</td>
        <td>
          <div style="display: flex; align-items: center; gap: 6px;">
            <div>${indPills || '<span style="color:var(--text-muted); font-size:0.7rem;">No Snapshot</span>'}</div>
            <button class="btn btn-sm btn-outline" style="padding: 1px 6px; font-size: 0.65rem;" onclick='openTradeHistoryModal(${tradeJson})' title="View daily indicator log history">
              📊 ${dailyCount}d Log
            </button>
          </div>
        </td>
        <td style="max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: 0.74rem;" title="${t.notes || ''}">
          ${t.notes || '<span style="opacity:0.3;">—</span>'}
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
  if (!libraryTrades || libraryTrades.length === 0) {
    showToast('No trades in library to export');
    return;
  }

  const headers = [
    'ID', 'Symbol', 'Type', 'Status', 'Strategy', 'Quantity', 'Entry_Price',
    'Exit_Price', 'Target', 'Stop_Loss', 'PnL', 'PnL_Pct', 'Date', 'Exit_Date', 'Source', 'Notes'
  ];

  const csvRows = [headers.join(',')];

  libraryTrades.forEach(t => {
    csvRows.push([
      `"${t.id || ''}"`,
      `"${t.symbol || ''}"`,
      `"${t.trade_type || 'BUY'}"`,
      `"${t.status || 'OPEN'}"`,
      `"${t.strategy || ''}"`,
      t.quantity ?? '',
      t.entry_price ?? '',
      t.exit_price ?? '',
      t.target ?? '',
      t.stop_loss ?? '',
      t.pnl ?? '',
      t.pnl_pct ?? '',
      `"${t.date || ''}"`,
      `"${t.exit_date || ''}"`,
      `"${t.source || 'MANUAL'}"`,
      `"${(t.notes || '').replace(/"/g, '""')}"`
    ].join(','));
  });

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `Trades_Library_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('📥 Exported Trades_Library.csv');
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
    const isBuy = (trade.trade_type || 'BUY') === 'BUY';
    const statusClass = trade.status === 'OPEN' ? 'text-cyan' : 'text-emerald';
    summaryEl.innerHTML = `
      <div><span style="color:var(--text-muted); font-size:0.75rem;">Status:</span> <strong class="${statusClass}">${trade.status}</strong></div>
      <div><span style="color:var(--text-muted); font-size:0.75rem;">Type:</span> <strong>${trade.trade_type}</strong></div>
      <div><span style="color:var(--text-muted); font-size:0.75rem;">Quantity:</span> <strong class="font-mono">${trade.quantity}</strong></div>
      <div><span style="color:var(--text-muted); font-size:0.75rem;">Entry Price:</span> <strong class="font-mono">₹${Number(trade.entry_price || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</strong></div>
      <div><span style="color:var(--text-muted); font-size:0.75rem;">Entry Date:</span> <strong class="font-mono">${trade.date || '—'}</strong></div>
      ${trade.exit_price ? `<div><span style="color:var(--text-muted); font-size:0.75rem;">Exit Price:</span> <strong class="font-mono">₹${Number(trade.exit_price).toLocaleString('en-IN', {minimumFractionDigits: 2})}</strong></div>` : ''}
      ${trade.pnl ? `<div><span style="color:var(--text-muted); font-size:0.75rem;">Realized PnL:</span> <strong class="font-mono ${trade.pnl > 0 ? 'text-emerald' : 'text-rose'}">₹${Number(trade.pnl).toLocaleString('en-IN', {minimumFractionDigits: 2})} (${trade.pnl_pct}%)</strong></div>` : ''}
    `;
  }

  const tbody = document.getElementById('tbody-trade-history');
  if (tbody) {
    const snapshots = Array.isArray(trade.daily_snapshots) ? trade.daily_snapshots : [];
    if (snapshots.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="14" style="text-align:center; padding:32px; color:var(--text-muted);">
            No daily snapshots recorded yet for ${trade.symbol}. Click <strong>Sync Today's Data</strong> to capture current indicator values.
          </td>
        </tr>
      `;
    } else {
      tbody.innerHTML = snapshots.map(s => {
        return `
          <tr>
            <td class="font-mono" style="font-weight:700; color:#fff;">${s.date} <span style="font-size:0.68rem; color:var(--text-muted); font-weight:normal;">${s.timestamp ? s.timestamp.slice(11) : ''}</span></td>
            <td class="num font-mono font-bold" style="color:var(--cyan);">₹${Number(s.price || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td class="num font-mono">${s.sma20 ? '₹' + Number(s.sma20).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</td>
            <td class="num font-mono">${s.sma50 ? '₹' + Number(s.sma50).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</td>
            <td class="num font-mono">${s.sma200 ? '₹' + Number(s.sma200).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</td>
            <td><span class="trend-badge ${s.trend || 'trend-weak'}">${s.trend || '—'}</span></td>
            <td class="num font-mono">${s.rs_score !== null && s.rs_score !== undefined ? Number(s.rs_score).toFixed(3) : '—'}</td>
            <td class="num"><span class="rs-rating-pill ${getRsRatingTier(s.rs_rating)}">${s.rs_rating || '—'}</span></td>
            <td><span class="rs-signal-badge ${s.rs_signal || 'NEUTRAL'}">${s.rs_signal || '—'}</span></td>
            <td class="num font-mono ${s.rvol > 1.5 ? 'rvol-high' : ''}">${s.rvol ? Number(s.rvol).toFixed(2) + 'x' : '—'}</td>
            <td>${s.breakout === 'YES' ? '<span class="badge-breakout">YES</span>' : '<span style="color:var(--text-muted);opacity:0.3;">—</span>'}</td>
            <td>${s.accumulation === 'ACCUMULATION' ? '<span class="badge-accum">ACCUM</span>' : '<span style="color:var(--text-muted);opacity:0.3;">—</span>'}</td>
            <td>${renderScorePips(s.score || 0)}</td>
            <td class="num font-mono">${s.volatility ? Number(s.volatility).toFixed(1) + '%' : '—'}</td>
          </tr>
        `;
      }).join('');
    }
  }

  modal.style.display = 'flex';
}

function closeTradeHistoryModal() {
  const modal = document.getElementById('trade-history-modal');
  if (modal) modal.style.display = 'none';
}

