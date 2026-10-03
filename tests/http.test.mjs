import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createHttpFixture } from './helpers/http.mjs';

async function fixture(t, options) { const f = await createHttpFixture(options); t.after(() => f.close()); return f; }
async function create(f) { const r = await f.request('/api/resumes', { method: 'POST', body: { name: '虚构示例', language: 'en' } }); assert.equal(r.status, 201); return r.json(); }
function raw(f, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(f.url + '/', { path, headers }, res => { let body = ''; res.on('data', x => body += x); res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers })); }); req.on('error', reject);
  });
}

test('cross-origin and absent-origin writes cannot alter storage', async t => {
  const f = await fixture(t);
  for (const origin of ['https://example.invalid', 'null', `http://127.0.0.1:${f.server.address().port + 1}`, undefined]) {
    const headers = { 'Content-Type': 'application/json' }; if (origin !== undefined) headers.Origin = origin;
    const r = await fetch(f.url + '/api/resumes', { method: 'POST', headers, body: '{"name":"拒绝创建","language":"en"}' });
    assert.equal(r.status, 403); assert.equal(r.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await f.store.list()).length, 0);
  assert.equal((await f.request('/api/resumes', { method: 'POST', headers: { Origin: `http://localhost:${f.server.address().port}` }, body: { name: '可保存', language: 'zh-CN' } })).status, 201);
});

test('rejects foreign Host, traversal, malformed IDs, and serves only web files', async t => {
  const f = await fixture(t);
  for (const host of ['example.invalid', `127.0.0.1:${f.server.address().port + 1}`, `localhost:${f.server.address().port}.evil`]) assert.equal((await raw(f, '/api/resumes', { Host: host })).status, 403);
  for (const path of ['/../server/config.mjs', '/%2e%2e/server/config.mjs', '/web%2f..%2fserver/config.mjs', '/%5c..%5cserver/config.mjs']) assert.equal((await raw(f, path)).status, 400);
  assert.equal((await f.request('/api/resumes/not-an-id')).status, 400);
  assert.equal((await f.request('/server/storage.mjs')).status, 404);
  assert.equal((await f.request('/')).status, 200);
  assert.match((await f.request('/shared/model.mjs')).headers.get('content-type'), /javascript/);
});

test('CRUD uses revision conflicts and preserves independent latest successful build', async t => {
  const f = await fixture(t); const doc = await create(f);
  const list = await (await f.request('/api/resumes')).json(); assert.deepEqual(Object.keys(list.resumes[0]).sort(), ['id', 'language', 'name', 'revision', 'updatedAt']);
  assert.equal((await (await f.request(`/api/resumes/${doc.id}`)).json()).latestBuild, null);
  const saved = await f.request(`/api/resumes/${doc.id}`, { method: 'PUT', body: { expectedRevision: 0, name: '已保存', data: doc.data } }); assert.equal(saved.status, 200); assert.equal((await saved.json()).revision, 1);
  const conflict = await f.request(`/api/resumes/${doc.id}`, { method: 'PUT', body: { expectedRevision: 0, data: doc.data } }); assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, 'REVISION_CONFLICT');
  const copied = await f.request(`/api/resumes/${doc.id}/copy`, { method: 'POST', body: { name: '中文副本', language: 'zh-CN', draft: doc.data } }); assert.equal(copied.status, 201); const copy = await copied.json(); assert.notEqual(copy.id, doc.id); assert.equal(copy.data.language, 'zh-CN');
});

