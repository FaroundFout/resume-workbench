import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createStore } from '../server/storage.mjs';
import { putAsset, readAsset } from '../server/assets.mjs';
import { withStore } from './helpers/store.mjs';
import { createHttpFixture } from './helpers/http.mjs';
import { createBuildFixture, finish } from './helpers/builds.mjs';

const code = expected => error => error.code === expected;
const missing = error => error.code === 'ENOENT';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const record = (doc, status = 'running') => ({ id: randomUUID(), resumeId: doc.id, revision: doc.revision, status,
  createdAt: '2026-10-11T00:00:00.000Z', finishedAt: status === 'running' ? null : '2026-10-11T00:01:00.000Z',
  pages: status === 'succeeded' ? 1 : null, warnings: [], error: null });

test('DELETE removes a whole resume and its logo and PDF history while preserving another resume', async t => {
  const f = await createHttpFixture(); t.after(() => f.close());
  const create = async name => (await (await f.request('/api/resumes', { method: 'POST', body: { name, language: 'en' } })).json());
  const doc = await create('Delete me'); const other = await create('Keep me');
  const png = await readFile(new URL('./fixtures/logo.png', import.meta.url));
  const asset = await (await f.request(`/api/resumes/${doc.id}/assets`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).json();
  doc.data.logo = { mode: 'custom', assetId: asset.id, widthCm: 2.4 };
  const saved = await (await f.request(`/api/resumes/${doc.id}`, { method: 'PUT', body: { expectedRevision: 0, data: doc.data } })).json();
  const build = await (await f.request(`/api/resumes/${doc.id}/builds`, { method: 'POST', body: { expectedRevision: saved.revision } })).json();
  await finish(f.builds, build.id);
  const otherBuild = await (await f.request(`/api/resumes/${other.id}/builds`, { method: 'POST', body: { expectedRevision: 0 } })).json();
  await finish(f.builds, otherBuild.id);
  const foreign = join(f.store.dataDir, 'builds', 'foreign-not-a-build');
  await mkdir(foreign); await writeFile(join(foreign, 'keep.txt'), 'keep');

  const deleted = await f.request(`/api/resumes/${doc.id}`, { method: 'DELETE', body: { expectedRevision: saved.revision } });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { id: doc.id, deleted: true });
  assert.deepEqual((await (await f.request('/api/resumes')).json()).resumes.map(x => x.id), [other.id]);
  for (const path of [`/api/resumes/${doc.id}`, `/api/resumes/${doc.id}/backup`, `/api/resumes/${doc.id}/assets/${asset.id}`,
    `/api/builds/${build.id}`, `/api/builds/${build.id}/pdf`, `/api/builds/${build.id}/log`]) {
    assert.equal((await f.request(path)).status, 404, path);
  }
  await assert.rejects(access(join(f.store.dataDir, 'resumes', doc.id)), missing);
  await assert.rejects(access(f.store.buildDirectory(build.id)), missing);
  assert.equal((await f.request(`/api/builds/${otherBuild.id}/pdf`)).status, 200);
  assert.equal(await readFile(join(foreign, 'keep.txt'), 'utf8'), 'keep');
  const reopened = await createStore({ dataDir: f.store.dataDir });
  assert.deepEqual((await reopened.list()).map(x => x.id), [other.id]);
});

test('DELETE rejects invalid or stale revisions and cross-origin requests without touching data', async t => {
  const f = await createHttpFixture(); t.after(() => f.close());
  const doc = await (await f.request('/api/resumes', { method: 'POST', body: { name: 'Keep me', language: 'en' } })).json();
  await f.store.save(doc.id, { expectedRevision: 0, data: doc.data });
  for (const expectedRevision of [undefined, -1, 0.5, '1']) {
    assert.equal((await f.request(`/api/resumes/${doc.id}`, { method: 'DELETE', body: { expectedRevision } })).status, 400);
  }
  const stale = await f.request(`/api/resumes/${doc.id}`, { method: 'DELETE', body: { expectedRevision: 0 } });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).error.code, 'REVISION_CONFLICT');
  assert.equal((await f.request('/api/resumes/not-an-id', { method: 'DELETE', body: { expectedRevision: 1 } })).status, 400);
  assert.equal((await f.request(`/api/resumes/${randomUUID()}`, { method: 'DELETE', body: { expectedRevision: 0 } })).status, 404);
  const forbidden = await f.request(`/api/resumes/${doc.id}`, { method: 'DELETE', headers: { Origin: 'https://example.invalid' }, body: { expectedRevision: 1 } });
  assert.equal(forbidden.status, 403);
  assert.equal((await f.store.read(doc.id)).revision, 1);
});

