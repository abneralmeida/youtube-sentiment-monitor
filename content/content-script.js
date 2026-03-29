/**
 * YouTube Sentiment Monitor — Content Script
 * Monitors live chat, viewer count, and stream metadata.
 * Sends batched data to the service worker for analysis.
 */

(function () {
  'use strict';

  let chatObserver = null;
  let bodyObserver = null;
  let viewerPollInterval = null;
  let heartbeatInterval = null;
  let batchTimer = null;
  let messageBatch = [];
  let lastUrl = location.href;
  let isLiveStream = false;
  let sessionStarted = false;

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function parseViewerCount(text) {
    if (!text) return 0;

    // Handle "mil" (Portuguese for thousand): "7,6 mil" → 7600
    const milMatch = text.match(/([\d.,]+)\s*mil/i);
    if (milMatch) return Math.round(parseFloat(milMatch[1].replace(',', '.')) * 1_000);

    // Handle M/K suffixes
    const clean = text.replace(/[^\d.,KkMm]/g, '').trim();
    if (/[Mm]/.test(clean)) return Math.round(parseFloat(clean.replace(',', '.')) * 1_000_000);
    if (/[Kk]/.test(clean)) return Math.round(parseFloat(clean.replace(',', '.')) * 1_000);

    // Brazilian Portuguese uses period as thousands separator: "7.608" → 7608
    // But "7.6" could mean 7.6 (decimal). Disambiguate: if there are 3 digits after the period, it's thousands.
    const ptThousands = clean.match(/^(\d{1,3})\.(\d{3})$/);
    if (ptThousands) return parseInt(ptThousands[1] + ptThousands[2], 10);

    // Remove all separators and parse
    const n = parseInt(clean.replace(/[.,]/g, ''), 10);
    return isNaN(n) ? 0 : n;
  }

  function getVideoId() {
    const params = new URLSearchParams(location.search);
    return params.get('v') || '';
  }

  function getVideoTitle() {
    const el = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1[class*="watch"] yt-formatted-string');
    return el ? el.textContent.trim() : document.title.replace(' - YouTube', '').trim();
  }

  function getChannelName() {
    const el = document.querySelector('ytd-channel-name yt-formatted-string#text, ytd-video-owner-renderer .ytd-channel-name yt-formatted-string');
    return el ? el.textContent.trim() : '';
  }

  function getViewerCount() {
    // For live streams, prefer elements that contain "assistindo" or "watching"
    // YouTube shows: "7.608 assistindo agora" or "7,608 watching now"
    const allSpans = document.querySelectorAll(
      'yt-view-count-renderer span, span.view-count, ytd-video-view-count-renderer span'
    );
    for (const el of allSpans) {
      const text = el.textContent || '';
      if (/assistindo|watching/i.test(text)) {
        const count = parseViewerCount(text);
        if (count > 0) return count;
      }
    }

    // Fallback: try the primary view-count renderer (first match is usually correct)
    const primary = document.querySelector(
      '#count yt-view-count-renderer span, ytd-watch-metadata yt-view-count-renderer span'
    );
    if (primary) {
      const count = parseViewerCount(primary.textContent);
      if (count > 0) return count;
    }

    // Last resort: any view-count element
    const any = document.querySelector('yt-view-count-renderer span');
    if (any) {
      const count = parseViewerCount(any.textContent);
      if (count > 0) return count;
    }

    return 0;
  }

  function isCurrentlyLive() {
    // Check for LIVE badge
    const badge = document.querySelector(
      '.ytp-live-badge, .ytd-badge-supported-renderer[aria-label="LIVE"], ' +
      'yt-live-chat-app, ytd-live-chat-frame'
    );
    return !!badge;
  }

  // ─── Message Sending ──────────────────────────────────────────────────────

  function sendToSW(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  function flushBatch() {
    if (messageBatch.length === 0) return;
    const batch = messageBatch.slice();
    messageBatch = [];
    batchTimer = null;
    sendToSW({ type: 'CHAT_BATCH', messages: batch, videoId: getVideoId() });
  }

  function queueMessage(msg) {
    messageBatch.push(msg);
    if (!batchTimer) {
      batchTimer = setTimeout(flushBatch, 1000);
    }
  }

  // ─── Message Extraction ───────────────────────────────────────────────────

  function extractEmojis(el) {
    return [...el.querySelectorAll('img.emoji, yt-emoji-run img, img[class*="emoji"]')]
      .map(img => img.getAttribute('aria-label') || img.getAttribute('alt') || '')
      .filter(Boolean);
  }

  function classifyElement(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'yt-live-chat-paid-message-renderer') return 'super_chat';
    if (tag === 'yt-live-chat-membership-item-renderer') return 'membership';
    if (tag === 'yt-live-chat-text-message-renderer') return 'message';
    return null;
  }

  function extractMessage(el) {
    const type = classifyElement(el);
    if (!type) return null;

    const textEl = el.querySelector('#message');
    const authorEl = el.querySelector('#author-name');
    const paidEl = el.querySelector('#purchase-amount, #purchase-amount-chip');
    const badgeEl = el.querySelector('#chat-badges yt-live-chat-author-badge-renderer');

    let text = '';
    if (textEl) {
      // Collect text nodes and emoji alt text
      text = [...textEl.childNodes].map(node => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent;
        if (node.tagName && node.tagName.toLowerCase() === 'img') {
          return node.getAttribute('alt') || node.getAttribute('aria-label') || '';
        }
        return node.textContent || '';
      }).join('');
    }

    const emojis = extractEmojis(el);
    const paidAmount = paidEl ? paidEl.textContent.trim() : null;
    const isMember = !!badgeEl;

    return {
      type,
      text: text.trim(),
      author: authorEl ? authorEl.textContent.trim() : '',
      emojis,
      paidAmount,
      isMember,
      ts: Date.now()
    };
  }

  // ─── Chat Observer ────────────────────────────────────────────────────────

  function attachChatObserver(itemsEl) {
    if (chatObserver) chatObserver.disconnect();

    chatObserver = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const msg = extractMessage(node);
          if (!msg || !msg.text) continue;

          // Priority items bypass the batch queue
          if (msg.type === 'super_chat' || msg.type === 'membership') {
            sendToSW({ type: 'CHAT_MESSAGE', message: msg, videoId: getVideoId() });
          } else {
            queueMessage(msg);
          }
        }
      }
    });

    chatObserver.observe(itemsEl, { childList: true, subtree: false });
  }

  // ─── Chat Discovery ───────────────────────────────────────────────────────

  function findChatItems() {
    // Layout A: inline items container
    const inlineItems = document.getElementById('items');
    if (inlineItems && inlineItems.closest('yt-live-chat-item-list-renderer')) {
      return { items: inlineItems, doc: document };
    }

    // Layout B: iframe-based chat
    const frame = document.getElementById('chatframe');
    if (!frame) return null;
    try {
      const frameDoc = frame.contentDocument || frame.contentWindow?.document;
      if (!frameDoc) return null;
      const items = frameDoc.getElementById('items');
      if (items) return { items, doc: frameDoc };
    } catch (_) {
      return null;
    }
    return null;
  }

  let chatPollInterval = null;

  function startChatDiscovery() {
    if (chatPollInterval) clearInterval(chatPollInterval);

    chatPollInterval = setInterval(() => {
      const found = findChatItems();
      if (found) {
        clearInterval(chatPollInterval);
        chatPollInterval = null;
        attachChatObserver(found.items);
      }
    }, 500);

    // Stop polling after 30s if not found (not a live stream)
    setTimeout(() => {
      if (chatPollInterval) {
        clearInterval(chatPollInterval);
        chatPollInterval = null;
      }
    }, 30_000);
  }

  // ─── Viewer Count Polling ─────────────────────────────────────────────────

  let lastViewerCount = 0;

  function startViewerPolling() {
    if (viewerPollInterval) clearInterval(viewerPollInterval);

    viewerPollInterval = setInterval(() => {
      const count = getViewerCount();
      if (count !== lastViewerCount) {
        lastViewerCount = count;
        sendToSW({ type: 'VIEWER_COUNT', count, videoId: getVideoId() });
      }
    }, 8000);
  }

  // ─── Session Lifecycle ────────────────────────────────────────────────────

  function startSession() {
    if (sessionStarted) return;
    sessionStarted = true;
    sendToSW({
      type: 'STREAM_START',
      videoId: getVideoId(),
      videoTitle: getVideoTitle(),
      channelName: getChannelName(),
      ts: Date.now()
    });
    startViewerPolling();
    startChatDiscovery();
  }

  function endSession() {
    sessionStarted = false;
    if (chatObserver) { chatObserver.disconnect(); chatObserver = null; }
    if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = null; }
    if (viewerPollInterval) { clearInterval(viewerPollInterval); viewerPollInterval = null; }
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    flushBatch();
    sendToSW({ type: 'STREAM_END', videoId: getVideoId(), ts: Date.now() });
  }

  // ─── Heartbeat ────────────────────────────────────────────────────────────

  function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      sendToSW({ type: 'PING' });
    }, 20_000);
  }

  // ─── Tab Visibility Recovery ──────────────────────────────────────────────
  // When the user switches back to the YouTube tab, Chrome un-throttles the
  // content script. We use this moment to:
  //   1. Wake the service worker with a PING (timers may have been killed)
  //   2. Immediately poll the viewer count (stale while tab was hidden)
  //   3. Flush any buffered chat messages

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!sessionStarted) return;

    // Wake SW — it may have been terminated while the tab was in background
    sendToSW({ type: 'PING' });

    // Immediately refresh viewer count instead of waiting up to 8s
    const count = getViewerCount();
    if (count > 0 && count !== lastViewerCount) {
      lastViewerCount = count;
      sendToSW({ type: 'VIEWER_COUNT', count, videoId: getVideoId() });
    }

    // Push any accumulated chat messages that were held in the buffer
    flushBatch();
  });

  // ─── VOD Chat Replay Analysis ─────────────────────────────────────────────

  let vodAnalysisRunning = false;

  // Inject a script tag to read ytInitialData from the page's JS world
  // (content scripts run in an isolated world and cannot access page variables directly)
  function readYtInitialData() {
    return new Promise(resolve => {
      const msgId = '__ysm_' + Date.now();
      window.addEventListener('message', function handler(e) {
        if (e.data?.type !== msgId) return;
        window.removeEventListener('message', handler);
        resolve(e.data.payload || null);
      });
      const s = document.createElement('script');
      s.textContent = `
        try {
          const d = window.ytInitialData;
          const bar = d?.contents?.twoColumnWatchNextResults?.conversationBar;
          const chat = bar?.liveChatRenderer;
          const conts = chat?.continuations || [];

          // Try all known continuation paths in priority order
          let token = null;
          for (const c of conts) {
            token = c?.liveChatReplayContinuationData?.continuation
                 || c?.timedContinuationData?.continuation
                 || c?.reloadContinuationData?.continuation
                 || c?.playerSeekContinuationData?.continuation;
            if (token) break;
          }

          // isReplay: check flag OR presence of replay-specific continuation
          const hasReplayCont = conts.some(c => c?.liveChatReplayContinuationData);
          const isReplay = chat?.isReplay === true || chat?.isReplay === 'true' || hasReplayCont;

          // Extract current API key and client version from page context
          const apiKey = window.ytcfg?.get?.('INNERTUBE_API_KEY') || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
          const clientVersion = window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') || '2.20240329.01.00';

          window.postMessage({ type: '${msgId}', payload: { token, isReplay, apiKey, clientVersion } }, '*');
        } catch(e) {
          window.postMessage({ type: '${msgId}', payload: null }, '*');
        }
      `;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    });
  }

  async function detectAndNotifyVOD() {
    if (isCurrentlyLive()) return; // handled by live stream path
    await new Promise(r => setTimeout(r, 800)); // let page settle
    const data = await readYtInitialData();
    if (!data?.token || !data?.isReplay) return;

    // Write to session storage so the panel picks it up via onChanged
    chrome.storage.session.set({
      vodDetected: {
        token: data.token,
        apiKey: data.apiKey,
        clientVersion: data.clientVersion,
        videoId: getVideoId(),
        videoTitle: getVideoTitle(),
        channelName: getChannelName(),
        ts: Date.now()
      }
    }).catch(() => {});
  }

  async function runVODAnalysis(initialToken, apiKey, clientVersion) {
    if (vodAnalysisRunning) return;
    vodAnalysisRunning = true;

    const videoId    = getVideoId();
    const videoTitle = getVideoTitle();
    const channelName = getChannelName();

    // Tell SW to create a VOD session and wait for confirmation
    await sendToSW({ type: 'VOD_ANALYSIS_START', videoId, videoTitle, channelName });

    let token = initialToken;
    let totalProcessed = 0;
    let page = 0;
    const MAX_PAGES = 200; // cap ~20k msgs for safety

    const YT_API_KEY = apiKey || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    const YT_CLIENT_VERSION = clientVersion || '2.20240329.01.00';

    while (token && page < MAX_PAGES && vodAnalysisRunning) {
      let data;
      try {
        const resp = await fetch(
          `/youtubei/v1/live_chat/get_live_chat_replay?key=${YT_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              context: {
                client: { clientName: 'WEB', clientVersion: YT_CLIENT_VERSION }
              },
              continuation: token
            })
          }
        );
        if (!resp.ok) break;
        data = await resp.json();
      } catch (_) { break; }

      const cont = data?.liveChatContinuation;
      if (!cont) break;

      // Extract messages from this page
      const messages = [];
      for (const action of cont.actions || []) {
        const replayAction = action.replayChatItemAction;
        if (!replayAction) continue;

        for (const a of replayAction.actions || []) {
          const item = a.addChatItemAction?.item;
          if (!item) continue;

          const renderer = item.liveChatTextMessageRenderer
                        || item.liveChatPaidMessageRenderer
                        || item.liveChatMembershipItemRenderer;
          if (!renderer) continue;

          // Reconstruct text from runs (supports emoji alt text)
          const runs = renderer.message?.runs
                    || renderer.headerSubtext?.runs
                    || [];
          const text = runs.map(r =>
            r.text || r.emoji?.shortcuts?.[0] || r.emoji?.emojiId || ''
          ).join('');

          // Timestamp: microseconds → ms
          const ts = renderer.timestampUsec
            ? Math.floor(parseInt(renderer.timestampUsec, 10) / 1000)
            : Date.now();

          // Emojis in message
          const emojis = runs
            .filter(r => r.emoji)
            .map(r => r.emoji?.shortcuts?.[0] || r.emoji?.emojiId || '');

          const type = item.liveChatPaidMessageRenderer     ? 'super_chat'
                     : item.liveChatMembershipItemRenderer  ? 'membership'
                     : 'message';

          if (text.trim() || emojis.length) {
            messages.push({ type, text: text.trim(), emojis, ts, isMember: false });
          }
        }
      }

      if (messages.length > 0) {
        await sendToSW({ type: 'VOD_MESSAGES_BATCH', messages });
        totalProcessed += messages.length;
      }

      // Report progress to panel via storage.session
      chrome.storage.session.set({
        vodProgress: { totalProcessed, page, running: true }
      }).catch(() => {});

      // Next continuation token
      const nextCont = cont.continuations?.[0];
      token = nextCont?.liveChatReplayContinuationData?.continuation
           || nextCont?.timedContinuationData?.continuation
           || null;

      page++;
      // Small delay to not hammer YouTube's internal API
      await new Promise(r => setTimeout(r, 120));
    }

    vodAnalysisRunning = false;

    // Finalize
    const result = await sendToSW({ type: 'VOD_ANALYSIS_COMPLETE' });
    const sessionId = result?.sessionId || null;
    chrome.storage.session.set({
      vodProgress: { totalProcessed, page, running: false, done: true, sessionId }
    }).catch(() => {});
  }

  // Listen for panel requesting VOD analysis start
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'START_VOD_ANALYSIS' && msg.token) {
      runVODAnalysis(msg.token, msg.apiKey, msg.clientVersion).catch(() => {});
    }
    if (msg.type === 'CANCEL_VOD_ANALYSIS') {
      vodAnalysisRunning = false;
    }
  });

  // ─── Initialization ───────────────────────────────────────────────────────

  function init() {
    // Wait for page to settle (YouTube SPA loads content after DOMContentLoaded)
    setTimeout(() => {
      isLiveStream = isCurrentlyLive();
      if (isLiveStream) startSession();
      else detectAndNotifyVOD();
    }, 2000);
  }

  // ─── SPA Navigation Handling ──────────────────────────────────────────────

  function handleNavigationAway() {
    if (sessionStarted) endSession();
    isLiveStream = false;
  }

  function handleNavigationTo() {
    // Re-check after new page loads
    setTimeout(() => {
      isLiveStream = isCurrentlyLive();
      if (isLiveStream && !sessionStarted) startSession();
      else if (!isLiveStream) detectAndNotifyVOD();
    }, 2500);
  }

  // YouTube fires this custom event on SPA navigation
  document.addEventListener('yt-navigate-start', () => {
    handleNavigationAway();
  });

  document.addEventListener('yt-navigate-finish', () => {
    handleNavigationTo();
  });

  // Fallback: watch title element for URL changes
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        if (!location.search.includes('v=')) {
          handleNavigationAway();
        }
      }
    }).observe(titleEl, { subtree: true, characterData: true, childList: true });
  }

  // ─── Start ────────────────────────────────────────────────────────────────

  startHeartbeat();
  init();

})();