test('separate JSON, image and backup limits reject excess bytes without writes', async t => {
  const f = await fixture(t); const doc = await create(f);
  for (const [path, limit, mime] of [['/api/resumes', 2, 'application/json'], [`/api/resumes/${doc.id}/assets`, 5, 'image/png'], ['/api/backups/import', 10, 'application/json']]) {
    assert.equal((await f.request(path, { method: 'POST', headers: { 'Content-Type': mime }, body: Buffer.alloc(limit * 1024 * 1024 + 1, 32) })).status, 413);
  }
  assert.equal((await f.store.list()).length, 1);
  assert.equal((await f.request('/api/resumes', { method: 'POST', body: '{broken' })).status, 400);
  assert.equal((await f.request('/api/resumes', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 400);
  // Backup parsing must permit a valid JSON body larger than the ordinary limit.
  const backup = await (await f.request(`/api/resumes/${doc.id}/backup`)).text();
  const padded = backup + ' '.repeat(2 * 1024 * 1024);
  assert.equal((await f.request('/api/backups/import', { method: 'POST', body: padded })).status, 201);
});

test('image uploads require matching MIME and preserve resume ownership through backup import', async t => {
  const f = await fixture(t); const doc = await create(f); const other = await create(f); const png = await readFile(new URL('./fixtures/logo.png', import.meta.url));
  assert.equal((await f.request(`/api/resumes/${doc.id}/assets`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: png })).status, 400);
  const uploaded = await f.request(`/api/resumes/${doc.id}/assets`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png }); assert.equal(uploaded.status, 201); const asset = await uploaded.json();
  const image = await f.request(`/api/resumes/${doc.id}/assets/${asset.id}`); assert.equal(image.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal((await f.request(`/api/resumes/${other.id}/assets/${asset.id}`)).status, 404);
  doc.data.logo = { mode: 'custom', assetId: asset.id, widthCm: 2.4 };
  assert.equal((await f.request(`/api/resumes/${doc.id}`, { method: 'PUT', body: { expectedRevision: 0, data: doc.data } })).status, 200);
  const backup = await f.request(`/api/resumes/${doc.id}/backup`); assert.match(backup.headers.get('content-disposition'), /^attachment;/);
  const imported = await f.request('/api/backups/import', { method: 'POST', body: await backup.text() }); assert.equal(imported.status, 201); const restored = await imported.json(); assert.notEqual(restored.data.logo.assetId, asset.id);
});

test('build publication gates PDFs; revision-specific PDF supports range and stable download', async t => {
  const f = await fixture(t); const doc = await create(f);
  const submitted = await f.request(`/api/resumes/${doc.id}/builds`, { method: 'POST', body: { expectedRevision: 0 } }); assert.equal(submitted.status, 202); const build = await submitted.json();
  for (let i = 0; i < 100; i++) { if ((await (await f.request(`/api/builds/${build.id}`)).json()).status !== 'running') break; await new Promise(r => setTimeout(r, 5)); }
  const view = await (await f.request(`/api/resumes/${doc.id}`)).json(); assert.equal(view.latestBuild.id, build.id); assert.equal(view.revision, 0);
  const path = `/api/builds/${build.id}/pdf`; const pdf = await f.request(path); assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf'); assert.match(pdf.headers.get('content-disposition'), /^inline;/); const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.match((await f.request(path + '?download=1')).headers.get('content-disposition'), /^attachment;/);
  const range = await f.request(path, { headers: { Range: 'bytes=0-4' } }); assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes 0-4/${bytes.length}`); assert.equal(await range.text(), '%PDF-');
  assert.equal((await f.request(path, { headers: { Range: 'bytes=99999-' } })).status, 416);
  doc.data.profile.name = '新版本'; await f.request(`/api/resumes/${doc.id}`, { method: 'PUT', body: { expectedRevision: 0, data: doc.data } });
  assert.deepEqual(Buffer.from(await (await f.request(path)).arrayBuffer()), bytes); assert.equal((await (await f.request(`/api/resumes/${doc.id}`)).json()).latestBuild.revision, 0);
  assert.match(await (await f.request(`/api/builds/${build.id}/log`)).text(), /Output written/);
  const stale = await f.request(`/api/resumes/${doc.id}/builds`, { method: 'POST', body: { expectedRevision: 0 } }); assert.equal(stale.status, 409);
});

test('missing compiler exposes safe diagnostics while editing and backups remain available', async t => {
  const f = await fixture(t, { available: false, environment: { available: false, executable: 'C:/secret.exe', cause: 'C:/private/data', message: '无法执行 C:/private/compiler.exe' } });
  const env = await (await f.request('/api/environment')).json(); assert.deepEqual(Object.keys(env).sort(), ['available', 'message']); assert.equal(env.available, false); assert.doesNotMatch(JSON.stringify(env), /private|secret|C:\//);
  const doc = await create(f); assert.equal((await f.request(`/api/resumes/${doc.id}`, { method: 'PUT', body: { expectedRevision: 0, data: doc.data } })).status, 200);
  assert.equal((await f.request(`/api/resumes/${doc.id}/backup`)).status, 200);
  assert.equal((await f.request(`/api/resumes/${doc.id}/builds`, { method: 'POST', body: { expectedRevision: 1 } })).status, 503);
});

test('PDF route cannot expose unpublished artifacts from a running build', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { prepareGate: gate });
  try {
    const doc = await create(f);
    const build = await (await f.request(`/api/resumes/${doc.id}/builds`, { method: 'POST', body: { expectedRevision: 0 } })).json();
    assert.equal((await f.request(`/api/builds/${build.id}/pdf`)).status, 404);
    assert.equal((await (await f.request(`/api/resumes/${doc.id}`)).json()).latestBuild, null);
  } finally { release(); }
});

test('chunked JSON requests enforce limits without trusting Content-Length', async t => {
  const f = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(f.url + '/api/resumes', { method: 'POST', headers: { Origin: f.url, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject);
    req.write(Buffer.alloc(1024 * 1024, 32)); req.write(Buffer.alloc(1024 * 1024, 32)); req.end('x');
  });
  assert.equal(status, 413); assert.equal((await f.store.list()).length, 0);
});
