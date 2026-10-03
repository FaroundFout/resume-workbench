import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyData } from '../web/shared/model.mjs';
import { moveItem, toggleSection } from '../web/forms/sections.mjs';
import { normalizeRuns } from '../web/rich-text.mjs';
import { createApi } from '../web/api.mjs';
import { createHttpFixture } from './helpers/http.mjs';
import { readFile } from 'node:fs/promises';

test('moves the first item to the last position without losing items or mutating input', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(moveItem(items, 0, 2).map(item => item.id), ['b', 'c', 'a']);
  assert.deepEqual(items.map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(moveItem(items, 2, 0).map(item => item.id), ['c', 'a', 'b']);
});
test('out of bounds moves leave the list intact', () => {
  assert.deepEqual(moveItem(['a', 'b'], 0, -1), ['a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 3, 0), ['a', 'b']);
});
test('hiding and restoring a section retains its data and leaves original untouched', () => {
  const data = createEmptyData('en');
  data.sections.projects.items.push({ id: 'p', name: 'Retained' });
  const hidden = toggleSection(data, 'projects', false);
  assert.equal(hidden.sections.projects.enabled, false);
  assert.equal(data.sections.projects.enabled, true);
  assert.deepEqual(hidden.sections.projects.items, [{ id: 'p', name: 'Retained' }]);
  assert.equal(toggleSection(hidden, 'projects', true).sections.projects.enabled, true);
});
test('normalization merges only adjacent runs with identical formatting', () => {
  assert.deepEqual(normalizeRuns([
    { text: 'a', bold: false, url: null }, { text: '', bold: true, url: null },
    { text: 'b', bold: false, url: null }, { text: 'c', bold: true, url: null },
    { text: 'd', bold: true, url: 'https://example.com' },
    { text: 'e', bold: true, url: 'https://example.com' },
  ]), [
    { text: 'ab', bold: false, url: null }, { text: 'c', bold: true, url: null },
    { text: 'de', bold: true, url: 'https://example.com' },
  ]);
});
test('invalid rich text links produce displayable field errors', () => {
  for (const url of ['javascript:alert(1)', '/relative', 'https://example.com/a b', 'data:text/plain,test']) {
    assert.throws(() => normalizeRuns([{ text: 'link', bold: false, url }]), error =>
      error.code === 'VALIDATION_ERROR' && error.status === 400 && typeof error.message === 'string' &&
      typeof error.fields['runs[0].url'] === 'string');
  }
  assert.deepEqual(normalizeRuns([{ text: 'mail', bold: false, url: 'mailto:hi@example.com' }]),
    [{ text: 'mail', bold: false, url: 'mailto:hi@example.com' }]);
});
test('merged text respects the model run length limit without losing text', () => {
  const runs = normalizeRuns([{ text: 'a'.repeat(10000), bold: false, url: null }, { text: 'b', bold: false, url: null }]);
  assert.deepEqual(runs.map(run => run.text.length), [10000, 1]);
  assert.equal(runs[1].text, 'b');
});

test('API client unwraps summaries, preserves structured errors and transfers backup/images as blobs', async t => {
  const fixture = await createHttpFixture(); t.after(() => fixture.close());
  // Node does not add a browser Origin header; retain real fetch and real local routes.
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options = {}) => realFetch(url, { ...options, headers: { ...options.headers, Origin: fixture.url } }));
  const api = createApi(fixture.url);
  const created = await api.create({ name: 'UI contract', language: 'en' });
  assert.equal((await api.list())[0].id, created.id);
  assert.equal((await api.read(created.id)).latestBuild, null);
  const data = structuredClone(created.data); data.profile.name = 'Alex';
  assert.equal((await api.save(created.id, { expectedRevision: 0, data })).revision, 1);
  await assert.rejects(api.save(created.id, { expectedRevision: 0, data }), error => error.status === 409 && error.code === 'REVISION_CONFLICT' && error.fields.actualRevision === 1);
  const copy = await api.copy(created.id, { name: '副本', language: 'zh-CN', draft: data });
  assert.equal(copy.data.language, 'zh-CN'); assert.equal(copy.data.profile.name, 'Alex');
  const png = await readFile(new URL('./fixtures/logo.png', import.meta.url));
  const asset = await api.uploadAsset(created.id, new Blob([png], { type: 'image/png' }));
  assert.equal(asset.mime, 'image/png'); assert.ok(asset.width > 0);
  const backup = await api.backup(created.id); assert.ok(backup instanceof Blob);
  assert.equal((await api.importBackup(backup)).data.profile.name, 'Alex');
  const build = await api.submitBuild(created.id, { expectedRevision: 1 });
  assert.equal((await api.readBuild(build.id)).resumeId, created.id);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(api.readBuild(build.id, { signal: cancelled.signal }), error => error.code === 'NETWORK_ERROR' && error.status === 0);
});