test('store deletion waits for a pending save and never lets a later save resurrect the document', async t => {
  const fs = await import('node:fs/promises');
  await withStore(async (store, dataDir) => {
    const doc = await store.create({ name: 'old', language: 'en' });
    const started = deferred(); const release = deferred();
    const target = join(dataDir, 'resumes', doc.id, 'resume.json');
    const real = fs.default.rename;
    t.mock.method(fs.default, 'rename', async (from, to) => {
      if (to === target) { started.resolve(); await release.promise; }
      return real(from, to);
    }); syncBuiltinESMExports();
    try {
      const saving = store.save(doc.id, { expectedRevision: 0, name: 'saved', data: doc.data });
      await started.promise;
      const removing = store.remove(doc.id, { expectedRevision: 0 });
      release.resolve(); await saving;
      await assert.rejects(removing, code('REVISION_CONFLICT'));
      assert.equal((await store.read(doc.id)).name, 'saved');
      const deleting = store.remove(doc.id, { expectedRevision: 1 });
      const lateSave = store.save(doc.id, { expectedRevision: 1, data: doc.data });
      await deleting; await assert.rejects(lateSave, code('NOT_FOUND'));
      assert.deepEqual(await store.list(), []);
    } finally { release.resolve(); t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
});

test('running stored builds prevent direct deletion until recovery marks them interrupted', async () => {
  await withStore(async store => {
    const doc = await store.create({ name: 'running', language: 'en' });
    const build = record(doc); await store.registerBuild(build);
    await assert.rejects(store.remove(doc.id, { expectedRevision: 0 }), code('RESUME_BUSY'));
    assert.equal((await store.read(doc.id)).revision, 0);
    await store.recoverBuilds();
    assert.deepEqual(await store.remove(doc.id, { expectedRevision: 0 }), { id: doc.id, deleted: true });
    await assert.rejects(store.readBuild(build.id), code('NOT_FOUND'));
  });
});

test('deletion is blocked during compiler detection before a build record exists', async () => {
  const entered = deferred(); const release = deferred();
  const f = await createBuildFixture({ detect: async () => { entered.resolve(); await release.promise; return { available: true, executable: 'controlled', message: 'ready' }; } });
  let submitted;
  try {
    submitted = f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 });
    await entered.promise;
    await assert.rejects(f.manager.removeResume({ resumeId: f.doc.id, expectedRevision: 0 }), code('RESUME_BUSY'));
    assert.deepEqual(await readdir(join(f.dataDir, 'builds')), []);
    const other = await f.store.create({ name: 'other', language: 'en' });
    assert.deepEqual(await f.manager.removeResume({ resumeId: other.id, expectedRevision: 0 }), { id: other.id, deleted: true });
    release.resolve(); await finish(f.manager, (await submitted).id);
  } finally { release.resolve(); if (submitted) await submitted.catch(() => {}); await f.close(); }
});

test('deletion stays blocked through terminal build publication and retention cleanup', async () => {
  const entered = deferred(); const release = deferred();
  const f = await createBuildFixture();
  const prune = f.store.pruneBuilds;
  f.store.pruneBuilds = async (...args) => { entered.resolve(); await release.promise; return prune(...args); };
  try {
    const build = await f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 });
    await entered.promise;
    assert.equal((await f.store.readBuild(build.id)).status, 'succeeded');
    await assert.rejects(f.manager.removeResume({ resumeId: f.doc.id, expectedRevision: 0 }), code('RESUME_BUSY'));
    release.resolve(); await finish(f.manager, build.id);
    await f.manager.removeResume({ resumeId: f.doc.id, expectedRevision: 0 });
    await assert.rejects(f.manager.pdfPath(build.id), code('NOT_FOUND'));
  } finally { release.resolve(); f.store.pruneBuilds = prune; await f.close(); }
});

test('a deletion reservation prevents new builds of that resume while another resume can compile', async () => {
  const entered = deferred(); const release = deferred();
  const f = await createBuildFixture();
  const remove = f.store.remove;
  f.store.remove = async (...args) => { entered.resolve(); await release.promise; return remove(...args); };
  let removing;
  try {
    removing = f.manager.removeResume({ resumeId: f.doc.id, expectedRevision: 0 });
    await entered.promise;
    await assert.rejects(f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 }), code('RESUME_DELETING'));
    await assert.rejects(f.manager.removeResume({ resumeId: f.doc.id, expectedRevision: 0 }), code('RESUME_DELETING'));
    const other = await f.store.create({ name: 'keep compiling', language: 'en' });
    const build = await f.manager.submit({ resumeId: other.id, expectedRevision: 0 });
    assert.equal((await finish(f.manager, build.id)).status, 'succeeded');
    release.resolve(); await removing;
    assert.equal((await f.store.read(other.id)).revision, 0);
  } finally { release.resolve(); if (removing) await removing.catch(() => {}); f.store.remove = remove; await f.close(); }
});

