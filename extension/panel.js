import { openDatabase, createStorage } from './storage.js';
import { downloadOrigin } from './download.js';

const $ = id => document.getElementById(id);
let storage, windowId, currentTab, selectedSession = '', selectedFile = '', pending, scan;
let state = { sessions: [], files: [], kept: [] }, tabs = [], busy = false, revision = 0;

async function send(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...data });
  if (!response?.ok) throw new Error(response?.error || 'The extension restarted. Close and reopen the panel.');
  return response.value;
}

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}
function session() { return state.sessions.find(item => item.id === selectedSession); }
function fileSelection() {
  const [kind, id] = selectedFile.split(':');
  const kept = kind === 'k';
  const file = (kept ? state.kept : state.files.filter(file => file.sessionId === selectedSession)).find(file => file.id === id);
  return file ? { file, kept } : null;
}
function invalidateScan() { scan = null; $('trust-page').checked = false; }
function size(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`; }
function option(value, label) { const el = document.createElement('option'); el.value = value; el.textContent = label; return el; }

async function refresh() {
  const version = ++revision;
  const [nextState, nextTabs, active, nextPending] = await Promise.all([
    send('snapshot'), chrome.tabs.query({}), chrome.tabs.query({ active: true, windowId }), send('pending', { windowId }),
  ]);
  if (version !== revision) return;
  const nextTab = active[0];
  if (currentTab?.id !== nextTab?.id) invalidateScan();
  state = nextState; tabs = nextTabs; currentTab = nextTab; pending = nextPending;
  if (!session()) selectedSession = state.sessions.find(item => item.tabs.includes(currentTab?.id))?.id || state.sessions[0]?.id || '';
  if (!fileSelection()) selectedFile = '';
  render();
}

async function run(operation, success) {
  if (busy) return;
  busy = true; $('controls').disabled = true;
  try {
    await operation();
    await refresh();
    if (success) status(success);
  } catch (error) { status(error.message, true); }
  finally { busy = false; render(); }
}

function action(label, callback, className = '') {
  const button = document.createElement('button');
  button.textContent = label; button.className = className; button.onclick = callback;
  return button;
}

function renderFiles(containerId, files, kept) {
  const container = $(containerId); container.replaceChildren();
  if (!files.length) {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = kept ? 'Keep a file to use it beyond this session.' : 'Add files, or right-click a direct download link.';
    container.append(empty); return;
  }
  for (const file of files) {
    const key = `${kept ? 'k' : 't'}:${file.id}`;
    const card = document.createElement('article'); card.className = `file-card${key === selectedFile ? ' selected' : ''}`;
    const name = document.createElement('p'); name.className = 'file-name'; name.textContent = file.name;
    const meta = document.createElement('p'); meta.className = 'file-meta'; meta.textContent = `${size(file.size)} · ${kept ? 'Kept on this device' : 'Temporary'}`;
    const actions = document.createElement('div'); actions.className = 'file-actions';
    const select = action(key === selectedFile ? 'Selected' : 'Select', () => { selectedFile = key; $('trust-page').checked = false; render(); });
    select.setAttribute('aria-pressed', String(key === selectedFile)); select.setAttribute('aria-label', `Select ${file.name}`);
    actions.append(select, action('Save copy', () => run(async () => {
      const stored = await storage.getFile(file.id, kept);
      if (!stored) throw new Error('This file no longer exists.');
      const url = URL.createObjectURL(stored.blob);
      const link = document.createElement('a'); link.href = url; link.download = stored.name;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'A download copy was requested. Use the website’s normal picker to select it.')));
    if (!kept) actions.append(action('Keep', () => run(async () => {
      await send('keep', { id: file.id });
      if (selectedFile === key) selectedFile = `k:${file.id}`;
    }, 'File moved to Kept files. Session cleanup will leave it there.')));
    actions.append(action('Delete', async () => {
      if (!await ask(`Delete ${file.name}?`, 'This removes the extension’s stored copy. Copies saved to disk or already attached to a page are unaffected.')) return;
      run(() => send('delete-file', { id: file.id, kept }), 'File deleted from local storage.');
    }, 'quiet danger'));
    card.append(name, meta, actions); container.append(card);
  }
}

function render() {
  const selected = session(), linked = selected?.tabs.includes(currentTab?.id);
  $('controls').disabled = busy || !storage;
  $('session-count').textContent = state.sessions.length;
  $('session-select').replaceChildren(...(state.sessions.length ? state.sessions.map(item => option(item.id, item.name)) : [option('', 'No active sessions')]));
  $('session-select').value = selectedSession;
  $('rename').disabled = !selected; $('end').disabled = !selected;
  $('session-area').hidden = !selected;
  $('local-files').disabled = !selected;
  if (selected) {
    $('tab-count').textContent = selected.tabs.length;
    $('current-tab').textContent = linked ? 'Current tab is linked to this session.' : 'Current tab is not linked to this session.';
    $('link-tab').disabled = linked || !currentTab;
    $('tab-list').replaceChildren(...selected.tabs.map(id => {
      const item = document.createElement('li');
      item.textContent = tabs.find(tab => tab.id === id)?.title || `Linked tab ${id}`;
      return item;
    }));
  }
  renderFiles('temporary-files', state.files.filter(file => file.sessionId === selectedSession), false);
  renderFiles('kept-files', state.kept, true);
  $('pending-area').hidden = !pending;
  if (pending) {
    $('pending-url').textContent = pending.url;
    $('permission-copy').textContent = `Allow a download request to ${new URL(pending.url).origin}. No cookies or sign-in credentials are sent. Select a session to save into.`;
    $('save-link').disabled = !selected;
  }
  const choice = fileSelection();
  $('selected-file').textContent = choice ? `${choice.file.name} · ${size(choice.file.size)}` : 'Select a file above to get started.';
  $('scan').disabled = !linked;
  const previousToken = $('upload-field').value;
  $('upload-field').replaceChildren(...(scan?.fields.length ? scan.fields.map(field => option(field.token, `${field.label}${field.accept ? ` (${field.accept})` : ''}${field.occupied ? ' — already filled' : ''}`)) : [option('', scan ? 'No compatible fields found' : 'Scan this page first')]));
  if (scan?.fields.some(field => field.token === previousToken)) $('upload-field').value = previousToken;
  $('upload-field').disabled = !scan?.fields.length;
  $('attach').disabled = !choice || !linked || !scan?.fields.length || !$('trust-page').checked;
}

function ask(title, copy, initialName) {
  return new Promise(resolve => {
    const dialog = $('edit-dialog');
    $('dialog-title').textContent = title; $('dialog-copy').textContent = copy;
    const editing = initialName !== undefined;
    $('dialog-name').hidden = !editing; $('dialog-label').hidden = !editing;
    $('dialog-name').required = editing; $('dialog-name').value = initialName || '';
    dialog.returnValue = '';
    dialog.onclose = () => resolve(dialog.returnValue === 'confirm' ? (editing ? $('dialog-name').value : true) : false);
    dialog.showModal();
    (editing ? $('dialog-name') : $('dialog-confirm')).focus();
  });
}

$('create-form').onsubmit = event => {
  event.preventDefault();
  run(async () => {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    const created = await send('create', { name: $('session-name').value, tabId: tab?.id });
    selectedSession = created.id; selectedFile = ''; invalidateScan(); $('session-name').value = '';
  }, 'Session created and linked to your current tab.');
};
$('session-select').onchange = () => { selectedSession = $('session-select').value; selectedFile = ''; invalidateScan(); render(); };
$('rename').onclick = async () => {
  const current = session(); if (!current) return;
  const name = await ask('Rename session', 'Choose a name for this task.', current.name);
  if (name !== false) run(() => send('rename', { id: current.id, name }), 'Session renamed.');
};
$('end').onclick = async () => {
  const current = session(); if (!current) return;
  if (await ask(`End “${current.name}”?`, 'All temporary files in this session will be deleted. Kept files remain. Files already attached to pages remain there until you clear them or close the pages.')) {
    run(async () => { await send('end', { id: current.id }); invalidateScan(); }, 'Session ended. Its temporary files were deleted.');
  }
};
$('link-tab').onclick = () => run(async () => {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  await send('link', { id: selectedSession, tabId: tab?.id }); invalidateScan();
}, 'Tab linked. Closing the last linked tab will end this session.');
$('local-files').onchange = () => {
  const files = [...$('local-files').files], sessionId = selectedSession;
  run(async () => {
    let added = 0;
    try {
      for (const file of files) { await storage.addFile(sessionId, file, file.name, file.lastModified); added++; }
    } catch (error) { throw new Error(`${added} file(s) added. ${error.message}`); }
    finally { $('local-files').value = ''; await send('files-added'); await refresh(); }
  }, `${files.length} file(s) added locally.`);
};
$('dismiss-link').onclick = () => run(() => send('dismiss-link', { windowId }), 'Link dismissed.');
$('save-link').onclick = () => {
  if (!pending || busy) return;
  const link = pending, sessionId = selectedSession;
  // Must be called synchronously from this click, before any await.
  const permission = chrome.permissions.request({ origins: [downloadOrigin(link.url)] });
  run(async () => {
    try {
      if (!await permission) throw new Error('Access declined. Download normally, then use Add files.');
      status('Downloading into local storage…');
      await send('download', { pendingId: link.id, windowId, sessionId });
    } finally { await chrome.permissions.remove({ origins: [downloadOrigin(link.url)] }).catch(() => {}); }
  }, 'File saved locally. Download site access released.');
};
$('scan').onclick = () => run(async () => {
  invalidateScan();
  try { scan = await send('scan', { sessionId: selectedSession, tabId: currentTab?.id }); }
  catch (error) { throw new Error(`${error.message} Click the toolbar icon on this tab, or use the website’s normal picker.`); }
  if (!scan.fields.length) throw new Error('No compatible native form fields found. Use the website’s normal picker; Save copy is available above.');
}, 'Choose an upload field, then confirm that you trust this page.');
$('trust-page').onchange = render;
$('attach').onclick = () => run(async () => {
  const selected = fileSelection();
  try {
    await send('attach', { sessionId: selectedSession, tabId: currentTab.id, fileId: selected.file.id, kept: selected.kept,
      documentId: scan.documentId, token: $('upload-field').value });
  } catch (error) { throw new Error(`${error.message} Use Save copy and the website’s normal picker if needed.`); }
  finally { invalidateScan(); }
}, 'File attached. Review the website’s form and submit it yourself.');
$('release-access').onclick = () => run(() => send('release-access'), 'Download site access released.');

chrome.runtime.onMessage.addListener(message => { if (message.type === 'changed') refresh().catch(error => status(error.message, true)); });
chrome.tabs.onActivated.addListener(info => { if (info.windowId === windowId) { invalidateScan(); refresh().catch(error => status(error.message, true)); } });
chrome.tabs.onUpdated.addListener((id, change) => { if (id === currentTab?.id && change.status === 'loading') { invalidateScan(); render(); } });

try {
  await send('ready');
  storage = createStorage(await openDatabase());
  windowId = (await chrome.windows.getCurrent()).id;
  await refresh();
  status('Ready. Your files stay local until you share them with a page.');
} catch (error) { status(error.message, true); }
