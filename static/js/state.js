/**
 * Kite Pulse — Shared State, Constants & Reusable UI Helpers
 */

// =================================================================
// APPLICATION STATE
// =================================================================
let dashboardData = null;
let chartStyle = 'PULSE'; // 'PULSE' or 'SC'
let scTailLen = 8;
let scEndOffset = 0;
let scTimer = null;
let currentEngineMode = 'yfinance';
let currentTimeframe = 'daily';
let currentQuadrantFilter = 'ALL';
let hoveredSector = null;
let selectedSector = null;

// RRG Canvas Controls
let focusMode = 'CLUSTER';
let labelMode = 'STAGGERED';
let zoomLevel = 1.0;
let panOffsetX = 0;
let panOffsetY = 0;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let hasDragged = false;
let initialPanX = 0;
let initialPanY = 0;

// Sector Strength Matrix State
let strengthSortCol = 'score';
let strengthSortAsc = false;
let searchQuery = '';
let sectorColFilters = {};

// Stock Strength Screener State
let stockStrengthData = null;
let stockStrengthLoading = false;
let stockSortCol = 'score';
let stockSortDir = 'desc';
let stockSearchQuery = '';
let stockQuickPill = 'all';
let stockColFilters = {};
let lastFilteredStockRows = [];

// Trade Library State
let libraryTrades = [];
let librarySummary = {};
let libraryLoading = false;
let libSortCol = 'date';
let libSortDir = 'desc';
let libSearchQuery = '';
let libStatusFilter = 'ALL';
let libTypeFilter = 'ALL';
let libQuickFilter = 'all';
let libColFilters = {};

// Shared Timers & Popover State
let activeExcelPopover = null;
let countdownTimer = null;
let remainingCacheSeconds = 900;

// =================================================================
// COLOR & FILTER CONSTANTS
// =================================================================
const QUAD_COLORS = {
  LEADING:   { stroke: '#10b981', fill: 'rgba(16, 185, 129, 0.25)', bg: 'rgba(16, 185, 129, 0.05)', text: '#10b981', chipClass: 'chip-leading', badgeClass: 'quad-leading' },
  IMPROVING: { stroke: '#06b6d4', fill: 'rgba(6, 182, 212, 0.25)',  bg: 'rgba(6, 182, 212, 0.05)',  text: '#06b6d4', chipClass: 'chip-improving', badgeClass: 'quad-improving' },
  WEAKENING: { stroke: '#f59e0b', fill: 'rgba(245, 158, 11, 0.25)', bg: 'rgba(245, 158, 11, 0.05)', text: '#f59e0b', chipClass: 'chip-weakening', badgeClass: 'quad-weakening' },
  LAGGING:   { stroke: '#f43f5e', fill: 'rgba(244, 63, 94, 0.25)',  bg: 'rgba(244, 63, 94, 0.05)',  text: '#f43f5e', chipClass: 'chip-lagging', badgeClass: 'quad-lagging' },
};

const SC_QUAD = {
  LEADING: '#1e9e1e',
  IMPROVING: '#2a45d6',
  WEAKENING: '#f2c200',
  LAGGING: '#e01010',
};

const NUMERIC_COLS = new Set([
  'price', 'sma20', 'sma50', 'sma200', 'rs_score', 'rs_rating',
  'vol_today', 'vol20', 'rvol', 'score', 'volatility',
  'entry_price', 'exit_price', 'quantity', 'target', 'stop_loss', 'pnl', 'pnl_pct',
]);

