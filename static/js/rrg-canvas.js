/**
 * Kite Pulse — Relative Rotation Graph (RRG) Visualizer, Scrubber & Rankings Table
 */

const canvas = document.getElementById('rrg-canvas');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('rrg-tooltip');
const canvasWrapper = document.getElementById('canvas-wrapper');
const spotlightCard = document.getElementById('sector-spotlight-card');
const sectorChipsBar = document.getElementById('sector-chips-bar');
const outlierPill = document.getElementById('outlier-alert-pill');

function syncTailControls(newLen) {
  scTailLen = newLen;
  const slider = document.getElementById('sc-tail-slider');
  if (slider && parseInt(slider.value, 10) !== newLen) {
    slider.value = newLen;
  }
  document.querySelectorAll('[data-tails]').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.getAttribute('data-tails'), 10) === newLen);
  });
}

function clearSectorSelection() {
  selectedSector = null;
  if (spotlightCard) spotlightCard.style.display = 'none';
  document.querySelectorAll('.sector-chip').forEach(c => c.classList.remove('active'));
  document.querySelector('.sector-chip[data-symbol="ALL"]')?.classList.add('active');
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
    chip.className = `sector-chip ${colorConfig.chipClass} ${selectedSector === item.symbol ? 'active' : ''}`;
    chip.setAttribute('data-symbol', item.symbol);
    chip.textContent = item.name.replace('Nifty ', '');

    chip.addEventListener('click', () => {
      document.querySelectorAll('.sector-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      selectSector(item);
    });

    chip.addEventListener('mouseenter', () => {
      if (!selectedSector) { hoveredSector = item; renderRRGCanvas(); }
    });
    chip.addEventListener('mouseleave', () => {
      if (!selectedSector) { hoveredSector = null; renderRRGCanvas(); }
    });

    sectorChipsBar.appendChild(chip);
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

  const stopDrag = () => {
    if (isDragging) {
      isDragging = false;
      canvas.style.cursor = 'crosshair';
    }
  };
  window.addEventListener('mouseup', stopDrag);
  window.addEventListener('blur', stopDrag);

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
  if (!e.ctrlKey && !e.metaKey) return;
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
    const dist = Math.hypot(mouseX - transformX(dp.r), mouseY - transformY(dp.m));
    if (dist < minDistance) {
      minDistance = dist;
      found = item;
    }
  });

  if (found !== hoveredSector) {
    hoveredSector = found;
    renderRRGCanvas();
  }
  if (hoveredSector) showTooltip(e.clientX, e.clientY, hoveredSector);
  else tooltip.style.display = 'none';
}

function handleCanvasClick() {
  if (hasDragged) { hasDragged = false; return; }
  if (!hoveredSector) return;

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

function showTooltip(clientX, clientY, item) {
  const dp = getDisplayPoint(item);
  tooltip.style.display = 'block';
  tooltip.innerHTML = `
    <div class="tt-title">${item.name}</div>
    <div class="tt-sub">${item.symbol}</div>
    <div class="tt-row"><span class="lbl">Quadrant:</span><span class="val" style="color: ${QUAD_COLORS[dp.q]?.stroke}">${dp.q}</span></div>
    <div class="tt-row"><span class="lbl">Heading:</span><span class="val">${item.direction}</span></div>
    <div class="tt-row"><span class="lbl">RS-Ratio:</span><span class="val">${dp.r?.toFixed(2)}${scEndOffset > 0 ? '' : ` (${item.rs_ratio_delta >= 0 ? '+' : ''}${item.rs_ratio_delta})`}</span></div>
    <div class="tt-row"><span class="lbl">RS-Momentum:</span><span class="val">${dp.m?.toFixed(2)}${scEndOffset > 0 ? '' : ` (${item.rs_momentum_delta >= 0 ? '+' : ''}${item.rs_momentum_delta})`}</span></div>
    <div class="tt-row"><span class="lbl">Distance:</span><span class="val">${Math.hypot(dp.r - 100, dp.m - 100).toFixed(2)}</span></div>
  `;

  const ttRect = tooltip.getBoundingClientRect();
  const wrapperRect = canvasWrapper.getBoundingClientRect();
  let left = clientX - wrapperRect.left + 15;
  let top = clientY - wrapperRect.top + 15;

  if (left + ttRect.width > wrapperRect.width - 20) left = clientX - wrapperRect.left - ttRect.width - 15;
  if (top + ttRect.height > wrapperRect.height - 20) top = clientY - wrapperRect.top - ttRect.height - 15;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

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

  const availHalfHeight = Math.max((height / 2) - 55, 150);
  const pixelsPerUnit = (availHalfHeight / span) * zoomLevel;

  return {
    transformX: (x) => centerX + (x - 100.0) * pixelsPerUnit,
    transformY: (y) => centerY - (y - 100.0) * pixelsPerUnit,
    centerX, centerY, pixelsPerUnit, span, width, height,
  };
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
    { x: curX - boxW - 18, y: curY - 18 },
  ];

  let bestSlot = candidateSlots[0];
  if (checkCollision) {
    for (const slot of candidateSlots) {
      const rect = { x: slot.x, y: slot.y, w: boxW, h: boxH };
      const overlaps = placedLabels.some(p =>
        !(rect.x + rect.w < p.x || rect.x > p.x + p.w || rect.y + rect.h < p.y || rect.y > p.y + p.h)
      );
      if (!overlaps) { bestSlot = slot; break; }
    }
  }
  placedLabels.push({ x: bestSlot.x, y: bestSlot.y, w: boxW, h: boxH });
  return bestSlot;
}

