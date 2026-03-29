/**
 * YouTube Sentiment Monitor — Service Worker
 * Receives chat events, runs sentiment analysis, manages sessions,
 * persists data to IndexedDB, and keeps state in chrome.storage.session.
 */

importScripts('../lib/storage.js');

// ─── Lexicon (loaded once) ────────────────────────────────────────────────

let LEXICON = null;

async function getLexicon() {
  if (LEXICON) return LEXICON;
  const url = chrome.runtime.getURL('lib/sentiment-lexicon.json');
  const res = await fetch(url);
  LEXICON = await res.json();
  return LEXICON;
}

// ─── In-Memory State ──────────────────────────────────────────────────────

const state = {
  activeSession: null,
  messageWindow: [],      // ring buffer: messages from last 60s, max 500
  tickBuffer: [],         // last 200 ticks for timeline display
  currentViewerCount: 0,
  avgChatRate: 0,         // exponential moving average
  sessionWordFreq: {},    // word → count for full session
  tickIndex: 0,
  tickTimer: null
};

// ─── Keep-Alive ───────────────────────────────────────────────────────────
// Chrome alarms have a minimum period of 1 minute in packaged extensions.
// We use chrome.alarms only as a belt-and-suspenders backup.
// The actual keep-alive comes from:
//   1. Content script PING messages every 20s
//   2. Regular CHAT_BATCH messages while stream is active
// The tick engine uses setInterval started when a session begins.

chrome.alarms.create('keep-alive', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'keep-alive') return;

  // SW may have been terminated and just woke up via alarm.
  // Restore state if needed, then ensure the tick timer is running.
  if (!state.activeSession) {
    await restoreState();
  }

  if (state.activeSession) {
    // Process a catch-up tick for any gap while SW was hibernated
    await processTick();

    // Restart the setInterval if it was lost when SW was killed
    if (!state.tickTimer) {
      state.tickTimer = setInterval(processTick, 5000);
    }
  }
});

// ─── State Persistence ────────────────────────────────────────────────────

function persistState() {
  // Persist top-200 words so keywords survive SW restarts (tab switching)
  const topWords = Object.entries(state.sessionWordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200);

  const snapshot = {
    activeSession: state.activeSession,
    tickBuffer: state.tickBuffer.slice(-200),
    currentViewerCount: state.currentViewerCount,
    avgChatRate: state.avgChatRate,
    tickIndex: state.tickIndex,
    sessionWordFreq: Object.fromEntries(topWords),
    lastTickAt: Date.now()
  };
  chrome.storage.session.set({ liveState: JSON.stringify(snapshot) }).catch(() => {});
}

async function restoreState() {
  return new Promise(resolve => {
    chrome.storage.session.get('liveState', ({ liveState }) => {
      if (liveState) {
        try {
          const snap = JSON.parse(liveState);
          // Restore word frequency map properly
          if (snap.sessionWordFreq) {
            state.sessionWordFreq = snap.sessionWordFreq;
            delete snap.sessionWordFreq;
          }
          Object.assign(state, snap);
        } catch (_) {}
      }
      resolve();
    });
  });
}

// ─── Sentiment Analysis ───────────────────────────────────────────────────

function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics for lookup
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return normalizeText(text).split(' ').filter(t => t.length > 0);
}

// Emojis que indicam riso genuíno
const LAUGH_EMOJIS = new Set(['😂','🤣','😹','😆','😁']);
// Emojis usados sarcasticamente quando o contexto é negativo
const MOCKERY_EMOJIS = new Set(['🏆','🥇','🎖','👑','🤡','🎪','🤦','🤦‍♂️','🤦‍♀️']);

function detectIrony(text, score, emojis) {
  const hasLaughter = /k{3,}|rs{2,}|haha{2,}|kkkkk/i.test(text);
  const isNegative  = score < -0.12;

  // Regra 1 — riso + conteúdo negativo = zombaria / schadenfreude
  if (hasLaughter && isNegative) return true;

  // Regra 2 — emoji de troféu/palhaço em mensagem negativa = prêmio irônico
  if (isNegative && emojis.some(e => MOCKERY_EMOJIS.has(e))) return true;

  // Regra 3 — emoji de gargalhada contradiz texto fortemente negativo
  if (score < -0.35 && emojis.some(e => LAUGH_EMOJIS.has(e))) return true;

  // Regra 4 — expressões sarcásticas em PT
  const lower = text.toLowerCase();
  if (/que surpresa[!.]?$|uau que novidade|que novidade[!.]?$|imagina s[oó][!.]?$|parab[eé]ns.{0,20}(ladr|crim|golp|mentir)|certeza n[eé][!.]?$/.test(lower)) return true;

  return false;
}

