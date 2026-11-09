/**
 * Kite Pulse — Unified Excel-Style Column Header Filter & Sort Engine
 * Supports #table-strength, #table-stock-strength, and #table-trades-library.
 */

const TEXT_ASC_DEFAULT_COLS = new Set([
  'name', 'ticker', 'symbol', 'trade_type', 'status', 'strategy',
  'date', 'trend', 'rs_signal', 'breakout', 'accumulation', 'last_updated',
]);

let excelGlobalEventsBound = false;

function getTableAdapter(tableId) {
  if (tableId === 'table-stock-strength') {
    return {
      getRows: () => stockStrengthData?.rows || [],
      filters: stockColFilters,
      getSort: () => ({ col: stockSortCol, dir: stockSortDir }),
      setSort: (col, dir) => { stockSortCol = col; stockSortDir = dir; },
      render: () => renderStockStrengthTable(),
    };
  }
  if (tableId === 'table-trades-library') {
    return {
      getRows: () => getPreparedLibraryRows(),
      filters: libColFilters,
      getSort: () => ({ col: libSortCol, dir: libSortDir }),
      setSort: (col, dir) => { libSortCol = col; libSortDir = dir; },
      render: () => renderTradeLibraryTable(),
    };
  }
  return {
    getRows: () => dashboardData?.strength_indicators || [],
    filters: sectorColFilters,
    getSort: () => ({ col: strengthSortCol, dir: strengthSortAsc ? 'asc' : 'desc' }),
    setSort: (col, dir) => { strengthSortCol = col; strengthSortAsc = (dir === 'asc'); },
    render: () => renderStrengthTable(),
  };
}

function formatColDisplayValue(row, col) {
  const raw = row[col];
  if (col === 'score') return raw != null ? `${raw} / 5` : '—';
  if (col === 'breakout') return raw === 'YES' ? 'YES' : 'NO';
  if (col === 'accumulation') return raw === 'ACCUMULATION' ? 'ACCUMULATION' : 'NONE';
  if (col === 'rs_score') return raw != null ? Number(raw).toFixed(3) : '—';
  if (col === 'rvol') return raw != null ? `${Number(raw).toFixed(2)}x` : '—';
  if (col === 'volatility') return raw != null ? `${Number(raw).toFixed(1)}%` : '—';
  if (['price', 'entry_price', 'exit_price', 'target', 'stop_loss', 'sma20', 'sma50', 'sma200'].includes(col)) {
    return raw != null ? fmtINR(raw, '—') : '—';
  }
  if (col === 'pnl') {
    return raw != null ? `${Number(raw) >= 0 ? '+' : ''}${fmtINR(raw, '—')}` : '—';
  }
  if (col === 'pnl_pct') {
    return raw != null ? `${Number(raw) >= 0 ? '+' : ''}${Number(raw).toFixed(2)}%` : '—';
  }
  if (['vol_today', 'vol20', 'quantity'].includes(col)) {
    return raw != null ? fmtInt(raw, '—') : '—';
  }
  return raw != null && raw !== '' ? String(raw) : '—';
}

function isColFilterActive(f) {
  if (!f) return false;
  return (f.selectedValues instanceof Set) || Boolean(f.op && f.op !== 'ALL');
}

