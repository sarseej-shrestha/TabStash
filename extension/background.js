import { openDatabase, createStorage } from './storage.js';
import { initializeLifecycle } from './lifecycle.js';

const ready = (async () => {
  const storage = createStorage(await openDatabase());
  await initializeLifecycle(storage, chrome);
  return storage;
})();

function report(error) { console.error('Upload Session:', error.message); }
function changed() { chrome.runtime.sendMessage({ type: 'changed' }).catch(() => {}); }
async function reconcile(storage) {
  await storage.reconcileTabs((await chrome.tabs.query({})).map(tab => tab.id));
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
    default: throw new Error('Unknown request. Reload Upload Session.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only our panel may operate on files. No externally-connectable surface or content-script bridge.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('panel.html') || message?.type === 'changed') return;
  handle(message).then(value => {
    sendResponse({ ok: true, value });
    if (!['snapshot', 'ready'].includes(message.type)) changed();
  }).catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