function scoreLaughter(text) {
  // Só adiciona bônus de riso se não for ironia (o detectIrony trata isso separado)
  let bonus = 0;
  if (/k{3,}/i.test(text)) bonus += 1.5;
  if (/ha{2,}|ah{2,}/i.test(text)) bonus += 1;
  if (/rs{2,}/i.test(text)) bonus += 1;
  if (/\blol\b/i.test(text)) bonus += 1;
  return bonus;
}

async function scoreMessage(msg) {
  const lex = await getLexicon();
  const { text = '', emojis = [], type, isMember } = msg;

  if (!text && emojis.length === 0) return 0;

  // Weight by message type
  const weight =
    type === 'super_chat'  ? 10 :
    type === 'membership'  ? 5  :
    isMember               ? 2  : 1;

  // Caps factor
  const upperRatio = (text.match(/[A-ZÁÉÍÓÚÃÕ]/g) || []).length / Math.max(1, text.replace(/\s/g, '').length);
  const capsFactor = upperRatio > 0.6 ? 1.4 : 1.0;

  // Score tokens
  const tokens = tokenize(text);
  let rawScore = 0;
  let matched = 0;

  for (const token of tokens) {
    // Check both normalized (no accent) and original
    const scoreEn = lex.en?.[token] ?? 0;
    const scorePt = lex.pt?.[token] ?? 0;
    const s = scoreEn || scorePt;
    if (s !== 0) {
      rawScore += s;
      matched++;
    }

    // Track word frequency for keywords display
    if (token.length > 2 && !STOP_WORDS.has(token)) {
      state.sessionWordFreq[token] = (state.sessionWordFreq[token] || 0) + 1;
    }
  }

  // Score emojis
  for (const emoji of emojis) {
    const s = lex.emoji?.[emoji] ?? 0;
    rawScore += s;
    if (s !== 0) matched++;
  }

  // Normalize by token count (before irony check)
  const normalizedScore = rawScore * capsFactor / Math.max(1, tokens.length);
  let score = Math.max(-1, Math.min(1, normalizedScore / 4));

  // Irony detection — must happen BEFORE laughter bonus
  const isIronic = detectIrony(text, score, emojis);

  if (isIronic) {
    // O riso neutraliza grande parte do sentimento negativo.
    // A pessoa está *se divertindo* com a crítica, não genuinamente furiosa.
    score = score * 0.18;
  } else {
    // Só aplica bônus de riso em mensagens não-irônicas
    const laughBonus = scoreLaughter(text);
    score = Math.max(-1, Math.min(1, (score * 4 + laughBonus) / 4));
  }

  return { score, weight, isIronic };
}

const STOP_WORDS = new Set([
  // Português — artigos, preposições, pronomes, verbos auxiliares comuns
  'de', 'da', 'do', 'das', 'dos', 'em', 'que', 'e', 'o', 'a', 'os', 'as',
  'um', 'uma', 'uns', 'umas', 'para', 'com', 'por', 'se', 'na', 'no', 'ao',
  'aos', 'te', 'me', 'ne', 'nao', 'nao', 'ja', 'mas', 'ou', 'ate', 'ate',
  'so', 'pra', 'pro', 'pelos', 'pelas', 'pelo', 'pela', 'sobre', 'entre',
  'desde', 'durante', 'segundo', 'conforme', 'porque', 'pois', 'quando',
  'como', 'onde', 'quem', 'qual', 'quais', 'quanto', 'essa', 'esse', 'esses',
  'essas', 'esta', 'este', 'estes', 'estas', 'aquela', 'aquele', 'aqueles',
  'aquelas', 'aqui', 'ali', 'la', 'la', 'la', 'aqui', 'aquela',
  'ele', 'ela', 'eles', 'elas', 'eu', 'tu', 'nos', 'vos', 'voce', 'vocês',
  'isso', 'isto', 'aquilo', 'tudo', 'nada', 'algo', 'alguem',
  'tem', 'ter', 'ser', 'estar', 'foi', 'era', 'vai', 'ia', 'faz', 'fazer',
  'está', 'esta', 'estou', 'sou', 'sao', 'são', 'sao', 'somos', 'tenho',
  'tem', 'temos', 'vai', 'vao', 'vou', 'vamos', 'veio', 'vem', 'ver',
  'mais', 'menos', 'muito', 'pouco', 'bem', 'mal', 'sim', 'nao', 'não',
  'talvez', 'tambem', 'também', 'assim', 'então', 'entao', 'logo', 'porém',
  'porem', 'todavia', 'contudo', 'entretanto', 'ainda', 'ja', 'já',
  'agora', 'depois', 'antes', 'hoje', 'ontem', 'amanha', 'sempre', 'nunca',
  'aqui', 'la', 'aquela', 'acaba', 'acabou',
  // Inglês
  'the', 'is', 'are', 'was', 'be', 'to', 'of', 'in', 'and', 'it', 'at',
  'but', 'or', 'an', 'my', 'we', 'he', 'she', 'they', 'you', 'i', 'this',
  'that', 'have', 'has', 'had', 'do', 'did', 'will', 'would', 'can', 'could',
  'should', 'may', 'might', 'shall', 'must', 'from', 'with', 'for', 'not',
  'on', 'by', 'as', 'up', 'out', 'if', 'all', 'so', 'no', 'our', 'their',
  'its', 'been', 'being', 'into', 'just', 'than', 'then', 'there',
  // Termos neutros de contexto (frequentes mas não revelam sentimento)
  'aula', 'live', 'link', 'chat', 'video', 'vídeo', 'canal', 'turma',
  'curso', 'produto', 'modulo', 'módulo', 'aulas', 'acesso', 'plataforma',
  'conteudo', 'conteúdo', 'inscricao', 'inscrição', 'carrinho', 'pagamento',
  'mes', 'mês', 'ano', 'dias', 'horas', 'semana', 'hoje', 'amanha', 'amanhã',
  'semestre', 'turma', 'grupo', 'telegram', 'whatsapp', 'discord',
  'professor', 'professora', 'mentor', 'mentora',
  'aqui', 'la', 'ali', 'isso', 'essa', 'esse', 'esta', 'este'
]);

