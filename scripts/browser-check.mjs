import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFixture, fixtureBytes } from './fixture-server.mjs';

const fixture = await startFixture();
const profile = await mkdtemp(path.join(tmpdir(), 'upload-session-browser-'));
const extension = path.join(profile, 'extension');
await cp(path.resolve('extension'), extension, { recursive: true });
// Automated headless runs cannot approve browser chrome permission dialogs.
// Give ONLY the local fixture access to a throwaway copy; shipped manifest is untouched.
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = [fixture.url + '/*'];
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const launch = () => chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
let context;
const pageErrors = [];
async function rpc(panel, type, data = {}) {
  const response = await panel.evaluate(message => chrome.runtime.sendMessage(message), { type, ...data });
  if (!response?.ok) throw new Error(response?.error || 'No response');
  return response.value;
}
async function openPanel(context, id) {
  const panel = await context.newPage();
  panel.on('pageerror', error => pageErrors.push(error.message));
  await panel.setViewportSize({ width: 390, height: 900 });
  await panel.goto(`chrome-extension://${id}/panel.html`);
  await panel.waitForFunction(() => !document.getElementById('controls').disabled);
  return panel;
}
async function seedLink(panel, url, windowId) {
  const pendingId = await panel.evaluate(async ({ url, windowId }) => {
    const { openDatabase, createStorage } = await import('./storage.js');
    const db = await openDatabase(), id = crypto.randomUUID();
    await createStorage(db).setMeta(`pending-${windowId}`, { id, url, createdAt: Date.now() });
    db.close(); return id;
  }, { url, windowId });
  await rpc(panel, 'files-added');
  return pendingId;
}
try {
  context = await launch();
  console.log(`Browser: ${context.browser().version()}`);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  let panel = await openPanel(context, id);
  const target = await context.newPage();
  await target.goto(fixture.url);
  await panel.waitForFunction(() => !document.getElementById('controls').disabled);
  await panel.locator('#session-name').fill('Local upload check');
  await panel.evaluate(() => document.getElementById('create-form').requestSubmit());
  await panel.waitForFunction(() => document.getElementById('status').textContent.includes('Session created'));
  const sessionId = await panel.locator('#session-select').inputValue();
  const tab = await panel.evaluate(url => chrome.tabs.query({}).then(tabs => tabs.find(tab => tab.url === url + '/')), fixture.url);
  assert.deepEqual((await rpc(panel, 'snapshot')).sessions[0].tabs, [tab.id]);
  await panel.locator('#rename').click();
  await panel.locator('#dialog-name').fill('Renamed application');
  await panel.locator('#dialog-confirm').click();
  await panel.waitForFunction(() => document.querySelector('#session-select option')?.textContent === 'Renamed application');
  await panel.locator('#local-files').setInputFiles({ name: 'picker.txt', mimeType: 'text/plain', buffer: Buffer.from('picker fallback') });
  await panel.waitForFunction(() => document.querySelector('#temporary-files .file-name')?.textContent === 'picker.txt');
  await panel.getByRole('button', { name: 'Keep', exact: true }).click();
  await panel.waitForFunction(() => document.querySelector('#kept-files .file-name')?.textContent === 'picker.txt');
  const keptId = (await rpc(panel, 'snapshot')).kept[0].id;
  const [savedCopy] = await Promise.all([panel.waitForEvent('download'), panel.locator('#kept-files').getByRole('button', { name: 'Save copy' }).click()]);
  assert.equal(savedCopy.suggestedFilename(), 'picker.txt');
  assert.equal((await readFile(await savedCopy.path())).toString(), 'picker fallback');
  console.log('PASS: create, rename, picker import, Keep, and Save copy through the UI.');
  let pendingId = await seedLink(panel, fixture.url.replace('127.0.0.1', 'localhost') + '/sample.txt', tab.windowId);
  await assert.rejects(rpc(panel, 'download', { pendingId, windowId: tab.windowId, sessionId }), /not granted/);
  assert.equal(fixture.downloads(), 0);
  for (const [route, pattern] of [['/redirect', /fetch/i], ['/', /web page/], ['/large', /20 MiB/]]) {
    pendingId = await seedLink(panel, fixture.url + route, tab.windowId);
    await assert.rejects(rpc(panel, 'download', { pendingId, windowId: tab.windowId, sessionId }), pattern);
  }
  assert.equal(fixture.downloads(), 0, 'Redirects must not be followed');
  await seedLink(panel, fixture.url + '/sample.txt', tab.windowId);
  await panel.waitForFunction(() => document.getElementById('pending-url').textContent.endsWith('/sample.txt'));
  await panel.locator('#save-link').click();
  await panel.waitForFunction(() => document.querySelector('#temporary-files .file-name')?.textContent === 'sample.txt');
  const fileId = (await rpc(panel, 'snapshot')).files[0].id;
  const storedBytes = await panel.evaluate(async fileId => {
    const { openDatabase, createStorage } = await import('./storage.js'); const db = await openDatabase();
    const file = await createStorage(db).getFile(fileId); db.close(); return file.blob.text();
  }, fileId);
  assert.equal(storedBytes, fixtureBytes.toString());
  console.log('PASS: denied-origin fallback, rejected redirects/HTML/oversize, direct download bytes in IndexedDB.');
  const oldScan = await rpc(panel, 'scan', { sessionId, tabId: tab.id });
  await target.reload();
  await assert.rejects(rpc(panel, 'attach', { sessionId, tabId: tab.id, fileId, documentId: oldScan.documentId, token: oldScan.fields[0].token }), /document|changed|frame/i);
  await assert.rejects(rpc(panel, 'scan', { sessionId: 'wrong-session', tabId: tab.id }), /Link this tab/);
  await target.evaluate(() => {
    const fieldset = document.createElement('fieldset'); fieldset.disabled = true;
    const input = document.querySelector('input'); input.before(fieldset); fieldset.append(input);
  });
  assert.equal((await rpc(panel, 'scan', { sessionId, tabId: tab.id })).fields.length, 0);
  await target.evaluate(() => { document.querySelector('fieldset').disabled = false; });
  await target.evaluate(() => {
    window.inputEvents = 0;
    document.querySelector('input').addEventListener('change', () => window.inputEvents++);
    document.querySelector('input').addEventListener('input', () => window.inputEvents++);
  });
  await panel.getByRole('button', { name: 'Select sample.txt', exact: true }).click();
  await panel.locator('#scan').click();
  await panel.waitForFunction(() => document.querySelector('#upload-field option')?.value);
  await panel.locator('#trust-page').check();
  await panel.locator('#attach').click();
  await panel.waitForFunction(() => document.getElementById('status').textContent.startsWith('File attached.'));
  assert.equal(await target.locator('input').evaluate(input => new Response(input.files[0]).text()), fixtureBytes.toString());
  assert.equal(await target.evaluate(() => window.inputEvents), 0);
  assert.equal(fixture.submissions(), 0);
  await mkdir('artifacts', { recursive: true });
  await panel.screenshot({ path: 'artifacts/panel.png', fullPage: true });
  await panel.setViewportSize({ width: 320, height: 850 });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.screenshot({ path: 'artifacts/panel-narrow.png', fullPage: true });
  let scan = await rpc(panel, 'scan', { sessionId, tabId: tab.id });
  await assert.rejects(rpc(panel, 'attach', { sessionId, tabId: tab.id, fileId, documentId: scan.documentId, token: scan.fields[0].token }), /rejected|already/i);
  await target.locator('input').evaluate(input => { input.value = ''; input.accept = '.pdf'; });
  scan = await rpc(panel, 'scan', { sessionId, tabId: tab.id });
  await assert.rejects(rpc(panel, 'attach', { sessionId, tabId: tab.id, fileId, documentId: scan.documentId, token: scan.fields[0].token }), /rejected|accepted/i);
  await target.locator('input').evaluate(input => { input.accept = '.txt'; });
  scan = await rpc(panel, 'scan', { sessionId, tabId: tab.id });
  await rpc(panel, 'attach', { sessionId, tabId: tab.id, fileId, documentId: scan.documentId, token: scan.fields[0].token });
  assert.equal(fixture.submissions(), 0);
  await target.click('button[type="submit"]');
  await target.waitForURL('**/submit');
  assert.equal(fixture.submissions(), 1);
  assert.ok((await target.textContent('body')).includes(fixtureBytes.toString().trim()));
  console.log('PASS: real attachment message flow, document isolation, accept/occupied guards, zero change events, explicit submit only.');
  const second = await context.newPage(); await second.goto(fixture.url + '/second');
  const secondTab = await panel.evaluate(url => chrome.tabs.query({}).then(tabs => tabs.find(tab => tab.url === url)), fixture.url + '/second');
  await rpc(panel, 'link', { id: sessionId, tabId: secondTab.id });
  await target.close();
  await panel.waitForFunction(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'snapshot' });
    return response.value.sessions[0]?.tabs.length === 1 && response.value.files.length === 1;
  });
  await second.close();
  await panel.waitForFunction(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'snapshot' });
    return response.value.sessions.length === 0 && response.value.files.length === 0 && response.value.kept.length === 1;
  });
  console.log('PASS: real tab-close events preserve multi-tab sessions, clean the last tab, and retain kept bytes.');
  // Simulate stale data from an abrupt shutdown, with no live tab to emit a close event.
  await panel.evaluate(async () => {
    const { openDatabase, createStorage } = await import('./storage.js'); const db = await openDatabase(); const storage = createStorage(db);
    const session = await storage.createSession('Stale after crash', 987654);
    await storage.addFile(session.id, new Blob(['temporary crash residue']), 'stale.txt');
    await storage.setMeta('pending-stale', 'private-url'); db.close();
  });
  await context.close(); context = await launch(); panel = await openPanel(context, id);
  const restarted = await rpc(panel, 'snapshot');
  assert.equal(restarted.sessions.length, 0); assert.equal(restarted.files.length, 0); assert.equal(restarted.kept[0].id, keptId);
  const pendingAfterRestart = await panel.evaluate(async () => {
    const { openDatabase, createStorage } = await import('./storage.js'); const db = await openDatabase();
    const result = await createStorage(db).getMeta('pending-stale'); db.close(); return result;
  });
  assert.equal(pendingAfterRestart, undefined); assert.deepEqual(pageErrors, []);
  console.log('PASS: real browser restart removes stale temporary data and link metadata, keeps retained files; zero panel errors.');
} finally {
  await context?.close();
  fixture.server.close();
  await rm(profile, { recursive: true, force: true });
}
