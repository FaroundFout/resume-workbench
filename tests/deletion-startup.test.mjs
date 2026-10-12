import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { startServer } from '../server/index.mjs';
import { createStore } from '../server/storage.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'PureCV empty startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(project, 'samples'), join(root, 'samples'), { recursive: true });
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const dataDir = join(root, 'data');
  await writeFile(join(root, 'config.local.json'), JSON.stringify({ port, dataDir, xelatexPath: 'missing-xelatex.exe' }));
  return { root, dataDir };
}
async function libraryAtStartup(root) {
  const { server, url } = await startServer(root, { openBrowser: false });
  try {
    const response = await fetch(url + '/api/resumes');
    assert.equal(response.status, 200);
    return (await response.json()).resumes;
  } finally { await server.shutdown(); }
}
async function emptyLibrary({ root, dataDir }, resumes) {
  const removed = join(root, 'intentionally removed');
  await mkdir(removed);
  for (const { id } of resumes) await rename(join(dataDir, 'resumes', id), join(removed, id));
}

test('a seeded library stays empty after every resume is deleted and the server restarts', async t => {
  const f = await fixture(t);
  const seeded = await libraryAtStartup(f.root);
  assert.equal(seeded.length, 2);
  assert.deepEqual(seeded.map(doc => doc.language).sort(), ['en', 'zh-CN']);
  assert.deepEqual((await libraryAtStartup(f.root)).map(doc => doc.id).sort(), seeded.map(doc => doc.id).sort());
  await emptyLibrary(f, seeded);
  assert.deepEqual(await libraryAtStartup(f.root), []);
  assert.deepEqual(await libraryAtStartup(f.root), []);
});

test('a legacy nonempty library is recognized before it is intentionally emptied', async t => {
  const f = await fixture(t);
  const store = await createStore({ dataDir: f.dataDir });
  const legacy = await store.create({ name: 'Existing personal resume', language: 'en' });
  const resumes = await libraryAtStartup(f.root);
  assert.deepEqual(resumes.map(doc => doc.id), [legacy.id]);
  await emptyLibrary(f, resumes);
  assert.deepEqual(await libraryAtStartup(f.root), []);
});

test('failed initial example loading leaves initialization retryable without partial seeds', async t => {
  const f = await fixture(t);
  const example = join(f.root, 'samples', 'resume.en.json');
  const saved = join(f.root, 'saved example.json');
  await rename(example, saved);
  await assert.rejects(startServer(f.root, { openBrowser: false }), { code: 'ENOENT' });
  const store = await createStore({ dataDir: f.dataDir });
  assert.deepEqual(await store.list(), []);
  await rename(saved, example);
  assert.equal((await libraryAtStartup(f.root)).length, 2);
});

test('failed initial seed validation removes only the new examples and permits a complete retry', async t => {
  const f = await fixture(t);
  const example = join(f.root, 'samples', 'resume.en.json');
  await writeFile(example, JSON.stringify({ language: 'en' }));
  await assert.rejects(startServer(f.root, { openBrowser: false }), { code: 'VALIDATION_ERROR' });
  const store = await createStore({ dataDir: f.dataDir });
  assert.deepEqual(await store.list(), []);
  await cp(join(project, 'samples', 'resume.en.json'), example);
  assert.equal((await libraryAtStartup(f.root)).length, 2);
});