// ─── Emotion Dimensions ───────────────────────────────────────────────────
// 10-dimension model: tokens already in normalizeText form (no accents, lowercase)

const EMOTION_TRIGGERS = {
  alegria:     ['kkk', 'rsrs', 'haha', 'hauahau', 'kkkk', 'kkkkk', 'lol', 'feliz', 'alegre', 'top', 'show', 'incrivel', 'otimo', 'demais', 'animado', 'empolgado', 'gol', 'venceu', 'ganhou', 'parabens', 'comemorando', 'euforia', 'amazing', 'great', 'awesome', 'yay'],
  amor:        ['amo', 'amei', 'amor', 'adorei', 'adoro', 'carinho', 'saudade', 'fofo', 'obrigado', 'obrigada', 'gratidao', 'grato', 'grata', 'love', 'adore', 'grateful', 'thank', 'thanks', 'querido', 'querida'],
  surpresa:    ['nossa', 'caramba', 'eita', 'serio', 'mentira', 'impossivel', 'inacreditavel', 'chocado', 'chocante', 'uau', 'wow', 'omg', 'unbelievable', 'incredible', 'shocking', 'nao acredito'],
  raiva:       ['raiva', 'odio', 'odeio', 'lixo', 'idiota', 'burro', 'ridiculo', 'absurdo', 'vergonha', 'revolta', 'indignado', 'revoltado', 'golpe', 'ladrao', 'corrupto', 'mentiroso', 'fraude', 'hate', 'stupid', 'horrible', 'awful', 'furious', 'outrage', 'nojento'],
  tristeza:    ['triste', 'tristeza', 'choro', 'chorei', 'decepcao', 'decepcionado', 'desapontado', 'perda', 'perdeu', 'fracasso', 'pior', 'que pena', 'infelizmente', 'sad', 'cry', 'loss', 'disappointed', 'miss', 'heartbroken', 'unfortunately'],
  medo:        ['medo', 'assustado', 'preocupado', 'preocupacao', 'ansioso', 'ansiedade', 'nervoso', 'tenso', 'tensao', 'incerto', 'risco', 'perigoso', 'fear', 'scared', 'worried', 'nervous', 'anxious', 'uncertain', 'danger'],
  nojo:        ['nojo', 'nojento', 'repugnante', 'horrivel', 'grotesco', 'podre', 'asqueroso', 'disgusting', 'gross', 'nasty', 'repulsive', 'revolting'],
  tedio:       ['entediado', 'tedio', 'chato', 'monotono', 'sem graca', 'cansativo', 'sonolento', 'sono', 'meh', 'boring', 'bored', 'dull', 'sleepy', 'whatever', 'indiferente'],
  curiosidade: ['curioso', 'interessante', 'conta mais', 'me explica', 'pergunta', 'como assim', 'quero saber', 'duvida', 'curious', 'interesting', 'wonder', 'explain', 'how does', 'tell me'],
  confianca:   ['confianca', 'confio', 'certeza', 'recomendo', 'aprovado', 'funciona', 'verdade', 'honesto', 'transparente', 'solido', 'trust', 'confident', 'reliable', 'recommend', 'honest', 'believe', 'proven']
};

const EMOTION_EMOJIS = {
  alegria:     new Set(['😂','🤣','😄','😁','🎉','🎊','🥳','🔥','👏','🙌','😆','⚽','🏆','🎵','🎶','😝']),
  amor:        new Set(['❤️','🥰','😍','💕','💖','💗','💓','🙏','😘','💝','🫶','💞']),
  surpresa:    new Set(['😮','😯','😲','🤯','😱','👀','🫣','😳','🫨']),
  raiva:       new Set(['😡','🤬','💢','😠','👎','💀','🤡','🖕']),
  tristeza:    new Set(['😢','😭','💔','😔','😞','🥺','😿','😓']),
  medo:        new Set(['😨','😰','😱','😟','😬','😓','🫣']),
  nojo:        new Set(['🤢','🤮','😖','🤐','😷','🤧']),
  tedio:       new Set(['😴','🥱','😑','😐','🙄','😒','💤']),
  curiosidade: new Set(['🤔','🧐','❓','💡','🔍','👁️','🫤']),
  confianca:   new Set(['💪','✅','👍','🤝','⭐','🌟','🏅','🫡'])
};

