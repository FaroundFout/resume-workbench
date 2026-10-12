import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { installMissingPackages } from '../server/environment/providers/miktex.mjs';
import { preparePdfEnvironment } from '../server/environment/prepare.mjs';
const toolchain = { flavour: 'miktex', executable: 'controlled', manager: 'controlled-manager', lookup: 'controlled-lookup', scope: 'user' };
const report = (missing = [], flavour = 'miktex') => ({ editorReady: true, pdfReady: false, state: missing.length ? 'missing-packages' : 'verification-required', checks: missing.map(id => ({ id, status: 'failed', code: 'TEX_PACKAGE_MISSING', message: 'missing' })), toolchain: { ...toolchain, flavour }, fingerprint: 'source', verifiedAt: null, task: null });
const ready = { ...report(), pdfReady: true, state: 'ready' };
const config = {};
const lookupFailure = () => ({ id: 'fontspec.sty', status: 'failed', code: 'TEX_LOOKUP_FAILED', message: 'lookup failed' });
test('mixed or incomplete quick inspection cannot authorize package mutation', async () => {
  for (const environment of [
    { ...report(['geometry.sty']), state: 'verification-failed', checks: [...report(['geometry.sty']).checks, lookupFailure()] },
    { ...report(['geometry.sty']), checks: [...report(['geometry.sty']).checks, lookupFailure()] },
    { ...report(['geometry.sty']), checks: [...report(['geometry.sty']).checks, { id: 'fontspec.sty', status: 'pending', code: 'TEX_LOOKUP_PENDING', message: 'pending' }] },
  ]) {
    let installs = 0; let leases = 0; let verifications = 0;
    const result = await preparePdfEnvironment(config, { inspect: async () => environment,
      acquireLease: async () => { leases++; return { release: async () => {} }; }, install: async () => { installs++; }, verify: async () => { verifications++; return ready; } });
    assert.equal(installs, 0); assert.equal(leases, 0); assert.equal(verifications, 0); assert.equal(result.pdfReady, false);
    assert.ok(result.checks.some(check => ['TEX_LOOKUP_FAILED', 'TEX_LOOKUP_PENDING'].includes(check.code)));
  }
});
test('failed reinspection stops after the permitted initial repair without starting smoke verification', async () => {
  let inspections = 0; let installs = 0; let verifications = 0;
  const unsafe = { ...report(), state: 'verification-failed', checks: [lookupFailure()] };
  const result = await preparePdfEnvironment(config, { inspect: async () => inspections++ ? unsafe : report(['geometry.sty']),
    acquireLease: async () => ({ release: async () => {} }), install: async () => { installs++; }, verify: async () => { verifications++; return ready; } });
  assert.equal(installs, 1); assert.equal(verifications, 0); assert.equal(result.pdfReady, false); assert.equal(result.state, 'verification-failed');
  assert.ok(result.checks.some(check => check.code === 'TEX_LOOKUP_FAILED'));
});
test('resource failure discovered after repair retains its diagnosis instead of becoming a compiler-change error', async () => {
  let inspections = 0;
  const unsafe = { ...report(), toolchain: null, state: 'missing-resources', checks: [{ id: 'font/Lato/Lato-Regular.ttf', status: 'failed', code: 'PROJECT_RESOURCE_MISSING', message: 'resource missing' }] };
  const result = await preparePdfEnvironment(config, { inspect: async () => inspections++ ? unsafe : report(['geometry.sty']),
    acquireLease: async () => ({ release: async () => {} }), install: async () => {}, verify: async () => { throw Error('must not verify'); } });
  assert.equal(result.state, 'missing-resources');
  assert.ok(result.checks.some(check => check.code === 'PROJECT_RESOURCE_MISSING'));
  assert.ok(!result.checks.some(check => check.code === 'TEX_TOOLCHAIN_CHANGED'));
});
test('smoke missing file repair requires a fresh trustworthy quick inspection before installation', async () => {
  let inspections = 0; let installs = 0; let verifications = 0;
  const unsafe = { ...report(['geometry.sty']), state: 'verification-failed', checks: [...report(['geometry.sty']).checks, lookupFailure()] };
  const result = await preparePdfEnvironment(config, { inspect: async () => inspections++ ? unsafe : report(),
    acquireLease: async () => ({ release: async () => {} }), install: async () => { installs++; },
    verify: async () => { verifications++; return verifications > 1 ? ready : { ...report(['geometry.sty']), state: 'verification-failed', checks: [...report(['geometry.sty']).checks, { id: 'pdf-zh-CN', status: 'failed', code: 'LATEX_ERROR', message: 'smoke failed' }] }; } });
  assert.equal(installs, 0); assert.equal(verifications, 1); assert.equal(result.pdfReady, false);
  assert.ok(result.checks.some(check => check.code === 'TEX_LOOKUP_FAILED'));
  assert.ok(result.checks.some(check => check.code === 'LATEX_ERROR'));
});
test('each extra repair round independently requires a trustworthy fresh inspection', async () => {
  let inspections = 0; let installs = 0; let verifications = 0;
  const unsafe = { ...report(), state: 'verification-failed', checks: [lookupFailure()] };
  const result = await preparePdfEnvironment(config, { inspect: async () => inspections++ >= 3 ? unsafe : report(),
    acquireLease: async () => ({ release: async () => {} }), install: async () => { installs++; },
    verify: async () => { verifications++; return { ...report(['geometry.sty']), state: 'verification-failed' }; } });
  assert.equal(installs, 1); assert.equal(verifications, 2); assert.equal(inspections, 4); assert.equal(result.pdfReady, false);
  assert.ok(result.checks.some(check => check.code === 'TEX_LOOKUP_FAILED'));
});
test('preparation repairs mapped packages then reinspects and verifies under one lease', async () => {
  let calls = 0; let released = 0; const installed = []; const lease = { release: async () => { released++; } };
  const result = await preparePdfEnvironment(config, { inspect: async () => report(calls++ ? [] : ['geometry.sty', 'tabularx.sty', 'array.sty']), acquireLease: async () => lease,
    install: async (_toolchain, ids) => installed.push(ids), verify: async (_config, _toolchain, options) => { assert.equal(options.lease, lease); assert.equal(released, 0); return ready; } });
  assert.equal(result.pdfReady, true); assert.deepEqual(installed, [['geometry', 'latex-tools']]); assert.equal(released, 1); assert.equal(calls, 2);
});
test('healthy environment verifies without network or package database update', async () => {
  const result = await preparePdfEnvironment(config, { inspect: async () => report(), acquireLease: async () => ({ release: async () => {} }),
    install: async () => { throw Error('must not install'); }, verify: async () => ready });
  assert.equal(result.state, 'ready');
});

