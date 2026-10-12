import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './helpers/dom.mjs';
import { deferred, settle } from './helpers/save.mjs';
import { createEmptyData } from '../web/shared/model.mjs';
import { createSaveController } from '../web/save-controller.mjs';

const doc = id => ({ schemaVersion: 1, id, name: id, revision: 0, updatedAt: '2026-10-11T00:00:00Z', data: createEmptyData('en'), latestBuild: null });
const node = (host, id) => host.all().find(n => n.id === id);
const named = (host, name) => host.all().find(n => n.tagName === 'button' && n.textContent === name);

async function workspace(t, { ids = ['a', 'b'], save, remove } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = installDom(t); const records = new Map(ids.map(id => [id, doc(id)]));
  const api = {
    list: async () => [...records.values()].map(d => ({ id: d.id, name: d.name, language: 'en', revision: d.revision })),
    read: async id => structuredClone(records.get(id)),
    create: async payload => { const created = { ...doc('created'), name: payload.name, data: createEmptyData(payload.language) }; records.set(created.id, created); return structuredClone(created); },
    save: save || (async (id, payload) => { throw new Error('Unexpected save during deletion'); }),
    remove: remove || (async (id, { expectedRevision }) => {
      assert.equal(expectedRevision, records.get(id).revision);
      records.delete(id); return { id, deleted: true };
    }),
  };
  const { mountWorkspace } = await import('../web/app.mjs');
  const app = mountWorkspace(host, { api }); t.after(() => app.destroy()); await settle();
  return { host, app, records, api, dialog: () => host.all().find(n => n.tagName === 'dialog') };
}

test('newly created resume can be deleted after confirmation while cancellation preserves it', async t => {
  const f = await workspace(t);
  await named(f.host, '＋ 新建').click(); await f.dialog().children[0].fire('submit');
  assert.equal(f.app.getDraft().resumeId, 'created');
  const remove = node(f.host, 'delete-button'); assert.ok(remove, 'whole-resume delete action exists');
  await remove.click(); assert.equal(f.dialog().open, true);
  assert.ok(f.dialog().all().some(n => n.textContent?.includes('我的简历')));
  await named(f.dialog(), '取消').click(); assert.equal(f.records.has('created'), true);
  await remove.click(); await f.dialog().children[0].fire('submit');
  assert.equal(f.records.has('created'), false); assert.equal(f.records.has('a'), true); assert.equal(f.records.has('b'), true);
  assert.equal(f.app.getDraft().resumeId, 'a'); assert.equal(f.dialog().open, false);
  assert.ok(!f.host.all().some(n => n.tagName === 'option' && n.value === 'created'));
});

test('deleting last resume clears forms and preview and still permits creating another', async t => {
  const f = await workspace(t, { ids: ['a'] });
  await node(f.host, 'delete-button').click(); await f.dialog().children[0].fire('submit');
  assert.equal(f.app.getDraft(), null); assert.equal(f.records.size, 0);
  assert.equal(node(f.host, 'delete-button').disabled, true);
  assert.equal(node(f.host, 'compile-button').disabled, true);
  assert.ok(f.host.all().some(n => n.textContent === '尚无简历'));
  assert.ok(f.host.all().some(n => n.className === 'empty-note'));
  assert.equal(node(f.host, 'download-pdf').getAttribute('href'), null);
  await named(f.host, '＋ 新建').click(); await f.dialog().children[0].fire('submit');
  assert.equal(f.app.getDraft().resumeId, 'created'); assert.equal(node(f.host, 'delete-button').disabled, false);
});

test('deletion waits for an in-flight save and discards queued invalid draft without saving it', async t => {
  const pending = deferred(); let saves = 0; let f;
  f = await workspace(t, { save: async (id, payload) => { saves++; await pending.promise; const saved = { ...doc(id), name: payload.name, data: payload.data, revision: 1 }; f.records.set(id, saved); return structuredClone(saved); } });
  const name = f.host.all().find(n => n.className === 'document-title').children[1];
  name.value = 'First save'; await name.fire('input'); t.mock.timers.tick(800);
  name.value = ''; await name.fire('input');
  await node(f.host, 'delete-button').click(); const deleting = f.dialog().children[0].fire('submit'); await settle();
  assert.equal(f.records.has('a'), true); assert.equal(await f.app.openResume('b'), false);
  pending.resolve(); await deleting; t.mock.timers.tick(5000); await settle();
  assert.equal(f.records.has('a'), false); assert.equal(saves, 1); assert.equal(f.app.getDraft().resumeId, 'b');
});

