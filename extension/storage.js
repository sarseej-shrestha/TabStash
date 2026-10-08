export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_SESSION_BYTES = 100 * 1024 * 1024;
const DB_NAME = 'upload-session';
const STORES = ['sessions', 'files', 'keptFiles', 'meta'];

export function openDatabase(factory = indexedDB, name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('sessions', { keyPath: 'id' });
      db.createObjectStore('files', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
      db.createObjectStore('keptFiles', { keyPath: 'id' });
      db.createObjectStore('meta');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other Upload Session panels and try again.'));
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function sessionName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > 80) throw new Error('Use a session name of 1–80 characters.');
  return name;
}

function tabId(value) {
  if (!Number.isInteger(value) || value < 0) throw new Error('Select a browser tab first.');
  return value;
}

export function createStorage(db) {
  async function transaction(stores, mode, operation) {
    const tx = db.transaction(stores, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error ?? new Error('Storage operation cancelled.'));
      tx.onerror = () => {}; // onabort reports the final error.
    });
    const table = name => tx.objectStore(name);
    try {
      const result = await operation(table);
      await done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* Already completed or aborted. */ }
      await done.catch(() => {});
      throw error;
    }
  }

  async function requireSession(table, id) {
    const session = await requestValue(table('sessions').get(id));
    if (!session) throw new Error('This session has ended. Create or select another session.');
    return session;
  }

  async function removeSession(table, id) {
    const keys = await requestValue(table('files').index('sessionId').getAllKeys(id));
    keys.forEach(key => table('files').delete(key));
    table('sessions').delete(id);
  }

  return {
    async snapshot() {
      return transaction(['sessions', 'files', 'keptFiles'], 'readonly', async table => {
        const [sessions, files, kept] = await Promise.all(['sessions', 'files', 'keptFiles'].map(name => requestValue(table(name).getAll())));
        const metadata = ({ blob, ...file }) => ({ ...file, size: blob.size, type: blob.type });
        return { sessions, files: files.map(metadata), kept: kept.map(metadata) };
      });
    },
    async createSession(name, initialTab) {
      const session = { id: crypto.randomUUID(), name: sessionName(name), tabs: [tabId(initialTab)], createdAt: Date.now() };
      return transaction(['sessions'], 'readwrite', async table => {
        const sessions = await requestValue(table('sessions').getAll());
        if (sessions.some(item => item.tabs.includes(initialTab))) throw new Error('This tab is already linked to a session. Switch to that session or use another tab.');
        table('sessions').add(session);
        return session;
      });
    },
    async renameSession(id, name) {
      name = sessionName(name);
      return transaction(['sessions'], 'readwrite', async table => {
        const session = await requireSession(table, id);
        table('sessions').put({ ...session, name });
      });
    },
    async linkTab(id, value) {
      tabId(value);
      return transaction(['sessions'], 'readwrite', async table => {
        const session = await requireSession(table, id);
        const sessions = await requestValue(table('sessions').getAll());
        if (sessions.some(item => item.id !== id && item.tabs.includes(value))) throw new Error('This tab belongs to another session. Use that session or another tab.');
        table('sessions').put({ ...session, tabs: [...new Set([...session.tabs, value])] });
      });
    },
    async endSession(id) {
      return transaction(['sessions', 'files'], 'readwrite', table => removeSession(table, id));
    },
    async closeTab(value) {
      return transaction(['sessions', 'files'], 'readwrite', async table => {
        const sessions = await requestValue(table('sessions').getAll());
        for (const session of sessions) {
          if (!session.tabs.includes(value)) continue;
          const tabs = session.tabs.filter(id => id !== value);
          if (tabs.length) table('sessions').put({ ...session, tabs });
          else await removeSession(table, session.id);
        }
      });
    },
    async replaceTab(removed, added) {
      tabId(added);
      return transaction(['sessions'], 'readwrite', async table => {
        for (const session of await requestValue(table('sessions').getAll())) {
          if (session.tabs.includes(removed)) table('sessions').put({ ...session, tabs: [...new Set(session.tabs.map(id => id === removed ? added : id))] });
        }
      });
    },
    async reconcileTabs(liveIds) {
      const live = new Set(liveIds);
      return transaction(['sessions', 'files'], 'readwrite', async table => {
        for (const session of await requestValue(table('sessions').getAll())) {
          const tabs = session.tabs.filter(id => live.has(id));
          if (!tabs.length) await removeSession(table, session.id);
          else table('sessions').put({ ...session, tabs });
        }
      });
    },
    async clearTemporary() {
      return transaction(['sessions', 'files', 'meta'], 'readwrite', async table => {
        table('sessions').clear(); table('files').clear(); table('meta').clear();
      });
    },
    async addFile(sessionId, blob, name, lastModified = Date.now()) {
      if (!(blob instanceof Blob) || blob.size > MAX_FILE_BYTES) throw new Error('Choose a file no larger than 20 MiB.');
      if (typeof name !== 'string' || !name.trim()) throw new Error('The file needs a name.');
      const file = { id: crypto.randomUUID(), sessionId, name: name.slice(0,255), blob, lastModified, createdAt: Date.now() };
      return transaction(['sessions', 'files'], 'readwrite', async table => {
        await requireSession(table, sessionId);
        const files = await requestValue(table('files').index('sessionId').getAll(sessionId));
        if (files.reduce((sum, file) => sum + file.blob.size, 0) + blob.size > MAX_SESSION_BYTES) throw new Error('This session is full (100 MiB). Remove or keep a file first.');
        table('files').add(file);
        return file.id;
      });
    },
    async keepFile(id) {
      return transaction(['files', 'keptFiles'], 'readwrite', async table => {
        const file = await requestValue(table('files').get(id));
        if (!file) throw new Error('This temporary file no longer exists.');
        const { sessionId, ...kept } = file;
        table('keptFiles').put({ ...kept, keptAt: Date.now() });
        table('files').delete(id);
      });
    },
    async getFile(id, kept = false) {
      const store = kept ? 'keptFiles' : 'files';
      return transaction([store], 'readonly', table => requestValue(table(store).get(id)));
    },
    async deleteFile(id, kept = false) {
      const store = kept ? 'keptFiles' : 'files';
      return transaction([store], 'readwrite', async table => { table(store).delete(id); });
    },
    async setMeta(key, value) {
      return transaction(['meta'], 'readwrite', async table => { table('meta').put(value, key); });
    },
    async getMeta(key) {
      return transaction(['meta'], 'readonly', table => requestValue(table('meta').get(key)));
    },
    async deleteMeta(key) {
      return transaction(['meta'], 'readwrite', async table => { table('meta').delete(key); });
    },
  };
}
