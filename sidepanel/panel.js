/**
 * YouTube Sentiment Monitor — Side Panel JS
 * Renders live sentiment data, timeline, keywords, peaks, and session history.
 */

(function () {
  'use strict';

  // ─── DOM References ────────────────────────────────────────────────────

  const $ = id => document.getElementById(id);
  const $$ = sel => document.querySelector(sel);

  const statusBar = $('status-bar');
  const statusDot = $('status-dot');
  const statusText = $('status-text');
  const streamMeta = $('stream-meta');
  const streamTitle = $('stream-title');
  const viewerVal = $('viewer-val');
  const peakVal = $('peak-val');
  const chatVal = $('chat-val');
  const gaugeSection = $('gauge-section');
  const gaugeFill = $('gauge-fill');
  const gaugeScore = $('gauge-score');
  const moodLabel = $('mood-label');
  const chartSection = $('chart-section');
  const tickCount = $('tick-count');
  const keywordsSection = $('keywords-section');
  const keywordsList = $('keywords-list');
  const peaksSection = $('peaks-section');
  const peaksList = $('peaks-list');
  const radarSection = $('radar-section');
  const idlePlaceholder = $('idle-placeholder');

  // ─── Tab Navigation ───────────────────────────────────────────────────

  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      btn.classList.add('active');
      const tabId = 'tab-' + btn.dataset.tab;
      document.getElementById(tabId).classList.remove('hidden');
      if (btn.dataset.tab === 'history') loadHistory();
    });
  });

  // ─── Chart.js Setup ───────────────────────────────────────────────────

  let liveChart = null;
  let historyChart = null;
  let emotionRadar = null;

  // ─── Emotion Radar ────────────────────────────────────────────────────────

  const EMOTION_ORDER  = ['alegria','surpresa','curiosidade','confianca','amor','tedio','nojo','medo','tristeza','raiva'];
  const EMOTION_LABELS_PT = {
    alegria: 'Alegria', amor: 'Amor', surpresa: 'Surpresa', raiva: 'Raiva',
    tristeza: 'Tristeza', medo: 'Medo', nojo: 'Nojo', tedio: 'Tédio',
    curiosidade: 'Curiosidade', confianca: 'Confiança'
  };

  function initEmotionRadar() {
    const ctx = $('emotion-radar').getContext('2d');
    emotionRadar = new Chart(ctx, {
      type: 'radar',
      data: {
        labels: EMOTION_ORDER.map(k => EMOTION_LABELS_PT[k]),
        datasets: [{
          data: EMOTION_ORDER.map(() => 0),
          borderColor: '#22c55e',
          backgroundColor: 'rgba(34,197,94,0.12)',
          borderWidth: 1.5,
          pointRadius: 3,
          pointBackgroundColor: '#22c55e',
          pointHoverRadius: 5
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          r: {
            min: 0,
            max: 100,
            ticks: { display: false, stepSize: 25 },
            grid: { color: '#2a2a2a' },
            angleLines: { color: '#2a2a2a' },
            pointLabels: { color: '#71717a', font: { size: 9 } }
          }
        }
      }
    });
  }

  function updateEmotionRadar(emotionScores) {
    if (!emotionScores) return;
    if (!emotionRadar) initEmotionRadar();
    const raw = EMOTION_ORDER.map(k => emotionScores[k] || 0);
    // Scale so the dominant emotion = 100 (better visual contrast)
    const max = Math.max(...raw, 1);
    emotionRadar.data.datasets[0].data = raw.map(v => Math.round((v / max) * 100));
    emotionRadar.update('none');
  }

  function initLiveChart() {
    const ctx = $('sentiment-chart').getContext('2d');
    liveChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Sentimento',
            data: [],
            borderColor: '#22c55e',
            backgroundColor: 'rgba(34,197,94,0.07)',
            borderWidth: 2,
            tension: 0.45,
            fill: true,
            pointRadius: [],
            pointBackgroundColor: '#f59e0b',
            pointBorderColor: '#f59e0b',
            yAxisID: 'y'
          },
          {
            label: 'Chat Rate',
            data: [],
            borderColor: '#3b82f680',
            borderWidth: 1,
            borderDash: [3, 3],
            tension: 0.3,
            fill: false,
            pointRadius: 0,
            yAxisID: 'y2'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 350 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                if (ctx.datasetIndex === 0) return ` Sentimento: ${ctx.raw.toFixed(2)}`;
                return ` Chat: ${Math.round(ctx.raw * 200)}/min`;
              }
            }
          }
        },
        scales: {
          x: {
            ticks: { color: '#52525b', maxTicksLimit: 6, font: { size: 9 } },
            grid: { color: '#1c1c1e' }
          },
          y: {
            min: -1,
            max: 1,
            ticks: { color: '#52525b', stepSize: 0.5, font: { size: 9 } },
            grid: { color: '#1c1c1e' }
          },
          y2: {
            display: false,
            min: 0,
            max: 1
          }
        }
      }
    });
  }

  function updateLiveChart(ticks) {
    if (!liveChart) initLiveChart();

    const labels = ticks.map(t => formatTime(t.timestamp));
    const scores = ticks.map(t => t.windowScore);
    const rates = ticks.map(t => Math.min(1, t.chatRate / 200));
    const pointRadii = ticks.map(t => t.isPeak ? 5 : 0);

    liveChart.data.labels = labels;
    liveChart.data.datasets[0].data = scores;
    liveChart.data.datasets[0].pointRadius = pointRadii;
    liveChart.data.datasets[1].data = rates;
    liveChart.update('none');

    tickCount.textContent = `${ticks.length} ticks`;
  }

  // ─── Mood Colors ──────────────────────────────────────────────────────

  const MOOD_COLORS = {
    excited:  '#f59e0b',
    positive: '#22c55e',
    neutral:  '#71717a',
    negative: '#f97316',
    angry:    '#ef4444',
    ironico:  '#a855f7'
  };

  const MOOD_LABELS = {
    excited:  'ANIMADO',
    positive: 'POSITIVO',
    neutral:  'NEUTRO',
    negative: 'NEGATIVO',
    angry:    'BRAVO',
    ironico:  'IRÔNICO'
  };

  // ─── Live View Update ─────────────────────────────────────────────────

  let lastActiveSessionId = null;

  function updateLiveView(data) {
    const { activeSession, tickBuffer, currentViewerCount, avgChatRate } = data;

    if (!activeSession) {
      // Session just ended — save its ID for the report button
      if (lastActiveSessionId) {
        lastEndedSessionId = lastActiveSessionId;
        lastActiveSessionId = null;
      }
      showIdleState();
      return;
    }

    lastActiveSessionId = activeSession.id;

    hideIdleState();

    // Status bar
    statusBar.className = 'status-bar status-live';
    statusText.textContent = '● AO VIVO';

    // Stream meta
    streamMeta.classList.remove('hidden');
    streamTitle.textContent = activeSession.videoTitle || '';
    viewerVal.textContent = formatNumber(currentViewerCount);
    chatVal.textContent = Math.round(avgChatRate);

    // Peak viewers (show only when peak meaningfully exceeds current count)
    const peak = activeSession.peakViewers || 0;
    if (peak > 0 && peak > currentViewerCount * 1.05) {
      $('peak-count').classList.remove('hidden');
      $('peak-sep').classList.remove('hidden');
      peakVal.textContent = formatNumber(peak);
    } else {
      $('peak-count').classList.add('hidden');
      $('peak-sep').classList.add('hidden');
    }

    // Gauge
    gaugeSection.classList.remove('hidden');
    const lastTick = tickBuffer && tickBuffer.length > 0 ? tickBuffer[tickBuffer.length - 1] : null;
    if (lastTick) {
      const score = lastTick.windowScore;
      const label = lastTick.windowLabel || 'neutral';
      const color = MOOD_COLORS[label] || MOOD_COLORS.neutral;

      // gauge fill: map -1..1 to 0..100%
      const pct = Math.round(((score + 1) / 2) * 100);
      gaugeFill.style.setProperty('--pct', pct);
      gaugeFill.style.setProperty('--mood-color', color);
      gaugeScore.style.setProperty('--mood-color', color);
      gaugeScore.textContent = (score >= 0 ? '+' : '') + score.toFixed(2);

      moodLabel.className = `mood-label mood-${label}`;
      moodLabel.textContent = MOOD_LABELS[label] || label.toUpperCase();
    }

    // Timeline
    if (tickBuffer && tickBuffer.length > 0) {
      chartSection.classList.remove('hidden');
      updateLiveChart(tickBuffer);

      // Keywords from last tick
      const kws = lastTick && lastTick.topKeywords ? lastTick.topKeywords : [];
      if (kws.length > 0) {
        keywordsSection.classList.remove('hidden');
        renderKeywords(keywordsList, kws);
      }

      // Emotion radar
      if (lastTick?.emotionScores) {
        radarSection.classList.remove('hidden');
        updateEmotionRadar(lastTick.emotionScores);
      }

      // Peaks
      const peaks = tickBuffer.filter(t => t.isPeak);
      if (peaks.length > 0) {
        peaksSection.classList.remove('hidden');
        renderPeaks(peaks);
      }
    }
  }

  let lastEndedSessionId = null;

  function showIdleState() {
    statusBar.className = 'status-bar status-idle';
    statusText.textContent = 'Aguardando transmissão...';
    streamMeta.classList.add('hidden');
    $('peak-count').classList.add('hidden');
    $('peak-sep').classList.add('hidden');
    gaugeSection.classList.add('hidden');
    chartSection.classList.add('hidden');
    keywordsSection.classList.add('hidden');
    radarSection.classList.add('hidden');
    peaksSection.classList.add('hidden');
    idlePlaceholder.classList.remove('hidden');

    // Show report button if we have a recently ended session
    const liveExportRow = $('live-export-row');
    if (lastEndedSessionId) {
      liveExportRow.classList.remove('hidden');
    }
  }

  function hideIdleState() {
    idlePlaceholder.classList.add('hidden');
    $('live-export-row').classList.add('hidden');
  }

  function renderKeywords(container, keywords) {
    container.innerHTML = keywords.map((w, i) =>
      `<span class="keyword-chip ${i < 3 ? 'top' : ''}">${escHtml(w)}</span>`
    ).join('');
  }

  function renderPeaks(peaks) {
    const shown = peaks.slice(-5); // last 5 peaks
    peaksList.innerHTML = shown.map(t => `
      <div class="peak-item">
        <span class="peak-time">${formatTime(t.timestamp)}</span>
        <span class="peak-rate">↑ ${(t.chatRate / Math.max(1, t.chatRate * 0.5)).toFixed(1)}x</span>
        <span class="peak-score">score: ${t.windowScore >= 0 ? '+' : ''}${t.windowScore.toFixed(2)}</span>
      </div>
    `).join('');
  }

  // ─── History ──────────────────────────────────────────────────────────

  let selectedSessionId = null;

  async function loadHistory() {
    const sessionsList = $('sessions-list');
    const sessionDetail = $('session-detail');

    if (selectedSessionId) return; // already showing detail

    sessionsList.innerHTML = '<div class="loading-text">Carregando...</div>';
    sessionsList.classList.remove('hidden');
    sessionDetail.classList.add('hidden');

    const resp = await sw({ type: 'GET_SESSIONS' });
    const sessions = resp?.sessions || [];

    if (sessions.length === 0) {
      sessionsList.innerHTML = '<div class="no-sessions">Nenhuma sessão gravada ainda.<br>Assista uma live para começar.</div>';
      return;
    }

    sessionsList.innerHTML = sessions.map(s => {
      const dur = s.endedAt ? formatDuration(s.endedAt - s.startedAt) : 'em curso';
      return `
        <div class="session-card" data-id="${s.id}">
          <div class="session-card-title">${escHtml(s.videoTitle || s.videoId)}</div>
          <div class="session-card-meta">
            <span>${formatDate(s.startedAt)}</span>
            <span>•</span>
            <span>${dur}</span>
            <span>•</span>
            <span>${s.totalMessages || 0} msgs</span>
          </div>
        </div>
      `;
    }).join('');

    sessionsList.querySelectorAll('.session-card').forEach(card => {
      card.addEventListener('click', () => openSessionDetail(card.dataset.id, sessions));
    });
  }

  async function openSessionDetail(sessionId, sessions) {
    selectedSessionId = sessionId;
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;

    $('sessions-list').classList.add('hidden');
    const detail = $('session-detail');
    detail.classList.remove('hidden');

    $('detail-title').textContent = session.videoTitle || session.videoId;
    $('detail-meta').innerHTML = `
      ${formatDate(session.startedAt)} &nbsp;•&nbsp;
      ${session.endedAt ? formatDuration(session.endedAt - session.startedAt) : 'em curso'} &nbsp;•&nbsp;
      ${session.totalMessages || 0} mensagens &nbsp;•&nbsp;
      ${session.totalSuperChats || 0} super chats &nbsp;•&nbsp;
      pico: ${formatNumber(session.peakViewers || 0)} espectadores
    `;

    const resp = await sw({ type: 'GET_SESSION_EVENTS', sessionId });
    const events = resp?.events || [];

    // Render history chart
    if (events.length > 0) {
      renderHistoryChart(events);

      // Top keywords from all ticks
      const allKws = {};
      events.forEach(e => (e.topKeywords || []).forEach(k => { allKws[k] = (allKws[k] || 0) + 1; }));
      const kws = Object.entries(allKws).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k);
      renderKeywords($('detail-keywords'), kws);
    }
  }

  function renderHistoryChart(events) {
    const ctx = $('history-chart').getContext('2d');
    if (historyChart) { historyChart.destroy(); historyChart = null; }

    historyChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: events.map(e => formatTime(e.timestamp)),
        datasets: [{
          label: 'Sentimento',
          data: events.map(e => e.windowScore),
          borderColor: '#22c55e',
          backgroundColor: 'rgba(34,197,94,0.07)',
          borderWidth: 2,
          tension: 0.45,
          fill: true,
          pointRadius: events.map(e => e.isPeak ? 4 : 0),
          pointBackgroundColor: '#f59e0b'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            ticks: { color: '#52525b', maxTicksLimit: 8, font: { size: 9 } },
            grid: { color: '#1c1c1e' }
          },
          y: {
            min: -1, max: 1,
            ticks: { color: '#52525b', stepSize: 0.5, font: { size: 9 } },
            grid: { color: '#1c1c1e' }
          }
        }
      }
    });
  }

  $('back-btn').addEventListener('click', () => {
    selectedSessionId = null;
    $('session-detail').classList.add('hidden');
    loadHistory();
  });

  $('export-report').addEventListener('click', () => generateAndOpenReport(selectedSessionId));
  $('export-json').addEventListener('click', async () => {
    if (!selectedSessionId) return;
    const resp = await sw({ type: 'EXPORT', sessionId: selectedSessionId, format: 'json' });
    if (resp?.data) downloadBlob(resp.data, `sentiment_${selectedSessionId}.json`, 'application/json');
  });

  $('export-csv').addEventListener('click', async () => {
    if (!selectedSessionId) return;
    const resp = await sw({ type: 'EXPORT', sessionId: selectedSessionId, format: 'csv' });
    if (resp?.data) downloadBlob(resp.data, `sentiment_${selectedSessionId}.csv`, 'text/csv');
  });

  $('delete-session-btn').addEventListener('click', async () => {
    if (!selectedSessionId) return;
    if (!confirm('Excluir esta sessão? Ação irreversível.')) return;
    await sw({ type: 'DELETE_SESSION', sessionId: selectedSessionId });
    selectedSessionId = null;
    $('session-detail').classList.add('hidden');
    loadHistory();
  });

  $('live-report-btn').addEventListener('click', () => {
    if (lastEndedSessionId) generateAndOpenReport(lastEndedSessionId);
  });

  // ─── Report ───────────────────────────────────────────────────────────

  async function generateAndOpenReport(sessionId) {
    if (!sessionId) return;
    const btn = document.activeElement;
    if (btn) { btn.textContent = 'Gerando...'; btn.disabled = true; }

    const resp = await sw({ type: 'GENERATE_REPORT', sessionId });

    if (btn) { btn.textContent = btn.id === 'export-report' ? 'Relatório HTML' : 'Gerar Relatório desta Sessão'; btn.disabled = false; }

    if (!resp?.html) return;
    downloadBlob(resp.html, `relatorio_sentimento_${sessionId}.html`, 'text/html');
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  function sw(message) {
    return chrome.runtime.sendMessage(message).catch(() => null);
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }

  function formatDuration(ms) {
    const m = Math.floor(ms / 60_000);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}min`;
    return `${m}min`;
  }

  function formatNumber(n) {
    if (!n) return '—';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toLocaleString('pt-BR');
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function downloadBlob(data, filename, mimeType) {
    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── VOD UI ───────────────────────────────────────────────────────────

  let vodToken = null;
  let vodApiKey = null;
  let vodClientVersion = null;
  let vodEstimated = 0;

  function showVODBanner(token, apiKey, clientVersion) {
    vodToken = token;
    vodApiKey = apiKey || null;
    vodClientVersion = clientVersion || null;
    $('vod-banner').classList.remove('hidden');
    $('vod-progress').classList.add('hidden');
    $('vod-complete').classList.add('hidden');
  }

  function hideVODUI() {
    $('vod-banner').classList.add('hidden');
    $('vod-progress').classList.add('hidden');
    $('vod-complete').classList.add('hidden');
    vodToken = null;
  }

  $('vod-analyze-btn').addEventListener('click', () => {
    if (!vodToken) return;
    $('vod-banner').classList.add('hidden');
    $('vod-progress').classList.remove('hidden');
    $('vod-progress-text').textContent = 'Iniciando...';
    $('progress-fill').style.width = '0%';
    // Tell content script to start fetching
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'START_VOD_ANALYSIS',
          token: vodToken,
          apiKey: vodApiKey,
          clientVersion: vodClientVersion
        });
      }
    });
  });

  $('vod-ignore-btn').addEventListener('click', hideVODUI);

  $('vod-cancel-btn').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'CANCEL_VOD_ANALYSIS' });
    });
    hideVODUI();
  });

  $('vod-view-btn').addEventListener('click', () => {
    hideVODUI();
    // Switch to history tab
    document.querySelector('.tab[data-tab="history"]').click();
  });

  // ─── Real-Time Updates ────────────────────────────────────────────────

  // Listen for storage changes (written by SW after each tick, and by content script for VOD progress)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;

    if (changes.liveState) {
      try {
        const data = JSON.parse(changes.liveState.newValue);
        if (document.getElementById('tab-live').classList.contains('active')) {
          updateLiveView(data);
        }
      } catch (_) {}
    }

    if (changes.vodDetected) {
      const d = changes.vodDetected.newValue;
      if (d?.token) showVODBanner(d.token, d.apiKey, d.clientVersion);
    }

    if (changes.vodProgress) {
      const p = changes.vodProgress.newValue;
      if (!p) return;
      if (p.running) {
        $('vod-progress').classList.remove('hidden');
        const pct = vodEstimated > 0
          ? Math.min(99, Math.round((p.totalProcessed / vodEstimated) * 100))
          : Math.min(99, p.page * 2); // rough estimate based on pages
        $('progress-fill').style.width = pct + '%';
        $('vod-progress-text').textContent = `${p.totalProcessed.toLocaleString('pt-BR')} mensagens processadas`;
      }
      if (p.done) {
        $('vod-progress').classList.add('hidden');
        $('vod-complete').classList.remove('hidden');
        $('progress-fill').style.width = '100%';
      }
    }
  });

  // Initial state fetch on panel open
  sw({ type: 'GET_STATE' }).then(data => {
    if (data) updateLiveView(data);
    else showIdleState();
  });

  // Check for any pending VOD detection or in-progress analysis
  // (handles case where panel opens after content script already ran)
  chrome.storage.session.get(['vodDetected', 'vodProgress'], ({ vodDetected, vodProgress }) => {
    if (vodDetected?.token && !vodProgress?.running && !vodProgress?.done) {
      showVODBanner(vodDetected.token, vodDetected.apiKey, vodDetected.clientVersion);
    }
    if (vodProgress?.running) {
      $('vod-progress').classList.remove('hidden');
      $('vod-progress-text').textContent = `${(vodProgress.totalProcessed || 0).toLocaleString('pt-BR')} mensagens processadas`;
    }
    if (vodProgress?.done) {
      $('vod-complete').classList.remove('hidden');
    }
  });

  // Keep SW alive while panel is open (panel open = user is watching)
  setInterval(() => sw({ type: 'PING' }).catch(() => {}), 20_000);

})();