const COL_PRESETS = {
  price: [
    { label: '< ₹500', op: 'lt', val1: 500, val2: null },
    { label: '₹500–1.5K', op: 'between', val1: 500, val2: 1500 },
    { label: '₹1.5K–5K', op: 'between', val1: 1500, val2: 5000 },
    { label: '> ₹5,000', op: 'gt', val1: 5000, val2: null },
  ],
  pnl: [
    { label: 'Gain (> ₹0)', op: 'gt', val1: 0, val2: null },
    { label: 'Loss (< ₹0)', op: 'lt', val1: 0, val2: null },
    { label: '≥ ₹5,000', op: 'gte', val1: 5000, val2: null },
    { label: '≥ ₹10,000', op: 'gte', val1: 10000, val2: null },
  ],
  pnl_pct: [
    { label: 'Gain (> 0%)', op: 'gt', val1: 0, val2: null },
    { label: '≥ +5%', op: 'gte', val1: 5, val2: null },
    { label: '≥ +10%', op: 'gte', val1: 10, val2: null },
    { label: 'Loss (< 0%)', op: 'lt', val1: 0, val2: null },
  ],
  sma20: [
    { label: 'Price > SMA 20', op: 'above_sma', val1: null, val2: null },
    { label: 'Price < SMA 20', op: 'below_sma', val1: null, val2: null },
  ],
  sma50: [
    { label: 'Price > SMA 50', op: 'above_sma', val1: null, val2: null },
    { label: 'Price < SMA 50', op: 'below_sma', val1: null, val2: null },
  ],
  sma200: [
    { label: 'Price > SMA 200', op: 'above_sma', val1: null, val2: null },
    { label: 'Price < SMA 200', op: 'below_sma', val1: null, val2: null },
  ],
  rs_score: [
    { label: '≥ 1.30 (Leader)', op: 'gte', val1: 1.30, val2: null },
    { label: '≥ 1.10 (Strong)', op: 'gte', val1: 1.10, val2: null },
    { label: '1.00–1.10', op: 'between', val1: 1.00, val2: 1.10 },
    { label: '< 1.00 (Weak)', op: 'lt', val1: 1.00, val2: null },
  ],
  rs_rating: [
    { label: '80–99 (Top)', op: 'gte', val1: 80, val2: null },
    { label: '60–79 (High)', op: 'between', val1: 60, val2: 79 },
    { label: '40–59 (Mid)', op: 'between', val1: 40, val2: 59 },
    { label: '< 40 (Low)', op: 'lt', val1: 40, val2: null },
  ],
  rvol: [
    { label: '≥ 2.0x (Ultra)', op: 'gte', val1: 2.0, val2: null },
    { label: '≥ 1.5x (High)', op: 'gte', val1: 1.5, val2: null },
    { label: '1.0x–1.5x', op: 'between', val1: 1.0, val2: 1.5 },
    { label: '< 1.0x (Low)', op: 'lt', val1: 1.0, val2: null },
  ],
  score: [
    { label: '5 / 5 Only', op: 'eq', val1: 5, val2: null },
    { label: '≥ 4 / 5', op: 'gte', val1: 4, val2: null },
    { label: '≥ 3 / 5', op: 'gte', val1: 3, val2: null },
    { label: '≤ 2 / 5', op: 'lte', val1: 2, val2: null },
  ],
  volatility: [
    { label: '< 20% (Low)', op: 'lt', val1: 20, val2: null },
    { label: '20%–35% (Mod)', op: 'between', val1: 20, val2: 35 },
    { label: '> 35% (High)', op: 'gt', val1: 35, val2: null },
  ],
  vol_today: [
    { label: '≥ 10M', op: 'gte', val1: 10000000, val2: null },
    { label: '≥ 1M', op: 'gte', val1: 1000000, val2: null },
    { label: '< 1M', op: 'lt', val1: 1000000, val2: null },
  ],
  vol20: [
    { label: '≥ 10M', op: 'gte', val1: 10000000, val2: null },
    { label: '≥ 1M', op: 'gte', val1: 1000000, val2: null },
    { label: '< 1M', op: 'lt', val1: 1000000, val2: null },
  ],
};

// =================================================================
// SHARED FORMATTING, RENDERING & DOM HELPERS
// =================================================================
const MUTED_DASH = '<span style="color:var(--text-muted); opacity:0.3;">—</span>';

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

