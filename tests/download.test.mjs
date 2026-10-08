import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadOrigin, downloadName, fetchDirectFile } from '../extension/download.js';
import { MAX_FILE_BYTES } from '../extension/storage.js';

test('only explicit HTTP(S) origins without credentials are eligible', () => {
  assert.equal(downloadOrigin('https://files.example.test/a?token=secret'), 'https://files.example.test/*');
  for (const url of ['file:///etc/passwd', 'data:text/plain,x', 'blob:https://example.test/a', 'javascript:alert(1)', 'https://u:p@example.test/file']) {
    assert.throws(() => downloadOrigin(url), /Only direct/);
  }
});
test('download uses GET without credentials, referrer, cache, or redirect following', async () => {
  const result = await fetchDirectFile('https://example.test/file', async (url, options) => {
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error'); assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.cache, 'no-store'); assert.ok(options.signal instanceof AbortSignal);
    assert.equal('body' in options, false);
    return new Response('exact bytes', { headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="proof.txt"' } });
  });
  assert.equal(result.name, 'proof.txt'); assert.equal(await result.blob.text(), 'exact bytes');
});
test('login pages and HTTP errors explain the picker fallback', async () => {
  await assert.rejects(fetchDirectFile('https://example.test', async () => new Response('login', { status: 401 })), /Add files/);
  await assert.rejects(fetchDirectFile('https://example.test', async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })), /web page/);
});
test('both declared and streamed size limits prevent oversized downloads', async () => {
  await assert.rejects(fetchDirectFile('https://example.test', async () => new Response('x', { headers: { 'content-length': String(MAX_FILE_BYTES + 1) } })), /20 MiB/);
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_FILE_BYTES + 1)); }, cancel() { cancelled = true; } });
  await assert.rejects(fetchDirectFile('https://example.test', async () => new Response(stream)), /20 MiB/);
  assert.equal(cancelled, true);
});
test('download names are decoded and cannot contain paths or control characters', () => {
  assert.equal(downloadName('https://example.test/f', "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt"), 'résumé.txt');
  assert.equal(downloadName('https://example.test/f', 'attachment; filename="../../private.txt"'), '.._.._private.txt');
  assert.equal(downloadName('https://example.test/report%20final.pdf'), 'report final.pdf');
  assert.equal(downloadName('https://example.test/'), 'download');
});

test('header-rejected responses cancel the network body immediately', async () => {
  for (const init of [{ status: 403 }, { headers: { 'content-type': 'text/html' } }, { headers: { 'content-length': String(MAX_FILE_BYTES + 1) } }]) {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    await assert.rejects(fetchDirectFile('https://example.test', async () => new Response(body, init)));
    assert.equal(cancelled, true);
  }
});
