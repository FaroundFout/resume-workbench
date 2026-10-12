import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyPdfEnvironment } from '../../server/environment/verify.mjs';
import { runXeLaTeX } from '../../server/compiler/process.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const exec = promisify(execFile);
const normalize = value => value.replace(/\s/gu, '');

// Developer QA needs an explicitly configured Python with pypdf/pdfplumber.
// Product setup uses only Node's lightweight smoke checks and never invokes it.
test('installed MiKTeX passes actual isolated bilingual product smoke and independent PDF QA', { timeout: 210000 }, async t => {
  assert.ok(process.env.PURECV_PYTHON, 'Set PURECV_PYTHON to the explicit developer QA Python; unavailable tooling must fail, not skip.');
  const { resolveToolchain } = await import('../../server/environment/toolchain.mjs');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'purecv-actual-smoke-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const dataDir = join(temporaryRoot, '真实数据 隔离标记');
  await mkdir(dataDir); await writeFile(join(dataDir, 'sentinel'), 'private history preserved');
  const config = { projectRoot: root, dataDir, xelatexPath: process.env.PURECV_XELATEX || null, compileTimeoutMs: 90000 };
  const toolchain = await resolveToolchain(config);
  assert.ok(toolchain, 'An actual installed XeLaTeX is required; this integration never skips unavailable environments.');
  assert.equal(toolchain.flavour, 'miktex', 'P0 installed-environment QA targets real MiKTeX.');
  const outcomes = [], passes = new Map();
  let diagnostics = '';
  const report = await verifyPdfEnvironment(config, toolchain, {
    temporaryRoot,
    log: text => { diagnostics += text; },
    runXeLaTeX: async options => {
      const result = await runXeLaTeX(options);
      const pass = (passes.get(options.cwd) ?? 0) + 1; passes.set(options.cwd, pass);
      if (pass !== 2 || result.exitCode !== 0) return result;
      const { stdout } = await exec(process.env.PURECV_PYTHON, ['-X', 'utf8', join(root, 'tests/integration/inspect_pdf.py'), join(options.cwd, 'resume.pdf')], {
        windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
      });
      const info = JSON.parse(stdout);
      const tex = await readFile(join(options.cwd, options.entryFile), 'utf8');
      const language = tex.includes('pdflang=zh-CN') ? 'zh-CN' : 'en';
      const text = normalize(info.text);
      assert.ok(info.pages > 0);
      assert.ok(text.includes(language === 'zh-CN' ? '中文验收示例' : '中文备用姓名'));
      for (const marker of ['BODY_MARKER', 'English', '中文正文', '中文粗体', 'SMOKE_REGULAR', 'SMOKE_BOLD', 'SMOKE_ITALIC', 'SMOKE_BOLD_ITALIC']) {
        assert.ok(text.includes(marker), `Missing actual native text ${marker}`);
      }
      for (const font of ['Lato-Regular', 'Lato-Bold', 'Lato-Italic', 'Lato-BoldItalic', 'SourceHanSerifCN-Regular', 'SourceHanSerifCN-Bold']) {
        assert.ok(Object.entries(info.fonts).some(([name, embedded]) => name.includes(font) && embedded), `${font} must actually be embedded.`);
      }
      assert.ok(Object.values(info.fonts).every(Boolean));
      assert.ok(info.images.flat().length > 0, 'The real default logo is rendered.');
      assert.ok(info.uris.includes('mailto:smoke@example.com'));
      assert.ok(info.uris.includes('https://example.com/smoke'));
      const paper = language === 'zh-CN' ? [595.28, 841.89] : [612, 792];
      assert.ok(info.boxes.every(box => box.every((value, i) => Math.abs(value - paper[i]) < 0.5)));
      outcomes.push({ language, pages: info.pages, fonts: Object.keys(info.fonts), paper: info.boxes[0] });
      return result;
    },
  });
  assert.equal(report.pdfReady, true, JSON.stringify({ state: report.state, checks: report.checks }) + '\n' + diagnostics);
  assert.equal(report.state, 'ready');
  assert.deepEqual(outcomes.map(x => x.language), ['zh-CN', 'en']);
  assert.deepEqual(await readdir(temporaryRoot), ['真实数据 隔离标记'], 'All private smoke artifacts have been removed.');
  assert.equal(await readFile(join(dataDir, 'sentinel'), 'utf8'), 'private history preserved');
  t.diagnostic(JSON.stringify({ toolchain: { flavour: toolchain.flavour, version: toolchain.version, scope: toolchain.scope }, outcomes }));
});
