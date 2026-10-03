import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateResumeData, createEmptyData } from '../web/shared/model.mjs';
import { importBackup } from '../server/backups.mjs';
import { withStore } from './helpers/store.mjs';
import { normalizeRuns, mountRichText } from '../web/rich-text.mjs';
import { mountProfile } from '../web/forms/profile.mjs';
import { mountSections } from '../web/forms/sections.mjs';
import { installDom, TestNode } from './helpers/dom.mjs';
import { runProcess } from '../server/compiler/process.mjs';

test('duplicate IDs are rejected precisely in contacts and every section before backup publication', async () => {
  const example = JSON.parse(await readFile(new URL('../examples/resume.en.json', import.meta.url)));
  example.sections.social.items = [{ id: 'social', organization: '', role: '', period: '', bullets: [] }];
  example.sections.awards.items = [{ id: 'award', name: '', period: '', issuer: '', description: [] }];
  for (const key of ['contacts', ...example.sectionOrder]) {
    const data = structuredClone(example);
    const items = key === 'contacts' ? data.profile.contacts : data.sections[key].items;
    assert.ok(items.length);
    items.push(structuredClone(items[0]));
    const path = key === 'contacts' ? 'profile.contacts' : `sections.${key}.items`;
    const result = validateResumeData(data);
    assert.equal(result.ok, false, key);
    assert.ok(result.issues.some(issue => issue.path === `${path}[${items.length - 1}].id` && /重复/.test(issue.message)));
    await withStore(async store => {
      await assert.rejects(importBackup(store, Buffer.from(JSON.stringify({ format: 'purecv-backup', version: 1, name: 'Duplicate', data, logoImage: null }))), e => e.code === 'INVALID_BACKUP' && /重复/.test(e.fields?.[`${path}[${items.length - 1}].id`]));
      assert.deepEqual(await store.list(), []);
    });
  }
});

test('validated unique contacts and sections edit and delete one item only', async t => {
  const container = installDom(t);
  document.createTextNode = text => { const n = new TestNode('#text'); n.textContent = text; return n; };
  let data = createEmptyData('en');
  data.profile.contacts = ['a', 'b'].map(id => ({ id, type: 'phone', label: id, value: id }));
  const profile = mountProfile(container, { data, onChange: next => data = next });
  const input = container.all().find(n => n.tagName === 'input' && n.value === 'a');
  input.value = 'changed'; await input.fire('input');
  assert.deepEqual(data.profile.contacts.map(c => c.label), ['changed', 'b']);
  await container.all().find(n => n.getAttribute('aria-label') === '联系方式 1 删除').click();
  assert.deepEqual(data.profile.contacts.map(c => c.id), ['b']); profile.destroy();
  data.sections.education.items = ['a', 'b'].map(id => ({ id, school: id, degree: '', major: '', period: '', bullets: [] }));
  const sections = mountSections(container, { data, sectionKey: 'education', onChange: next => data = next });
  const school = container.all().find(n => n.tagName === 'input' && n.value === 'a');
  school.value = 'changed'; await school.fire('input');
  assert.deepEqual(data.sections.education.items.map(c => c.school), ['changed', 'b']);
  await container.all().find(n => n.getAttribute('aria-label') === '教育经历 1 删除').click();
  assert.deepEqual(data.sections.education.items.map(c => c.id), ['b']);
  assert.equal(validateResumeData(data).ok, true); sections.destroy();
});

test('rich link limit agrees with model and displays error before range mutation', async t => {
  const container = installDom(t); container.ownerDocument = document;
  const url = 'https://example.com/' + 'x'.repeat(2001);
  assert.throws(() => normalizeRuns([{ text: 'x', bold: false, url }]), e => /2000/.test(e.message));
  const boundary = url.slice(0, 2000);
  assert.equal(normalizeRuns([{ text: 'x', url: boundary }])[0].url, boundary);
  let changed = 0;
  mountRichText(container, { value: [], onChange() { changed++; } });
  const input = container.all().find(n => n.tagName === 'input');
  assert.equal(input.maxLength, 2000);
  input.value = url;
  // Selection access would throw: invalid input must return before restoring/mutating it.
  await container.all().find(n => n.textContent === '应用链接').click();
  assert.match(container.all().find(n => n.className === 'field-error').textContent, /2000/);
  assert.equal(changed, 0);
});

test('real child UTF8 stdout and stderr retain independent decoder state and flush at end', async () => {
  const result = await runProcess({ executable: process.execPath, timeoutMs: 5000, args: ['-e', `
    const a=Buffer.from('中文'), b=Buffer.from('警告');
    process.stdout.write(a.subarray(0,1));
    process.stderr.write(b.subarray(0,2));
    setTimeout(()=>{process.stdout.write(a.subarray(1));process.stderr.write(b.subarray(2));},80);
  `] });
  assert.equal(result.exitCode, 0);
  assert.ok(result.log.includes('中文')); assert.ok(result.log.includes('警告'));
  assert.doesNotMatch(result.log, /�/);
  const unfinished = await runProcess({ executable: process.execPath, timeoutMs: 5000, args: ['-e', 'process.stdout.write(Buffer.from([0xe4]));process.stderr.write(Buffer.from([0xe8]));'] });
  assert.equal(unfinished.log, '��');
});

test('process output cap counts source bytes across both streams', async () => {
  const result = await runProcess({ executable: process.execPath, timeoutMs: 5000, args: ['-e', "process.stdout.write('中'.repeat(900000));"] });
  const body = result.log.split('\n[日志超过')[0];
  assert.ok(Buffer.byteLength(body) <= 2 * 1024 * 1024 + 2);
  assert.ok(body.length < 700000);
  assert.equal(result.log.match(/日志超过/g).length, 1);
});
