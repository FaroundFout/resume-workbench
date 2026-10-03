import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEmptyData, validateResumeData } from '../web/shared/model.mjs';
import { mountLayout } from '../web/forms/layout.mjs';
import { installDom } from './helpers/dom.mjs';
import { withStore } from './helpers/store.mjs';
import { exportBackup, importBackup } from '../server/backups.mjs';
import { renderResume } from '../server/latex/render.mjs';

// Catch rejection/coercion of valid factors and accidental migration of old records.
test('optional numeric body line spacing validates inclusively without injecting legacy fields', () => {
  for (const language of ['zh-CN', 'en']) for (const factor of [undefined, 1, 1.05, 1.2, 1.5]) {
    const data = createEmptyData(language);
    delete data.layout.lineSpacing;
    if (factor !== undefined) data.layout.lineSpacing = factor;
    const before = structuredClone(data);
    assert.deepEqual(validateResumeData(data), { ok: true, value: data });
    assert.deepEqual(data, before);
  }
  for (const value of [0.99, 1.51, NaN, Infinity, '1.2', null, undefined]) {
    const data = createEmptyData('en'); data.layout.lineSpacing = value;
    const result = validateResumeData(data);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.path === 'layout.lineSpacing'));
  }
  for (const mutate of [data => { data.layout.unknown = 1; }, data => { delete data.layout.marginMm; }]) {
    const data = createEmptyData('en'); mutate(data);
    assert.equal(validateResumeData(data).ok, false);
  }
});

// Catch a lost optional factor at real save/reload/copy or portable import boundaries.
test('schema1 save reload copy and portable backups retain bilingual spacing or its legacy absence', async () => {
  for (const language of ['zh-CN', 'en']) for (const factor of [undefined, 1.2, 1.5]) {
    const data = createEmptyData(language); delete data.layout.lineSpacing;
    if (factor !== undefined) data.layout.lineSpacing = factor;
    await withStore(async store => {
      const doc = await store.create({ name: 'Public spacing fixture', language, seed: data });
      await store.save(doc.id, { expectedRevision: 0, data });
      const saved = await store.read(doc.id);
      assert.equal(saved.schemaVersion, 1);
      assert.deepEqual(saved.data, data);
      const copy = await store.copy(doc.id, { name: 'Copy', language: language === 'en' ? 'zh-CN' : 'en', draft: data });
      assert.deepEqual(copy.data.layout, data.layout);
      const bytes = await exportBackup(store, doc.id);
      assert.equal(JSON.parse(bytes).version, 1);
      await withStore(async destination => {
        const restored = await importBackup(destination, bytes);
        assert.equal(restored.schemaVersion, 1);
        assert.deepEqual(restored.data, data);
      });
    });
  }
});

// Exercise the mounted production form, firing its input/reset handlers, rather than grep.
test('line spacing form edits without remounting and reset changes only spacing', async t => {
  const container = installDom(t);
  let data = createEmptyData('zh-CN'); delete data.layout.lineSpacing;
  const original = structuredClone(data);
  let edits = 0;
  const form = mountLayout(container, { data, onChange: next => { data = next; edits++; } });
  const findRange = () => container.all().find(n => n.tagName === 'input' && n.type === 'range');
  const range = findRange(); assert.ok(range, 'Page layout must offer a native body line spacing slider');
  const label = container.all().find(n => n.tagName === 'label' && n.all().includes(range));
  assert.ok(label.all().some(n => n.textContent === '正文行距'), 'Range has a visible associated label');
  assert.equal(Number(range.value), 1);
  assert.equal(Number(range.min), 1); assert.equal(Number(range.max), 1.5); assert.equal(Number(range.step), 0.05);
  const value = container.all().find(n => n.tagName === 'output'); assert.ok(value);
  assert.equal(value.textContent, '1.00');
  assert.ok(range.id && value.getAttribute('for') === range.id, 'Current value is associated with the input');
  assert.equal(range.getAttribute('aria-describedby'), value.id);
  range.value = '1.20'; await range.fire('input');
  assert.equal(data.layout.lineSpacing, 1.2); assert.equal(value.textContent, '1.20');
  assert.equal(findRange(), range, 'Dragging must retain focus and the mounted input');
  range.value = '1.50'; await range.fire('input');
  assert.equal(data.layout.lineSpacing, 1.5);
  const reset = container.all().find(n => n.tagName === 'button' && n.textContent === '恢复默认'); assert.ok(reset);
  await reset.click();
  assert.equal(Number(range.value), 1); assert.equal(value.textContent, '1.00');
  assert.deepEqual(data, { ...original, layout: { ...original.layout, lineSpacing: 1 } });
  assert.equal(edits, 3); assert.deepEqual(original.layout, createEmptyData('zh-CN').layout);
  const next = createEmptyData('en'); next.layout.lineSpacing = 1.35;
  form.update(next);
  assert.equal(Number(findRange().value), 1.35);
  assert.equal(container.all().find(n => n.tagName === 'output').textContent, '1.35');
  form.destroy(); assert.equal(container.children.length, 0);
});

test('legacy and explicit default render identical bilingual LaTeX with unchanged other layout settings', async () => {
  for (const language of ['zh-CN', 'en']) {
    const data = createEmptyData(language); delete data.layout.lineSpacing;
    const dir = language === 'en' ? 'purecv-en' : 'purecv-zh';
    const template = { main: await readFile(new URL(`../templates/${dir}/main.tex`, import.meta.url), 'utf8'), macros: await readFile(new URL('../templates/shared/macros.tex', import.meta.url), 'utf8') };
    const refs = { fontDir: 'resources/font', logoFile: null };
    const legacy = renderResume(data, refs, template);
    data.layout.lineSpacing = 1;
    assert.deepEqual(renderResume(data, refs, template), legacy);
  }
});
