import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as provider from '../server/environment/providers/miktex.mjs';
import { preparePdfEnvironment } from '../server/environment/prepare.mjs';

const selected = { flavour: 'miktex', executable: 'controlled', manager: 'controlled-manager', lookup: 'controlled-lookup', scope: 'user', version: 'before' };
const report = (missing = [], toolchain = selected) => ({ editorReady: true, pdfReady: false,
  state: missing.length ? 'missing-packages' : 'verification-required', toolchain,
  checks: missing.map(id => ({ id, status: 'failed', code: 'TEX_PACKAGE_MISSING', message: 'missing' })),
  fingerprint: 'fixture', verifiedAt: null, task: null });
const ready = toolchain => ({ ...report([], toolchain), state: 'ready', pdfReady: true });

test('explicit update synchronizes packages and rebuilds xelatex before bilingual verification under one lease', async () => {
  const events = []; let upgraded = false;
  const managed = { ...selected, env: { MIKTEX_REPOSITORY: 'https://packages.example.test/' } };
  const after = { ...managed, version: 'after' };
  const lease = { release: async () => events.push('released') };
  const result = await preparePdfEnvironment({}, { update: true,
    inspect: async (config, options) => { events.push('inspect'); if (upgraded) { assert.equal(config.xelatexPath, selected.executable); assert.equal(options.env, managed.env); } return report([], upgraded ? after : managed); },
    acquireLease: async () => { events.push('lease'); return lease; },
    synchronize: async () => { events.push('update'); upgraded = true; },
    rebuild: async value => { assert.equal(value.version, 'after'); events.push('format'); },
    verify: async (_config, value, options) => { assert.equal(options.lease, lease); events.push('verify'); return ready(value); },
  });
  assert.equal(result.pdfReady, true);
  assert.deepEqual(events, ['inspect', 'lease', 'update', 'inspect', 'format', 'verify', 'released']);
  assert.equal(result.toolchain.version, 'after');
});

test('default missing-package repair does not upgrade installed packages or rebuild formats', async () => {
  let installed = false;
  const result = await preparePdfEnvironment({}, { inspect: async () => report(installed ? [] : ['geometry.sty']),
    acquireLease: async () => ({ release: async () => {} }), install: async () => { installed = true; },
    synchronize: async () => { throw Error('unexpected full update'); }, rebuild: async () => { throw Error('unexpected format rebuild'); },
    verify: async () => ready(selected) });
  assert.equal(result.pdfReady, true);
});

test('update repair installs missing dependencies before format generation', async () => {
  const events = []; let installed = false;
  const result = await preparePdfEnvironment({}, { update: true,
    inspect: async () => report(installed ? [] : ['ctexhook.sty']),
    acquireLease: async () => ({ release: async () => {} }),
    synchronize: async () => events.push('update'),
    install: async (_value, ids) => { assert.deepEqual(ids, ['ctex']); installed = true; events.push('install'); },
    rebuild: async () => events.push('format'), verify: async () => { events.push('verify'); return ready(selected); } });
  assert.equal(result.pdfReady, true); assert.deepEqual(events, ['update', 'install', 'format', 'verify']);
});

test('failed update never verifies or publishes ready and drains before lease release', async () => {
  const events = []; const { AppError } = await import('../server/errors.mjs');
  const result = await preparePdfEnvironment({}, { update: true, inspect: async () => report(),
    acquireLease: async () => ({ release: async () => events.push('release') }),
    synchronize: async () => { events.push('update'); throw new AppError('TEX_UPDATE_FAILED', 'update failed', 503); },
    verify: async () => { throw Error('must not verify failed update'); } });
  assert.equal(result.pdfReady, false); assert.ok(result.checks.some(c => c.code === 'TEX_UPDATE_FAILED'));
  assert.deepEqual(events, ['update', 'release']);
});

test('explicit update refuses TeX Live without executing a manager', async () => {
  const result = await preparePdfEnvironment({}, { update: true, inspect: async () => report([], { ...selected, flavour: 'texlive' }),
    acquireLease: async () => { throw Error('must not mutate TeX Live'); },
    synchronize: async () => { throw Error('must not update TeX Live'); }, verify: async () => ready(selected) });
  assert.equal(result.pdfReady, false); assert.ok(result.checks.some(c => c.code === 'TEXLIVE_REPAIR_REQUIRED'));
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'MiKTeX 同源 更新 '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin'); await mkdir(bin);
  const toolchain = { ...selected, executable: join(bin, 'xelatex.exe'), manager: join(bin, 'miktex.exe'), lookup: join(bin, 'findtexmf.exe') };
  for (const file of [toolchain.executable, toolchain.manager, toolchain.lookup]) await writeFile(file, 'fixture executable');
  return { directory, toolchain };
}

test('maintenance provider uses fixed same-source user-scoped commands and disables on-demand format installation', async t => {
  assert.equal(typeof provider.updateInstalledPackages, 'function'); assert.equal(typeof provider.rebuildXeLaTeXFormat, 'function');
  const { toolchain } = await fixture(t); const commands = [];
  const run = async command => { commands.push(command); return { exitCode: 0, log: '' }; };
  await provider.updateInstalledPackages(toolchain, { run }); await provider.rebuildXeLaTeXFormat(toolchain, { run });
  assert.deepEqual(commands.map(c => c.args), [['packages', 'update-package-database'], ['packages', 'update'],
    ['--disable-installer', 'fndb', 'refresh'], ['--disable-installer', 'formats', 'build', 'xelatex']]);
  assert.ok(commands.every(c => c.executable === toolchain.manager && c.timeoutMs <= 600000));
});

test('maintenance refuses mismatched or unconfirmed shared installations before any mutation', async t => {
  assert.equal(typeof provider.updateInstalledPackages, 'function');
  const { directory, toolchain } = await fixture(t);
  const other = join(directory, 'other'); await mkdir(other); const manager = join(other, 'miktex.exe'); await writeFile(manager, 'fixture');
  const run = async () => { throw Error('must not execute rejected manager'); };
  await assert.rejects(provider.updateInstalledPackages({ ...toolchain, manager }, { run }), e => e.code === 'TEX_TOOLCHAIN_MISMATCH');
  await assert.rejects(provider.updateInstalledPackages({ ...toolchain, scope: 'shared', userRepair: false }, { run }), e => e.code === 'TEX_PERMISSION_DENIED');
});

test('failed format generation retains a specific diagnosis and never retries arbitrary commands', async t => {
  assert.equal(typeof provider.rebuildXeLaTeXFormat, 'function');
  const { toolchain } = await fixture(t); let calls = 0;
  await assert.rejects(provider.rebuildXeLaTeXFormat(toolchain, { run: async () => ({ exitCode: ++calls === 1 ? 0 : 1, log: 'format generation failed' }) }),
    e => e.code === 'TEX_FORMAT_BUILD_FAILED');
  assert.equal(calls, 2);
});
