import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireEnvironmentLease } from '../server/environment/lease.mjs';
import { acquireDataDirectory } from '../server/ownership.mjs';
import { createBuildFixture, finish } from './helpers/builds.mjs';
import { setTimeout as delay } from 'node:timers/promises';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'purecv-lease-'));
  const bin = join(root, 'installation', 'bin'); await mkdir(bin, { recursive: true });
  const executable = join(bin, 'xelatex.exe'); await writeFile(executable, 'controlled');
  try { await fn({ root, bin, executable }); } finally { await rm(root, { recursive: true, force: true }); }
}
test('same installation compiler and manager share an exclusive kernel lease; other installation is independent', async () => fixture(async f => {
  const manager = join(f.bin, 'miktex.exe'); await writeFile(manager, 'controlled');
  const held = await acquireEnvironmentLease({ executable: f.executable });
  try {
    await assert.rejects(acquireEnvironmentLease({ executable: manager }), e => e.code === 'ENVIRONMENT_BUSY' && e.status === 409);
    const other = join(f.root, 'other', 'xelatex.exe'); await mkdir(join(f.root, 'other')); await writeFile(other, 'controlled');
    const independent = await acquireEnvironmentLease({ executable: other }); await independent.release();
  } finally { await held.release(); await held.release(); }
}));
test('directory aliases resolve to the same installation lease and do not collide with data ownership namespace', async () => fixture(async f => {
  const alias = join(f.root, 'alias'); await symlink(f.bin, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const data = await acquireDataDirectory(f.bin);
  const held = await acquireEnvironmentLease({ executable: f.executable });
  try { await assert.rejects(acquireEnvironmentLease({ executable: join(alias, 'xelatex.exe') }), e => e.code === 'ENVIRONMENT_BUSY'); }
  finally { await held.release(); await data.release(); }
}));
test('aborted lease acquisition never leaks a kernel reservation', async () => fixture(async f => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(acquireEnvironmentLease({ executable: f.executable }, { signal: controller.signal }), e => e.name === 'AbortError');
  const lease = await acquireEnvironmentLease({ executable: f.executable }); await lease.release();
}));
test('lease is cross-process exclusive and process death releases it without stale lock files', async () => fixture(async f => {
  const module = pathToFileURL(join(process.cwd(), 'server/environment/lease.mjs')).href;
  const script = join(f.root, 'holder.mjs');
  await writeFile(script, `import {acquireEnvironmentLease} from ${JSON.stringify(module)}; await acquireEnvironmentLease({executable:process.argv[2]}); process.stdout.write('ready\\n');`);
  const child = spawn(process.execPath, [script, f.executable], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(Error(`holder exited ${code}: ${stderr}`))); });
    await assert.rejects(acquireEnvironmentLease({ executable: f.executable }), e => e.code === 'ENVIRONMENT_BUSY');
  } finally { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
  const lease = await acquireEnvironmentLease({ executable: f.executable }); await lease.release();
}));
test('formal build acquires before snapshot capture and releases after publication', async () => fixture(async tool => {
  let captureStarted; let continueCapture;
  const capturing = new Promise(resolve => { captureStarted = resolve; });
  const gate = new Promise(resolve => { continueCapture = resolve; });
  const f = await createBuildFixture({ detect: async () => ({ available: true, executable: tool.executable }), acquireLease: acquireEnvironmentLease });
  const capture = f.store.capture;
  f.store.capture = async (...args) => { captureStarted(); await gate; return capture(...args); };
  try {
    const submission = f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 });
    await capturing;
    await assert.rejects(acquireEnvironmentLease({ executable: tool.executable }, { mode: 'prepare' }), e => e.code === 'ENVIRONMENT_BUSY');
    continueCapture();
    const result = await finish(f.manager, (await submission).id);
    assert.equal(result.status, 'succeeded');
    const after = await acquireEnvironmentLease({ executable: tool.executable }); await after.release();
  } finally { continueCapture(); await f.close(); }
}));
test('repair lease prevents formal build capture and registration', async () => fixture(async tool => {
  const held = await acquireEnvironmentLease({ executable: tool.executable }, { mode: 'prepare' });
  const f = await createBuildFixture({ detect: async () => ({ available: true, executable: tool.executable }), acquireLease: acquireEnvironmentLease });
  let captures = 0; f.store.capture = async () => { captures++; throw Error('must not capture'); };
  try {
    await assert.rejects(f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 }), e => e.code === 'ENVIRONMENT_BUSY');
    assert.equal(captures, 0);
  } finally { await held.release(); await f.close(); }
}));
test('cancelled lease acquisition drains late ownership before shutdown completes', async () => {
  let completeAcquire; let started; let released = false;
  const startedAcquire = new Promise(resolve => { started = resolve; });
  const acquisition = new Promise(resolve => { completeAcquire = resolve; });
  const f = await createBuildFixture({ acquireLease: async () => { started(); await acquisition; return { release: async () => { released = true; } }; } });
  const pending = f.manager.submit({ resumeId: f.doc.id, expectedRevision: 0 });
  const outcome = pending.catch(cause => cause.code);
  await startedAcquire;
  let closed = false; const closing = f.manager.shutdown().then(() => { closed = true; });
  try {
    await delay(20); assert.equal(closed, false); assert.equal(released, false);
    completeAcquire(); await closing;
    assert.equal(await outcome, 'BUILDER_SHUTDOWN'); assert.equal(released, true);
  } finally { completeAcquire(); await f.close(); }
});
