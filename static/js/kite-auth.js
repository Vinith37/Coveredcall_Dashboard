/**
 * Kite Pulse — Zerodha Kite Connect Authentication & Engine Mode Controller
 */

let kiteModalPollTimer = null;

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

function reloadActiveDataFeeds() {
  fetchData(false);
  if (stockStrengthData) fetchStockStrengthData(false);
}

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
        body: JSON.stringify({ request_token: reqToken.trim() }),
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

async function setEngineMode(mode) {
  if (mode === currentEngineMode) return;

  if (mode === 'kite' && !dashboardData?.kite_status?.is_connected) {
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
    } catch {
      openKiteModal();
      return;
    }
  }

  try {
    const res = await fetch('/api/engine/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    const result = await res.json();
    if (result.success) {
      currentEngineMode = mode;
      syncEngineModeUI(mode);
      showToast(result.message || `Switched to ${mode}`);
      reloadActiveDataFeeds();
    } else if (result.need_auth) {
      openKiteModal();
      showToast('⚠️ Please login to Kite to activate Kite API.');
    }
  } catch (err) {
    console.error('Failed to change engine mode:', err);
    showToast('Failed to switch engine mode.');
  }
}

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
        reloadActiveDataFeeds();
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
  kiteModalPollTimer = setInterval(() => refreshKiteModalStatus(true), 2000);
}

function closeKiteModal() {
  if (kiteModalPollTimer) {
    clearInterval(kiteModalPollTimer);
    kiteModalPollTimer = null;
  }
  const modal = document.getElementById('kite-modal');
  if (modal) modal.style.display = 'none';
  const feedback = document.getElementById('auth-feedback');
  if (feedback) feedback.textContent = '';
}

async function submitKiteToken() {
  const tokenInput = document.getElementById('input-request-token');
  const token = tokenInput?.value.trim();
  const feedback = document.getElementById('auth-feedback');

  if (!token) {
    if (feedback) {
      feedback.textContent = 'Please enter a request_token or access_token.';
      feedback.style.color = 'var(--rose)';
    }
    return;
  }

  if (feedback) {
    feedback.textContent = 'Authenticating with Kite Connect...';
    feedback.style.color = 'var(--cyan)';
  }

  try {
    const res = await fetch('/api/kite/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_token: token }),
    });
    const json = await res.json();

    if (res.ok && json.success) {
      if (feedback) {
        feedback.textContent = `Success! ${json.message}`;
        feedback.style.color = 'var(--emerald)';
      }
      if (tokenInput) tokenInput.value = '';
      currentEngineMode = 'kite';
      syncEngineModeUI('kite');
      showToast('🪁 Switched to Zerodha Kite API (Live Quotes)');
      reloadActiveDataFeeds();
      openKiteModal();
    } else if (feedback) {
      feedback.textContent = json.detail || 'Authorization failed. Please verify request token.';
      feedback.style.color = 'var(--rose)';
    }
  } catch {
    if (feedback) {
      feedback.textContent = 'Error connecting to server.';
      feedback.style.color = 'var(--rose)';
    }
  }
}

async function disconnectKite() {
  try {
    await fetch('/api/kite/disconnect', { method: 'POST' });
    currentEngineMode = 'yfinance';
    syncEngineModeUI('yfinance');
    showToast('⚡ Switched to Zero-Token Yahoo Finance Engine');
    openKiteModal();
    reloadActiveDataFeeds();
  } catch (e) {
    console.error('Error disconnecting:', e);
  }
}