function rowMatchesSingleColFilter(row, col, f) {
  if (!isColFilterActive(f)) return true;

  if (f.selectedValues instanceof Set) {
    if (!f.selectedValues.has(formatColDisplayValue(row, col))) return false;
  }

  if (f.op && f.op !== 'ALL') {
    if (f.op === 'above_sma' || f.op === 'below_sma') {
      const p = Number(row.price);
      const s = Number(row[col]);
      if (isNaN(p) || isNaN(s)) return false;
      return f.op === 'above_sma' ? p > s : p < s;
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
    clearBtn.style.display = activeCount > 0 ? 'inline-flex' : 'none';
    if (activeCount > 0) {
      clearBtn.innerHTML = `<span>✕ Clear Column Filters (${activeCount})</span>`;
    }
  }
}

function applyTableSort(tableId, col, dir) {
  const adapter = getTableAdapter(tableId);
  adapter.setSort(col, dir);

  document.querySelectorAll(`#${tableId} thead th`).forEach(h => {
    h.classList.remove('sort-asc', 'sort-desc');
    if (h.getAttribute('data-sort') === col) {
      h.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
  adapter.render();
}

function enhanceTableHeadersWithExcelFilters() {
  ['table-stock-strength', 'table-strength', 'table-trades-library'].forEach(tableId => {
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

      th.addEventListener('click', (e) => {
        if (e.target.closest('.th-filter-btn')) return;
        const adapter = getTableAdapter(tableId);
        const cur = adapter.getSort();
        const nextDir = cur.col === col
          ? (cur.dir === 'asc' ? 'desc' : 'asc')
          : (TEXT_ASC_DEFAULT_COLS.has(col) ? 'asc' : 'desc');
        applyTableSort(tableId, col, nextDir);
      });
    });
  });

  if (!excelGlobalEventsBound) {
    excelGlobalEventsBound = true;
    document.addEventListener('mousedown', (e) => {
      const pop = document.getElementById('excel-filter-popover');
      if (!pop || !pop.classList.contains('visible')) return;
      if (pop.contains(e.target) || e.target.closest('.th-filter-btn')) return;
      closeExcelFilterPopover();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeExcelFilterPopover();
    });

    ['stock-table-scroll', 'lib-table-scroll'].forEach(scrollId => {
      document.getElementById(scrollId)?.addEventListener('scroll', () => {
        if (activeExcelPopover) positionExcelPopover(activeExcelPopover.thEl);
      });
    });
  }
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

  const adapter = getTableAdapter(tableId);
  const sourceRows = adapter.getRows();
  const filtersMap = adapter.filters;
  const currentFilter = filtersMap[col] || { selectedValues: null, op: 'ALL', val1: null, val2: null };

  const contextRows = sourceRows.filter(r => rowMatchesColFilters(r, filtersMap, col));
  const valueMap = new Map();
  contextRows.forEach(r => {
    const disp = formatColDisplayValue(r, col);
    if (!valueMap.has(disp)) {
      valueMap.set(disp, { disp, raw: r[col], count: 0 });
    }
    valueMap.get(disp).count++;
  });

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
  const draftSelected = currentFilter.selectedValues instanceof Set
    ? new Set(currentFilter.selectedValues)
    : new Set(allValueStrings);
  let draftOp = currentFilter.op || 'ALL';
  let draftVal1 = currentFilter.val1 ?? '';
  let draftVal2 = currentFilter.val2 ?? '';

  const curSort = adapter.getSort();
  const isSortedAsc = curSort.col === col && curSort.dir === 'asc';
  const isSortedDesc = curSort.col === col && curSort.dir === 'desc';

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
    const visibleItems = q ? uniqueItems.filter(u => u.disp.toLowerCase().includes(q)) : uniqueItems;
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
      visibleItems.forEach(u => e.target.checked ? draftSelected.add(u.disp) : draftSelected.delete(u.disp));
      renderCheckboxList(searchInput.value);
    });

    listContainer.querySelectorAll('.efp-chk-val').forEach(chk => {
      chk.addEventListener('change', (e) => {
        const val = e.target.getAttribute('data-val');
        if (e.target.checked) draftSelected.add(val);
        else draftSelected.delete(val);
        if (chkAll) {
          chkAll.checked = visibleItems.length > 0 && visibleItems.every(u => draftSelected.has(u.disp));
        }
      });
    });
  }

  renderCheckboxList('');
  searchInput?.addEventListener('input', (e) => renderCheckboxList(e.target.value));

  pop.querySelector('#efp-sort-asc')?.addEventListener('click', () => {
    applyTableSort(tableId, col, 'asc');
    closeExcelFilterPopover();
  });
  pop.querySelector('#efp-sort-desc')?.addEventListener('click', () => {
    applyTableSort(tableId, col, 'desc');
    closeExcelFilterPopover();
  });

  const opSelect = pop.querySelector('#efp-op-select');
  const val1Input = pop.querySelector('#efp-val1');
  const val2Input = pop.querySelector('#efp-val2');

  const syncNumInputVisibility = () => {
    if (val1Input) val1Input.style.display = ['ALL', 'above_sma', 'below_sma'].includes(draftOp) ? 'none' : 'block';
    if (val2Input) val2Input.style.display = draftOp === 'between' ? 'block' : 'none';
  };

  opSelect?.addEventListener('change', (e) => {
    draftOp = e.target.value;
    syncNumInputVisibility();
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
      const p = presets[parseInt(chip.getAttribute('data-preset-idx'), 10)];
      if (!p) return;
      const isAlreadyActive = chip.classList.contains('active');
      pop.querySelectorAll('.efp-preset-chip').forEach(c => c.classList.remove('active'));

      if (isAlreadyActive) {
        draftOp = 'ALL'; draftVal1 = ''; draftVal2 = '';
      } else {
        chip.classList.add('active');
        draftOp = p.op; draftVal1 = p.val1 ?? ''; draftVal2 = p.val2 ?? '';
      }
      if (opSelect) opSelect.value = draftOp;
      if (val1Input) val1Input.value = draftVal1;
      if (val2Input) val2Input.value = draftVal2;
      syncNumInputVisibility();
    });
  });

  pop.querySelector('#efp-btn-close')?.addEventListener('click', closeExcelFilterPopover);

  pop.querySelector('#efp-btn-clear')?.addEventListener('click', () => {
    delete filtersMap[col];
    closeExcelFilterPopover();
    adapter.render();
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
        val2: draftVal2 !== '' ? Number(draftVal2) : null,
      };
    }

    closeExcelFilterPopover();
    adapter.render();
  });
}

