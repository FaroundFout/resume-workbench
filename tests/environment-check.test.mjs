import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename, delimiter } from 'node:path';
import { runProcess } from '../server/compiler/process.mjs';
import { discoverCompiler } from '../server/compiler/environment.mjs';

const fonts = ['Lato/Lato-Regular.ttf', 'Lato/Lato-Bold.ttf', 'Lato/Lato-Italic.ttf', 'Lato/Lato-BoldItalic.ttf', 'Simsun/SourceHanSerifCN-Regular.ttf', 'Simsun/SourceHanSerifCN-Bold.ttf'];
const projectFiles = [...fonts.map(name => `font/${name}`), 'font/Lato/OFL.txt', 'font/Simsun/LICENSE.txt', 'templates/purecv-en/main.tex', 'templates/purecv-zh/main.tex', 'templates/shared/macros.tex', 'templates/default-logo.png', 'samples/resume.zh.json', 'samples/resume.en.json'];
const texFiles = ['article.cls', 'geometry.sty', 'fontspec.sty', 'xeCJK.sty', 'ctexhook.sty', 'ctexpatch.sty', 'titlesec.sty', 'enumitem.sty', 'tabularx.sty', 'array.sty', 'graphicx.sty', 'hyperref.sty', 'accsupp.sty'];
test('child-local environment is passed without global mutation and separates lookup stdout from errors', async () => {
  const result = await runProcess({ executable: process.execPath, cwd: tmpdir(), args: ['-e', 'console.log(process.env.PURECV_TEST_CHILD); console.error("diagnostic only");'],
    timeoutMs: 3000, env: { ...process.env, PURECV_TEST_CHILD: 'selected toolchain' } });
  assert.equal(result.stdout.trim(), 'selected toolchain');
  assert.equal(result.stderr.trim(), 'diagnostic only');
  assert.equal(process.env.PURECV_TEST_CHILD, undefined);
});
async function api() {
  const modules = await Promise.all(['manifest', 'toolchain', 'check', 'diagnostics'].map(name => import(`../server/environment/${name}.mjs`).catch(error => error.code === 'ERR_MODULE_NOT_FOUND' ? {} : Promise.reject(error))));
  const result = Object.assign({}, ...modules);
  assert.equal(typeof result.inspectEnvironment, 'function', 'Task 1 must expose a read-only environment inspector');
  return result;
}
async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), 'PureCV 环境 空格 '));
  const projectRoot = join(root, 'project');
  const bin = join(root, 'MiKTeX', 'bin');
  const extension = process.platform === 'win32' ? '.exe' : '';
  const executable = join(bin, `xelatex${extension}`);
  const lookup = join(bin, `findtexmf${extension}`);
  const manager = join(bin, `miktex${extension}`);
  const dependencies = join(root, 'texmf');
  const put = async (file, bytes = `fixture for ${basename(file)}`) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes); };
  for (const file of projectFiles) await put(join(projectRoot, file));
  for (const file of [executable, lookup, manager]) await put(file);
  for (const file of texFiles) await put(join(dependencies, file));
  const toolchain = { flavour: 'miktex', executable, lookup, manager, version: 'MiKTeX-XeTeX 4.22', scope: 'user' };
  const config = { projectRoot, xelatexPath: executable, dataDir: join(root, 'DO NOT TOUCH') };
  const calls = [];
  const run = async options => {
    calls.push(options);
    const file = options.args.at(-1);
    return { exitCode: 0, timedOut: false, aborted: false, log: `${join(dependencies, file)}\n` };
  };
  const probe = async () => ({ exitCode: 0, timedOut: false, aborted: false, flavour: 'miktex', log: toolchain.version });
  try { await callback({ root, projectRoot, bin, extension, config, toolchain, dependencies, put, calls, run, probe }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('version success with a missing geometry file never claims PDF readiness', async () => fixture(async f => {
  const { inspectEnvironment } = await api();
  const report = await inspectEnvironment(f.config, { toolchain: f.toolchain, run: options => options.args.at(-1) === 'geometry.sty'
    ? Promise.resolve({ exitCode: 1, timedOut: false, aborted: false, log: '' }) : f.run(options) });
  assert.equal(report.editorReady, true);
  assert.equal(report.pdfReady, false);
  assert.equal(report.state, 'missing-packages');
  assert.deepEqual(report.checks.find(check => check.id === 'geometry.sty'), { id: 'geometry.sty', status: 'failed', code: 'TEX_PACKAGE_MISSING', message: '缺少 TeX 依赖 geometry.sty' });
  await assert.rejects(readdir(f.config.dataDir), error => error.code === 'ENOENT');
}));

test('installed xeCJK still requires both CTeX support files before smoke verification', async () => fixture(async f => {
  const { inspectEnvironment, packageIdsByFlavour } = await api();
  await Promise.all(['ctexhook.sty', 'ctexpatch.sty'].map(file => rm(join(f.dependencies, file))));
  const report = await inspectEnvironment(f.config, { toolchain: f.toolchain, run: async options => {
    if (['ctexhook.sty', 'ctexpatch.sty'].includes(options.args.at(-1))) return { exitCode: 1, log: '' };
    return f.run(options);
  } });
  assert.equal(report.state, 'missing-packages');
  assert.equal(report.pdfReady, false);
  assert.ok(report.checks.some(check => check.id === 'xeCJK.sty' && check.status === 'passed'));
  assert.deepEqual(report.checks.filter(check => check.code === 'TEX_PACKAGE_MISSING').map(check => check.id), ['ctexhook.sty', 'ctexpatch.sty']);
  for (const flavour of ['miktex', 'texlive']) {
    assert.equal(packageIdsByFlavour[flavour]['ctexhook.sty'], 'ctex');
    assert.equal(packageIdsByFlavour[flavour]['ctexpatch.sty'], 'ctex');
  }
}));

test('every required font, template, macro, logo and license fails as a project resource', async () => fixture(async f => {
  const { inspectEnvironment, requiredProjectFiles, requiredFonts } = await api();
  assert.deepEqual([...requiredFonts].sort(), [...fonts].sort());
  assert.deepEqual([...requiredProjectFiles].sort(), [...projectFiles].sort());
  for (const file of projectFiles) {
    const bytes = await readFile(join(f.projectRoot, file));
    await rm(join(f.projectRoot, file));
    const report = await inspectEnvironment(f.config, { toolchain: f.toolchain, run: f.run });
    assert.equal(report.state, 'missing-resources', file);
    assert.ok(report.checks.some(check => check.id === file && check.code === 'PROJECT_RESOURCE_MISSING'), file);
    assert.equal(report.pdfReady, false);
    await f.put(join(f.projectRoot, file), bytes);
  }
}));

test('healthy required dependencies require real verification and use only installer-disabled lookup', async () => fixture(async f => {
  const { inspectEnvironment, requiredTexFiles, packageIdsByFlavour } = await api();
  const report = await inspectEnvironment(f.config, { toolchain: f.toolchain, run: f.run });
  assert.equal(report.state, 'verification-required');
  assert.equal(report.pdfReady, false);
  assert.equal(report.verifiedAt, null);
  assert.equal(report.task, null);
  assert.match(report.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual([...requiredTexFiles].sort(), [...texFiles].sort());
  assert.equal(packageIdsByFlavour.miktex['tabularx.sty'], 'latex-tools');
  assert.equal(packageIdsByFlavour.texlive['array.sty'], 'tools');
  assert.equal(packageIdsByFlavour.miktex['article.cls'], 'ltxbase');
  for (const call of f.calls) {
    assert.equal(call.executable, f.toolchain.lookup);
    assert.deepEqual(call.args.slice(0, -1), ['--miktex-disable-installer', '--miktex-disable-maintenance', '--miktex-disable-diagnose']);
    assert.ok(texFiles.includes(call.args.at(-1)));
    assert.ok(call.timeoutMs <= 15000 && call.timeoutMs > 0);
  }
  const original = report.fingerprint;
  await f.put(join(f.projectRoot, 'templates/purecv-en/main.tex'), 'updated template');
  assert.notEqual((await inspectEnvironment(f.config, { toolchain: f.toolchain, run: f.run })).fingerprint, original);
  await f.put(join(f.dependencies, 'geometry.sty'), 'updated dependency');
  assert.notEqual((await inspectEnvironment(f.config, { toolchain: f.toolchain, run: f.run })).fingerprint, original);
}));

test('lookup absence, unsupported flags, errors, timeouts and invalid output are distinct from missing packages', async () => fixture(async f => {
  const { inspectEnvironment } = await api();
  const cases = [
    [{ ...f.toolchain, lookup: null }, f.run, 'TEX_LOOKUP_UNAVAILABLE'],
    [f.toolchain, async () => ({ exitCode: 1, timedOut: false, aborted: false, log: 'unknown option --miktex-disable-maintenance' }), 'TEX_LOOKUP_UNSUPPORTED'],
    [f.toolchain, async () => ({ exitCode: 2, timedOut: false, aborted: false, log: 'permission denied' }), 'TEX_LOOKUP_FAILED'],
    [f.toolchain, async () => ({ exitCode: null, timedOut: true, aborted: false, log: '' }), 'ENVIRONMENT_TIMEOUT'],
    [f.toolchain, async () => ({ exitCode: 0, timedOut: false, aborted: false, log: join(f.dependencies, 'array.sty') }), 'TEX_LOOKUP_INVALID_RESULT'],
  ];
  for (const [toolchain, run, code] of cases) {
    const report = await inspectEnvironment(f.config, { toolchain, run });
    assert.equal(report.state, 'verification-failed', code);
    assert.ok(report.checks.some(check => check.code === code), code);
    assert.equal(report.checks.some(check => check.code === 'TEX_PACKAGE_MISSING'), false, code);
  }
}));

test('package detection shares one deadline rather than a fresh deadline per package', async () => fixture(async f => {
  const { inspectEnvironment } = await api();
  const started = Date.now();
  const report = await inspectEnvironment(f.config, { toolchain: f.toolchain, timeoutMs: 80, run: async options => {
    await new Promise(done => setTimeout(done, Math.min(40, options.timeoutMs)));
    return options.timeoutMs <= 40 ? { exitCode: null, timedOut: true, aborted: false, log: '' } : f.run(options);
  } });
  assert.equal(report.state, 'verification-failed');
  assert.ok(report.checks.some(check => check.code === 'ENVIRONMENT_TIMEOUT'));
  assert.ok(Date.now() - started < 400);
}));

test('toolchain companions stay in selected absolute bin even with another installation first on PATH', async () => fixture(async f => {
  const { resolveToolchain } = await api();
  const foreignBin = join(f.root, 'other', 'bin');
  await f.put(join(foreignBin, `miktex${f.extension}`));
  await f.put(join(foreignBin, `findtexmf${f.extension}`));
  const selected = await resolveToolchain(f.config, { env: { PATH: foreignBin }, commonPaths: [], probe: f.probe });
  assert.equal(selected.executable, resolve(f.toolchain.executable));
  assert.equal(selected.lookup, resolve(f.toolchain.lookup));
  assert.equal(selected.manager, resolve(f.toolchain.manager));
  await rm(f.toolchain.manager);
  assert.equal((await resolveToolchain(f.config, { env: { PATH: foreignBin }, commonPaths: [], probe: f.probe })).manager, null);
}));

test('toolchain resolution ignores quoted-empty PATH and keeps the selected bin independent of project cwd', async () => fixture(async f => {
  const { resolveToolchain } = await api();
  const config = { ...f.config, xelatexPath: null };
  const candidates = [];
  const toolchain = await resolveToolchain(config, { env: { PATH: ['""', ' "  " ', ` "${f.bin}" `].join(delimiter) },
    commonPaths: [], probe: async executable => { candidates.push(executable); return f.probe(); } });
  assert.ok(toolchain, 'a recognized compiler in a valid quoted bin must resolve canonically');
  assert.equal(toolchain.executable, f.toolchain.executable);
  assert.equal(toolchain.lookup, f.toolchain.lookup);
  assert.deepEqual(candidates, [f.toolchain.executable]);
}));

test('legacy compiler discovery returns its selected child environment for formal builds', async () => fixture(async f => {
  const environment = await discoverCompiler(f.config, { env: { PATH: 'other installation' }, commonPaths: [], probe: f.probe });
  assert.equal(environment.env.PATH.split(process.platform === 'win32' ? ';' : ':')[0], f.bin);
  assert.equal(environment.flavour, 'miktex');
  assert.equal(environment.version, 'MiKTeX-XeTeX 4.22');
}));

test('unusable explicit compiler cannot fall back to an unrelated healthy installation', async () => fixture(async f => {
  const { resolveToolchain, inspectEnvironment } = await api();
  const config = { ...f.config, xelatexPath: join(f.root, 'missing.exe') };
  const probes = [];
  const options = { env: { PATH: f.bin }, commonPaths: [f.toolchain.executable], probe: async executable => {
    probes.push(executable);
    return { exitCode: 1, flavour: null, log: '', timedOut: false, aborted: false };
  } };
  assert.equal(await resolveToolchain(config, options), null);
  assert.deepEqual(probes, [config.xelatexPath]);
  const report = await inspectEnvironment(config, options);
  assert.equal(report.state, 'missing-compiler');
  assert.equal(report.pdfReady, false);
}));

test('cancelled checks start no compiler or lookup process', async () => fixture(async f => {
  const { inspectEnvironment, resolveToolchain } = await api();
  const controller = new AbortController(); controller.abort();
  const forbidden = () => { throw new Error('must not run'); };
  await assert.rejects(inspectEnvironment(f.config, { signal: controller.signal, run: forbidden, probe: forbidden }), error => error.name === 'AbortError');
  await assert.rejects(resolveToolchain(f.config, { signal: controller.signal, probe: forbidden }), error => error.name === 'AbortError');
}));

test('compiler probe timeout is a detection failure rather than an absent compiler', async () => fixture(async f => {
  const { inspectEnvironment } = await api();
  const report = await inspectEnvironment(f.config, { env: {}, commonPaths: [], probe: async () => ({
    flavour: null, exitCode: null, timedOut: true, aborted: false, log: '' }) });
  assert.equal(report.state, 'verification-failed');
  assert.ok(report.checks.some(check => check.code === 'ENVIRONMENT_TIMEOUT'));
}));

test('stderr-only errors cannot count as a resolved TeX dependency', async () => fixture(async f => {
  const { inspectEnvironment } = await api();
  const report = await inspectEnvironment(f.config, { toolchain: f.toolchain, run: async options => ({
    exitCode: 0, timedOut: false, aborted: false, stdout: '', stderr: `Error reading ${join(f.dependencies, options.args.at(-1))}`, log: '' }) });
  assert.equal(report.state, 'verification-failed');
  assert.ok(report.checks.some(check => check.code === 'TEX_LOOKUP_FAILED'));
  assert.equal(report.checks.some(check => check.code === 'TEX_PACKAGE_MISSING'), false);
}));

test('a found path accompanied by an error diagnostic cannot pass read-only dependency inspection', async () => fixture(async f => {
  const { inspectEnvironment } = await api();
  const report = await inspectEnvironment(f.config, { toolchain: f.toolchain, run: async options => ({
    exitCode: 0, timedOut: false, aborted: false, stdout: join(f.dependencies, options.args.at(-1)),
    stderr: 'fatal error: cannot read the package database', log: '' }) });
  assert.equal(report.state, 'verification-failed');
  assert.ok(report.checks.some(check => check.code === 'TEX_LOOKUP_FAILED'));
}));

test('TeX Live uses the selected sibling kpsewhich and no MiKTeX parameters', async () => fixture(async f => {
  const { inspectEnvironment, resolveToolchain } = await api();
  const lookup = join(f.bin, `kpsewhich${f.extension}`);
  await f.put(lookup);
  const toolchain = await resolveToolchain(f.config, { env: {}, commonPaths: [], probe: async () => ({
    exitCode: 0, timedOut: false, aborted: false, flavour: 'texlive', log: 'XeTeX (TeX Live 2026)' }) });
  assert.equal(toolchain.lookup, lookup);
  assert.equal(toolchain.manager, null);
  const report = await inspectEnvironment(f.config, { toolchain, run: f.run });
  assert.equal(report.state, 'verification-required');
  assert.ok(f.calls.every(call => call.args.length === 1));
}));

test('lookup from an unrelated compiler root is rejected before any query', async () => fixture(async f => {
  const { inspectEnvironment } = await api();
  const lookup = join(f.root, 'foreign', `findtexmf${f.extension}`); await f.put(lookup);
  const report = await inspectEnvironment(f.config, { toolchain: { ...f.toolchain, lookup }, run: f.run });
  assert.equal(report.state, 'verification-failed');
  assert.ok(report.checks.some(check => check.code === 'TEX_LOOKUP_UNAVAILABLE'));
  assert.equal(f.calls.length, 0);
}));

test('public reports white-list fields and redact private Windows and Unix paths', async () => fixture(async f => {
  const { toPublicEnvironment, redactEnvironmentLog } = await api();
  const report = toPublicEnvironment({ editorReady: true, pdfReady: false, state: 'verification-failed', toolchain: f.toolchain,
    checks: [{ id: 'geometry.sty', status: 'failed', code: 'TEX_LOOKUP_FAILED', message: 'Error at C:\\Users\\Alice Name\\private\\file.tex' }],
    task: { id: 'task-1', phase: 'checking', status: 'failed', executable: f.toolchain.executable }, fingerprint: 'private', verifiedAt: 'private', log: 'private' });
  assert.deepEqual(Object.keys(report).sort(), ['available', 'checks', 'editorReady', 'pdfReady', 'state', 'task']);
  assert.equal(report.available, true);
  assert.deepEqual(report.task, { id: 'task-1', phase: 'checking', status: 'failed' });
  assert.equal(JSON.stringify(report).includes('Alice'), false);
  assert.equal(JSON.stringify(report).includes(f.root), false);
  const log = redactEnvironmentLog('Error "C:\\Users\\Alice Name\\secret file.tex"\n/home/alice/data/file.tex\n\\\\server\\private\\secret.tex\ngeometry.sty');
  assert.equal(/Alice|alice|secret|server/.test(log), false);
  assert.match(log, /geometry\.sty/);
}));
