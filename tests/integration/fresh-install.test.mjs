import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, cp, realpath, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// This file is developer release QA, not part of the installed product. Run
// with the candidate's downloaded Node, after setup. No bootstrap occurs here.
const exec = promisify(execFile);
const normalize = value => value.replace(/\s/gu, '');
function context() {
  assert.ok(process.env.PURECV_INSTALL_ROOT, 'Set PURECV_INSTALL_ROOT to the installation extracted from the final release ZIP.');
  assert.ok(process.env.PURECV_RELEASE_ZIP, 'Set PURECV_RELEASE_ZIP to the exact tested release ZIP.');
  assert.ok(process.env.PURECV_RELEASE_EVIDENCE, 'Set PURECV_RELEASE_EVIDENCE to a dedicated public QA evidence directory.');
  return { root: resolve(process.env.PURECV_INSTALL_ROOT), zip: resolve(process.env.PURECV_RELEASE_ZIP), evidence: resolve(process.env.PURECV_RELEASE_EVIDENCE) };
}
const candidateImport = (root, name) => import(pathToFileURL(join(root, name)).href);
async function candidate(t) {
  const { root, zip, evidence } = context();
  const { verifyReleaseZip } = await candidateImport(root, 'scripts/release-verify.mjs');
  const release = await verifyReleaseZip(zip);
  assert.equal((await realpath(process.execPath)).toLowerCase(), (await realpath(join(root, '.runtime/node/node.exe'))).toLowerCase(), 'QA must use the installed project Node, not a runner cache.');
  const nodeManifest = JSON.parse(release.entries.get('scripts/node-runtime.json'));
  assert.equal(process.versions.node, nodeManifest.version);
  for (const file of release.manifest.files) {
    const { sha256 } = await candidateImport(root, 'scripts/release-format.mjs');
    const info = await lstat(join(root, file.path)); assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.equal(sha256(await readFile(join(root, file.path))), file.sha256, `Installed public source drifted: ${file.path}`);
  }
  assert.ok(/[\u3400-\u9fff]/u.test(root) && /\s/u.test(root), 'Installation root must exercise Chinese and spaces.');
  for (const name of ['resume', 'resume_zh', 'examples', 'config.local.json']) await assert.rejects(lstat(join(root, name)), { code: 'ENOENT' });
  await mkdir(evidence, { recursive: true });
  const { resolveToolchain } = await candidateImport(root, 'server/environment/toolchain.mjs');
  const config = { projectRoot: root, dataDir: join(evidence, 'isolated-data'), xelatexPath: process.env.PURECV_XELATEX || null, compileTimeoutMs: 90000 };
  const toolchain = await resolveToolchain(config);
  assert.ok(toolchain, 'Actual XeLaTeX must be available; this release QA never skips missing tools.');
  assert.equal(toolchain.flavour, 'miktex');
  const { redactEnvironmentLog } = await candidateImport(root, 'server/environment/diagnostics.mjs');
  let log = '';
  const logName = t.name.includes('multiple pages') ? 'multipage-qa.log' : 'pdf-qa.log';
  t.after(() => writeFile(join(evidence, logName), redactEnvironmentLog(log), 'utf8'));
  return { root, zip, evidence, release, config, toolchain, appendLog: value => { log += String(value) + '\n'; } };
}
async function inspectPdf(pdf) {
  assert.ok(process.env.PURECV_PYTHON, 'Configure explicit developer QA Python after product installation; unavailable QA fails.');
  assert.ok(process.env.PURECV_PDF_INSPECTOR, 'Configure PURECV_PDF_INSPECTOR as the public inspect_pdf.py supplied outside the ZIP.');
  const { stdout } = await exec(process.env.PURECV_PYTHON, ['-X', 'utf8', resolve(process.env.PURECV_PDF_INSPECTOR), pdf], {
    windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

test('fresh-install provenance proves an ordinary-user clean Windows 11 x64 setup, doctor and reuse', async () => {
  const { evidence } = context();
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
  const clean = JSON.parse(await readFile(join(evidence, 'clean-preflight.json'), 'utf8'));
  assert.equal(clean.status, 'passed'); assert.ok(clean.build >= 22000); assert.equal(clean.workstation, true);
  assert.equal(clean.architecture, 'x64'); assert.equal(clean.elevated, false);
  assert.equal(clean.administratorGroupMember, false);
  assert.deepEqual(clean.presentTools, []); assert.deepEqual(clean.cachedTex, []);
  assert.match(clean.snapshot, /^[A-Za-z0-9_.-]{1,128}$/u);
  const result = JSON.parse(await readFile(join(evidence, 'installation.json'), 'utf8'));
  assert.equal(result.setupExitCode, 0); assert.equal(result.doctorExitCode, 0); assert.equal(result.repeatSetupExitCode, 0);
  assert.equal(result.selectionReused, true); assert.equal(result.nodeDownloadVerified, true);
  assert.ok(result.setupDurationMs > 0);
});

test('final release ZIP passes actual bilingual PDF parsing, text, embedded fonts, images and links', { timeout: 240000 }, async t => {
  const f = await candidate(t);
  const { verifyPdfEnvironment } = await candidateImport(f.root, 'server/environment/verify.mjs');
  const { runXeLaTeX } = await candidateImport(f.root, 'server/compiler/process.mjs');
  const outcomes = [], passes = new Map();
  const report = await verifyPdfEnvironment(f.config, f.toolchain, {
    log: f.appendLog,
    runXeLaTeX: async options => {
      const result = await runXeLaTeX(options); const pass = (passes.get(options.cwd) ?? 0) + 1; passes.set(options.cwd, pass);
      if (result.exitCode !== 0 || pass !== 2) return result;
      const pdf = join(options.cwd, 'resume.pdf'), info = await inspectPdf(pdf);
      const tex = await readFile(join(options.cwd, options.entryFile), 'utf8');
      const language = tex.includes('pdflang=zh-CN') ? 'zh-CN' : 'en';
      assert.ok(info.pages > 0);
      const text = normalize(info.text);
      for (const marker of ['BODY_MARKER', 'English', '中文正文', '中文粗体', 'SMOKE_REGULAR', 'SMOKE_BOLD', 'SMOKE_ITALIC', 'SMOKE_BOLD_ITALIC', language === 'zh-CN' ? '中文验收示例' : '中文备用姓名']) assert.ok(text.includes(marker), `Missing ${language} native text: ${marker}`);
      for (const font of ['Lato-Regular', 'Lato-Bold', 'Lato-Italic', 'Lato-BoldItalic', 'SourceHanSerifCN-Regular', 'SourceHanSerifCN-Bold']) assert.ok(Object.entries(info.fonts).some(([name, embedded]) => name.includes(font) && embedded), `Font not embedded: ${font}`);
      assert.ok(Object.values(info.fonts).every(Boolean)); assert.ok(info.images.flat().length > 0);
      assert.ok(info.uris.includes('mailto:smoke@example.com')); assert.ok(info.uris.includes('https://example.com/smoke'));
      const paper = language === 'zh-CN' ? [595.28, 841.89] : [612, 792];
      assert.ok(info.boxes.every(box => box.every((value, i) => Math.abs(value - paper[i]) < 0.5)));
      await cp(pdf, join(f.evidence, `sample-${language}.pdf`));
      await writeFile(join(f.evidence, `sample-${language}-inspection.json`), JSON.stringify(info, null, 2) + '\n');
      outcomes.push({ language, pages: info.pages, fonts: info.fonts, paper: info.boxes[0], image: true, links: true, nativeText: true });
      return result;
    },
  });
  assert.equal(report.pdfReady, true, JSON.stringify({ state: report.state, checks: report.checks }));
  assert.deepEqual(outcomes.map(value => value.language), ['zh-CN', 'en']);
  const packageVersions = [];
  for (const id of [...new Set(Object.values(f.release.manifest.packageIdsByFlavour.miktex))].sort()) {
    const { stdout } = await exec(f.toolchain.manager, ['packages', 'info', '--template={id}|{version}|{timePackaged}|{isInstalled}', id], {
      env: f.toolchain.env ? { ...process.env, ...f.toolchain.env } : process.env, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
    });
    packageVersions.push({ id, actual: stdout.trim() });
  }
  let selection = null;
  try {
    const record = JSON.parse(await readFile(join(f.root, '.runtime/tex-selection.json'), 'utf8'));
    selection = { relativeExecutable: record.relativeExecutable, version: record.version, bootstrap: record.bootstrap, repository: record.repository };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(join(f.evidence, 'release-pdf-summary.json'), JSON.stringify({
    releaseSha256: f.release.sha256, releaseBytes: f.release.bytes, releaseFiles: f.release.files,
    node: { version: process.versions.node, architecture: process.arch, source: 'project runtime' },
    toolchain: { flavour: f.toolchain.flavour, version: f.toolchain.version, scope: f.toolchain.scope }, selection,
    packageVersions, outcomes,
    cleanVm: process.env.PURECV_REQUIRE_CLEAN_VM === '1',
    repositoryBoundary: 'Bootstrap records mirror selection; exact package versions above are measured. Remote repository contents are not pinned.',
  }, null, 2) + '\n');
  t.diagnostic(JSON.stringify({ releaseSha256: f.release.sha256, outcomes: outcomes.map(({ language, pages }) => ({ language, pages })) }));
});

test('final release ZIP preserves final native Chinese and English text across multiple pages', { timeout: 240000 }, async t => {
  const f = await candidate(t);
  const { createEmptyData, validateResumeData } = await candidateImport(f.root, 'web/shared/model.mjs');
  const { prepareBuild } = await candidateImport(f.root, 'server/latex/resources.mjs');
  const { runXeLaTeX } = await candidateImport(f.root, 'server/compiler/process.mjs');
  const { acquireEnvironmentLease } = await candidateImport(f.root, 'server/environment/lease.mjs');
  const { validateSmokePdf } = await candidateImport(f.root, 'server/environment/pdf-smoke.mjs');
  const lease = await acquireEnvironmentLease(f.toolchain, { mode: 'verify' });
  const outcomes = [];
  try {
    for (const language of ['zh-CN', 'en']) {
      const data = createEmptyData(language); data.profile.name = 'Public Multipage Example'; data.profile.alternateName = '公开分页样例';
      data.sections.projects.items = [{ id: 'release-qa', name: 'Public Example', period: '2024–2026', role: 'Developer', url: '', techStack: 'Node.js 中文', summary: [], bullets: [
        ...Array.from({ length: 99 }, (_, i) => [{ text: `Public verification row ${i + 1}: 中文正文与完整英文文本；公开虚构内容用于确认分页、字体与最后一行保持完整。`, bold: false, url: null }]),
        [{ text: 'FINAL_RELEASE_MARKER 中文英文末行完整', bold: true, url: 'https://example.com/release' }],
      ] }];
      const checked = validateResumeData(data);
      assert.equal(checked.ok, true, JSON.stringify(checked.issues));
      const buildDir = join(f.config.dataDir, 'builds', `multipage-${language}`);
      const prepared = await prepareBuild({ projectRoot: f.root, dataDir: f.config.dataDir, buildDir, snapshot: { data, logoImage: null } });
      for (let pass = 0; pass < 2; pass++) {
        const result = await runXeLaTeX({ executable: f.toolchain.executable, env: f.toolchain.env, cwd: prepared.cwd, entryFile: prepared.entryFile, timeoutMs: 90000 });
        f.appendLog(result.log); assert.equal(result.exitCode, 0);
        await validateSmokePdf({ path: join(buildDir, 'resume.pdf'), log: result.log });
      }
      const pdf = join(buildDir, 'resume.pdf'), info = await inspectPdf(pdf);
      assert.ok(info.pages > 1); assert.ok(normalize(info.text).includes('FINAL_RELEASE_MARKER中文英文末行完整'));
      assert.ok(info.uris.includes('https://example.com/release')); assert.ok(Object.values(info.fonts).every(Boolean));
      await cp(pdf, join(f.evidence, `multipage-${language}.pdf`));
      outcomes.push({ language, pages: info.pages, finalText: true, embeddedFonts: true });
    }
  } finally { await lease.release(); }
  await writeFile(join(f.evidence, 'multipage-summary.json'), JSON.stringify(outcomes, null, 2) + '\n');
});