test('missing CTeX support files repair one known package and require fresh verification', async () => {
  let inspections = 0; let verifications = 0; const batches = [];
  const result = await preparePdfEnvironment(config, { inspect: async () => report(inspections++ ? [] : ['ctexhook.sty', 'ctexpatch.sty']),
    acquireLease: async () => ({ release: async () => {} }), install: async (_toolchain, ids) => { batches.push(ids); },
    verify: async () => { verifications++; return ready; } });
  assert.equal(result.pdfReady, true);
  assert.deepEqual(batches, [['ctex']]);
  assert.equal(inspections, 2); assert.equal(verifications, 1);
});

test('smoke-discovered CTeX support files use the same fixed package mapping', async () => {
  let verifications = 0; const batches = [];
  const result = await preparePdfEnvironment(config, { inspect: async () => report(),
    acquireLease: async () => ({ release: async () => {} }), install: async (_toolchain, ids) => { batches.push(ids); },
    verify: async () => verifications++ ? ready : { ...report(['ctexhook.sty', 'ctexpatch.sty']), state: 'verification-failed' } });
  assert.equal(result.pdfReady, true); assert.deepEqual(batches, [['ctex']]); assert.equal(verifications, 2);
});

test('an unknown smoke dependency remains visible and never becomes an install argument', async () => {
  let installations = 0;
  const result = await preparePdfEnvironment(config, { inspect: async () => report(),
    acquireLease: async () => ({ release: async () => {} }), install: async () => { installations++; },
    verify: async () => ({ ...report(['not-listed.sty']), missingTexFiles: ['not-listed.sty'], state: 'missing-packages' }) });
  assert.equal(result.pdfReady, false); assert.equal(installations, 0);
  assert.ok(result.checks.some(check => check.code === 'TEX_PACKAGE_UNKNOWN'));
  assert.ok(result.checks.some(check => check.id === 'not-listed.sty' && check.code === 'TEX_PACKAGE_MISSING'));
  assert.deepEqual(result.missingTexFiles, ['not-listed.sty']);
});
test('unknown file identifiers never become install arguments and TeX Live remains manual', async () => {
  for (const environment of [report(['--admin.sty']), report(['geometry.sty'], 'texlive')]) {
    const result = await preparePdfEnvironment(config, { inspect: async () => environment, acquireLease: async () => { throw Error('no lease needed'); }, install: async () => { throw Error('must not install'); } });
    assert.equal(result.pdfReady, false); assert.equal(result.state, 'missing-packages');
    assert.ok(result.checks.some(c => ['TEX_PACKAGE_UNKNOWN', 'TEXLIVE_REPAIR_REQUIRED'].includes(c.code)));
  }
});
test('additional known compile dependencies are repaired no more than two rounds', async () => {
  let installations = 0; let verifications = 0;
  const result = await preparePdfEnvironment(config, { inspect: async () => report(), acquireLease: async () => ({ release: async () => {} }),
    install: async () => { installations++; }, verify: async () => { verifications++; return { ...report(['geometry.sty']), state: 'verification-failed' }; } });
  assert.equal(result.pdfReady, false); assert.equal(installations, 2); assert.equal(verifications, 3);
  assert.ok(result.checks.some(c => c.code === 'TEX_REPAIR_LIMIT'));
});
test('initial package repair and extra rounds share the ten-minute package execution budget', async () => {
  const budgets = []; let inspections = 0; let verifications = 0;
  const result = await preparePdfEnvironment(config, { inspect: async () => report(inspections++ ? [] : ['geometry.sty']), acquireLease: async () => ({ release: async () => {} }),
    install: async (_toolchain, _ids, options) => { budgets.push(options.timeoutMs); await delay(20); },
    verify: async () => verifications++ ? ready : report(['tabularx.sty']) });
  assert.equal(result.pdfReady, true); assert.equal(budgets.length, 2);
  assert.ok(budgets[0] <= 600000 && budgets[0] > 599900);
  assert.ok(budgets[1] < budgets[0] - 10);
});
test('controlled package failure preserves report and releases lease; retry reuses installed subset', async () => {
  let released = 0; let installedGeometry = false; const batches = [];
  const collaborators = { inspect: async () => report(installedGeometry ? ['tabularx.sty'] : ['geometry.sty', 'tabularx.sty']), acquireLease: async () => ({ release: async () => { released++; } }),
    install: async (_toolchain, ids) => { batches.push(ids); if (!installedGeometry) { installedGeometry = true; const { AppError } = await import('../server/errors.mjs'); throw new AppError('TEX_REPOSITORY_UNAVAILABLE', 'unavailable'); } }, verify: async () => ready };
  assert.equal((await preparePdfEnvironment(config, collaborators)).pdfReady, false);
  collaborators.inspect = async () => report(installedGeometry && batches.length > 1 ? [] : installedGeometry ? ['tabularx.sty'] : ['geometry.sty', 'tabularx.sty']);
  assert.equal((await preparePdfEnvironment(config, collaborators)).pdfReady, true);
  assert.deepEqual(batches, [['geometry', 'latex-tools'], ['latex-tools']]); assert.equal(released, 2);
});
async function providerFixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'purecv-packages-'));
  await mkdir(join(root, 'bin')); const bin = join(root, 'bin');
  const selected = { ...toolchain, executable: join(bin, 'xelatex.exe'), manager: join(bin, 'miktex.exe'), lookup: join(bin, 'findtexmf.exe') };
  for (const name of ['xelatex.exe', 'miktex.exe', 'findtexmf.exe']) await writeFile(join(bin, name), 'controlled');
  try { await fn(selected, root); } finally { await rm(root, { recursive: true, force: true }); }
}
test('provider validates same installation and installs only whitelist ids with fixed non-admin arguments', async () => providerFixture(async selected => {
  const commands = [];
  await installMissingPackages(selected, ['geometry', 'latex-tools', 'geometry'], { run: async args => { commands.push(args); return { exitCode: 0, log: '' }; } });
  assert.deepEqual(commands.map(c => c.args), [['packages', 'update-package-database'], ['packages', 'install', 'geometry', 'latex-tools']]);
  assert.ok(commands.every(c => c.executable === selected.manager && c.timeoutMs <= 600000));
  await assert.rejects(installMissingPackages(selected, ['--admin'], { run: async () => { throw Error('unsafe execution'); } }), e => e.code === 'TEX_PACKAGE_UNKNOWN');
}));