function computeEmotionScores(messages) {
  const counts = { alegria: 0, amor: 0, surpresa: 0, raiva: 0, tristeza: 0, medo: 0, nojo: 0, tedio: 0, curiosidade: 0, confianca: 0 };
  if (messages.length === 0) return counts;

  for (const msg of messages) {
    const norm = normalizeText(msg.text || '');
    const emojiSet = new Set(msg.emojis || []);
    for (const emotion of Object.keys(counts)) {
      let hit = false;
      for (const trigger of EMOTION_TRIGGERS[emotion]) {
        if (norm.includes(trigger)) { hit = true; break; }
      }
      if (!hit) {
        for (const e of EMOTION_EMOJIS[emotion]) {
          if (emojiSet.has(e)) { hit = true; break; }
        }
      }
      if (hit) counts[emotion]++;
    }
  }

  // Express as percentage of messages showing each emotion
  const total = messages.length;
  const result = {};
  for (const [k, v] of Object.entries(counts)) {
    result[k] = parseFloat((v / total * 100).toFixed(1));
  }
  return result;
}

// ─── Tick Engine ──────────────────────────────────────────────────────────

async function processTick() {
  if (!state.activeSession) return;

  const now = Date.now();
  const windowStart = now - 30_000; // 30-second sliding window

  // Prune old messages from window
  state.messageWindow = state.messageWindow.filter(m => m.ts > now - 60_000);
  const windowMessages = state.messageWindow.filter(m => m.ts > windowStart);

  // Compute window score
  let totalWeight = 0;
  let weightedSum = 0;
  let superChatCount = 0;
  let membershipCount = 0;

  for (const m of windowMessages) {
    totalWeight += m.weight;
    weightedSum += m.score * m.weight;
    if (m.type === 'super_chat') superChatCount++;
    if (m.type === 'membership') membershipCount++;
  }

  const windowScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const chatRate = Math.round(windowMessages.length * (60 / 30)); // msgs/min

  // Update avg chat rate (exponential moving average, α=0.3)
  state.avgChatRate = state.avgChatRate * 0.7 + chatRate * 0.3;

  const isPeak = state.avgChatRate > 5 && chatRate > state.avgChatRate * 2;

  // If this is a peak, compute keywords specific to THIS window (not session-wide)
  // so the peak summary reflects what was being discussed at that moment
  let peakKeywords = null;
  if (isPeak) {
    const wf = {};
    for (const m of windowMessages) {
      for (const token of tokenize(m.text || '')) {
        if (token.length > 2 && !STOP_WORDS.has(token)) {
          wf[token] = (wf[token] || 0) + 1;
        }
      }
    }
    peakKeywords = Object.entries(wf).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
  }

  // Irony ratio in this window
  const ironicCount = windowMessages.filter(m => m.isIronic).length;
  const ironicRatio = windowMessages.length > 0 ? ironicCount / windowMessages.length : 0;

  // Classify label
  const label = classifyLabel(windowScore, chatRate, state.avgChatRate, ironicRatio);

  // Emotion breakdown for radar chart
  const emotionScores = computeEmotionScores(windowMessages);

  // Top keywords (session-wide top 8, filtered by stop words)
  const topKeywords = Object.entries(state.sessionWordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);

  const tickIndex = state.tickIndex++;
  const eventId = `${state.activeSession.id}_${String(tickIndex).padStart(6, '0')}`;

  const event = {
    id: eventId,
    sessionId: state.activeSession.id,
    tickIndex,
    timestamp: now,
    windowScore: parseFloat(windowScore.toFixed(4)),
    windowLabel: label,
    viewerCount: state.currentViewerCount,
    chatRate,
    superChatCount,
    membershipCount,
    topKeywords,
    isPeak,
    peakKeywords,
    ironicRatio: parseFloat(ironicRatio.toFixed(3)),
    emotionScores
  };

  // Update session peak viewers
  if (state.currentViewerCount > (state.activeSession.peakViewers || 0)) {
    state.activeSession.peakViewers = state.currentViewerCount;
    await storage.upsertSession(state.activeSession);
  }

  // Append tick to timeline buffer (max 200)
  state.tickBuffer.push(event);
  if (state.tickBuffer.length > 200) state.tickBuffer.shift();

  // Persist to IndexedDB
  await storage.appendEvent(event);

  // Persist state snapshot for panel
  persistState();
}

