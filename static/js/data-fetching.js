/**
 * Kite Pulse — Data Fetching Module (NSE F&O Automated Pipeline)
 * Monitors Kite Connect API status, dynamic F&O stock universe, IST scheduler,
 * 30-month historical backfill progress, and CSV export downloads.
 */

let fnoStatusData = null;
let fnoStocksRows = [];
let fnoPollTimer = null;
let fnoPreviewSearch = '';
let fnoScheduleDraft = [];
let fnoScheduleDirty = false;

function initDataFetching() {
  bindFnoListeners();
  fetchFnoStatus();
}

function ensureDataFetchingLoaded() {
  fetchFnoStatus();
  fetchFnoStocksPreview();
}

function bindFnoListeners() {
  document.getElementById('btn-fno-open-kite')?.addEventListener('click', openKiteModal);
  document.getElementById('btn-fno-refresh-status')?.addEventListener('click', () => {
    fetchFnoStatus();
    fetchFnoStocksPreview();
  });

  document.getElementById('btn-fno-refresh-universe')?.addEventListener('click', refreshFnoUniverse);
  document.getElementById('btn-fno-manual-fetch')?.addEventListener('click', () => triggerFnoFetch('snapshot', 'MANUAL'));
  document.getElementById('btn-fno-simultaneous-fetch')?.addEventListener('click', () => triggerFnoFetch('simultaneous', 'MANUAL'));
  document.getElementById('btn-fno-incremental-hist')?.addEventListener('click', () => triggerFnoFetch('incremental', 'MANUAL'));
  document.getElementById('btn-fno-add-slot')?.addEventListener('click', addFnoScheduleSlot);
  document.getElementById('btn-fno-save-schedule')?.addEventListener('click', saveFnoSchedule);

  const slotsWrap = document.getElementById('fno-schedule-slots');
  if (slotsWrap) {
    slotsWrap.addEventListener('change', handleFnoSlotInput);
    slotsWrap.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.fno-slot-remove');
      if (!delBtn) return;
      const idx = Number(delBtn.dataset.idx);
      if (fnoScheduleDraft.length <= 1) {
        showToast('At least one schedule slot must remain.');
        return;
      }
      fnoScheduleDraft.splice(idx, 1);
      fnoScheduleDirty = true;
      renderFnoScheduleEditor();
    });
  }
  document.getElementById('btn-fno-full-hist')?.addEventListener('click', () => {
    if (confirm('Run full 30-month historical refresh for all 200+ NSE F&O stocks? This respects Kite rate limits and runs in the background.')) {
      triggerFnoFetch('historical', 'MANUAL');
    }
  });

  // CSV Download buttons
  document.getElementById('btn-fno-dl-all')?.addEventListener('click', () => triggerCsvDownload('/api/fno/export/all'));
  document.getElementById('btn-fno-dl-hist-all')?.addEventListener('click', () => triggerCsvDownload('/api/fno/export/historical-all'));

  document.getElementById('btn-fno-dl-stock')?.addEventListener('click', () => {
    const sym = document.getElementById('fno-dl-stock-select')?.value;
    if (!sym) {
      showToast('Please select an F&O stock first.');
      return;
    }
    triggerCsvDownload(`/api/fno/export/stock/${encodeURIComponent(sym)}`);
  });

  document.getElementById('btn-fno-dl-snapshot')?.addEventListener('click', () => {
    const val = document.getElementById('fno-dl-snapshot-select')?.value;
    if (!val) {
      showToast('Please select a snapshot time slot (10 AM, 1 PM, or 3 PM).');
      return;
    }
    const [datePart, slotPart] = val.split('|');
    const qs = new URLSearchParams();
    if (datePart) qs.set('date', datePart);
    if (slotPart) qs.set('slot', slotPart);
    triggerCsvDownload(`/api/fno/export/all?${qs.toString()}`);
  });

  document.getElementById('fno-preview-search')?.addEventListener('input', (e) => {
    fnoPreviewSearch = (e.target.value || '').trim().toUpperCase();
    renderFnoPreviewTable();
  });
}

