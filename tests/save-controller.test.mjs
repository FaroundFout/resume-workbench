import test from 'node:test';
import assert from 'node:assert/strict';
import { createSaveFixture, settle } from './helpers/save.mjs';
import { deferred } from './helpers/save.mjs';
import { installDom } from './helpers/dom.mjs';
import { createEmptyData } from '../web/shared/model.mjs';

test('flush waits for latest queued data and document name with serial revisions', async t => {
  const f = createSaveFixture(t);
  f.controller.edit(f.draft('first')); f.startFirstSave();
  f.controller.edit(f.draft('second'), { name: 'Renamed' });
  const pending = f.controller.flush();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].payload.expectedRevision, 0);
  f.resolveFirstSave(1); await settle();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].payload.expectedRevision, 1);
  f.resolveSecondSave(2); const saved = await pending;
  assert.equal(saved.revision, 2); assert.equal(saved.data.profile.name, 'second'); assert.equal(saved.name, 'Renamed');
  assert.equal(f.statuses.at(-1).state, 'saved');
});
test('autosave waits for quiet input and isolates mutable caller data', async t => {
  const f = createSaveFixture(t); const data = f.draft('retained');
  f.controller.edit(data); data.profile.name = 'mutated'; t.mock.timers.tick(799);
  assert.equal(f.calls.length, 0); t.mock.timers.tick(1);
  assert.equal(f.calls[0].payload.data.profile.name, 'retained'); f.resolveFirstSave(1); await settle();
  assert.equal((await f.controller.flush()).revision, 1); assert.equal(f.calls.length, 1);
});
test('failed saves retain draft and explicit flush retries latest edit', async t => {
  const f = createSaveFixture(t); f.controller.edit(f.draft('unsaved'));
  const first = f.controller.flush(); f.calls[0].pending.reject({ status: 0, code: 'NETWORK_ERROR' });
  await assert.rejects(first); assert.equal(f.statuses.at(-1).state, 'error');
  assert.equal(f.controller.readDraft().profile.name, 'unsaved');
  const retry = f.controller.flush(); f.resolveSecondSave(1); assert.equal((await retry).revision, 1);
});
test('conflict stops retries and retains newer draft for copy or explicit reload', async t => {
  const f = createSaveFixture(t); f.controller.edit(f.draft('first')); f.startFirstSave();
  f.controller.edit(f.draft('keep me')); const pending = f.controller.flush();
  f.calls[0].pending.reject({ status: 409, code: 'REVISION_CONFLICT', fields: { actualRevision: 2 } });
  await assert.rejects(pending); await assert.rejects(f.controller.flush()); t.mock.timers.tick(5000);
  assert.equal(f.calls.length, 1); assert.equal(f.statuses.at(-1).state, 'conflict');
  assert.equal(f.controller.readDraft().profile.name, 'keep me');
});
test('destroy clears pending debounce and silences in-flight completion', async t => {
  const f = createSaveFixture(t); f.controller.edit(f.draft('one')); f.startFirstSave();
  f.controller.edit(f.draft('two')); f.controller.destroy(); const count = f.statuses.length;
  f.resolveFirstSave(1); await settle(); t.mock.timers.tick(5000);
  assert.equal(f.calls.length, 1); assert.equal(f.statuses.length, count); await assert.rejects(f.controller.flush());
});

