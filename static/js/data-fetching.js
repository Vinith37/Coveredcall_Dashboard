/**
 * Kite Pulse — Lean 5-Step Data Fetching Module (NSE F&O)
 * 1. Select Stock -> 2. Select Timestamps -> 3. Time Frame -> 4. Fetch & Download CSV -> 5. Process & Logs
 */

let fnoStatusData = null;
let fnoStocksRows = [];
let fnoPollTimer = null;
let fnoPreviewSearch = '';
let fnoSelectedTimeframe = '1M';

function initDataFetching() {
  bindFnoListeners();
  fetchFnoStatus();
}

function ensureDataFetchingLoaded() {
  fetchFnoStatus();
  fetchFnoStocksPreview();
}

function getSelectedTimestamps() {
  const checked = Array.from(document.querySelectorAll('#fno-ts-chips input[type="checkbox"]:checked'));
  return checked.map(el => el.value);
}

function bindFnoListeners() {
  document.getElementById('btn-fno-open-kite')?.addEventListener('click', openKiteModal);
  document.getElementById('btn-fno-refresh-universe')?.addEventListener('click', refreshFnoUniverse);

  // 1. Stock selector (also filters preview table when single stock is selected)
  document.getElementById('fno-custom-stock')?.addEventListener('change', (e) => {
    const val = (e.target.value || 'ALL').trim().toUpperCase();
    fnoPreviewSearch = val === 'ALL' ? '' : val;
    renderFnoPreviewTable();
  });

  // 2. Timestamp chips toggle styling
  document.getElementById('fno-ts-chips')?.addEventListener('change', (e) => {
    const chip = e.target.closest('.fno-ts-chip');
    if (chip && e.target.type === 'checkbox') {
      chip.classList.toggle('active', e.target.checked);
    }
  });

  document.getElementById('btn-fno-add-custom-time')?.addEventListener('click', () => {
    const inp = document.getElementById('fno-custom-time-input');
    const val = (inp?.value || '').trim();
    if (!val || !/^\d{2}:\d{2}$/.test(val)) {
      showToast('Enter a valid HH:MM time.');
      return;
    }
    const chips = document.getElementById('fno-ts-chips');
    if (!chips) return;
    const existing = chips.querySelector(`input[value="${val}"]`);
    if (existing) {
      existing.checked = true;
      existing.closest('.fno-ts-chip')?.classList.add('active');
      return;
    }
    const [hh, mm] = val.split(':').map(Number);
    const h12 = hh % 12 || 12;
    const ampm = hh >= 12 ? 'PM' : 'AM';
    const labelText = `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;
    const label = document.createElement('label');
    label.className = 'fno-ts-chip active';
    label.innerHTML = `<input type="checkbox" value="${val}" checked /> <span>${labelText}</span>`;
    chips.appendChild(label);
  });

  document.getElementById('btn-fno-save-auto-schedule')?.addEventListener('click', saveSelectedAsAutoSchedule);

  // 3. Time Frame buttons
  document.getElementById('fno-tf-group')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.fno-tf-btn');
    if (!btn) return;
    fnoSelectedTimeframe = btn.dataset.tf || '1M';
    document.querySelectorAll('#fno-tf-group .fno-tf-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  // 4. Fetch & Download CSV
  document.getElementById('btn-fno-custom-fetch')?.addEventListener('click', runCustomFetch);
  document.getElementById('btn-fno-custom-download')?.addEventListener('click', downloadCustomCsv);

  // Preview table search
  document.getElementById('fno-preview-search')?.addEventListener('input', (e) => {
    fnoPreviewSearch = (e.target.value || '').trim().toUpperCase();
    renderFnoPreviewTable();
  });
}

async function fetchFnoStatus() {
  try {
    const res = await fetch('/api/fno/status');
    if (!res.ok) return;
    fnoStatusData = await res.json();
    renderFnoStatus(fnoStatusData);

    const running = Boolean(fnoStatusData?.progress?.is_running);
    if (running && !fnoPollTimer) {
      fnoPollTimer = setInterval(() => {
        fetchFnoStatus();
        fetchFnoStocksPreview();
      }, 2000);
    } else if (!running && fnoPollTimer) {
      clearInterval(fnoPollTimer);
      fnoPollTimer = null;
      fetchFnoStocksPreview();
    }
  } catch (err) {
    console.warn('Failed to fetch F&O status:', err);
  }
}

async function fetchFnoStocksPreview() {
  try {
    const res = await fetch('/api/fno/stocks');
    if (!res.ok) return;
    const data = await res.json();
    fnoStocksRows = data.rows || [];
    populateStockDropdown();
    renderFnoPreviewTable();
  } catch (err) {
    console.warn('Failed to load F&O stocks preview:', err);
  }
}

function populateStockDropdown() {
  const sel = document.getElementById('fno-custom-stock');
  if (!sel) return;
  const cur = sel.value || 'ALL';
  const opts = ['<option value="ALL">All Eligible NSE F&amp;O Stocks (Consolidated)</option>'];
  fnoStocksRows.forEach(r => {
    opts.push(`<option value="${r.symbol}">${r.symbol} — ${r.name || r.symbol}</option>`);
  });
  sel.innerHTML = opts.join('');
  sel.value = cur;
}

async function refreshFnoUniverse() {
  const btn = document.getElementById('btn-fno-refresh-universe');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/fno/universe/refresh', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Universe refresh failed');
    showToast(data.message || 'F&O universe updated.');
    await fetchFnoStatus();
    await fetchFnoStocksPreview();
  } catch (err) {
    showToast(`Universe error: ${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function saveSelectedAsAutoSchedule() {
  const selected = getSelectedTimestamps().filter(t => /^\d{2}:\d{2}$/.test(t));
  if (selected.length === 0) {
    showToast('Select at least one IST time (e.g. 10:00 AM, 1:00 PM, 3:00 PM) to save as auto-schedule.');
    return;
  }
  const slots = selected.map(t => {
    const [hh, mm] = t.split(':').map(Number);
    const h12 = hh % 12 || 12;
    const ampm = hh >= 12 ? 'PM' : 'AM';
    const code = mm === 0 ? `${h12}${ampm}` : `${h12}_${String(mm).padStart(2, '0')}${ampm}`;
    return { slot: code, label: t, hour: hh, minute: mm, enabled: true };
  });
  try {
    const res = await fetch('/api/fno/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Failed to save schedule');
    fnoStatusData = data.status;
    renderFnoStatus(fnoStatusData);
    showToast(data.message || 'Auto-schedule updated.');
  } catch (err) {
    showToast(`Schedule error: ${err.message}`);
  }
}

async function runCustomFetch() {
  const symbol = document.getElementById('fno-custom-stock')?.value || 'ALL';
  const timestamps = getSelectedTimestamps();
  if (timestamps.length === 0) {
    showToast('Step 2: Select at least one timestamp.');
    return;
  }

  const btn = document.getElementById('btn-fno-custom-fetch');
  if (btn) {
    btn.disabled = true;
    btn.textContent = symbol === 'ALL' ? 'Starting...' : `Fetching ${symbol}...`;
  }

  try {
    const res = await fetch('/api/fno/custom/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol,
        timestamps,
        timeframe: fnoSelectedTimeframe,
      }),
    });
    const data = await res.json();
    if (!res.ok && res.status !== 409) {
      throw new Error(data.detail || data.message || 'Fetch failed');
    }
    showToast(data.message || 'Fetch completed.');
    await fetchFnoStatus();
    await fetchFnoStocksPreview();
  } catch (err) {
    showToast(`Fetch error: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '▶ Fetch Data';
    }
  }
}

function downloadCustomCsv() {
  const symbol = document.getElementById('fno-custom-stock')?.value || 'ALL';
  const timestamps = getSelectedTimestamps();
  if (timestamps.length === 0) {
    showToast('Step 2: Select at least one timestamp.');
    return;
  }
  const qs = new URLSearchParams({
    symbol,
    timestamps: timestamps.join(','),
    timeframe: fnoSelectedTimeframe,
    auto_fetch: symbol === 'ALL' ? 'false' : 'true',
  });
  triggerCsvDownload(`/api/fno/custom/export?${qs.toString()}`);
}

function triggerCsvDownload(url) {
  showToast('Preparing CSV download...');
  window.location.href = url;
}

function renderFnoStatus(data) {
  if (!data) return;
  const api = data.api_connection || {};
  const univ = data.universe || {};
  const sched = data.schedule || {};
  const prog = data.progress || {};

  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  const pill = document.getElementById('fno-api-status-pill');
  if (pill) {
    pill.textContent = api.is_connected ? 'CONNECTED' : 'DISCONNECTED';
    pill.className = `fno-status-pill ${api.is_connected ? 'connected' : 'disconnected'}`;
  }
  setText('fno-auth-status', api.is_connected ? (api.user_name || api.user_id || 'Active') : 'Not Authenticated');
  setText('fno-total-stocks', univ.total_stocks || 0);
  setText('fno-market-day-badge', sched.is_trading_day ? 'NSE Trading Day (IST)' : 'Market Holiday / Weekend');

  const nf = sched.next_fetch || {};
  setText('fno-next-fetch', nf.scheduled_at ? `${nf.slot} — ${nf.scheduled_at}` : '—');

  // 5. Process & Logs
  const pct = Number(prog.progress_pct || 0);
  setText('fno-progress-pct-label', `${pct.toFixed(1)}%`);
  const bar = document.getElementById('fno-progress-bar');
  if (bar) bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  setText('fno-current-stock', prog.is_running ? (prog.current_symbol || 'Processing...') : 'Idle');
  setText('fno-prog-success', prog.success_count ?? 0);
  setText('fno-prog-failed', prog.failed_count ?? 0);
  setText('fno-last-message', prog.last_message || 'Ready.');

  const errBox = document.getElementById('fno-error-logs');
  if (errBox) {
    const errs = prog.errors || [];
    if (errs.length === 0) {
      const logs = data.logs || [];
      if (logs.length > 0) {
        errBox.innerHTML = logs.slice(0, 6).map(l => `
          <div class="fno-log-line">
            <span class="fno-log-tag ${l.status}">${l.status}</span>
            <span>[${l.slot} / ${l.mode}] ${l.message} (${l.finished_at || l.started_at})</span>
          </div>
        `).join('');
      } else {
        errBox.innerHTML = '<div class="fno-log-empty">No logs yet.</div>';
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
}

function renderFnoPreviewTable() {
  const tbody = document.getElementById('tbody-fno-preview');
  const counter = document.getElementById('fno-preview-counter');
  if (!tbody) return;

  const filtered = fnoPreviewSearch
    ? fnoStocksRows.filter(r => r.symbol.includes(fnoPreviewSearch))
    : fnoStocksRows;

  if (counter) {
    counter.textContent = `${filtered.length} stocks`;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="20" class="empty-msg">No F&amp;O stocks match "${fnoPreviewSearch}". Click "Discover Stocks" or "Fetch Data".</td></tr>`;
    return;
  }

  const fmtNum = (v, d = 2) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d));
  const fmtInt = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('en-IN'));

  tbody.innerHTML = filtered.slice(0, 100).map(r => {
    const mapped = {
      ticker: r.symbol,
      trend: r.trend,
      rs_score: r.rs_value,
      rs_rating: r.rs_rating,
      rs_signal: r.rs_signal,
      breakout: r.breakout_50d === 'YES',
      accumulation: r.accumulation === 'YES',
    };
    const trendHtml = r.trend ? renderTrendBadge(mapped) : '—';
    const rsSigHtml = r.rs_signal ? renderRsSignalBadge(mapped) : '—';
    const rsRatingHtml = r.rs_rating != null ? renderRsRatingBadge(mapped) : '—';
    const breakHtml = r.breakout_50d ? renderBoolPill(r.breakout_50d === 'YES', 'YES') : '—';
    const accumHtml = r.accumulation ? renderBoolPill(r.accumulation === 'YES', 'YES') : '—';

    return `
      <tr>
        <td><strong>${r.symbol}</strong></td>
        <td class="font-mono" style="font-size:0.74rem;">${r.timestamp || '—'}</td>
        <td class="num font-mono">${fmtNum(r.open)}</td>
        <td class="num font-mono">${fmtNum(r.high)}</td>
        <td class="num font-mono">${fmtNum(r.low)}</td>
        <td class="num font-mono"><strong>${fmtNum(r.close)}</strong></td>
        <td class="num font-mono">${fmtNum(r.sma20)}</td>
        <td class="num font-mono">${fmtNum(r.sma50)}</td>
        <td class="num font-mono">${fmtNum(r.sma200)}</td>
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
          <button class="btn btn-sm btn-outline" style="padding:2px 8px; font-size:0.68rem;" onclick="triggerCsvDownload('/api/fno/custom/export?symbol=${r.symbol}&timestamps=' + encodeURIComponent(getSelectedTimestamps().join(',') || '15:00') + '&timeframe=' + encodeURIComponent(fnoSelectedTimeframe))">
            ⬇ CSV
          </button>
        </td>
      </tr>
    `;
  }).join('');
}