test('failed deletion retains current draft and resumes autosave', async t => {
  let savedName = null;
  const f = await workspace(t, { remove: async () => { throw { status: 409, code: 'RESUME_BUSY', message: '简历正在编译，请稍后删除' }; },
    save: async (id, payload) => { savedName = payload.name; return { ...doc(id), ...payload, revision: 1 }; } });
  const name = f.host.all().find(n => n.className === 'document-title').children[1]; name.value = 'Keep draft'; await name.fire('input');
  await node(f.host, 'delete-button').click(); await f.dialog().children[0].fire('submit');
  assert.equal(f.app.getDraft().resumeId, 'a'); assert.equal(f.app.getDraft().name, 'Keep draft'); assert.equal(f.records.has('a'), true);
  assert.equal(f.dialog().open, true); assert.ok(f.dialog().all().some(n => n.textContent?.includes('正在编译')));
  t.mock.timers.tick(800); await settle(); assert.equal(savedName, 'Keep draft');
});

test('save pause drains existing request without sending queued changes and resume preserves them', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const pending = deferred(); const sent = [];
  const controller = createSaveController({ resumeId: 'a', initial: doc('a'), api: { save: async (id, payload) => { sent.push(payload); if (sent.length === 1) await pending.promise; return { ...doc(id), ...payload, revision: sent.length }; } } });
  t.after(() => controller.destroy());
  controller.edit(doc('a').data, { name: 'first' }); t.mock.timers.tick(800);
  controller.edit(doc('a').data, { name: 'second' }); const paused = controller.pause();
  pending.resolve(); assert.equal((await paused).revision, 1);
  t.mock.timers.tick(5000); await settle(); assert.equal(sent.length, 1);
  controller.resume(); t.mock.timers.tick(800); await settle();
  assert.equal(sent.length, 2); assert.equal(sent[1].name, 'second'); assert.equal(sent[1].expectedRevision, 1);
});

test('a deletion revision conflict exposes reload recovery without losing the current resume', async t => {
  const f = await workspace(t, { remove: async () => { throw { status: 409, code: 'REVISION_CONFLICT', message: '简历已被其他页面修改，请重新载入' }; } });
  await node(f.host, 'delete-button').click(); await f.dialog().children[0].fire('submit');
  assert.equal(f.app.getDraft().resumeId, 'a'); assert.equal(f.records.has('a'), true);
  await named(f.dialog(), '取消').click();
  assert.equal(node(f.host, 'save-status').dataset.state, 'conflict');
  assert.equal(f.host.all().find(n => n.className === 'recovery-actions').hidden, false);
  await named(f.host, '重新载入并放弃本页草稿').click();
  assert.equal(node(f.host, 'save-status').dataset.state, 'saved');
});

test('pending backup import blocks deletion until its library response is applied', async t => {
  const f = await workspace(t, { ids: ['a'] }); const gate = deferred(); const listed = deferred();
  f.api.importBackup = async () => { const imported = doc('imported'); f.records.set(imported.id, imported); return imported; };
  const list = f.api.list;
  f.api.list = async () => { const snapshot = await list(); listed.resolve(); await gate.promise; return snapshot; };
  const input = f.host.all().find(n => n.type === 'file'); input.files = [new Blob(['{}'], { type: 'application/json' })];
  const importing = input.fire('change'); await listed.promise;
  try {
    assert.equal(node(f.host, 'delete-button').disabled, true);
    assert.equal(named(f.host, '＋ 新建').disabled, true); assert.equal(named(f.host, '复制').disabled, true);
    await node(f.host, 'delete-button').click(); assert.equal(f.dialog().open, undefined);
    gate.resolve(); await importing;
    assert.equal(f.app.getDraft().resumeId, 'imported'); assert.equal(f.records.has('a'), true);
    assert.equal(node(f.host, 'delete-button').disabled, false);
  } finally { gate.resolve(); await importing; }
});

test('pending creation blocks deletion and keeps its dialog open until publication', async t => {
  const f = await workspace(t); const gate = deferred(); const entered = deferred(); const create = f.api.create;
  f.api.create = async payload => { entered.resolve(); await gate.promise; return create(payload); };
  await named(f.host, '＋ 新建').click(); const creating = f.dialog().children[0].fire('submit'); await entered.promise;
  try {
    assert.equal(node(f.host, 'delete-button').disabled, true);
    assert.equal(named(f.dialog(), '取消').disabled, true);
    let cancelled = false; await f.dialog().fire('cancel', { preventDefault() { cancelled = true; } }); assert.equal(cancelled, true);
    gate.resolve(); await creating;
    assert.equal(f.app.getDraft().resumeId, 'created'); assert.equal(f.records.has('a'), true);
    assert.equal(node(f.host, 'delete-button').disabled, false);
  } finally { gate.resolve(); await creating; }
});