async function triggerCsvDownload(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(`⚠️ ${err.detail || 'Dataset not available yet'}`);
      return;
    }
    const blob = await res.blob();
    const disp = res.headers.get('Content-Disposition') || '';
    const match = disp.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : 'fno_export.csv';

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    showToast(`⬇ Downloaded ${filename}`);
  } catch (err) {
    console.error('CSV download failed:', err);
    showToast('⚠️ Failed to download CSV');
  }
}

async function refreshFnoUniverse() {
  const btn = document.getElementById('btn-fno-refresh-universe');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/fno/universe/refresh', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ ${data.message}`);
      await fetchFnoStatus();
      await fetchFnoStocksPreview();
    } else {
      showToast(`⚠️ ${data.detail || 'Could not discover F&O universe'}`);
    }
  } catch (err) {
    console.error('Universe refresh error:', err);
    showToast('⚠️ Failed to refresh F&O universe');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function triggerFnoFetch(mode, slot) {
  try {
    const res = await fetch('/api/fno/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, slot }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`⚡ ${data.message}`);
      await fetchFnoStatus();
    } else {
      showToast(`⚠️ ${data.message || data.detail || 'Could not start fetch'}`);
    }
  } catch (err) {
    console.error('F&O fetch trigger error:', err);
    showToast('⚠️ Network error starting fetch');
  }
}

async function fetchFnoStatus() {
  try {
    const res = await fetch('/api/fno/status');
    if (!res.ok) return;
    fnoStatusData = await res.json();
    renderFnoStatus(fnoStatusData);

    const isRunning = fnoStatusData?.progress?.is_running;
    if (fnoPollTimer) clearTimeout(fnoPollTimer);
    fnoPollTimer = setTimeout(() => {
      const tabActive = document.getElementById('tab-data-fetching')?.classList.contains('active');
      if (isRunning || tabActive) {
        fetchFnoStatus();
        if (!isRunning && tabActive) fetchFnoStocksPreview();
      }
    }, isRunning ? 1500 : 20000);
  } catch (err) {
    console.error('Error loading F&O status:', err);
  }
}

async function fetchFnoStocksPreview() {
  try {
    const res = await fetch('/api/fno/stocks');
    if (!res.ok) return;
    const data = await res.json();
    fnoStocksRows = data.rows || [];
    populateFnoStockDropdown(fnoStocksRows);
    renderFnoPreviewTable();
  } catch (err) {
    console.error('Error loading F&O preview rows:', err);
  }
}

function populateFnoStockDropdown(rows) {
  const sel = document.getElementById('fno-dl-stock-select');
  if (!sel) return;
  const prevVal = sel.value;
  sel.innerHTML = '<option value="">Select F&O Stock...</option>' +
    rows.map(r => `<option value="${r.symbol}">${r.symbol}</option>`).join('');
  if (prevVal && rows.some(r => r.symbol === prevVal)) {
    sel.value = prevVal;
  }
}

function renderFnoStatus(data) {
  if (!data) return;
  const api = data.api_connection || {};
  const univ = data.universe || {};
  const sched = data.schedule || {};
  const prog = data.progress || {};
  const hist = data.historical || {};

  // A. API Connection
  const pill = document.getElementById('fno-api-status-pill');
  const authEl = document.getElementById('fno-auth-status');
  const lastConnEl = document.getElementById('fno-last-api-conn');
  if (pill) {
    pill.textContent = api.is_connected ? 'CONNECTED' : 'DISCONNECTED';
    pill.className = `fno-status-pill ${api.is_connected ? 'connected' : 'disconnected'}`;
  }
  if (authEl) {
    authEl.textContent = api.is_connected ? `Authenticated (${api.user_name || api.user_id || 'Active'})` : 'Not Authenticated';
  }
  if (lastConnEl) {
    lastConnEl.textContent = api.last_successful_connection || '—';
  }

  // B. Stock Universe
  const totalStocks = univ.total_stocks || 0;
  const badge = document.getElementById('fno-universe-badge');
  if (badge) badge.textContent = totalStocks > 0 ? totalStocks : 'F&O';
  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  setText('fno-total-stocks', totalStocks);
  setText('fno-fetched-ok', prog.success_count ?? 0);
  setText('fno-fetched-fail', prog.failed_count ?? 0);
  setText('fno-universe-updated', univ.last_updated || 'Not discovered yet');

  // C. Schedule
  const dayBadge = document.getElementById('fno-market-day-badge');
  if (dayBadge) {
    dayBadge.textContent = sched.is_trading_day ? 'Trading Day (IST)' : 'Market Holiday / Weekend';
  }
  if (!fnoScheduleDirty && Array.isArray(sched.slots)) {
    fnoScheduleDraft = sched.slots.map(s => ({
      slot: s.slot,
      label: s.label || s.slot,
      hour: Number(s.hour),
      minute: Number(s.minute),
      enabled: s.enabled !== false,
      completed_today: Boolean(s.completed_today),
    }));
    renderFnoScheduleEditor();
  }
  const nf = sched.next_fetch || {};
  setText('fno-next-fetch', nf.scheduled_at ? `${nf.slot} — ${nf.scheduled_at}` : '—');

  // D. Fetching Progress & Logs
  const pct = Number(prog.progress_pct || 0);
  setText('fno-progress-pct-label', `${pct.toFixed(1)}%`);
  const bar = document.getElementById('fno-progress-bar');
  if (bar) bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  setText('fno-current-stock', prog.is_running ? (prog.current_symbol || 'Processing...') : 'Idle');
  setText('fno-prog-success', prog.success_count ?? 0);
  setText('fno-prog-failed', prog.failed_count ?? 0);
  setText('fno-last-message', prog.last_message || 'Ready');

  const errBox = document.getElementById('fno-error-logs');
  if (errBox) {
    const errs = prog.errors || [];
    if (errs.length === 0) {
      const logs = data.logs || [];
      if (logs.length > 0) {
        errBox.innerHTML = logs.slice(0, 5).map(l => `
          <div class="fno-log-line">
            <span class="fno-log-tag ${l.status}">${l.status}</span>
            <span>[${l.slot} / ${l.mode}] ${l.message} (${l.finished_at || l.started_at})</span>
          </div>
        `).join('');
      } else {
        errBox.innerHTML = '<div class="fno-log-empty">No fetch logs yet.</div>';
      }
    } else {
      errBox.innerHTML = errs.map(e => `
        <div class="fno-log-line error">
          <span class="fno-log-tag FAILED">${e.symbol}</span>
          <span>${e.error}</span>
        </div>
      `).join('');
    }
  }

  // E. Historical Data
  setText('fno-hist-start', hist.start_date || '—');
  setText('fno-hist-end', hist.end_date || '—');
  setText('fno-hist-records', Number(hist.total_records || 0).toLocaleString('en-IN'));

  // F. Snapshot Selector
  const snapSel = document.getElementById('fno-dl-snapshot-select');
  if (snapSel && Array.isArray(data.available_snapshots)) {
    const cur = snapSel.value;
    const baseOpts = [
      '<option value="">Select Snapshot...</option>',
      '<option value="|10AM">Latest 10:00 AM IST</option>',
      '<option value="|1PM">Latest 1:00 PM IST</option>',
      '<option value="|3PM">Latest 3:00 PM IST</option>',
    ];
    const datedOpts = data.available_snapshots.map(s =>
      `<option value="${s.snapshot_date}|${s.slot}">${s.snapshot_date} — ${s.slot} (${s.stock_count} stocks)</option>`
    );
    snapSel.innerHTML = baseOpts.concat(datedOpts).join('');
    if (cur) snapSel.value = cur;
  }
}

function renderFnoPreviewTable() {
  const tbody = document.getElementById('tbody-fno-preview');
  const counter = document.getElementById('fno-preview-counter');
  if (!tbody) return;

  const filtered = fnoPreviewSearch
    ? fnoStocksRows.filter(r => r.symbol.includes(fnoPreviewSearch))
    : fnoStocksRows;

  if (counter) counter.textContent = `${filtered.length} stocks`;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="22" style="text-align:center; padding:32px; color:var(--text-muted);">No F&amp;O records match your filter.</td></tr>`;
    return;
  }

  const fmtNum = (v, d = 2) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
  tbody.innerHTML = filtered.slice(0, 250).map(r => {
    const mapped = {
      sma20: r.sma20,
      sma50: r.sma50,
      sma200: r.sma200,
      trend: r.trend,
      rs_score: r.rs_value,
      rs_rating: r.rs_rating,
      rs_signal: r.rs_signal,
      vol_today: r.volume,
      vol20: r.vol20,
      rvol: r.rvol,
      breakout: r.breakout_50d,
      accumulation: r.accumulation,
      score: r.momentum_score,
      volatility: r.volatility,
    };
    const trendHtml = r.trend ? `<span class="badge-trend ${r.trend}">${r.trend.replace('_', ' ')}</span>` : '—';
    const rsSigHtml = r.rs_signal ? `<span class="badge-rs ${r.rs_signal}">${r.rs_signal}</span>` : '—';
    const rsTier = r.rs_rating != null ? getRsRatingTier(r.rs_rating) : '';
    const rsRatingHtml = r.rs_rating != null ? `<span class="rs-rating-badge ${rsTier}">${r.rs_rating}</span>` : '—';
    const breakHtml = r.breakout_50d === 'YES' ? '<span class="badge-breakout">YES</span>' : '<span style="opacity:0.3;">—</span>';
    const accumHtml = r.accumulation === 'ACCUMULATION' ? '<span class="badge-accum">ACCUM</span>' : '<span style="opacity:0.3;">—</span>';

    return `
      <tr>
        <td class="stock-ticker-cell"><span class="stock-sym-badge">${r.symbol}</span></td>
        <td class="font-mono" style="font-size:0.74rem; color:var(--text-muted);">${r.timestamp || '—'}</td>
        <td class="num font-mono">${r.open != null ? fmtINR(r.open) : '—'}</td>
        <td class="num font-mono">${r.high != null ? fmtINR(r.high) : '—'}</td>
        <td class="num font-mono">${r.low != null ? fmtINR(r.low) : '—'}</td>
        <td class="num font-mono" style="font-weight:700; color:#fff;">${r.close != null ? fmtINR(r.close) : '—'}</td>
        <td class="num font-mono">${r.sma20 != null ? fmtINR(r.sma20) : '—'}</td>
        <td class="num font-mono">${r.sma50 != null ? fmtINR(r.sma50) : '—'}</td>
        <td class="num font-mono">${r.sma200 != null ? fmtINR(r.sma200) : '—'}</td>
        <td>${trendHtml}</td>
        <td class="num font-mono">${mapped.rs_score != null ? Number(mapped.rs_score).toFixed(3) : '—'}</td>
        <td class="num">${rsRatingHtml}</td>
        <td>${rsSigHtml}</td>
        <td class="num font-mono">${r.volume != null ? fmtInt(r.volume) : '—'}</td>
        <td class="num font-mono">${r.vol20 != null ? fmtInt(r.vol20) : '—'}</td>
        <td class="num font-mono">${r.rvol != null ? fmtNum(r.rvol) + 'x' : '—'}</td>
        <td style="text-align:center;">${breakHtml}</td>
        <td style="text-align:center;">${accumHtml}</td>
        <td>${renderScorePips(r.momentum_score || 0)}</td>
        <td class="num font-mono">${fmtNum(r.rsi14)}</td>
        <td class="num font-mono">${r.volatility != null ? fmtNum(r.volatility, 1) + '%' : '—'}</td>
        <td style="text-align:center;">
          <button class="btn btn-sm btn-outline" style="padding:2px 8px; font-size:0.68rem;" onclick="triggerCsvDownload('/api/fno/export/stock/${r.symbol}')">
            ⬇ CSV
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function pad2(n) {
  return String(Math.max(0, Number(n) || 0)).padStart(2, '0');
}

function formatSlotCodeFromTime(hour, minute) {
  const h = Number(hour);
  const m = Number(minute);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const ampm = h >= 12 ? 'PM' : 'AM';
  return m === 0 ? `${h12}${ampm}` : `${h12}_${pad2(m)}${ampm}`;
}

function renderFnoScheduleEditor() {
  const slotsWrap = document.getElementById('fno-schedule-slots');
  if (!slotsWrap) return;

  slotsWrap.innerHTML = fnoScheduleDraft.map((s, idx) => {
    const timeVal = `${pad2(s.hour)}:${pad2(s.minute)}`;
    const classes = [
      'fno-slot-pill',
      'fno-slot-editable',
      s.completed_today ? 'completed' : '',
      !s.enabled ? 'disabled' : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="${classes}" data-idx="${idx}">
        <div class="fno-slot-top">
          <label class="fno-slot-toggle" title="Enable/Disable this scheduled fetch">
            <input type="checkbox" class="fno-slot-enabled" data-idx="${idx}" ${s.enabled ? 'checked' : ''} />
            <span class="fno-slot-code">${s.slot}${s.completed_today ? ' ✓' : ''}</span>
          </label>
          <button type="button" class="fno-slot-remove" data-idx="${idx}" title="Remove slot">✕</button>
        </div>
        <input type="time" class="fno-slot-time" data-idx="${idx}" value="${timeVal}" />
      </div>
    `;
  }).join('');

  const saveBtn = document.getElementById('btn-fno-save-schedule');
  if (saveBtn) {
    saveBtn.textContent = fnoScheduleDirty ? 'Save Schedule *' : 'Save Schedule';
  }
}

function handleFnoSlotInput(e) {
  const idx = Number(e.target?.dataset?.idx);
  if (Number.isNaN(idx) || !fnoScheduleDraft[idx]) return;

  if (e.target.classList.contains('fno-slot-enabled')) {
    fnoScheduleDraft[idx].enabled = e.target.checked;
    fnoScheduleDirty = true;
    renderFnoScheduleEditor();
    return;
  }

  if (e.target.classList.contains('fno-slot-time')) {
    const [hh, mm] = (e.target.value || '10:00').split(':').map(Number);
    if (!Number.isNaN(hh) && !Number.isNaN(mm)) {
      fnoScheduleDraft[idx].hour = hh;
      fnoScheduleDraft[idx].minute = mm;
      const candidate = formatSlotCodeFromTime(hh, mm);
      const duplicate = fnoScheduleDraft.some((item, i) => i !== idx && item.slot === candidate);
      fnoScheduleDraft[idx].slot = duplicate ? `${candidate}_${idx + 1}` : candidate;
      fnoScheduleDirty = true;
      renderFnoScheduleEditor();
    }
  }
}

function addFnoScheduleSlot() {
  let newHour = 11;
  let newMin = 30;
  const used = new Set(fnoScheduleDraft.map(s => `${s.hour}:${s.minute}`));
  while (used.has(`${newHour}:${newMin}`) && newHour < 15) {
    newHour += 1;
  }
  const code = formatSlotCodeFromTime(newHour, newMin);
  const uniqueCode = fnoScheduleDraft.some(s => s.slot === code) ? `${code}_${fnoScheduleDraft.length + 1}` : code;
  fnoScheduleDraft.push({
    slot: uniqueCode,
    label: 'Custom',
    hour: newHour,
    minute: newMin,
    enabled: true,
    completed_today: false,
  });
  fnoScheduleDirty = true;
  renderFnoScheduleEditor();
}

async function saveFnoSchedule() {
  try {
    const res = await fetch('/api/fno/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slots: fnoScheduleDraft.map(s => ({
          slot: s.slot,
          label: s.label || s.slot,
          hour: Number(s.hour),
          minute: Number(s.minute),
          enabled: Boolean(s.enabled),
        })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.message || 'Failed to save schedule');
    fnoScheduleDirty = false;
    fnoStatusData = data.status;
    renderFnoStatus(fnoStatusData);
    showToast(data.message || 'IST schedule saved.');
  } catch (err) {
    showToast(`Schedule error: ${err.message}`);
  }
}


