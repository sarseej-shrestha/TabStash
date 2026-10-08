import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { openDatabase, createStorage, MAX_FILE_BYTES } from '../extension/storage.js';
import { initializeLifecycle } from '../extension/lifecycle.js';

async function setup(t) {
  const db = await openDatabase(new IDBFactory());
  t.after(() => db.close());
  return createStorage(db);
}
const file = (storage, session, text = 'private bytes') => storage.addFile(session.id, new Blob([text], { type: 'text/plain' }), 'document.txt');

test('closing one of multiple linked tabs preserves files; closing last deletes them', async t => {
  const storage = await setup(t), session = await storage.createSession('Application', 10);
  await storage.linkTab(session.id, 20); await storage.linkTab(session.id, 20);
  const id = await file(storage, session);
  assert.deepEqual((await storage.snapshot()).sessions[0].tabs, [10, 20]);
  await storage.closeTab(10);
  assert.equal(await (await storage.getFile(id)).blob.text(), 'private bytes');
  assert.deepEqual((await storage.snapshot()).sessions[0].tabs, [20]);
  await storage.closeTab(20);
  assert.deepEqual(await storage.snapshot(), { sessions: [], files: [], kept: [] });
});

test('Keep moves bytes out of temporary storage and survives every cleanup path', async t => {
  const storage = await setup(t), session = await storage.createSession('Keep', 1);
  const keptId = await file(storage, session, 'keep these bytes');
  const temporaryId = await file(storage, session);
  await storage.keepFile(keptId);
  assert.equal(await storage.getFile(keptId), undefined);
  await storage.endSession(session.id); await storage.closeTab(1); await storage.clearTemporary();
  assert.equal(await storage.getFile(temporaryId), undefined);
  const kept = await storage.getFile(keptId, true);
  assert.equal(await kept.blob.text(), 'keep these bytes');
  assert.equal('sessionId' in kept, false);
  await storage.deleteFile(keptId, true);
  assert.equal(await storage.getFile(keptId, true), undefined);
});

test('ending one session cannot remove files in another or kept files', async t => {
  const storage = await setup(t), a = await storage.createSession('A', 1), b = await storage.createSession('B', 2);
  await file(storage, a); const bId = await file(storage, b);
  await storage.endSession(a.id);
  assert.equal((await storage.snapshot()).sessions[0].id, b.id);
  assert.ok(await storage.getFile(bId));
});

test('a tab cannot silently move to another session', async t => {
  const storage = await setup(t), a = await storage.createSession('A', 1), b = await storage.createSession('B', 2);
  await assert.rejects(storage.linkTab(b.id, 1), /another session/);
  await assert.rejects(storage.createSession('Duplicate', 1), /already linked/);
  assert.deepEqual((await storage.snapshot()).sessions.find(s => s.id === a.id).tabs, [1]);
});

test('late download completion cannot resurrect an ended session', async t => {
  const storage = await setup(t), session = await storage.createSession('A', 1);
  await storage.endSession(session.id);
  await assert.rejects(file(storage, session), /has ended/);
  assert.equal((await storage.snapshot()).files.length, 0);
});

test('concurrent add and end leave no orphaned temporary data', async t => {
  const storage = await setup(t), session = await storage.createSession('A', 1);
  await Promise.allSettled([file(storage, session), storage.endSession(session.id)]);
  assert.deepEqual(await storage.snapshot(), { sessions: [], files: [], kept: [] });
});

test('Keep racing cleanup never leaves a duplicate or resurrects a deleted file', async t => {
  const storage = await setup(t), session = await storage.createSession('A', 1), id = await file(storage, session);
  await Promise.all([storage.keepFile(id), storage.endSession(session.id)]);
  assert.equal(await storage.getFile(id), undefined);
  assert.ok(await storage.getFile(id, true));
  const next = await storage.createSession('B', 2), late = await file(storage, next);
  await storage.endSession(next.id);
  await assert.rejects(storage.keepFile(late), /no longer exists/);
  assert.equal(await storage.getFile(late, true), undefined);
});

test('tab replacement preserves session; reconciling missed close events removes orphans', async t => {
  const storage = await setup(t), session = await storage.createSession('A', 1);
  await file(storage, session); await storage.replaceTab(1, 5); await storage.closeTab(1);
  assert.deepEqual((await storage.snapshot()).sessions[0].tabs, [5]);
  await storage.reconcileTabs([5]); assert.equal((await storage.snapshot()).files.length, 1);
  await storage.reconcileTabs([99]); assert.equal((await storage.snapshot()).files.length, 0);
});

test('browser restart clears temporary data and pending URLs, preserving kept files', async t => {
  const storage = await setup(t), session = await storage.createSession('Old', 1);
  const id = await file(storage, session); await storage.keepFile(id); await file(storage, session);
  await storage.setMeta('pending-1', { url: 'https://example.test/private-token' });
  let marker = {};
  const browser = { storage: { session: { get: async () => marker, set: async value => { marker = value; } } }, tabs: { query: async () => [{ id: 1 }] } };
  await initializeLifecycle(storage, browser);
  assert.equal((await storage.snapshot()).sessions.length, 0);
  assert.equal((await storage.snapshot()).kept.length, 1);
  assert.equal(await storage.getMeta('pending-1'), undefined);
  const fresh = await storage.createSession('Fresh', 1); await file(storage, fresh);
  await initializeLifecycle(storage, browser); // Worker suspension must not act like browser restart.
  assert.equal((await storage.snapshot()).files.length, 1);
  marker = {};
  await initializeLifecycle(storage, browser);
  assert.equal((await storage.snapshot()).files.length, 0);
  assert.equal((await storage.snapshot()).kept.length, 1);
});

test('renaming is validated and metadata snapshots exclude file bytes', async t => {
  const storage = await setup(t), session = await storage.createSession('Original', 1);
  await file(storage, session); await storage.renameSession(session.id, '  Renamed  ');
  const snapshot = await storage.snapshot();
  assert.equal(snapshot.sessions[0].name, 'Renamed'); assert.equal('blob' in snapshot.files[0], false);
  await assert.rejects(storage.renameSession(session.id, ' '), /1–80/);
  await assert.rejects(storage.createSession('x'.repeat(81), 2), /1–80/);
  await assert.rejects(storage.createSession('Invalid', -1), /browser tab/);
});

test('file and session limits are enforced atomically', async t => {
  const storage = await setup(t), session = await storage.createSession('Bounded', 1);
  await assert.rejects(storage.addFile(session.id, new Blob([new Uint8Array(MAX_FILE_BYTES + 1)]), 'large.bin'), /20 MiB/);
  const fullFile = new Blob([new Uint8Array(MAX_FILE_BYTES)]);
  for (let i = 0; i < 5; i++) await storage.addFile(session.id, fullFile, `${i}.bin`);
  await assert.rejects(file(storage, session), /100 MiB/);
  assert.equal((await storage.snapshot()).files.length, 5);
});
