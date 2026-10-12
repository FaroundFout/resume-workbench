import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createEnvironmentService } from '../server/environment/service.mjs';
import { inspectEnvironment } from '../server/environment/check.mjs';
import { requiredProjectFiles, requiredTexFiles } from '../server/environment/manifest.mjs';
import { saveEnvironmentRecord, applyEnvironmentRecord } from '../server/environment/record.mjs';
import { AppError } from '../server/errors.mjs';
import { createBuildFixture, finish } from './helpers/builds.mjs';

async function fixture(t, { missing = [], verify, cached = false, acquireLease } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'purecv-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { projectRoot: root };
  for (const file of [...requiredProjectFiles, ...requiredTexFiles.map(file => `tex/${file}`), 'bin/xelatex.exe', 'bin/findtexmf.exe']) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), `fixture ${file}`);
  }
  let toolchain = { executable: join(root, 'bin/xelatex.exe'), lookup: join(root, 'bin/findtexmf.exe'), flavour: 'miktex', version: 'fixture', scope: 'project' };
  let queries = 0;
  const inspect = (config, options) => inspectEnvironment(config, { ...options, toolchain, run: async ({ args }) => {
    queries++;
    const file = args.at(-1);
    return { exitCode: 0, stdout: missing.includes(file) ? '' : join(root, 'tex', file), stderr: '', log: '', timedOut: false, aborted: false };
  } });
  if (cached) await saveEnvironmentRecord(root, { ...await inspect(config, {}), state: 'ready', pdfReady: true, verifiedAt: new Date().toISOString() });
  const service = createEnvironmentService({ config, inspect, acquireLease: acquireLease ?? (async () => ({ release: async () => {} })),
    verify: verify ?? (async (_config, _chain, { inspection, onProgress }) => {
      onProgress('pdf-zh-CN'); onProgress('pdf-en');
      return { ...inspection, state: 'ready', pdfReady: true, verifiedAt: new Date().toISOString(), task: { status: 'succeeded' } };
    }) });
  t.after(() => service.shutdown());
  await service.initialize();
  return { root, config, service, missing, queries: () => queries, select: value => { toolchain = value; } };
}
async function done(service) {
  for (let i = 0; i < 200; i++) {
    const report = await service.getReport();
    if (report.task?.status !== 'running') return report;
    await delay(2);
  }
  throw Error('Environment task never finished');
}

test('missing packages stay unready until fixed and bilingual recheck finishes', async t => {
  const f = await fixture(t, { missing: ['geometry.sty'] });
  assert.equal((await f.service.getReport()).state, 'missing-packages');
  assert.equal((await f.service.getReport()).pdfReady, false);
  f.missing.length = 0;
  const started = f.service.check();
  assert.equal(started.state, 'checking'); assert.equal(started.task.status, 'running');
  const report = await done(f.service);
  assert.equal(report.state, 'ready'); assert.equal(report.pdfReady, true); assert.equal(report.task.status, 'succeeded');
});

test('cached readiness is cheap to poll and missing previously verified TeX dependency revokes it', async t => {
  const f = await fixture(t, { cached: true });
  assert.equal((await f.service.getReport()).state, 'ready');
  const before = f.queries();
  await f.service.getReport(); await f.service.getReport();
  assert.equal(f.queries(), before, 'unchanged polls must not spawn TeX query processes');
  await rm(join(f.root, 'tex/geometry.sty'));
  const report = await f.service.getReport();
  assert.equal(report.pdfReady, false); assert.notEqual(report.state, 'ready');
});

test('template, font, compiler and managed selection changes invalidate old fingerprint', async t => {
  for (const file of ['templates/purecv-zh/main.tex', 'font/Lato/Lato-Regular.ttf', 'bin/xelatex.exe', '.runtime/tex-selection.json']) {
    const f = await fixture(t, { cached: true });
    assert.equal((await f.service.getReport()).pdfReady, true);
    await mkdir(dirname(join(f.root, file)), { recursive: true });
    await writeFile(join(f.root, file), 'changed content');
    assert.equal((await f.service.getReport()).pdfReady, false, file);
  }
});

test('duplicate rechecks reuse one task and real phases are visible before finishing', async t => {
  let release;
  let entered;
  const running = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { verify: async (_config, _chain, { inspection, onProgress }) => {
    onProgress('pdf-zh-CN'); entered(); await new Promise(resolve => { release = resolve; });
    onProgress('pdf-en'); return { ...inspection, pdfReady: true, state: 'ready', verifiedAt: new Date().toISOString(), task: { status: 'succeeded' } };
  } });
  const first = f.service.check(); const second = f.service.check();
  assert.equal(first.task.id, second.task.id);
  await running;
  assert.equal((await f.service.getReport()).task.phase, 'pdf-zh-CN');
  release(); assert.equal((await done(f.service)).task.status, 'succeeded');
});