test('workspace immediate preview flushes all edits and switching waits for save', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const host = installDom(t);
  const { mountWorkspace } = await import('../web/app.mjs');
  const doc = id => ({ schemaVersion: 1, id, name: id, revision: 0, updatedAt: '2026-10-02T00:00:00Z', data: createEmptyData('en'), latestBuild: null });
  const saves = []; const builds = []; const reads = [];
  const api = { list: async () => [{ id: 'a', name: 'a', language: 'en' }, { id: 'b', name: 'b', language: 'en' }],
    read: async id => { reads.push(id); return doc(id); }, save(id, payload) { const pending = deferred(); saves.push({ id, payload, pending }); return pending.promise; },
    submitBuild: async (id, payload) => { builds.push({ id, payload }); return { id: 'fixed', resumeId: id, revision: payload.expectedRevision, status: 'failed', error: null }; } };
  const workspace = mountWorkspace(host, { api }); t.after(() => workspace.destroy()); await settle();
  const profile = () => host.all().find(n => n.className === 'field-grid').children[0].children[1];
  profile().value = 'first'; await profile().fire('input'); t.mock.timers.tick(800);
  profile().value = 'second'; await profile().fire('input');
  const compiling = host.all().find(n => n.id === 'compile-button').fire('click');
  saves[0].pending.resolve({ ...doc('a'), revision: 1, data: saves[0].payload.data }); await settle();
  assert.equal(saves.length, 2); assert.equal(builds.length, 0);
  saves[1].pending.resolve({ ...doc('a'), revision: 2, data: saves[1].payload.data }); await compiling;
  assert.deepEqual(builds, [{ id: 'a', payload: { expectedRevision: 2 } }]);
  profile().value = 'third'; await profile().fire('input'); const switching = workspace.openResume('b'); await settle();
  assert.equal(workspace.getDraft().resumeId, 'a'); assert.deepEqual(reads, ['a']);
  saves[2].pending.resolve({ ...doc('a'), revision: 3, data: saves[2].payload.data }); await switching;
  assert.equal(workspace.getDraft().resumeId, 'b');
});
test('workspace conflict blocks switching and keeps draft for explicit recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const host = installDom(t); const { mountWorkspace } = await import('../web/app.mjs');
  const doc = id => ({ schemaVersion: 1, id, name: id, revision: 0, data: createEmptyData('en'), latestBuild: null });
  const api = { list: async () => [{ id: 'a', name: 'a', language: 'en' }], read: async id => doc(id), save: async () => { throw { status: 409, code: 'REVISION_CONFLICT', message: '冲突' }; } };
  const workspace = mountWorkspace(host, { api }); t.after(() => workspace.destroy()); await settle();
  const input = host.all().find(n => n.className === 'document-title').children[1]; input.value = 'keep'; await input.fire('input');
  assert.equal(await workspace.openResume('b'), false); assert.equal(workspace.getDraft().resumeId, 'a'); assert.equal(workspace.getDraft().name, 'keep');
  assert.equal(host.all().find(n => n.id === 'save-status').dataset.state, 'conflict');
  await workspace.openResume('b', { keepDraft: true }); assert.equal(workspace.getDraft().resumeId, 'b');
});
test('workspace restores old PDF and editing during a running build leaves its captured revision alone', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const host = installDom(t); const { mountWorkspace } = await import('../web/app.mjs');
  const data = createEmptyData('en'); const old = { id: 'old', resumeId: 'a', revision: 0, status: 'succeeded', error: null };
  const doc = { schemaVersion: 1, id: 'a', name: 'a', revision: 1, data, latestBuild: old }; let submissions = 0; const submit = deferred();
  const api = { list: async () => [{ id: 'a', name: 'a', language: 'en' }], read: async () => doc,
    save: async (id, payload) => ({ ...doc, revision: payload.expectedRevision + 1, name: payload.name, data: payload.data }),
    submitBuild: async () => { submissions++; await submit.promise; return { ...old, id: 'fixed', revision: 1, status: 'running' }; }, readBuild: async id => ({ ...old, id, revision: 1, status: 'failed' }) };
  const workspace = mountWorkspace(host, { api }); t.after(() => workspace.destroy()); await settle();
  assert.match(host.all().find(n => n.id === 'build-status').textContent, /旧内容/);
  const compiling = host.all().find(n => n.id === 'compile-button').fire('click'); await settle();
  assert.equal(host.all().find(n => n.id === 'build-preparation')?.hidden, false);
  submit.resolve(); await compiling;
  assert.match(host.all().find(n => n.id === 'build-status').textContent, /正在编译.*修订 1.*旧内容.*修订 0/);
  const input = host.all().find(n => n.className === 'document-title').children[1]; input.value = 'New title'; await input.fire('input');
  assert.equal(host.all().find(n => n.id === 'compile-button').disabled, true); assert.equal(submissions, 1);
  t.mock.timers.tick(1000); await settle();
  assert.match(host.all().find(n => n.id === 'build-status').textContent, /编译失败/);
  assert.equal(host.all().find(n => n.id === 'download-pdf').href, '/api/builds/old/pdf?download=1');
  assert.equal(workspace.getDraft().name, 'New title');
});
test('backup download waits for saved revision and backup import creates independent document', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const host = installDom(t); const { mountWorkspace } = await import('../web/app.mjs');
  const doc = id => ({ schemaVersion: 1, id, name: id, revision: 0, data: createEmptyData('en'), latestBuild: null }); const pending = deferred(); let imported = null;
  const api = { list: async () => [{ id: 'a', name: 'a', language: 'en' }], read: async id => doc(id), save: async (id, payload) => { await pending.promise; return { ...doc(id), revision: 1, data: payload.data, name: payload.name }; }, importBackup: async file => { imported = file; return doc('imported'); } };
  const workspace = mountWorkspace(host, { api }); t.after(() => workspace.destroy()); await settle();
  const name = host.all().find(n => n.className === 'document-title').children[1]; name.value = 'saved'; await name.fire('input');
  const backup = host.all().find(n => n.id === 'backup-button').fire('click'); await settle();
  assert.equal(document.created.filter(n => n.download).length, 0);
  pending.resolve(); await backup;
  assert.equal(document.created.find(n => n.download).href, '/api/resumes/a/backup');
  const file = new Blob(['{}'], { type: 'application/json' }); const input = host.all().find(n => n.type === 'file'); input.files = [file]; await input.fire('change');
  assert.equal(imported, file); assert.equal(workspace.getDraft().resumeId, 'imported');
});
test('conflict copy submits retained page draft without overwriting source', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const host = installDom(t); const { mountWorkspace } = await import('../web/app.mjs');
  const doc = id => ({ schemaVersion: 1, id, name: id, revision: 0, data: createEmptyData('en'), latestBuild: null }); let copyPayload; let saves = 0;
  const api = { list: async () => [{ id: 'a', name: 'a', language: 'en' }], read: async id => doc(id), save: async () => { saves++; throw { status: 409, code: 'REVISION_CONFLICT' }; }, copy: async (id, payload) => { copyPayload = { id, payload }; return { ...doc('copy'), data: { ...payload.draft, language: payload.language } }; } };
  const workspace = mountWorkspace(host, { api }); t.after(() => workspace.destroy()); await settle();
  const input = host.all().find(n => n.className === 'field-grid').children[0].children[1]; input.value = 'Retained'; await input.fire('input');
  await host.all().find(n => n.id === 'save-button').fire('click');
  await host.all().find(n => n.textContent === '复制').fire('click');
  await host.all().find(n => n.tagName === 'dialog').children[0].fire('submit');
  assert.equal(saves, 1); assert.equal(copyPayload.id, 'a'); assert.equal(copyPayload.payload.draft.profile.name, 'Retained');
  assert.equal(workspace.getDraft().resumeId, 'copy'); assert.equal(workspace.getDraft().data.language, 'zh-CN');
  assert.equal(host.all().find(n => n.className === 'app-error').hidden, true);
});
