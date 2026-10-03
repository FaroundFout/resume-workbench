import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEmptyData, validateLanguage, validateResumeData } from '../web/shared/model.mjs';

const run = (text = 'Text') => ({ text, bold: false, url: null });
const education = () => ({ id: 'edu-1', school: 'School', degree: 'Degree', major: 'Major', period: '2020–2024', bullets: [[run()]] });
function rejected(data, path) {
  const result = validateResumeData(data);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.path === path), JSON.stringify(result));
  assert.ok(result.issues.every(issue => typeof issue.message === 'string' && issue.message.length));
}

test('empty resumes have usable explicit defaults and independent content', () => {
  const data = createEmptyData('en');
  assert.equal(data.language, 'en');
  assert.deepEqual(data.layout, { paper: 'auto', fontSizePt: 10, density: 'compact', marginMm: 10 });
  assert.deepEqual(data.logo, { mode: 'default', assetId: null, widthCm: 2.4 });
  assert.deepEqual(data.sectionOrder, ['education', 'experience', 'projects', 'skills', 'awards', 'social']);
  assert.deepEqual(data.profile, { name: '', alternateName: '', title: '', contacts: [] });
  assert.equal(validateResumeData(data).ok, true);
  data.sections.education.items.push(education());
  data.sectionOrder.reverse();
  assert.equal(createEmptyData('en').sections.education.items.length, 0);
  assert.equal(createEmptyData('en').sectionOrder[0], 'education');
});

test('only the two resume language values are accepted', () => {
  assert.equal(validateLanguage('zh-CN'), 'zh-CN');
  assert.equal(validateLanguage('en'), 'en');
  for (const value of ['zh', 'EN', '', null, 1, {}]) {
    assert.throws(() => validateLanguage(value), /language/);
    assert.throws(() => createEmptyData(value), /language/);
    rejected({ ...createEmptyData('en'), language: value }, 'language');
  }
});

test('font sizes, margins and logo dimensions enforce inclusive boundaries', () => {
  for (const fontSizePt of [10, 11, 12]) {
    for (const marginMm of [8, 20]) {
      for (const widthCm of [1.2, 3.2]) {
        const data = createEmptyData('zh-CN');
        Object.assign(data.layout, { fontSizePt, marginMm });
        data.logo.widthCm = widthCm;
        assert.equal(validateResumeData(data).ok, true);
      }
    }
  }
  for (const [area, key, value] of [
    ['layout', 'fontSizePt', 13], ['layout', 'fontSizePt', '10'],
    ['layout', 'marginMm', 7.9], ['layout', 'marginMm', 20.1], ['layout', 'marginMm', NaN],
    ['logo', 'widthCm', 1.19], ['logo', 'widthCm', 3.3], ['logo', 'widthCm', Infinity],
  ]) {
    const data = createEmptyData('en');
    data[area][key] = value;
    rejected(data, `${area}.${key}`);
  }
});

test('section order requires exactly the six unique known sections', () => {
  for (const order of [Array(6).fill('projects'), ['education'], ['education', 'experience', 'projects', 'skills', 'awards', 'html']]) {
    const data = createEmptyData('en');
    data.sectionOrder = order;
    rejected(data, 'sectionOrder');
  }
});

test('disabled sections preserve all text, formatting and literal characters', () => {
  const data = createEmptyData('zh-CN');
  const text = ' 中文 & 100% $ _ { } \\ <strong>actual text</strong>\n';
  data.profile.name = '  Example  ';
  data.sections.education.items = [{ ...education(), bullets: [[{ text, bold: true, url: 'https://example.org/a?x=1&y=2' }]] }];
  data.sections.education.enabled = false;
  const before = JSON.stringify(data);
  const result = validateResumeData(data);
  assert.equal(result.ok, true);
  assert.equal(result.value.sections.education.items[0].bullets[0][0].text, text);
  assert.equal(result.value.profile.name, '  Example  ');
  assert.equal(JSON.stringify(data), before);
});

test('unknown fields including raw HTML and cross-type entries are rejected', () => {
  const cases = [
    [data => { data.html = '<b>bad</b>'; }, 'html'],
    [data => { data.profile.html = '<b>bad</b>'; }, 'profile.html'],
    [data => { data.sections.education.items = [{ ...education(), role: 'wrong type' }]; }, 'sections.education.items[0].role'],
    [data => { data.sections.experience.items = [education()]; }, 'sections.experience.items[0].school'],
    [data => { data.sections.skills.items = [{ id: 's', category: 'Skill', content: [{ ...run(), html: '<b>x</b>' }] }]; }, 'sections.skills.items[0].content[0].html'],
  ];
  for (const [mutate, path] of cases) {
    const data = createEmptyData('en');
    mutate(data);
    rejected(data, path);
  }
});

test('malformed objects, missing fields and incorrect scalar types are rejected', () => {
  for (const value of [null, [], 'resume', 0]) rejected(value, '$');
  const cases = [
    [data => { delete data.profile.title; }, 'profile.title'],
    [data => { data.sections.skills.enabled = 1; }, 'sections.skills.enabled'],
    [data => { data.sections.education.items = {}; }, 'sections.education.items'],
    [data => { data.layout.paper = 'A4'; }, 'layout.paper'],
    [data => { data.layout.density = 'tiny'; }, 'layout.density'],
    [data => { data.logo.mode = 'remote'; }, 'logo.mode'],
    [data => { data.profile.contacts = [{ id: 'c', type: 'fax', label: '', value: '' }]; }, 'profile.contacts[0].type'],
    [data => { data.sections.skills.items = [{ id: 's', category: 'Skill', content: [{ text: 'x', bold: 'yes', url: null }] }]; }, 'sections.skills.items[0].content[0].bold'],
  ];
  for (const [mutate, path] of cases) {
    const data = createEmptyData('en'); mutate(data); rejected(data, path);
  }
});

