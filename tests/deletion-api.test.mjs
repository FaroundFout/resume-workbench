import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../web/api.mjs';
import { createHttpFixture } from './helpers/http.mjs';

test('browser API deletion sends its revision and removes only the selected resume over HTTP', async t => {
  const f = await createHttpFixture(); t.after(() => f.close());
  const fetch = globalThis.fetch;
  // Browsers supply Origin on same-origin writes; Node fetch needs it explicitly.
  t.mock.method(globalThis, 'fetch', (url, options = {}) => fetch(url, { ...options, headers: { ...options.headers, Origin: f.url } }));
  const api = createApi(f.url);
  const doc = await api.create({ name: 'delete', language: 'en' });
  const other = await api.create({ name: 'keep', language: 'zh-CN' });
  await api.save(doc.id, { expectedRevision: 0, data: doc.data });
  await assert.rejects(api.remove(doc.id, { expectedRevision: 0 }), error => error.code === 'REVISION_CONFLICT' && error.status === 409);
  assert.equal((await api.read(doc.id)).revision, 1);
  await api.remove(doc.id, { expectedRevision: 1 });
  assert.deepEqual((await api.list()).map(d => d.id), [other.id]);
  await assert.rejects(api.read(doc.id), error => error.code === 'NOT_FOUND' && error.status === 404);
});