test('a failed deletion releases its reservation so the retained resume can still compile', async () => {
  const f = await createBuildFixture();
  try {
    await f.store.save(f.doc.id, { expectedRevision: 0, data: f.doc.data });
    await assert.rejects(f.manager.removeResume({ resumeId: f.doc.id, expectedRevision: 0 }), code('REVISION_CONFLICT'));
    const build = await f.manager.submit({ resumeId: f.doc.id, expectedRevision: 1 });
    assert.equal((await finish(f.manager, build.id)).status, 'succeeded');
  } finally { await f.close(); }
});

test('Windows rename denial leaves a complete visible resume and its PDF intact', async t => {
  const fs = await import('node:fs/promises');
  const f = await createBuildFixture();
  const build = await f.submitAndFinish();
  const directory = join(f.dataDir, 'resumes', f.doc.id);
  const before = await readFile(join(directory, 'resume.json'));
  const real = fs.default.rename;
  t.mock.method(fs.default, 'rename', async (from, to) => {
    if (from === directory) throw Object.assign(new Error('locked directory'), { code: 'EPERM' });
    return real(from, to);
  }); syncBuiltinESMExports();
  const started = Date.now();
  try {
    await assert.rejects(f.manager.removeResume({ resumeId: f.doc.id, expectedRevision: 0 }), code('EPERM'));
    assert.ok(Date.now() - started < 3000);
    assert.deepEqual(await readFile(join(directory, 'resume.json')), before);
    assert.deepEqual((await f.store.list()).map(x => x.id), [f.doc.id]);
    assert.equal(await f.readPdf(build.id), '%PDF-first');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

test('cleanup denial after atomic removal cannot restore the resume or expose leftover PDF and logs', async t => {
  const fs = await import('node:fs/promises');
  const f = await createBuildFixture();
  const png = await readFile(new URL('./fixtures/logo.png', import.meta.url));
  const asset = await putAsset(f.store, f.doc.id, png);
  const build = await f.submitAndFinish();
  const real = fs.default.rm;
  const buildDirectory = f.store.buildDirectory(build.id);
  t.mock.method(fs.default, 'rm', async (path, options) => {
    if (path === buildDirectory || String(path).includes(`.deleted-${f.doc.id}`)) throw Object.assign(new Error('locked cleanup'), { code: 'EPERM' });
    return real(path, options);
  }); syncBuiltinESMExports();
  try {
    assert.deepEqual(await f.manager.removeResume({ resumeId: f.doc.id, expectedRevision: 0 }), { id: f.doc.id, deleted: true });
    assert.deepEqual(await f.store.list(), []);
    await assert.rejects(f.store.read(f.doc.id), code('NOT_FOUND'));
    await assert.rejects(readAsset(f.store, f.doc.id, asset.id), code('NOT_FOUND'));
    await assert.rejects(f.store.readBuild(build.id), code('NOT_FOUND'));
    await assert.rejects(f.manager.pdfPath(build.id), code('NOT_FOUND'));
    await assert.rejects(f.manager.logPath(build.id), code('NOT_FOUND'));
    assert.equal(await readFile(join(buildDirectory, 'resume.pdf'), 'utf8'), '%PDF-first');
    const leftovers = (await readdir(join(f.dataDir, 'resumes'))).filter(x => x.startsWith(`.deleted-${f.doc.id}`));
    assert.equal(leftovers.length, 1);
    assert.deepEqual(await readFile(join(f.dataDir, 'resumes', leftovers[0], 'assets', asset.id)), png);
    const reopened = await createStore({ dataDir: f.dataDir });
    assert.deepEqual(await reopened.list(), []);
    await assert.rejects(reopened.readBuild(build.id), code('NOT_FOUND'));
    await reopened.recoverBuilds();
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

test('a resume disappearing between list enumeration and reading does not fail the whole list', async t => {
  const fs = await import('node:fs/promises');
  await withStore(async (store, dataDir) => {
    const doc = await store.create({ name: 'race', language: 'en' });
    const other = await store.create({ name: 'still visible', language: 'en' });
    const path = join(dataDir, 'resumes', doc.id, 'resume.json');
    const realRead = fs.default.readFile; const realRename = fs.default.rename;
    let removed = false;
    t.mock.method(fs.default, 'readFile', async (input, ...args) => {
      if (input === path && !removed) {
        removed = true;
        await realRename(join(dataDir, 'resumes', doc.id), join(dataDir, 'resumes', `.deleted-${doc.id}`));
      }
      return realRead(input, ...args);
    }); syncBuiltinESMExports();
    try { assert.deepEqual((await store.list()).map(x => x.id), [other.id]); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
});