function classifyLabel(score, chatRate, avgRate, ironicRatio = 0) {
  // Mais de 35% das mensagens na janela são irônicas → humor dominante é zombaria
  if (ironicRatio > 0.35) return 'ironico';
  const isHigh = chatRate > avgRate * 1.8 && avgRate > 5;
  if (score > 0.45 && isHigh) return 'excited';
  if (score > 0.25) return 'positive';
  if (score < -0.35 && isHigh) return 'angry';
  if (score < -0.2) return 'negative';
  return 'neutral';
}

// ─── Session Management ───────────────────────────────────────────────────

async function startSession({ videoId, videoTitle, channelName, ts }) {
  if (state.activeSession) await endSession({ videoId, ts: ts - 1 });

  const sessionId = `${videoId}_${ts}`;
  const session = {
    id: sessionId,
    videoId,
    videoTitle: videoTitle || 'Unknown Stream',
    channelName: channelName || '',
    startedAt: ts,
    endedAt: null,
    peakViewers: 0,
    totalMessages: 0,
    totalSuperChats: 0
  };

  state.activeSession = session;
  state.messageWindow = [];
  state.tickBuffer = [];
  state.currentViewerCount = 0;
  state.avgChatRate = 0;
  state.sessionWordFreq = {};
  state.tickIndex = 0;

  await storage.upsertSession(session);

  // Start 5-second tick timer using setInterval.
  // SW stays alive due to content script heartbeats + chat message traffic.
  if (state.tickTimer) clearInterval(state.tickTimer);
  state.tickTimer = setInterval(processTick, 5000);

  persistState();
}

async function endSession({ ts }) {
  if (!state.activeSession) return;

  state.activeSession.endedAt = ts || Date.now();
  await storage.upsertSession(state.activeSession);

  state.activeSession = null;
  state.messageWindow = [];
  state.tickBuffer = [];

  if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
  persistState();
}

// ─── Message Processing ───────────────────────────────────────────────────

async function processChatMessages(messages) {
  if (!state.activeSession) return;

  for (const msg of messages) {
    const result = await scoreMessage(msg);
    if (!result) continue;

    const { score, weight, isIronic } = result;

    state.messageWindow.push({
      ...msg,
      score,
      weight,
      isIronic: !!isIronic
    });

    // Cap ring buffer
    if (state.messageWindow.length > 500) state.messageWindow.shift();

    // Update session totals
    state.activeSession.totalMessages++;
    if (msg.type === 'super_chat') state.activeSession.totalSuperChats++;
  }
}

// ─── Report Generation ────────────────────────────────────────────────────

