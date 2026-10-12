import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDoctor } from '../scripts/doctor.mjs';
import { saveEnvironmentRecord, applyEnvironmentRecord } from '../server/environment/record.mjs';

const fingerprint = 'a'.repeat(64);
const toolchain = { executable: 'C:/Users/private/MiKTeX/xelatex.exe', flavour: 'miktex', version: 'test', manager: null, lookup: null, scope: 'user' };
const report = (state = 'verification-required') => ({ editorReady: true, pdfReady: state === 'ready', state, checks: [], toolchain, fingerprint, verifiedAt: state === 'ready' ? '2026-10-12T00:00:00.000Z' : null, task: null });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'PureCV 安装 CLI '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.purecv'));
  await writeFile(join(root, '.purecv/private-data'), 'preserve-user-data');
  return root;
}
async function invoke(root, args, collaborators = {}) {
  const lines = [];
  const result = await runDoctor({ projectRoot: root, args, writeLine: line => lines.push(line), ...collaborators });
  assert.equal(await readFile(join(root, '.purecv/private-data'), 'utf8'), 'preserve-user-data');
  return { ...result, lines: lines.join('\n') };
}

test('default installation prepares PDF and only bilingual verification success publishes a record', async t => {
  const root = await fixture(t);
  let prepared = 0;
  const result = await invoke(root, [], { prepare: async () => { prepared++; return report('ready'); } });
  assert.equal(prepared, 1); assert.equal(result.exitCode, 0);
  assert.match(result.lines, /中文.*英文.*通过/);
  const stored = JSON.parse(await readFile(join(root, '.runtime/environment-validation.json'), 'utf8'));
  assert.equal(stored.fingerprint, fingerprint); assert.equal(stored.pdfReady, true);
  assert.doesNotMatch(JSON.stringify(stored), /private|xelatex\.exe/);
});

test('missing compiler fails complete setup while editor data stays usable', async t => {
  const root = await fixture(t);
  const result = await invoke(root, ['--prepare'], { prepare: async () => ({ ...report('missing-compiler'), toolchain: null,
    checks: [{ id: 'compiler', status: 'failed', code: 'COMPILER_UNAVAILABLE', message: '未找到 XeLaTeX' }] }) });
  assert.equal(result.exitCode, 1); assert.match(result.lines, /COMPILER_UNAVAILABLE/);
  assert.match(result.lines, /https:\/\/miktex.org\/download/);
  assert.doesNotMatch(result.lines, /Setup complete/);
  await assert.rejects(access(join(root, '.runtime/environment-validation.json')), { code: 'ENOENT' });
});

test('editor-only is explicit and performs no PDF inspection or package mutation', async t => {
  const root = await fixture(t);
  const forbidden = () => { throw Error('must not touch PDF environment'); };
  const result = await invoke(root, ['--editor-only'], { inspect: forbidden, prepare: forbidden, verify: forbidden });
  assert.equal(result.exitCode, 0); assert.match(result.lines, /PDF.*未准备/);
  await assert.rejects(access(join(root, '.runtime')), { code: 'ENOENT' });
});

test('check mode stays read-only and reports verification-required instead of full success', async t => {
  const root = await fixture(t);
  const result = await invoke(root, ['--check'], { inspect: async () => report(),
    prepare: () => { throw Error('must not install'); }, verify: () => { throw Error('must not compile'); } });
  assert.equal(result.exitCode, 1); assert.equal(result.report.state, 'verification-required');
  assert.doesNotMatch(result.lines, /Setup complete/);
});

test('verify mode selects the inspected toolchain and refuses a failed language result', async t => {
  const root = await fixture(t);
  let selected;
  const result = await invoke(root, ['--verify'], { inspect: async () => report(), verify: async (_config, value) => {
    selected = value; return { ...report('verification-failed'), checks: [{ id: 'en', status: 'failed', code: 'PDF_VERIFICATION_FAILED', message: '英文样例编译失败' }] };
  }, prepare: () => { throw Error('must not install'); } });
  assert.equal(selected, toolchain); assert.equal(result.exitCode, 1);
  assert.match(result.lines, /英文样例编译失败/);
});

test('unsupported and conflicting command modes fail before touching dependencies', async t => {
  const root = await fixture(t);
  for (const args of [['--unknown'], ['--prepare', '--editor-only'], ['--check', '--verify']]) {
    const result = await invoke(root, args, { prepare: () => { throw Error('must not prepare'); }, inspect: () => { throw Error('must not inspect'); } });
    assert.equal(result.exitCode, 1); assert.match(result.lines, /参数|模式/);
  }
});

test('explicit update is accepted only with prepare and passes intent to the preparation service', async t => {
  const root = await fixture(t);
  let update;
  const result = await invoke(root, ['--prepare', '--update'], { prepare: async (_config, options) => { update = options.update; return report('ready'); } });
  assert.equal(result.exitCode, 0); assert.equal(update, true);
  assert.match(result.lines, /更新.*宏包|同步.*宏包/);
  for (const args of [['--verify', '--update'], ['--check', '--update'], ['--editor-only', '--update'], ['--prepare', '--update', '--update']]) {
    const rejected = await invoke(root, args, { prepare: () => { throw Error('must not prepare'); }, inspect: () => { throw Error('must not inspect'); } });
    assert.equal(rejected.exitCode, 1); assert.match(rejected.lines, /参数|模式/);
  }
});

test('validation record only restores ready for matching fingerprints and a complete quick check', async t => {
  const root = await fixture(t);
  await saveEnvironmentRecord(root, report('ready'));
  const matching = await applyEnvironmentRecord(root, report());
  assert.equal(matching.pdfReady, true); assert.equal(matching.state, 'ready');
  assert.equal((await applyEnvironmentRecord(root, { ...report(), fingerprint: 'b'.repeat(64) })).pdfReady, false);
  assert.equal((await applyEnvironmentRecord(root, report('missing-packages'))).pdfReady, false);
  await writeFile(join(root, '.runtime/environment-validation.json'), '{broken');
  assert.equal((await applyEnvironmentRecord(root, report())).pdfReady, false);
});

test('a failed full verification invalidates an old successful validation record', async t => {
  const root = await fixture(t);
  await saveEnvironmentRecord(root, report('ready'));
  const result = await invoke(root, ['--verify'], { inspect: async () => report(), verify: async () => report('verification-failed') });
  assert.equal(result.exitCode, 1);
  assert.equal((await applyEnvironmentRecord(root, report())).pdfReady, false);
});

test('an unexpected verification exception also invalidates a prior passing record', async t => {
  const root = await fixture(t);
  await saveEnvironmentRecord(root, report('ready'));
  const result = await invoke(root, ['--verify'], { inspect: async () => report(), verify: async () => { throw Error('fixture verification failure'); } });
  assert.equal(result.exitCode, 1);
  assert.equal((await applyEnvironmentRecord(root, report())).pdfReady, false);
});