test('links reject executable, file, relative and malformed URL values', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', '/relative', 'https://', 'https:example.org', ' https://example.org', 'https://example.org\n']) {
    const data = createEmptyData('en');
    data.sections.skills.items = [{ id: 's', category: 'Skill', content: [{ ...run(), url }] }];
    rejected(data, 'sections.skills.items[0].content[0].url');
  }
  const data = createEmptyData('en');
  data.profile.contacts = [{ id: 'c', type: 'url', label: 'Site', value: 'javascript:alert(1)' }];
  rejected(data, 'profile.contacts[0].value');
});

test('rich-text links allow mailto while project and website links require HTTP', () => {
  const data = createEmptyData('en');
  data.sections.skills.items = [{ id: 's', category: '', content: [{ ...run(), url: 'mailto:hello@example.com' }] }];
  assert.equal(validateResumeData(data).ok, true);
  data.sections.skills.items[0].content[0].url = 'tel:123456';
  rejected(data, 'sections.skills.items[0].content[0].url');
  data.sections.skills.items[0].content[0].url = null;
  data.sections.projects.items = [{ id: 'p', name: 'Project', period: '', role: '', url: '', techStack: '', summary: [], bullets: [] }];
  assert.equal(validateResumeData(data).ok, true);
  data.sections.projects.items[0].url = 'mailto:hello@example.com';
  rejected(data, 'sections.projects.items[0].url');
  data.sections.projects.items[0].url = 'https://example.org/project';
  assert.equal(validateResumeData(data).ok, true);
});

test('logo modes require valid asset references and hiding retains a custom asset', () => {
  const data = createEmptyData('en');
  data.logo.mode = 'custom';
  rejected(data, 'logo.assetId');
  data.logo.assetId = 'asset_123-abc';
  assert.equal(validateResumeData(data).ok, true);
  data.logo.mode = 'hidden';
  assert.equal(validateResumeData(data).ok, true);
  assert.equal(data.logo.assetId, 'asset_123-abc');
  data.logo.mode = 'default';
  rejected(data, 'logo.assetId');
  data.logo.mode = 'custom';
  for (const value of ['../logo', '', 'a'.repeat(129), 123]) {
    data.logo.assetId = value;
    rejected(data, 'logo.assetId');
  }
});

test('ordinary fields and TextRuns enforce their independent length limits', () => {
  const data = createEmptyData('en');
  data.profile.name = 'a'.repeat(2000);
  data.sections.skills.items = [{ id: 's', category: '', content: [run('文'.repeat(10000))] }];
  assert.equal(validateResumeData(data).ok, true);
  data.profile.name += 'a';
  rejected(data, 'profile.name');
  data.profile.name = '';
  data.sections.skills.items[0].content[0].text += '文';
  rejected(data, 'sections.skills.items[0].content[0].text');
});

test('section entries and entry bullets enforce the 100 count limits', () => {
  const data = createEmptyData('en');
  data.sections.education.items = Array.from({ length: 100 }, (_, i) => ({ ...education(), id: `e${i}`, bullets: [] }));
  data.sections.education.items[0].bullets = Array.from({ length: 100 }, () => [run()]);
  assert.equal(validateResumeData(data).ok, true);
  data.sections.education.items.push(education());
  rejected(data, 'sections.education.items');
  data.sections.education.items.pop();
  data.sections.education.items[0].bullets.push([run()]);
  rejected(data, 'sections.education.items[0].bullets');
});

test('the total text budget counts content across different sections', () => {
  const data = createEmptyData('en');
  data.sections.skills.items = [{ id: '', category: '', content: Array.from({ length: 19 }, () => run('x'.repeat(10000))) }];
  assert.equal(validateResumeData(data).ok, true);
  data.sections.skills.items[0].content.push(run('x'.repeat(10000)));
  assert.equal(validateResumeData(data).ok, true);
  data.sections.skills.items[0].content.push(run('x'));
  rejected(data, '$');
  data.sections.skills.items[0].content.splice(19);
  data.sections.education.items = [{ id: '', school: '', degree: '', major: '', period: '', bullets: [[run('x'.repeat(10000)), run('x'.repeat(10000))]] }];
  rejected(data, '$');
});

test('sparse arrays cannot silently omit required list entries', () => {
  const data = createEmptyData('en');
  data.sections.education.items = Array(1);
  rejected(data, 'sections.education.items[0]');
  data.sections.education.items = [];
  data.sections.skills.items = [{ id: 's', category: '', content: Array(1) }];
  rejected(data, 'sections.skills.items[0].content[0]');
});

test('fictional Chinese and English examples both validate and cover all sections', async () => {
  const zh = JSON.parse(await readFile(new URL('../examples/resume.zh.json', import.meta.url), 'utf8'));
  const en = JSON.parse(await readFile(new URL('../examples/resume.en.json', import.meta.url), 'utf8'));
  assert.equal(zh.language, 'zh-CN'); assert.equal(en.language, 'en');
  for (const data of [zh, en]) {
    assert.deepEqual(validateResumeData(data), { ok: true, value: data });
    assert.ok(data.profile.name);
    for (const section of ['education', 'experience', 'projects', 'skills', 'awards', 'social']) assert.ok(data.sections[section].items.length);
    assert.ok(data.profile.contacts.some(contact => contact.type === 'email' && contact.value.endsWith('@example.com')));
  }
  for (const section of zh.sectionOrder) {
    assert.deepEqual(Object.keys(zh.sections[section].items[0]), Object.keys(en.sections[section].items[0]));
  }
});
