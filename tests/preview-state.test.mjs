import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorState } from '../web/state.mjs';
import { mountPreview } from '../web/preview.mjs';
import { createEmptyData } from '../web/shared/model.mjs';
import { deferred, settle } from './helpers/save.mjs';

const build = (id, revision, status) => ({ id, resumeId: 'a', revision, status, createdAt: '2026-10-02T00:00:00Z', finishedAt: status === 'running' ? null : '2026-10-02T00:01:00Z', pages: status === 'succeeded' ? 1 : null, warnings: [], error: status === 'failed' ? { message: 'compile failed' } : null });
const saved = { schemaVersion: 1, id: 'a', name: 'A', revision: 2, updatedAt: '2026-10-02T00:00:00Z', data: createEmptyData('en'), latestBuild: build('old', 1, 'succeeded') };

test('preview shows current attempt diagnostics, successful pages, and retains older PDF on package failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const container = dom(t); const pending = deferred();
  const preview = mountPreview(container, { api: { readBuild: () => pending.promise } }); t.after(() => preview.destroy());
  preview.show({ ...build('old', 1, 'succeeded'), pages: 4, warnings: ['Overfull \\hbox (2pt too wide)'] });
  const nodes = () => container.children.flatMap(n => [n, ...n.children]);
  const text = () => nodes().map(n => n.textContent || '').join(' ');
  assert.match(text(), /4 页/); assert.match(text(), /多页/); assert.match(text(), /Overfull/);
  assert.equal(nodes().find(n => n.id === 'build-log').href, '/api/builds/old/log');
  preview.show(build('missing-package', 2, 'running')); t.mock.timers.tick(1000);
  pending.resolve({ ...build('missing-package', 2, 'failed'), error: { code: 'COMPILE_FAILED', message: 'XeLaTeX 编译失败，请查看任务日志' }, warnings: ["LaTeX Error: File 'missing.sty' not found."] });
  await settle();
  assert.match(text(), /missing.sty/); assert.match(text(), /本次失败/); assert.match(text(), /旧内容.*修订 1/);
  assert.equal(nodes().find(n => n.id === 'build-log').href, '/api/builds/missing-package/log');
  assert.equal(nodes().find(n => n.id === 'download-pdf').href, '/api/builds/old/pdf?download=1');
  assert.match(text(), /当前 PDF.*4 页/);
});
// Minimal DOM surface used by the actual preview; no simulated viewer or PDF engine.
class Node { constructor(tag) { this.tagName = tag; this.children = []; this.hidden = false; this.attributes = {}; } append(...nodes) { this.children.push(...nodes); } replaceChildren(...nodes) { this.children = nodes; } setAttribute(key, value) { this.attributes[key] = value; } getAttribute(key) { return this.attributes[key] ?? this[key] ?? null; } removeAttribute(key) { delete this.attributes[key]; delete this[key]; } }
function dom(t) { const previous = globalThis.document; globalThis.document = { createElement: tag => new Node(tag) }; t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }); return new Node('div'); }

