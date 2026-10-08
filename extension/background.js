import { openDatabase, createStorage } from './storage.js';
import { initializeLifecycle } from './lifecycle.js';
import { downloadOrigin, fetchDirectFile } from './download.js';
import { inspectInputs, attachToInput, serializeFile } from './attach.js';

const ready = (async () => {
  const storage = createStorage(await openDatabase());
  await initializeLifecycle(storage, chrome);
  // Recover optional grants left behind by an interrupted download.
  await releaseDownloadAccess();
  return storage;
})();

function report(error) { console.error('Upload Session:', error.message); }
function changed() { chrome.runtime.sendMessage({ type: 'changed' }).catch(() => {}); }
async function reconcile(storage) {
  await storage.reconcileTabs((await chrome.tabs.query({})).map(tab => tab.id));
}

async function releaseDownloadAccess() {
  const { origins = [] } = await chrome.permissions.getAll();
  if (origins.length) await chrome.permissions.remove({ origins }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'save-link', title: 'Add link to Upload Session', contexts: ['link'], targetUrlPatterns: ['http://*/*', 'https://*/*'] });
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'save-link' || !tab?.id) return;
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(report);
  ready.then(async storage => {
    downloadOrigin(info.linkUrl);
    await storage.setMeta(`pending-${tab.windowId}`, { id: crypto.randomUUID(), url: info.linkUrl, tabId: tab.id, createdAt: Date.now() });
    changed();
  }).catch(report);
});

async function requireLinked(storage, sessionId, tabId) {
  const { sessions } = await storage.snapshot();
  if (!sessions.some(session => session.id === sessionId && session.tabs.includes(tabId))) {
    throw new Error('Link this tab to the selected session first.');
  }
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:\/\//.test(tab.url)) throw new Error('Click the Upload Session toolbar icon on a normal HTTP(S) page to grant access, then scan again. Otherwise use the website’s picker.');
}

let downloading = false;
async function download(storage, message) {
  if (downloading) throw new Error('Another download is running. Wait for it to finish.');
  downloading = true;
  let origin;
  try {
    const pending = await storage.getMeta(`pending-${message.windowId}`);
    if (!pending || pending.id !== message.pendingId || Date.now() - pending.createdAt > 10 * 60_000) throw new Error('This link expired or changed. Right-click the link again.');
    origin = downloadOrigin(pending.url);
    if (!await chrome.permissions.contains({ origins: [origin] })) throw new Error('Site access was not granted. Download normally and use Add files.');
    const file = await fetchDirectFile(pending.url);
    await storage.addFile(message.sessionId, file.blob, file.name);
    await storage.deleteMeta(`pending-${message.windowId}`);
    return file.name;
  } finally {
    if (origin) await chrome.permissions.remove({ origins: [origin] }).catch(() => {});
    downloading = false;
  }
}

chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(report);
});
chrome.runtime.onStartup.addListener(() => { ready.then(changed).catch(report); });
chrome.tabs.onRemoved.addListener(id => {
  ready.then(async storage => { await storage.closeTab(id); changed(); }).catch(report);
});
chrome.tabs.onReplaced.addListener((added, removed) => {
  ready.then(async storage => { await storage.replaceTab(removed, added); changed(); }).catch(report);
});

async function handle(message) {
  const storage = await ready;
  switch (message.type) {
    case 'ready': return true;
    case 'snapshot': {
      await reconcile(storage);
      return storage.snapshot();
    }
    case 'create': {
      await chrome.tabs.get(message.tabId);
      const session = await storage.createSession(message.name, message.tabId);
      await reconcile(storage);
      return session;
    }
    case 'rename': return storage.renameSession(message.id, message.name);
    case 'link': {
      await chrome.tabs.get(message.tabId);
      await storage.linkTab(message.id, message.tabId);
      return reconcile(storage);
    }
    case 'end': return storage.endSession(message.id);
    case 'keep': return storage.keepFile(message.id);
    case 'delete-file': return storage.deleteFile(message.id, Boolean(message.kept));
    case 'files-added': return reconcile(storage);
    case 'pending': {
      const pending = await storage.getMeta(`pending-${message.windowId}`);
      if (pending && Date.now() - pending.createdAt > 10 * 60_000) { await storage.deleteMeta(`pending-${message.windowId}`); return null; }
      return pending;
    }
    case 'dismiss-link': return storage.deleteMeta(`pending-${message.windowId}`);
    case 'download': return download(storage, message);
    case 'release-access': return releaseDownloadAccess();
    case 'scan': {
      await requireLinked(storage, message.sessionId, message.tabId);
      const [result] = await chrome.scripting.executeScript({ target: { tabId: message.tabId, frameIds: [0] }, func: inspectInputs });
      return { documentId: result.documentId, fields: result.result };
    }
    case 'attach': {
      await requireLinked(storage, message.sessionId, message.tabId);
      const file = await storage.getFile(message.fileId, Boolean(message.kept));
      if (!file || (!message.kept && file.sessionId !== message.sessionId)) throw new Error('This file is no longer available in this session.');
      if (typeof message.documentId !== 'string' || typeof message.token !== 'string') throw new Error('Scan the page again.');
      const [result] = await chrome.scripting.executeScript({ target: { tabId: message.tabId, documentIds: [message.documentId] },
        func: attachToInput, args: [await serializeFile(file), message.token] });
      if (!result?.result?.name) throw new Error('The page changed or rejected attachment. Scan again or use its normal picker.');
      return result.result;
    }
    default: throw new Error('Unknown request. Reload Upload Session.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only our panel may operate on files. No externally-connectable surface or content-script bridge.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('panel.html') || message?.type === 'changed') return;
  handle(message).then(value => {
    sendResponse({ ok: true, value });
    if (!['snapshot', 'ready', 'pending', 'scan', 'attach'].includes(message.type)) changed();
  }).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
