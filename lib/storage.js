/**
 * YouTube Sentiment Monitor — IndexedDB Storage
 * Provides a Promise-based wrapper around IndexedDB.
 * Can be loaded via importScripts() in the service worker.
 */

const DB_NAME = 'yt-sentiment-v1';
const DB_VERSION = 1;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = self.indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains('sessions')) {
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('startedAt', 'startedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains('events')) {
        const events = db.createObjectStore('events', { keyPath: 'id' });
        events.createIndex('sessionId', 'sessionId', { unique: false });
        events.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };

    req.onsuccess = (e) => {
      _db = e.target.result;
      resolve(_db);
    };

    req.onerror = () => reject(req.error);
  });
}

function tx(storeName, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

const storage = {
  upsertSession(session) {
    return tx('sessions', 'readwrite', store => store.put(session));
  },

  appendEvent(event) {
    return tx('events', 'readwrite', store => store.put(event));
  },

  getSession(id) {
    return tx('sessions', 'readonly', store => store.get(id));
  },

  listSessions() {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction('sessions', 'readonly');
      const store = t.objectStore('sessions');
      const idx = store.index('startedAt');
      const req = idx.getAll();
      req.onsuccess = () => {
        // Sort newest first
        resolve((req.result || []).sort((a, b) => b.startedAt - a.startedAt));
      };
      req.onerror = () => reject(req.error);
    }));
  },

  getSessionEvents(sessionId) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction('events', 'readonly');
      const store = t.objectStore('events');
      const idx = store.index('sessionId');
      const req = idx.getAll(sessionId);
      req.onsuccess = () => {
        resolve((req.result || []).sort((a, b) => a.tickIndex - b.tickIndex));
      };
      req.onerror = () => reject(req.error);
    }));
  },

  deleteSession(id) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(['sessions', 'events'], 'readwrite');
      t.objectStore('sessions').delete(id);

      // Delete all events for this session
      const eventsStore = t.objectStore('events');
      const idx = eventsStore.index('sessionId');
      const req = idx.openCursor(id);
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    }));
  },

  async exportSessionJSON(sessionId) {
    const [session, events] = await Promise.all([
      this.getSession(sessionId),
      this.getSessionEvents(sessionId)
    ]);
    return JSON.stringify({ session, events }, null, 2);
  },

  async exportSessionCSV(sessionId) {
    const events = await this.getSessionEvents(sessionId);
    if (events.length === 0) return 'No data';

    const headers = [
      'tickIndex', 'timestamp', 'windowScore', 'windowLabel',
      'viewerCount', 'chatRate', 'superChatCount', 'membershipCount',
      'isPeak', 'topKeywords'
    ];

    const rows = events.map(e => [
      e.tickIndex,
      new Date(e.timestamp).toISOString(),
      e.windowScore.toFixed(4),
      e.windowLabel,
      e.viewerCount,
      e.chatRate,
      e.superChatCount,
      e.membershipCount,
      e.isPeak ? '1' : '0',
      (e.topKeywords || []).join(' | ')
    ].join(','));

    return [headers.join(','), ...rows].join('\n');
  }
};