function isSectorActive(symbol) {
  return selectedSector === symbol || Boolean(hoveredSector && hoveredSector.symbol === symbol);
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
  if (chartStyle === 'SC') {
    renderStockChartsRRG(width, height, rrgList, transforms);
    return;
  }

  const { transformX, transformY, centerX: cx, centerY: cy, pixelsPerUnit, span } = transforms;

  // 1. Quadrants
  ctx.fillStyle = 'rgba(16, 185, 129, 0.055)'; ctx.fillRect(cx, 0, width - cx, cy);
  ctx.fillStyle = 'rgba(6, 182, 212, 0.055)';  ctx.fillRect(0, 0, cx, cy);
  ctx.fillStyle = 'rgba(244, 63, 94, 0.055)';  ctx.fillRect(0, cy, cx, height - cy);
  ctx.fillStyle = 'rgba(245, 158, 11, 0.055)'; ctx.fillRect(cx, cy, width - cx, height - cy);

  // 2. Distance Rings
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.045)';
  ctx.lineWidth = 1;
  const ringStep = span > 10 ? 4.0 : (span > 5 ? 2.0 : 1.0);
  const maxRingDist = Math.max(width, height) / pixelsPerUnit;

  for (let d = ringStep; d <= maxRingDist; d += ringStep) {
    const radius = d * pixelsPerUnit;
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
    const diagX = cx + radius * 0.7071;
    const diagY = cy - radius * 0.7071;
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

  // 4. Crosshairs & Benchmark Bullseye
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.38)';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, height); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(width, cy); ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)'; ctx.fill();
  ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = '#38bdf8'; ctx.fill();

  ctx.font = '700 9px JetBrains Mono, monospace';
  ctx.fillStyle = 'rgba(56, 189, 248, 0.85)';
  ctx.fillText('100.0 (Benchmark)', cx + 9, cy - 8);

  // Watermarks & Axis Titles
  ctx.font = '800 12px Outfit, sans-serif';
  ctx.fillStyle = 'rgba(16, 185, 129, 0.35)'; ctx.fillText('LEADING (Top-Right)', width - 160, 26);
  ctx.fillStyle = 'rgba(6, 182, 212, 0.35)';  ctx.fillText('IMPROVING (Top-Left)', 20, 26);
  ctx.fillStyle = 'rgba(244, 63, 94, 0.35)';  ctx.fillText('LAGGING (Bottom-Left)', 20, height - 26);
  ctx.fillStyle = 'rgba(245, 158, 11, 0.35)'; ctx.fillText('WEAKENING (Bottom-Right)', width - 175, height - 26);

  ctx.font = '600 10px Inter, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.fillText('RS-Ratio (Benchmark = 100) →', width - 210, cy + 16);
  ctx.save();
  ctx.translate(cx - 10, 85);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('RS-Momentum (Benchmark = 100) →', 0, 0);
  ctx.restore();

  // 5. Partition Visible Nodes vs Outliers
  const visibleNodes = [];
  const outliers = [];

  rrgList.forEach(item => {
    const win = scWindow(item);
    const dp = getDisplayPoint(item);
    if (currentQuadrantFilter !== 'ALL' && dp.q !== currentQuadrantFilter) return;

    const curX = transformX(dp.r);
    const curY = transformY(dp.m);
    if (curX >= 15 && curX <= width - 15 && curY >= 15 && curY <= height - 15) {
      visibleNodes.push({ item, curX, curY, winPts: win.pts, colorConfig: QUAD_COLORS[dp.q] || QUAD_COLORS.LEADING });
    } else {
      outliers.push(item);
    }
  });

  updateOutlierBanner(outliers);

  // Draw Tails
  if (scTailLen > 0) {
    visibleNodes.forEach(({ item, winPts, colorConfig }) => {
      const hot = isSectorActive(item.symbol);
      const isMuted = (hoveredSector || selectedSector) && !hot;

      if (winPts.length >= 2) {
        ctx.beginPath();
        winPts.forEach((pt, i) => {
          const px = transformX(pt.r), py = transformY(pt.m);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.strokeStyle = isMuted ? 'rgba(255, 255, 255, 0.03)' : hot ? colorConfig.stroke : colorConfig.stroke + '75';
        ctx.lineWidth = hot ? 3.5 : 1.8;
        ctx.stroke();

        for (let i = 0; i < winPts.length - 1; i++) {
          ctx.beginPath();
          ctx.arc(transformX(winPts[i].r), transformY(winPts[i].m), hot ? 3.0 : 2.0, 0, Math.PI * 2);
          ctx.fillStyle = isMuted ? 'rgba(255, 255, 255, 0.05)' : colorConfig.stroke + '80';
          ctx.fill();
        }
      }
    });
  }

  // Draw Nodes & Labels
  const placedLabels = [];
  visibleNodes.sort((a, b) => Number(isSectorActive(a.item.symbol)) - Number(isSectorActive(b.item.symbol)));

  visibleNodes.forEach(({ item, curX, curY, colorConfig }) => {
    const hot = isSectorActive(item.symbol);
    const isMuted = (hoveredSector || selectedSector) && !hot;

    if (hot) {
      ctx.beginPath(); ctx.arc(curX, curY, 18, 0, Math.PI * 2);
      ctx.fillStyle = colorConfig.fill; ctx.fill();
      ctx.beginPath(); ctx.arc(curX, curY, 11, 0, Math.PI * 2);
      ctx.strokeStyle = colorConfig.stroke; ctx.lineWidth = 2; ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(curX, curY, hot ? 7.0 : 5.0, 0, Math.PI * 2);
    ctx.fillStyle = isMuted ? '#475569' : colorConfig.stroke;
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    const shouldDrawLabel = labelMode === 'HOVER' ? hot : (labelMode === 'LEADERS' ? (hot || item.distance > 1.5) : true);
    if (shouldDrawLabel) {
      const labelText = item.name.replace('Nifty ', '');
      ctx.font = hot ? '700 11px Inter, sans-serif' : '600 10px Inter, sans-serif';
      const boxWidth = ctx.measureText(labelText).width + 12;
      const boxHeight = 18;

      const bestSlot = findNonOverlappingSlot(curX, curY, boxWidth, boxHeight, placedLabels, labelMode === 'STAGGERED' && !hot);

      if (Math.hypot(bestSlot.x - (curX + 10), bestSlot.y - (curY - 9)) > 4) {
        ctx.beginPath();
        ctx.moveTo(curX, curY);
        ctx.lineTo(bestSlot.x + boxWidth / 2, bestSlot.y + boxHeight / 2);
        ctx.strokeStyle = isMuted ? 'rgba(255, 255, 255, 0.08)' : (colorConfig.stroke + '85');
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.fillStyle = isMuted ? 'rgba(15, 23, 42, 0.5)' : hot ? 'rgba(15, 23, 42, 0.96)' : 'rgba(15, 23, 42, 0.84)';
      ctx.fillRect(bestSlot.x, bestSlot.y, boxWidth, boxHeight);

      ctx.strokeStyle = hot ? colorConfig.stroke : 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = hot ? 1.5 : 1;
      ctx.strokeRect(bestSlot.x, bestSlot.y, boxWidth, boxHeight);

      ctx.fillStyle = isMuted ? '#64748b' : hot ? '#ffffff' : '#f1f5f9';
      ctx.fillText(labelText, bestSlot.x + 6, bestSlot.y + 13);
    }
  });

  updateScPanel();
}

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
  nodes.sort((a, b) => Number(isSectorActive(a.item.symbol)) - Number(isSectorActive(b.item.symbol)));

  nodes.forEach(({ item, hx, hy, win, q }) => {
    const hot = isSectorActive(item.symbol);
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
    const slot = findNonOverlappingSlot(hx, hy, ctx.measureText(label).width, 13, placedLabels, true);
    ctx.fillStyle = '#111';
    ctx.fillText(label, slot.x, slot.y + 10);
    ctx.globalAlpha = 1;
  });

  updateScPanel();
}

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
    syncTailControls(parseInt(e.target.value, 10));
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

    const tr = document.createElement('tr');
    if (isSectorActive(item.symbol)) tr.style.backgroundColor = 'rgba(6, 182, 212, 0.16)';
    tr.style.cursor = 'pointer';

    tr.addEventListener('mouseenter', () => { hoveredSector = item; renderRRGCanvas(); });
    tr.addEventListener('mouseleave', () => { hoveredSector = null; renderRRGCanvas(); });
    tr.addEventListener('click', () => {
      if (selectedSector === item.symbol) clearSectorSelection();
      else selectSector(item);
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