test('provider installs CTeX once without a full upgrade or an administrator scope', async () => providerFixture(async selected => {
  const commands = [];
  await installMissingPackages(selected, ['ctex', 'ctex'], { run: async options => { commands.push(options.args); return { exitCode: 0, log: '' }; } });
  assert.deepEqual(commands, [['packages', 'update-package-database'], ['packages', 'install', 'ctex']]);
}));
test('download transient failures retry twice, while permission and deadline failures stop promptly', async () => providerFixture(async selected => {
  let updates = 0;
  await installMissingPackages(selected, ['geometry'], { run: async ({ args }) => { if (args[1] === 'update-package-database' && updates++ < 2) return { exitCode: 1, log: 'network connection failed' }; return { exitCode: 0, log: '' }; } });
  assert.equal(updates, 3);
  for (const [failure, code] of [[{ exitCode: 1, log: 'Permission denied' }, 'TEX_PERMISSION_DENIED'], [{ exitCode: null, log: '无法启动编译进程 (EACCES)' }, 'TEX_PERMISSION_DENIED'], [{ exitCode: null, log: '无法启动编译进程 (ENOENT)' }, 'TEX_MANAGER_UNAVAILABLE'], [{ exitCode: null, timedOut: true, log: '' }, 'TEX_PACKAGE_TIMEOUT'], [{ exitCode: 1, log: 'repository unavailable' }, 'TEX_REPOSITORY_UNAVAILABLE']]) {
    let calls = 0;
    await assert.rejects(installMissingPackages(selected, ['geometry'], { run: async () => { calls++; return failure; } }), e => e.code === code);
    assert.equal(calls, code === 'TEX_REPOSITORY_UNAVAILABLE' ? 3 : 1);
  }
}));
test('missing manager and foreign installation fail before package mutation', async () => providerFixture(async (selected, root) => {
  await assert.rejects(installMissingPackages({ ...selected, manager: null }, ['geometry']), e => e.code === 'TEX_MANAGER_UNAVAILABLE');
  const foreign = join(root, 'foreign'); await mkdir(foreign); const manager = join(foreign, 'miktex.exe'); await writeFile(manager, 'controlled');
  await assert.rejects(installMissingPackages({ ...selected, manager }, ['geometry']), e => e.code === 'TEX_TOOLCHAIN_MISMATCH');
}));
test('package preparation cancellation waits for runner settlement and then releases ownership', async () => {
  const controller = new AbortController(); let abortSeen; let settleRunner; let released = false;
  const aborted = new Promise(resolve => { abortSeen = resolve; });
  const runner = new Promise(resolve => { settleRunner = resolve; });
  const preparing = preparePdfEnvironment(config, { signal: controller.signal,
    inspect: async () => report(['geometry.sty']), acquireLease: async () => ({ release: async () => { released = true; } }),
    install: async (_toolchain, _ids, { signal }) => { signal.addEventListener('abort', abortSeen, { once: true }); await runner; signal.throwIfAborted(); } });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await aborted;
  assert.equal(released, false); settleRunner();
  const result = await preparing; assert.equal(result.pdfReady, false); assert.equal(result.task.status, 'cancelled'); assert.equal(released, true);
});
test('compiler absence and project resource failures never start installation or verification', async () => {
  for (const missing of [{ ...report(), toolchain: null, state: 'missing-compiler' }, { ...report(), state: 'missing-resources' }]) {
    const result = await preparePdfEnvironment(config, { inspect: async () => missing,
      acquireLease: async () => { throw Error('must not acquire'); }, install: async () => { throw Error('must not install'); }, verify: async () => { throw Error('must not verify'); } });
    assert.equal(result.state, missing.state); assert.equal(result.task.status, 'failed');
  }
});
test('provider uses one aggregate budget for retries and rejects shared scope without confirmed user repair', async () => providerFixture(async selected => {
  await assert.rejects(installMissingPackages({ ...selected, scope: 'shared' }, ['geometry']), e => e.code === 'TEX_PERMISSION_DENIED');
  await assert.rejects(installMissingPackages(selected, ['geometry'], { timeoutMs: 0, run: async () => { throw Error('expired budget must not launch'); } }), e => e.code === 'TEX_PACKAGE_TIMEOUT');
}));