function fmtINR(val, fallback = MUTED_DASH) {
  if (val === null || val === undefined || val === '' || isNaN(Number(val))) return fallback;
  return '₹' + Number(val).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtInt(val, fallback = MUTED_DASH) {
  if (val === null || val === undefined || val === '' || isNaN(Number(val))) return fallback;
  return Number(val).toLocaleString('en-IN');
}

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

/**
 * Shared renderer for the 14 standard technical indicator table cells:
 * SMA 20, SMA 50, SMA 200, Trend Signal, RS Value, RS Rating, RS Signal,
 * [Vol Today, Vol 20], RVOL, 50D Breakout, Accumulation, Momentum, Volatility %
 */
function renderIndicatorCellsHTML(r, { includeVolumeCols = true } = {}) {
  const breakoutHtml = r.breakout === 'YES' ? '<span class="badge-breakout">YES</span>' : MUTED_DASH;
  const accumHtml = r.accumulation === 'ACCUMULATION' ? '<span class="badge-accum">ACCUM</span>' : MUTED_DASH;

  return `
    <td class="num font-mono">${fmtINR(r.sma20)}</td>
    <td class="num font-mono">${fmtINR(r.sma50)}</td>
    <td class="num font-mono">${fmtINR(r.sma200)}</td>
    <td>${r.trend ? `<span class="trend-badge ${r.trend}">${r.trend}</span>` : MUTED_DASH}</td>
    <td class="num font-mono font-bold">${r.rs_score != null ? Number(r.rs_score).toFixed(3) : MUTED_DASH}</td>
    <td class="num">${r.rs_rating != null ? `<span class="rs-rating-pill ${getRsRatingTier(r.rs_rating)}">${r.rs_rating}</span>` : MUTED_DASH}</td>
    <td>${r.rs_signal ? `<span class="rs-signal-badge ${r.rs_signal}">${r.rs_signal}</span>` : MUTED_DASH}</td>
    ${includeVolumeCols ? `
      <td class="num font-mono">${fmtInt(r.vol_today)}</td>
      <td class="num font-mono">${fmtInt(r.vol20)}</td>
    ` : ''}
    <td class="num font-mono ${r.rvol > 1.5 ? 'rvol-high' : ''}">${r.rvol != null ? Number(r.rvol).toFixed(2) + 'x' : MUTED_DASH}</td>
    <td style="text-align:center;">${breakoutHtml}</td>
    <td style="text-align:center;">${accumHtml}</td>
    <td>${r.score != null ? renderScorePips(r.score) : MUTED_DASH}</td>
    <td class="num font-mono">${r.volatility != null ? Number(r.volatility).toFixed(1) + '%' : MUTED_DASH}</td>
  `;
}

/**
 * Generic multi-table row sorter with secondary RS tie-breaker on 'score'.
 */
function sortDataRows(rows, col, dir) {
  const isAsc = dir === 'asc';
  rows.sort((a, b) => {
    if (col === 'score') {
      const diff = isAsc ? (a.score || 0) - (b.score || 0) : (b.score || 0) - (a.score || 0);
      if (diff !== 0) return diff;
      return (b.rs_score || 0) - (a.rs_score || 0);
    }
    const va = a[col] ?? '';
    const vb = b[col] ?? '';
    if (typeof va === 'number' && typeof vb === 'number') {
      return isAsc ? va - vb : vb - va;
    }
    return isAsc
      ? String(va).toLowerCase().localeCompare(String(vb).toLowerCase())
      : String(vb).toLowerCase().localeCompare(String(va).toLowerCase());
  });
  return rows;
}

/**
 * Generic CSV file builder & browser download trigger.
 */
function downloadCSV(filenamePrefix, headers, rowsMatrix) {
  const csvLines = [
    headers.join(','),
    ...rowsMatrix.map(row => row.join(',')),
  ];
  const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `${filenamePrefix}_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast(`📥 Exported ${filenamePrefix}.csv`);
}

/**
 * Reusable search input + clear button binder.
 */
function bindSearchInput(inputId, clearBtnId, onChange) {
  const input = document.getElementById(inputId);
  const clearBtn = clearBtnId ? document.getElementById(clearBtnId) : null;
  if (!input) return;

  input.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (clearBtn) clearBtn.style.display = val ? 'block' : 'none';
    onChange(val);
  });

  clearBtn?.addEventListener('click', () => {
    input.value = '';
    clearBtn.style.display = 'none';
    onChange('');
  });
}

/**
 * Reusable quick-filter pill group binder.
 */
function bindPillGroup(selector, attrName, onSelect) {
  const pills = document.querySelectorAll(selector);
  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      pills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      onSelect(pill.getAttribute(attrName));
    });
  });
}

