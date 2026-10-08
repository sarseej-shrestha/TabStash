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
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/panel.html`);
  const target = await context.newPage();
  await target.goto(fixture.url);
  const result = await panel.evaluate(async ({ url, content }) => {
    const blob = await (await fetch(url + '/sample.txt', { credentials: 'omit', redirect: 'error' })).blob();
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('attachment-proof', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put(blob, 'proof');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    const restored = await new Promise((resolve, reject) => {
      const request = db.transaction('files').objectStore('files').get('proof');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    if (await restored.text() !== content) throw new Error('Stored bytes changed');
    const { attachToInput, serializeFile, inspectInputs } = await import('./attach.js');
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url + '/');
    const [scan] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: inspectInputs });
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: attachToInput,
      args: [await serializeFile({ blob: restored, name: 'sample.txt', lastModified: 1 }), scan.result[0].token] });
    db.close();
    return result.result;
  }, { url: fixture.url, content: fixtureBytes.toString() });
  assert.deepEqual(result, { name: 'sample.txt', size: fixtureBytes.length });
  assert.equal(await target.locator('input').evaluate(input => new Response(input.files[0]).text()), fixtureBytes.toString());
  assert.equal(fixture.submissions(), 0, 'Attachment must not submit the form');
  await target.click('button[type="submit"]');
  await target.waitForURL('**/submit');
  assert.equal(fixture.submissions(), 1);
  assert.ok((await target.textContent('body')).includes(fixtureBytes.toString().trim()));
  await mkdir('artifacts', { recursive: true });
  await panel.screenshot({ path: 'artifacts/panel.png', fullPage: true });
  console.log('PASS: direct HTTP link → IndexedDB Blob → isolated-world FileList → native form. No submission until explicit submit.');
} finally {
  await context?.close();
  fixture.server.close();
  await rm(profile, { recursive: true, force: true });
}