test('open restores old successful build and failed newer build retains old PDF', () => {
  const state = createEditorState(saved); assert.equal(state.read().previewDirty, true);
  state.applyBuild(build('new', 2, 'running')); state.applyBuild(build('new', 2, 'failed'));
  assert.equal(state.read().pdfBuild.id, 'old'); assert.equal(state.read().build.status, 'failed');
  const data = createEmptyData('en'); data.profile.name = 'Latest'; state.setDraft(data);
  state.applySaved({ ...saved, revision: 3, data: saved.data });
  assert.equal(state.read().draft.profile.name, 'Latest'); assert.equal(state.read().dirty, true);
});
test('preview polls fixed build at most once per second, stops at terminal state, links same PDF', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const container = dom(t); const queries = []; const statuses = [];
  const api = { readBuild(id) { const pending = deferred(); queries.push({ id, pending }); return pending.promise; } };
  const preview = mountPreview(container, { api, onStatus: value => statuses.push(value) }); t.after(() => preview.destroy());
  preview.show(build('fixed', 2, 'running')); t.mock.timers.tick(999); assert.equal(queries.length, 0);
  t.mock.timers.tick(1); assert.equal(queries[0].id, 'fixed'); t.mock.timers.tick(5000); assert.equal(queries.length, 1);
  queries[0].pending.resolve(build('fixed', 2, 'succeeded')); await settle(); t.mock.timers.tick(5000);
  assert.equal(queries.length, 1); assert.equal(statuses.at(-1).state, 'succeeded');
  const nodes = container.children.flatMap(node => [node, ...node.children]);
  assert.equal(nodes.find(node => node.tagName === 'iframe').src, '/api/builds/fixed/pdf');
  assert.equal(nodes.find(node => node.id === 'download-pdf').href, '/api/builds/fixed/pdf?download=1');
  assert.equal(nodes.find(node => node.target === '_blank').href, '/api/builds/fixed/pdf');
});
test('preview keeps successful PDF after failure and ignores disposed or replaced query', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const container = dom(t); const pending = deferred(); let count = 0;
  const preview = mountPreview(container, { api: { readBuild() { count++; return pending.promise; } } });
  preview.show(build('old', 1, 'succeeded')); preview.show(build('bad', 2, 'failed'));
  assert.equal(container.children.flatMap(n => [n, ...n.children]).find(n => n.tagName === 'iframe').src, '/api/builds/old/pdf');
  preview.show(build('running', 2, 'running')); t.mock.timers.tick(1000); preview.destroy();
  pending.resolve(build('running', 2, 'succeeded')); await settle(); t.mock.timers.tick(5000);
  assert.equal(count, 1); assert.equal(container.children.length, 0);
});
test('temporary query failure keeps PDF and retries after a full second', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const container = dom(t); const calls = [];
  const preview = mountPreview(container, { api: { readBuild(id) { const pending = deferred(); calls.push({ id, pending }); return pending.promise; } } }); t.after(() => preview.destroy());
  preview.show(build('old', 1, 'succeeded')); preview.show(build('fixed', 2, 'running'));
  t.mock.timers.tick(1000); calls[0].pending.reject({ message: '服务暂时不可用' }); await settle();
  assert.match(container.children.find(n => n.id === 'build-status').textContent, /服务暂时不可用/);
  t.mock.timers.tick(999); assert.equal(calls.length, 1); t.mock.timers.tick(1); assert.equal(calls[1].id, 'fixed');
  calls[1].pending.resolve(build('fixed', 2, 'failed')); await settle(); t.mock.timers.tick(5000); assert.equal(calls.length, 2);
  assert.match(container.children.find(n => n.id === 'build-status').textContent, /修订 1/);
});
test('replacement build ignores a stale in-flight response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const container = dom(t); const late = deferred();
  const preview = mountPreview(container, { api: { readBuild: () => late.promise } }); t.after(() => preview.destroy());
  preview.show(build('a', 1, 'running')); t.mock.timers.tick(1000); preview.show(build('b', 2, 'succeeded'));
  late.resolve(build('a', 1, 'succeeded')); await settle();
  assert.equal(container.children.flatMap(n => [n, ...n.children]).find(n => n.id === 'download-pdf').href, '/api/builds/b/pdf?download=1');
});
test('destroy aborts the in-flight build query without later callback or retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const container = dom(t); const statuses = []; const calls = []; let aborted = false;
  const api = { readBuild(id, { signal } = {}) {
    const pending = deferred(); calls.push({ id, signal });
    signal?.addEventListener('abort', () => { aborted = true; pending.reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
    return pending.promise;
  } };
  const preview = mountPreview(container, { api, onStatus: status => statuses.push(status) });
  preview.show(build('fixed', 2, 'running')); t.mock.timers.tick(1000); const count = statuses.length;
  preview.destroy();
  assert.equal(aborted, true); assert.equal(calls[0].signal.aborted, true);
  await settle(); t.mock.timers.tick(5000);
  assert.equal(calls.length, 1); assert.equal(statuses.length, count); assert.equal(container.children.length, 0);
});
test('replacing a preview aborts its old query and polls only the new build after one second', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const container = dom(t); const calls = []; const statuses = [];
  const api = { readBuild(id, { signal } = {}) {
    const pending = deferred(); calls.push({ id, signal, pending });
    signal?.addEventListener('abort', () => pending.reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    return pending.promise;
  } };
  const preview = mountPreview(container, { api, onStatus: status => statuses.push(status) }); t.after(() => preview.destroy());
  preview.show(build('old', 1, 'running')); t.mock.timers.tick(1000); preview.show(build('new', 2, 'running'));
  assert.equal(calls[0].signal?.aborted, true); await settle();
  t.mock.timers.tick(999); assert.equal(calls.length, 1); t.mock.timers.tick(1);
  assert.equal(calls[1].id, 'new'); assert.equal(calls[1].signal.aborted, false);
  calls[1].pending.resolve(build('new', 2, 'succeeded')); await settle(); t.mock.timers.tick(5000);
  assert.equal(calls.length, 2); assert.equal(statuses.at(-1).build.id, 'new'); assert.equal(statuses.at(-1).state, 'succeeded');
});