async function generateReport(sessionId) {
  const [session, events] = await Promise.all([
    storage.getSession(sessionId),
    storage.getSessionEvents(sessionId)
  ]);

  if (!session || events.length === 0) {
    return '<p>Sem dados suficientes para gerar relatório.</p>';
  }

  const dur = session.endedAt
    ? Math.round((session.endedAt - session.startedAt) / 60000)
    : Math.round((Date.now() - session.startedAt) / 60000);

  const avgScore = events.reduce((s, e) => s + e.windowScore, 0) / events.length;
  const maxScore = Math.max(...events.map(e => e.windowScore));
  const minScore = Math.min(...events.map(e => e.windowScore));
  const peaks = events.filter(e => e.isPeak);
  const maxChatRate = Math.max(...events.map(e => e.chatRate));

  // Label distribution
  const labelCounts = {};
  events.forEach(e => { labelCounts[e.windowLabel] = (labelCounts[e.windowLabel] || 0) + 1; });
  const dominant = Object.entries(labelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral';

  // Top keywords
  const wordFreq = {};
  events.forEach(e => (e.topKeywords || []).forEach(k => { wordFreq[k] = (wordFreq[k] || 0) + 1; }));
  const topWords = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 15);

  // Build SVG sparkline for timeline
  const sparkline = buildSparklineSVG(events);

  const MOOD_COLORS = {
    excited: '#f59e0b', positive: '#22c55e', neutral: '#71717a',
    negative: '#f97316', angry: '#ef4444'
  };
  const MOOD_PT = {
    excited: 'Animado', positive: 'Positivo', neutral: 'Neutro',
    negative: 'Negativo', angry: 'Irritado/Bravo'
  };
  const moodColor = MOOD_COLORS[dominant] || '#71717a';
  const moodLabel = MOOD_PT[dominant] || dominant;

  const formatDate = ts => new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  const formatScore = s => (s >= 0 ? '+' : '') + s.toFixed(3);

  const peaksHtml = peaks.slice(0, 10).map(p => `
    <tr>
      <td>${new Date(p.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
      <td style="color:${MOOD_COLORS[p.windowLabel] || '#71717a'}">${MOOD_PT[p.windowLabel] || p.windowLabel}</td>
      <td>${formatScore(p.windowScore)}</td>
      <td>${p.chatRate} /min</td>
    </tr>`).join('');

  const labelDistHtml = Object.entries(labelCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => {
      const pct = Math.round((count / events.length) * 100);
      return `
        <div class="dist-row">
          <span class="dist-label" style="color:${MOOD_COLORS[label] || '#71717a'}">${MOOD_PT[label] || label}</span>
          <div class="dist-bar-wrap">
            <div class="dist-bar" style="width:${pct}%; background:${MOOD_COLORS[label] || '#71717a'}"></div>
          </div>
          <span class="dist-pct">${pct}%</span>
        </div>`;
    }).join('');

  const keywordsHtml = topWords.map(([word, count], i) => {
    const size = i < 3 ? 18 : i < 6 ? 15 : 12;
    return `<span class="kw-chip" style="font-size:${size}px">${escHtml(word)} <small>(${count})</small></span>`;
  }).join('');

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Relatório de Sentimento — ${escHtml(session.videoTitle)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e4e4e7; padding: 32px; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
  h2 { font-size: 13px; font-weight: 600; letter-spacing: 0.07em; color: #71717a; text-transform: uppercase; margin-bottom: 14px; }
  .subtitle { color: #71717a; font-size: 13px; margin-bottom: 28px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 28px; }
  .card { background: #141414; border: 1px solid #2a2a2a; border-radius: 10px; padding: 16px; }
  .card-value { font-size: 26px; font-weight: 700; margin-bottom: 2px; }
  .card-label { font-size: 11px; color: #71717a; text-transform: uppercase; letter-spacing: 0.07em; }
  .section { background: #141414; border: 1px solid #2a2a2a; border-radius: 10px; padding: 20px; margin-bottom: 20px; }
  .sparkline-wrap { background: #0a0a0a; border-radius: 6px; padding: 10px 0; margin-top: 10px; overflow: hidden; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 11px; color: #71717a; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; padding: 0 8px 8px 0; border-bottom: 1px solid #2a2a2a; }
  td { padding: 8px 8px 8px 0; border-bottom: 1px solid #1c1c1e; color: #d4d4d8; }
  tr:last-child td { border-bottom: none; }
  .dist-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .dist-label { min-width: 90px; font-size: 12px; font-weight: 600; }
  .dist-bar-wrap { flex: 1; height: 8px; background: #1c1c1e; border-radius: 4px; overflow: hidden; }
  .dist-bar { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .dist-pct { min-width: 35px; text-align: right; font-size: 11px; color: #71717a; }
  .kw-list { display: flex; flex-wrap: wrap; gap: 8px; }
  .kw-chip { background: #1c1c1e; border: 1px solid #2a2a2a; border-radius: 6px; padding: 5px 11px; color: #d4d4d8; }
  .kw-chip small { color: #71717a; font-size: 10px; }
  .mood-badge { display: inline-block; padding: 4px 14px; border-radius: 20px; font-size: 13px; font-weight: 700; letter-spacing: 0.05em; }
  footer { margin-top: 32px; text-align: center; font-size: 11px; color: #3f3f46; }
</style>
</head>
<body>

<h1>${escHtml(session.videoTitle)}</h1>
<p class="subtitle">
  ${escHtml(session.channelName)} &nbsp;•&nbsp;
  ${formatDate(session.startedAt)}
  ${session.endedAt ? ' → ' + formatDate(session.endedAt) : ' (ao vivo)'}
</p>

<div class="grid">
  <div class="card">
    <div class="card-value" style="color:${moodColor}">${moodLabel}</div>
    <div class="card-label">Humor dominante</div>
  </div>
  <div class="card">
    <div class="card-value">${formatScore(avgScore)}</div>
    <div class="card-label">Score médio</div>
  </div>
  <div class="card">
    <div class="card-value">${dur} min</div>
    <div class="card-label">Duração</div>
  </div>
  <div class="card">
    <div class="card-value">${(session.totalMessages || 0).toLocaleString('pt-BR')}</div>
    <div class="card-label">Mensagens</div>
  </div>
  <div class="card">
    <div class="card-value">${(session.peakViewers || 0).toLocaleString('pt-BR')}</div>
    <div class="card-label">Pico de espectadores</div>
  </div>
  <div class="card">
    <div class="card-value">${peaks.length}</div>
    <div class="card-label">Picos de engajamento</div>
  </div>
  <div class="card">
    <div class="card-value">${formatScore(maxScore)}</div>
    <div class="card-label">Score máximo</div>
  </div>
  <div class="card">
    <div class="card-value">${formatScore(minScore)}</div>
    <div class="card-label">Score mínimo</div>
  </div>
</div>

<div class="section">
  <h2>Linha do Tempo — Sentimento</h2>
  <div class="sparkline-wrap">${sparkline}</div>
</div>

<div class="section">
  <h2>Distribuição de Humor</h2>
  ${labelDistHtml}
</div>

${peaks.length > 0 ? `
<div class="section">
  <h2>Momentos de Pico (${peaks.length} detectados)</h2>
  <table>
    <thead><tr><th>Horário</th><th>Humor</th><th>Score</th><th>Chat Rate</th></tr></thead>
    <tbody>${peaksHtml}</tbody>
  </table>
</div>` : ''}

<div class="section">
  <h2>Palavras Mais Mencionadas</h2>
  <div class="kw-list">${keywordsHtml}</div>
</div>

<footer>Gerado por YouTube Sentiment Monitor em ${new Date().toLocaleString('pt-BR')} &nbsp;•&nbsp; ${events.length} ticks analisados</footer>
</body>
</html>`;
}

function buildSparklineSVG(events) {
  const W = 820, H = 80;
  if (events.length < 2) return `<svg width="${W}" height="${H}"><text x="${W/2}" y="${H/2}" fill="#52525b" text-anchor="middle" font-size="12">Dados insuficientes</text></svg>`;

  const scores = events.map(e => e.windowScore);
  const xs = events.map((_, i) => Math.round((i / (events.length - 1)) * W));
  const ys = scores.map(s => Math.round(((1 - s) / 2) * (H - 12) + 6));

  const line = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x},${ys[i]}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;

  // Zero line
  const zeroY = Math.round(H / 2);

  // Peak markers
  const peakMarkers = events
    .filter(e => e.isPeak)
    .map((e, _, arr) => {
      const i = events.indexOf(e);
      return `<circle cx="${xs[i]}" cy="${ys[i]}" r="4" fill="#f59e0b" />`;
    }).join('');

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#22c55e" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="#22c55e" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    <line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="#2a2a2a" stroke-width="1" stroke-dasharray="4 4"/>
    <path d="${area}" fill="url(#sg)"/>
    <path d="${line}" fill="none" stroke="#22c55e" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${peakMarkers}
  </svg>`;
}

// ─── Message Listeners ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type } = message;

  if (type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }

  if (type === 'STREAM_START') {
    startSession(message).then(() => sendResponse({ ok: true }));
    return true; // async
  }

  if (type === 'STREAM_END') {
    endSession(message).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (type === 'CHAT_BATCH') {
    processChatMessages(message.messages || []).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (type === 'CHAT_MESSAGE') {
    processChatMessages([message.message]).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (type === 'VIEWER_COUNT') {
    state.currentViewerCount = message.count || 0;
    sendResponse({ ok: true });
    return false;
  }

  if (type === 'GET_STATE') {
    sendResponse({
      activeSession: state.activeSession,
      tickBuffer: state.tickBuffer,
      currentViewerCount: state.currentViewerCount,
      avgChatRate: state.avgChatRate,
      recentMessages: state.messageWindow.slice(-20).map(m => ({
        text: m.text,
        score: m.score,
        type: m.type,
        ts: m.ts
      }))
    });
    return false;
  }

  if (type === 'GET_SESSIONS') {
    storage.listSessions().then(sessions => sendResponse({ sessions }));
    return true;
  }

  if (type === 'GET_SESSION_EVENTS') {
    storage.getSessionEvents(message.sessionId).then(events => sendResponse({ events }));
    return true;
  }

  if (type === 'DELETE_SESSION') {
    storage.deleteSession(message.sessionId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (type === 'EXPORT') {
    const { sessionId, format } = message;
    const exportFn = format === 'csv'
      ? storage.exportSessionCSV.bind(storage)
      : storage.exportSessionJSON.bind(storage);
    exportFn(sessionId).then(data => sendResponse({ data }));
    return true;
  }

  if (type === 'GENERATE_REPORT') {
    generateReport(message.sessionId).then(html => sendResponse({ html }));
    return true;
  }

  // ── VOD Analysis ──────────────────────────────────────────────────────────

  if (type === 'VOD_ANALYSIS_START') {
    // Content script starts sending batches; create a synthetic session
    const { videoId, videoTitle, channelName, estimatedMessages } = message;
    const sessionId = `vod_${videoId}_${Date.now()}`;
    state.vodSession = {
      id: sessionId,
      videoId,
      videoTitle: videoTitle || `VOD ${videoId}`,
      channelName: channelName || '',
      startedAt: null,      // will be set from first message timestamp
      endedAt: null,
      peakViewers: 0,
      totalMessages: 0,
      totalSuperChats: 0,
      isVOD: true,
      estimatedMessages: estimatedMessages || 0
    };
    state.vodMessages = [];  // all messages for offline tick computation
    sendResponse({ ok: true, sessionId });
    return true;
  }

  if (type === 'VOD_MESSAGES_BATCH') {
    // Accumulate messages; score them in bulk
    if (!state.vodSession) { sendResponse({ ok: false }); return false; }
    const msgs = message.messages || [];
    (async () => {
      const lex = await getLexicon();
      for (const msg of msgs) {
        const result = await scoreMessage(msg);
        if (!result) continue;
        const { score, weight, isIronic } = result;
        state.vodMessages.push({ ...msg, score, weight, isIronic: !!isIronic });
        state.vodSession.totalMessages++;
        if (msg.type === 'super_chat') state.vodSession.totalSuperChats++;
        // Track word frequency
        for (const token of tokenize(msg.text || '')) {
          if (token.length > 2 && !STOP_WORDS.has(token)) {
            state.sessionWordFreq[token] = (state.sessionWordFreq[token] || 0) + 1;
          }
        }
      }
      sendResponse({ ok: true, processed: state.vodMessages.length });
    })();
    return true;
  }

  if (type === 'VOD_ANALYSIS_COMPLETE') {
    if (!state.vodSession || state.vodMessages.length === 0) {
      sendResponse({ ok: false }); return false;
    }
    (async () => {
      // Sort all messages by timestamp
      state.vodMessages.sort((a, b) => a.ts - b.ts);

      const firstTs = state.vodMessages[0].ts;
      const lastTs  = state.vodMessages[state.vodMessages.length - 1].ts;
      state.vodSession.startedAt = firstTs;
      state.vodSession.endedAt   = lastTs;

      await storage.upsertSession(state.vodSession);

      // Build synthetic ticks — group messages into 30s windows every 5s
      const durationMs = lastTs - firstTs;
      const tickIntervalMs = Math.max(5000, Math.round(durationMs / 200)); // max 200 ticks
      const numTicks = Math.ceil(durationMs / tickIntervalMs);
      const ticks = [];

      for (let i = 0; i < numTicks; i++) {
        const windowEnd   = firstTs + (i + 1) * tickIntervalMs;
        const windowStart = windowEnd - 30_000;
        const windowMsgs  = state.vodMessages.filter(m => m.ts >= windowStart && m.ts < windowEnd);
        if (windowMsgs.length === 0) continue;

        let totalWeight = 0, weightedSum = 0, superCount = 0, memberCount = 0;
        let ironicCount = 0;
        for (const m of windowMsgs) {
          totalWeight  += m.weight;
          weightedSum  += m.score * m.weight;
          if (m.type === 'super_chat') superCount++;
          if (m.type === 'membership') memberCount++;
          if (m.isIronic) ironicCount++;
        }
        const windowScore  = totalWeight > 0 ? weightedSum / totalWeight : 0;
        const chatRate     = Math.round(windowMsgs.length * (60000 / Math.min(30_000, tickIntervalMs)));
        const ironicRatio  = windowMsgs.length > 0 ? ironicCount / windowMsgs.length : 0;

        // Running avg for peak detection
        const avgRate = ticks.length > 0
          ? ticks.slice(-10).reduce((s, t) => s + t.chatRate, 0) / Math.min(10, ticks.length)
          : chatRate;

        const label         = classifyLabel(windowScore, chatRate, avgRate, ironicRatio);
        const isPeak        = avgRate > 5 && chatRate > avgRate * 2;
        const emotionScores = computeEmotionScores(windowMsgs);

        let peakKeywords = null;
        if (isPeak) {
          const wf = {};
          for (const m of windowMsgs) {
            for (const token of tokenize(m.text || '')) {
              if (token.length > 2 && !STOP_WORDS.has(token)) {
                wf[token] = (wf[token] || 0) + 1;
              }
            }
          }
          peakKeywords = Object.entries(wf).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
        }

        // Session-wide top keywords snapshot at this tick
        const topKeywords = Object.entries(state.sessionWordFreq)
          .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);

        const tickIndex = ticks.length;
        const event = {
          id: `${state.vodSession.id}_${String(tickIndex).padStart(6, '0')}`,
          sessionId: state.vodSession.id,
          tickIndex,
          timestamp: Math.round(windowEnd),
          windowScore: parseFloat(windowScore.toFixed(4)),
          windowLabel: label,
          viewerCount: 0,
          chatRate,
          superChatCount: superCount,
          membershipCount: memberCount,
          topKeywords,
          isPeak,
          peakKeywords,
          ironicRatio: parseFloat(ironicRatio.toFixed(3)),
          emotionScores
        };
        ticks.push(event);
        await storage.appendEvent(event);
      }

      // Clear vod state
      const sessionId = state.vodSession.id;
      state.vodSession  = null;
      state.vodMessages = [];
      state.sessionWordFreq = {};

      sendResponse({ ok: true, sessionId, ticks: ticks.length });
    })();
    return true;
  }

  return false;
});

// ─── Side Panel Action ────────────────────────────────────────────────────

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ─── Initialization ───────────────────────────────────────────────────────

restoreState().then(async () => {
  await getLexicon(); // warm up lexicon cache
  // Restart tick timer if there was an active session when the SW restarted
  if (state.activeSession) {
    if (state.tickTimer) clearInterval(state.tickTimer);
    state.tickTimer = setInterval(processTick, 5000);
  }
});