test('cancelled verification drains before restoring a nonchecking state', async t => {
  let entered;
  const running = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { cached: true, verify: async (_config, _chain, { signal }) => {
    entered(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted();
  } });
  f.service.check(); await running; await f.service.cancel();
  const report = await f.service.getReport();
  assert.equal(report.state, 'ready'); assert.equal(report.task.status, 'cancelled');
});

test('environment check and builds share reservation before asynchronous discovery', async t => {
  const build = await createBuildFixture(); t.after(() => build.close());
  const f = await fixture(t);
  f.service.setBuildManager(build.manager);
  const occupied = build.manager.reserveEnvironmentTask({ controller: new AbortController() });
  assert.throws(() => f.service.check(), e => e.code === 'ENVIRONMENT_BUSY');
  await assert.rejects(build.manager.submit({ resumeId: build.doc.id, expectedRevision: 0 }), e => e.code === 'ENVIRONMENT_BUSY');
  await occupied.release();
  const record = await build.manager.submit({ resumeId: build.doc.id, expectedRevision: 0 });
  assert.throws(() => f.service.check(), e => e.code === 'ENVIRONMENT_BUSY');
  await finish(build.manager, record.id);
  f.service.check(); assert.equal((await done(f.service)).pdfReady, true);
});

test('explicit environment failure revokes record while editing remains ready', async t => {
  const f = await fixture(t, { cached: true });
  await f.service.invalidate({ code: 'TEX_PACKAGE_MISSING', message: '缺少 geometry.sty' });
  const report = await f.service.getReport();
  assert.equal(report.pdfReady, false); assert.equal(report.editorReady, true); assert.equal(report.state, 'missing-packages');
});

test('failed verification removes previous readiness record and exposes controlled result', async t => {
  const f = await fixture(t, { cached: true, verify: async (_config, _chain, { inspection }) => ({ ...inspection,
    state: 'verification-failed', pdfReady: false, verifiedAt: null, task: { status: 'failed' },
    checks: [...inspection.checks, { id: 'pdf-en', code: 'LATEX_ERROR', status: 'failed', message: '英文样例编译失败' }] }) });
  f.service.check(); const report = await done(f.service);
  assert.equal(report.task.status, 'failed'); assert.equal(report.state, 'verification-failed');
  assert.equal((await applyEnvironmentRecord(f.root, { ...report, state: 'verification-required' })).pdfReady, false);
});

test('resource change during verification refuses ready and a retry can recover', async t => {
  let change = true;
  const f = await fixture(t, { verify: async (config, _chain, { inspection }) => {
    if (change) await writeFile(join(config.projectRoot, 'templates/shared/macros.tex'), 'changed while compiling');
    return { ...inspection, state: 'ready', pdfReady: true, verifiedAt: new Date().toISOString(), task: { status: 'succeeded' } };
  } });
  f.service.check(); const report = await done(f.service);
  assert.equal(report.pdfReady, false); assert.equal(report.state, 'verification-required');
  assert.ok(report.checks.some(item => item.code === 'ENVIRONMENT_CHANGED'));
  change = false; f.service.check(); assert.equal((await done(f.service)).pdfReady, true);
});

test('cross-process lease refusal terminates the task with ENVIRONMENT_BUSY and releases the service slot', async t => {
  let busy = true;
  const f = await fixture(t, { acquireLease: async () => {
    if (busy) throw new AppError('ENVIRONMENT_BUSY', '环境正在修复，请稍后重试。', 409);
    return { release: async () => {} };
  } });
  f.service.check(); const report = await done(f.service);
  assert.equal(report.task.status, 'failed'); assert.ok(report.checks.some(item => item.code === 'ENVIRONMENT_BUSY'));
  busy = false; f.service.check(); assert.equal((await done(f.service)).state, 'ready');
});

test('complete verification keeps the service slot until its environment lease is released', async t => {
  let release;
  let ended;
  const releasing = new Promise(resolve => { ended = resolve; });
  const f = await fixture(t, { acquireLease: async () => ({ release: async () => {
    ended(); await new Promise(resolve => { release = resolve; });
  } }) });
  f.service.check(); await releasing;
  let polled = false; const poll = f.service.getReport().then(value => { polled = true; return value; });
  await delay(5); assert.equal(polled, false);
  release(); assert.equal((await poll).task.status, 'succeeded');
});
