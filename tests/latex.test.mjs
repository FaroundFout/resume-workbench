import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEmptyData } from '../web/shared/model.mjs';
import { escapeLatex, renderRichText } from '../server/latex/text.mjs';
import { renderResume } from '../server/latex/render.mjs';
const refs = { fontDir: 'resources/font/', logoFile: 'resources/logo.png' };
async function render(data, resources = refs) {
  const language = data.language === 'zh-CN' ? 'zh' : 'en';
  const [main, macros] = await Promise.all([
    readFile(new URL(`../templates/purecv-${language}/main.tex`, import.meta.url), 'utf8'),
    readFile(new URL('../templates/shared/macros.tex', import.meta.url), 'utf8'),
  ]);
  return renderResume(data, resources, { main, macros });
}

test('user punctuation and attempted TeX commands become literal text once', () => {
  assert.equal(escapeLatex('A&B_C%'), 'A\\&B\\_C\\%');
  assert.equal(escapeLatex('\\input{evil} $ # ^ ~'), '\\textbackslash{}input\\{evil\\} \\$ \\# \\textasciicircum{} \\textasciitilde{}');
});

test('rich text preserves bold, links, and native multiline text', () => {
  assert.equal(renderRichText([{ text: 'Redis & Lua', bold: true, url: null }]), '\\textbf{Redis \\& Lua}');
  assert.equal(renderRichText([{ text: 'API_文档', bold: true, url: 'https://example.com/?a=1&b=2#part' }]), '\\href{https://example.com/?a=1\\&b=2\\#part}{\\textbf{API\\_文档}}');
  assert.equal(renderRichText([{ text: 'first\nsecond', bold: false, url: 'mailto:student@example.com' }]), '\\href{mailto:student@example.com}{first\\newline{}second}');
  assert.throws(() => renderRichText([{ text: 'bad', bold: false, url: 'javascript:alert(1)' }]));
});

test('rich text links require complete URL syntax and a nonempty mail recipient', () => {
  for (const url of ['https:example.com', 'http:/example.com', 'mailto:']) {
    assert.throws(() => renderRichText([{ text: 'link', bold: false, url }]), error => error.code === 'INVALID_URL');
  }
});

test('six populated sections follow saved order and hidden content disappears', async () => {
  const data = JSON.parse(await readFile(new URL('../examples/resume.zh.json', import.meta.url), 'utf8'));
  data.sectionOrder = ['social', 'awards', 'skills', 'projects', 'experience', 'education'];
  const { mainTex, macrosTex } = await render(data);
  const headings = ['社会经历', '荣誉奖项', '专业技能', '项目经历', '工作经历', '教育经历'];
  const indices = headings.map(title => mainTex.indexOf(`\\section{${title}}`));
  assert.ok(indices.every(index => index >= 0));
  assert.deepEqual([...indices].sort((a, b) => a - b), indices);
  data.sections.projects.enabled = false;
  data.sections.education.items = [];
  const hidden = (await render(data)).mainTex;
  assert.ok(!hidden.includes('\\section{项目经历}'));
  assert.ok(!hidden.includes(data.sections.projects.items[0].name));
  assert.ok(!hidden.includes('\\section{教育经历}'));
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(mainTex + macrosTex));
});

test('language selects headings and automatic paper while explicit paper wins', async () => {
  for (const [language, paper, heading] of [['zh-CN', 'a4paper', '教育经历'], ['en', 'letterpaper', 'Education']]) {
    const data = createEmptyData(language);
    data.sections.education.items = [{ id: 'e', school: '中文 University', degree: 'BSc', major: 'Software', period: '2020–2024', bullets: [] }];
    const { mainTex } = await render(data);
    assert.ok(mainTex.includes(`\\documentclass[${paper},10pt]{article}`));
    assert.ok(mainTex.includes(`\\section{${heading}}`));
    assert.ok(mainTex.includes('中文 University'));
    assert.ok(mainTex.includes('\\setCJKmainfont['));
    for (const explicit of ['a4', 'letter']) {
      data.layout.paper = explicit;
      data.layout.fontSizePt = 12;
      data.layout.marginMm = 18;
      const tex = (await render(data)).mainTex;
      assert.ok(tex.includes(`\\documentclass[${explicit}paper,12pt]{article}`));
      assert.ok(tex.includes('margin=18mm'));
    }
  }
});

test('logo is bounded in two dimensions and hidden mode leaves a full width header', async () => {
  const data = createEmptyData('zh-CN');
  data.profile.name = '姓名';
  data.logo.widthCm = 1.7;
  const visible = (await render(data)).mainTex;
  assert.ok(visible.includes('\\includegraphics[width=1.7cm,height=3.2cm,keepaspectratio]{resources/logo.png}'));
  data.logo = { mode: 'hidden', assetId: 'retained', widthCm: 1.7 };
  const hidden = (await render(data)).mainTex;
  assert.ok(!hidden.includes('\\includegraphics'));
  assert.ok(!hidden.includes('\\begin{minipage}'));
  assert.ok(!hidden.includes('resources/logo.png'));
  assert.ok(hidden.includes('\\begin{center}'));
});

test('long headings and dates use wrapping columns and plain body stays outside ActualText', async () => {
  const data = JSON.parse(await readFile(new URL('../examples/resume.en.json', import.meta.url), 'utf8'));
  data.sections.projects.items[0].name = 'A long project title '.repeat(20);
  data.sections.projects.items[0].period = 'September 2024 to September 2026';
  data.profile.contacts.push({ id: 'wechat', type: 'wechat', label: '微信', value: 'wechat_example' });
  const { mainTex, macrosTex } = await render(data);
  assert.ok(mainTex.includes(data.sections.projects.items[0].name));
  assert.ok(mainTex.includes('September 2024 to September 2026'));
  assert.ok(macrosTex.includes('\\begin{tabularx}{\\linewidth}'));
  assert.ok(macrosTex.includes('p{0.28\\linewidth}'));
  assert.ok(macrosTex.includes('ActualText={#1}'));
  assert.ok(mainTex.includes('\\resumeContact{微信}{\\resumeChatIcon}'));
  assert.ok(mainTex.includes('\\resumeSkill{Development Fundamentals}'));
  assert.ok(!mainTex.includes('\\BeginAccSupp'));
  assert.ok(!mainTex.includes('\\textit'));
  assert.ok(!mainTex.includes('\\textsc'));
});

test('invalid data or unsafe resource references cannot introduce TeX or paths', async () => {
  const data = createEmptyData('en');
  data.layout.marginMm = '1}\\input{evil}';
  await assert.rejects(render(data));
  await assert.rejects(render(createEmptyData('en'), { fontDir: '../font', logoFile: null }));
  await assert.rejects(render(createEmptyData('en'), { fontDir: 'resources/font/', logoFile: 'C:/private.png' }));
});
