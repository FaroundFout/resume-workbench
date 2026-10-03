import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withStore } from './helpers/store.mjs';
import { createStore } from '../server/storage.mjs';
import { putAsset, readAsset } from '../server/assets.mjs';

const png = () => readFile(new URL('./fixtures/logo.png', import.meta.url));
const code = expected => error => error.code === expected;
const record = (doc, index, status = 'running') => ({
  id: randomUUID(), resumeId: doc.id, revision: doc.revision, status,
  createdAt: `2026-10-02T00:00:${String(index).padStart(2, '0')}.000Z`,
  finishedAt: status === 'running' ? null : '2026-10-02T00:01:00.000Z',
  pages: status === 'succeeded' ? 1 : null, warnings: [], error: null,
});

test('simultaneous writes cannot both accept revision zero', async () => {
  await withStore(async store => {
    const doc = await store.create({ name: '示例', language: 'zh-CN' });
    const results = await Promise.allSettled([
      store.save(doc.id, { expectedRevision: 0, data: doc.data }),
      store.save(doc.id, { expectedRevision: 0, data: doc.data }),
    ]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(results.find(x => x.status === 'rejected').reason.code, 'REVISION_CONFLICT');
    assert.equal((await store.read(doc.id)).revision, 1);
    await assert.rejects(store.capture(doc.id, 0), code('REVISION_CONFLICT'));
  });
});

test('restart preserves independent documents, section order and owned logo', async () => {
  await withStore(async (store, dataDir) => {
    const doc = await store.create({ name: '示例', language: 'zh-CN' });
    const bytes = await png();
    const asset = await putAsset(store, doc.id, bytes);
    doc.data.sectionOrder.reverse();
    doc.data.profile.name = '张示例';
    doc.data.logo = { mode: 'custom', assetId: asset.id, widthCm: 2.1 };
    const saved = await store.save(doc.id, { expectedRevision: 0, name: '修改', data: doc.data });
    saved.data.profile.name = '不能回写';
    const reopened = await createStore({ dataDir });
    const restored = await reopened.read(doc.id);
    assert.equal(restored.name, '修改');
    assert.equal(restored.revision, 1);
    assert.equal(restored.data.profile.name, '张示例');
    assert.deepEqual(restored.data.sectionOrder, ['social', 'awards', 'skills', 'projects', 'experience', 'education']);
    assert.deepEqual(await readAsset(reopened, doc.id, asset.id), bytes);
    assert.deepEqual((await reopened.list()).map(x => x.id), [doc.id]);
    assert.deepEqual((await reopened.capture(doc.id, 1)).logoImage.bytes, bytes);
    assert.equal((await readdir(join(dataDir, 'resumes', doc.id))).some(x => x.endsWith('.tmp')), false);
  });
});

test('copies a draft to English with fresh resume and hidden logo references', async () => {
  await withStore(async store => {
    const original = await store.create({ name: '中文', language: 'zh-CN' });
    const asset = await putAsset(store, original.id, await png());
    original.data.logo = { mode: 'hidden', assetId: asset.id, widthCm: 2.4 };
    await store.save(original.id, { expectedRevision: 0, data: original.data });
    const draft = structuredClone(original.data);
    draft.profile.name = 'Draft';
    const copy = await store.copy(original.id, { name: 'English', language: 'en', draft });
    assert.notEqual(copy.id, original.id);
    assert.equal(copy.revision, 0);
    assert.equal(copy.data.language, 'en');
    assert.equal(copy.data.profile.name, 'Draft');
    assert.notEqual(copy.data.logo.assetId, asset.id);
    assert.equal(copy.data.logo.mode, 'hidden');
    assert.deepEqual(await readAsset(store, copy.id, copy.data.logo.assetId), await png());
    assert.deepEqual((await store.capture(copy.id, 0)).logoImage.bytes, await png());
    assert.equal((await store.read(original.id)).data.profile.name, '');
    await assert.rejects(readAsset(store, copy.id, asset.id), code('NOT_FOUND'));
  });
});

test('foreign assets, traversal, invalid drafts and revisions fail without changing data', async () => {
  await withStore(async store => {
    const a = await store.create({ name: 'A', language: 'en' });
    const b = await store.create({ name: 'B', language: 'en' });
    const asset = await putAsset(store, a.id, await png());
    b.data.logo = { mode: 'custom', assetId: asset.id, widthCm: 2.4 };
    await assert.rejects(store.save(b.id, { expectedRevision: 0, data: b.data }), code('NOT_FOUND'));
    await assert.rejects(store.create({ name: 'Bad seed', language: 'en', seed: b.data }), code('VALIDATION_ERROR'));
    await assert.rejects(store.read('../outside'), code('VALIDATION_ERROR'));
    await assert.rejects(store.save(a.id, { expectedRevision: -1, data: a.data }), code('VALIDATION_ERROR'));
    a.data.layout.marginMm = 21;
    await assert.rejects(store.save(a.id, { expectedRevision: 0, data: a.data }), code('VALIDATION_ERROR'));
    assert.equal((await store.read(b.id)).revision, 0);
    assert.equal((await store.list()).length, 2);
  });
});

test('save snapshots caller data before asynchronous work and capture owns its bytes', async () => {
  await withStore(async store => {
    const doc = await store.create({ name: 'A', language: 'en' });
    const asset = await putAsset(store, doc.id, await png());
    doc.data.profile.name = 'Submitted';
    doc.data.logo = { mode: 'custom', assetId: asset.id, widthCm: 2.4 };
    const pending = store.save(doc.id, { expectedRevision: 0, data: doc.data });
    doc.data.profile.name = 'Later edit';
    await pending;
    const snapshot = await store.capture(doc.id, 1);
    assert.equal(snapshot.data.profile.name, 'Submitted');
    snapshot.logoImage.bytes.fill(0);
    assert.deepEqual((await store.capture(doc.id, 1)).logoImage.bytes, await png());
  });
});

test('build recovery and retention preserve newest success separately from content revision', async () => {
  await withStore(async (store, dataDir) => {
    const doc = await store.create({ name: 'A', language: 'en' });
    const successes = [];
    for (let i = 0; i < 7; i++) {
      const build = record(doc, i);
      await store.registerBuild(build);
      await writeFile(join(store.buildDirectory(build.id), 'resume.pdf'), 'test pdf');
      successes.push(await store.publishBuild({ ...build, status: 'succeeded', pages: 1, finishedAt: '2026-10-02T00:01:00.000Z' }));
    }
    const oldFailure = record(doc, 7);
    await store.registerBuild(oldFailure);
    await store.publishBuild({ ...oldFailure, status: 'failed', finishedAt: '2026-10-02T00:01:00.000Z', error: { code: 'COMPILE_FAILED' } });
    const running = record(doc, 8);
    await store.registerBuild(running);
    const reopened = await createStore({ dataDir });
    await reopened.recoverBuilds();
    assert.equal((await reopened.readBuild(running.id)).status, 'interrupted');
    assert.equal((await reopened.latestSuccessfulBuild(doc.id)).id, successes[6].id);
    assert.equal((await reopened.read(doc.id)).revision, 0);
    await reopened.pruneBuilds(doc.id);
    await assert.rejects(reopened.readBuild(successes[0].id), code('NOT_FOUND'));
    await assert.rejects(reopened.readBuild(successes[1].id), code('NOT_FOUND'));
    await assert.rejects(reopened.readBuild(oldFailure.id), code('NOT_FOUND'));
    assert.equal((await reopened.readBuild(running.id)).status, 'interrupted');
    assert.equal((await readdir(join(dataDir, 'builds'))).length, 6);
    assert.equal(await readFile(join(reopened.buildDirectory(successes[6].id), 'resume.pdf'), 'utf8'), 'test pdf');
  });
});

test('invalid and duplicate build publication cannot alter identity or content', async () => {
  await withStore(async store => {
    const doc = await store.create({ name: 'A', language: 'en' });
    const build = record(doc, 0);
    await store.registerBuild(build);
    await assert.rejects(store.registerBuild(build), code('BUILD_CONFLICT'));
    await assert.rejects(store.publishBuild({ ...build, revision: 4, status: 'failed', finishedAt: '2026-10-02T00:01:00.000Z' }), code('BUILD_CONFLICT'));
    await store.publishBuild({ ...build, status: 'succeeded', pages: 1, finishedAt: '2026-10-02T00:01:00.000Z' });
    await assert.rejects(store.publishBuild({ ...build, status: 'failed', finishedAt: '2026-10-02T00:01:00.000Z' }), code('BUILD_CONFLICT'));
    assert.equal((await store.readBuild(build.id)).status, 'succeeded');
    assert.equal((await store.read(doc.id)).revision, 0);
    assert.equal(await store.latestSuccessfulBuild(randomUUID()), null);
  });
});

// Regression: Windows virus scanners/file indexers may temporarily deny replacement.
// The real store must retain the old complete record throughout bounded retry.
test('transient rename denial preserves old record then atomically saves new revision', async t => {
  const fs = await import('node:fs/promises');
  const { syncBuiltinESMExports } = await import('node:module');
  await withStore(async (store, dataDir) => {
    const doc = await store.create({ name: 'old', language: 'en' });
    const target = join(dataDir, 'resumes', doc.id, 'resume.json');
    const renameReal = fs.default.rename;
    let denials = 0;
    t.mock.method(fs.default, 'rename', async (from, to) => {
      if (to === target && denials++ < 2) {
        assert.equal(JSON.parse(await readFile(target, 'utf8')).revision, 0);
        throw Object.assign(new Error('transient share denial'), { code: 'EPERM' });
      }
      return renameReal(from, to);
    });
    syncBuiltinESMExports();
    try {
      const saved = await store.save(doc.id, { expectedRevision: 0, name: 'new', data: doc.data });
      assert.equal(saved.revision, 1);
      assert.equal((await store.read(doc.id)).name, 'new');
      assert.deepEqual(await readdir(join(dataDir, 'resumes', doc.id)), ['assets', 'resume.json']);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
});

test('permanent rename denial fails boundedly without deleting old record or leaking temp files', async t => {
  const fs = await import('node:fs/promises');
  const { syncBuiltinESMExports } = await import('node:module');
  await withStore(async (store, dataDir) => {
    const doc = await store.create({ name: 'old', language: 'en' });
    const target = join(dataDir, 'resumes', doc.id, 'resume.json');
    const before = await readFile(target);
    const renameReal = fs.default.rename;
    let attempts = 0;
    t.mock.method(fs.default, 'rename', async (from, to) => {
      if (to === target) { attempts++; throw Object.assign(new Error('permanent denial'), { code: 'EPERM' }); }
      return renameReal(from, to);
    });
    syncBuiltinESMExports();
    const started = Date.now();
    try {
      await assert.rejects(store.save(doc.id, { expectedRevision: 0, name: 'new', data: doc.data }), code('EPERM'));
      assert.ok(attempts > 1 && attempts <= 6);
      assert.ok(Date.now() - started < 3000);
      assert.deepEqual(await readFile(target), before);
      assert.deepEqual(await readdir(join(dataDir, 'resumes', doc.id)), ['assets', 'resume.json']);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
});
